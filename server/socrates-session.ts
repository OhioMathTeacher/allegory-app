/**
 * The draft-and-revise loop behind a Socrates playlist.
 *
 * The plan described Phase 3 as making an existing loop tag-aware. There was no
 * loop: Socrates emitted one block of {artist, album, track} guesses, the client
 * matched them against the library as best it could, and that was the end of it.
 * Two things follow from that, and they are the whole design here.
 *
 * FIRST, Socrates now picks from real candidates. The old prompt shipped artist
 * and album names only, so the model had to GUESS which songs were on a record —
 * and an unlucky guess vanished silently in the resolver. `selectCandidates`
 * retrieves actual tracks, with their tags and play counts, so the model is
 * choosing rather than recalling. A misremembered tracklist can no longer cost
 * you a song.
 *
 * SECOND, rejection is information. When Todd drops tracks from a draft,
 * `adjustWeights` turns that into tag-level weights, using the two rules from
 * the plan:
 *
 *   - Rejections concentrated in one tag down-weight that tag.
 *   - Rejections spread across sibling tags down-weight their PARENT. Turning
 *     down one Delta blues track says something about that track. Turning down
 *     a Delta blues and a Chicago blues says something about Blues, and only
 *     looking at the children would miss it.
 *
 * Weights are multiplicative and floored rather than allowed to reach zero, so a
 * tag that has been rejected a few times becomes unlikely without becoming
 * impossible — a later revision can still surface it if nothing else fits.
 *
 * POPULARITY IS NOT A TAG. "Too common" is a fact about listening, not a claim
 * about the music, so it is a separate ceiling with its own threshold
 * (`playCountMax`). Filing it as a tag would have made "too common" inherit and
 * expand through the tree, which is nonsense.
 */
import type { Tag, TagTree } from './tags.ts'
import type { FilterTrack } from './filters.ts'

/** Each rejection multiplies the offending tag's weight by this. */
const REJECT_FACTOR = 0.55
/** Weights floor here rather than reaching zero — unlikely, not banned. */
export const MIN_WEIGHT = 0.05
/** How many distinct siblings must be rejected before the parent is implicated. */
const SIBLING_THRESHOLD = 2

export type TagWeights = Record<string, number>

export interface WeightInput {
  tree: TagTree
  /** The tag ids carried by each rejected track, one array per track. */
  rejected: string[][]
  /** Weights so far. Absent means every tag starts at 1. */
  current?: TagWeights
}

/**
 * Fold a round of rejections into the tag weights.
 *
 * Returns only the tags whose weight has moved, so a session's state stays small
 * and a weight of 1 never has to be written down.
 */
export function adjustWeights({ tree, rejected, current = {} }: WeightInput): TagWeights {
  const next: TagWeights = { ...current }
  const bump = (id: string) => {
    next[id] = Math.max(MIN_WEIGHT, (next[id] ?? 1) * REJECT_FACTOR)
  }

  // How many rejected tracks carried each tag.
  const tally = new Map<string, number>()
  for (const tags of rejected) {
    for (const id of new Set(tags)) tally.set(id, (tally.get(id) ?? 0) + 1)
  }

  for (const [id, n] of tally) {
    for (let i = 0; i < n; i++) bump(id)
  }

  // Rejections spread across siblings implicate the parent. Counted on DISTINCT
  // children, not on rejections: three tracks all filed under Delta blues say
  // nothing about Blues, but one Delta and one Chicago do.
  const childrenByParent = new Map<string, Set<string>>()
  for (const id of tally.keys()) {
    const parent = tree.get(id)?.parentId
    if (!parent) continue
    const set = childrenByParent.get(parent) ?? new Set<string>()
    set.add(id)
    childrenByParent.set(parent, set)
  }
  for (const [parent, kids] of childrenByParent) {
    if (kids.size >= SIBLING_THRESHOLD) bump(parent)
  }

  return next
}

export interface CandidateQuery {
  /** Seed tags. Candidates must carry one of these, or of their descendants. */
  tagIds?: string[]
  weights?: TagWeights
  /** Paths already spoken for — pinned, rejected, or already in the draft. */
  excludePaths?: string[]
  /** Drop anything played more than this. The "nothing too obvious" lever. */
  playCountMax?: number
  limit?: number
  /** Reproducible tie-breaking, so "revise" varies without being random. */
  seed?: number
}

