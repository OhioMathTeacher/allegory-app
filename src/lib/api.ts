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
  SearchResults,
  Track,
} from './types'

async function getJson<T>(conn: Connection, path: string): Promise<T> {
  const res = await fetch(`${conn.serverUrl}${path}`)
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
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  const res = await fetch(`${conn.serverUrl}/song-context/${encodeURIComponent(trackId)}`)
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
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
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

/** Append tracks to an existing playlist. */
export async function addToPlaylist(
  conn: Connection,
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  await send(conn, 'POST', `/playlists/${playlistId}/items`, { trackIds })
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
  return `${conn.serverUrl}/art/${itemId}?size=${size}${tag ? `&t=${encodeURIComponent(tag)}` : ''}`
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
  return `${conn.serverUrl}/stream/${trackId}?can=${encodeURIComponent(playbackCaps())}`
}

// --- settings ---------------------------------------------------------------

export interface AppSettings {
  musicDir: string
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
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      // HTTP headers are ASCII; encode so non-ASCII (curly quotes,
      // accents, etc.) survive the trip.
      'X-Tsm-Path': encodeURIComponent(relPath),
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
