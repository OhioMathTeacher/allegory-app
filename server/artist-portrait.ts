/**
 * Portraits for artists that aren't in the library.
 *
 * Why this exists: Last.fm's API no longer returns artist images. Every artist,
 * famous or obscure, comes back with the same grey placeholder
 * (2a96cbd8b46e442fc41c2b86b821562f.png), so `artist-related.ts` has nothing to
 * show next to a suggestion. Deezer's public search does have real portraits
 * and needs no key, so we look names up there.
 *
 * Everything is cached twice over: an index of name → image URL (including
 * misses, so a nameless act isn't re-queried forever) and the resized JPEG
 * bytes on disk. After the first look-up an artist costs nothing and works
 * offline. The browser never talks to Deezer — the server fetches, resizes and
 * serves, so no third party sees which artist pages get opened.
 *
 * Best-effort throughout, like the rest of the enrichment path: offline, a
 * timeout, or a shape we don't recognise all mean "no portrait", never an error.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

const TIMEOUT_MS = 6000
const DEEZER_SEARCH = 'https://api.deezer.com/search/artist'
// An artist headshot is tens of kilobytes. These ceilings are generous for
// anything legitimate and still refuse the pathological cases outright.
const MAX_PORTRAIT_BYTES = 8 * 1024 * 1024
const MAX_PORTRAIT_PIXELS = 40_000_000 // ~6300x6300
// Re-check a miss after this long; an artist may get added to Deezer later.
const MISS_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

interface IndexEntry {
  /** Remote image URL, or null when the look-up found nothing. */
  url: string | null
  at: number
}

/** Fold a name for cache lookups — mirrors the matching in artist-related.ts. */
function norm(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** A filesystem-safe cache filename for a normalised name. */
function slug(normName: string): string {
  return normName.replace(/[^a-z0-9]+/g, '-').slice(0, 64) || 'unknown'
}

export function createPortraits(cacheDir: string) {
  const dir = join(cacheDir, 'portraits')
  const indexFile = join(dir, 'index.json')

  let index: Record<string, IndexEntry> | null = null
  // One in-flight look-up per artist, so a page of 24 cards that all miss
  // doesn't fire 24 identical Deezer requests.
  const inflight = new Map<string, Promise<string | null>>()

  async function loadIndex(): Promise<Record<string, IndexEntry>> {
    if (index) return index
    try {
      const parsed = JSON.parse(await readFile(indexFile, 'utf8')) as unknown
      index = parsed && typeof parsed === 'object' ? (parsed as Record<string, IndexEntry>) : {}
    } catch {
      index = {}
    }
    return index
  }

  async function saveIndex(): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(indexFile, JSON.stringify(index ?? {}), 'utf8')
    } catch {
      // Cache is an optimisation; losing it only costs a re-query.
    }
  }

  /** Ask Deezer for this artist's picture URL. Null when there's no match. */
  async function lookup(name: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(
        `${DEEZER_SEARCH}?q=${encodeURIComponent(name)}&limit=5`,
        { signal: controller.signal },
      )
      if (!res.ok) return null
      const body = (await res.json()) as {
        data?: { name?: string; picture_xl?: string; picture_big?: string }[]
      }
      const wanted = norm(name)
      // Prefer an exact (normalised) name match; Deezer's search is fuzzy and
      // will happily return a tribute band or a remixer for a near-miss.
      const hit =
        body.data?.find((a) => norm(a.name ?? '') === wanted) ?? undefined
      const url = hit?.picture_xl || hit?.picture_big || null
      // Deezer serves a known blank silhouette for artists with no photo.
      if (url && /\/artist\/\/?$/.test(url)) return null
      return url ?? null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** The image URL for a name, consulting (and filling) the index. */
  async function urlFor(name: string): Promise<string | null> {
    const key = norm(name)
    if (!key) return null
    const idx = await loadIndex()
    const hit = idx[key]
    // A hit is kept forever; a miss is retried once its TTL lapses.
    if (hit && (hit.url !== null || Date.now() - hit.at < MISS_TTL_MS)) {
      return hit.url
    }
    const pending = inflight.get(key)
    if (pending) return pending

    const task = (async () => {
      const url = await lookup(name)
      idx[key] = { url, at: Date.now() }
      await saveIndex()
      return url
    })().finally(() => inflight.delete(key))

    inflight.set(key, task)
    return task
  }

  /**
   * Resized JPEG bytes for an artist's portrait, or null when there isn't one.
   * Reads the disk cache first so a repeat view never touches the network.
   */
  async function bytesFor(name: string, size: number): Promise<Buffer | null> {
    const key = norm(name)
    if (!key) return null
    const file = join(dir, `${slug(key)}-${size}.jpg`)
    try {
      return await readFile(file)
    } catch {
      // Not cached yet.
    }

    const url = await urlFor(name)
    if (!url) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      })
      if (!res.ok) return null

      // Everything below the fetch is about what reaches sharp. It decodes in
      // native code (libvips), so hostile bytes are the one input worth being
      // strict about — the same discipline the paste-a-URL cover picker in
      // router.ts already applies. Deezer is a known host over HTTPS, not an
      // arbitrary one, but "probably fine" is not a reason to skip the checks.
      const type = (res.headers.get('content-type') ?? '').toLowerCase()
      if (type && !type.startsWith('image/')) return null
      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_PORTRAIT_BYTES) return null

      const raw = Buffer.from(await res.arrayBuffer())
      // Re-check after the fact: content-length is a claim, not a guarantee.
      if (raw.length === 0 || raw.length > MAX_PORTRAIT_BYTES) return null

      const buf = await sharp(raw, {
        // Portraits are small headshots. Capping pixels keeps a decompression
        // bomb — tiny file, enormous canvas — from eating memory on decode.
        limitInputPixels: MAX_PORTRAIT_PIXELS,
      })
        .resize(size, size, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 82 })
        .toBuffer()
      await mkdir(dir, { recursive: true })
      await writeFile(file, buf).catch(() => undefined)
      return buf
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  return { bytesFor, urlFor }
}

export type PortraitStore = ReturnType<typeof createPortraits>
