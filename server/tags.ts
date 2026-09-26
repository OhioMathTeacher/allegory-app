/**
 * Hierarchical tags — a tree Todd owns, and per-track assignments to it.
 *
 * Storage follows the shape the rest of Allegory already uses rather than
 * introducing a database, and it is split deliberately between two places
 * because the two halves have different lifetimes:
 *
 *   - THE TREE lives in `.allegory-cache/tags.json`. It is a construct of its
 *     own ("Delta blues is a kind of Blues"), true regardless of which files
 *     happen to be on disk, so it does not belong next to any album.
 *   - THE ASSIGNMENTS live in a `.allegory-tags.json` sidecar inside each album
 *     folder, keyed by filename. That is the same trick `.allegory-artist.json`
 *     already uses: the data travels with the music, so moving or renaming an
 *     album folder — or moving the whole drive — carries the tagging with it.
 *
 * Why not key assignments on the track id: a track id is `sha1('track:' +
 * relative path)`, so it changes the moment a file moves. Allegory itself ships
 * the operations that move files (album edits, artist renames, album merges,
 * duplicate quarantine), and `listen-log.ts` already documents what that costs
 * — it denormalizes for exactly this reason. A table keyed on track id would
 * lose a season of tagging to one folder rename and say nothing.
 *
 * An assignment whose file is gone is KEPT, not collected. A rename that
 * orphans an entry is usually about to be undone, and deleting the tags on
 * sight would make the undo lossy; `orphansIn` surfaces them instead so the UI
 * can offer the choice.
 *
 * `source` records who asserted a tag, because that decides what may overwrite
 * it. `file` is the plan's missing fourth case: a genre frame written into the
 * audio file itself is neither the user's word nor a scrape, and calling it
 * either would make "never overwrite user-edited metadata" impossible to
 * reason about later. An `ai` assignment is a SUGGESTION until approved — it is
 * invisible to filtering until then, and rejecting it is remembered so the
 * model cannot propose it again.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** What a tag is *about*. Kept small and closed; `other` is the escape hatch. */
export type TagKind = 'genre' | 'mood' | 'era' | 'instrument' | 'context' | 'other'
export const TAG_KINDS: readonly TagKind[] = [
  'genre',
  'mood',
  'era',
  'instrument',
  'context',
  'other',
]

/** Who asserted an assignment. See the header on why `file` exists. */
export type TagSource = 'user' | 'file' | 'scraped' | 'ai'
export const TAG_SOURCES: readonly TagSource[] = ['user', 'file', 'scraped', 'ai']

export interface Tag {
  id: string
  name: string
  /** Null for a root tag. */
  parentId: string | null
  kind: TagKind
  createdAt: number
}

export interface TagAssignment {
  tagId: string
  source: TagSource
  /** How sure the asserter is, when it can say. Null for a human. */
  confidence?: number | null
  createdAt: number
  /** Set when an `ai` suggestion was accepted. Other sources need no approval. */
  approvedAt?: number
}

/** The `.allegory-tags.json` sidecar for one album folder. */
interface Sidecar {
  version: number
  /** Filename (not path) → what is on that file. */
  files: Record<string, { tags: TagAssignment[]; rejected?: string[] }>
}

const SIDECAR = '.allegory-tags.json'
const SIDECAR_VERSION = 1
const TREE_VERSION = 1

function newId(): string {
  return randomBytes(8).toString('hex')
}

