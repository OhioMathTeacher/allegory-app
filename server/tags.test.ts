/**
 * Hierarchical tags: the tree queries, cycle prevention, and the one property
 * the sidecar storage was chosen for — tags survive a folder being moved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTree, createTags, type Tag } from './tags.ts'

// --- the tree, on a literal ---------------------------------------------------

/** Roots › Blues › {Delta blues, Chicago blues}, plus an unrelated root. */
function sampleTags(): Tag[] {
  const t = (id: string, name: string, parentId: string | null): Tag => ({
    id,
    name,
    parentId,
    kind: 'genre',
    createdAt: 0,
  })
  return [
    t('roots', 'Roots', null),
    t('blues', 'Blues', 'roots'),
    t('delta', 'Delta blues', 'blues'),
    t('chicago', 'Chicago blues', 'blues'),
    t('punk', 'Punk', null),
  ]
}

test('children() returns direct children, and the roots for null', () => {
  const tree = buildTree(sampleTags())
  assert.deepEqual(
    tree.children('blues').map((t) => t.id),
    ['chicago', 'delta'], // name order, not insertion order
  )
  assert.deepEqual(
    tree.children(null).map((t) => t.id),
    ['punk', 'roots'],
  )
  assert.deepEqual(tree.children('delta'), [])
})

test('ancestors() walks up, nearest first, excluding self', () => {
  const tree = buildTree(sampleTags())
  assert.deepEqual(
    tree.ancestors('delta').map((t) => t.id),
    ['blues', 'roots'],
  )
  assert.deepEqual(tree.ancestors('roots'), [])
})

test('descendants() returns the whole subtree, excluding self', () => {
  const tree = buildTree(sampleTags())
  assert.deepEqual(new Set(tree.descendants('roots').map((t) => t.id)), new Set(['blues', 'delta', 'chicago']))
  assert.deepEqual(tree.descendants('delta'), [])
  assert.deepEqual(tree.descendants('punk'), [])
})

test('path() spells out the lineage', () => {
  assert.equal(buildTree(sampleTags()).path('delta'), 'Roots › Blues › Delta blues')
})

test('wouldCycle() catches self-parenting and every descendant', () => {
  const tree = buildTree(sampleTags())
  assert.equal(tree.wouldCycle('blues', 'blues'), true, 'a tag cannot parent itself')
  assert.equal(tree.wouldCycle('roots', 'delta'), true, 'not into a grandchild')
  assert.equal(tree.wouldCycle('roots', 'blues'), true, 'not into a child')
  assert.equal(tree.wouldCycle('blues', 'punk'), false, 'an unrelated tag is fine')
  assert.equal(tree.wouldCycle('delta', null), false, 'promoting to root is fine')
})

test('a cycle already on disk does not hang the traversals', () => {
  // The tree file is hand-editable, so the guard has to hold for input the app
  // would never have written itself.
  const looped = sampleTags().map((t) => (t.id === 'roots' ? { ...t, parentId: 'delta' } : t))
  const tree = buildTree(looped)
  const ancestors = tree.ancestors('delta').map((t) => t.id)
  assert.ok(ancestors.length < 10, `ancestors did not terminate: ${ancestors.join(',')}`)
  assert.ok(tree.descendants('roots').length < 10, 'descendants did not terminate')
})

test('a parentId pointing at nothing is treated as a root, not dropped', () => {
  const orphaned = sampleTags().map((t) => (t.id === 'blues' ? { ...t, parentId: 'gone' } : t))
  const tree = buildTree(orphaned)
  assert.ok(
    tree.children(null).some((t) => t.id === 'blues'),
    'a tag with a dangling parent vanished from the tree',
  )
})

