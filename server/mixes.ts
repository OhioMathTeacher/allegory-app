/**
 * Mixes — the generated playlists on the Discover page.
 *
 * A catalogue, not a hardcoded handful. Each entry knows three things: how to
 * describe itself, whether the library can currently produce it, and how to
 * pull `count` tracks that aren't already spoken for. That last signature is
 * what makes a mix endless — the card asks for an opening batch, and the player
 * asks the same builder for more later with the whole queue excluded.
 *
 * The catalogue is deliberately wider than the page. The user picks up to three
 * and only those get built, so opening Discover now costs less than it did when
 * four mixes were computed whether you looked at them or not.
 *
 * Everything here reads local data only — the listening log, the scanned index,
 * and the enrichment sidecars already on disk. No mix needs the network, and a
 * mix that can't be made says so rather than failing.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AlbumDTO, Library, ScannedTrack, TrackDTO } from './scanner.ts'
import { playFacts, seededPick, type PlayFacts } from './discover.ts'

/** Which shelf of the picker a mix sits on. */
export type MixGroup = 'history' | 'shelf' | 'genre'

export interface Mix {
  id: string
  title: string
  /** One line explaining why this mix exists — the reason is the feature. */
  subtitle: string
  group: MixGroup
  trackIds: string[]
  tracks: TrackDTO[]
}

/** A mix that was asked for but isn't there — the picker's promise, unkept. */
export interface SkippedMix {
  id: string
  title: string
  /** In the UI's own words: why this one has no card today. */
  reason: string
}

/** One row in the picker's catalogue. */
export interface MixTypeDTO {
  id: string
  title: string
  subtitle: string
  group: MixGroup
  /** False when the library or the log can't currently produce this one. */
  available: boolean
  /** Why not, in the picker's own words. Only set when unavailable. */
  reason?: string
}

/** How many mixes the page will show at once. */
export const MAX_MIXES = 3

// A mix opens with INITIAL tracks and, once it's playing, tops itself up REFILL
// at a time so it never runs dry — see moreMixTracks and the player's refill.
const INITIAL = 12
const REFILL = 12

const DAY = 1000 * 60 * 60 * 24
const SECOND = 10_000_000 // duration ticks

// --- facts about the shelf --------------------------------------------------

/**
 * Everything the shelf-based mixes need, derived once per request from the
 * in-memory index. Deliberately free of tag reads: durations are the one thing
 * the scan skips, so anything needing them (short / long) pays for itself in
 * its own builder rather than making every mix wait.
 */
interface ShelfFacts {
  /** Every scanned track. */
  tracks: ScannedTrack[]
  /** albumId → its tracks, in track order. */
  byAlbum: Map<string, ScannedTrack[]>
  /** artistId → its tracks, album by album. */
  byArtist: Map<string, ScannedTrack[]>
  albums: AlbumDTO[]
  /** artistId → its albums. */
  albumsByArtist: Map<string, AlbumDTO[]>
  /** Decades with albums in them, best-stocked first. */
  decades: { decade: number; albums: number }[]
  /** Years with at least one album, ascending. */
  years: number[]
  /** albumId → the album, for the id-keyed lookups below. */
  albumById: Map<string, AlbumDTO>
  /** Newest file mtime anywhere in the library. */
  newestAt: number
}

/** A track's number, tag first and filename second — how the scan orders them. */
function trackNo(t: ScannedTrack): number {
  return t.tagTrackNo ?? t.fileNum ?? 9999
}

function shelfFacts(library: Library): ShelfFacts {
  const tracks = library.allTracks()
  const byAlbum = new Map<string, ScannedTrack[]>()
  const byArtist = new Map<string, ScannedTrack[]>()
  let newestAt = 0
  for (const t of tracks) {
    const album = byAlbum.get(t.albumId)
    if (album) album.push(t)
    else byAlbum.set(t.albumId, [t])
    const artist = byArtist.get(t.artistId)
    if (artist) artist.push(t)
    else byArtist.set(t.artistId, [t])
    if (t.mtimeMs > newestAt) newestAt = t.mtimeMs
  }
  for (const list of byAlbum.values()) list.sort((a, b) => trackNo(a) - trackNo(b))

  const albums = library.albums()
  const albumById = new Map(albums.map((a) => [a.id, a]))
  const albumsByArtist = new Map<string, AlbumDTO[]>()
  const byDecade = new Map<number, number>()
  const years = new Set<number>()
  for (const a of albums) {
    if (a.artistId) {
      const list = albumsByArtist.get(a.artistId)
      if (list) list.push(a)
      else albumsByArtist.set(a.artistId, [a])
    }
    if (a.year) {
      years.add(a.year)
      const decade = Math.floor(a.year / 10) * 10
      byDecade.set(decade, (byDecade.get(decade) ?? 0) + 1)
    }
  }

  return {
    tracks,
    byAlbum,
    byArtist,
    albums,
    albumById,
    albumsByArtist,
    decades: [...byDecade.entries()]
      .map(([decade, albums]) => ({ decade, albums }))
      .sort((a, b) => b.albums - a.albums),
    years: [...years].sort((a, b) => a - b),
    newestAt,
  }
}

