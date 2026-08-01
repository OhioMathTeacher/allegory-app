/**
 * Discovery: what to play next, and what you're missing.
 *
 * Three independent things live here, sharing one idea — that the listening log
 * plus the enrichment sidecars already know enough to make good suggestions
 * without asking a model anything:
 *
 *   mixes            generated entirely from local data, so they work offline
 *   recommendations  library artists worth revisiting, scored from a time window
 *   missing albums   the one online piece: well-known records you don't own
 *
 * Everything degrades rather than fails. No listening history yields empty
 * mixes, not an error; no Last.fm key yields no missing-album list; a network
 * timeout yields whatever was already cached.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AlbumDTO, Library, TrackDTO } from './scanner.ts'
import { getListenLog, windowStart, type ListenWindow } from './listen-log.ts'
import { createArtistIndex } from './artist-match.ts'

const SIDECAR = '.allegory-artist.json'
const TIMEOUT_MS = 6000
const LASTFM = 'https://ws.audioscrobbler.com/2.0/'
// Top albums live in the same sidecar as the rest of the enrichment. They're
// refreshed on their own clock because they change far more slowly than
// anything else there.
const TOP_ALBUMS_TTL_MS = 1000 * 60 * 60 * 24 * 90 // 90 days
// How many artists one "missing albums" sweep will look up online. Keeps a
// cold cache from turning into hundreds of requests in a single page load.
const MAX_LOOKUPS_PER_SWEEP = 12

/** Fold a name for comparison — mirrors artist-related.ts so the two agree. */
function norm(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^the\s+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** Words that mark a parenthetical as edition noise rather than part of a title. */
const EDITION_WORDS =
  /remaster|deluxe|expanded|anniversary|edition|reissue|bonus|explicit|mono|stereo|version|disc\s*\d+|cd\s*\d*|super\s*audio/i

/**
 * Album titles carry a lot of noise that has nothing to do with identity — a
 * year the folder was named with, a "(2009 Remastered Version)", a "[Deluxe
 * Edition]", an ampersand where the other source spelled out "and". Strip it
 * before comparing, or you get told you're missing records sitting right there
 * under a slightly different name.
 *
 * Note the care around years: a bare 4-digit token is only dropped when it sits
 * in a bracket or next to an edition word, because "1984" and "2112" are album
 * titles in their own right.
 */
function normAlbum(name: string): string {
  const withoutBrackets = name.replace(
    /[([{]([^)\]}]*)[)\]}]/g,
    (whole, inner: string) =>
      EDITION_WORDS.test(inner) || /(?:19|20)\d{2}/.test(inner) ? ' ' : whole,
  )
  return norm(
    withoutBrackets
      // A leading "1973 " or "(1973) " the way folders are often named. The
      // lookahead keeps an album actually called "1984" from becoming nothing.
      .replace(/^\s*(?:19|20)\d{2}\s*[-–—.]?\s*(?=\S)/, ' ')
      .replace(new RegExp(EDITION_WORDS.source, 'gi'), ' ')
      // "Kitsune - EP" and "Kitsune" are the same record to a listener.
      .replace(/\s*[-–—]?\s*\b(?:ep|single)\b\s*$/i, ' ')
      .replace(/[&]/g, ' and ')
      .replace(/[()[\]{}]/g, ' '),
  )
}

/**
 * Compilations, hits packages and box sets. Last.fm's top-albums list is ranked
 * by scrobbles, so these crowd the top — but "you're missing The Essential Ozzy
 * Osbourne" is not a useful thing to tell someone who owns the studio records
 * it's drawn from.
 */
const COMPILATION =
  /\b(greatest hits|best of|the essential|essential|ultimate|collection|anthology|retrospective|compilation|box ?set|singles|rarities|b-sides|very best)\b/i

function isCompilation(name: string): boolean {
  return COMPILATION.test(name)
}

// --- mixes -----------------------------------------------------------------

export interface Mix {
  id: string
  title: string
  /** One line explaining why this mix exists — the reason is the feature. */
  subtitle: string
  trackIds: string[]
  tracks: TrackDTO[]
}

/** Deterministic shuffle: same inputs give the same mix within a request, so
 *  a re-render doesn't reshuffle the deck under the user. */
function seededPick<T>(items: T[], count: number, seed: number): T[] {
  const arr = [...items]
  let s = seed || 1
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, count)
}

interface PlayFacts {
  /** artistId → play count, over the whole log. */
  playsByArtist: Map<string, number>
  /** artistId → most recent play (epoch ms). */
  lastByArtist: Map<string, number>
  /** trackId → play count. */
  playsByTrack: Map<string, number>
  /** artistIds played inside the recent window. */
  recentArtists: Set<string>
}