// --- the store ----------------------------------------------------------------

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allegory-tags-'))
  const music = join(root, 'Music')
  const cache = join(root, 'cache')
  // NOT a purely numeric name: the scanner's CD_SUBDIR rule folds "1984" and
  // the like into the parent folder as a disc subdirectory.
  const albumDir = join(music, 'Van Halen', 'Fair Warning')
  await mkdir(albumDir, { recursive: true })
  await mkdir(cache, { recursive: true })
  const trackA = join(albumDir, '01 Jump.flac')
  const trackB = join(albumDir, '02 Panama.flac')
  for (const f of [trackA, trackB]) await writeFile(f, 'audio')
  return {
    root,
    music,
    cache,
    albumDir,
    trackA,
    trackB,
    tags: createTags(cache),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('createTag is idempotent for a name already under that parent', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const blues = await f.tags.createTag('Blues', 'genre', null)
  const again = await f.tags.createTag('  blues  ', 'genre', null)
  assert.equal(again.id, blues.id, 'a second create made a duplicate tag')
  assert.equal((await f.tags.tree()).all().length, 1)
})

test('reparentTag refuses a cycle and leaves the tree alone', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const roots = await f.tags.createTag('Roots', 'genre', null)
  const blues = await f.tags.createTag('Blues', 'genre', roots.id)
  const delta = await f.tags.createTag('Delta blues', 'genre', blues.id)

  await assert.rejects(() => f.tags.reparentTag(roots.id, delta.id), /inside itself/)
  // The refusal must not have half-applied: Roots is still a root.
  assert.equal((await f.tags.tree()).get(roots.id)?.parentId, null)
})

test('two siblings cannot share a name', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const roots = await f.tags.createTag('Roots', 'genre', null)
  await f.tags.createTag('Blues', 'genre', roots.id)
  const punk = await f.tags.createTag('Punk', 'genre', roots.id)
  await assert.rejects(() => f.tags.renameTag(punk.id, 'blues'), /already a tag/)
})

test('tags are written beside the music and survive the folder moving', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const blues = await f.tags.createTag('Blues', 'genre', null)
  assert.equal(await f.tags.addToTracks([f.trackA], blues.id, 'user'), 1)

  // The sidecar is in the album folder, not in the cache.
  const sidecar = JSON.parse(await readFile(join(f.albumDir, '.allegory-tags.json'), 'utf8'))
  assert.deepEqual(Object.keys(sidecar.files), ['01 Jump.flac'])

  // This is the whole reason assignments are not keyed on the track id: the id
  // is a hash of the relative path, so renaming the folder would have thrown
  // the tagging away.
  const moved = join(f.music, 'Van Halen', 'Fair Warning (Remastered)')
  await rename(f.albumDir, moved)

  const fresh = createTags(f.cache) // a new process, cold caches
  const got = await fresh.tagsForTrack(join(moved, '01 Jump.flac'))
  assert.deepEqual(
    got.tags.map((a) => a.tagId),
    [blues.id],
    'tags did not survive the folder rename',
  )
})

test('filtering by a tag includes its descendants by default', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const blues = await f.tags.createTag('Blues', 'genre', null)
  const delta = await f.tags.createTag('Delta blues', 'genre', blues.id)
  await f.tags.addToTracks([f.trackA], delta.id, 'user')

  const dirs = [f.albumDir]
  assert.deepEqual(await f.tags.tracksWithTag(blues.id, dirs), [f.trackA])
  assert.deepEqual(
    await f.tags.tracksWithTag(blues.id, dirs, { includeDescendants: false }),
    [],
    'the descendant expansion could not be turned off',
  )
})

test('an AI suggestion is invisible until approved, and a rejection sticks', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const mood = await f.tags.createTag('Wistful', 'mood', null)
  const dirs = [f.albumDir]
  await f.tags.addToTracks([f.trackA], mood.id, 'ai', 0.7)

  assert.deepEqual(await f.tags.tracksWithTag(mood.id, dirs), [], 'a guess counted as a fact')
  assert.equal((await f.tags.pending(dirs)).length, 1)

  await f.tags.approve(f.trackA, mood.id)
  assert.deepEqual(await f.tags.tracksWithTag(mood.id, dirs), [f.trackA])
  assert.equal((await f.tags.pending(dirs)).length, 0)

  // Rejecting removes it and is remembered, so the model cannot re-propose it.
  await f.tags.reject(f.trackA, mood.id)
  assert.deepEqual(await f.tags.tracksWithTag(mood.id, dirs), [])
  assert.equal(await f.tags.addToTracks([f.trackA], mood.id, 'ai'), 0, 're-proposed a rejected tag')

  // Todd adding it by hand is not a re-proposal, and clears the rejection.
  assert.equal(await f.tags.addToTracks([f.trackA], mood.id, 'user'), 1)
  assert.deepEqual((await f.tags.tagsForTrack(f.trackA)).rejected, [])
})

