/**
 * Artist enrichment: related artists + genre tags, pulled from Last.fm and
 * cached in a per-artist sidecar so it travels with the music and survives
 * offline.
 *
 * The sidecar is a hidden file (`.allegory-artist.json`) written into the
 * artist's own folder — the same place `folder.jpg` lives — so the scanner,
 * which skips dot-files, never mistakes it for media. We store the raw Last.fm
 * names; matching them to local library artists happens at read time, so newly
 * added artists light up as links without a re-fetch.
 *
 * Every network path is best-effort: offline, a timeout, a non-OK response, or
 * malformed JSON all degrade to "no data", never an exception. An artist page
 * should never break because enrichment is unavailable.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Library } from './scanner.ts'

const SIDECAR = '.allegory-artist.json'
const SIDECAR_VERSION = 1
const TIMEOUT_MS = 6000
// Cache is essentially permanent; we only re-fetch after this or on demand.
const TTL_MS = 1000 * 60 * 60 * 24 * 60 // 60 days
const LASTFM = 'https://ws.audioscrobbler.com/2.0/'

interface RawRelated {
  name: string
  mbid?: string
}

interface Sidecar {
  version: number
  fetchedAt: number
  source: string
  genres: string[]
  related: RawRelated[]
}

export interface RelatedArtist {
  name: string
  mbid?: string
  /** Set when this artist exists in the local library — the UI links to it. */
  artistId?: string
  /** Truthy when the matched library artist has a cover image to show. */
  imageTag?: string
}

export interface ArtistRelatedDTO {
  genres: string[]
  related: RelatedArtist[]
  /** False when no Last.fm key is configured, so the UI can prompt for one. */
  configured: boolean
  /** Epoch ms the data was fetched, or null when it never has been. */
  fetchedAt: number | null
}

// --- Last.fm response shapes (only the fields we read) ---------------------
interface LfmArtistRef {
  name?: string
  mbid?: string
}
interface LfmTag {
  name?: string
}
interface LfmSimilar {
  similarartists?: { artist?: LfmArtistRef[] }
}
interface LfmTopTags {
  toptags?: { tag?: LfmTag[] }
}

/** Fold a display name to a comparison key: drop diacritics, a leading "the",
 *  and punctuation, so "The Beatles" and "Beatles" (and folder variants) meet. */
function norm(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^the\s+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

async function callLastfm<T>(
  method: string,
  artist: string,
  apiKey: string,
  extra: Record<string, string> = {},
): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const params = new URLSearchParams({
      method,
      artist,
      api_key: apiKey,
      format: 'json',
      autocorrect: '1',
      ...extra,
    })
    const res = await fetch(`${LASTFM}?${params.toString()}`, {
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchEnrichment(
  name: string,
  apiKey: string,
): Promise<{ genres: string[]; related: RawRelated[] } | null> {
  const [sim, tags] = await Promise.all([
    callLastfm<LfmSimilar>('artist.getSimilar', name, apiKey, { limit: '24' }),
    callLastfm<LfmTopTags>('artist.getTopTags', name, apiKey),
  ])
  if (!sim && !tags) return null
  const related: RawRelated[] = (sim?.similarartists?.artist ?? [])
    .map((a) => ({ name: (a.name ?? '').trim(), mbid: a.mbid || undefined }))
    .filter((a) => a.name.length > 0)
  const genres: string[] = (tags?.toptags?.tag ?? [])
    .map((t) => (t.name ?? '').trim())
    .filter((n) => n.length > 0)
    .slice(0, 6)
  return { genres, related }
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Sidecar
    if (parsed && Array.isArray(parsed.related)) return parsed
  } catch {
    // Missing or unreadable — treat as no cache.
  }
  return null
}

/**
 * Related artists + genres for one library artist. Reads the sidecar, fetching
 * + writing it when missing, stale, or `refresh` is set and a key is present.
 * Returns null only when the artist id is unknown.
 */
export async function getArtistRelated(
  library: Library,
  artistId: string,
  apiKey: string | undefined,
  opts: { refresh?: boolean } = {},
): Promise<ArtistRelatedDTO | null> {
  const artist = library.artist(artistId)
  if (!artist) return null

  const sidecarPath = join(artist.dir, SIDECAR)
  let data = await readSidecar(sidecarPath)
  const stale =
    !data ||
    data.version !== SIDECAR_VERSION ||
    Date.now() - data.fetchedAt > TTL_MS

  if ((opts.refresh || stale) && apiKey) {
    const fresh = await fetchEnrichment(artist.name, apiKey)
    if (fresh) {
      data = {
        version: SIDECAR_VERSION,
        fetchedAt: Date.now(),
        source: 'lastfm',
        genres: fresh.genres,
        related: fresh.related,
      }
      try {
        await writeFile(sidecarPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
      } catch {
        // Read-only media or a permission issue — serve the data anyway.
      }
    }
  }

  // Resolve names against the current library so matches become tappable links.
  const byName = new Map<string, { id: string; imageTag?: string }>()
  for (const a of library.artists()) {
    byName.set(norm(a.name), { id: a.id, imageTag: a.imageTag })
  }

  const related: RelatedArtist[] = (data?.related ?? []).map((r) => {
    const hit = byName.get(norm(r.name))
    return {
      name: r.name,
      mbid: r.mbid,
      artistId: hit?.id,
      imageTag: hit?.imageTag,
    }
  })

  return {
    genres: data?.genres ?? [],
    related,
    configured: !!apiKey,
    fetchedAt: data?.fetchedAt ?? null,
  }
}