export interface Candidate {
  trackId: string
  path: string
  title: string
  artist: string
  album: string
  year?: number
  playCount: number
  /** Tag NAMES, not ids — this goes to a language model. */
  tags: string[]
  /** What the weighting made of it. Higher is more wanted. */
  score: number
}

/** Deterministic jitter in [0,1), so ties break stably for a given seed. */
function jitter(key: string, seed: number): number {
  let h = seed || 1
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) & 0x7fffffff
  }
  return (h % 1000) / 1000
}

/**
 * Pull the tracks worth offering, best first.
 *
 * A track's score is the mean weight of its tags that the seed actually asked
 * for. Mean rather than sum, or a track carrying six tags would outrank a
 * better-fitting one carrying two simply for being busier.
 */
export function selectCandidates(
  tracks: FilterTrack[],
  tree: TagTree | null,
  query: CandidateQuery = {},
): Candidate[] {
  const { weights = {}, limit = 60, seed = 1 } = query
  const excluded = new Set(query.excludePaths ?? [])

  // Seed tags expand downward: asking for Blues offers what is filed beneath it.
  const wanted = new Set<string>(query.tagIds ?? [])
  if (tree) {
    for (const id of query.tagIds ?? []) {
      for (const d of tree.descendants(id)) wanted.add(d.id)
    }
  }

  const named = (id: string) => tree?.get(id)?.name ?? id

  const scored: Candidate[] = []
  for (const t of tracks) {
    if (excluded.has(t.path)) continue
    if (query.playCountMax !== undefined && t.playCount > query.playCountMax) continue

    const hits = wanted.size > 0 ? t.tagIds.filter((id) => wanted.has(id)) : t.tagIds
    // With a seed, a track carrying none of the wanted tags is not a candidate.
    if (wanted.size > 0 && hits.length === 0) continue

    const relevant = hits.length > 0 ? hits : t.tagIds
    const score =
      relevant.length === 0
        ? 1 // untagged, and nothing was asked for: neutral rather than excluded
        : relevant.reduce((sum, id) => sum + (weights[id] ?? 1), 0) / relevant.length

    // A tag beaten down to the floor is a strong signal, not a mild one.
    if (score <= MIN_WEIGHT) continue

    scored.push({
      trackId: t.id,
      path: t.path,
      title: t.title,
      artist: t.artist,
      album: t.album,
      year: t.year,
      playCount: t.playCount,
      tags: t.tagIds.map(named),
      score,
    })
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      jitter(a.path, seed) - jitter(b.path, seed) ||
      a.path.localeCompare(b.path),
  )
  return scored.slice(0, Math.max(0, limit))
}

/**
 * The slice of the tag tree worth sending to the model: the seed tags, what is
 * beneath them, and the ancestors that give them context. Not the whole tree —
 * a few hundred tags is a lot of prompt to spend on branches nobody asked about.
 */
export function compactSubtree(tree: TagTree, tagIds: string[]): Tag[] {
  const out = new Map<string, Tag>()
  for (const id of tagIds) {
    const self = tree.get(id)
    if (!self) continue
    out.set(id, self)
    for (const a of tree.ancestors(id)) out.set(a.id, a)
    for (const d of tree.descendants(id)) out.set(d.id, d)
  }
  // No seed at all: the roots alone, so the model can see what kinds of thing
  // exist without being handed the entire vocabulary.
  if (out.size === 0) for (const r of tree.children(null)) out.set(r.id, r)
  return [...out.values()]
}

/** Render the subtree as indented lines — cheaper in tokens than JSON. */
export function renderSubtree(tags: Tag[]): string {
  const byParent = new Map<string | null, Tag[]>()
  const present = new Set(tags.map((t) => t.id))
  for (const t of tags) {
    const key = t.parentId && present.has(t.parentId) ? t.parentId : null
    const list = byParent.get(key) ?? []
    list.push(t)
    byParent.set(key, list)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }
  const lines: string[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const t of byParent.get(parent) ?? []) {
      lines.push(`${'  '.repeat(depth)}- ${t.name}`)
      walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join('\n') || '(no tags yet)'
}
