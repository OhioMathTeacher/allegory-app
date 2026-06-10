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
  imageTag?: string
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
  paths(playlistId: string): Promise<string[]>
  create(name: string, trackPaths: string[]): Promise<string>
  addItems(playlistId: string, trackPaths: string[]): Promise<void>
  removeIndices(playlistId: string, indices: number[]): Promise<void>
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

  async function listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(dir)
      return entries.filter((f) => f.toLowerCase().endsWith('.m3u')).sort()
    } catch {
      return []
    }
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
      name: name || file.slice(0, file.length - 4),
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
          return { id: e.id, name: e.name, trackCount: e.paths.length, imageTag }
        }),
      )
      return dtos.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
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

    async addItems(playlistId, trackPaths) {
      const e = await entryFor(playlistId)
      if (!e) throw new Error('That playlist no longer exists.')
      await write(e.filePath, e.id, e.name, [...e.paths, ...trackPaths])
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
      await write(join(dir, file), id, file.slice(0, -4), paths)
      return id
    },

    customArtPath,
    setArt,
  }
}
