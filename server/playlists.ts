/**
 * Playlists, stored as portable `.m3u` files in `<musicDir>/Playlists`.
 *
 * A plain path-per-line `.m3u` is readable by Plex, VLC and most players,
 * and every edit Allegory offers — create, append, remove, reorder, rename,
 * combine — is just a line operation on the file. Paths are written relative
 * to the music directory (POSIX slashes) so playlists survive the drive
 * being moved.
 *
 * Each Allegory playlist carries a stable `#Allegory-ID` so renaming the file never
 * breaks a reference. Files without one (e.g. hand-made `.m3u`s) fall back
 * to an id derived from the filename.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename as renameFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLAYLISTS_DIRNAME, fromPosix, toPosix } from './scanner.ts'

/** A playlist as sent to the browser — matches the client's `Playlist`. */
export interface PlaylistDTO {
  id: string
  name: string
  trackCount: number
  /** How many entries repeat a track already listed above them. */
  duplicateCount: number
  imageTag?: string
}

/** What `addItems` actually did — `skipped` are the already-present ones. */
export interface AddItemsResult {
  added: number
  skipped: number
}

/** A file in the playlist folder that Allegory did not load, and why. */
export interface SkippedPlaylistFile {
  name: string
  reason: string
}

/**
 * What the playlist folder actually holds — including the part that was *not*
 * loaded. Silence here is what turned a bulk rename into a week of confusion:
 * seven `.m3u.bak` files sat in the folder while the UI reported three
 * playlists and no reason to think anything was missing.
 */
export interface PlaylistsReport {
  /** Absolute path of the folder these playlists live in. */
  dir: string
  /** Files that look like playlists but were skipped, with the reason. */
  skipped: SkippedPlaylistFile[]
  /** Set only when the folder exists but could not be read. */
  error?: string
}

/** Extensions we parse. `.m3u8` is the same format, declared UTF-8. */
const LOADABLE_RE = /\.m3u8?$/i

/**
 * Files worth *mentioning* when they aren't loaded. Something named
 * `Van Halen Classics.m3u.bak` is plainly meant to be a playlist, so dropping
 * it without a word is the bug. A `notes.txt` in the same folder is not, and
 * stays quiet.
 */
const PLAYLIST_ISH_RE = /\.(m3u8?|pls|xspf|wpl)(\.|$)/i

function skipReason(name: string): string {
  // `foo.m3u.bak`, `foo.m3u8.old` — a playlist with something appended.
  const suffixed = name.toLowerCase().match(/\.(m3u8?)\.([^.]+)$/)
  if (suffixed) {
    return `saved as .${suffixed[2]} — rename it to .${suffixed[1]} to load it`
  }
  return 'unsupported playlist format — Allegory reads .m3u and .m3u8'
}

/** A playlist filename without its extension, for the display-name fallback. */
function baseName(file: string): string {
  return file.replace(LOADABLE_RE, '')
}

/**
 * Keep each track's first occurrence and drop the repeats, preserving the
 * order of the survivors.
 *
 * Entries are compared by the absolute path `parse` has already resolved them
 * to, not by the raw `.m3u` line — so `Music/x.flac` and `../Music/x.flac`
 * are recognised as one file rather than two. Two different files holding the
 * same recording (an album rip and a greatest-hits rip) are deliberately left
 * alone: only the player can tell those apart, and guessing gets live takes
 * and remasters wrong.
 */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const p of paths) {
    if (seen.has(p)) continue
    seen.add(p)
    unique.push(p)
  }
  return unique
}

/** How many entries `dedupePaths` would drop. */
function countDuplicates(paths: string[]): number {
  return paths.length - new Set(paths).size
}

function fallbackId(filename: string): string {
  return createHash('sha1').update('playlist:' + filename).digest('hex').slice(0, 16)
}

/** Make a playlist name safe to use as a filename. */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 120) || 'Playlist'
}

interface ParsedPlaylist {
  file: string
  filePath: string
  id: string
  name: string
  paths: string[]
}

