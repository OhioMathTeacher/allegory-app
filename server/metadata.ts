/**
 * Edit album metadata using the system `ffmpeg` CLI. `music-metadata` (the
 * library Allegory reads tags with) is read-only, so writes go out as
 * `ffmpeg -i in.ext -map 0 -c copy -metadata album=… out.ext` then atomic
 * move over the original. `-map 0` is essential — without it ffmpeg drops
 * embedded cover art.
 *
 * Album-name and artist edits also rename the folder on disk so the library
 * grid (which reads folder names, not tags) reflects the change.
 */
import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Library } from './scanner.ts'

/**
 * Files that must never block an artist-folder merge. These are caches and OS
 * droppings that both folders legitimately carry: refusing to merge because
 * each side has one would make merging impossible, which is exactly what it
 * did before this existed.
 */
const DISPOSABLE_ON_MERGE = new Set([
  // Allegory's own per-artist Last.fm cache (see artist-related.ts).
  '.allegory-artist.json',
  '.DS_Store',
  'Thumbs.db',
])

function isDisposableOnMerge(name: string): boolean {
  return DISPOSABLE_ON_MERGE.has(name)
}

import { runFfmpeg } from './ffmpeg.ts'

export interface AlbumEdits {
  name?: string
  artist?: string
  /** Four-digit year — stored as the `date` tag. */
  year?: number | string
}

export interface AlbumEditResult {
  tracksWritten: number
  folderRenamed: boolean
  /** Absolute path the album lives at now (changes when name/artist do). */
  newDir: string
}

