/**
 * The local HTTP API that replaces the Jellyfin server: library browsing,
 * playlist editing, audio streaming (with Range support so the browser can
 * seek) and on-the-fly cover-art thumbnails.
 */
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join } from 'node:path'
import sharp from 'sharp'
import type { Library } from './scanner.ts'
import type { Playlists } from './playlists.ts'
import type { SettingsStore } from './settings.ts'
import { editAlbum, renameArtist, applyAlbumTags, readFullTags } from './metadata.ts'
import {
  getArtistRelated,
  getArtistTopTracks,
  setArtistTags,
} from './artist-related.ts'
import type { PortraitStore } from './artist-portrait.ts'
import {
  getMixes,
  getMissingAlbums,
  getRecommendations,
} from './discover.ts'
import { saveUpload } from './upload.ts'
import { recordPlay, getPlayHistory } from './play-history.ts'
import {
  appendListen,
  getListenStats,
  seedIfEmpty,
  type ListenWindow,
} from './listen-log.ts'
import { transcodedPath } from './transcode.ts'

// A fresh id per server process. The in-app updater watches this: it only
// reloads the page once this changes, which proves the server has actually
// restarted on the freshly-built code — not merely that `git reset` moved HEAD
// (which happens seconds in, long before npm install + build + restart finish).
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.alac': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
}

/**
 * Audio formats that some browsers can't decode, mapped to the capability
 * token the client advertises in `?can=` (see `audioStreamUrl`). If a track's
 * format token is absent from the client's list, we transcode to AAC before
 * streaming. mp3/m4a/mp4/alac/aac are universally supported and omitted here —
 * they're never transcoded. Notably Safari has no Ogg Vorbis/Opus support, so
 * `.ogg`/`.oga`/`.opus` get transcoded for it (e.g. "Bright Horses").
 */
const RISKY_FORMAT: Record<string, string> = {
  '.ogg': 'ogg',
  '.oga': 'ogg',
  '.opus': 'opus',
  '.flac': 'flac',
  '.wav': 'wav',
  '.aif': 'aiff',
  '.aiff': 'aiff',
  '.wma': 'wma',
}

interface RouterDeps {
  library: Library
  playlists: Playlists
  /** Resolves once the initial library scan has finished. */
  ready: Promise<void>
  /** Where resized cover-art thumbnails are cached. */
  artCacheDir: string
  /** Where AAC transcodes of browser-incompatible formats are cached. */
  transcodeCacheDir: string
  /** Persistent settings (musicDir live here once a user has set one). */
  settings: SettingsStore
  /** Swap the library/playlists to a new musicDir and trigger a fresh scan. */
  onMusicDirChange: (newDir: string) => Promise<void>
  /** Portraits for artists that aren't in the library (Deezer-backed). */
  portraits: PortraitStore
}

export interface Router {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  /** Hot-swap in a freshly-built library + playlists after a music-dir change. */
  reload: (next: { library: Library; playlists: Playlists; ready: Promise<void> }) => void
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Read a request body as raw bytes — for file uploads. */
function readRawBody(
  req: IncomingMessage,
  limit = 25 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Image is too large (25 MB max).'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * Download an image from a user-supplied URL, server-side. Doing the fetch here
 * (rather than in the browser) sidesteps CORS, which blocks fetching most
 * remote artwork from the page. Restricted to http(s); rejects non-images,
 * oversized payloads and slow hosts. Returns the raw bytes for `sharp` to
 * validate and re-encode, exactly like an uploaded file.
 */
async function fetchRemoteImage(rawUrl: string | undefined): Promise<Buffer> {
  const url = (rawUrl ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Enter an image URL starting with http:// or https://.')
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15000)
  let res: Response
  try {
    res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Allegory', Accept: 'image/*' },
    })
  } catch {
    throw new Error('Could not reach that URL.')
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`That URL returned ${res.status}.`)
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (type && !type.startsWith('image/')) {
    throw new Error('That URL does not point to an image.')
  }
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error('Image is too large (25 MB max).')
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error('Image is too large (25 MB max).')
  }
  if (buf.length === 0) throw new Error('That URL returned an empty response.')
  return buf
}

/**
 * Get the image bytes for an art-upload request, from either a JSON `{ url }`
 * body (fetched server-side) or the raw request body (a direct file upload).
 * The two cover-art entry points share this so every endpoint accepts both.
 */
async function readImageUpload(req: IncomingMessage): Promise<Buffer> {
  const ct = (req.headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    const body = (await readBody(req)) as { url?: string }
    return fetchRemoteImage(body.url)
  }
  return readRawBody(req)
}

/** Run a git command in the repo (process.cwd()), capturing its output. */
function runGit(
  args: string[],
  timeoutMs = 12000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('git', args, { cwd: process.cwd() })
    } catch {
      resolve({ ok: false, stdout: '', stderr: 'git not found' })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: stderr || 'git not found' })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr })
    })
  })
}

