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
import { createArtistIndex } from './artist-match.ts'

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
  /** Genres as Last.fm reported them — replaced wholesale on every refetch. */
  genres: string[]
  related: RawRelated[]
  /** Tags the user added by hand. Kept apart from `genres` precisely so a
   *  refetch can overwrite Last.fm's list without touching their edits. */
  userTags?: string[]
  /** Last.fm genres the user removed. Remembered rather than deleted, so a
   *  refetch doesn't quietly bring back a tag they'd already dismissed. */
  hiddenTags?: string[]
}

export interface RelatedArtist {
  name: string
  mbid?: string
  /** Set when this artist exists in the local library — the UI links to it. */
  artistId?: string
  /** The library's own spelling of the match. The name match is fuzzy, so this
   *  can differ from `name` ("Beatles" vs "The Beatles"); the UI shows this one
   *  for matches so a tapped card and its destination page agree. */
  libraryName?: string
  /** Truthy when the matched library artist has a cover image to show. */
  imageTag?: string
}

export interface ArtistRelatedDTO {
  /** What to display: Last.fm's genres minus the user's removals, plus their
   *  own additions. The UI edits this list directly. */
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

/**
 * The tag list to display: Last.fm's genres with the user's removals taken out,
 * then their own additions appended. Case-insensitive throughout so "Doom" and
 * "doom" can't both appear, but the original casing is what gets shown.
 */
function effectiveGenres(data: Sidecar | null): string[] {
  const hidden = new Set((data?.hiddenTags ?? []).map((t) => t.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const g of data?.genres ?? []) {
    const k = g.toLowerCase()
    if (hidden.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push(g)
  }
  for (const t of data?.userTags ?? []) {
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
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
        // Hand edits outlive the refetch — that's the whole point of keeping
        // them in their own fields.
        userTags: data?.userTags,
        hiddenTags: data?.hiddenTags,
      }
      try {
        await writeFile(sidecarPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
      } catch {
        // Read-only media or a permission issue — serve the data anyway.
      }
    }
  }

  // Resolve names against the current library so matches become tappable links.
  // Uses the shared three-tier matcher, so a "Dio, Ronnie James" folder is
  // still found when Last.fm calls it "Dio".
  const index = createArtistIndex(library.artists())

  const related: RelatedArtist[] = (data?.related ?? []).map((r) => {
    const hit = index.find(r.name)
    return {
      name: r.name,
      mbid: r.mbid,
      artistId: hit?.id,
      libraryName: hit?.name,
      imageTag: hit?.imageTag,
    }
  })

  return {
    genres: effectiveGenres(data),
    related,
    configured: !!apiKey,
    fetchedAt: data?.fetchedAt ?? null,
  }
}

/**
 * Replace an artist's displayed tags with exactly `tags`.
 *
 * The caller sends the whole list it wants rather than add/remove deltas, which
 * keeps the operation idempotent and lets us derive both halves of the stored
 * state: anything Last.fm gave us that isn't in the list becomes a removal,
 * anything in the list that Last.fm didn't give us becomes an addition. Works
 * with no sidecar and no API key — a purely hand-tagged artist is fine.
 *
 * Returns the tags as stored, or null for an unknown artist id.
 */
export async function setArtistTags(
  library: Library,
  artistId: string,
  tags: string[],
): Promise<string[] | null> {
  const artist = library.artist(artistId)
  if (!artist) return null

  // Trim, drop blanks, and collapse case-duplicates while keeping first-seen
  // casing and the caller's ordering.
  const wanted: string[] = []
  const wantedKeys = new Set<string>()
  for (const raw of tags) {
    const t = raw.trim()
    const k = t.toLowerCase()
    if (!t || wantedKeys.has(k)) continue
    wantedKeys.add(k)
    wanted.push(t)
  }

  const sidecarPath = join(artist.dir, SIDECAR)
  const existing = await readSidecar(sidecarPath)
  const fromLastfm = existing?.genres ?? []
  const lastfmKeys = new Set(fromLastfm.map((g) => g.toLowerCase()))

  const next: Sidecar = {
    version: SIDECAR_VERSION,
    // No sidecar yet means nothing has ever been fetched; leaving fetchedAt at
    // 0 keeps it "stale" so enrichment still runs once a key is configured.
    fetchedAt: existing?.fetchedAt ?? 0,
    source: existing?.source ?? 'user',
    genres: fromLastfm,
    related: existing?.related ?? [],
    userTags: wanted.filter((t) => !lastfmKeys.has(t.toLowerCase())),
    hiddenTags: fromLastfm.filter((g) => !wantedKeys.has(g.toLowerCase())),
  }

  try {
    await writeFile(sidecarPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch {
    // Read-only media — report what we would have stored so the UI doesn't
    // claim a success it can't back up on the next read.
    return effectiveGenres(existing)
  }
  return effectiveGenres(next)
}
