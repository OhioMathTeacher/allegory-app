/**
 * Library scanner — turns a music directory on disk into an in-memory index
 * of artists, albums and tracks.
 *
 * The directory is expected to be laid out as `Artist/Album/NN Title.ext`
 * (CD1/CD2 sub-folders are folded back into their album).
 *
 * Grouping is deliberately split between the two sources of truth:
 *   - ARTIST comes from the top-level folder name. Per-track artist tags are
 *     too dirty to group on (see the note further down).
 *   - ALBUM NAME comes from the tag, falling back to the folder name.
 * Header tags are therefore read at scan time (cached by path+mtime+size).
 * The heavier per-track tags — duration, disc number — stay lazy and are read
 * the first time an album or playlist is opened.
 */
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { analyzeArtists, type CleanupArtist, type CleanupReport } from './cleanup.ts'

const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.oga',
  '.wav', '.aac', '.wma', '.aiff', '.aif', '.alac',
])
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']

/** Folder where Allegory keeps its `.m3u` playlists; excluded from the scan. */
export const PLAYLISTS_DIRNAME = 'Playlists'

/**
 * Subfolder names that should be folded back into their parent album. Covers:
 *   - "CD1", "CD 1", "CD.1", "CD_1", "CD-1"
 *   - "Disc 2", "Disk2"
 *   - "CD_7243…" (CD with catalog number — common rip artifact)
 *   - "1", "2", "3"  (purely numeric — the most-common 2-disc layout)
 */
const CD_SUBDIR = /^(?:(?:cd|dis[ck])[\s._-]*\d+|\d+)$|^(?:cd|dis[ck])[\s._-]*\d+/i
const TRACK_PREFIX = /^\s*(\d{1,3})\s*[.\-_)]*\s+/

function id(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

// Characters that should never appear in a displayed name: C0/C1 control
// codes, zero-width marks, the BOM, and the Private-Use Area (U+E000–U+F8FF) —
// which is how macOS / iTunes smuggle filesystem-illegal punctuation like
// `: ? "` onto disk (e.g. a folder that reads "Melvins" is really "Melvins<F028>").
// eslint-disable-next-line no-control-regex
const JUNK_CHARS = /[\x00-\x1f\x7f-\x9f\u200b-\u200d\ufeff\ue000-\uf8ff]/g

/** Strip junk characters from a name and collapse the leftover whitespace. */
function cleanName(s: string | undefined | null): string {
  if (!s) return ''
  return s.replace(JUNK_CHARS, '').replace(/\s{2,}/g, ' ').trim()
}

/** Header-level tags read at scan time (no duration — that stays lazy). */
interface ScanTag {
  mtimeMs: number
  size: number
  artist?: string
  albumartist?: string
  album?: string
  title?: string
  year?: number
  trackNo?: number
  discNo?: number
  /** Genre frame, split into values. Drives the genre mixes on Discover. */
  genres?: string[]
}

// Bumped when ScanTag grows a field, so cached entries written before it
// existed are re-read instead of being trusted forever — mtime and size can't
// notice that we started asking a new question of the same file.
const TAG_CACHE_VERSION = 2

/** The tag cache as it sits on disk. */
interface TagCacheFile {
  version: number
  files: Record<string, ScanTag>
}

/** Read just the tag header for one file (fast — skips the audio + covers). */
async function readHeaderTags(file: string): Promise<Omit<ScanTag, 'mtimeMs' | 'size'>> {
  try {
    const mm = await import('music-metadata')
    const md = await mm.parseFile(file, { duration: false, skipCovers: true })
    return {
      artist: md.common.artist?.trim() || undefined,
      albumartist: md.common.albumartist?.trim() || undefined,
      album: md.common.album?.trim() || undefined,
      title: md.common.title?.trim() || undefined,
      year: md.common.year ?? undefined,
      trackNo: md.common.track?.no ?? undefined,
      discNo: md.common.disk?.no ?? undefined,
      genres: splitGenres(md.common.genre),
    }
  } catch {
    return {}
  }
}

/**
 * A genre frame's values. music-metadata already hands back an array for
 * properly multi-valued frames; the split picks up the players that write
 * "Rock; Live" into one.
 *
 * Only the semicolon splits. Comma and slash are separators in some files and
 * part of the name in others — "Folk, World, & Country" and "R&B/Soul" are
 * single genres people actually use, and inventing three tags out of one is
 * worse than missing a split.
 */
function splitGenres(raw: string[] | undefined): string[] | undefined {
  if (!raw || raw.length === 0) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    for (const part of value.split(';')) {
      const name = cleanName(part)
      const key = name.toLowerCase()
      if (!name || seen.has(key)) continue
      seen.add(key)
      out.push(name)
    }
  }
  return out.length > 0 ? out : undefined
}