async function playFacts(now: number): Promise<PlayFacts> {
  const log = await getListenLog()
  const recentCutoff = windowStart('30d', now)
  const facts: PlayFacts = {
    playsByArtist: new Map(),
    lastByArtist: new Map(),
    playsByTrack: new Map(),
    recentArtists: new Set(),
  }
  for (const e of log) {
    if (e.artistId) {
      facts.playsByArtist.set(
        e.artistId,
        (facts.playsByArtist.get(e.artistId) ?? 0) + 1,
      )
      const last = facts.lastByArtist.get(e.artistId) ?? 0
      if (e.at > last) facts.lastByArtist.set(e.artistId, e.at)
      if (e.at >= recentCutoff) facts.recentArtists.add(e.artistId)
    }
    facts.playsByTrack.set(e.trackId, (facts.playsByTrack.get(e.trackId) ?? 0) + 1)
  }
  return facts
}

/**
 * A twofer: two tracks in a row from each of several artists, the way a radio
 * station does it. Drawn from artists you actually play, so it feels like your
 * station rather than a random walk through the library.
 */
async function twoferMix(
  library: Library,
  facts: PlayFacts,
  seed: number,
): Promise<Mix | null> {
  const played = [...facts.playsByArtist.entries()]
    .filter(([id]) => library.artist(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id]) => id)
  if (played.length < 2) return null

  const chosen = seededPick(played, 6, seed)
  const tracks: TrackDTO[] = []
  for (const artistId of chosen) {
    const all = await library.artistTracks(artistId)
    if (all.length === 0) continue
    tracks.push(...seededPick(all, 2, seed + artistId.length))
  }
  if (tracks.length < 4) return null
  return {
    id: 'twofer',
    title: 'Twofer',
    subtitle: 'Two in a row from artists you keep coming back to',
    trackIds: tracks.map((t) => t.id),
    tracks,
  }
}

/**
 * Artists you used to play a lot and haven't touched in a month. This is the
 * mix that earns its keep in a library too big to hold in your head.
 */