/** Tag names compare case- and space-insensitively; `Delta Blues` is `delta blues`. */
function norm(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

// --- the tree, as pure functions over a flat list ---------------------------
//
// Everything below is deliberately free of I/O so the parts most worth testing
// — cycle prevention and the two traversals — can be tested on a literal.

/** A read-only view of the tag tree. */
export interface TagTree {
  all(): Tag[]
  get(id: string): Tag | undefined
  /** Direct children of `id`, or the roots for `null`. Name order. */
  children(id: string | null): Tag[]
  /** Ancestors of `id`, nearest parent first. Excludes `id`. */
  ancestors(id: string): Tag[]
  /** Every tag under `id`, breadth-first. Excludes `id`. */
  descendants(id: string): Tag[]
  /** Would making `parentId` the parent of `id` create a cycle? */
  wouldCycle(id: string, parentId: string | null): boolean
  /** `Roots › Blues › Delta blues` — for display and for disambiguation. */
  path(id: string): string
  /** A sibling of `parentId` already called `name`, if there is one. */
  findChild(parentId: string | null, name: string): Tag | undefined
}

function byName(a: Tag, b: Tag): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function buildTree(tags: Tag[]): TagTree {
  const byId = new Map(tags.map((t) => [t.id, t]))
  const kids = new Map<string | null, Tag[]>()
  for (const t of tags) {
    // A parent that is not in the list is treated as absent rather than
    // dangling, so one corrupt row cannot hide a whole subtree from the UI.
    const key = t.parentId && byId.has(t.parentId) ? t.parentId : null
    const list = kids.get(key) ?? []
    list.push(t)
    kids.set(key, list)
  }
  for (const list of kids.values()) list.sort(byName)

  function ancestors(id: string): Tag[] {
    const out: Tag[] = []
    // `seen` is not paranoia: the file on disk is editable by hand, and a
    // hand-made cycle must not hang the server on the next page load.
    const seen = new Set<string>([id])
    let cur = byId.get(id)?.parentId ?? null
    while (cur && !seen.has(cur)) {
      const t = byId.get(cur)
      if (!t) break
      out.push(t)
      seen.add(cur)
      cur = t.parentId
    }
    return out
  }

  function descendants(id: string): Tag[] {
    const out: Tag[] = []
    const seen = new Set<string>([id])
    const queue = [...(kids.get(id) ?? [])]
    while (queue.length > 0) {
      const t = queue.shift()!
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
      queue.push(...(kids.get(t.id) ?? []))
    }
    return out
  }

  return {
    all: () => [...tags].sort(byName),
    get: (id) => byId.get(id),
    children: (id) => [...(kids.get(id) ?? [])],
    ancestors,
    descendants,
    wouldCycle(id, parentId) {
      if (!parentId) return false
      // A tag cannot be its own parent, and cannot descend from itself.
      if (parentId === id) return true
      return ancestors(parentId).some((a) => a.id === id) || parentId === id
    },
    path(id) {
      const self = byId.get(id)
      if (!self) return ''
      return [...ancestors(id).reverse().map((t) => t.name), self.name].join(' › ')
    },
    findChild(parentId, name) {
      const target = norm(name)
      return (kids.get(parentId) ?? []).find((t) => norm(t.name) === target)
    },
  }
}

// --- the store ---------------------------------------------------------------

export interface TrackTags {
  /** Absolute path of the track. */
  path: string
  tags: TagAssignment[]
  rejected: string[]
}

/** One pending `ai` suggestion, with enough context for a review screen. */
export interface PendingSuggestion {
  path: string
  tagId: string
  confidence?: number | null
  createdAt: number
}

export interface Tags {
  tree(): Promise<TagTree>
  createTag(name: string, kind: TagKind, parentId?: string | null): Promise<Tag>
  renameTag(id: string, name: string): Promise<Tag>
  /** Throws if the move would make `id` its own ancestor. */
  reparentTag(id: string, parentId: string | null): Promise<Tag>
  /**
   * Delete a tag. Its children rise to its parent rather than vanishing, and
   * assignments to it are dropped from every sidecar in `dirs`.
   */
  removeTag(id: string, dirs: string[]): Promise<void>
  /** Fold `sourceId` into `targetId`: assignments move, children reparent. */
  mergeTags(sourceId: string, targetId: string, dirs: string[]): Promise<void>

  tagsForTrack(path: string): Promise<TrackTags>
  /** Add one tag to many tracks. Returns how many files actually changed. */
  addToTracks(
    paths: string[],
    tagId: string,
    source: TagSource,
    confidence?: number | null,
  ): Promise<number>
  /** Remove one tag from many tracks. Returns how many files changed. */
  removeFromTracks(paths: string[], tagId: string): Promise<number>
  /** Accept a pending `ai` suggestion. */
  approve(path: string, tagId: string): Promise<void>
  /** Reject a tag, and remember it so `ai` cannot propose it again. */
  reject(path: string, tagId: string): Promise<void>
  /** Every pending `ai` suggestion across `dirs`. */
  pending(dirs: string[]): Promise<PendingSuggestion[]>

  /**
   * Paths carrying `tagId`. Descendants are included by default, because
   * asking for Blues and not being shown the Delta blues you filed under it is
   * the whole reason the tree exists.
   */
  tracksWithTag(
    tagId: string,
    dirs: string[],
    opts?: { includeDescendants?: boolean; includeUnapproved?: boolean },
  ): Promise<string[]>
  /** Assignment counts per tag id, for the tree UI. Approved only. */
  counts(dirs: string[]): Promise<Record<string, number>>
  /** Sidecar entries in `dir` whose file is no longer present. */
  orphansIn(dir: string, presentFilenames: string[]): Promise<string[]>
  /**
   * Carry assignments across a file move. Folder moves need nothing — the
   * sidecar travels with the folder — but combining albums moves individual
   * files between folders and renames them on collision, which is the one
   * operation that would otherwise strand the tagging. Returns how many
   * entries moved.
   */
  relocate(moves: { from: string; to: string }[]): Promise<number>

  /**
   * Fold the genre frames already on disk into the tree, as root-level tags
   * with source `file`. Idempotent: a second run over the same tracks creates
   * nothing and changes nothing.
   */
  migrateGenres(tracks: { path: string; genres?: string[] }[]): Promise<{
    tagsCreated: number
    filesTagged: number
  }>
  /** Drop the in-memory sidecar cache — used after the music dir changes. */
  forget(): void
}

export function createTags(cacheDir: string): Tags {
  const treeFile = join(cacheDir, 'tags.json')

  let treeCache: Tag[] | null = null
  // Sidecars are read once per folder per run and written through, so a tag
  // sweep over a large library costs one read per album rather than one per
  // question asked of it.
  const sidecars = new Map<string, Sidecar>()

  async function loadTree(): Promise<Tag[]> {
    if (treeCache) return treeCache
    try {
      const parsed = JSON.parse(await readFile(treeFile, 'utf8')) as Partial<{
        version: number
        tags: Tag[]
      }>
      treeCache = Array.isArray(parsed.tags)
        ? parsed.tags.filter(
            (t): t is Tag => !!t && typeof t.id === 'string' && typeof t.name === 'string',
          )
        : []
    } catch {
      treeCache = []
    }
    return treeCache
  }

  async function saveTree(tags: Tag[]): Promise<void> {
    treeCache = tags
    await mkdir(cacheDir, { recursive: true })
    // Written to a temp file and renamed: the tree is the one thing here that
    // cannot be rebuilt from the music, so a half-written file is not an
    // acceptable failure mode.
    const tmp = treeFile + '.tmp'
    const body = JSON.stringify({ version: TREE_VERSION, tags }, null, 2) + '\n'
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, treeFile)
  }

  async function loadSidecar(dir: string): Promise<Sidecar> {
    const hit = sidecars.get(dir)
    if (hit) return hit
    let sc: Sidecar = { version: SIDECAR_VERSION, files: {} }
    try {
      const parsed = JSON.parse(await readFile(join(dir, SIDECAR), 'utf8')) as Partial<Sidecar>
      if (parsed && typeof parsed.files === 'object' && parsed.files) {
        sc = { version: SIDECAR_VERSION, files: parsed.files }
      }
    } catch {
      // Missing or unreadable — an empty sidecar, which is the common case.
    }
    sidecars.set(dir, sc)
    return sc
  }

  async function saveSidecar(dir: string, sc: Sidecar): Promise<void> {
    sidecars.set(dir, sc)
    const file = join(dir, SIDECAR)
    const body = JSON.stringify({ version: SIDECAR_VERSION, files: sc.files }, null, 2) + '\n'
    const tmp = file + '.tmp'
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
  }

  function entryFor(sc: Sidecar, name: string): { tags: TagAssignment[]; rejected?: string[] } {
    const e = sc.files[name]
    if (e && Array.isArray(e.tags)) return e
    const fresh = { tags: [], rejected: [] as string[] }
    sc.files[name] = fresh
    return fresh
  }

  /** An assignment counts for filtering when it is not an unapproved AI guess. */
  function isApproved(a: TagAssignment): boolean {
    return a.source !== 'ai' || typeof a.approvedAt === 'number'
  }

  /** Walk every sidecar in `dirs`, yielding one absolute path at a time. */
  async function sweep(
    dirs: string[],
    visit: (path: string, entry: { tags: TagAssignment[]; rejected?: string[] }) => void,
  ): Promise<void> {
    for (const dir of dirs) {
      const sc = await loadSidecar(dir)
      for (const [name, entry] of Object.entries(sc.files)) {
        if (!entry || !Array.isArray(entry.tags)) continue
        visit(join(dir, name), entry)
      }
    }
  }

  /** Apply `mutate` to each named file's entry, saving folders that changed. */
  async function editPaths(
    paths: string[],
    mutate: (entry: { tags: TagAssignment[]; rejected?: string[] }) => boolean,
  ): Promise<number> {
    const byDir = new Map<string, string[]>()
    for (const p of paths) {
      const dir = dirname(p)
      const list = byDir.get(dir) ?? []
      list.push(basename(p))
      byDir.set(dir, list)
    }
    let changed = 0
    for (const [dir, names] of byDir) {
      const sc = await loadSidecar(dir)
      let dirty = false
      for (const name of names) {
        if (mutate(entryFor(sc, name))) {
          dirty = true
          changed++
        }
      }
      if (dirty) await saveSidecar(dir, sc)
    }
    return changed
  }

  async function mustGet(id: string): Promise<Tag> {
    const t = buildTree(await loadTree()).get(id)
    if (!t) throw new Error('That tag no longer exists.')
    return t
  }

  async function tree(): Promise<TagTree> {
    return buildTree(await loadTree())
  }

  async function createTag(
    name: string,
    kind: TagKind,
    parentId: string | null = null,
  ): Promise<Tag> {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) throw new Error('A tag needs a name.')
    const tags = await loadTree()
    const t = buildTree(tags)
    if (parentId && !t.get(parentId)) throw new Error('That parent tag no longer exists.')
    // Creating a tag that is already there returns it, so the migration and any
    // retried request are both idempotent.
    const existing = t.findChild(parentId, clean)
    if (existing) return existing
    const tag: Tag = {
      id: newId(),
      name: clean,
      parentId: parentId ?? null,
      kind,
      createdAt: Date.now(),
    }
    await saveTree([...tags, tag])
    return tag
  }

  async function renameTag(id: string, name: string): Promise<Tag> {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) throw new Error('A tag needs a name.')
    const tags = await loadTree()
    const self = await mustGet(id)
    const clash = buildTree(tags).findChild(self.parentId, clean)
    if (clash && clash.id !== id) {
      throw new Error(`There is already a tag called \u201c${clash.name}\u201d here.`)
    }
    await saveTree(tags.map((t) => (t.id === id ? { ...t, name: clean } : t)))
    return { ...self, name: clean }
  }

  async function reparentTag(id: string, parentId: string | null): Promise<Tag> {
    const tags = await loadTree()
    const t = buildTree(tags)
    const self = await mustGet(id)
    if (parentId && !t.get(parentId)) throw new Error('That parent tag no longer exists.')
    if (t.wouldCycle(id, parentId)) throw new Error('A tag cannot be moved inside itself.')
    const clash = t.findChild(parentId ?? null, self.name)
    if (clash && clash.id !== id) {
      throw new Error(`There is already a tag called \u201c${clash.name}\u201d there.`)
    }
    await saveTree(tags.map((x) => (x.id === id ? { ...x, parentId: parentId ?? null } : x)))
    return { ...self, parentId: parentId ?? null }
  }

  async function tracksWithTag(
    tagId: string,
    dirs: string[],
    opts: { includeDescendants?: boolean; includeUnapproved?: boolean } = {},
  ): Promise<string[]> {
    const { includeDescendants = true, includeUnapproved = false } = opts
    const t = buildTree(await loadTree())
    const wanted = new Set<string>([tagId])
    if (includeDescendants) for (const d of t.descendants(tagId)) wanted.add(d.id)
    const out: string[] = []
    await sweep(dirs, (path, entry) => {
      const hit = entry.tags.some(
        (a) => wanted.has(a.tagId) && (includeUnapproved || isApproved(a)),
      )
      if (hit) out.push(path)
    })
    return out.sort()
  }

  async function addToTracks(
    paths: string[],
    tagId: string,
    source: TagSource,
    confidence: number | null = null,
  ): Promise<number> {
    await mustGet(tagId)
    const now = Date.now()
    return editPaths(paths, (entry) => {
      if (entry.tags.some((a) => a.tagId === tagId)) return false
      // A tag the user already rejected here is not re-proposed by a model. A
      // deliberate human add overrides that and clears the rejection.
      const rejected = entry.rejected ?? []
      if (rejected.includes(tagId)) {
        if (source === 'ai') return false
        entry.rejected = rejected.filter((r) => r !== tagId)
      }
      entry.tags.push({
        tagId,
        source,
        confidence,
        createdAt: now,
        ...(source === 'ai' ? {} : { approvedAt: now }),
      })
      return true
    })
  }

  async function removeFromTracks(paths: string[], tagId: string): Promise<number> {
    return editPaths(paths, (entry) => {
      if (!entry.tags.some((a) => a.tagId === tagId)) return false
      entry.tags = entry.tags.filter((a) => a.tagId !== tagId)
      return true
    })
  }

  async function removeTag(id: string, dirs: string[]): Promise<void> {
    const tags = await loadTree()
    const self = await mustGet(id)
    const carriers = await tracksWithTag(id, dirs, {
      includeDescendants: false,
      includeUnapproved: true,
    })
    // Children rise to the deleted tag's parent. Dropping a subtree because
    // someone tidied one level of it would be a very expensive surprise.
    await saveTree(
      tags
        .filter((t) => t.id !== id)
        .map((t) => (t.parentId === id ? { ...t, parentId: self.parentId } : t)),
    )
    await removeFromTracks(carriers, id)
  }

  async function mergeTags(sourceId: string, targetId: string, dirs: string[]): Promise<void> {
    if (sourceId === targetId) return
    const tags = await loadTree()
    const t = buildTree(tags)
    const source = await mustGet(sourceId)
    if (!t.get(targetId)) throw new Error('That tag no longer exists.')
    const carriers = await tracksWithTag(sourceId, dirs, {
      includeDescendants: false,
      includeUnapproved: true,
    })
    // Merging a tag that has children would orphan the branch, so they are
    // lifted to the source's parent rather than deleted with it.
    await saveTree(
      tags
        .filter((x) => x.id !== sourceId)
        .map((x) => (x.parentId === sourceId ? { ...x, parentId: source.parentId } : x)),
    )
    await editPaths(carriers, (entry) => {
      const from = entry.tags.find((a) => a.tagId === sourceId)
      if (!from) return false
      entry.tags = entry.tags.filter((a) => a.tagId !== sourceId)
      // The target may already be there; keep the stronger claim rather than
      // letting a merge downgrade a hand-made tag to an unapproved AI guess.
      const onto = entry.tags.find((a) => a.tagId === targetId)
      if (!onto) {
        entry.tags.push({ ...from, tagId: targetId })
      } else if (onto.source === 'ai' && from.source !== 'ai') {
        onto.source = from.source
        onto.approvedAt = from.approvedAt ?? onto.approvedAt
      }
      return true
    })
  }

  async function tagsForTrack(path: string): Promise<TrackTags> {
    const sc = await loadSidecar(dirname(path))
    const e = sc.files[basename(path)]
    return {
      path,
      tags: e?.tags?.filter((a) => a && typeof a.tagId === 'string') ?? [],
      rejected: e?.rejected ?? [],
    }
  }

  async function approve(path: string, tagId: string): Promise<void> {
    await editPaths([path], (entry) => {
      const a = entry.tags.find((x) => x.tagId === tagId)
      if (!a || typeof a.approvedAt === 'number') return false
      a.approvedAt = Date.now()
      return true
    })
  }

  async function reject(path: string, tagId: string): Promise<void> {
    await editPaths([path], (entry) => {
      entry.tags = entry.tags.filter((a) => a.tagId !== tagId)
      const rejected = entry.rejected ?? []
      if (rejected.includes(tagId)) return true
      entry.rejected = [...rejected, tagId]
      return true
    })
  }

  async function pending(dirs: string[]): Promise<PendingSuggestion[]> {
    const out: PendingSuggestion[] = []
    await sweep(dirs, (path, entry) => {
      for (const a of entry.tags) {
        if (a.source === 'ai' && typeof a.approvedAt !== 'number') {
          out.push({ path, tagId: a.tagId, confidence: a.confidence, createdAt: a.createdAt })
        }
      }
    })
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async function counts(dirs: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    await sweep(dirs, (_path, entry) => {
      for (const a of entry.tags) {
        if (!isApproved(a)) continue
        out[a.tagId] = (out[a.tagId] ?? 0) + 1
      }
    })
    return out
  }

  async function orphansIn(dir: string, presentFilenames: string[]): Promise<string[]> {
    const present = new Set(presentFilenames)
    const sc = await loadSidecar(dir)
    return Object.keys(sc.files)
      .filter((name) => !present.has(name))
      .sort()
  }

  async function relocate(moves: { from: string; to: string }[]): Promise<number> {
    let carried = 0
    const dirty = new Set<string>()
    for (const { from, to } of moves) {
      const fromDir = dirname(from)
      const toDir = dirname(to)
      const fromSc = await loadSidecar(fromDir)
      const entry = fromSc.files[basename(from)]
      // Nothing tagged on this file: the overwhelmingly common case, and not
      // something to write a sidecar for.
      if (!entry || !Array.isArray(entry.tags)) continue
      if (fromDir === toDir && basename(from) === basename(to)) continue
      delete fromSc.files[basename(from)]
      dirty.add(fromDir)
      const toSc = fromDir === toDir ? fromSc : await loadSidecar(toDir)
      const existing = toSc.files[basename(to)]
      if (existing && Array.isArray(existing.tags)) {
        // The destination name was already tagged (a collision the mover
        // renamed around, or a re-run). Union rather than overwrite.
        const seen = new Set(existing.tags.map((a) => a.tagId))
        for (const a of entry.tags) if (!seen.has(a.tagId)) existing.tags.push(a)
        const rejected = new Set([...(existing.rejected ?? []), ...(entry.rejected ?? [])])
        existing.rejected = [...rejected]
      } else {
        toSc.files[basename(to)] = entry
      }
      dirty.add(toDir)
      carried++
    }
    for (const dir of dirty) {
      const sc = sidecars.get(dir)
      if (sc) await saveSidecar(dir, sc)
    }
    return carried
  }

  async function migrateGenres(
    tracks: { path: string; genres?: string[] }[],
  ): Promise<{ tagsCreated: number; filesTagged: number }> {
    // One pass to build the vocabulary, so the tree file is written a handful of
    // times rather than once per track.
    const wanted = new Map<string, string>() // normalised → as first written
    for (const t of tracks) {
      for (const g of t.genres ?? []) {
        const clean = g.trim().replace(/\s+/g, ' ')
        if (clean && !wanted.has(norm(clean))) wanted.set(norm(clean), clean)
      }
    }

    let tagsCreated = 0
    const idFor = new Map<string, string>()
    for (const [key, name] of wanted) {
      // Flat existing genres become root-level tags, per the plan. But a genre
      // Todd has since filed under a parent must not be duplicated back at the
      // root, so an existing tag of that name is looked for anywhere in the
      // tree before creating one.
      const anywhere = buildTree(await loadTree()).all().find((t) => norm(t.name) === key)
      if (anywhere) {
        idFor.set(key, anywhere.id)
        continue
      }
      idFor.set(key, (await createTag(name, 'genre', null)).id)
      tagsCreated++
    }

    // Grouped by folder and saved once per folder. Going through addToTracks
    // per track would rewrite a sidecar once per track per genre, which on a
    // real library is thousands of writes to say one thing.
    const byDir = new Map<string, { path: string; ids: string[] }[]>()
    for (const t of tracks) {
      const ids = [
        ...new Set(
          (t.genres ?? []).map((g) => idFor.get(norm(g))).filter((x): x is string => !!x),
        ),
      ]
      if (ids.length === 0) continue
      const dir = dirname(t.path)
      const list = byDir.get(dir) ?? []
      list.push({ path: t.path, ids })
      byDir.set(dir, list)
    }

    const now = Date.now()
    let filesTagged = 0
    for (const [dir, items] of byDir) {
      const sc = await loadSidecar(dir)
      let dirty = false
      for (const { path, ids } of items) {
        const entry = entryFor(sc, basename(path))
        let touched = false
        for (const tagId of ids) {
          if (entry.tags.some((a) => a.tagId === tagId)) continue
          // A genre the user has already dismissed here is not re-added by a
          // rescan — the same promise `hiddenTags` makes in the artist sidecar.
          if ((entry.rejected ?? []).includes(tagId)) continue
          entry.tags.push({ tagId, source: 'file', confidence: null, createdAt: now, approvedAt: now })
          touched = true
        }
        if (touched) {
          dirty = true
          filesTagged++
        }
      }
      if (dirty) await saveSidecar(dir, sc)
    }
    return { tagsCreated, filesTagged }
  }

  function forget(): void {
    sidecars.clear()
    treeCache = null
  }

  return {
    tree,
    createTag,
    renameTag,
    reparentTag,
    removeTag,
    mergeTags,
    tagsForTrack,
    addToTracks,
    removeFromTracks,
    approve,
    reject,
    pending,
    tracksWithTag,
    counts,
    orphansIn,
    relocate,
    migrateGenres,
    forget,
  }
}

/** Where the scanner should not look: the tag sidecar is ours, not media. */
export const TAGS_SIDECAR_NAME = SIDECAR