/** Parse "09 Cryin'.mp3" → { num: 9, title: "Cryin'" }. */
function parseFilename(file: string): { num?: number; title: string } {
  const stem = file.slice(0, file.length - extname(file).length)
  const m = TRACK_PREFIX.exec(stem)
  if (m) return { num: Number(m[1]), title: stem.slice(m[0].length).trim() || stem }
  return { title: stem }
}

/** Pick the most cover-like image from a directory's image files. */
function bestArt(images: string[]): string | null {
  if (images.length === 0) return null
  const rank = (p: string): number => {
    const name = basename(p).toLowerCase()
    if (name.startsWith('cover')) return 0
    if (name.startsWith('folder')) return 1
    if (name.startsWith('front')) return 2
    if (name.startsWith('album')) return 3
    if (name.startsWith('poster')) return 4
    // backdrop / banner / logo / fanart / disc art make poor square covers
    if (/^(backdrop|banner|logo|fanart|disc|cdart|clearart)/.test(name)) return 100
    return 50
  }
  return [...images].sort((a, b) => rank(a) - rank(b))[0]
}

export interface ScannedTrack {
  id: string
  path: string
  fileTitle: string
  fileNum?: number
  albumId: string
  artistId: string
  // When the file landed on disk (ms epoch) — drives "recently added".
  mtimeMs: number
  // Tag values captured at scan time (names already cleaned).
  tagTitle?: string
  tagArtist?: string
  tagAlbum?: string
  tagTrackNo?: number
  tagDiscNo?: number
  /** Genre tags on this file, as written. */
  genres?: string[]
}

export interface ScannedAlbum {
  id: string
  name: string
  artist: string
  artistId: string
  year?: number
  dir: string
  artPath: string | null
  trackIds: string[]
  /** Every genre tag across the album's files, deduped. A record tagged
   *  "Rock; Live" on some songs and "Rock" on others counts as both. */
  genres: string[]
  // Newest track mtime in the album (ms epoch) — drives "recently added".
  addedAt?: number
}

export interface ScannedArtist {
  id: string
  name: string
  dir: string
  artPath: string | null
  albumIds: string[]
}

/** A track as sent to the browser — matches the client's `Track` type. */
export interface TrackDTO {
  id: string
  name: string
  artist: string
  artistId?: string
  album: string
  albumId?: string
  index?: number
  discNumber?: number
  durationTicks: number
  playlistItemId?: string
  // When this track's file landed on disk (ms epoch).
  addedAt?: number
}

export interface AlbumDTO {
  id: string
  name: string
  artist: string
  artistId?: string
  year?: number
  trackCount?: number
  imageTag?: string
  /** Genre tags across the album's files, deduped. */
  genres?: string[]
  // When this album's newest file landed on disk (ms epoch).
  addedAt?: number
}

export interface ArtistDTO {
  id: string
  name: string
  /** Truthy when the artist has a cover image to fetch from /api/art. */
  imageTag?: string
}

export interface SearchResult {
  /** Names of top-level music-dir folders that have no audio (yet). When a
   *  search returns no matches the UI can use these to say "you have a
   *  placeholder folder, drop music in there to populate it." */
  placeholders: string[]
  albums: AlbumDTO[]
  artists: ArtistDTO[]
  tracks: TrackDTO[]
}

/** Outcome of merging albums on disk. */
export interface MergeResult {
  moved: number
  renamed: number
  foldersRemoved: number
  foldersKept: number
}


