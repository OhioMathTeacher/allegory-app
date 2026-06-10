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
async function writeTrackTags(path: string, tags: Record<string, string>): Promise<void> {
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

  // Then rename the folder if the album moved on disk. `album.dir` is the
  // album folder; its parent is the artist folder.
  let newDir = album.dir
  let folderRenamed = false
  const renameArtist = edits.artist !== undefined && newArtist !== album.artist
  const renameAlbum = edits.name !== undefined && newName !== album.name

  if (renameArtist || renameAlbum) {
    // <musicDir>/<artist>/<album>/ — derive musicDir from album.dir minus
    // its last two segments rather than carrying it through as a parameter.
    const oldArtistDir = dirname(album.dir)
    const musicDir = dirname(oldArtistDir)
    const newArtistDir = renameArtist ? join(musicDir, newArtist) : oldArtistDir
    newDir = join(newArtistDir, newName)

    if (newDir !== album.dir) {
      if (await exists(newDir)) {
        throw new Error(
          `Cannot rename — a folder already exists at ${newDir}. Move or delete it and try again.`,
        )
      }
      if (renameArtist) {
        await mkdir(newArtistDir, { recursive: true })
      }
      await rename(album.dir, newDir).catch(async () => {
        // Cross-filesystem fallback: copy the directory contents file by file.
        // (Rare on a single drive, but keeps us honest.)
        await mkdir(newDir, { recursive: true })
        for (const old of paths) {
          const target = join(newDir, basename(old))
          await moveFile(old, target)
        }
        await unlink(album.dir).catch(() => undefined)
      })
      folderRenamed = true
    }
  }

  return {
    tracksWritten: paths.length,
    folderRenamed,
    newDir,
  }
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
      // any name collision so we don't half-merge and leave a mess.
      const children = await readdir(oldDir, { withFileTypes: true })
      for (const child of children) {
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
