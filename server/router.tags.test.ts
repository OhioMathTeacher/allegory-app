/**
 * The tag endpoints, over a real HTTP server.
 *
 * This goes through `http` and `fetch` rather than calling the handler
 * directly, because half of what these routes do is routing: `/api/tags/pending`
 * has to be matched before `/api/tags/:id`, and a unit call on the handler with
 * a hand-made request object would not have caught getting that order wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibrary } from './scanner.ts'
import { createPlaylists } from './playlists.ts'
import { createSettings } from './settings.ts'
import { createAuth } from './auth.ts'
import { createPortraits } from './artist-portrait.ts'
import { createTags } from './tags.ts'
import { createRouter } from './router.ts'

async function serve() {
  const root = await mkdtemp(join(tmpdir(), 'allegory-router-'))
  const music = join(root, 'Music')
  const cache = join(root, 'cache')
  const albumDir = join(music, 'Van Halen', 'Fair Warning')
  await mkdir(albumDir, { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(join(albumDir, '01 Mean Street.flac'), 'audio')
  await writeFile(join(albumDir, '02 Dirty Movies.flac'), 'audio')

  const library = createLibrary(music)
  const ready = library.scan()
  const tags = createTags(cache)
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
    tags,
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
    library,
    tags,
    albumDir,
    cleanup: async () => {
      await new Promise<void>((done) => server.close(() => done()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('the tag endpoints create, tag, filter and review over HTTP', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  // An empty tree, and the kinds the UI populates its dropdown from.
  const empty = await s.api('GET', '/tags')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.tags, [])
  assert.ok(empty.json.kinds.includes('genre'))

  const blues = (await s.api('POST', '/tags', { name: 'Blues', kind: 'genre' })).json
  const delta = (
    await s.api('POST', '/tags', { name: 'Delta blues', kind: 'genre', parentId: blues.id })
  ).json
  assert.equal(delta.parentId, blues.id)

  // A bad kind is refused rather than silently stored as something else.
  const bad = await s.api('POST', '/tags', { name: 'Nope', kind: 'flavour' })
  assert.equal(bad.status, 400)

  const tracks = s.library.allTracks()
  assert.equal(tracks.length, 2, 'the fixture library did not scan as expected')

  const added = await s.api('POST', `/tags/${delta.id}/tracks`, { trackIds: [tracks[0].id] })
  assert.equal(added.json.changed, 1)

  // Asking for the parent finds the track filed under the child — the whole
  // point of the tree, and the default.
  const viaParent = await s.api('GET', `/tags/${blues.id}/tracks`)
  assert.equal(viaParent.json.length, 1)
  const viaParentOnly = await s.api('GET', `/tags/${blues.id}/tracks?descendants=0`)
  assert.equal(viaParentOnly.json.length, 0)

  // Counts come back with the tree, so the UI needs one request.
  const withCounts = await s.api('GET', '/tags')
  assert.equal(withCounts.json.counts[delta.id], 1)

  // `/tags/pending` must not be read as a tag id.
  const mood = (await s.api('POST', '/tags', { name: 'Wistful', kind: 'mood' })).json
  await s.api('POST', `/tags/${mood.id}/tracks`, {
    trackIds: [tracks[1].id],
    source: 'ai',
    confidence: 0.6,
  })
  const pending = await s.api('GET', '/tags/pending')
  assert.equal(pending.status, 200, 'GET /tags/pending was not routed')
  assert.equal(pending.json.length, 1)
  assert.equal(pending.json[0].trackId, tracks[1].id)
  // Unapproved, so it does not show up as a fact yet.
  assert.equal((await s.api('GET', `/tags/${mood.id}/tracks`)).json.length, 0)

  const ok = await s.api('POST', `/tracks/${tracks[1].id}/tags/${mood.id}?verdict=approve`)
  assert.equal(ok.status, 200)
  assert.equal((await s.api('GET', `/tags/${mood.id}/tracks`)).json.length, 1)

  // A verdict is required — a bare POST must not quietly do one of them.
  const noVerdict = await s.api('POST', `/tracks/${tracks[1].id}/tags/${mood.id}`)
  assert.equal(noVerdict.status, 400)

  // A track's own assignments.
  const own = await s.api('GET', `/tracks/${tracks[0].id}/tags`)
  assert.deepEqual(
    own.json.tags.map((a: { tagId: string }) => a.tagId),
    [delta.id],
  )

  // Reparenting into a descendant is refused with the server's own message.
  const cycle = await s.api('PATCH', `/tags/${blues.id}`, { parentId: delta.id })
  assert.equal(cycle.status, 400, 'a bad move should be a 400, not a server error')
  assert.match(cycle.json.error, /inside itself/)

  // Merge, then delete.
  assert.equal((await s.api('POST', `/tags/${delta.id}/merge`, { targetId: blues.id })).status, 200)
  assert.equal((await s.api('GET', `/tags/${blues.id}/tracks?descendants=0`)).json.length, 1)
  assert.equal((await s.api('DELETE', `/tags/${blues.id}`)).status, 200)
  assert.deepEqual((await s.api('GET', '/tags')).json.tags.map((t: { name: string }) => t.name), [
    'Wistful',
  ])
})

test('POST /tags/migrate folds the files’ own genres in, idempotently', async (t) => {
  const s = await serve()
  t.after(s.cleanup)

  // No real genre frames on these stub files, so the migration has nothing to
  // do — which is the case worth pinning: it must report zero, not fail.
  const first = await s.api('POST', '/tags/migrate')
  assert.equal(first.status, 200)
  assert.deepEqual(first.json, { tagsCreated: 0, filesTagged: 0 })

  const again = await s.api('POST', '/tags/migrate')
  assert.deepEqual(again.json, { tagsCreated: 0, filesTagged: 0 })
})
