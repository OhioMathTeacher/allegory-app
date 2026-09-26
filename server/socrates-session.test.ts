/**
 * The draft-and-revise loop: how rejection turns into tag weights, and how
 * weights turn into the next round of candidates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTree, type Tag } from './tags.ts'
import type { FilterTrack } from './filters.ts'
import {
  MIN_WEIGHT,
  adjustWeights,
  compactSubtree,
  renderSubtree,
  selectCandidates,
} from './socrates-session.ts'

// Roots › Blues › {Delta blues, Chicago blues}; Jazz › Bebop; Live (context)
const TAGS: Tag[] = [
  { id: 'roots', name: 'Roots', parentId: null, kind: 'genre', createdAt: 0 },
  { id: 'blues', name: 'Blues', parentId: 'roots', kind: 'genre', createdAt: 0 },
  { id: 'delta', name: 'Delta blues', parentId: 'blues', kind: 'genre', createdAt: 0 },
  { id: 'chicago', name: 'Chicago blues', parentId: 'blues', kind: 'genre', createdAt: 0 },
  { id: 'jazz', name: 'Jazz', parentId: null, kind: 'genre', createdAt: 0 },
  { id: 'bebop', name: 'Bebop', parentId: 'jazz', kind: 'genre', createdAt: 0 },
  { id: 'live', name: 'Live', parentId: null, kind: 'context', createdAt: 0 },
]
const tree = buildTree(TAGS)

// --- feedback into weights ---------------------------------------------------

test('rejections concentrated in one tag down-weight only that tag', () => {
  const w = adjustWeights({ tree, rejected: [['delta'], ['delta'], ['delta']] })
  assert.ok(w.delta < 1, 'the rejected tag was not down-weighted')
  // Three tracks all filed under Delta blues say nothing about Blues as a whole.
  assert.equal(w.blues, undefined, 'the parent was implicated by one child alone')
  assert.equal(w.chicago, undefined, 'an untouched sibling was down-weighted')
})

test('rejections spread across siblings down-weight the parent', () => {
  // One Delta and one Chicago is a statement about Blues, and looking only at
  // the children would miss it.
  const w = adjustWeights({ tree, rejected: [['delta'], ['chicago']] })
  assert.ok(w.delta < 1)
  assert.ok(w.chicago < 1)
  assert.ok(w.blues !== undefined && w.blues < 1, 'the parent was not implicated')
  // Blues is a child of Roots, but only ONE of Roots' children was hit.
  assert.equal(w.roots, undefined, 'the grandparent was implicated on one child')
})

test('two children of different parents do not implicate either parent', () => {
  const w = adjustWeights({ tree, rejected: [['delta'], ['bebop']] })
  assert.equal(w.blues, undefined)
  assert.equal(w.jazz, undefined)
})

test('weights accumulate across rounds and floor rather than reaching zero', () => {
  let w = adjustWeights({ tree, rejected: [['delta']] })
  const afterOne = w.delta
  w = adjustWeights({ tree, rejected: [['delta']], current: w })
  assert.ok(w.delta < afterOne, 'a second round did not push it further down')
  for (let i = 0; i < 40; i++) w = adjustWeights({ tree, rejected: [['delta']], current: w })
  assert.equal(w.delta, MIN_WEIGHT, 'the weight did not floor')
  assert.ok(w.delta > 0, 'a tag became impossible rather than unlikely')
})

test('a root tag with no parent does not blow up', () => {
  const w = adjustWeights({ tree, rejected: [['live'], ['jazz']] })
  assert.ok(w.live < 1 && w.jazz < 1)
})

test('rejecting a track twice in one round counts once per track', () => {
  // The same tag listed twice on ONE track is one track's worth of evidence.
  const dup = adjustWeights({ tree, rejected: [['delta', 'delta']] })
  const single = adjustWeights({ tree, rejected: [['delta']] })
  assert.equal(dup.delta, single.delta)
})

// --- weights into candidates -------------------------------------------------

function tk(id: string, tagIds: string[], over: Partial<FilterTrack> = {}): FilterTrack {
  return {
    id,
    path: `/m/${id}.flac`,
    title: id,
    artist: 'A',
    album: 'B',
    addedAt: 0,
    playCount: 0,
    tagIds,
    ...over,
  }
}

const LIB: FilterTrack[] = [
  tk('muddy', ['delta']),
  tk('wolf', ['chicago']),
  tk('both', ['delta', 'chicago']),
  tk('miles', ['bebop']),
  tk('hit', ['delta'], { playCount: 99 }),
  tk('untagged', []),
]

const names = (c: { title: string }[]) => c.map((x) => x.title)

test('a seed tag offers what is filed beneath it', () => {
  const got = selectCandidates(LIB, tree, { tagIds: ['blues'] })
  assert.deepEqual(names(got).sort(), ['both', 'hit', 'muddy', 'wolf'])
  // Jazz is not under Blues, and the untagged track carries nothing asked for.
  assert.ok(!names(got).includes('miles'))
  assert.ok(!names(got).includes('untagged'))
})

test('tag names are sent, not ids — this goes to a language model', () => {
  const got = selectCandidates(LIB, tree, { tagIds: ['delta'] })
  assert.ok(got.length > 0)
  assert.ok(got[0].tags.includes('Delta blues'), `got ${JSON.stringify(got[0].tags)}`)
})

test('pinned and rejected paths are not offered again', () => {
  const got = selectCandidates(LIB, tree, {
    tagIds: ['blues'],
    excludePaths: ['/m/muddy.flac', '/m/wolf.flac'],
  })
  assert.deepEqual(names(got).sort(), ['both', 'hit'])
})

test('playCountMax is the "nothing too obvious" ceiling', () => {
  const got = selectCandidates(LIB, tree, { tagIds: ['blues'], playCountMax: 10 })
  assert.ok(!names(got).includes('hit'), 'a much-played track survived the ceiling')
  assert.equal(names(got).length, 3)
})

test('a down-weighted tag sinks, and a floored one drops out entirely', () => {
  const weights = adjustWeights({ tree, rejected: [['chicago'], ['chicago'], ['chicago']] })
  const got = selectCandidates(LIB, tree, { tagIds: ['blues'], weights })
  // Muddy (delta only) should now outrank Wolf (chicago only).
  assert.ok(
    names(got).indexOf('muddy') < names(got).indexOf('wolf'),
    `weighting did not reorder: ${names(got).join(', ')}`,
  )

  let floored = weights
  for (let i = 0; i < 40; i++) {
    floored = adjustWeights({ tree, rejected: [['chicago']], current: floored })
  }
  const after = selectCandidates(LIB, tree, { tagIds: ['chicago'], weights: floored })
  assert.deepEqual(after, [], 'a tag beaten to the floor still produced candidates')
})

test('score is the mean of the wanted tags, not the sum', () => {
  // `both` carries Delta AND Chicago. With Chicago down-weighted, a sum would
  // let `both` outrank `muddy` simply for carrying more tags.
  const weights = adjustWeights({ tree, rejected: [['chicago']] })
  const got = selectCandidates(LIB, tree, { tagIds: ['blues'], weights })
  assert.ok(
    names(got).indexOf('muddy') < names(got).indexOf('both'),
    `a busier track outranked a better fit: ${names(got).join(', ')}`,
  )
})

test('ordering is reproducible for a seed and differs across seeds', () => {
  const a = names(selectCandidates(LIB, tree, { tagIds: ['blues'], seed: 3 }))
  const b = names(selectCandidates(LIB, tree, { tagIds: ['blues'], seed: 3 }))
  assert.deepEqual(a, b, 'the same seed gave a different order')
  let differs = false
  for (const seed of [1, 2, 4, 5, 9, 17, 33]) {
    if (names(selectCandidates(LIB, tree, { tagIds: ['blues'], seed })).join() !== a.join()) {
      differs = true
      break
    }
  }
  assert.ok(differs, 'no seed produced a different order — revise would never vary')
})

test('with no seed tags, everything is a candidate including the untagged', () => {
  const got = selectCandidates(LIB, tree, {})
  assert.equal(got.length, LIB.length)
  assert.ok(names(got).includes('untagged'), 'an untagged track was silently dropped')
})

test('limit caps the list', () => {
  assert.equal(selectCandidates(LIB, tree, { limit: 2 }).length, 2)
  assert.equal(selectCandidates(LIB, tree, { limit: 0 }).length, 0)
})

// --- the prompt's slice of the tree ------------------------------------------

test('compactSubtree carries the seed, its ancestors and its descendants', () => {
  const got = compactSubtree(tree, ['blues']).map((t) => t.id).sort()
  assert.deepEqual(got, ['blues', 'chicago', 'delta', 'roots'])
  // Not the whole tree: Jazz and Live were not asked about.
  assert.ok(!got.includes('jazz'))
  assert.ok(!got.includes('live'))
})

test('with no seed, compactSubtree offers the roots rather than everything', () => {
  const got = compactSubtree(tree, []).map((t) => t.id).sort()
  assert.deepEqual(got, ['jazz', 'live', 'roots'])
})

test('renderSubtree indents by depth', () => {
  const text = renderSubtree(compactSubtree(tree, ['blues']))
  assert.match(text, /^- Roots$/m)
  assert.match(text, /^ {2}- Blues$/m)
  assert.match(text, /^ {4}- Chicago blues$/m)
  assert.equal(renderSubtree([]), '(no tags yet)')
})
