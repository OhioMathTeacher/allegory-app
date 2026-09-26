/**
 * Saved filters: the matching rules, and the store around them.
 *
 * `evaluate` is pure, so these run on literals — no library, no sidecars, no
 * listen log. That is the whole reason it was split out.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTree, type Tag } from './tags.ts'
import { createFilters, evaluate, type FilterTrack } from './filters.ts'

// Roots › Blues › {Delta blues, Chicago blues}; Jazz; Punk
const TAGS: Tag[] = [
  { id: 'blues', name: 'Blues', parentId: null, kind: 'genre', createdAt: 0 },
  { id: 'delta', name: 'Delta blues', parentId: 'blues', kind: 'genre', createdAt: 0 },
  { id: 'chicago', name: 'Chicago blues', parentId: 'blues', kind: 'genre', createdAt: 0 },
  { id: 'jazz', name: 'Jazz', parentId: null, kind: 'genre', createdAt: 0 },
  { id: 'live', name: 'Live', parentId: null, kind: 'context', createdAt: 0 },
]
const tree = buildTree(TAGS)

function tk(over: Partial<FilterTrack> & { id: string }): FilterTrack {
  return {
    path: `/m/${over.id}.flac`,
    title: over.id,
    artist: 'A',
    album: 'B',
    addedAt: 0,
    playCount: 0,
    tagIds: [],
    ...over,
  }
}

const LIB: FilterTrack[] = [
  tk({ id: 'muddy', artist: 'Muddy Waters', album: 'Folk Singer', artistId: 'ar1',
       year: 1964, addedAt: 1000, playCount: 1, tagIds: ['delta'] }),
  tk({ id: 'wolf', artist: 'Howlin Wolf', album: 'Moanin', artistId: 'ar2',
       year: 1959, addedAt: 2000, playCount: 12, tagIds: ['chicago'] }),
  tk({ id: 'miles', artist: 'Miles Davis', album: 'Kind of Blue', artistId: 'ar3',
       year: 1959, addedAt: 3000, playCount: 40, tagIds: ['jazz'] }),
  tk({ id: 'bootleg', artist: 'Muddy Waters', album: 'Unknown Bootleg', artistId: 'ar1',
       addedAt: 4000, playCount: 0, tagIds: ['delta', 'live'] }),
  tk({ id: 'untagged', artist: 'Nobody', album: 'Nowhere', artistId: 'ar4',
       year: 2001, addedAt: 5000, playCount: 3, tagIds: [] }),
]

const ids = (rows: FilterTrack[]) => rows.map((t) => t.id).sort()

test('an empty rule matches everything', () => {
  assert.equal(evaluate(LIB, {}, tree).length, LIB.length)
})

test('including a parent tag finds tracks filed under its children', () => {
  assert.deepEqual(ids(evaluate(LIB, { includeTagIds: ['blues'] }, tree)),
    ['bootleg', 'muddy', 'wolf'])
})

test('descendant expansion can be turned off', () => {
  // Nothing carries "Blues" itself, so the literal reading finds nothing.
  assert.deepEqual(
    evaluate(LIB, { includeTagIds: ['blues'], includeDescendants: false }, tree), [])
})

test('EXCLUDING a parent excludes its children too', () => {
  // The asymmetry worth guarding: excluding Blues while quietly keeping Delta
  // blues would be far more surprising than the reverse.
  assert.deepEqual(ids(evaluate(LIB, { excludeTagIds: ['blues'] }, tree)),
    ['miles', 'untagged'])
})

test('tagMatch "all" wants one tag from each requested family', () => {
  // "Blues AND Live" — the bootleg is Delta blues + Live, so it qualifies even
  // though it carries neither literal parent id.
  assert.deepEqual(
    ids(evaluate(LIB, { includeTagIds: ['blues', 'live'], tagMatch: 'all' }, tree)),
    ['bootleg'])
  // ...and "any" of the same two is a wider net.
  assert.deepEqual(
    ids(evaluate(LIB, { includeTagIds: ['blues', 'live'], tagMatch: 'any' }, tree)),
    ['bootleg', 'muddy', 'wolf'])
})

test('artist, and case-insensitive text across title / artist / album', () => {
  assert.deepEqual(ids(evaluate(LIB, { artistIds: ['ar1'] }, tree)), ['bootleg', 'muddy'])
  assert.deepEqual(ids(evaluate(LIB, { text: 'kind of BLUE' }, tree)), ['miles'])
  assert.deepEqual(ids(evaluate(LIB, { text: 'howlin' }, tree)), ['wolf'])
})

test('a year bound drops tracks with no year rather than letting them through', () => {
  // The bootleg is undated. Treating unknown as passing would quietly fill a
  // 1960s filter with undated rips.
  assert.deepEqual(ids(evaluate(LIB, { yearMin: 1955, yearMax: 1965 }, tree)),
    ['miles', 'muddy', 'wolf'])
  assert.ok(!ids(evaluate(LIB, { yearMin: 1900 }, tree)).includes('bootleg'))
})

test('playCountMax is the "nothing too obvious" lever', () => {
  assert.deepEqual(ids(evaluate(LIB, { playCountMax: 3 }, tree)),
    ['bootleg', 'muddy', 'untagged'])
  assert.deepEqual(ids(evaluate(LIB, { playCountMin: 12 }, tree)), ['miles', 'wolf'])
})

test('added-date bounds are inclusive', () => {
  assert.deepEqual(ids(evaluate(LIB, { addedAfter: 3000, addedBefore: 4000 }, tree)),
    ['bootleg', 'miles'])
})

test('rules are ANDed together', () => {
  assert.deepEqual(
    ids(evaluate(LIB, { includeTagIds: ['blues'], playCountMax: 5, artistIds: ['ar1'] }, tree)),
    ['bootleg', 'muddy'])
})

test('sorting and limit', () => {
  assert.deepEqual(evaluate(LIB, { sort: 'added' }, tree).map((t) => t.id),
    ['untagged', 'bootleg', 'miles', 'wolf', 'muddy'])
  assert.deepEqual(evaluate(LIB, { sort: 'plays', limit: 2 }, tree).map((t) => t.id),
    ['miles', 'wolf'])
  assert.equal(evaluate(LIB, { limit: 0 }, tree).length, 0)
})

test('a seeded shuffle is reproducible, and a different seed differs', () => {
  const a = evaluate(LIB, { sort: 'random', seed: 7 }, tree).map((t) => t.id)
  const b = evaluate(LIB, { sort: 'random', seed: 7 }, tree).map((t) => t.id)
  assert.deepEqual(a, b, 'the same seed gave a different order')
  assert.equal(a.length, LIB.length, 'the shuffle dropped or duplicated tracks')
  assert.deepEqual([...a].sort(), ids(LIB), 'the shuffle changed the set')
  const c = evaluate(LIB, { sort: 'random', seed: 99 }, tree).map((t) => t.id)
  assert.notDeepEqual(a, c, 'two different seeds gave the same order')
})

test('tags work with no tree at all — the literal reading', () => {
  // A filter evaluated before the tree loads must not throw, just not expand.
  assert.deepEqual(ids(evaluate(LIB, { includeTagIds: ['delta'] }, null)), ['bootleg', 'muddy'])
  assert.deepEqual(evaluate(LIB, { includeTagIds: ['blues'] }, null), [])
})

// --- the store ---------------------------------------------------------------

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'allegory-filters-'))
  return { dir, filters: createFilters(dir), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('filters are created, renamed and listed by name', async (t) => {
  const s = await store()
  t.after(s.cleanup)

  const blues = await s.filters.create('Deep Blues', { includeTagIds: ['blues'] })
  await s.filters.create('Anything', {})
  assert.deepEqual((await s.filters.list()).map((f) => f.name), ['Anything', 'Deep Blues'])

  await assert.rejects(() => s.filters.create('deep blues', {}), /already a filter/)
  const renamed = await s.filters.update(blues.id, { name: 'Deeper Blues' })
  assert.equal(renamed.name, 'Deeper Blues')
  assert.ok(renamed.updatedAt >= renamed.createdAt)
})

test('a filter survives a restart, and noteRun records the materialisation', async (t) => {
  const s = await store()
  t.after(s.cleanup)

  const f = await s.filters.create('Unplayed', { playCountMax: 0 })
  await s.filters.noteRun(f.id, 42, 'playlist-abc')

  const fresh = createFilters(s.dir) // cold cache, as after a restart
  const got = await fresh.get(f.id)
  assert.ok(got)
  assert.equal(got.lastCount, 42)
  assert.equal(got.playlistId, 'playlist-abc')
  assert.deepEqual(got.rule, { playCountMax: 0 })
})

test('deleting a filter leaves its materialised playlist alone', async (t) => {
  const s = await store()
  t.after(s.cleanup)

  const f = await s.filters.create('Temp', {})
  await s.filters.noteRun(f.id, 3, 'playlist-xyz')
  await s.filters.remove(f.id)

  assert.equal(await s.filters.get(f.id), undefined)
  // The .m3u is an ordinary playlist people may have queued. Tidying a filter
  // is not permission to delete it; detaching is what happens.
  assert.deepEqual(await s.filters.list(), [])
})