async function dormantMix(
  library: Library,
  facts: PlayFacts,
  seed: number,
): Promise<Mix | null> {
  const dormant = [...facts.playsByArtist.entries()]
    .filter(([id, plays]) => plays >= 2 && !facts.recentArtists.has(id) && library.artist(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id)
  if (dormant.length === 0) return null

  const tracks: TrackDTO[] = []
  for (const artistId of seededPick(dormant, 8, seed)) {
    const all = await library.artistTracks(artistId)
    if (all.length > 0) tracks.push(...seededPick(all, 2, seed + 7))
  }
  if (tracks.length === 0) return null
  return {
    id: 'dormant',
    title: 'Haven’t heard in a while',
    subtitle: 'Favourites that have gone quiet for a month or more',
    trackIds: tracks.map((t) => t.id),
    tracks,
  }
}

/**
 * Tracks from albums you own but have never actually played. A big library
 * accumulates these; they're the cheapest discovery there is, because you
 * already own them.
 */
async function deepCutsMix(
  library: Library,
  facts: PlayFacts,
  seed: number,
): Promise<Mix | null> {
  const unplayed = library
    .allTracks()
    .filter((t) => !facts.playsByTrack.has(t.id))
  if (unplayed.length < 5) return null

  // Bias toward artists you've shown any interest in, so this stays adjacent
  // to your taste instead of dredging up the one comedy album.
  const known = unplayed.filter((t) => facts.playsByArtist.has(t.artistId))
  const pool = known.length >= 10 ? known : unplayed
  const picks = seededPick(pool, 12, seed)
  const tracks = await library.tracksForPaths(picks.map((t) => t.path))
  if (tracks.length === 0) return null
  return {
    id: 'deep-cuts',
    title: 'Deep cuts',
    subtitle: 'On your shelves, never played',
    trackIds: tracks.map((t) => t.id),
    tracks,
  }
}

/** A decade you own a lot of, sampled across artists. */
async function decadeMix(
  library: Library,
  seed: number,
): Promise<Mix | null> {
  const byDecade = new Map<number, AlbumDTO[]>()
  for (const a of library.albums()) {
    if (!a.year) continue
    const decade = Math.floor(a.year / 10) * 10
    const list = byDecade.get(decade) ?? []
    list.push(a)
    byDecade.set(decade, list)
  }
  if (byDecade.size === 0) return null
  const ranked = [...byDecade.entries()].sort((a, b) => b[1].length - a[1].length)
  // Rotate through the well-stocked decades rather than always picking the
  // biggest, so this card isn't identical every single day.
  const [decade, albums] = ranked[seed % Math.min(3, ranked.length)]

  const tracks: TrackDTO[] = []
  for (const album of seededPick(albums, 10, seed)) {
    const all = await library.albumTracks(album.id)
    if (all.length > 0) tracks.push(...seededPick(all, 1, seed + album.id.length))
  }
  if (tracks.length < 3) return null
  return {
    id: `decade-${decade}`,
    title: `The ${decade}s`,
    subtitle: `One track each from ${albums.length} albums you own from the decade`,
    trackIds: tracks.map((t) => t.id),
    tracks,
  }
}

/** Every mix worth showing right now, in display order. */
export async function getMixes(library: Library, now: number): Promise<Mix[]> {
  const facts = await playFacts(now)
  // A seed that changes daily: mixes stay stable through a session but are
  // different tomorrow, which is what makes them worth checking.
  const seed = Math.floor(now / (1000 * 60 * 60 * 24))
  const mixes = await Promise.all([
    twoferMix(library, facts, seed),
    dormantMix(library, facts, seed),
    deepCutsMix(library, facts, seed),
    decadeMix(library, seed),
  ])
  return mixes.filter((m): m is Mix => m !== null)
}

// --- recommendations -------------------------------------------------------

export interface Recommendation {
  artistId: string
  name: string
  imageTag?: string
  /** Why we're suggesting it, in the UI's own words. */
  reason: string
}

interface SidecarShape {
  genres?: string[]
  related?: { name: string }[]
  topAlbums?: { name: string; playcount?: number }[]
  topAlbumsAt?: number
}

async function readSidecar(dir: string): Promise<SidecarShape | null> {
  try {
    return JSON.parse(await readFile(join(dir, SIDECAR), 'utf8')) as SidecarShape
  } catch {
    return null
  }
}

/**
 * Artists in your library worth playing next, based on a window of listening.
 *
 * The signal is the related-artist graph: for everything you played in the
 * window, look up who Last.fm says it resembles, keep the ones you already own,
 * and rank by how many of your recent artists point at them. Something five of
 * your artists all resemble is a better bet than something only one does. We
 * deliberately exclude what you've already been playing — you don't need to be
 * told to listen to the record that's been on all week.
 */
export async function getRecommendations(
  library: Library,
  window: ListenWindow,
  now: number,
): Promise<{ window: ListenWindow; basis: number; items: Recommendation[] }> {
  const log = await getListenLog()
  const since = windowStart(window, now)
  const inWindow = log.filter((e) => e.at >= since)

  const seedArtists = new Map<string, number>()
  for (const e of inWindow) {
    if (e.artistId && library.artist(e.artistId)) {
      seedArtists.set(e.artistId, (seedArtists.get(e.artistId) ?? 0) + 1)
    }
  }

  // Same three-tier matcher as the artist page, so a related artist stored
  // under a "Last, First" folder still counts as one you own.
  const index = createArtistIndex(library.artists())

  // candidate artistId → the seed artists that pointed at it
  const votes = new Map<string, Set<string>>()
  const top = [...seedArtists.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  for (const [artistId] of top) {
    const artist = library.artist(artistId)
    if (!artist) continue
    const sidecar = await readSidecar(artist.dir)
    for (const rel of sidecar?.related ?? []) {
      const hit = index.find(rel.name)
      if (!hit || hit.id === artistId || seedArtists.has(hit.id)) continue
      const set = votes.get(hit.id) ?? new Set<string>()
      set.add(library.artist(artistId)?.name ?? artistId)
      votes.set(hit.id, set)
    }
  }

  const items: Recommendation[] = [...votes.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 18)
    .flatMap(([artistId, voters]) => {
      const a = library.artists().find((x) => x.id === artistId)
      if (!a) return []
      const names = [...voters]
      const reason =
        names.length === 1
          ? `Because you played ${names[0]}`
          : `Like ${names.slice(0, 2).join(' and ')}${
              names.length > 2 ? ` (+${names.length - 2} more)` : ''
            }`
      return [{ artistId, name: a.name, imageTag: a.imageTag, reason }]
    })

  return { window, basis: seedArtists.size, items }
}

// --- missing albums --------------------------------------------------------

export interface MissingAlbum {
  artistId: string
  artist: string
  album: string
  /** Last.fm listener count — a rough proxy for "how well known". */
  playcount?: number
}

interface LfmTopAlbums {
  topalbums?: { album?: { name?: string; playcount?: number }[] }
}

async function fetchTopAlbums(
  name: string,
  apiKey: string,
): Promise<{ name: string; playcount?: number }[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const params = new URLSearchParams({
      method: 'artist.getTopAlbums',
      artist: name,
      api_key: apiKey,
      format: 'json',
      autocorrect: '1',
      limit: '15',
    })
    const res = await fetch(`${LASTFM}?${params}`, { signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json()) as LfmTopAlbums
    return (body.topalbums?.album ?? [])
      .map((a) => ({ name: (a.name ?? '').trim(), playcount: Number(a.playcount) || undefined }))
      .filter((a) => a.name && a.name.toLowerCase() !== '(null)')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Well-known albums by artists you already own — that you don't own.
 *
 * Scoped to the artists you actually listen to rather than the whole library,
 * which keeps it both relevant and cheap: a 500-artist collection would
 * otherwise mean 500 Last.fm calls to answer one screen. Results are cached
 * into each artist's existing sidecar, so a second visit is free and offline.
 */
export async function getMissingAlbums(
  library: Library,
  apiKey: string | undefined,
  now: number,
): Promise<{ configured: boolean; items: MissingAlbum[] }> {
  if (!apiKey) return { configured: false, items: [] }

  const facts = await playFacts(now)
  const candidates = [...facts.playsByArtist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .filter((id) => library.artist(id))

  const items: MissingAlbum[] = []
  let lookups = 0

  for (const artistId of candidates) {
    const artist = library.artist(artistId)
    if (!artist) continue

    const sidecarPath = join(artist.dir, SIDECAR)
    let sidecar = await readSidecar(artist.dir)
    const fresh =
      sidecar?.topAlbums &&
      sidecar.topAlbumsAt &&
      now - sidecar.topAlbumsAt < TOP_ALBUMS_TTL_MS

    if (!fresh) {
      if (lookups >= MAX_LOOKUPS_PER_SWEEP) continue
      lookups += 1
      const top = await fetchTopAlbums(artist.name, apiKey)
      if (top) {
        sidecar = { ...(sidecar ?? {}), topAlbums: top, topAlbumsAt: now }
        try {
          // Merge into whatever else the sidecar holds — never clobber the
          // related-artist data or the user's tags.
          const existing = await readSidecar(artist.dir)
          await writeFile(
            sidecarPath,
            JSON.stringify({ ...(existing ?? {}), topAlbums: top, topAlbumsAt: now }, null, 2) + '\n',
            'utf8',
          )
        } catch {
          // Read-only media — serve what we fetched without caching it.
        }
      }
    }

    const owned = new Set(
      library.artistAlbums(artistId).map((a) => normAlbum(a.name)),
    )
    const candidates = sidecar?.topAlbums ?? []
    // Last.fm's top-albums list is polluted by mis-scrobbled singles, which
    // show up with a tiny fraction of a real album's count. Judge each artist
    // against their own best rather than an absolute number, so this works the
    // same for a stadium act and a band with four hundred listeners.
    // Relative to the artist's own best, but capped: 5% of a 13-million-play
    // Paranoid would be 650k, which would throw away real Black Sabbath
    // records. The cap keeps the rule aimed at obvious junk.
    const best = Math.max(0, ...candidates.map((c) => c.playcount ?? 0))
    const floor = Math.min(best * 0.05, 50_000)

    // The same record recurs as several remasters; collapse them, keeping the
    // highest count but the cleanest title to show.
    const merged = new Map<string, { name: string; playcount?: number }>()
    for (const candidate of candidates) {
      const key = normAlbum(candidate.name)
      if (!key || owned.has(key)) continue
      if (isCompilation(candidate.name)) continue
      if (best > 0 && (candidate.playcount ?? 0) < floor) continue
      const hit = merged.get(key)
      if (!hit) {
        merged.set(key, { name: candidate.name, playcount: candidate.playcount })
        continue
      }
      // Prefer a title without a parenthetical; fall back to the shorter one.
      const cleaner =
        candidate.name.replace(/\s*[([{].*/, '').length < hit.name.length &&
        !/[([{]/.test(candidate.name)
      if (cleaner) hit.name = candidate.name
      if ((candidate.playcount ?? 0) > (hit.playcount ?? 0)) {
        hit.playcount = candidate.playcount
      }
    }

    for (const entry of merged.values()) {
      items.push({
        artistId,
        artist: artist.name,
        album: entry.name,
        playcount: entry.playcount,
      })
    }
  }

  // Best-known first, so the most conspicuous gaps lead.
  items.sort((a, b) => (b.playcount ?? 0) - (a.playcount ?? 0))
  return { configured: true, items: items.slice(0, 40) }
}
