/**
 * Saved filters, and the smart playlists they materialise.
 *
 * A filter is a question about the library ("Blues, nothing I have played more
 * than three times, added this year"). Asking it is pure: `evaluate` takes a
 * flat list of facts about tracks and a rule, and returns the matches. That
 * split is deliberate — the interesting part is the matching, and keeping it
 * free of the library, the tag sidecars and the listen log is what makes it
 * testable without any of them.
 *
 * Filters live in `.allegory-cache/filters.json` for the same reason the tag
 * tree does: a filter is Todd's construct, true regardless of which files are
 * on the drive, so it does not belong beside any album.
 *
 * MATERIALISING is the point. A smart playlist is not a new kind of object that
 * clients have to understand — it is an ordinary `.m3u`, rewritten in place from
 * the filter's current answer. That is what makes it visible in Amperfy, which
 * knows nothing about filters and never will. The playlist keeps its id across
 * refreshes (see `replaceTracks`), so Navidrome and anything else holding a
 * reference to it does not see the playlist vanish and come back.
 *
 * TAGS EXPAND DOWNWARD, both ways. Asking to include Blues includes Delta
 * blues; asking to EXCLUDE Blues excludes Delta blues too. Excluding a parent
 * while quietly keeping its children would be the more surprising of the two.
 *
 * There is no `rating` rule, though the plan listed one: nothing in Allegory
 * records a rating, and inventing a field here would mean inventing a way to
 * set it. Popularity stands in for the thing ratings were wanted for — see
 * `playCountMax`, which is how "nothing too obvious" is expressed. It is
 * deliberately NOT a tag: how often a song gets played is a fact about
 * listening, not a claim about the music.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TagTree } from './tags.ts'

/** How a track looks to the matcher. Assembled by the caller. */
export interface FilterTrack {
  id: string
  path: string
  title: string
  artist: string
  album: string
  artistId?: string
  /** The album's year, where the tags gave one. */
  year?: number
  /** When the file landed on disk (ms epoch). */
  addedAt: number
  /** Plays over the whole listen log. */
  playCount: number
  /** Approved tag assignments on this track. */
  tagIds: string[]
}

export type FilterSort = 'artist' | 'album' | 'added' | 'plays' | 'random'

export interface FilterRule {
  /** Carry any of these tags (or all, with `tagMatch: 'all'`). */
  includeTagIds?: string[]
  /** Carry none of these tags. */
  excludeTagIds?: string[]
  tagMatch?: 'any' | 'all'
  /** Expand include/exclude tags to their descendants. Default true. */
  includeDescendants?: boolean
  artistIds?: string[]
  /** Substring match on title, artist or album — case-insensitive. */
  text?: string
  yearMin?: number
  yearMax?: number
  /** The "nothing too obvious" lever: drop anything played more than this. */
  playCountMax?: number
  playCountMin?: number
  addedAfter?: number
  addedBefore?: number
  sort?: FilterSort
  /** Reproducible shuffle for `sort: 'random'`. */
  seed?: number
  limit?: number
}

export interface SavedFilter {
  id: string
  name: string
  rule: FilterRule
  createdAt: number
  updatedAt: number
  /** The `.m3u` this filter owns, once materialised. */
  playlistId?: string
  /** Rewrite the playlist whenever the library is rescanned. */
  autoRefresh?: boolean
  lastRunAt?: number
  lastCount?: number
}

const FILE_VERSION = 1

function newId(): string {
  return randomBytes(8).toString('hex')
}

/** Expand a set of tag ids to include everything beneath them. */
function expand(ids: string[] | undefined, tree: TagTree | null, on: boolean): Set<string> {
  const out = new Set<string>(ids ?? [])
  if (!on || !tree) return out
  for (const id of ids ?? []) {
    for (const d of tree.descendants(id)) out.add(d.id)
  }
  return out
}

/** A seeded shuffle, matching the one the mixes use so both feel the same. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const arr = [...items]
  let s = seed || 1
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function compare(a: FilterTrack, b: FilterTrack, sort: FilterSort): number {
  const byName = (x: string, y: string) =>
    x.localeCompare(y, undefined, { sensitivity: 'base' })
  switch (sort) {
    case 'added':
      return b.addedAt - a.addedAt // newest first
    case 'plays':
      return b.playCount - a.playCount // most-played first
    case 'album':
      return byName(a.album, b.album) || byName(a.title, b.title)
    case 'artist':
    default:
      return byName(a.artist, b.artist) || byName(a.album, b.album) || byName(a.title, b.title)
  }
}

/**
 * Answer a filter. Every rule is ANDed; an absent rule constrains nothing,
 * which is what makes a half-built filter in the UI still show something
 * sensible rather than nothing.
 */
