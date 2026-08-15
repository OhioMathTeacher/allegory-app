/**
 * The client side of Allegory's local API. Every function here calls the
 * `/api/*` endpoints served by the allegory-library Vite plugin (server/), which
 * scans the music directory on disk. The function names and signatures are
 * unchanged from the old Jellyfin client, so the screens didn't have to.
 */
import type {
  Album,
  Artist,
  Connection,
  MergeResult,
  Playlist,
  PlaylistsReport,
  SearchResults,
  Track,
} from './types'
import { authHeaders, withKey } from './auth'

async function getJson<T>(conn: Connection, path: string): Promise<T> {
  const res = await fetch(`${conn.serverUrl}${path}`, {
    credentials: 'include',
    headers: authHeaders(conn.serverUrl),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<T>
}

/** Issues a request that surfaces the server's `{ error }` message on failure. */
async function send<T>(
  conn: Connection,
  method: 'POST' | 'DELETE' | 'PATCH' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${conn.serverUrl}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(conn.serverUrl),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // no JSON body — keep the generic message
    }
    throw new Error(message)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function getAlbums(conn: Connection): Promise<Album[]> {
  return getJson<Album[]>(conn, '/albums')
}

/** Merge several albums into one, physically, on disk. */
export async function combineAlbums(
  conn: Connection,
  targetId: string,
  sourceIds: string[],
): Promise<MergeResult> {
  return send<MergeResult>(conn, 'POST', '/albums/combine', {
    targetId,
    sourceIds,
  })
}

export interface AlbumEdits {
  name?: string
  artist?: string
  year?: number | string
}

export interface AlbumEditResult {
  tracksWritten: number
  folderRenamed: boolean
  newDir: string
}

/** Write album name / artist / year to every track and rename the folder. */
export async function editAlbumMetadata(
  conn: Connection,
  albumId: string,
  edits: AlbumEdits,
): Promise<AlbumEditResult> {
  return send<AlbumEditResult>(conn, 'POST', `/albums/${albumId}/metadata`, edits)
}

/** The curated, editable common tag fields shown per track. */
export interface CommonTags {
  title: string
  artist: string
  album: string
  albumartist: string
  year: string
  trackNo: string
  discNo: string
  genre: string
  composer: string
  comment: string
}

/** One track's full tag picture as returned by the detailed editor's loader. */
export interface TrackTags {
  trackId: string
  file: string
  format?: string
  common: CommonTags
  /** Raw container-native frames, read-only. */
  native: Array<{ id: string; value: string }>
  error?: string
}

export interface AlbumTags {
  album: { id: string; name: string; artist: string; year?: number }
  tracks: TrackTags[]
}

/** Album-wide + per-track tag edits sent when saving the detailed editor. */
export interface AlbumTagEdits {
  album?: { name?: string; artist?: string; year?: string; genre?: string }
  tracks?: Array<{ trackId: string } & Partial<CommonTags>>
}

export interface AlbumTagSaveResult {
  tracksWritten: number
  folderRenamed: boolean
  newDir: string
}

/** Read every editable field (plus raw native tags) for an album's tracks. */
export async function getAlbumTags(
  conn: Connection,
  albumId: string,
): Promise<AlbumTags> {
  return getJson<AlbumTags>(conn, `/albums/${albumId}/tags`)
}

/** Save album-wide and per-track tag edits in one batch. */
export async function saveAlbumTags(
  conn: Connection,
  albumId: string,
  edits: AlbumTagEdits,
): Promise<AlbumTagSaveResult> {
  return send<AlbumTagSaveResult>(conn, 'POST', `/albums/${albumId}/tags`, edits)
}

/** State of the local checkout relative to the published latest. */
export interface UpdateStatus {
  /** Unique to this server process — changes only on an actual restart. */
  bootId?: string
  current: string
  currentMessage: string
  /** Installed version from package.json, e.g. "1.8.1". '' if unreadable. */
  currentVersion?: string
  latest: string
  latestMessage: string
  /** Published version from origin/main's package.json. '' if unreadable. */
  latestVersion?: string
  ahead: number
  behind: number
  available: boolean
  fetchOk: boolean
  fetchError?: string
  /** Set when the install can't self-update (e.g. not a git checkout). */
  error?: string
}

/** Check whether a newer version is published (server runs `git fetch`). */
export async function getUpdateStatus(conn: Connection): Promise<UpdateStatus> {
  return getJson<UpdateStatus>(conn, '/update/status')
}

/**
 * Apply the latest update and restart the server. Returns as soon as the
 * (detached) updater is launched; the server will go down and come back on the
 * same URL, so the caller should poll and reload.
 */
export async function applyUpdate(
  conn: Connection,
): Promise<{ ok: boolean; restarting: boolean }> {
  return send<{ ok: boolean; restarting: boolean }>(conn, 'POST', '/update/apply', {})
}

/** Search tracks, albums and artists by name. */
export async function search(
  conn: Connection,
  query: string,
): Promise<SearchResults> {
  return getJson<SearchResults>(conn, `/search?q=${encodeURIComponent(query)}`)
}

/** Album artists in the library. */
export async function getArtists(conn: Connection): Promise<Artist[]> {
  return getJson<Artist[]>(conn, '/artists')
}

/** Albums credited to one artist. */
export async function getArtistAlbums(
  conn: Connection,
  artistId: string,
): Promise<Album[]> {
  return getJson<Album[]>(conn, `/artists/${artistId}/albums`)
}

export async function getAlbumTracks(
  conn: Connection,
  albumId: string,
): Promise<Track[]> {
  return getJson<Track[]>(conn, `/albums/${albumId}/tracks`)
}

/** Every track by one artist, in album order. */
export async function getArtistTracks(
  conn: Connection,
  artistId: string,
): Promise<Track[]> {
  return getJson<Track[]>(conn, `/artists/${artistId}/tracks`)
}

export interface RelatedArtist {
  name: string
  mbid?: string
  /** Set when this artist is in the library — the card links to their page. */
  artistId?: string
  /** The library's own spelling, when matched — the match is fuzzy, so this
   *  can differ from `name` ("Dio" vs "Dio, Ronnie James"). */
  libraryName?: string
  /** Truthy when the matched library artist has a cover image. */
  imageTag?: string
}

export interface ArtistRelated {
  genres: string[]
  related: RelatedArtist[]
  /** False when no Last.fm key is configured — the UI prompts to add one. */
  configured: boolean
  /** Epoch ms the data was fetched, or null when it never has been. */
  fetchedAt: number | null
}

/**
 * Recently-played songs + albums for one artist — the same shape and dedup as
 * the global Recently tab, narrowed to this artist's plays.
 */
export async function getArtistRecentlyPlayed(
  conn: Connection,
  artistId: string,
): Promise<RecentResult> {
  return getJson<RecentResult>(conn, `/artists/${artistId}/recently-played`)
}

/** One of an artist's best-known songs, matched against the library. */
export interface PopularTrack {
  name: string
  /** Last.fm listener count — a rough proxy for how well known it is. */
  listeners?: number
  /** Set when the song is in the library; the row plays it. */
  trackId?: string
  /** The library's own title, which can differ in punctuation or casing. */
  libraryTitle?: string
}

/**
 * An artist's best-known songs. Answers "where do I start?" for an artist you
 * own but have never played — which a personal play history can't. Served from
 * the per-artist sidecar, so it's one fetch per artist and offline afterwards.
 */
export async function getArtistTopTracks(
  conn: Connection,
  artistId: string,
): Promise<{ tracks: PopularTrack[]; configured: boolean }> {
  return getJson(conn, `/artists/${artistId}/top-tracks`)
}

/**
 * Replace an artist's tag list with exactly `tags`. The server splits it back
 * into "added by hand" and "Last.fm genres the user dropped", so edits survive
 * the next enrichment refresh. Returns the list as stored.
 */
export async function setArtistTags(
  conn: Connection,
  artistId: string,
  tags: string[],
): Promise<string[]> {
  const data = await send<{ ok: true; genres: string[] }>(
    conn,
    'PUT',
    `/artists/${artistId}/tags`,
    { tags },
  )
  return data.genres
}

/**
 * Related artists + genres for one artist. Served from the per-artist sidecar
 * cache; pass `refresh` to force a re-fetch from Last.fm.
 */
export async function getArtistRelated(
  conn: Connection,
  artistId: string,
  refresh = false,
): Promise<ArtistRelated> {
  return getJson<ArtistRelated>(
    conn,
    `/artists/${artistId}/related${refresh ? '?refresh=1' : ''}`,
  )
}

/** The curated sidecar for a track ("Cliff's Notes for the model"). */
export interface SongContext {
  /** The curator's own notes (.md/.txt) — safe to send to any provider. */
  notes: string | null
  /** Verbatim lyrics (.lrc, timings stripped) — local provider only. */
  lyrics: string | null
}

/**
 * Fetch the per-song curation sidecar, or `null` when the track has none
 * (a 404 from the server — the common, graceful case, not an error).
 */
export async function getSongContext(
  conn: Connection,
  trackId: string,
): Promise<SongContext | null> {
  const res = await fetch(`${conn.serverUrl}/song-context/${encodeURIComponent(trackId)}`, {
    credentials: 'include',
    headers: authHeaders(conn.serverUrl),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json() as Promise<SongContext>
}

/** The track's notes exactly as stored on disk, for editing ("" when none). */
export async function getSongNotesRaw(conn: Connection, trackId: string): Promise<string> {
  const { notes } = await getJson<{ notes: string }>(
    conn,
    `/song-context/${encodeURIComponent(trackId)}?raw=1`,
  )
  return notes
}

/** Save (or, on empty text, clear) a track's notes. Returns whether notes remain. */
export async function saveSongNotes(
  conn: Connection,
  trackId: string,
  notes: string,
): Promise<boolean> {
  const { hasNotes } = await send<{ ok: true; hasNotes: boolean }>(
    conn,
    'PUT',
    `/song-context/${encodeURIComponent(trackId)}`,
    { notes },
  )
  return hasNotes
}

/** Track ids that currently have a notes sidecar — for the list pencils. */
export async function getSongNotesIndex(conn: Connection): Promise<string[]> {
  const { trackIds } = await getJson<{ trackIds: string[] }>(conn, '/song-notes')
  return trackIds
}

/** The full tracks that have a notes sidecar — the smart "Notes" playlist. */
export async function getSongNotesTracks(conn: Connection): Promise<Track[]> {
  return getJson<Track[]>(conn, '/song-notes/tracks')
}

export interface ArtistRenameResult {
  ok: true
  tracksRewritten: number
  folderRenamed: boolean
  /** Set if the artist's folder was merged into an existing folder. */
  mergedInto?: string
}

/**
 * Rename an artist for real: server-side this rewrites the artist /
 * album_artist tags on every track and renames (or merges) the artist's
 * folder, then kicks off a library rescan. Can be slow on large
 * discographies — the request blocks until tags + folder moves complete.
 */
export async function renameArtist(
  conn: Connection,
  artistId: string,
  name: string,
): Promise<ArtistRenameResult> {
  return send<ArtistRenameResult>(conn, 'PATCH', `/artists/${artistId}`, { name })
}

/** Upload and set an artist's cover image. */
export async function uploadArtistImage(
  conn: Connection,
  artistId: string,
  file: File,
): Promise<void> {
  await uploadImage(conn, `/artists/${artistId}/image`, file)
}

/** Upload and set an album's cover image. */
export async function uploadAlbumImage(
  conn: Connection,
  albumId: string,
  file: File,
): Promise<void> {
  await uploadImage(conn, `/albums/${albumId}/image`, file)
}

/** Upload and set a playlist's cover image. */
export async function uploadPlaylistImage(
  conn: Connection,
  playlistId: string,
  file: File,
): Promise<void> {
  await uploadImage(conn, `/playlists/${playlistId}/image`, file)
}

async function uploadImage(
  conn: Connection,
  path: string,
  file: File,
): Promise<void> {
  const res = await fetch(`${conn.serverUrl}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      ...authHeaders(conn.serverUrl),
    },
    body: file,
  })
  if (!res.ok) {
    let message = `Upload failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // no JSON body
    }
    throw new Error(message)
  }
}

/**
 * Set artwork from a remote URL. The server fetches the image (avoiding the
 * browser's CORS restrictions), then resizes and stores it like an upload.
 * The same image endpoints accept either raw bytes or a JSON `{ url }` body.
 */
async function uploadImageFromUrl(
  conn: Connection,
  path: string,
  url: string,
): Promise<void> {
  await send(conn, 'POST', path, { url })
}

/** Set an album's cover from a remote image URL. */
export async function uploadAlbumImageFromUrl(
  conn: Connection,
  albumId: string,
  url: string,
): Promise<void> {
  await uploadImageFromUrl(conn, `/albums/${albumId}/image`, url)
}

/** Set an artist's cover from a remote image URL. */
export async function uploadArtistImageFromUrl(
  conn: Connection,
  artistId: string,
  url: string,
): Promise<void> {
  await uploadImageFromUrl(conn, `/artists/${artistId}/image`, url)
}

/** Set a playlist's cover from a remote image URL. */
export async function uploadPlaylistImageFromUrl(
  conn: Connection,
  playlistId: string,
  url: string,
): Promise<void> {
  await uploadImageFromUrl(conn, `/playlists/${playlistId}/image`, url)
}

/** The user's playlists. */
export async function getPlaylists(conn: Connection): Promise<Playlist[]> {
  return getJson<Playlist[]>(conn, '/playlists')
}

/**
 * What the server's playlist folder holds beyond the playlists themselves —
 * files it skipped, and why. Fetched alongside the list so the UI can say
 * "seven files here were not loaded" instead of quietly showing three.
 */
export async function getPlaylistsReport(conn: Connection): Promise<PlaylistsReport> {
  return getJson<PlaylistsReport>(conn, '/playlists/report')
}

/** The tracks of one playlist, in playlist order. */
export async function getPlaylistTracks(
  conn: Connection,
  playlistId: string,
): Promise<Track[]> {
  return getJson<Track[]>(conn, `/playlists/${playlistId}/tracks`)
}

/** Create a playlist containing the given tracks; returns its id. */
export async function createPlaylist(
  conn: Connection,
  name: string,
  trackIds: string[],
): Promise<string> {
  const data = await send<{ id?: string }>(conn, 'POST', '/playlists', {
    name,
    trackIds,
  })
  return data?.id ?? ''
}

/**
 * Append tracks to an existing playlist. Tracks already in it are skipped and
 * counted in `skipped` rather than added a second time; pass `allowDuplicates`
 * to add them regardless.
 */
export async function addToPlaylist(
  conn: Connection,
  playlistId: string,
  trackIds: string[],
  allowDuplicates = false,
): Promise<{ added: number; skipped: number }> {
  const data = await send<{ added?: number; skipped?: number }>(
    conn,
    'POST',
    `/playlists/${playlistId}/items`,
    { trackIds, allowDuplicates },
  )
  return { added: data?.added ?? 0, skipped: data?.skipped ?? 0 }
}

/**
 * Drop entries that repeat a track already listed above them, keeping the
 * first of each. Returns how many entries were removed; the tracks themselves
 * stay in the library.
 */
export async function removePlaylistDuplicates(
  conn: Connection,
  playlistId: string,
): Promise<number> {
  const data = await send<{ removed?: number }>(
    conn,
    'POST',
    `/playlists/${playlistId}/deduplicate`,
  )
  return data?.removed ?? 0
}

/**
 * Remove entries from a playlist. `entryIds` are the per-occurrence ids from
 * Track.playlistItemId (a track can appear more than once).
 */
export async function removeFromPlaylist(
  conn: Connection,
  playlistId: string,
  entryIds: string[],
): Promise<void> {
  const query = encodeURIComponent(entryIds.join(','))
  await send(conn, 'DELETE', `/playlists/${playlistId}/items?entryIds=${query}`)
}

/** Permanently delete a playlist. */
export async function deletePlaylist(
  conn: Connection,
  playlistId: string,
): Promise<void> {
  await send(conn, 'DELETE', `/playlists/${playlistId}`)
}

/** Rename a playlist. */
export async function renamePlaylist(
  conn: Connection,
  playlistId: string,
  name: string,
): Promise<void> {
  await send(conn, 'POST', `/playlists/${playlistId}/rename`, { name })
}

/** Move a track within a playlist from one position to another. */
export async function movePlaylistTrack(
  conn: Connection,
  playlistId: string,
  from: number,
  to: number,
): Promise<void> {
  await send(conn, 'POST', `/playlists/${playlistId}/move`, { from, to })
}

/** Create a new playlist from the tracks of several existing playlists. */
export async function combinePlaylists(
  conn: Connection,
  name: string,
  sourceIds: string[],
): Promise<string> {
  const data = await send<{ id?: string }>(conn, 'POST', '/playlists/combine', {
    name,
    sourceIds,
  })
  return data?.id ?? ''
}

/** Re-scan the music directory for newly added (or removed) files. */
export async function refreshLibrary(conn: Connection): Promise<void> {
  await send(conn, 'POST', '/rescan')
}

// The "Recently" panel pulls two of these: recently-added and recently-played.
export interface RecentResult {
  albums: Album[]
  tracks: Track[]
}

export async function getRecentlyAdded(conn: Connection): Promise<RecentResult> {
  return getJson<RecentResult>(conn, '/recent/added')
}

export async function getRecentlyPlayed(conn: Connection): Promise<RecentResult> {
  return getJson<RecentResult>(conn, '/recent/played')
}

// --- discover ---------------------------------------------------------------

/** Time windows the Discover page can reason over. */
export type ListenWindow = 'today' | '7d' | '30d' | '90d' | 'all'

export interface Mix {
  id: string
  title: string
  subtitle: string
  trackIds: string[]
  tracks: Track[]
}

export interface Recommendation {
  artistId: string
  name: string
  imageTag?: string
  reason: string
}

export interface MissingAlbum {
  artistId: string
  artist: string
  album: string
  playcount?: number
}

/** Generated mixes. Computed locally on the server — works offline. */
export async function getMixes(conn: Connection): Promise<Mix[]> {
  const data = await getJson<{ mixes: Mix[] }>(conn, '/discover/mixes')
  return data.mixes
}

/** More tracks in a mix's theme, so a playing mix never runs dry. `exclude` is
 *  the current queue's track ids. Returns [] when the theme is exhausted. */
export async function getMoreMixTracks(
  conn: Connection,
  mixId: string,
  exclude: string[],
): Promise<Track[]> {
  const data = await send<{ tracks: Track[] }>(conn, 'POST', '/discover/mixes/more', {
    mixId,
    exclude,
  })
  return data.tracks
}

/** Artists in your library worth playing next, scored over a listening window. */
export async function getRecommendations(
  conn: Connection,
  window: ListenWindow,
): Promise<{ window: ListenWindow; basis: number; items: Recommendation[] }> {
  return getJson(conn, `/discover/recommendations?window=${window}`)
}

/** Well-known albums by artists you own — that you don't own. */
export async function getMissingAlbums(
  conn: Connection,
): Promise<{ configured: boolean; items: MissingAlbum[] }> {
  return getJson(conn, '/discover/missing-albums')
}

export interface ListenCount<T> {
  item: T
  plays: number
  lastAt: number
}

export interface ListenStats {
  window: ListenWindow
  totalPlays: number
  since: number
  /** Epoch ms of the oldest play on record, or null when nothing is logged. */
  logStartsAt: number | null
  topArtists: ListenCount<{ name: string; artistId?: string }>[]
  topAlbums: ListenCount<{ name: string; artist: string; albumId?: string }>[]
  topTracks: ListenCount<{ title: string; artist: string; trackId: string }>[]
}

/** What you've actually been playing over a window, from the permanent log. */
export async function getListenStats(
  conn: Connection,
  window: ListenWindow,
): Promise<ListenStats> {
  return getJson<ListenStats>(conn, `/listen/stats?window=${window}`)
}

/** Report that a track was played. Best-effort — call sites swallow failures. */
export async function reportPlay(conn: Connection, trackId: string): Promise<void> {
  await send(conn, 'POST', '/recent/played', { trackId })
}

/**
 * Whether a library scan is still running: `0` while scanning, `null` once
 * idle. (Allegory scans are a fast directory walk, so there is no percentage.)
 */
export async function getLibraryScanProgress(
  conn: Connection,
): Promise<number | null> {
  const status = await getJson<{ scanning: boolean }>(conn, '/status')
  return status.scanning ? 0 : null
}

export function albumImageUrl(
  conn: Connection,
  itemId: string,
  tag: string | undefined,
  size = 400,
): string {
  // Include the tag so the URL changes when the art changes (e.g. a re-uploaded
  // playlist cover) — otherwise the long-cached old image sticks across reloads.
  return withKey(
    `${conn.serverUrl}/art/${itemId}?size=${size}${tag ? `&t=${encodeURIComponent(tag)}` : ''}`,
    conn.serverUrl,
  )
}

/**
 * A portrait for an artist that isn't in the library, by name. The server
 * fetches, resizes and caches it; a 404 means there's no picture, which the
 * caller should treat as "show the placeholder".
 */
export function artistPortraitUrl(
  conn: Connection,
  name: string,
  size = 220,
): string {
  return `${conn.serverUrl}/portrait?name=${encodeURIComponent(name)}&size=${size}`
}

// --- "go hear this" links ---------------------------------------------------
// None of these need a key or an API call; they're plain search URLs. Which
// service to point at depends on what's being linked, and the two cases differ:
//
//   an ARTIST we don't own   often independent — Bandcamp is where you can
//                            actually hear them AND pay them directly
//   an ALBUM we don't own    surfaced because it's well known, which in
//                            practice means major-label back catalogue that
//                            isn't on Bandcamp at all
//
// So artists get Bandcamp first, records get streaming first, and both get a
// fallback so a miss on one service isn't a dead end.

/** Bandcamp's artists-&-labels tab. `item_type=b` is the artist filter — do
 *  NOT use it for an album query; it will match nothing. */
export function bandcampArtistUrl(name: string): string {
  return `https://bandcamp.com/search?q=${encodeURIComponent(name)}&item_type=b`
}

export function spotifySearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`
}

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
}

export function trackImageUrl(conn: Connection, track: Track, size = 400): string {
  return albumImageUrl(conn, track.albumId ?? track.id, undefined, size)
}

/**
 * Which not-universally-supported audio formats can THIS browser decode? We
 * probe once with a throwaway <audio> element and memoise the result as a comma
 * list of tokens (matching the server's RISKY_FORMAT map). The server transcodes
 * any track whose format isn't on this list — so Safari, which can't play Ogg
 * Vorbis/Opus, gets an AAC transcode while Chrome/Firefox get the original.
 */
let capsParam: string | null = null
function playbackCaps(): string {
  if (capsParam !== null) return capsParam
  if (typeof document === 'undefined') {
    capsParam = ''
    return capsParam
  }
  const probe = document.createElement('audio')
  // [token, MIME to test]. canPlayType returns '' when it can't play the type.
  const RISKY: ReadonlyArray<[string, string]> = [
    ['ogg', 'audio/ogg; codecs="vorbis"'],
    ['opus', 'audio/ogg; codecs="opus"'],
    ['flac', 'audio/flac'],
    ['wav', 'audio/wav'],
    ['aiff', 'audio/aiff'],
    ['wma', 'audio/x-ms-wma'],
  ]
  capsParam = RISKY.filter(([, mime]) => probe.canPlayType(mime) !== '')
    .map(([token]) => token)
    .join(',')
  return capsParam
}

export function audioStreamUrl(conn: Connection, trackId: string): string {
  // `withKey` is a no-op same-origin (the cookie covers `<audio src>`); it only
  // adds `?k=` when this device is streaming from another island.
  return withKey(
    `${conn.serverUrl}/stream/${trackId}?can=${encodeURIComponent(playbackCaps())}`,
    conn.serverUrl,
  )
}

// --- settings ---------------------------------------------------------------

export interface AppSettings {
  musicDir: string
  /**
   * Whether a Last.fm key is saved. The key itself never comes back over the
   * wire — the server keeps it and uses it for enrichment. Writing a new one
   * still works; you just can't read the old one out again.
   */
  hasLastfmKey?: boolean
}

export interface PathValidation {
  ok: boolean
  error?: string
  artistCount?: number
}

export async function getSettings(conn: Connection): Promise<AppSettings> {
  return getJson<AppSettings>(conn, '/settings')
}

export async function updateSettings(
  conn: Connection,
  musicDir: string,
): Promise<{ ok: true; musicDir: string; artistCount?: number }> {
  return send(conn, 'POST', '/settings', { musicDir })
}

/** Save (or clear) the Last.fm API key without touching the music dir. */
export async function updateLastfmKey(
  conn: Connection,
  lastfmApiKey: string,
): Promise<{ ok: true }> {
  return send(conn, 'POST', '/settings', { lastfmApiKey })
}

export async function validateMusicDir(
  conn: Connection,
  musicDir: string,
): Promise<PathValidation> {
  return send<PathValidation>(conn, 'POST', '/settings/validate', { musicDir })
}

export interface UploadResult {
  ok: true
  written: string
  skipped?: boolean
}

/**
 * Upload one file into the music library. `relPath` is preserved on disk
 * (e.g., "Pearl Jam/Ten/01 Once.mp3"). The server refuses to overwrite
 * existing files; check `skipped` on the response.
 */
export async function uploadMusicFile(
  conn: Connection,
  relPath: string,
  file: File,
): Promise<UploadResult> {
  const res = await fetch(`${conn.serverUrl}/upload`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      // HTTP headers are ASCII; encode so non-ASCII (curly quotes,
      // accents, etc.) survive the trip.
      'X-Tsm-Path': encodeURIComponent(relPath),
      ...authHeaders(conn.serverUrl),
    },
    body: file,
  })
  if (!res.ok) {
    let message = `Upload failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // no JSON body
    }
    throw new Error(message)
  }
  return (await res.json()) as UploadResult
}

export interface FolderEntry {
  name: string
  path: string
}

export interface FolderListing {
  path: string
  parent: string | null
  entries: FolderEntry[]
  shortcuts: FolderEntry[]
}

/** List the immediate subdirectories of a server-side path. */
export async function browseFolders(
  conn: Connection,
  path?: string,
): Promise<FolderListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return getJson<FolderListing>(conn, `/fs/browse${q}`)
}