export interface Library {
  readonly musicDir: string
  scan(): Promise<void>
  status(): { ready: boolean; scanning: boolean; albums: number; artists: number; tracks: number }
  albums(): AlbumDTO[]
  artists(): ArtistDTO[]
  /** The most recently added albums + tracks, ranked by file mtime. */
  recentlyAdded(limit: number): Promise<{ albums: AlbumDTO[]; tracks: TrackDTO[] }>
  /** Resolve a play log (newest-first ids) into recent albums + tracks. */
  recentlyPlayed(trackIds: string[], limit: number): Promise<{ albums: AlbumDTO[]; tracks: TrackDTO[] }>
  artistAlbums(artistId: string): AlbumDTO[]
  artistTracks(artistId: string): Promise<TrackDTO[]>
  albumTracks(albumId: string): Promise<TrackDTO[]>
  tracksForPaths(paths: string[]): Promise<TrackDTO[]>
  search(query: string): Promise<SearchResult>
  track(id: string): ScannedTrack | undefined
  /** Every scanned track, for cross-library sweeps (e.g. the notes index). */
  allTracks(): ScannedTrack[]
  trackByPath(path: string): ScannedTrack | undefined
  album(id: string): ScannedAlbum | undefined
  artist(id: string): ScannedArtist | undefined
  /** Absolute path to a cover image for any album / artist / track id. */
  artPathFor(id: string): string | null
  /** Cover image for the album a given track file belongs to. */
  artPathForFile(path: string): string | null
  /** Save a JPEG as the artist's cover image; returns the path written. */
  setArtistArt(artistId: string, jpeg: Buffer): Promise<string | null>
  /** Save a JPEG as the album's cover image; returns the path written. */
  setAlbumArt(albumId: string, jpeg: Buffer): Promise<string | null>
  /** Move every track from the source albums into the target's folder. */
  /**
   * Move every track from the source albums into the target's folder.
   *
   * `onMove` is called for each file as it lands, with its old and new paths.
   * This is the one library operation that moves individual files BETWEEN
   * folders (and renames them on collision), so anything keyed on a file's
   * location — the tag sidecars — needs to be told. A whole-folder rename
   * needs no hook: the sidecar moves with the folder.
   */
  combineAlbums(
    targetId: string,
    sourceIds: string[],
    onMove?: (from: string, to: string) => void,
  ): Promise<MergeResult>
  /** Analyse the artist list for duplicates/variants and junk entries. */
  cleanupReport(): CleanupReport
}

/** Every file under `dir`, recursively. */
async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()!
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) out.push(full)
    }
  }
  return out
}

/** Remove `dir` and any sub-directory that is (or becomes) empty. */
async function pruneEmptyDirs(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(join(dir, e.name))
  }
  const remaining = await readdir(dir).catch(() => ['?'])
  if (remaining.length === 0) return rmdir(dir).then(() => true, () => false)
  return false
}