interface MixCtx {
  library: Library
  facts: PlayFacts
  shelf: ShelfFacts
  now: number
}

// --- shared picking ---------------------------------------------------------

/** Scanned tracks not already in the queue. */
function free(tracks: ScannedTrack[], exclude: Set<string>): ScannedTrack[] {
  return tracks.filter((t) => !exclude.has(t.id))
}

/**
 * Walk a set of groups in seeded order, taking `per` tracks from each until
 * `count` is filled. Almost every mix is this shape — two in a row from each
 * artist, one track from each album — so it lives here once rather than eight
 * times over. Groups are shuffled, so a mix isn't alphabetical by accident.
 */
function pickAcross(
  groups: ScannedTrack[][],
  per: number,
  seed: number,
  exclude: Set<string>,
  count: number,
): ScannedTrack[] {
  const out: ScannedTrack[] = []
  const taken = new Set(exclude)
  for (const group of seededPick(groups, groups.length, seed)) {
    const pool = free(group, taken)
    if (pool.length === 0) continue
    for (const t of seededPick(pool, per, seed + group.length)) {
      out.push(t)
      taken.add(t.id)
    }
    if (out.length >= count) break
  }
  return out.slice(0, count)
}

/** Turn chosen tracks into DTOs. The one place a duration gets read. */
function resolve(library: Library, picks: ScannedTrack[]): Promise<TrackDTO[]> {
  return library.tracksForPaths(picks.map((t) => t.path))
}

/**
 * Tracks whose length passes a test. Duration is the one tag the scan skips, so
 * this reads files — a batch at a time, stopping the moment the mix is full.
 * Worst case it looks at a few hundred files; the scanner memoises what it
 * reads, so the second visit costs nothing.
 */
async function byDuration(
  ctx: MixCtx,
  seed: number,
  exclude: Set<string>,
  count: number,
  keep: (ticks: number) => boolean,
): Promise<TrackDTO[]> {
  const pool = seededPick(free(ctx.shelf.tracks, exclude), 400, seed)
  const out: TrackDTO[] = []
  for (let i = 0; i < pool.length && out.length < count; i += 60) {
    const batch = await resolve(ctx.library, pool.slice(i, i + 60))
    // A zero duration means the file wouldn't parse, not that it's short.
    out.push(...batch.filter((t) => t.durationTicks > 0 && keep(t.durationTicks)))
  }
  return out.slice(0, count)
}

/** Log-derived play counts inside a window, newest wins. */
function playedTracks(ctx: MixCtx, ids: string[], exclude: Set<string>): ScannedTrack[] {
  const out: ScannedTrack[] = []
  const seen = new Set(exclude)
  for (const id of ids) {
    if (seen.has(id)) continue
    const t = ctx.library.track(id)
    if (!t) continue // played once, since deleted or re-tagged
    seen.add(id)
    out.push(t)
  }
  return out
}

// --- genre index ------------------------------------------------------------

const SIDECAR = '.allegory-artist.json'
// Only the sidecar half of the genre index is cached, and only against the
// disk reads it costs. The half that comes from file tags is recomputed every
// time: it's an in-memory walk, and it's the half that changes the moment you
// tag an album and the library rescans. A TTL over that half would mean tagging
// a record live and not seeing it for five minutes.
const SIDECAR_TTL_MS = 1000 * 60 * 5

interface GenreEntry {
  slug: string
  label: string
  /** Artists whose sidecar carries the tag — the whole catalogue counts. */
  artistIds: string[]
  /** Albums whose own files carry it — just those records. */
  albumIds: string[]
}

/** slug → the artists whose sidecar carries that tag, and how it's spelled. */
type SidecarTags = Map<string, { label: string; artistIds: string[] }>

let sidecarCache: { dir: string; at: number; tags: SidecarTags } | null = null

/** Fold a tag to a stable id. "Post-Punk", "post punk" and "post-punk" agree. */
function slugify(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
}

/**
 * "post-punk" → "Post-punk", for a card title built from a slug alone. The
 * hyphens stay: they came from spaces as often as from hyphens, and every
 * reading ("Hip-hop", "Singer-songwriter", "Post-punk") is one people write.
 */
