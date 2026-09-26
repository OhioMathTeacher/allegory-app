/**
 * Saved filters over HTTP, and the smart playlist they materialise.
 *
 * The point of this file is the join: a filter is only useful if its answer
 * ends up in a `.m3u` that something else can read, keeping the same identity
 * across refreshes. That crosses filters.ts, playlists.ts and the router, so it
 * is tested through the real server rather than by unit-calling each part.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createLibrary } from './scanner.ts'
import { createPlaylists } from './playlists.ts'
import { createSettings } from './settings.ts'
import { createAuth } from './auth.ts'
import { createPortraits } from './artist-portrait.ts'
import { createTags } from './tags.ts'
import { createFilters } from './filters.ts'
import { createRouter } from './router.ts'

async function serve() {
  const root = await mkdtemp(join(tmpdir(), 'allegory-filters-api-'))
  const music = join(root, 'Music')
  const cache = join(root, 'cache')
  const blues = join(music, 'Muddy Waters', 'Folk Singer')
  const jazz = join(music, 'Miles Davis', 'Kind of Blue')
  await mkdir(blues, { recursive: true })
  await mkdir(jazz, { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(join(blues, '01 My Home.flac'), 'audio')
  await writeFile(join(blues, '02 You Need Help.flac'), 'audio')
  await writeFile(join(jazz, '01 So What.flac'), 'audio')

  const library = createLibrary(music)
  const ready = library.scan()
  const router = createRouter({
    library,
    playlists: createPlaylists(music),
    ready,
    artCacheDir: join(cache, 'art'),
    transcodeCacheDir: join(cache, 'transcode'),
    settings: createSettings(cache, music),
    onMusicDirChange: async () => {},
    portraits: createPortraits(cache),
    auth: createAuth(cache),
    tags: createTags(cache),
    filters: createFilters(cache),
  })

  const server = createServer((req, res) => {
    void router.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  await ready

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }

  return {
    api,
    music,
    library,
    plDir: join(music, 'Playlists'),
    cleanup: async () => {
      await new Promise<void>((done) => server.close(() => done()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('a filter becomes a real .m3u that an outside reader can resolve', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  // Tag the two blues tracks.
  const blues = (await s.api('POST', '/tags', { name: 'Blues', kind: 'genre' })).json
  const delta = (
    await s.api('POST', '/tags', { name: 'Delta blues', kind: 'genre', parentId: blues.id })
  ).json
  const bluesTracks = s.library
    .allTracks()
    .filter((x) => x.path.includes('Folk Singer'))
    .map((x) => x.id)
  assert.equal(bluesTracks.length, 2)
  await s.api('POST', `/tags/${delta.id}/tracks`, { trackIds: bluesTracks })

  // Preview an unsaved rule first — what the builder does on every keystroke.
  const preview = await s.api('POST', '/filters/preview', {
    rule: { includeTagIds: [blues.id] },
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.count, 2, 'the parent tag did not expand to its child')

  const saved = (
    await s.api('POST', '/filters', {
      name: 'All Blues',
      rule: { includeTagIds: [blues.id], sort: 'album' },
    })
  ).json
  assert.equal(saved.name, 'All Blues')

  const run = await s.api('POST', `/filters/${saved.id}/materialize`)
  assert.equal(run.status, 200)
  assert.equal(run.json.count, 2)

  // The payoff: a real playlist file, with paths an outside player resolves.
  const lines = (await readFile(join(s.plDir, 'All Blues.m3u'), 'utf8'))
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.ok(line.startsWith('../'), `not file-relative: ${line}`)
    const abs = isAbsolute(line) ? line : resolve(s.plDir, line)
    await readFile(abs) // throws if the line points at nothing
  }
})

test('refreshing a smart playlist keeps its id, and picks up new matches', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  const mood = (await s.api('POST', '/tags', { name: 'Late night', kind: 'mood' })).json
  const all = s.library.allTracks()
  await s.api('POST', `/tags/${mood.id}/tracks`, { trackIds: [all[0].id] })

  const f = (await s.api('POST', '/filters', {
    name: 'Late Night',
    rule: { includeTagIds: [mood.id] },
  })).json
  const first = await s.api('POST', `/filters/${f.id}/materialize`)
  assert.equal(first.json.count, 1)
  const playlistId = first.json.playlistId

  // Tag a second track and refresh.
  await s.api('POST', `/tags/${mood.id}/tracks`, { trackIds: [all[1].id] })
  const second = await s.api('POST', `/filters/${f.id}/materialize`)
  assert.equal(second.json.count, 2, 'the refresh did not pick up the new match')
  assert.equal(
    second.json.playlistId,
    playlistId,
    'the refresh minted a new playlist id — every client holding a reference would lose it',
  )

  // One playlist file, not two.
  const list = (await s.api('GET', '/playlists')).json
  assert.equal(list.filter((p: { name: string }) => p.name === 'Late Night').length, 1)
  assert.equal(list.find((p: { id: string }) => p.id === playlistId).trackCount, 2)
})

test('filters are named uniquely, and a missing one 404s rather than 500s', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  await s.api('POST', '/filters', { name: 'Unplayed', rule: { playCountMax: 0 } })
  const dupe = await s.api('POST', '/filters', { name: 'unplayed', rule: {} })
  assert.equal(dupe.status, 400)
  assert.match(dupe.json.error, /already a filter/)

  assert.equal((await s.api('POST', '/filters/nope/materialize')).status, 404)
  assert.equal((await s.api('GET', '/filters/nope/tracks')).status, 404)
})

test('everything with no plays is a filter, and it matches the whole library', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  // Nothing has been played in a fresh fixture, so playCountMax: 0 is the whole
  // library — the "nothing too obvious" lever at its widest.
  const f = (await s.api('POST', '/filters', {
    name: 'Never Played',
    rule: { playCountMax: 0, sort: 'artist' },
  })).json
  const tracks = (await s.api('GET', `/filters/${f.id}/tracks`)).json
  assert.equal(tracks.length, 3)
  assert.equal(tracks[0].artist, 'Miles Davis', 'artist sort did not apply')
})

test('the Socrates shortlist expands seed tags and reacts to rejections', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  const blues = (await s.api('POST', '/tags', { name: 'Blues', kind: 'genre' })).json
  const delta = (
    await s.api('POST', '/tags', { name: 'Delta blues', kind: 'genre', parentId: blues.id })
  ).json
  const jazz = (await s.api('POST', '/tags', { name: 'Jazz', kind: 'genre' })).json

  const bluesIds = s.library.allTracks().filter((x) => x.path.includes('Folk Singer')).map((x) => x.id)
  const jazzIds = s.library.allTracks().filter((x) => x.path.includes('Kind of Blue')).map((x) => x.id)
  await s.api('POST', `/tags/${delta.id}/tracks`, { trackIds: bluesIds })
  await s.api('POST', `/tags/${jazz.id}/tracks`, { trackIds: jazzIds })

  // Seeding with the parent offers what is filed beneath it, and nothing else.
  const seeded = await s.api('POST', '/socrates/candidates', { tagIds: [blues.id] })
  assert.equal(seeded.status, 200)
  assert.equal(seeded.json.candidates.length, 2)
  assert.ok(
    seeded.json.candidates.every((c: { tags: string[] }) => c.tags.includes('Delta blues')),
    'the shortlist leaked something outside the seed',
  )
  // The model is sent the branch it needs, not the whole vocabulary.
  assert.match(seeded.json.tagTree, /Blues/)
  assert.doesNotMatch(seeded.json.tagTree, /Jazz/)

  // Tag names, not ids — this goes to a language model.
  assert.ok(!seeded.json.candidates[0].tags.includes(delta.id))

  // Rejecting a track excludes it AND down-weights what it carried.
  const rejectedId = seeded.json.candidates[0].trackId
  const revised = await s.api('POST', '/socrates/candidates', {
    tagIds: [blues.id],
    rejectedTrackIds: [rejectedId],
    excludeTrackIds: [rejectedId],
  })
  assert.ok(
    !revised.json.candidates.some((c: { trackId: string }) => c.trackId === rejectedId),
    'a rejected track was offered again',
  )
  assert.ok(
    revised.json.weights['Delta blues'] < 1,
    `rejection did not become a weight: ${JSON.stringify(revised.json.weights)}`,
  )
})

test('a filter can seed a Socrates session — Phase 2 into Phase 3', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  const jazz = (await s.api('POST', '/tags', { name: 'Jazz', kind: 'genre' })).json
  const jazzIds = s.library.allTracks().filter((x) => x.path.includes('Kind of Blue')).map((x) => x.id)
  await s.api('POST', `/tags/${jazz.id}/tracks`, { trackIds: jazzIds })

  const f = (await s.api('POST', '/filters', {
    name: 'Just Jazz',
    rule: { includeTagIds: [jazz.id] },
  })).json

  // The filter narrows the pool, and its own include-tags become the seed.
  const res = await s.api('POST', '/socrates/candidates', { filterId: f.id })
  assert.equal(res.status, 200)
  assert.equal(res.json.poolSize, 1, 'the filter did not narrow the pool')
  assert.equal(res.json.candidates.length, 1)
  assert.equal(res.json.candidates[0].artist, 'Miles Davis')

  assert.equal((await s.api('POST', '/socrates/candidates', { filterId: 'nope' })).status, 404)
})

test('the play-count ceiling is honoured, and an empty shortlist is not an error', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  const tag = (await s.api('POST', '/tags', { name: 'Anything', kind: 'other' })).json
  await s.api('POST', `/tags/${tag.id}/tracks`, {
    trackIds: s.library.allTracks().map((x) => x.id),
  })

  // Nothing has been played in a fresh fixture, so a ceiling of 0 keeps
  // everything — the lever at its widest rather than its narrowest.
  const wide = await s.api('POST', '/socrates/candidates', { tagIds: [tag.id], playCountMax: 0 })
  assert.equal(wide.json.candidates.length, 3)

  // A seed tag nothing carries is an empty shortlist, answered as 200 with an
  // empty list — the UI says "loosen it", which a 500 could not.
  const other = (await s.api('POST', '/tags', { name: 'Nothing', kind: 'other' })).json
  const empty = await s.api('POST', '/socrates/candidates', { tagIds: [other.id] })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.candidates, [])
})