/** Move a file, falling back to copy+delete across filesystems. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    await unlink(from)
  }
}

/** A filename not already in `taken` — suffixes "(2)", "(3)"… on collision. */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Run an async mapper over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function createLibrary(musicDir: string): Library {
  const tracks = new Map<string, ScannedTrack>()
  const tracksByPath = new Map<string, ScannedTrack>()
  const albums = new Map<string, ScannedAlbum>()
  const artists = new Map<string, ScannedArtist>()
  const artistByName = new Map<string, ScannedArtist>()
  // Durations (in ticks) read lazily the first time an album is opened.
  const durations = new Map<string, number>()

  const cacheDir = join(process.cwd(), '.allegory-cache')
  const tagCacheFile = join(cacheDir, 'tags-cache.json')

  let ready = false
  let scanning = false
  // Top-level musicDir folder names that contained no audio at scan time —
  // surfaced by search when the main results are empty.
  let emptyArtistFolders: string[] = []

  async function walk(dir: string, audio: string[], images: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      // Skip hidden entries and cruft so they never get mistaken for tracks:
      //  - "." prefix   — .DS_Store, "._" AppleDouble sidecars, dotfiles
      //  - "_" prefix   — __MACOSX, and sync-tool stub files like
      //    "__01 Steady As She Goes.mp3": 5 KB corrupt placeholders that sit
      //    beside the real track and would otherwise double every album.
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      if (e.isDirectory()) {
        if (e.name === PLAYLISTS_DIRNAME || e.name === 'lost+found') continue
        await walk(full, audio, images)
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase()
        if (AUDIO_EXTS.has(ext)) audio.push(full)
        else if (IMAGE_EXTS.includes(ext)) images.push(full)
      }
    }
  }

  async function scan(): Promise<void> {
    scanning = true
    try {
      const audioFiles: string[] = []
      const imageFiles: string[] = []
      await walk(musicDir, audioFiles, imageFiles)

      tracks.clear()
      tracksByPath.clear()
      albums.clear()
      artists.clear()
      artistByName.clear()
      durations.clear()

      // The top-level folder a file lives under — its fallback "artist folder".
      const artistTopDir = (file: string): string => {
        const seg = relative(musicDir, file).split(sep)[0]
        return seg ? join(musicDir, seg) : musicDir
      }
      // A directory and its ancestors, up to (but excluding) musicDir.
      const ancestorDirs = (dir: string): string[] => {
        const out: string[] = []
        let d = dir
        while (d.startsWith(musicDir) && d !== musicDir) {
          out.push(d)
          const parent = dirname(d)
          if (parent === d) break
          d = parent
        }
        return out
      }

      // Group every directory's images so albums/artists can claim their art.
      const imagesByDir = new Map<string, string[]>()
      for (const img of imageFiles) {
        const d = dirname(img)
        const list = imagesByDir.get(d)
        if (list) list.push(img)
        else imagesByDir.set(d, [img])
      }

      // Read header tags for every file, reusing a disk cache keyed by
      // path + mtime + size so re-scans (and restarts) stay fast.
      let cache: Record<string, ScanTag> = {}
      try {
        const parsed = JSON.parse(await readFile(tagCacheFile, 'utf8')) as TagCacheFile
        // A cache from before the current shape is dropped whole: its entries
        // are missing whatever field was added, and no per-file check can tell.
        if (parsed?.version === TAG_CACHE_VERSION && parsed.files) cache = parsed.files
      } catch {
        cache = {}
      }
      const nextCache: Record<string, ScanTag> = {}
      const scanTags = await mapLimit(audioFiles, 24, async (file): Promise<ScanTag> => {
        const st = await stat(file).catch(() => null)
        const mtimeMs = st?.mtimeMs ?? 0
        const size = st?.size ?? 0
        const hit = cache[file]
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
          nextCache[file] = hit
          return hit
        }
        const entry: ScanTag = { mtimeMs, size, ...(await readHeaderTags(file)) }
        nextCache[file] = entry
        return entry
      })
      try {
        await mkdir(cacheDir, { recursive: true })
        const payload: TagCacheFile = { version: TAG_CACHE_VERSION, files: nextCache }
        await writeFile(tagCacheFile, JSON.stringify(payload))
      } catch {
        // Cache is best-effort — a failed write just means a slower next scan.
      }

      // Zero-byte files are the residue of an interrupted copy: no tags, and
      // nothing to play. They were being indexed anyway and shown as ordinary
      // tracks that silently do nothing, so drop them before the index is built.
      const playableFiles: string[] = []
      const playableTags: ScanTag[] = []
      for (let i = 0; i < audioFiles.length; i++) {
        if (scanTags[i].size === 0) continue
        playableFiles.push(audioFiles[i])
        playableTags.push(scanTags[i])
      }
      const emptyFiles = audioFiles.length - playableFiles.length

      // Group artists + albums by their (cleaned) tags. Folder names are only
      // a fallback for files that have no usable tags.
      const albumDirs = new Map<string, Set<string>>()
      for (let i = 0; i < playableFiles.length; i++) {
        const file = playableFiles[i]
        const st = playableTags[i]
        const fileDir = dirname(file)
        // Fold CD1/CD2 sub-folders back into the parent album folder.
        const albumFolderDir = CD_SUBDIR.test(basename(fileDir)) ? dirname(fileDir) : fileDir

        const folderArtist = cleanName(basename(artistTopDir(file))) || 'Unknown Artist'
        const folderAlbum = cleanName(basename(albumFolderDir)) || folderArtist

        const tagTitle = cleanName(st.title)
        const tagArtist = cleanName(st.albumartist) || cleanName(st.artist)
        const tagAlbum = cleanName(st.album)

        // The artist comes from the TOP-LEVEL folder — the one place the
        // library is reliably organised. Per-track artist tags ("$peedranch",
        // "21bigplayer") and mid-level album-code folders ("1992DC") are both
        // too dirty to trust for grouping. Album NAME, however, comes from the
        // tag (which is clean), so "1992DC/DC" becomes "Dale Crover".
        const artistName = folderArtist
        const albumName = tagAlbum || folderAlbum

        const artistKey = artistName.toLowerCase()
        const albumKey = artistKey + ' ' + albumName.toLowerCase()
        const artistId = id('artist:' + artistKey)
        const albumId = id('album:' + albumKey)

        let artist = artists.get(artistId)
        if (!artist) {
          artist = {
            id: artistId,
            name: artistName,
            dir: artistTopDir(file),
            artPath: null,
            albumIds: [],
          }
          artists.set(artistId, artist)
          artistByName.set(artistKey, artist)
        }

        let album = albums.get(albumId)
        if (!album) {
          album = {
            id: albumId,
            name: albumName,
            artist: artistName,
            artistId,
            year: st.year,
            dir: albumFolderDir,
            artPath: null,
            trackIds: [],
            genres: [],
          }
          albums.set(albumId, album)
          artist.albumIds.push(albumId)
        } else if (album.year == null && st.year != null) {
          album.year = st.year
        }

        const dset = albumDirs.get(albumId) ?? new Set<string>()
        dset.add(albumFolderDir)
        dset.add(fileDir)
        albumDirs.set(albumId, dset)

        const { num, title } = parseFilename(basename(file))
        const trackId = id('track:' + relative(musicDir, file))
        const track: ScannedTrack = {
          id: trackId,
          path: file,
          fileTitle: title,
          fileNum: num,
          albumId,
          artistId,
          mtimeMs: st.mtimeMs,
          tagTitle: tagTitle || undefined,
          tagArtist: tagArtist || undefined,
          tagAlbum: tagAlbum || undefined,
          tagTrackNo: st.trackNo,
          tagDiscNo: st.discNo,
          genres: st.genres,
        }
        tracks.set(trackId, track)
        tracksByPath.set(file, track)
        album.trackIds.push(trackId)
        // The album's genres are the union of its files'. Records are tagged a
        // song at a time as often as all at once, and one song tagged "Live"
        // shouldn't be the only way to find the album it's on.
        for (const genre of st.genres ?? []) {
          if (!album.genres.some((g) => g.toLowerCase() === genre.toLowerCase())) {
            album.genres.push(genre)
          }
        }
        // The album is "added" at the moment its newest track landed.
        album.addedAt = Math.max(album.addedAt ?? 0, st.mtimeMs)
      }

      // Cover art per album: the best image across all the folders its tracks
      // live in. Order tracks by tag disc/track number, then filename.
      for (const album of albums.values()) {
        const dirs = albumDirs.get(album.id) ?? new Set([album.dir])
        const imgs: string[] = []
        for (const d of dirs) imgs.push(...(imagesByDir.get(d) ?? []))
        album.artPath = bestArt(imgs)
        album.trackIds.sort((a, b) => {
          const ta = tracks.get(a)!
          const tb = tracks.get(b)!
          return (
            (ta.tagDiscNo ?? 1) - (tb.tagDiscNo ?? 1) ||
            (ta.tagTrackNo ?? ta.fileNum ?? 9999) - (tb.tagTrackNo ?? tb.fileNum ?? 9999) ||
            ta.path.localeCompare(tb.path)
          )
        })
      }
      // Cover art per artist: the best image anywhere in the artist's folder
      // tree (album dirs + their ancestors), else the first album's cover.
      for (const artist of artists.values()) {
        const seen = new Set<string>()
        const imgs: string[] = []
        for (const albumId of artist.albumIds) {
          for (const d of albumDirs.get(albumId) ?? new Set<string>()) {
            for (const anc of ancestorDirs(d)) {
              if (seen.has(anc)) continue
              seen.add(anc)
              imgs.push(...(imagesByDir.get(anc) ?? []))
            }
          }
        }
        artist.artPath =
          bestArt(imgs) ??
          (artist.albumIds
            .map((a) => albums.get(a)?.artPath)
            .find((p): p is string => !!p) ?? null)
      }

      // Collect top-level musicDir folders that contain no audio at all —
      // empty placeholder folders the user can populate later. Search will
      // surface these when normal results are empty.
      const artistDirs = new Set([...artists.values()].map((a) => a.dir))
      const topLevel = await readdir(musicDir, { withFileTypes: true }).catch(() => [])
      emptyArtistFolders = topLevel
        .filter(
          (e) =>
            e.isDirectory() &&
            !e.name.startsWith('.') &&
            e.name !== PLAYLISTS_DIRNAME &&
            !artistDirs.has(join(musicDir, e.name)),
        )
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

      ready = true
      console.log(
        `[allegory] library: ${artists.size} artists, ${albums.size} albums, ${tracks.size} tracks` +
          (emptyArtistFolders.length
            ? ` (${emptyArtistFolders.length} empty placeholder folder${
                emptyArtistFolders.length === 1 ? '' : 's'
              })`
            : '') +
          (emptyFiles
            ? ` — skipped ${emptyFiles} zero-byte file${emptyFiles === 1 ? '' : 's'}`
            : ''),
      )
    } finally {
      scanning = false
    }
  }

  /** Read (and memoise) a track's duration — the one tag we skip at scan. */
  async function readDuration(track: ScannedTrack): Promise<number> {
    const cached = durations.get(track.id)
    if (cached != null) return cached
    let ticks = 0
    try {
      const mm = await import('music-metadata')
      const md = await mm.parseFile(track.path, { duration: true, skipCovers: true })
      ticks = Math.round((md.format.duration ?? 0) * 10_000_000)
    } catch {
      // Unreadable / unsupported file — leave the duration at 0.
    }
    durations.set(track.id, ticks)
    return ticks
  }

  /** Turn scanned tracks into DTOs from their scan-time tags + lazy duration. */
  async function toDTOs(items: ScannedTrack[]): Promise<TrackDTO[]> {
    return mapLimit(items, 8, async (t): Promise<TrackDTO> => {
      const album = albums.get(t.albumId)
      const artistName = t.tagArtist || album?.artist || 'Unknown Artist'
      const artist = artistByName.get(artistName.toLowerCase())
      return {
        id: t.id,
        name: t.tagTitle || t.fileTitle,
        artist: artistName,
        artistId: artist?.id ?? t.artistId,
        album: t.tagAlbum || album?.name || '',
        albumId: t.albumId,
        index: t.tagTrackNo ?? t.fileNum,
        discNumber: t.tagDiscNo,
        durationTicks: await readDuration(t),
        addedAt: t.mtimeMs,
      }
    })
  }

  function albumDTO(a: ScannedAlbum): AlbumDTO {
    return {
      id: a.id,
      name: a.name,
      artist: a.artist,
      artistId: a.artistId,
      year: a.year,
      trackCount: a.trackIds.length,
      imageTag: a.artPath ? 'art' : undefined,
      genres: a.genres.length > 0 ? a.genres : undefined,
      addedAt: a.addedAt,
    }
  }

  function artistDTO(a: ScannedArtist): ArtistDTO {
    return { id: a.id, name: a.name, imageTag: a.artPath ? 'art' : undefined }
  }

  return {
    musicDir,
    scan,
    status: () => ({
      ready,
      scanning,
      albums: albums.size,
      artists: artists.size,
      tracks: tracks.size,
    }),
    albums: () =>
      [...albums.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map(albumDTO),
    artists: () =>
      [...artists.values()]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map(artistDTO),
    recentlyAdded: async (limit) => {
      const recentAlbums = [...albums.values()]
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        .slice(0, limit)
        .map(albumDTO)
      // Top tracks by file mtime, newest first, then resolved to DTOs.
      const recentTrackItems = [...tracks.values()]
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit)
      const recentTracks = await toDTOs(recentTrackItems)
      return { albums: recentAlbums, tracks: recentTracks }
    },
    recentlyPlayed: async (trackIds, limit) => {
      // Walk the play log newest-first, keeping the first sighting of each
      // track and album. Ids that vanished after a rescan are skipped.
      const seenTracks = new Set<string>()
      const trackItems: ScannedTrack[] = []
      const seenAlbums = new Set<string>()
      const albumItems: ScannedAlbum[] = []
      for (const id of trackIds) {
        const t = tracks.get(id)
        if (!t) continue
        if (!seenTracks.has(t.id) && trackItems.length < limit) {
          seenTracks.add(t.id)
          trackItems.push(t)
        }
        if (!seenAlbums.has(t.albumId) && albumItems.length < limit) {
          const album = albums.get(t.albumId)
          if (album) {
            seenAlbums.add(t.albumId)
            albumItems.push(album)
          }
        }
      }
      const playedTracks = await toDTOs(trackItems)
      return { albums: albumItems.map(albumDTO), tracks: playedTracks }
    },
    artistAlbums: (artistId) => {
      const artist = artists.get(artistId)
      if (!artist) return []
      return artist.albumIds
        .map((id) => albums.get(id))
        .filter((a): a is ScannedAlbum => !!a)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map(albumDTO)
    },
    artistTracks: async (artistId) => {
      const artist = artists.get(artistId)
      if (!artist) return []
      // Album by album, each album already in track order from the scan.
      const items: ScannedTrack[] = []
      for (const albumId of artist.albumIds) {
        const album = albums.get(albumId)
        if (!album) continue
        for (const trackId of album.trackIds) {
          const t = tracks.get(trackId)
          if (t) items.push(t)
        }
      }
      return toDTOs(items)
    },
    albumTracks: async (albumId) => {
      const album = albums.get(albumId)
      if (!album) return []
      const items = album.trackIds
        .map((id) => tracks.get(id))
        .filter((t): t is ScannedTrack => !!t)
      const dtos = await toDTOs(items)
      // Now that real disc/track numbers are known, sort properly.
      return dtos.sort(
        (a, b) =>
          (a.discNumber ?? 1) - (b.discNumber ?? 1) ||
          (a.index ?? 9999) - (b.index ?? 9999),
      )
    },
    tracksForPaths: async (paths) => {
      const items = paths
        .map((p) => tracksByPath.get(p))
        .filter((t): t is ScannedTrack => !!t)
      return toDTOs(items)
    },
    search: async (query) => {
      const q = query.trim().toLowerCase()
      if (q.length === 0) return { placeholders: [], albums: [], artists: [], tracks: [] }
      // Normalize separators in BOTH query and candidate so "ac-dc",
      // "ac_dc", "ac dc" all match a folder named "ACDC", and vice versa.
      const fold = (s: string) => s.toLowerCase().replace(/[\s_\-./&]+/g, '')
      const qFolded = fold(q)
      // Rank: 0 = name starts with the query, 1 = contains it, 2 = no match.
      // Falls back to a separator-folded comparison when the literal one
      // misses, so users don't have to guess the punctuation.
      const rank = (name: string): number => {
        const n = name.toLowerCase()
        if (n.startsWith(q)) return 0
        if (n.includes(q)) return 1
        const f = fold(name)
        if (f.startsWith(qFolded)) return 0
        if (f.includes(qFolded)) return 1
        return 2
      }
      const matchedAlbums = [...albums.values()]
        .map((a) => ({ a, r: Math.min(rank(a.name), rank(a.artist)) }))
        .filter((x) => x.r < 2)
        .sort((x, y) => x.r - y.r || x.a.name.localeCompare(y.a.name))
        .slice(0, 24)
        .map((x) => albumDTO(x.a))
      const matchedArtists = [...artists.values()]
        .map((a) => ({ a, r: rank(a.name) }))
        .filter((x) => x.r < 2)
        .sort((x, y) => x.r - y.r || x.a.name.localeCompare(y.a.name))
        .slice(0, 24)
        .map((x) => artistDTO(x.a))
      const matchedTrackItems = [...tracks.values()]
        .map((t) => ({ t, r: rank(t.fileTitle) }))
        .filter((x) => x.r < 2)
        .sort((x, y) => x.r - y.r || x.t.fileTitle.localeCompare(y.t.fileTitle))
        .slice(0, 50)
        .map((x) => x.t)
      const matchedTracks = await toDTOs(matchedTrackItems)
      const placeholders = emptyArtistFolders.filter((n) => rank(n) < 2)
      return {
        placeholders,
        albums: matchedAlbums,
        artists: matchedArtists,
        tracks: matchedTracks,
      }
    },
    track: (id) => tracks.get(id),
    allTracks: () => [...tracks.values()],
    trackByPath: (path) => tracksByPath.get(path),
    album: (id) => albums.get(id),
    artist: (id) => artists.get(id),
    artPathFor: (id) => {
      const album = albums.get(id)
      if (album) return album.artPath
      const artist = artists.get(id)
      if (artist) return artist.artPath
      const track = tracks.get(id)
      if (track) return albums.get(track.albumId)?.artPath ?? null
      return null
    },
    artPathForFile: (path) => {
      const track = tracksByPath.get(path)
      return track ? albums.get(track.albumId)?.artPath ?? null : null
    },
    setArtistArt: async (artistId, jpeg) => {
      const artist = artists.get(artistId)
      if (!artist) return null
      const dest = join(artist.dir, 'folder.jpg')
      await writeFile(dest, jpeg)
      artist.artPath = dest
      return dest
    },
    setAlbumArt: async (albumId, jpeg) => {
      const album = albums.get(albumId)
      if (!album) return null
      const dest = join(album.dir, 'folder.jpg')
      await writeFile(dest, jpeg)
      album.artPath = dest
      return dest
    },
    combineAlbums: async (targetId, sourceIds, onMove) => {
      const target = albums.get(targetId)
      if (!target) throw new Error('That album could not be found.')
      const taken = new Set(await readdir(target.dir).catch(() => []))
      let moved = 0
      let renamed = 0
      let foldersRemoved = 0
      let foldersKept = 0
      for (const sourceId of sourceIds) {
        const source = albums.get(sourceId)
        if (!source || source.id === targetId || source.dir === target.dir) {
          continue
        }
        // Move audio (and lyric/cue sidecars) into the target's folder.
        for (const file of await collectFiles(source.dir)) {
          const ext = extname(file).toLowerCase()
          if (!AUDIO_EXTS.has(ext) && ext !== '.lrc' && ext !== '.cue') continue
          const original = basename(file)
          const name = freeName(original, taken)
          taken.add(name)
          const dest = join(target.dir, name)
          await moveFile(file, dest)
          onMove?.(file, dest)
          if (AUDIO_EXTS.has(ext)) moved++
          if (name !== original) renamed++
        }
        // Drop now-redundant art and junk; leave anything unexpected.
        for (const file of await collectFiles(source.dir)) {
          const base = basename(file)
          const ext = extname(base).toLowerCase()
          if (
            IMAGE_EXTS.includes(ext) ||
            base.startsWith('._') ||
            base === '.DS_Store' ||
            ext === '.log' ||
            ext === '.nfo'
          ) {
            await unlink(file).catch(() => undefined)
          }
        }
        if (await pruneEmptyDirs(source.dir)) foldersRemoved++
        else foldersKept++
      }
      return { moved, renamed, foldersRemoved, foldersKept }
    },
    cleanupReport: () => {
      const list: CleanupArtist[] = [...artists.values()].map((a) => ({
        id: a.id,
        name: a.name,
        albumCount: a.albumIds.length,
        trackCount: a.albumIds.reduce(
          (sum, albumId) => sum + (albums.get(albumId)?.trackIds.length ?? 0),
          0,
        ),
      }))
      return analyzeArtists(list)
    },
  }
}

/** Normalise a path for comparison — POSIX slashes, used in `.m3u` files. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

export function fromPosix(p: string): string {
  return sep === '/' ? p : p.split('/').join(sep)
}
