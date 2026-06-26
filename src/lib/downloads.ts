/**
 * Offline downloads — store streamed audio so the app can browse and play music
 * with the home server unreachable (in the car, server off). Phone *and*
 * desktop; it's all PWA.
 *
 * Pieces:
 *   - Audio bytes live in the `allegory-audio-v1` Cache. The service worker
 *     serves /api/stream/* cache-first from it and synthesises 206 range
 *     responses for seeking (see public/sw.js).
 *   - Cover art for downloaded items lives in `allegory-art-v1`, so the
 *     Downloads view and player have artwork offline.
 *   - A small IndexedDB index ('allegory-downloads') records what's downloaded
 *     so the Downloads view works with no network.
 *
 * This module is the client-side manager the UI talks to. The Cache API is
 * available on the page (not just in the SW), so we write those caches directly
 * here, then keep an in-memory mirror + reactive store for the React layer.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Connection, Track } from './types'
import {
  audioStreamUrl,
  albumImageUrl,
  getAlbumTracks,
  getPlaylistTracks,
  getArtistTracks,
} from './api'

const AUDIO_CACHE = 'allegory-audio-v1'
const ART_CACHE = 'allegory-art-v1'
const DB_NAME = 'allegory-downloads'
const DB_VERSION = 1
const STORE = 'tracks'

export interface DownloadRecord {
  /** Track id — the primary key. */
  id: string
  /** Enough of the track to render rows and build an offline play queue. */
  track: Track
  /** The audio-cache key the bytes were stored under (path-only, no ?can=). */
  streamKey: string
  /** The cover-art URL we cached, for offline <img> src. */
  artUrl: string
  /** Audio body size in bytes, for the storage meter. */
  size: number
  downloadedAt: number
}

// --- IndexedDB (tiny hand-rolled wrapper) -----------------------------------

let dbPromise: Promise<IDBDatabase> | null = null
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE)
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbGetAll(): Promise<DownloadRecord[]> {
  const db = await openDb()
  return promisify(store(db, 'readonly').getAll() as IDBRequest<DownloadRecord[]>)
}
async function dbPut(rec: DownloadRecord): Promise<void> {
  const db = await openDb()
  await promisify(store(db, 'readwrite').put(rec))
}
async function dbDelete(id: string): Promise<void> {
  const db = await openDb()
  await promisify(store(db, 'readwrite').delete(id))
}
async function dbClear(): Promise<void> {
  const db = await openDb()
  await promisify(store(db, 'readwrite').clear())
}

// --- Reactive store ---------------------------------------------------------
// recordCache mirrors IndexedDB; inflight tracks in-progress downloads. A
// monotonic `version` drives useSyncExternalStore subscribers (returning a
// stable number keeps the snapshot identity-safe).

type Phase = 'pending' | 'error'
const recordCache = new Map<string, DownloadRecord>()
const inflight = new Map<string, { phase: Phase; progress: number; name: string }>()
// Batch counters for the global progress bar: tracks queued across active
// downloads, and how many have finished. Both reset to 0 when the batch drains.
let queued = 0
let completed = 0
let version = 0
let hydrated = false
const listeners = new Set<() => void>()

/** Mark one queued track as finished; clear the batch + error markers when it drains. */
function settleOne(): void {
  completed++
  if (completed >= queued) {
    queued = 0
    completed = 0
    for (const [id, v] of inflight) if (v.phase === 'error') inflight.delete(id)
  }
}