test('removeTag lifts its children rather than dropping the subtree', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const roots = await f.tags.createTag('Roots', 'genre', null)
  const blues = await f.tags.createTag('Blues', 'genre', roots.id)
  const delta = await f.tags.createTag('Delta blues', 'genre', blues.id)
  await f.tags.addToTracks([f.trackA], blues.id, 'user')

  await f.tags.removeTag(blues.id, [f.albumDir])

  const tree = await f.tags.tree()
  assert.equal(tree.get(blues.id), undefined)
  assert.equal(tree.get(delta.id)?.parentId, roots.id, 'Delta blues was orphaned')
  assert.deepEqual((await f.tags.tagsForTrack(f.trackA)).tags, [])
})

test('mergeTags moves assignments and keeps the stronger claim', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const keep = await f.tags.createTag('Blues', 'genre', null)
  const fold = await f.tags.createTag('blues rock', 'genre', null)
  const child = await f.tags.createTag('Delta blues', 'genre', fold.id)

  await f.tags.addToTracks([f.trackA], fold.id, 'user')
  await f.tags.addToTracks([f.trackB], keep.id, 'ai')
  await f.tags.addToTracks([f.trackB], fold.id, 'user')

  await f.tags.mergeTags(fold.id, keep.id, [f.albumDir])

  const tree = await f.tags.tree()
  assert.equal(tree.get(fold.id), undefined, 'the folded tag survived')
  assert.equal(tree.get(child.id)?.parentId, null, 'its child was not lifted')

  assert.deepEqual(
    (await f.tags.tagsForTrack(f.trackA)).tags.map((a) => a.tagId),
    [keep.id],
  )
  // trackB had both: an unapproved AI guess for the keeper and a hand-made tag
  // for the one being folded in. The merge must not leave it a guess.
  const b = (await f.tags.tagsForTrack(f.trackB)).tags
  assert.equal(b.length, 1)
  assert.equal(b[0].source, 'user', 'a merge downgraded a hand-made tag to an AI guess')
})

test('migrateGenres folds file genres in once, and stays put on a second run', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const tracks = [
    { path: f.trackA, genres: ['Hard Rock', 'Rock'] },
    { path: f.trackB, genres: ['hard rock'] }, // same tag, different casing
  ]

  const first = await f.tags.migrateGenres(tracks)
  assert.equal(first.tagsCreated, 2, 'casing was treated as two different genres')
  assert.equal(first.filesTagged, 2)

  const second = await f.tags.migrateGenres(tracks)
  assert.deepEqual(second, { tagsCreated: 0, filesTagged: 0 }, 'the migration was not idempotent')

  const hardRock = (await f.tags.tree()).all().find((x) => x.name === 'Hard Rock')
  assert.ok(hardRock)
  assert.equal((await f.tags.counts([f.albumDir]))[hardRock.id], 2)
})

test('a genre Todd has reparented is not duplicated back at the root', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  // Migrate, then file "Hard Rock" under a parent — the ordinary reason the
  // tree exists. A later rescan must not recreate it as a root tag.
  await f.tags.migrateGenres([{ path: f.trackA, genres: ['Hard Rock'] }])
  const rock = await f.tags.createTag('Rock', 'genre', null)
  const hardRock = (await f.tags.tree()).all().find((x) => x.name === 'Hard Rock')!
  await f.tags.reparentTag(hardRock.id, rock.id)

  const again = await f.tags.migrateGenres([{ path: f.trackA, genres: ['Hard Rock'] }])
  assert.equal(again.tagsCreated, 0)
  const named = (await f.tags.tree()).all().filter((x) => x.name === 'Hard Rock')
  assert.equal(named.length, 1, 'the migration duplicated a reparented genre at the root')
  assert.equal(named[0].parentId, rock.id, 'the migration reset its parent')
})