function labelFor(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

interface GenreSidecar {
  genres?: string[]
  userTags?: string[]
  hiddenTags?: string[]
}

/**
 * The tags an artist actually displays — mirrors effectiveGenres in
 * artist-related.ts, so a tag the user hid can't come back as a mix.
 */
function shownTags(data: GenreSidecar): string[] {
  const hidden = new Set((data.hiddenTags ?? []).map((t) => t.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const tag of [...(data.genres ?? []), ...(data.userTags ?? [])]) {
    const key = tag.toLowerCase()
    if (hidden.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/**
 * Genres worth offering as a mix, from both places a genre is written down:
 * the tags on your artists (Last.fm's, plus your own) and the genre frame in
 * the files themselves, which is what the tag editor writes.
 *
 * The two aren't the same claim. An artist tag says "this band is post-punk"
 * and pulls their whole catalogue; a file tag says "this record is live" and
 * pulls only that record. Both fold into one entry per genre.
 *
 * Only genres reaching several artists make the list — a tag on one band makes
 * a mix of that band, which is not a mix. The sidecars are read straight off
 * disk, a lot of tiny reads for a big library, so the result is cached briefly;
 * the picker asks for it every time it opens.
 */
async function genreIndex(library: Library, now: number): Promise<GenreEntry[]> {
  const fromArtists = await sidecarTags(library, now)
  const bySlug = new Map<
    string,
    { label: string; artistIds: Set<string>; albumIds: Set<string>; reach: Set<string> }
  >()
  const entry = (tag: string) => {
    const slug = slugify(tag)
    if (!slug) return null
    let hit = bySlug.get(slug)
    if (!hit) {
      // Keep the spelling as written — "Alternative Rock" reads better than
      // anything reconstructed from its slug. Only a lowercase tag gets a
      // capital, which is how Last.fm writes all of them.
      hit = { label: displayTag(tag), artistIds: new Set(), albumIds: new Set(), reach: new Set() }
      bySlug.set(slug, hit)
    }
    return hit
  }

  for (const tagged of fromArtists.values()) {
    // The label round-trips to the same slug it was keyed by, so this lands on
    // the same entry a file tag with that spelling would.
    const hit = entry(tagged.label)
    if (!hit) continue
    for (const artistId of tagged.artistIds) {
      hit.artistIds.add(artistId)
      hit.reach.add(artistId)
    }
  }

  for (const album of library.albums()) {
    for (const tag of album.genres ?? []) {
      const hit = entry(tag)
      if (!hit) continue
      hit.albumIds.add(album.id)
      if (album.artistId) hit.reach.add(album.artistId)
    }
  }

  return [...bySlug.entries()]
    // Live records get their own card, with a heuristic behind it that a plain
    // genre mix hasn't got. Offering both would be the same mix listed twice.
    .filter(([slug]) => !LIVE_TAGS.has(slug))
    .map(([slug, v]) => ({
      slug,
      label: v.label,
      artistIds: [...v.artistIds],
      albumIds: [...v.albumIds],
      reach: v.reach.size,
    }))
    .filter((g) => g.reach >= 3)
    .sort((a, b) => b.reach - a.reach)
    .slice(0, 12)
    .map(({ slug, label, artistIds, albumIds }) => ({ slug, label, artistIds, albumIds }))
}

/** The artist-tag half of the index — the part that costs a read per artist. */
async function sidecarTags(library: Library, now: number): Promise<SidecarTags> {
  if (sidecarCache && sidecarCache.dir === library.musicDir && now - sidecarCache.at < SIDECAR_TTL_MS) {
    return sidecarCache.tags
  }
  const tags: SidecarTags = new Map()
  for (const artist of library.artists()) {
    const dir = library.artist(artist.id)?.dir
    if (!dir) continue
    let data: GenreSidecar
    try {
      data = JSON.parse(await readFile(join(dir, SIDECAR), 'utf8')) as GenreSidecar
    } catch {
      continue // no enrichment for this artist yet
    }
    for (const tag of shownTags(data)) {
      const slug = slugify(tag)
      if (!slug) continue
      const hit = tags.get(slug)
      if (hit) hit.artistIds.push(artist.id)
      else tags.set(slug, { label: displayTag(tag), artistIds: [artist.id] })
    }
  }
  sidecarCache = { dir: library.musicDir, at: now, tags }
  return tags
}

/** A tag as it should read on a card: as written, but never uncapitalised. */
function displayTag(tag: string): string {
  const clean = tag.trim()
  return clean === clean.toLowerCase() ? labelFor(clean) : clean
}

// --- the catalogue ----------------------------------------------------------

/**
 * How many tracks a set of groups can actually yield at `per` apiece. The
 * picker's promise and the builder's cap have to be computed the same way: five
 * newly-added tracks that all sit on one album are two tracks once the
 * per-album take is applied, not five, and a mix that says it's available and
 * then comes back short is the picker lying.
 */
function yieldOf(groups: ScannedTrack[][], per: number): number {
  return groups.reduce((n, g) => n + Math.min(per, g.length), 0)
}

interface MixType {
  id: string
  title: string
  subtitle: string
  group: MixGroup
  /** Fewest tracks worth showing a card for. */
  min: number
  /** Cheap enough to run for all thirty on every picker open. */
  ready(ctx: MixCtx): boolean
  /** Shown greyed in the picker when `ready` says no. */
  reason: string
  build(
    ctx: MixCtx,
    seed: number,
    exclude: Set<string>,
    count: number,
  ): Promise<TrackDTO[]>
}

/**
 * A mix made by taking `per` tracks from each of a set of groups — two in a row
 * from each artist, one track from each album. Declaring the groups once means
 * `ready` and `build` can't drift apart.
 */
function groupMix(
  base: Omit<MixType, 'ready' | 'build'>,
  groups: (ctx: MixCtx) => ScannedTrack[][],
  per: number,
): MixType {
  return {
    ...base,
    ready: (ctx) => yieldOf(groups(ctx), per) >= base.min,
    build: async (ctx, seed, exclude, count) =>
      resolve(ctx.library, pickAcross(groups(ctx), per, seed, exclude, count)),
  }
}

/** Artists you've played, best first, that still exist in the library. */
function rankedArtists(ctx: MixCtx, limit: number): string[] {
  return [...ctx.facts.playsByArtist.entries()]
    .filter(([id]) => ctx.library.artist(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}

/** The tracks of a list of artists, as groups for pickAcross. */
function artistGroups(ctx: MixCtx, artistIds: string[]): ScannedTrack[][] {
  return artistIds
    .map((id) => ctx.shelf.byArtist.get(id) ?? [])
    .filter((g) => g.length > 0)
}

const CATALOGUE: MixType[] = [
  // --- from your listening ---
  groupMix(
    {
      id: 'twofer',
      title: 'Twofer',
      subtitle: 'Two in a row from artists you keep coming back to',
      group: 'history',
      min: 4,
      reason: 'Needs a few artists played more than once',
    },
    (ctx) => artistGroups(ctx, rankedArtists(ctx, 20)),
    2,
  ),
  groupMix(
    {
      id: 'dormant',
      title: 'Haven’t heard in a while',
      subtitle: 'Favourites that have gone quiet for a month or more',
      group: 'history',
      min: 2,
      reason: 'Nothing has gone quiet yet',
    },
    (ctx) => artistGroups(ctx, dormantArtists(ctx)),
    2,
  ),
  {
    id: 'on-repeat',
    title: 'On repeat',
    subtitle: 'The tracks you can’t leave alone lately',
    group: 'history',
    min: 4,
    reason: 'Nothing played twice in the last month',
    ready: (ctx) => onRepeatIds(ctx).length >= 4,
    build: async (ctx, _seed, exclude, count) =>
      resolve(ctx.library, playedTracks(ctx, onRepeatIds(ctx), exclude).slice(0, count)),
  },
  groupMix(
    {
      id: 'gauntlet',
      title: 'The gauntlet',
      subtitle: 'One track each from your most-played artists',
      group: 'history',
      min: 5,
      reason: 'Needs a handful of artists in your history',
    },
    (ctx) => artistGroups(ctx, rankedArtists(ctx, 12)),
    1,
  ),
  {
    id: 'one-year-ago',
    title: 'One year ago',
    subtitle: 'What you had on this time last year',
    group: 'history',
    min: 4,
    reason: 'Your listening log doesn’t reach back a year yet',
    ready: (ctx) => yearAgoIds(ctx).length >= 4,
    build: async (ctx, seed, exclude, count) => {
      const picks = playedTracks(ctx, yearAgoIds(ctx), exclude)
      return resolve(ctx.library, seededPick(picks, count, seed))
    },
  },
  {
    id: 'didnt-stick',
    title: 'Didn’t stick',
    subtitle: 'Played once, months ago, never again',
    group: 'history',
    min: 5,
    reason: 'Nothing has been left behind long enough',
    ready: (ctx) => onceIds(ctx).length >= 5,
    build: async (ctx, seed, exclude, count) => {
      const picks = playedTracks(ctx, onceIds(ctx), exclude)
      return resolve(ctx.library, seededPick(picks, count, seed))
    },
  },

  // --- from your shelves ---
  {
    id: 'deep-cuts',
    title: 'Deep cuts',
    subtitle: 'On your shelves, never played',
    group: 'shelf',
    min: 5,
    reason: 'You’ve played everything you own',
    ready: (ctx) => unplayed(ctx).length >= 5,
    build: async (ctx, seed, exclude, count) => {
      const pool = free(unplayed(ctx), exclude)
      // Bias toward artists you've shown any interest in, so this stays
      // adjacent to your taste instead of dredging up the one comedy album.
      const known = pool.filter((t) => ctx.facts.playsByArtist.has(t.artistId))
      return resolve(ctx.library, seededPick(known.length >= 10 ? known : pool, count, seed))
    },
  },
  groupMix(
    {
      id: 'fresh',
      title: 'Freshly ripped',
      subtitle: 'Landed on disk in the last month',
      group: 'shelf',
      min: 4,
      reason: 'Nothing new has arrived in the last month',
    },
    (ctx) => groupByAlbum(recentlyAdded(ctx)),
    2,
  ),
  groupMix(
    {
      id: 'stack',
      title: 'The stack',
      subtitle: 'Albums you filed away and never opened',
      group: 'shelf',
      min: 4,
      reason: 'No album has been sitting unplayed',
    },
    stackAlbums,
    2,
  ),
  {
    id: 'openers',
    title: 'Track ones',
    subtitle: 'Every record’s opening statement',
    group: 'shelf',
    min: 5,
    reason: 'Needs a few albums with track numbers',
    ready: (ctx) => openers(ctx).length >= 5,
    build: async (ctx, seed, exclude, count) =>
      resolve(ctx.library, seededPick(free(openers(ctx), exclude), count, seed)),
  },
  {
    id: 'closers',
    title: 'Closers',
    subtitle: 'The last song on the album, usually the best one',
    group: 'shelf',
    min: 5,
    reason: 'Needs a few full albums with track numbers',
    ready: (ctx) => closers(ctx).length >= 5,
    build: async (ctx, seed, exclude, count) =>
      resolve(ctx.library, seededPick(free(closers(ctx), exclude), count, seed)),
  },
  {
    id: 'short',
    title: 'Short and sharp',
    subtitle: 'Nothing over two and a half minutes',
    group: 'shelf',
    min: 4,
    reason: 'Needs more tracks to sift through',
    ready: (ctx) => ctx.shelf.tracks.length >= 40,
    build: (ctx, seed, exclude, count) =>
      byDuration(ctx, seed, exclude, count, (ticks) => ticks <= 150 * SECOND),
  },
  {
    id: 'long',
    title: 'The long ones',
    subtitle: 'Seven minutes and up',
    group: 'shelf',
    min: 3,
    reason: 'Needs more tracks to sift through',
    ready: (ctx) => ctx.shelf.tracks.length >= 40,
    build: (ctx, seed, exclude, count) =>
      byDuration(ctx, seed, exclude, count, (ticks) => ticks >= 420 * SECOND),
  },
  groupMix(
    {
      id: 'live',
      title: 'Live',
      subtitle: 'Albums you’ve tagged live, and any that say so on the sleeve',
      group: 'shelf',
      min: 4,
      reason: 'Nothing tagged live, and no sleeve says so',
    },
    liveAlbums,
    2,
  ),
  groupMix(
    {
      id: 'debuts',
      title: 'Debuts',
      subtitle: 'The first record by artists you own several of',
      group: 'shelf',
      min: 4,
      reason: 'Needs a few artists with dated albums',
    },
    debutAlbums,
    1,
  ),
  groupMix(
    {
      id: 'deep-shelf',
      title: 'Deep shelf',
      subtitle: 'Artists you own five or more albums by',
      group: 'shelf',
      min: 4,
      reason: 'No artist runs five albums deep yet',
    },
    (ctx) => artistGroups(ctx, wellStockedArtists(ctx, 5)),
    2,
  ),
  groupMix(
    {
      id: 'one-and-done',
      title: 'One and done',
      subtitle: 'Artists you own exactly one record by',
      group: 'shelf',
      min: 5,
      reason: 'Needs a few one-album artists',
    },
    (ctx) => artistGroups(ctx, singleAlbumArtists(ctx)),
    1,
  ),
  {
    id: 'chronological',
    title: 'Chronological',
    subtitle: 'One track a year, oldest first',
    group: 'shelf',
    min: 5,
    reason: 'Needs albums across at least five years',
    ready: (ctx) => ctx.shelf.years.length >= 5,
    build: async (ctx, seed, exclude, count) => {
      // The one mix that must not be shuffled — the running order is the point.
      const out: ScannedTrack[] = []
      const taken = new Set(exclude)
      for (const year of ctx.shelf.years) {
        const albums = ctx.shelf.albums.filter((a) => a.year === year)
        const [album] = seededPick(albums, 1, seed + year)
        const pool = free(ctx.shelf.byAlbum.get(album?.id ?? '') ?? [], taken)
        if (pool.length === 0) continue
        const [track] = seededPick(pool, 1, seed + year)
        out.push(track)
        taken.add(track.id)
        if (out.length >= count) break
      }
      return resolve(ctx.library, out)
    },
  },
  {
    id: 'shuffle',
    title: 'Pure shuffle',
    subtitle: 'The whole library, no opinion at all',
    group: 'shelf',
    min: 4,
    reason: 'Nothing scanned yet',
    ready: (ctx) => ctx.shelf.tracks.length >= 4,
    build: async (ctx, seed, exclude, count) =>
      resolve(ctx.library, seededPick(free(ctx.shelf.tracks, exclude), count, seed)),
  },
]

const BY_ID = new Map(CATALOGUE.map((t) => [t.id, t]))

// --- selectors the catalogue leans on ---------------------------------------
// Each is cheap and pure, so a type's `ready` can call the same function its
// `build` does and the picker can never promise a mix that comes back empty.

function dormantArtists(ctx: MixCtx): string[] {
  return [...ctx.facts.playsByArtist.entries()]
    .filter(
      ([id, plays]) =>
        plays >= 2 && !ctx.facts.recentArtists.has(id) && ctx.library.artist(id),
    )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => id)
}

function onRepeatIds(ctx: MixCtx): string[] {
  return [...ctx.facts.recentPlaysByTrack.entries()]
    .filter(([id, plays]) => plays >= 2 && ctx.library.track(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
}

/** Tracks played in a fortnight straddling this date last year. */
function yearAgoIds(ctx: MixCtx): string[] {
  const from = ctx.now - 372 * DAY
  const to = ctx.now - 358 * DAY
  const out: string[] = []
  for (const e of ctx.facts.log) {
    if (e.at >= from && e.at <= to && ctx.library.track(e.trackId)) out.push(e.trackId)
  }
  return out
}

/** Played exactly once, and not for two months — a record that didn't land. */
function onceIds(ctx: MixCtx): string[] {
  const cutoff = ctx.now - 60 * DAY
  const out: string[] = []
  for (const [id, plays] of ctx.facts.playsByTrack) {
    if (plays !== 1) continue
    if ((ctx.facts.lastByTrack.get(id) ?? 0) > cutoff) continue
    if (!ctx.library.track(id)) continue
    out.push(id)
  }
  return out
}

function unplayed(ctx: MixCtx): ScannedTrack[] {
  return ctx.shelf.tracks.filter((t) => !ctx.facts.playsByTrack.has(t.id))
}

function recentlyAdded(ctx: MixCtx): ScannedTrack[] {
  const cutoff = ctx.now - 30 * DAY
  return ctx.shelf.tracks.filter((t) => t.mtimeMs >= cutoff)
}

/** Group loose tracks by the album they came from, for pickAcross. */
function groupByAlbum(tracks: ScannedTrack[]): ScannedTrack[][] {
  const by = new Map<string, ScannedTrack[]>()
  for (const t of tracks) {
    const list = by.get(t.albumId)
    if (list) list.push(t)
    else by.set(t.albumId, [t])
  }
  return [...by.values()]
}

/** Albums filed more than a month ago that have never once been played. */
function stackAlbums(ctx: MixCtx): ScannedTrack[][] {
  const cutoff = ctx.now - 30 * DAY
  const out: ScannedTrack[][] = []
  for (const [albumId, tracks] of ctx.shelf.byAlbum) {
    if (tracks.length < 3) continue
    if ((ctx.shelf.albumById.get(albumId)?.addedAt ?? 0) > cutoff) continue
    if (tracks.some((t) => ctx.facts.playsByTrack.has(t.id))) continue
    out.push(tracks)
  }
  return out
}

function openers(ctx: MixCtx): ScannedTrack[] {
  const out: ScannedTrack[] = []
  for (const tracks of ctx.shelf.byAlbum.values()) {
    // Four tracks or more, or a stray single counts as its own opener.
    if (tracks.length < 4) continue
    const first = tracks[0]
    if (trackNo(first) === 1) out.push(first)
  }
  return out
}

function closers(ctx: MixCtx): ScannedTrack[] {
  const out: ScannedTrack[] = []
  for (const tracks of ctx.shelf.byAlbum.values()) {
    if (tracks.length < 5) continue
    const last = tracks[tracks.length - 1]
    if (trackNo(last) !== 9999) out.push(last)
  }
  return out
}

/**
 * Album titles that announce a concert recording rather than a studio one.
 * Deliberately narrow — a looser pattern ("at the …") sweeps up studio records
 * with a preposition in the title, and a mix with a lie in it is worse than a
 * short mix.
 */
const LIVE_ALBUM = /\blive\b|\bunplugged\b|\bin concert\b|\bconcert\b/i

/** Genre tags that mean "this is a performance". Slugs, so "Live Album",
 *  "live-album" and "LIVE" all land here. */
const LIVE_TAGS = new Set(['live', 'live-album', 'unplugged', 'concert'])

function isLiveTag(tag: string): boolean {
  return LIVE_TAGS.has(slugify(tag))
}

/**
 * Live records: what you've tagged, plus what says so on the sleeve.
 *
 * A union, not a preference. Most files arrive from a ripper with a genre
 * already in them — "Live Evil" comes through tagged Metal — so "this album has
 * tags, trust them" would quietly drop real live records that nobody
 * deliberately tagged. Tagging an album live adds it to the mix; it never takes
 * anything away, which is the only rule that behaves the same on a hand-curated
 * library and a freshly ripped one.
 */
function liveAlbums(ctx: MixCtx): ScannedTrack[][] {
  return ctx.shelf.albums
    .filter((a) => (a.genres ?? []).some(isLiveTag) || LIVE_ALBUM.test(a.name))
    .map((a) => ctx.shelf.byAlbum.get(a.id) ?? [])
    .filter((g) => g.length > 0)
}

/** The earliest dated album of every artist you own more than one of. */
function debutAlbums(ctx: MixCtx): ScannedTrack[][] {
  const out: ScannedTrack[][] = []
  for (const albums of ctx.shelf.albumsByArtist.values()) {
    const dated = albums.filter((a) => a.year)
    if (dated.length < 2) continue
    const debut = dated.reduce((a, b) => ((a.year ?? 0) <= (b.year ?? 0) ? a : b))
    const tracks = ctx.shelf.byAlbum.get(debut.id) ?? []
    if (tracks.length > 0) out.push(tracks)
  }
  return out
}

function wellStockedArtists(ctx: MixCtx, least: number): string[] {
  return [...ctx.shelf.albumsByArtist.entries()]
    .filter(([, albums]) => albums.length >= least)
    .map(([id]) => id)
}

function singleAlbumArtists(ctx: MixCtx): string[] {
  return [...ctx.shelf.albumsByArtist.entries()]
    .filter(([, albums]) => albums.length === 1)
    .map(([id]) => id)
}

// --- parameterised types ----------------------------------------------------
// Decades and genres aren't fixed entries — the catalogue offers whatever the
// library happens to hold. Their ids carry the parameter so a refill can find
// its way back to the same decade or tag with nothing else remembered.

function decadeType(decade: number, albums: number): MixType {
  return groupMix(
    {
      id: `decade-${decade}`,
      title: `The ${decade}s`,
      subtitle: `One track each from ${albums} album${albums === 1 ? '' : 's'} you own from the decade`,
      group: 'shelf',
      min: 3,
      reason: 'Not enough albums from this decade',
    },
    (ctx) =>
      ctx.shelf.albums
        .filter((a) => a.year && Math.floor(a.year / 10) * 10 === decade)
        .map((a) => ctx.shelf.byAlbum.get(a.id) ?? [])
        .filter((g) => g.length > 0),
    1,
  )
}

function genreType(slug: string, label: string, entry?: GenreEntry): MixType {
  return groupMix(
    {
      id: `genre-${slug}`,
      title: label,
      subtitle: `Tagged ${label.toLowerCase()}, on your own shelves`,
      group: 'genre',
      min: 4,
      reason: 'Not enough of your library carries this tag',
    },
    // An artist tagged with a genre brings their whole catalogue; an album
    // tagged with one brings only itself. Album groups come first so a tagged
    // record can't be crowded out by a well-stocked artist. A tag that has
    // since fallen out of the catalogue has no entry and yields nothing, which
    // the page reports as skipped rather than as an empty card.
    (ctx) =>
      entry
        ? [
            ...entry.albumIds.map((id) => ctx.shelf.byAlbum.get(id) ?? []),
            ...artistGroups(ctx, entry.artistIds),
          ].filter((g) => g.length > 0)
        : [],
    2,
  )
}

/**
 * The type behind an id, including the parameterised ones.
 *
 * Decades and genres carry their parameter in the id and nothing else, so both
 * are rebuilt here against the current library — a decade needs its album count
 * to describe itself, and a genre needs the spelling you actually use. Deriving
 * either from the id alone gives a card that says "0 albums" or renames your
 * "Alternative Rock" to "Alternative-rock".
 */
async function typeFor(id: string, ctx: MixCtx): Promise<MixType | null> {
  const known = BY_ID.get(id)
  if (known) return known
  if (id.startsWith('decade-')) {
    const decade = Number(id.slice('decade-'.length))
    if (!Number.isFinite(decade)) return null
    const hit = ctx.shelf.decades.find((d) => d.decade === decade)
    return decadeType(decade, hit?.albums ?? 0)
  }
  if (id.startsWith('genre-')) {
    const slug = id.slice('genre-'.length)
    if (!slug) return null
    // A tag that has since fallen out of the catalogue still resolves; it just
    // builds nothing, and the page reports it as skipped rather than lying.
    const entry = (await genreIndex(ctx.library, ctx.now)).find((g) => g.slug === slug)
    return genreType(slug, entry?.label ?? labelFor(slug), entry)
  }
  return null
}

// --- the public surface -----------------------------------------------------

async function context(library: Library, now: number): Promise<MixCtx> {
  return { library, facts: await playFacts(now), shelf: shelfFacts(library), now }
}

/** A seed that changes daily: mixes hold still through a session but are
 *  different tomorrow, which is what makes them worth checking. */
function dailySeed(now: number): number {
  return Math.floor(now / DAY)
}

/**
 * The whole catalogue, with each entry marked available or not. The picker
 * shows the unavailable ones greyed rather than hiding them — "not enough
 * history yet" is information, and a list that changes size as you listen is
 * harder to learn than one that fills in.
 */
export async function getMixTypes(library: Library, now: number): Promise<MixTypeDTO[]> {
  const ctx = await context(library, now)
  const genres = await genreIndex(library, now)
  const types = [
    ...CATALOGUE,
    ...ctx.shelf.decades.map((d) => decadeType(d.decade, d.albums)),
    ...genres.map((g) => genreType(g.slug, g.label, g)),
  ]
  return types.map((t) => {
    const available = t.ready(ctx)
    return {
      id: t.id,
      title: t.title,
      subtitle: t.subtitle,
      group: t.group,
      available,
      ...(available ? {} : { reason: t.reason }),
    }
  })
}

// What a first-time visitor gets, in preference order. The first three that the
// library can actually produce win, so a brand-new install opens on shelf mixes
// and quietly graduates to history-based ones as the log fills in.
const DEFAULT_ORDER = [
  'twofer',
  'dormant',
  'deep-cuts',
  'fresh',
  'stack',
  'openers',
  'shuffle',
]

/** Ids to build when the client hasn't chosen — see DEFAULT_ORDER. */
function defaultIds(ctx: MixCtx): string[] {
  const out = DEFAULT_ORDER.filter((id) => BY_ID.get(id)?.ready(ctx)).slice(0, MAX_MIXES)
  if (out.length > 0) return out
  const decade = ctx.shelf.decades[0]
  return decade ? [`decade-${decade.decade}`] : []
}

/**
 * Build the chosen mixes. `ids` is the user's picks, capped at MAX_MIXES; an
 * empty list means "you decide", which is what a first visit sends.
 *
 * A mix that comes back short is reported as skipped rather than shown as an
 * empty card. Saying "not enough history for this one yet" is the difference
 * between a page that looks broken and a page that's waiting for you.
 */
export async function getMixes(
  library: Library,
  now: number,
  ids: string[] = [],
): Promise<{ mixes: Mix[]; skipped: SkippedMix[] }> {
  const ctx = await context(library, now)
  const chosen = ids.length > 0
  const wanted = (chosen ? ids : defaultIds(ctx)).slice(0, MAX_MIXES)
  const seed = dailySeed(now)

  const built = await Promise.all(
    wanted.map(async (id): Promise<Mix | SkippedMix> => {
      const type = await typeFor(id, ctx)
      if (!type) return { id, title: id, reason: 'No longer a kind of mix' }
      const tracks = await type.build(ctx, seed, new Set(), INITIAL)
      if (tracks.length < type.min) {
        return {
          id: type.id,
          title: type.title,
          // The type's own words when it knew it couldn't; otherwise it thought
          // it could and the shelf came up short anyway.
          reason: type.ready(ctx) ? 'Not enough tracks for it today' : type.reason,
        }
      }
      return {
        id: type.id,
        title: type.title,
        subtitle: type.subtitle,
        group: type.group,
        trackIds: tracks.map((t) => t.id),
        tracks,
      }
    }),
  )
  const mixes = built.filter((m): m is Mix => 'tracks' in m)
  // Only a deliberate choice is worth explaining. When the server picked, it
  // picked what it knew would work, and a gap is nobody's expectation.
  const skipped = chosen ? built.filter((m): m is SkippedMix => !('tracks' in m)) : []
  return { mixes, skipped }
}

/**
 * More tracks in the same theme, so a playing mix never runs dry. Excludes
 * what's already queued and moves the seed with each batch, so successive
 * top-ups don't repeat.
 *
 * Finite themes — deep cuts, the stack, one year ago — eventually return [] and
 * the mix simply ends. The others recycle across sessions (only the current
 * queue is excluded), so they're effectively endless. An unknown id gives [].
 */
export async function moreMixTracks(
  library: Library,
  mixId: string,
  now: number,
  excludeIds: string[],
): Promise<TrackDTO[]> {
  const ctx = await context(library, now)
  const type = await typeFor(mixId, ctx)
  if (!type) return []
  // Move the seed with the queue length so each top-up draws a different hand.
  const seed = dailySeed(now) + excludeIds.length * 31 + 1
  return type.build(ctx, seed, new Set(excludeIds), REFILL)
}