export interface Playlists {
  list(): Promise<PlaylistDTO[]>
  /** What the playlist folder holds, including files that were not loaded. */
  report(): Promise<PlaylistsReport>
  paths(playlistId: string): Promise<string[]>
  create(name: string, trackPaths: string[]): Promise<string>
  /**
   * Append tracks. Ones already in the playlist are skipped and reported
   * rather than silently appended a second time — pass `allowDuplicates` to
   * add them anyway.
   */
  addItems(
    playlistId: string,
    trackPaths: string[],
    allowDuplicates?: boolean,
  ): Promise<AddItemsResult>
  removeIndices(playlistId: string, indices: number[]): Promise<void>
  /** Drop repeated entries, keeping the first of each. Returns how many went. */
  removeDuplicates(playlistId: string): Promise<number>
  /** Reorder a playlist: move the track at `from` to position `to`. */
  move(playlistId: string, from: number, to: number): Promise<void>
  rename(playlistId: string, newName: string): Promise<void>
  remove(playlistId: string): Promise<void>
  /** Create a new playlist from the tracks of several existing ones. */
  combine(name: string, sourceIds: string[]): Promise<string>
  /** Absolute path to a playlist's custom cover, if one has been set. */
  customArtPath(playlistId: string): Promise<string | null>
  /** Store a custom cover image (JPEG bytes) for a playlist. */
  setArt(playlistId: string, jpeg: Buffer): Promise<boolean>
}