function bump(): void {
  version++
  for (const fn of listeners) fn()
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
function getVersion(): number {
  return version
}

// Hydrate the in-memory index from IndexedDB once, on first import.
void (async () => {
  try {
    for (const rec of await dbGetAll()) recordCache.set(rec.id, rec)
  } catch {
    // No IndexedDB (private mode, etc.) — downloads just won't persist/list.
  } finally {
    hydrated = true
    bump()
  }
})()

/** Synchronous "is this track downloaded?" — reads the in-memory mirror. */
export function isDownloaded(id: string): boolean {
  return recordCache.has(id)
}

/**
 * A `blob:` object URL for a downloaded track's audio, or null if it isn't
 * downloaded (or the cached body is somehow gone). Playing from this instead of
 * the stream URL keeps playback fully local: no network and, crucially, no
 * service-worker range-serving — which is what stutters/stalls on iOS. The
 * caller owns the returned URL and must URL.revokeObjectURL() it when done.
 */
export async function getDownloadedAudioUrl(id: string): Promise<string | null> {
  const rec = recordCache.get(id)
  if (!rec) return null
  try {
    const cache = await caches.open(AUDIO_CACHE)
    // ignoreSearch so a body stored under the path-only key still matches.
    const res = await cache.match(rec.streamKey, { ignoreSearch: true })
    if (!res) return null
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

/** Whether the initial IndexedDB hydrate has finished. */
export function downloadsReady(): boolean {
  return hydrated
}

// --- Downloading ------------------------------------------------------------

function setProgress(id: string, progress: number): void {
  const cur = inflight.get(id)
  if (!cur || cur.phase !== 'pending') return
  // Throttle re-renders: only publish on a meaningful jump (or completion).
  if (progress < 1 && progress - cur.progress < 0.02) return
  inflight.set(id, { phase: 'pending', progress, name: cur.name })
  bump()
}

async function readWithProgress(
  res: Response,
  id: string,
  onChunk?: () => void,
): Promise<{ blob: Blob; size: number; type: string }> {
  const type = res.headers.get('Content-Type') || 'audio/mpeg'
  const total = Number(res.headers.get('Content-Length')) || 0
  if (!res.body || !total) {
    const blob = await res.blob()
    setProgress(id, 1)
    return { blob, size: blob.size, type }
  }
  const reader = res.body.getReader()
  const chunks: BlobPart[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      onChunk?.()
      chunks.push(value)
      received += value.byteLength
      setProgress(id, received / total)
    }
  }
  const blob = new Blob(chunks, { type })
  return { blob, size: blob.size, type }
}

/**
 * Download one track: fetch the full stream (a plain 200, no Range), store the
 * bytes in the audio cache, cache the cover art, and index it in IndexedDB.
 * A no-op if the track is already downloaded.
 */
export async function downloadTrack(conn: Connection, track: Track): Promise<void> {
  if (recordCache.has(track.id)) return
  const name = `${track.artist} — ${track.name}`
  queued++
  inflight.set(track.id, { phase: 'pending', progress: 0, name })
  bump()

  // Abort a track that makes no progress for STALL_MS (the iOS hang symptom),
  // so a single stuck stream can't freeze the whole album/playlist batch — the
  // loop catches the error and moves to the next track. Re-armed on each chunk.
  const STALL_MS = 25_000
  const ctrl = new AbortController()
  let stall: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => ctrl.abort(), STALL_MS)
  }

  try {
    arm()
    // ?dl=1 tells the (updated) service worker to stay out of the way (see
    // public/sw.js): routing a big download through the SW can hang on iOS.
    const res = await fetch(`${audioStreamUrl(conn, track.id)}&dl=1`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`stream ${res.status}`)
    const { blob, size, type } = await readWithProgress(res, track.id, arm)
    if (stall) clearTimeout(stall)

    // Store under a path-only key so the player's ?can=<caps> (which can differ
    // across devices/sessions) still hits via the SW's ignoreSearch match.
    const streamKey = `${conn.serverUrl}/stream/${track.id}`
    const audioCache = await caches.open(AUDIO_CACHE)
    await audioCache.put(
      streamKey,
      new Response(blob, {
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      }),
    )

    // Cover art is best-effort — bounded by its own short timeout so it can't
    // hang the track either.
    const artUrl = albumImageUrl(conn, track.albumId ?? track.id, track.albumImageTag, 400)
    try {
      const artRes = await fetch(artUrl, { signal: AbortSignal.timeout(10_000) })
      if (artRes.ok) await (await caches.open(ART_CACHE)).put(artUrl, artRes)
    } catch {
      // ignore — art is optional
    }

    const rec: DownloadRecord = {
      id: track.id,
      track,
      streamKey,
      artUrl,
      size,
      downloadedAt: Date.now(),
    }
    await dbPut(rec)
    recordCache.set(track.id, rec)
    inflight.delete(track.id)
  } catch (err) {
    inflight.set(track.id, { phase: 'error', progress: 0, name })
    throw err
  } finally {
    if (stall) clearTimeout(stall)
    settleOne()
    bump()
  }
}