/** Stream an audio file, honouring a `Range` header so seeking works. */
async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<void> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    res.writeHead(404).end()
    return
  }
  const type = AUDIO_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.range

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? Number(m[1]) : 0
    let end = m && m[2] ? Number(m[2]) : size - 1
    if (Number.isNaN(start) || start < 0) start = 0
    if (Number.isNaN(end) || end >= size) end = size - 1
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
      return
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
    createReadStream(path, { start, end }).pipe(res)
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    })
    createReadStream(path).pipe(res)
  }
}

/**
 * Per-song curation sidecar — "Cliff's Notes for the model." The curator drops
 * a file next to a track and Socrates is grounded with their exact angle:
 *   <track>.md               → notes (the curator's OWN writing; see NOTE_EXTS)
 *   <track>.lrc              → lyrics (verbatim — the client only forwards
 *                              these to a LOCAL model; see SocratesPanel)
 * Absent sidecar = both null = a graceful 404. The filesystem is the curation
 * layer: no DB, no config — just drop a note beside a song.
 */
export interface SongContext {
  notes: string | null
  lyrics: string | null
}

/**
 * Extensions treated as curator NOTES — deliberately only `.md`. A `.txt` in a
 * music library is almost always something else (pasted lyrics, a tracklist,
 * even stray recovery codes), so feeding it to the model as "notes" is a
 * privacy/copyright leak and inflates the annotated-song count. Verbatim lyrics
 * live in `.lrc` and are handled separately (local-model-only).
 */
const NOTE_EXTS = ['.md']

/** Read the first existing, non-empty sidecar from the candidate extensions. */
async function readSidecar(audioPath: string, exts: string[]): Promise<string | null> {
  const dir = dirname(audioPath)
  const stem = basename(audioPath, extname(audioPath))
  for (const ext of exts) {
    try {
      const text = await readFile(join(dir, stem + ext), 'utf8')
      if (text.trim()) return text
    } catch {
      // ENOENT or unreadable — try the next candidate.
    }
  }
  return null
}

/**
 * Flatten optional YAML-ish frontmatter into plain `key: value` lines so the
 * whole note reads as prose to the model (no YAML parser needed — the fields
 * are themselves useful grounding, e.g. "thinker: Simone Weil").
 */
function flattenFrontmatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!m) return md.trim()
  return `${m[1].trim()}\n\n${md.slice(m[0].length).trim()}`.trim()
}