export function createPlaylists(musicDir: string): Playlists {
  const dir = join(musicDir, PLAYLISTS_DIRNAME)
  // Custom playlist covers live in a hidden subfolder of the Playlists dir,
  // keyed by playlist id — so they survive a rename and aren't seen as music.
  const artDir = join(dir, '.art')
  const artFile = (playlistId: string) => join(artDir, `${playlistId}.jpg`)

  /**
   * Read the folder once, splitting it into what we load and what we skip.
   *
   * The `catch` deliberately distinguishes two cases that used to look
   * identical from the outside: a folder that isn't there yet (the ordinary
   * first-run state — it appears on the first save) and a folder that exists
   * but can't be read (a permissions or mount fault the user needs told).
   */
  async function scanFolder(): Promise<{
    files: string[]
    skipped: SkippedPlaylistFile[]
    error?: string
  }> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { files: [], skipped: [] }
      return {
        files: [],
        skipped: [],
        error: `Could not read ${dir}${code ? ` (${code})` : ''}.`,
      }
    }
    const files: string[] = []
    const skipped: SkippedPlaylistFile[] = []
    for (const name of entries) {
      if (name.startsWith('.')) continue // `.art/`, editor droppings
      if (LOADABLE_RE.test(name)) files.push(name)
      else if (PLAYLIST_ISH_RE.test(name)) skipped.push({ name, reason: skipReason(name) })
    }
    files.sort()
    skipped.sort((a, b) => a.name.localeCompare(b.name))
    return { files, skipped }
  }

  async function listFiles(): Promise<string[]> {
    return (await scanFolder()).files
  }

  async function parse(file: string): Promise<ParsedPlaylist> {
    const filePath = join(dir, file)
    let text = ''
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      // unreadable — treated as empty below
    }
    let id = ''
    let name = ''
    const paths: string[] = []
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('#Allegory-ID:')) {
        id = line.slice('#Allegory-ID:'.length).trim()
        continue
      }
      if (line.startsWith('#PLAYLIST:')) {
        name = line.slice('#PLAYLIST:'.length).trim()
        continue
      }
      if (line.startsWith('#')) continue
      const p = fromPosix(line)
      paths.push(isAbsolute(p) ? p : resolve(musicDir, p))
    }
    return {
      file,
      filePath,
      id: id || fallbackId(file),
      name: name || baseName(file),
      paths,
    }
  }

  async function listEntries(): Promise<ParsedPlaylist[]> {
    return Promise.all((await listFiles()).map(parse))
  }

  async function entryFor(playlistId: string): Promise<ParsedPlaylist | null> {
    for (const entry of await listEntries()) {
      if (entry.id === playlistId) return entry
    }
    return null
  }

  async function write(
    filePath: string,
    id: string,
    name: string,
    paths: string[],
  ): Promise<void> {
    await mkdir(dir, { recursive: true })
    const lines = ['#EXTM3U', `#PLAYLIST:${name}`, `#Allegory-ID:${id}`]
    for (const p of paths) {
      const rel = relative(musicDir, p)
      lines.push(rel.startsWith('..') ? p : toPosix(rel))
    }
    await writeFile(filePath, lines.join('\n') + '\n', 'utf8')
  }

  /** A non-colliding `.m3u` filename for `name` (optionally keeping `ignore`). */
  async function freeFilename(name: string, ignore?: string): Promise<string> {
    const base = safeName(name)
    const taken = new Set((await listFiles()).filter((f) => f !== ignore))
    let file = `${base}.m3u`
    for (let n = 2; taken.has(file); n++) file = `${base} ${n}.m3u`
    return file
  }

  async function customArtPath(playlistId: string): Promise<string | null> {
    try {
      await stat(artFile(playlistId))
      return artFile(playlistId)
    } catch {
      return null
    }
  }

  async function setArt(playlistId: string, jpeg: Buffer): Promise<boolean> {
    if (!(await entryFor(playlistId))) return false
    await mkdir(artDir, { recursive: true })
    await writeFile(artFile(playlistId), jpeg)
    return true
  }

  return {
    async list() {
      const entries = await listEntries()
      const dtos = await Promise.all(
        entries.map(async (e): Promise<PlaylistDTO> => {
          // Custom art → tag is its mtime, so the image URL changes whenever the
          // art is replaced (a cache-bust that survives reloads). Otherwise the
          // first track's cover (stable tag), or no art.
          let imageTag: string | undefined
          try {
            const st = await stat(artFile(e.id))
            imageTag = 'c' + Math.round(st.mtimeMs)
          } catch {
            imageTag = e.paths.length > 0 ? 'art' : undefined
          }
          return {
            id: e.id,
            name: e.name,
            trackCount: e.paths.length,
            duplicateCount: countDuplicates(e.paths),
            imageTag,
          }
        }),
      )
      return dtos.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
    },

    async report() {
      const { skipped, error } = await scanFolder()
      return { dir, skipped, ...(error ? { error } : {}) }
    },

    async paths(playlistId) {
      return (await entryFor(playlistId))?.paths ?? []
    },

    async create(name, trackPaths) {
      const id = randomBytes(8).toString('hex')
      const file = await freeFilename(name)
      await write(join(dir, file), id, file.slice(0, -4), trackPaths)
      return id
    },

    async addItems(playlistId, trackPaths, allowDuplicates = false) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      // Adding a track that's already there is nearly always a mis-click, so
      // it's reported back rather than quietly making a second copy. The
      // caller can insist by passing `allowDuplicates`.
      const present = new Set(e.paths)
      const toAdd = allowDuplicates
        ? trackPaths
        : dedupePaths(trackPaths).filter((p) => !present.has(p))
      if (toAdd.length > 0) {
        await write(e.filePath, e.id, e.name, [...e.paths, ...toAdd])
      }
      return { added: toAdd.length, skipped: trackPaths.length - toAdd.length }
    },

    async removeIndices(playlistId, indices) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      const drop = new Set(indices)
      await write(
        e.filePath,
        e.id,
        e.name,
        e.paths.filter((_, i) => !drop.has(i)),
      )
    },

    async removeDuplicates(playlistId) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      const unique = dedupePaths(e.paths)
      const removed = e.paths.length - unique.length
      // Don't rewrite a file that has nothing to fix — leaves the mtime alone.
      if (removed > 0) await write(e.filePath, e.id, e.name, unique)
      return removed
    },

    async move(playlistId, from, to) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      const p = e.paths
      if (from < 0 || from >= p.length || to < 0 || to >= p.length || from === to) {
        return
      }
      const reordered = p.slice()
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved)
      await write(e.filePath, e.id, e.name, reordered)
    },

    async rename(playlistId, newName) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      const file = await freeFilename(newName, e.file)
      const newPath = join(dir, file)
      await write(e.filePath, e.id, file.slice(0, -4), e.paths)
      if (newPath !== e.filePath) await renameFile(e.filePath, newPath)
    },

    async remove(playlistId) {
      const e = await entryFor(playlistId)
      if (e) await unlink(e.filePath).catch(() => undefined)
    },

    async combine(name, sourceIds) {
      const byId = new Map((await listEntries()).map((e) => [e.id, e]))
      const paths: string[] = []
      for (const sourceId of sourceIds) {
        const e = byId.get(sourceId)
        if (e) paths.push(...e.paths)
      }
      const id = randomBytes(8).toString('hex')
      const file = await freeFilename(name)
      // Overlap between the sources is the whole reason duplicates appeared in
      // the first place: two lists sharing tracks used to concatenate into a
      // playlist that named each shared track twice.
      await write(join(dir, file), id, file.slice(0, -4), dedupePaths(paths))
      return id
    },

    customArtPath,
    setArt,
  }
}
