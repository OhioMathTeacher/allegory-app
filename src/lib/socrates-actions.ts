/**
 * Parse Socrates messages for `playlist` action blocks and resolve the
 * proposed {artist, album, track} triples against the actual library.
 *
 * The "action protocol" is documented in `socrates-prompt.ts`. Socrates
 * emits fenced code blocks like:
 *   ```playlist
 *   { "name": "...", "tracks": [ { "artist": "...", "album": "...", "track": "..." } ] }
 *   ```
 * This module never executes anything by itself — it just extracts and
 * resolves. The UI does the actual creation + playback on user click.
 */
import type { Album, Artist, Track } from './types'

export interface ProposedTrack {
  artist: string
  album: string
  track: string
}

export interface PlaylistProposal {
  /** Suggested playlist name from Socrates. */
  name: string
  tracks: ProposedTrack[]
}

export interface ParsedMessage {
  /** Prose with playlist blocks removed; rendered as text in the bubble. */
  prose: string
  /** All playlist proposals found in the message, in document order. */
  proposals: PlaylistProposal[]
}

/** Best-effort JSON parse: strip `//` line comments and trailing commas so a
 *  near-miss block from a weak model still parses. Throws like JSON.parse if
 *  the body genuinely isn't JSON. */
function looseJsonParse(body: string): unknown {
  const cleaned = body
    .replace(/\/\/[^\n]*/g, '') // line comments
    .replace(/,\s*([}\]])/g, '$1') // trailing commas before } or ]
    .trim()
  return JSON.parse(cleaned)
}

/** Validate + coerce a parsed value into a PlaylistProposal, or null. Drops
 *  malformed individual tracks rather than rejecting the whole block. */
function asProposal(value: unknown): PlaylistProposal | null {
  if (!value || typeof value !== 'object') return null
  const p = value as Partial<PlaylistProposal>
  if (typeof p.name !== 'string' || !Array.isArray(p.tracks)) return null
  const tracks = p.tracks.filter(
    (t): t is ProposedTrack =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as ProposedTrack).artist === 'string' &&
      typeof (t as ProposedTrack).album === 'string' &&
      typeof (t as ProposedTrack).track === 'string',
  )
  if (tracks.length === 0) return null
  return { name: p.name, tracks }
}

/** Find the first balanced `{…}` object that mentions "tracks", returning its
 *  text and span. Brace-aware so a nested object doesn't end it early. Used to
 *  rescue a bare JSON proposal a model dumped into prose with no code fence. */
function extractTracksObject(s: string): { text: string; start: number; end: number } | null {
  const key = s.indexOf('"tracks"')
  if (key === -1) return null
  let start = s.lastIndexOf('{', key)
  while (start !== -1) {
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}') {
        depth--
        if (depth === 0) {
          const text = s.slice(start, i + 1)
          if (text.includes('"tracks"')) return { text, start, end: i + 1 }
          break // this object didn't enclose the key — try an earlier brace
        }
      }
    }
    start = s.lastIndexOf('{', start - 1)
  }
  return null
}

/**
 * Pull playlist proposals out of a Socrates message and return the surrounding
 * prose with them removed.
 *
 * Deliberately forgiving, because the whole feature dies on a strict parse:
 * weak / free models mis-tag the fence (```json), drop the tag entirely, add a
 * trailing comma, or dump raw JSON into the prose. We accept all of those — a
 * block only counts if it actually has the {name, tracks[]} shape, so genuine
 * code or quotes in the reply are left untouched in the prose.
 */