export function evaluate(
  tracks: FilterTrack[],
  rule: FilterRule,
  tree: TagTree | null = null,
): FilterTrack[] {
  const descend = rule.includeDescendants !== false
  const include = expand(rule.includeTagIds, tree, descend)
  const exclude = expand(rule.excludeTagIds, tree, descend)
  const artists = new Set(rule.artistIds ?? [])
  const text = rule.text?.trim().toLowerCase() ?? ''
  const all = rule.tagMatch === 'all'

  const matched = tracks.filter((t) => {
    const tags = new Set(t.tagIds)

    if (include.size > 0) {
      if (all) {
        // With descendants on, "all of Blues and Jazz" means one tag from each
        // requested family — not the literal parent ids, which a track filed
        // under Delta blues would never carry.
        for (const id of rule.includeTagIds ?? []) {
          const family = expand([id], tree, descend)
          if (![...family].some((f) => tags.has(f))) return false
        }
      } else if (![...include].some((id) => tags.has(id))) {
        return false
      }
    }
    if (exclude.size > 0 && [...exclude].some((id) => tags.has(id))) return false
    if (artists.size > 0 && (!t.artistId || !artists.has(t.artistId))) return false
    if (text) {
      const hay = `${t.title}\n${t.artist}\n${t.album}`.toLowerCase()
      if (!hay.includes(text)) return false
    }
    // A track whose album has no year cannot satisfy a year bound. Treating
    // "unknown" as passing would quietly fill a 1967-1972 filter with undated
    // rips.
    if (rule.yearMin !== undefined && (t.year === undefined || t.year < rule.yearMin)) return false
    if (rule.yearMax !== undefined && (t.year === undefined || t.year > rule.yearMax)) return false
    if (rule.playCountMin !== undefined && t.playCount < rule.playCountMin) return false
    if (rule.playCountMax !== undefined && t.playCount > rule.playCountMax) return false
    if (rule.addedAfter !== undefined && t.addedAt < rule.addedAfter) return false
    if (rule.addedBefore !== undefined && t.addedAt > rule.addedBefore) return false
    return true
  })

  const sorted =
    rule.sort === 'random'
      ? seededShuffle(matched, rule.seed ?? 1)
      : [...matched].sort((a, b) => compare(a, b, rule.sort ?? 'artist'))

  return rule.limit !== undefined && rule.limit >= 0 ? sorted.slice(0, rule.limit) : sorted
}

// --- persistence -------------------------------------------------------------

export interface Filters {
  list(): Promise<SavedFilter[]>
  get(id: string): Promise<SavedFilter | undefined>
  create(name: string, rule: FilterRule): Promise<SavedFilter>
  update(
    id: string,
    patch: Partial<Pick<SavedFilter, 'name' | 'rule' | 'autoRefresh' | 'playlistId'>>,
  ): Promise<SavedFilter>
  remove(id: string): Promise<void>
  /** Record the outcome of a materialisation. */
  noteRun(id: string, count: number, playlistId: string): Promise<void>
  forget(): void
}

export function createFilters(cacheDir: string): Filters {
  const file = join(cacheDir, 'filters.json')
  let cache: SavedFilter[] | null = null

  async function load(): Promise<SavedFilter[]> {
    if (cache) return cache
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<{
        version: number
        filters: SavedFilter[]
      }>
      cache = Array.isArray(parsed.filters)
        ? parsed.filters.filter(
            (f): f is SavedFilter =>
              !!f && typeof f.id === 'string' && typeof f.name === 'string' && !!f.rule,
          )
        : []
    } catch {
      cache = []
    }
    return cache
  }

  async function save(filters: SavedFilter[]): Promise<void> {
    cache = filters
    await mkdir(cacheDir, { recursive: true })
    // Temp-then-rename: a filter cannot be rebuilt from the music, so a
    // half-written file is not an acceptable failure mode.
    const tmp = file + '.tmp'
    await writeFile(tmp, JSON.stringify({ version: FILE_VERSION, filters }, null, 2) + '\n', 'utf8')
    await rename(tmp, file)
  }

  async function mustGet(id: string): Promise<SavedFilter> {
    const f = (await load()).find((x) => x.id === id)
    if (!f) throw new Error('That filter no longer exists.')
    return f
  }

  return {
    async list() {
      return [...(await load())].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      )
    },
    async get(id) {
      return (await load()).find((f) => f.id === id)
    },
    async create(name, rule) {
      const clean = name.trim().replace(/\s+/g, ' ')
      if (!clean) throw new Error('A filter needs a name.')
      const filters = await load()
      if (filters.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`There is already a filter called “${clean}”.`)
      }
      const now = Date.now()
      const f: SavedFilter = { id: newId(), name: clean, rule, createdAt: now, updatedAt: now }
      await save([...filters, f])
      return f
    },
    async update(id, patch) {
      const filters = await load()
      const self = await mustGet(id)
      if (patch.name !== undefined) {
        const clean = patch.name.trim().replace(/\s+/g, ' ')
        if (!clean) throw new Error('A filter needs a name.')
        const clash = filters.find(
          (f) => f.id !== id && f.name.toLowerCase() === clean.toLowerCase(),
        )
        if (clash) throw new Error(`There is already a filter called “${clash.name}”.`)
        patch = { ...patch, name: clean }
      }
      const next = { ...self, ...patch, updatedAt: Date.now() }
      await save(filters.map((f) => (f.id === id ? next : f)))
      return next
    },
    async remove(id) {
      const filters = await load()
      // The materialised `.m3u` is deliberately left behind. It is an ordinary
      // playlist that people may have added to a queue or a client; deleting
      // someone's playlist because they tidied up a filter would be the worse
      // surprise. Detaching is what happens.
      await save(filters.filter((f) => f.id !== id))
    },
    async noteRun(id, count, playlistId) {
      const filters = await load()
      const self = await mustGet(id)
      const next = { ...self, playlistId, lastRunAt: Date.now(), lastCount: count }
      await save(filters.map((f) => (f.id === id ? next : f)))
    },
    forget() {
      cache = null
    },
  }
}