/** Strip LRC timing tags so lyrics read as plain prose. */
function stripLrc(raw: string): string {
  return raw
    .split(/\r?\n/)
    // Drop pure metadata tags like [ar:...] [ti:...] [length:...].
    .filter((line) => !/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(line))
    // Remove leading/stacked [mm:ss.xx] timestamps from each line.
    .map((line) => line.replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function readSongContext(audioPath: string): Promise<SongContext> {
  const [notes, lrc] = await Promise.all([
    readSidecar(audioPath, NOTE_EXTS),
    readSidecar(audioPath, ['.lrc']),
  ])
  return {
    notes: notes ? flattenFrontmatter(notes) : null,
    lyrics: lrc ? stripLrc(lrc) : null,
  }
}

/**
 * Where to write a track's notes: reuse an existing `.md` if there is one,
 * otherwise default to `<stem>.md`. Only `.md` counts as notes (see NOTE_EXTS),
 * so a track's stray `.txt` lyrics are never clobbered by a note write.
 */
async function notesSidecarPath(audioPath: string): Promise<{ existing: string | null; fallback: string }> {
  const dir = dirname(audioPath)
  const stem = basename(audioPath, extname(audioPath))
  const fallback = join(dir, `${stem}.md`)
  for (const ext of NOTE_EXTS) {
    const p = join(dir, stem + ext)
    try {
      await stat(p)
      return { existing: p, fallback }
    } catch {
      // not this one
    }
  }
  return { existing: null, fallback }
}

/** Write (or, on empty input, delete) a track's notes sidecar. */
async function writeSongNotes(audioPath: string, notes: string): Promise<boolean> {
  const { existing, fallback } = await notesSidecarPath(audioPath)
  if (!notes.trim()) {
    if (existing) await unlink(existing).catch(() => undefined)
    return false
  }
  await writeFile(existing ?? fallback, notes.endsWith('\n') ? notes : `${notes}\n`, 'utf8')
  return true
}

export function createRouter(deps: RouterDeps): Router {
  // These three are `let` so a music-dir change can swap them in without
  // unmounting the middleware or restarting Vite.
  let library = deps.library
  let playlists = deps.playlists
  let ready = deps.ready
  const { artCacheDir, transcodeCacheDir, settings, onMusicDirChange, portraits } =
    deps

  /** Map track ids to their absolute file paths. */
  function pathsFor(trackIds: string[]): string[] {
    return trackIds
      .map((id) => library.track(id)?.path)
      .filter((p): p is string => !!p)
  }

  async function serveArt(
    res: ServerResponse,
    id: string,
    size: number,
  ): Promise<void> {
    let src = library.artPathFor(id)
    if (!src) {
      // The id may be a playlist: prefer a custom cover the user set...
      src = await playlists.customArtPath(id)
    }
    if (!src) {
      // ...otherwise fall back to its first track's album cover.
      const first = (await playlists.paths(id))[0]
      if (first) src = library.artPathForFile(first)
    }
    if (!src) {
      res.writeHead(404).end()
      return
    }
    const cacheFile = join(artCacheDir, `${id}-${size}.jpg`)
    try {
      const cached = await readFile(cacheFile)
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': cached.length,
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(cached)
      return
    } catch {
      // Not cached yet — render it below.
    }
    try {
      const buf = await sharp(src)
        .resize(size, size, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 82 })
        .toBuffer()
      await mkdir(artCacheDir, { recursive: true })
      await writeFile(cacheFile, buf).catch(() => undefined)
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(buf)
    } catch {
      // sharp couldn't read it — fall back to the original image file.
      try {
        const raw = await readFile(src)
        const ext = extname(src).toLowerCase()
        const type =
          ext === '.png' ? 'image/png'
          : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
          : 'image/jpeg'
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': raw.length,
          'Cache-Control': 'public, max-age=86400',
        })
        res.end(raw)
      } catch {
        res.writeHead(500).end()
      }
    }
  }

  /** Handle an `/api/*` request. Returns false if the path isn't ours. */
  function reload(next: { library: Library; playlists: Playlists; ready: Promise<void> }): void {
    library = next.library
    playlists = next.playlists
    ready = next.ready
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segs = url.pathname.split('/').filter(Boolean)
    if (segs[0] !== 'api') return false

    const method = req.method ?? 'GET'
    const seg = (i: number) => decodeURIComponent(segs[i] ?? '')

    // Permissive CORS so a phone served by one island can browse, fetch art
    // from, stream from, and probe another island it's chosen to control.
    // Safe for a LAN tool — the API is read-mostly and the box isn't public.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Allegory-Path')
    if (method === 'OPTIONS') {
      res.writeHead(204).end()
      return true
    }

    try {
      // --- status (used by the rescan progress poll) ----------------------
      if (segs.length === 2 && segs[1] === 'status' && method === 'GET') {
        sendJson(res, library.status())
        return true
      }

      // --- cleanup analysis (duplicate/variant + junk artists) ------------
      if (segs.length === 2 && segs[1] === 'cleanup' && method === 'GET') {
        sendJson(res, library.cleanupReport())
        return true
      }

      // --- upload (drag-and-drop) ----------------------------------------
      // One file per request; client sends the relative path as a header
      // so we can preserve the dropped folder structure on disk.
      if (segs.length === 2 && segs[1] === 'upload' && method === 'POST') {
        const headerRaw = req.headers['x-allegory-path']
        const raw = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw
        if (!raw) {
          sendJson(res, { error: 'Missing X-Tsm-Path header.' }, 400)
          return true
        }
        let relPath: string
        try {
          relPath = decodeURIComponent(raw)
        } catch {
          sendJson(res, { error: 'X-Tsm-Path is not valid URL-encoding.' }, 400)
          return true
        }
        const body = await readRawBody(req, 500 * 1024 * 1024)
        const result = await saveUpload(library.musicDir, relPath, body)
        sendJson(res, { ok: true, ...result })
        return true
      }

      // --- rescan ---------------------------------------------------------
      if (segs.length === 2 && segs[1] === 'rescan' && method === 'POST') {
        void library.scan().catch((e) => console.error('[allegory] rescan failed', e))
        sendJson(res, { ok: true })
        return true
      }

      // --- filesystem browse ---------------------------------------------
      // Lists immediate subdirectories of a path, for the in-app folder
      // picker. The server has filesystem access; the browser doesn't.
      if (segs.length === 3 && segs[1] === 'fs' && segs[2] === 'browse' && method === 'GET') {
        const requested = url.searchParams.get('path') || process.env.HOME || '/'
        const showHidden = url.searchParams.get('hidden') === '1'
        try {
          const { readdir, stat: statFs } = await import('node:fs/promises')
          const { dirname: dn, resolve: resolvePath } = await import('node:path')
          const path = resolvePath(requested)
          const st = await statFs(path)
          if (!st.isDirectory()) {
            sendJson(res, { error: 'Not a directory.' }, 400)
            return true
          }
          const entries = await readdir(path, { withFileTypes: true })
          const dirs = entries
            .filter((e) => e.isDirectory() && (showHidden || !e.name.startsWith('.')))
            .map((e) => ({ name: e.name, path: `${path === '/' ? '' : path}/${e.name}` }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          const parent = path === '/' ? null : dn(path)
          const shortcuts = [
            { name: 'Home', path: process.env.HOME || '/' },
            { name: 'Media', path: '/media' },
            { name: 'Mount', path: '/mnt' },
            { name: 'Root', path: '/' },
          ]
          sendJson(res, { path, parent, entries: dirs, shortcuts })
          return true
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Could not read directory.'
          sendJson(res, { error: message }, 400)
          return true
        }
      }

      // --- settings -------------------------------------------------------
      // These deliberately run before `await ready` so a first-run UI can
      // configure the music dir even while no library exists yet.
      if (segs.length === 2 && segs[1] === 'settings' && method === 'GET') {
        sendJson(res, await settings.load())
        return true
      }
      if (segs.length === 2 && segs[1] === 'settings' && method === 'POST') {
        const body = (await readBody(req)) as {
          musicDir?: string
          lastfmApiKey?: string
        }
        const current = await settings.load()
        const lastfmApiKey =
          body.lastfmApiKey !== undefined
            ? body.lastfmApiKey.trim() || undefined
            : current.lastfmApiKey

        // Key-only update: persist it without re-validating or rescanning.
        if (body.musicDir === undefined) {
          await settings.save({ ...current, lastfmApiKey })
          sendJson(res, { ok: true })
          return true
        }

        const musicDir = body.musicDir.trim()
        const v = await settings.validate(musicDir)
        if (!v.ok) {
          sendJson(res, { error: v.error ?? 'Invalid path.' }, 400)
          return true
        }
        await settings.save({ musicDir, lastfmApiKey })
        await onMusicDirChange(musicDir)
        sendJson(res, { ok: true, musicDir, artistCount: v.artistCount })
        return true
      }
      if (
        segs.length === 3 &&
        segs[1] === 'settings' &&
        segs[2] === 'validate' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as { musicDir?: string }
        sendJson(res, await settings.validate((body.musicDir ?? '').trim()))
        return true
      }

      // --- self-update ----------------------------------------------------
      // These run before `await ready` so updates work even mid-scan. The repo
      // is the server's cwd; the heavy lifting (pull + restart) is done by
      // bin/allegory-update so it survives the server restarting itself.
      if (
        segs.length === 3 &&
        segs[1] === 'update' &&
        segs[2] === 'status' &&
        method === 'GET'
      ) {
        const head = await runGit(['rev-parse', '--short', 'HEAD'])
        if (!head.ok) {
          sendJson(res, {
            error: 'This install is not a git checkout — in-app update is unavailable.',
            available: false,
          })
          return true
        }
        const fetched = await runGit(['fetch', 'origin', 'main', '--quiet'])
        const headMsg = await runGit(['log', '-1', '--format=%s'])
        const counts = await runGit(['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
        const latest = await runGit(['rev-parse', '--short', 'origin/main'])
        const latestMsg = await runGit(['log', '-1', '--format=%s', 'origin/main'])
        let ahead = 0
        let behind = 0
        if (counts.ok) {
          const [a, b] = counts.stdout.trim().split(/\s+/).map(Number)
          ahead = a || 0
          behind = b || 0
        }
        sendJson(res, {
          bootId: BOOT_ID,
          current: head.stdout.trim(),
          currentMessage: headMsg.stdout.trim(),
          latest: latest.stdout.trim(),
          latestMessage: latestMsg.stdout.trim(),
          ahead,
          behind,
          available: behind > 0,
          fetchOk: fetched.ok,
          fetchError: fetched.ok
            ? undefined
            : (fetched.stderr.trim() || 'Could not reach the update server.').slice(0, 200),
        })
        return true
      }
      if (
        segs.length === 3 &&
        segs[1] === 'update' &&
        segs[2] === 'apply' &&
        method === 'POST'
      ) {
        const script = join(process.cwd(), 'bin', 'allegory-update')
        if (!existsSync(script)) {
          sendJson(res, { error: 'Update script not found in this install.' }, 500)
          return true
        }
        try {
          // Detached + own session so killing this server (during the restart)
          // doesn't kill the updater.
          const child = spawn('bash', [script], {
            cwd: process.cwd(),
            detached: true,
            stdio: 'ignore',
          })
          child.unref()
        } catch (err) {
          sendJson(
            res,
            { error: err instanceof Error ? err.message : 'Could not start the updater.' },
            500,
          )
          return true
        }
        sendJson(res, { ok: true, restarting: true })
        return true
      }

      // Every read below needs the first scan to have finished.
      await ready

      // --- search ---------------------------------------------------------
      if (segs.length === 2 && segs[1] === 'search' && method === 'GET') {
        sendJson(res, await library.search(url.searchParams.get('q') ?? ''))
        return true
      }

      // --- albums ---------------------------------------------------------
      if (segs.length === 2 && segs[1] === 'albums' && method === 'GET') {
        sendJson(res, library.albums())
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'albums' &&
        segs[3] === 'tracks' &&
        method === 'GET'
      ) {
        sendJson(res, await library.albumTracks(seg(2)))
        return true
      }
      if (
        segs.length === 3 &&
        segs[1] === 'albums' &&
        segs[2] === 'combine' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as {
          targetId?: string
          sourceIds?: string[]
        }
        if (!body.targetId || !body.sourceIds || body.sourceIds.length === 0) {
          sendJson(
            res,
            { error: 'Choose an album to keep and at least one to merge in.' },
            400,
          )
          return true
        }
        const result = await library.combineAlbums(body.targetId, body.sourceIds)
        await library.scan() // the library changed on disk
        sendJson(res, result)
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'albums' &&
        segs[3] === 'image' &&
        method === 'POST'
      ) {
        const albumId = seg(2)
        let raw: Buffer
        try {
          raw = await readImageUpload(req)
        } catch (err) {
          sendJson(res, { error: err instanceof Error ? err.message : 'Could not read image.' }, 400)
          return true
        }
        let jpeg: Buffer
        try {
          jpeg = await sharp(raw)
            .resize(1200, 1200, { fit: 'cover', position: 'attention' })
            .jpeg({ quality: 90 })
            .toBuffer()
        } catch {
          sendJson(res, { error: "That file isn't a readable image." }, 400)
          return true
        }
        const saved = await library.setAlbumArt(albumId, jpeg)
        if (!saved) {
          sendJson(res, { error: 'Unknown album.' }, 404)
          return true
        }
        // Invalidate cached thumbnails so the new cover shows immediately.
        try {
          for (const f of await readdir(artCacheDir)) {
            if (f.startsWith(albumId + '-')) {
              await unlink(join(artCacheDir, f)).catch(() => undefined)
            }
          }
        } catch {
          // cache dir may not exist yet
        }
        sendJson(res, { ok: true })
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'albums' &&
        segs[3] === 'metadata' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as {
          name?: string
          artist?: string
          year?: number | string
        }
        const result = await editAlbum(library, seg(2), body)
        await library.scan() // tags and possibly the folder changed on disk
        sendJson(res, result)
        return true
      }
      // Full per-track tag picture for the detailed editor.
      if (
        segs.length === 4 &&
        segs[1] === 'albums' &&
        segs[3] === 'tags' &&
        method === 'GET'
      ) {
        const album = library.album(seg(2))
        if (!album) {
          sendJson(res, { error: 'Unknown album.' }, 404)
          return true
        }
        const tracks = []
        for (const trackId of album.trackIds) {
          const track = library.track(trackId)
          if (track) tracks.push(await readFullTags(track.id, track.path))
        }
        sendJson(res, {
          album: { id: album.id, name: album.name, artist: album.artist, year: album.year },
          tracks,
        })
        return true
      }
      // Save album-wide + per-track tag edits in one batch.
      if (
        segs.length === 4 &&
        segs[1] === 'albums' &&
        segs[3] === 'tags' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as Parameters<typeof applyAlbumTags>[2]
        try {
          const result = await applyAlbumTags(library, seg(2), body)
          await library.scan() // tags and possibly the folder changed on disk
          sendJson(res, result)
        } catch (err) {
          sendJson(res, { error: err instanceof Error ? err.message : 'Save failed.' }, 400)
        }
        return true
      }

      // --- artists --------------------------------------------------------
      if (segs.length === 2 && segs[1] === 'artists' && method === 'GET') {
        sendJson(res, library.artists())
        return true
      }
      if (segs.length === 3 && segs[1] === 'artists' && method === 'PATCH') {
        const artistId = seg(2)
        if (!library.artist(artistId)) {
          sendJson(res, { error: 'Unknown artist.' }, 404)
          return true
        }
        const body = (await readBody(req)) as { name?: string | null }
        if (!body || typeof body.name !== 'string' || !body.name.trim()) {
          sendJson(res, { error: 'A new name is required.' }, 400)
          return true
        }
        try {
          const result = await renameArtist(library, artistId, body.name)
          // Force a rescan so the library re-derives the artist from the
          // renamed folder. We don't await it — the response goes back
          // immediately and the client invalidates its queries.
          void library.scan()
          sendJson(res, { ok: true, ...result })
        } catch (err) {
          sendJson(
            res,
            { error: err instanceof Error ? err.message : 'Rename failed.' },
            500,
          )
        }
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'albums' &&
        method === 'GET'
      ) {
        sendJson(res, library.artistAlbums(seg(2)))
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'tracks' &&
        method === 'GET'
      ) {
        sendJson(res, await library.artistTracks(seg(2)))
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'related' &&
        method === 'GET'
      ) {
        // Local-first: reads the cached sidecar; only hits Last.fm when it's
        // missing/stale (or ?refresh=1) and a key is configured.
        const { lastfmApiKey } = await settings.load()
        const dto = await getArtistRelated(library, seg(2), lastfmApiKey, {
          refresh: url.searchParams.get('refresh') === '1',
        })
        if (!dto) {
          sendJson(res, { error: 'Unknown artist.' }, 404)
          return true
        }
        sendJson(res, dto)
        return true
      }
      // The user's own tag list for an artist. PUT the full desired list; the
      // server works out which are additions and which are Last.fm genres the
      // user dropped, so hand edits survive the next enrichment refresh.
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'tags' &&
        method === 'PUT'
      ) {
        const body = (await readBody(req)) as { tags?: unknown }
        if (!Array.isArray(body.tags)) {
          sendJson(res, { error: 'tags must be an array of strings.' }, 400)
          return true
        }
        const tags = body.tags.filter((t): t is string => typeof t === 'string')
        const saved = await setArtistTags(library, seg(2), tags)
        if (!saved) {
          sendJson(res, { error: 'Unknown artist.' }, 404)
          return true
        }
        sendJson(res, { ok: true, genres: saved })
        return true
      }

      // An artist's best-known songs, matched to what's on disk. Answers
      // "where do I start?" for an artist you own but have never played.
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'top-tracks' &&
        method === 'GET'
      ) {
        const { lastfmApiKey } = await settings.load()
        const dto = await getArtistTopTracks(
          library,
          seg(2),
          lastfmApiKey,
          Date.now(),
        )
        if (!dto) {
          sendJson(res, { error: 'Unknown artist.' }, 404)
          return true
        }
        sendJson(res, dto)
        return true
      }

      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'recently-played' &&
        method === 'GET'
      ) {
        // The play log, narrowed to this artist's tracks, then run through the
        // same resolver as the Recently tab so songs/albums dedup identically.
        const artistId = seg(2)
        const history = await getPlayHistory()
        const ids = history
          .map((h) => h.trackId)
          .filter((id) => library.track(id)?.artistId === artistId)
        sendJson(res, await library.recentlyPlayed(ids, 25))
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'artists' &&
        segs[3] === 'image' &&
        method === 'POST'
      ) {
        const artistId = seg(2)
        let raw: Buffer
        try {
          raw = await readImageUpload(req)
        } catch (err) {
          sendJson(res, { error: err instanceof Error ? err.message : 'Could not read image.' }, 400)
          return true
        }
        let jpeg: Buffer
        try {
          jpeg = await sharp(raw)
            .resize(800, 800, { fit: 'cover', position: 'attention' })
            .jpeg({ quality: 88 })
            .toBuffer()
        } catch {
          sendJson(res, { error: "That file isn't a readable image." }, 400)
          return true
        }
        const saved = await library.setArtistArt(artistId, jpeg)
        if (!saved) {
          sendJson(res, { error: 'Unknown artist.' }, 404)
          return true
        }
        // Drop cached resized variants so the new image shows immediately.
        try {
          for (const f of await readdir(artCacheDir)) {
            if (f.startsWith(artistId + '-')) {
              await unlink(join(artCacheDir, f)).catch(() => undefined)
            }
          }
        } catch {
          // cache dir may not exist yet
        }
        sendJson(res, { ok: true })
        return true
      }

      // --- recently added -------------------------------------------------
      // The freshest albums + tracks, ranked by when their files landed on
      // disk (track mtime; an album inherits its newest track's mtime).
      if (
        segs.length === 3 &&
        segs[1] === 'recent' &&
        segs[2] === 'added' &&
        method === 'GET'
      ) {
        sendJson(res, await library.recentlyAdded(25))
        return true
      }

      // --- recently played ------------------------------------------------
      // GET resolves the persisted play log against the current scan (ids that
      // vanished after a rescan are skipped), newest-first. POST appends a play.
      if (segs.length === 3 && segs[1] === 'recent' && segs[2] === 'played') {
        if (method === 'GET') {
          const history = await getPlayHistory()
          sendJson(res, await library.recentlyPlayed(history.map((h) => h.trackId), 25))
          return true
        }
        if (method === 'POST') {
          const body = (await readBody(req)) as { trackId?: string }
          if (typeof body.trackId === 'string' && body.trackId) {
            await recordPlay(body.trackId)
            // Also append to the permanent log. Names are resolved and stored
            // now, while the track is still in the index, so the history stays
            // readable after a rescan renames or removes the file.
            const t = library.track(body.trackId)
            if (t) {
              const album = library.album(t.albumId)
              const artist = library.artist(t.artistId)
              await appendListen({
                at: Date.now(),
                trackId: t.id,
                title: t.tagTitle || t.fileTitle,
                artist: artist?.name ?? t.tagArtist ?? '',
                album: album?.name ?? t.tagAlbum ?? '',
                artistId: t.artistId,
                albumId: t.albumId,
              })
            }
          }
          sendJson(res, { ok: true })
          return true
        }
      }

      // --- listening history ------------------------------------------------
      // What you've been playing over a window, the basis for time-scoped
      // recommendations. Reads the permanent log, not the 200-entry panel
      // buffer, so "last 30 days" means it.
      if (
        segs.length === 3 &&
        segs[1] === 'listen' &&
        segs[2] === 'stats' &&
        method === 'GET'
      ) {
        // First run on an upgraded install: rescue the ring buffer's entries.
        await seedIfEmpty(async () => {
          const history = await getPlayHistory()
          return history.flatMap((h) => {
            const t = library.track(h.trackId)
            if (!t) return []
            return [
              {
                at: h.at,
                trackId: t.id,
                title: t.tagTitle || t.fileTitle,
                artist: library.artist(t.artistId)?.name ?? t.tagArtist ?? '',
                album: library.album(t.albumId)?.name ?? t.tagAlbum ?? '',
                artistId: t.artistId,
                albumId: t.albumId,
              },
            ]
          })
        })

        const raw = url.searchParams.get('window') ?? '30d'
        const allowed: ListenWindow[] = ['today', '7d', '30d', '90d', 'all']
        const window = (allowed as string[]).includes(raw)
          ? (raw as ListenWindow)
          : '30d'
        sendJson(res, await getListenStats(window, Date.now()))
        return true
      }

      // --- discover ---------------------------------------------------------
      // Mixes are pure local computation; recommendations read the sidecars
      // already on disk; missing-albums is the only one that may go online.
      if (segs.length === 3 && segs[1] === 'discover' && method === 'GET') {
        if (segs[2] === 'mixes') {
          sendJson(res, { mixes: await getMixes(library, Date.now()) })
          return true
        }
        if (segs[2] === 'recommendations') {
          const raw = url.searchParams.get('window') ?? '30d'
          const allowed: ListenWindow[] = ['today', '7d', '30d', '90d', 'all']
          const window = (allowed as string[]).includes(raw)
            ? (raw as ListenWindow)
            : '30d'
          sendJson(res, await getRecommendations(library, window, Date.now()))
          return true
        }
        if (segs[2] === 'missing-albums') {
          const { lastfmApiKey } = await settings.load()
          sendJson(res, await getMissingAlbums(library, lastfmApiKey, Date.now()))
          return true
        }
      }

      // --- playlists ------------------------------------------------------
      if (segs.length === 2 && segs[1] === 'playlists') {
        if (method === 'GET') {
          sendJson(res, await playlists.list())
          return true
        }
        if (method === 'POST') {
          const body = (await readBody(req)) as {
            name?: string
            trackIds?: string[]
          }
          const name = (body.name ?? '').trim()
          if (!name) {
            sendJson(res, { error: 'A playlist name is required.' }, 400)
            return true
          }
          const id = await playlists.create(name, pathsFor(body.trackIds ?? []))
          sendJson(res, { id })
          return true
        }
      }
      if (
        segs.length === 4 &&
        segs[1] === 'playlists' &&
        segs[3] === 'tracks' &&
        method === 'GET'
      ) {
        const playlistId = seg(2)
        const paths = await playlists.paths(playlistId)
        const tracks = await library.tracksForPaths(paths)
        // Each entry carries its position so a specific one can be removed.
        tracks.forEach((t, i) => {
          t.playlistItemId = `${playlistId}:${i}`
        })
        sendJson(res, tracks)
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'playlists' &&
        segs[3] === 'items'
      ) {
        const playlistId = seg(2)
        if (method === 'POST') {
          const body = (await readBody(req)) as { trackIds?: string[] }
          await playlists.addItems(playlistId, pathsFor(body.trackIds ?? []))
          sendJson(res, { ok: true })
          return true
        }
        if (method === 'DELETE') {
          const entryIds = (url.searchParams.get('entryIds') ?? '')
            .split(',')
            .filter(Boolean)
          const indices = entryIds
            .map((e) => Number(e.split(':')[1]))
            .filter((n) => Number.isInteger(n))
          await playlists.removeIndices(playlistId, indices)
          sendJson(res, { ok: true })
          return true
        }
      }

      // --- playlist editing ----------------------------------------------
      if (
        segs.length === 3 &&
        segs[1] === 'playlists' &&
        segs[2] === 'combine' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as {
          name?: string
          sourceIds?: string[]
        }
        const name = (body.name ?? '').trim()
        if (!name) {
          sendJson(res, { error: 'A playlist name is required.' }, 400)
          return true
        }
        const id = await playlists.combine(name, body.sourceIds ?? [])
        sendJson(res, { id })
        return true
      }
      if (segs.length === 3 && segs[1] === 'playlists' && method === 'DELETE') {
        await playlists.remove(seg(2))
        sendJson(res, { ok: true })
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'playlists' &&
        segs[3] === 'rename' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as { name?: string }
        const name = (body.name ?? '').trim()
        if (!name) {
          sendJson(res, { error: 'A playlist name is required.' }, 400)
          return true
        }
        await playlists.rename(seg(2), name)
        sendJson(res, { ok: true })
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'playlists' &&
        segs[3] === 'move' &&
        method === 'POST'
      ) {
        const body = (await readBody(req)) as { from?: number; to?: number }
        await playlists.move(seg(2), Number(body.from), Number(body.to))
        sendJson(res, { ok: true })
        return true
      }
      if (
        segs.length === 4 &&
        segs[1] === 'playlists' &&
        segs[3] === 'image' &&
        method === 'POST'
      ) {
        const playlistId = seg(2)
        let raw: Buffer
        try {
          raw = await readImageUpload(req)
        } catch (err) {
          sendJson(res, { error: err instanceof Error ? err.message : 'Could not read image.' }, 400)
          return true
        }
        let jpeg: Buffer
        try {
          jpeg = await sharp(raw)
            .resize(1200, 1200, { fit: 'cover', position: 'attention' })
            .jpeg({ quality: 90 })
            .toBuffer()
        } catch {
          sendJson(res, { error: "That file isn't a readable image." }, 400)
          return true
        }
        const saved = await playlists.setArt(playlistId, jpeg)
        if (!saved) {
          sendJson(res, { error: 'Unknown playlist.' }, 404)
          return true
        }
        // Invalidate cached thumbnails so the new cover shows immediately.
        try {
          for (const f of await readdir(artCacheDir)) {
            if (f.startsWith(playlistId + '-')) {
              await unlink(join(artCacheDir, f)).catch(() => undefined)
            }
          }
        } catch {
          // cache dir may not exist yet
        }
        sendJson(res, { ok: true })
        return true
      }

      // --- which tracks have notes (bulk index for list pencils) ---------
      if (segs.length === 2 && segs[1] === 'song-notes' && method === 'GET') {
        const checked = await Promise.all(
          library.allTracks().map(async (t) =>
            (await readSidecar(t.path, NOTE_EXTS)) ? t.id : null,
          ),
        )
        sendJson(res, { trackIds: checked.filter((id): id is string => id !== null) })
        return true
      }

      // --- the full tracks that have notes (the smart "Notes" playlist) ---
      if (
        segs.length === 3 &&
        segs[1] === 'song-notes' &&
        segs[2] === 'tracks' &&
        method === 'GET'
      ) {
        const noted = await Promise.all(
          library.allTracks().map(async (t) =>
            (await readSidecar(t.path, NOTE_EXTS)) ? t.path : null,
          ),
        )
        const paths = noted.filter((p): p is string => p !== null)
        sendJson(res, await library.tracksForPaths(paths))
        return true
      }

      // --- per-song curation sidecar -------------------------------------
      // Notes (.md/.txt) and/or lyrics (.lrc) the curator dropped next to the
      // track. 404 when a track has no sidecar — the graceful common case.
      // `?raw=1` returns the unprocessed notes text for the in-app editor
      // (200 + "" when none, so editing can start from a blank slate).
      if (segs.length === 3 && segs[1] === 'song-context' && method === 'GET') {
        const track = library.track(seg(2))
        if (!track) {
          res.writeHead(404).end()
          return true
        }
        if (url.searchParams.get('raw') === '1') {
          const raw = await readSidecar(track.path, NOTE_EXTS)
          sendJson(res, { notes: raw ?? '' })
          return true
        }
        const ctx = await readSongContext(track.path)
        if (!ctx.notes && !ctx.lyrics) {
          res.writeHead(404).end()
          return true
        }
        sendJson(res, ctx)
        return true
      }

      // --- save / clear a track's notes (the in-app pencil editor) -------
      if (segs.length === 3 && segs[1] === 'song-context' && method === 'PUT') {
        const track = library.track(seg(2))
        if (!track) {
          res.writeHead(404).end()
          return true
        }
        const body = (await readBody(req)) as { notes?: string }
        const hasNotes = await writeSongNotes(track.path, body.notes ?? '')
        sendJson(res, { ok: true, hasNotes })
        return true
      }

      // --- streaming ------------------------------------------------------
      // The client passes `?can=<tokens>` listing the not-universally-supported
      // formats this browser can decode (see `audioStreamUrl`). If the track's
      // format isn't on that list, transcode to AAC first so it still plays
      // (e.g. an .ogg in Safari). Chrome/Firefox advertise ogg/opus/flac and so
      // get the original file untouched.
      if (segs.length === 3 && segs[1] === 'stream' && method === 'GET') {
        const track = library.track(seg(2))
        if (!track) {
          res.writeHead(404).end()
          return true
        }
        const token = RISKY_FORMAT[extname(track.path).toLowerCase()]
        // An ABSENT `can` param = a non-Allegory client (curl, etc.): serve the
        // original untouched. A PRESENT-but-empty `can=` is a real browser that
        // can't play any risky format → still transcode.
        const advertised = url.searchParams.has('can')
        const can = new Set((url.searchParams.get('can') ?? '').split(',').filter(Boolean))
        let path = track.path
        if (advertised && token && !can.has(token)) {
          try {
            path = await transcodedPath(track.path, track.id, transcodeCacheDir)
          } catch (err) {
            console.error('[allegory] transcode failed', track.path, err)
            res.writeHead(500).end()
            return true
          }
        }
        await streamFile(req, res, path)
        return true
      }

      // --- cover art ------------------------------------------------------
      // A portrait for an artist we don't own, by name. Served from the local
      // cache after the first fetch, so the browser never contacts Deezer and
      // repeat views work offline. 404 simply means "no picture" — the UI
      // falls back to its placeholder.
      if (segs.length === 2 && segs[1] === 'portrait' && method === 'GET') {
        const name = (url.searchParams.get('name') ?? '').trim()
        const size = Math.min(
          640,
          Math.max(48, Number(url.searchParams.get('size')) || 220),
        )
        const buf = name ? await portraits.bytesFor(name, size) : null
        if (!buf) {
          res.writeHead(404).end()
          return true
        }
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=604800',
        })
        res.end(buf)
        return true
      }

      if (segs.length === 3 && segs[1] === 'art' && method === 'GET') {
        const size = Math.min(1200, Math.max(48, Number(url.searchParams.get('size')) || 400))
        await serveArt(res, seg(2), size)
        return true
      }

      sendJson(res, { error: 'Not found' }, 404)
      return true
    } catch (err) {
      console.error('[allegory] api error', err)
      const message = err instanceof Error ? err.message : 'Server error'
      sendJson(res, { error: message }, 500)
      return true
    }
  }

  return { handle, reload }
}