test('orphansIn surfaces a vanished file rather than discarding its tags', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const blues = await f.tags.createTag('Blues', 'genre', null)
  await f.tags.addToTracks([f.trackA], blues.id, 'user')

  // A rename inside the folder is the one move the sidecar cannot follow. The
  // entry is kept so the undo is not lossy, and reported so the UI can ask.
  assert.deepEqual(await f.tags.orphansIn(f.albumDir, ['02 Panama.flac']), ['01 Jump.flac'])
  assert.deepEqual(await f.tags.orphansIn(f.albumDir, ['01 Jump.flac', '02 Panama.flac']), [])
})

test('relocate carries assignments across a file move, and unions on collision', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const other = join(f.music, 'Van Halen', 'Diver Down')
  await mkdir(other, { recursive: true })
  const moved = join(other, '01 Jump.flac')

  const blues = await f.tags.createTag('Blues', 'genre', null)
  const punk = await f.tags.createTag('Punk', 'genre', null)
  await f.tags.addToTracks([f.trackA], blues.id, 'user')

  assert.equal(await f.tags.relocate([{ from: f.trackA, to: moved }]), 1)
  assert.deepEqual((await f.tags.tagsForTrack(f.trackA)).tags, [], 'the old entry was left behind')
  assert.deepEqual(
    (await f.tags.tagsForTrack(moved)).tags.map((a) => a.tagId),
    [blues.id],
  )

  // Moving onto a name that is already tagged unions the two rather than
  // overwriting — the destination's own tagging is not someone else's to drop.
  await f.tags.addToTracks([f.trackB], punk.id, 'user')
  await f.tags.relocate([{ from: moved, to: f.trackB }])
  assert.deepEqual(
    new Set((await f.tags.tagsForTrack(f.trackB)).tags.map((a) => a.tagId)),
    new Set([punk.id, blues.id]),
  )

  // An untagged file is not worth writing a sidecar for.
  assert.equal(await f.tags.relocate([{ from: join(other, 'nothing.flac'), to: moved }]), 0)
})

test('combining albums carries the tags with the files', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  // Two albums whose track filenames collide, so the mover has to rename one —
  // the case where a sidecar keyed on filename would land on the wrong file.
  const albumB = join(f.music, 'Van Halen', 'Diver Down')
  await mkdir(albumB, { recursive: true })
  const bTrack = join(albumB, '01 Jump.flac')
  await writeFile(bTrack, 'audio')

  const blues = await f.tags.createTag('Blues', 'genre', null)
  const punk = await f.tags.createTag('Punk', 'genre', null)
  await f.tags.addToTracks([f.trackA], blues.id, 'user')
  await f.tags.addToTracks([bTrack], punk.id, 'user')

  const { createLibrary } = await import('./scanner.ts')
  const library = createLibrary(f.music)
  await library.scan()
  const albums = library.albums()
  const target = albums.find((a) => a.name === 'Fair Warning')
  const source = albums.find((a) => a.name === 'Diver Down')
  assert.ok(target && source, `expected both albums, got ${albums.map((a) => a.name).join(', ')}`)

  const moves: { from: string; to: string }[] = []
  await library.combineAlbums(target.id, [source.id], (from, to) => moves.push({ from, to }))
  assert.ok(
    moves.some((m) => m.from === bTrack && m.to !== join(f.albumDir, '01 Jump.flac')),
    `expected the colliding file to be renamed, got ${JSON.stringify(moves)}`,
  )

  assert.equal(await f.tags.relocate(moves), 1)

  // The moved track kept its own tag, under its new name, and did not inherit
  // the tag of the file it collided with.
  const landed = moves.find((m) => m.from === bTrack)!.to
  assert.deepEqual(
    (await f.tags.tagsForTrack(landed)).tags.map((a) => a.tagId),
    [punk.id],
  )
  assert.deepEqual(
    (await f.tags.tagsForTrack(join(f.albumDir, '01 Jump.flac'))).tags.map((a) => a.tagId),
    [blues.id],
  )
})