// Download several tracks at once (a small pool) rather than strictly
// one-at-a-time: this overlaps each track's per-request latency, so an album or
// playlist downloads much faster. Already-downloaded tracks are skipped
// instantly inside downloadTrack, so re-running to resume stays cheap.
const DOWNLOAD_CONCURRENCY = 4
async function downloadMany(conn: Connection, tracks: Track[]): Promise<void> {
  let next = 0
  async function worker() {
    while (next < tracks.length) {
      const t = tracks[next++]
      try {
        await downloadTrack(conn, t)
      } catch {
        // One bad track shouldn't abort the whole album/playlist/artist.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, tracks.length) }, () => worker()),
  )
}

export async function downloadAlbum(conn: Connection, albumId: string): Promise<void> {
  await downloadMany(conn, await getAlbumTracks(conn, albumId))
}
export async function downloadPlaylist(conn: Connection, playlistId: string): Promise<void> {
  await downloadMany(conn, await getPlaylistTracks(conn, playlistId))
}
export async function downloadArtist(conn: Connection, artistId: string): Promise<void> {
  await downloadMany(conn, await getArtistTracks(conn, artistId))
}

/** Download a known set of tracks (used for album/playlist menus that already
 *  loaded their listing). */
export async function downloadTracks(conn: Connection, tracks: Track[]): Promise<void> {
  await downloadMany(conn, tracks)
}

/** Remove one downloaded track: its audio, its art (if unshared), and index. */
export async function removeDownload(id: string): Promise<void> {
  const rec = recordCache.get(id)
  recordCache.delete(id)
  inflight.delete(id)
  try {
    await dbDelete(id)
  } catch {
    // ignore
  }
  if (rec) {
    try {
      const audioCache = await caches.open(AUDIO_CACHE)
      await audioCache.delete(rec.streamKey, { ignoreSearch: true })
    } catch {
      // ignore
    }
    // Only drop the album art if no remaining download still references it.
    const stillUsed = [...recordCache.values()].some((r) => r.artUrl === rec.artUrl)
    if (!stillUsed) {
      try {
        const artCache = await caches.open(ART_CACHE)
        await artCache.delete(rec.artUrl, { ignoreSearch: true })
      } catch {
        // ignore
      }
    }
  }
  bump()
}

/** Remove a set of tracks (album/playlist/artist "remove download"). */
export async function removeDownloads(ids: string[]): Promise<void> {
  for (const id of ids) await removeDownload(id)
}

/** Wipe every download — audio, art and the index. */
export async function clearAllDownloads(): Promise<void> {
  recordCache.clear()
  inflight.clear()
  try {
    await dbClear()
  } catch {
    // ignore
  }
  try {
    await caches.delete(AUDIO_CACHE)
  } catch {
    // ignore
  }
  try {
    await caches.delete(ART_CACHE)
  } catch {
    // ignore
  }
  bump()
}

/** Best-effort storage usage/quota for the meter (0s when unsupported). */
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { usage: 0, quota: 0 }
  }
  const e = await navigator.storage.estimate()
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 }
}

// --- React hooks ------------------------------------------------------------

export interface DownloadStatus {
  downloaded: boolean
  pending: boolean
  progress: number
  error: boolean
}
const NONE: DownloadStatus = { downloaded: false, pending: false, progress: 0, error: false }

/** Reactive per-track status for the contextual menus. */
export function useDownloadStatus(id: string | undefined): DownloadStatus {
  const ver = useSyncExternalStore(subscribe, getVersion, getVersion)
  return useMemo(() => {
    void ver
    if (!id) return NONE
    const f = inflight.get(id)
    if (f) {
      return {
        downloaded: recordCache.has(id),
        pending: f.phase === 'pending',
        progress: f.progress,
        error: f.phase === 'error',
      }
    }
    return recordCache.has(id)
      ? { downloaded: true, pending: false, progress: 1, error: false }
      : NONE
  }, [id, ver])
}

/** Reactive download state across a set of tracks (for album/playlist menus). */
export interface CollectionStatus {
  total: number
  downloaded: number
  pending: number
  /** Every track is downloaded. */
  complete: boolean
  /** A download is in progress for at least one track. */
  busy: boolean
}
export function useCollectionStatus(ids: string[]): CollectionStatus {
  const ver = useSyncExternalStore(subscribe, getVersion, getVersion)
  return useMemo(() => {
    void ver
    let downloaded = 0
    let pending = 0
    for (const id of ids) {
      if (recordCache.has(id)) downloaded++
      if (inflight.get(id)?.phase === 'pending') pending++
    }
    return {
      total: ids.length,
      downloaded,
      pending,
      complete: ids.length > 0 && downloaded === ids.length,
      busy: pending > 0,
    }
  }, [ids, ver])
}

/** Reactive whole-app download progress, for the persistent progress bar. */
export interface DownloadProgress {
  active: boolean
  /** Tracks queued in the current batch. */
  total: number
  /** Tracks finished in the current batch. */
  done: number
  /** The track downloading right now (artist — title), if any. */
  currentName: string | null
  /** That track's progress, 0–1. */
  currentPct: number
}
export function useDownloadProgress(): DownloadProgress {
  const ver = useSyncExternalStore(subscribe, getVersion, getVersion)
  return useMemo(() => {
    void ver
    let currentName: string | null = null
    let currentPct = 0
    for (const v of inflight.values()) {
      if (v.phase === 'pending') {
        currentName = v.name
        currentPct = v.progress
        break
      }
    }
    return { active: queued > 0, total: queued, done: completed, currentName, currentPct }
  }, [ver])
}

/** Reactive list of all downloaded tracks, album-grouped order. */
export function useDownloads(): DownloadRecord[] {
  const ver = useSyncExternalStore(subscribe, getVersion, getVersion)
  return useMemo(() => {
    void ver
    return [...recordCache.values()].sort((a, b) => {
      const byAlbum = a.track.album.localeCompare(b.track.album)
      if (byAlbum !== 0) return byAlbum
      return (a.track.index ?? 0) - (b.track.index ?? 0)
    })
  }, [ver])
}

/** Reactive count of downloaded tracks (for the tab badge / empty checks). */
export function useDownloadCount(): number {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return recordCache.size
}
