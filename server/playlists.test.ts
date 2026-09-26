/**
 * Playlist path handling — the `.m3u` write/parse contract.
 *
 * The case that matters most here is the one that used to pass: Allegory wrote
 * paths relative to the music directory and resolved them the same way, so a
 * round-trip through its own parser was perfectly consistent while every other
 * player read the same file as empty. So these tests do not ask "does the line
 * come back out the way it went in?" — they resolve each written line the way
 * an outside reader does, against the folder holding the playlist file, and
 * require a real file to be there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createPlaylists } from './playlists.ts'

/** A music dir with two real tracks, one file outside it, and a Playlists dir. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'allegory-playlists-'))
  const music = join(root, 'Music')
  const plDir = join(music, 'Playlists')
  const trackA = join(music, 'Van Halen', '1984', '01 Jump.flac')
  const trackB = join(music, 'Van Halen', '1984', '02 Panama.flac')
  const guest = join(root, 'Elsewhere', 'guest.flac')
  await mkdir(join(music, 'Van Halen', '1984'), { recursive: true })
  await mkdir(join(root, 'Elsewhere'), { recursive: true })
  await mkdir(plDir, { recursive: true })
  for (const f of [trackA, trackB, guest]) await writeFile(f, 'audio')
  return {
    music,
    plDir,
    trackA,
    trackB,
    guest,
    playlists: createPlaylists(music),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** The track lines of a playlist file, headers dropped. */
async function trackLines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter((l) => l && !l.startsWith('#'))
}

/**
 * Resolve a line the way any other player does — against the folder the
 * playlist file sits in — and report whether a file is actually there. This is
 * the check that distinguishes the bug from a cosmetic path difference.
 */
async function resolvesFromPlaylistDir(plDir: string, line: string): Promise<boolean> {
  const abs = isAbsolute(line) ? line : resolve(plDir, line)
  try {
    await stat(abs)
    return true
  } catch {
    return false
  }
}

test('create() writes paths an outside reader can resolve', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  await f.playlists.create('Road Trip', [f.trackA, f.trackB])
  const lines = await trackLines(join(f.plDir, 'Road Trip.m3u'))

  assert.deepEqual(lines, [
    '../Van Halen/1984/01 Jump.flac',
    '../Van Halen/1984/02 Panama.flac',
  ])
  for (const line of lines) {
    assert.ok(
      await resolvesFromPlaylistDir(f.plDir, line),
      `line does not resolve from the Playlists folder: ${line}`,
    )
  }
})

test('tracks outside the music dir stay absolute, and still resolve', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  await f.playlists.create('Mixed', [f.trackA, f.guest])
  const lines = await trackLines(join(f.plDir, 'Mixed.m3u'))

  assert.equal(lines[0], '../Van Halen/1984/01 Jump.flac')
  assert.ok(isAbsolute(lines[1]), `expected an absolute path, got ${lines[1]}`)
  assert.ok(await resolvesFromPlaylistDir(f.plDir, lines[1]))
})

test('Allegory reads its own output back to the same absolute paths', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const id = await f.playlists.create('Round Trip', [f.trackA, f.trackB, f.guest])
  assert.deepEqual(await f.playlists.paths(id), [f.trackA, f.trackB, f.guest])
})

test('a legacy music-dir-relative playlist still resolves', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  await writeFile(
    join(f.plDir, 'Legacy.m3u'),
    [
      '#EXTM3U',
      '#PLAYLIST:Legacy',
      '#Allegory-ID:deadbeefdeadbeef',
      'Van Halen/1984/01 Jump.flac',
      'Van Halen/1984/02 Panama.flac',
    ].join('\n') + '\n',
  )

  const entry = (await f.playlists.list()).find((p) => p.name === 'Legacy')
  assert.ok(entry, 'legacy playlist was not listed')
  assert.equal(entry.trackCount, 2)
  assert.deepEqual(await f.playlists.paths(entry.id), [f.trackA, f.trackB])
})

test('migrateLegacy() rewrites Allegory’s own legacy files, once', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  await writeFile(
    join(f.plDir, 'Legacy.m3u'),
    [
      '#EXTM3U',
      '#PLAYLIST:Legacy',
      '#Allegory-ID:deadbeefdeadbeef',
      'Van Halen/1984/01 Jump.flac',
    ].join('\n') + '\n',
  )

  assert.equal(await f.playlists.migrateLegacy(), 1)
  // Second run must find nothing: a migration that keeps rewriting the same
  // files would churn mtimes and make Navidrome rescan forever.
  assert.equal(await f.playlists.migrateLegacy(), 0)

  const text = await readFile(join(f.plDir, 'Legacy.m3u'), 'utf8')
  assert.deepEqual(await trackLines(join(f.plDir, 'Legacy.m3u')), [
    '../Van Halen/1984/01 Jump.flac',
  ])
  assert.match(text, /#Allegory-ID:deadbeefdeadbeef/, 'id was not preserved')
  assert.match(text, /#PLAYLIST:Legacy/, 'name was not preserved')
})

test('migrateLegacy() leaves a hand-made playlist byte-identical', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  // No `#Allegory-ID`, and an `#EXTINF` its author put there. Rewriting it
  // would silently discard that line, so it must not be touched at all.
  const handMade = join(f.plDir, 'By Hand.m3u')
  const before =
    ['#EXTM3U', '#EXTINF:241,Van Halen - Jump', 'Van Halen/1984/01 Jump.flac'].join('\n') + '\n'
  await writeFile(handMade, before)

  assert.equal(await f.playlists.migrateLegacy(), 0)
  assert.equal(await readFile(handMade, 'utf8'), before)

  // ...and it is still readable, resolved the legacy way.
  const entry = (await f.playlists.list()).find((p) => p.name === 'By Hand')
  assert.ok(entry)
  assert.deepEqual(await f.playlists.paths(entry.id), [f.trackA])
})

test('replaceTracks keeps the id and file, and leaves an unchanged list alone', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)

  const id = await f.playlists.create('Smart Set', [f.trackA])
  const file = join(f.plDir, 'Smart Set.m3u')
  const before = await stat(file)

  // Swapping contents must not mint a new id or a new file: a smart playlist is
  // refreshed in place, and every client holding a reference — Navidrome's
  // imported row, a queue in Amperfy — would otherwise see it vanish.
  assert.equal(await f.playlists.replaceTracks(id, [f.trackB, f.trackA]), true)
  const after = (await f.playlists.list()).find((p) => p.name === 'Smart Set')
  assert.ok(after)
  assert.equal(after.id, id, 'the playlist id changed')
  assert.deepEqual(await f.playlists.paths(id), [f.trackB, f.trackA])
  assert.deepEqual(await trackLines(file), [
    '../Van Halen/1984/02 Panama.flac',
    '../Van Halen/1984/01 Jump.flac',
  ])

  // An unchanged answer must not churn the mtime, or every refresh sends
  // Navidrome off to rescan for nothing.
  await new Promise((r) => setTimeout(r, 15))
  await f.playlists.replaceTracks(id, [f.trackB, f.trackA])
  assert.equal((await stat(file)).mtimeMs, (await stat(file)).mtimeMs)
  const unchanged = await stat(file)
  await f.playlists.replaceTracks(id, [f.trackB, f.trackA])
  assert.equal((await stat(file)).mtimeMs, unchanged.mtimeMs, 'an unchanged refresh rewrote the file')

  assert.equal(await f.playlists.replaceTracks('nope-not-a-playlist', []), false)
  assert.ok(before.mtimeMs > 0)
})
