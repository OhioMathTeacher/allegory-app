/**
 * The handle every screen passes to the API helpers. Allegory has no remote
 * server or login, so this is a constant — `serverUrl` is the local `/api`
 * base, and `userId` is kept only so React Query cache keys stay stable.
 */
export interface Connection {
  serverUrl: string
  userId: string
  userName: string
}

export interface Album {
  id: string
  name: string
  artist: string
  artistId?: string
  year?: number
  trackCount?: number
  imageTag?: string
  // When this album's newest file landed on disk (ms epoch).
  addedAt?: number
}

export interface Artist {
  id: string
  name: string
  imageTag?: string
}

export interface Playlist {
  id: string
  name: string
  trackCount?: number
  /** Entries repeating a track already listed above them, counted server-side
   *  over every `.m3u` line — including ones with no file on disk, which the
   *  tracks endpoint leaves out. */
  duplicateCount?: number
  imageTag?: string
}

/** A file in the playlist folder that the server did not load, and why. */
export interface SkippedPlaylistFile {
  name: string
  reason: string
}

/** What the server's playlist folder holds, including what it skipped. */
export interface PlaylistsReport {
  dir: string
  skipped: SkippedPlaylistFile[]
  error?: string
}

/** What an album-merge did, for the confirmation message. */
export interface MergeResult {
  moved: number
  renamed: number
  foldersRemoved: number
  foldersKept: number
}

export interface SearchResults {
  /** Names of top-level music-dir folders with no audio in them yet. */
  placeholders: string[]
  albums: Album[]
  artists: Artist[]
  tracks: Track[]
}

export interface Track {
  id: string
  name: string
  artist: string
  artistId?: string
  album: string
  albumId?: string
  albumImageTag?: string
  index?: number
  discNumber?: number
  durationTicks: number
  /** The entry's id within a playlist — set only for tracks loaded from
   *  a playlist, and needed to remove that specific entry. */
  playlistItemId?: string
  // When this track's file landed on disk (ms epoch).
  addedAt?: number
}