export function parseSocratesMessage(content: string): ParsedMessage {
  const proposals: PlaylistProposal[] = []

  // 1) Any fenced code block — `playlist`, `json`, or untagged. Try each body
  //    as a proposal; keep it only if it has the shape, else leave it in prose.
  const fence = /```[ \t]*[a-zA-Z]*\r?\n?([\s\S]*?)```/g
  let prose = content.replace(fence, (match, body: string) => {
    try {
      const prop = asProposal(looseJsonParse(body))
      if (prop) {
        proposals.push(prop)
        return ''
      }
    } catch {
      // Not a playlist block — fall through and keep it verbatim.
    }
    return match
  })

  // 2) No fenced proposal? A model may have dumped raw JSON straight into the
  //    prose. Rescue the first balanced object that carries a "tracks" array.
  if (proposals.length === 0) {
    const obj = extractTracksObject(prose)
    if (obj) {
      try {
        const prop = asProposal(looseJsonParse(obj.text))
        if (prop) {
          proposals.push(prop)
          prose = prose.slice(0, obj.start) + prose.slice(obj.end)
        }
      } catch {
        // leave the prose as-is
      }
    }
  }

  return { prose: prose.replace(/\n{3,}/g, '\n\n').trim(), proposals }
}

// --- resolver -----------------------------------------------------------

/** Normalise for matching: lowercase + strip separators, punctuation, "the". */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[\s_\-./&'":!?,()[\]]+/g, '')
}

export interface ResolvedTrack {
  proposed: ProposedTrack
  /** The matched library track if one was found, null otherwise. */
  resolved: Track | null
}

export interface ResolveContext {
  artists: Artist[]
  albums: Album[]
  /**
   * Fetch the tracks for a single album. The catalog only knows albums
   * by name; tracks are loaded lazily because there are thousands of
   * them and most aren't relevant to any one resolution call.
   */
  fetchAlbumTracks: (albumId: string) => Promise<Track[]>
}

/**
 * Resolve every proposed track to a library Track (or null). Groups
 * proposals by album so we fetch each album's tracks at most once even
 * if Socrates picked several from the same record.
 */
export async function resolvePlaylist(
  proposal: PlaylistProposal,
  ctx: ResolveContext,
): Promise<ResolvedTrack[]> {
  // Index artists + their albums.
  const artistByNorm = new Map<string, Artist>()
  for (const a of ctx.artists) artistByNorm.set(norm(a.name), a)

  const albumsByArtistId = new Map<string, Album[]>()
  for (const al of ctx.albums) {
    if (!al.artistId) continue
    const list = albumsByArtistId.get(al.artistId) ?? []
    list.push(al)
    albumsByArtistId.set(al.artistId, list)
  }

  // Walk each proposed track, resolve the album it lives on. Tracks are
  // fetched per album below.
  type WithAlbum = { proposed: ProposedTrack; album: Album | null }
  const withAlbum: WithAlbum[] = proposal.tracks.map((p) => {
    const artist = artistByNorm.get(norm(p.artist))
    if (!artist) return { proposed: p, album: null }
    const albums = albumsByArtistId.get(artist.id) ?? []
    const pNorm = norm(p.album)
    let album = albums.find((al) => norm(al.name) === pNorm) ?? null
    if (!album) {
      // Loose fall-back: "contains" match.
      album = albums.find((al) => norm(al.name).includes(pNorm) || pNorm.includes(norm(al.name))) ?? null
    }
    return { proposed: p, album }
  })

  // Fetch tracks for every album in play, once.
  const uniqueAlbumIds = [...new Set(withAlbum.map((w) => w.album?.id).filter((id): id is string => !!id))]
  const trackCache = new Map<string, Track[]>()
  await Promise.all(
    uniqueAlbumIds.map(async (id) => {
      try {
        const ts = await ctx.fetchAlbumTracks(id)
        trackCache.set(id, ts)
      } catch {
        trackCache.set(id, [])
      }
    }),
  )

  // Final resolution pass: find each proposed track by name in its album.
  return withAlbum.map(({ proposed, album }) => {
    if (!album) return { proposed, resolved: null }
    const tracks = trackCache.get(album.id) ?? []
    const tNorm = norm(proposed.track)
    let hit = tracks.find((t) => norm(t.name) === tNorm) ?? null
    if (!hit) {
      hit = tracks.find((t) => norm(t.name).includes(tNorm) || tNorm.includes(norm(t.name))) ?? null
    }
    return { proposed, resolved: hit }
  })
}
