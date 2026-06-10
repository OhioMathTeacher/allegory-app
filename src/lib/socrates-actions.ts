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

/**
 * Extract every ```playlist``` JSON block in `content`, return the
 * surrounding prose with those blocks removed. Bad JSON is skipped
 * silently — better to lose a card than corrupt the whole message.
 */
export function parseSocratesMessage(content: string): ParsedMessage {
  const proposals: PlaylistProposal[] = []
  // Match fenced blocks with `playlist` as the language tag. The leading
  // newline tolerance lets the block sit anywhere in the message.
  const re = /```playlist\s*([\s\S]*?)```/g
  const prose = content.replace(re, (_match, body: string) => {
    try {
      const parsed = JSON.parse(body) as Partial<PlaylistProposal>
      if (
        typeof parsed.name === 'string' &&
        Array.isArray(parsed.tracks) &&
        parsed.tracks.every(
          (t) =>
            t &&
            typeof t === 'object' &&
            typeof (t as ProposedTrack).artist === 'string' &&
            typeof (t as ProposedTrack).album === 'string' &&
            typeof (t as ProposedTrack).track === 'string',
        )
      ) {
        proposals.push({ name: parsed.name, tracks: parsed.tracks as ProposedTrack[] })
      }
    } catch {
      // Malformed JSON — drop the block silently.
    }
    return ''
  })
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