/** Strip filesystem-unsafe characters and trim. Empty strings become null. */
function safeFsName(s: string): string | null {
  // The C0 control range is the point: these bytes are illegal in filenames.
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length === 0 ? null : cleaned
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

/** Write the given tag set to one audio file, in place. */
export async function writeTrackTags(path: string, tags: Record<string, string>): Promise<void> {
  const tmp = join(dirname(path), `.allegory-edit-${Date.now()}-${basename(path)}`)
  const metaArgs: string[] = []
  for (const [key, value] of Object.entries(tags)) {
    metaArgs.push('-metadata', `${key}=${value}`)
  }
  await runFfmpeg([
    '-y',
    '-i', path,
    '-map', '0',
    '-c', 'copy',
    ...metaArgs,
    tmp,
  ])
  await moveFile(tmp, path)
}

/** Does this path already exist? (Stat with a swallowed ENOENT.) */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Apply an album edit: write tags on every file in the album, and rename the
 * folder if the album's name or artist changed. Returns the new directory.
 *
 * Throws if the target folder already exists, if either name is empty after
 * sanitization, or if any ffmpeg write fails.
 */
export async function editAlbum(
  library: Library,
  albumId: string,
  edits: AlbumEdits,
): Promise<AlbumEditResult> {
  const album = library.album(albumId)
  if (!album) throw new Error('Album not found.')

  // Build the tag set first so we can fail fast on bad inputs.
  const tags: Record<string, string> = {}
  let newName = album.name
  let newArtist = album.artist

  if (edits.name !== undefined) {
    const safe = safeFsName(edits.name)
    if (!safe) throw new Error('Album name cannot be empty.')
    newName = safe
    tags.album = safe
  }
  if (edits.artist !== undefined) {
    const safe = safeFsName(edits.artist)
    if (!safe) throw new Error('Artist name cannot be empty.')
    newArtist = safe
    tags.artist = safe
    tags.album_artist = safe
  }
  if (edits.year !== undefined && edits.year !== '') {
    const y = String(edits.year).trim()
    if (!/^\d{4}$/.test(y)) throw new Error('Year must be a four-digit number.')
    tags.date = y
  }

  if (Object.keys(tags).length === 0) {
    return { tracksWritten: 0, folderRenamed: false, newDir: album.dir }
  }

  // Resolve track paths from the in-memory library, in album order.
  const paths = album.trackIds
    .map((id) => library.track(id)?.path)
    .filter((p): p is string => !!p)

  if (paths.length === 0) {
    throw new Error('No track files found for this album.')
  }

  // Write tags first (one ffmpeg invocation per file).
  for (const path of paths) {
    await writeTrackTags(path, tags)
  }

  // Then rename the folder if the album moved on disk.
  const { folderRenamed, newDir } = await renameAlbumFolder(
    album.dir,
    newName,
    newArtist,
    album.artist,
    album.name,
    paths,
  )

  return {
    tracksWritten: paths.length,
    folderRenamed,
    newDir,
  }
}

/**
 * Move an album's folder on disk to reflect a new album name and/or artist.
 * `album.dir` is `<musicDir>/<artist>/<album>/`. Returns the directory the
 * album lives at afterwards (unchanged if nothing moved).
 *
 * Throws if the destination already exists. Falls back to a per-file move
 * across filesystems. Call this AFTER writing tags — `paths` must still be
 * valid when it runs.
 */
export async function renameAlbumFolder(
  currentDir: string,
  newName: string,
  newArtist: string,
  oldArtist: string,
  oldName: string,
  paths: string[],
): Promise<{ folderRenamed: boolean; newDir: string }> {
  const renameArtist = newArtist !== oldArtist
  const renameAlbum = newName !== oldName
  if (!renameArtist && !renameAlbum) {
    return { folderRenamed: false, newDir: currentDir }
  }

  // <musicDir>/<artist>/<album>/ — derive musicDir from currentDir minus its
  // last two segments rather than carrying it through as a parameter.
  const oldArtistDir = dirname(currentDir)
  const musicDir = dirname(oldArtistDir)
  const newArtistDir = renameArtist ? join(musicDir, newArtist) : oldArtistDir
  const newDir = join(newArtistDir, newName)

  if (newDir === currentDir) return { folderRenamed: false, newDir: currentDir }

  if (await exists(newDir)) {
    throw new Error(
      `Cannot rename — a folder already exists at ${newDir}. Move or delete it and try again.`,
    )
  }
  if (renameArtist) {
    await mkdir(newArtistDir, { recursive: true })
  }
  await rename(currentDir, newDir).catch(async () => {
    // Cross-filesystem fallback: copy the directory contents file by file.
    // (Rare on a single drive, but keeps us honest.)
    await mkdir(newDir, { recursive: true })
    for (const old of paths) {
      const target = join(newDir, basename(old))
      await moveFile(old, target)
    }
    await unlink(currentDir).catch(() => undefined)
  })
  return { folderRenamed: true, newDir }
}

export interface ArtistRenameResult {
  tracksRewritten: number
  folderRenamed: boolean
  /** If the artist's folder was merged into an existing folder, the target. */
  mergedInto?: string
}

/**
 * Rename an artist for real: rewrite the `artist` + `album_artist` tags on
 * every track that belongs to this artist (across every album), and then
 * rename (or merge) the artist's folder on disk.
 *
 * The scanner derives the displayed artist name from the folder name, so a
 * folder rename is what actually changes the Artists list on next scan. The
 * tag rewrites keep things consistent for other players and for the queue's
 * track-level artist label.
 *
 * If a folder with the new name already exists, the source folder's album
 * subfolders are MOVED into it (a real merge), and the now-empty source
 * folder is removed. Throws on a name collision between an existing album
 * and one being moved in.
 */
export async function renameArtist(
  library: Library,
  artistId: string,
  newName: string,
): Promise<ArtistRenameResult> {
  const artist = library.artist(artistId)
  if (!artist) throw new Error('Artist not found.')

  const safe = safeFsName(newName)
  if (!safe) throw new Error('Artist name cannot be empty.')
  if (safe === artist.name && safe === basename(artist.dir)) {
    return { tracksRewritten: 0, folderRenamed: false }
  }

  // Collect every track path belonging to this artist BEFORE we touch the
  // filesystem — once the folder moves, the in-memory paths go stale.
  const paths: string[] = []
  for (const albumId of artist.albumIds) {
    const album = library.album(albumId)
    if (!album) continue
    for (const trackId of album.trackIds) {
      const track = library.track(trackId)
      if (track) paths.push(track.path)
    }
  }

  // Rewrite tags first (paths still valid).
  for (const path of paths) {
    await writeTrackTags(path, { artist: safe, album_artist: safe })
  }

  // Now move the folder. The artist's home dir lives directly under musicDir.
  const oldDir = artist.dir
  const musicDir = dirname(oldDir)
  const newDir = join(musicDir, safe)

  let folderRenamed = false
  let mergedInto: string | undefined

  if (newDir !== oldDir) {
    if (await exists(newDir)) {
      // Merge: move each child of oldDir into newDir. Reject up-front on
      // any name collision so we don't half-merge and leave a mess — but not
      // on bookkeeping that both folders are *expected* to have. Every artist
      // folder carries an enrichment sidecar, so without this exemption no two
      // artists could ever be merged: the collision check would always fire on
      // Allegory's own cache file.
      const children = await readdir(oldDir, { withFileTypes: true })
      for (const child of children) {
        if (isDisposableOnMerge(child.name)) continue
        const target = join(newDir, child.name)
        if (await exists(target)) {
          throw new Error(
            `Can't merge — "${child.name}" already exists under "${safe}". ` +
              `Resolve manually and try again.`,
          )
        }
      }
      for (const child of children) {
        const from = join(oldDir, child.name)
        const to = join(newDir, child.name)
        // The surviving artist keeps its own sidecar; the source's copy is a
        // regenerable Last.fm cache, so it's dropped rather than merged.
        if (isDisposableOnMerge(child.name) && (await exists(to))) {
          await unlink(from).catch(() => undefined)
          continue
        }
        await moveFile(from, to).catch(async () => {
          // moveFile only handles files; for directories fall back to rename
          // (or recursive copy across filesystems).
          await rename(from, to)
        })
      }
      // Best-effort cleanup of the now-empty source folder.
      await rmdir(oldDir).catch(() => undefined)
      mergedInto = newDir
      folderRenamed = true
    } else {
      // Simple rename. Falls back to mkdir + per-child move across filesystems.
      try {
        await rename(oldDir, newDir)
      } catch {
        await mkdir(newDir, { recursive: true })
        const children = await readdir(oldDir, { withFileTypes: true })
        for (const child of children) {
          await rename(join(oldDir, child.name), join(newDir, child.name))
        }
        await rmdir(oldDir).catch(() => undefined)
      }
      folderRenamed = true
    }
  }

  return { tracksRewritten: paths.length, folderRenamed, mergedInto }
}

// ---------------------------------------------------------------------------
// Full per-track tag editing
// ---------------------------------------------------------------------------

/** The curated set of common fields we read and edit per track. */
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

/** One track's full tag picture, as sent to the editor. */
export interface TrackTags {
  trackId: string
  file: string
  format?: string
  common: CommonTags
  /** Raw container-native frames, read-only — for diagnosis. */
  native: Array<{ id: string; value: string }>
  /** Set when the file's tags could not be parsed. */
  error?: string
}

/** Album-wide identity + per-track edits sent back when saving. */
export interface AlbumTagEdits {
  /** Applied to every track; album/artist also rename the folder. */
  album?: {
    name?: string
    artist?: string
    year?: string
    genre?: string
  }
  /** Per-track overrides, keyed by track id. Override album-wide values. */
  tracks?: Array<{ trackId: string } & Partial<CommonTags>>
}

/** Map a CommonTags-shaped partial to the ffmpeg `-metadata` key/value set. */
function toFfmpegTags(edit: Partial<CommonTags>): Record<string, string> {
  const tags: Record<string, string> = {}
  if (edit.title !== undefined) tags.title = edit.title
  if (edit.artist !== undefined) tags.artist = edit.artist
  if (edit.album !== undefined) tags.album = edit.album
  if (edit.albumartist !== undefined) tags.album_artist = edit.albumartist
  if (edit.year !== undefined) tags.date = edit.year
  if (edit.trackNo !== undefined) tags.track = edit.trackNo
  if (edit.discNo !== undefined) tags.disc = edit.discNo
  if (edit.genre !== undefined) tags.genre = edit.genre
  if (edit.composer !== undefined) tags.composer = edit.composer
  if (edit.comment !== undefined) tags.comment = edit.comment
  return tags
}

/** Read every field we expose for one track, including the raw native frames. */
export async function readFullTags(trackId: string, path: string): Promise<TrackTags> {
  const blank: CommonTags = {
    title: '', artist: '', album: '', albumartist: '', year: '',
    trackNo: '', discNo: '', genre: '', composer: '', comment: '',
  }
  try {
    const mm = await import('music-metadata')
    const md = await mm.parseFile(path, { duration: false, skipCovers: true })
    const c = md.common
    const common: CommonTags = {
      title: c.title?.trim() ?? '',
      artist: c.artist?.trim() ?? '',
      album: c.album?.trim() ?? '',
      albumartist: c.albumartist?.trim() ?? '',
      year: c.year != null ? String(c.year) : '',
      trackNo: c.track?.no != null ? String(c.track.no) : '',
      discNo: c.disk?.no != null ? String(c.disk.no) : '',
      genre: c.genre?.join(', ') ?? '',
      composer: c.composer?.join(', ') ?? '',
      comment:
        c.comment
          ?.map((x) => (typeof x === 'string' ? x : (x?.text ?? '')))
          .filter(Boolean)
          .join(' / ') ?? '',
    }
    const native: Array<{ id: string; value: string }> = []
    for (const frames of Object.values(md.native ?? {})) {
      for (const f of frames) {
        const v = f.value
        const value =
          v == null
            ? ''
            : typeof v === 'object'
              ? ('text' in v ? String((v as { text?: unknown }).text ?? '') : '[binary]')
              : String(v)
        native.push({ id: f.id, value: value.slice(0, 500) })
      }
    }
    return { trackId, file: basename(path), format: md.format.container ?? undefined, common, native }
  } catch {
    return { trackId, file: basename(path), common: blank, native: [], error: 'unreadable' }
  }
}

export interface AlbumTagSaveResult {
  tracksWritten: number
  folderRenamed: boolean
  newDir: string
}

/**
 * Apply album-wide and per-track tag edits in one pass. Album-wide values are
 * written to every track; per-track values override them for their own track.
 * Tags are written FIRST (while paths are valid), then the folder is renamed if
 * the album name or artist changed.
 */
export async function applyAlbumTags(
  library: Library,
  albumId: string,
  edits: AlbumTagEdits,
): Promise<AlbumTagSaveResult> {
  const album = library.album(albumId)
  if (!album) throw new Error('Album not found.')

  // --- album-wide values (applied to every track) ---
  const aw = edits.album ?? {}
  let newName = album.name
  let newArtist = album.artist
  const albumWide: Partial<CommonTags> = {}

  if (aw.name !== undefined) {
    const safe = safeFsName(aw.name)
    if (!safe) throw new Error('Album name cannot be empty.')
    newName = safe
    albumWide.album = safe
  }
  if (aw.artist !== undefined) {
    const safe = safeFsName(aw.artist)
    if (!safe) throw new Error('Album artist cannot be empty.')
    newArtist = safe
    albumWide.artist = safe
    albumWide.albumartist = safe
  }
  if (aw.year !== undefined && aw.year !== '') {
    const y = String(aw.year).trim()
    if (!/^\d{4}$/.test(y)) throw new Error('Year must be a four-digit number.')
    albumWide.year = y
  }
  if (aw.genre !== undefined) albumWide.genre = aw.genre.trim()

  const albumWideTags = toFfmpegTags(albumWide)

  // --- per-track overrides ---
  const perTrack = new Map<string, Record<string, string>>()
  for (const t of edits.tracks ?? []) {
    const { trackId, ...rest } = t
    perTrack.set(trackId, toFfmpegTags(rest))
  }

  // Resolve paths up front; we need them all for a folder-rename fallback.
  const allPaths = album.trackIds
    .map((id) => library.track(id)?.path)
    .filter((p): p is string => !!p)

  // Build the write set: album-wide tags merged with per-track overrides.
  const writes: Array<{ path: string; tags: Record<string, string> }> = []
  for (const trackId of album.trackIds) {
    const track = library.track(trackId)
    if (!track) continue
    const merged = { ...albumWideTags, ...(perTrack.get(trackId) ?? {}) }
    if (Object.keys(merged).length > 0) writes.push({ path: track.path, tags: merged })
  }

  const identityChanged = newName !== album.name || newArtist !== album.artist
  if (writes.length === 0 && !identityChanged) {
    return { tracksWritten: 0, folderRenamed: false, newDir: album.dir }
  }

  // Write tags first — paths are still valid before any folder move.
  for (const w of writes) {
    await writeTrackTags(w.path, w.tags)
  }

  // Then move the folder if the album's name or artist changed.
  const { folderRenamed, newDir } = await renameAlbumFolder(
    album.dir,
    newName,
    newArtist,
    album.artist,
    album.name,
    allPaths,
  )

  return { tracksWritten: writes.length, folderRenamed, newDir }
}
