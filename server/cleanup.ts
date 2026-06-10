/**
 * Library-cleanup analysis — ported from the standalone jellyfin-music-cleanup
 * routines (duplicate_finder.py / app.py) and adapted to Allegory's local,
 * folder-backed library. Pure functions: given the artist list, return
 *   - duplicate / variant artist groups (so the user can merge them), and
 *   - "junk" artists that look like import artifacts.
 *
 * Merging itself reuses the existing renameArtist (rewrites artist /
 * album_artist tags on every track and folds the folder into the target).
 */

export interface CleanupArtist {
  id: string
  name: string
  albumCount: number
  trackCount: number
}

export interface DuplicateGroup {
  /** Suggested name to keep. */
  canonical: string
  members: CleanupArtist[]
  score: number
}

export interface JunkArtist extends CleanupArtist {
  reasons: string[]
}

export interface CleanupReport {
  duplicateGroups: DuplicateGroup[]
  junkArtists: JunkArtist[]
}

// --- fuzzy string matching (a small port of rapidfuzz's fuzz.ratio / -------
//     token_sort_ratio: both are 2·LCS / (len(a)+len(b)) · 100). -----------
function lcsLength(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0 || n === 0) return 0
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

function ratio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 100
  return (2 * lcsLength(a, b)) / (a.length + b.length) * 100
}

function sortTokens(s: string): string {
  return s.split(/\s+/).filter(Boolean).sort().join(' ')
}

function tokenSortRatio(a: string, b: string): number {
  return ratio(sortTokens(a), sortTokens(b))
}

// --- name normalisation (so "AC/DC" ≈ "AC-DC", "Dylan, Bob" ≈ "Bob Dylan") -
const RELATION_WORDS = ['the', 'and', '&', 'feat', 'with']

export function normalizeName(raw: string): string {
  let name = raw.trim()

  // "Last, First" → "First Last" (but not "Bob Dylan & The Band"-style).
  if (name.includes(', ') && (name.match(/,/g) ?? []).length === 1) {
    const parts = name.split(', ')
    if (parts.length === 2 && !RELATION_WORDS.some((w) => parts[1].toLowerCase().includes(w))) {
      name = `${parts[1]} ${parts[0]}`
    }
  }

  name = name.toLowerCase()
  name = name.replace(/\s+and\s+/g, ' & ')
  name = name.replace(/\s+the\s+/g, ' ')
  name = name.replace(/^the\s+/, '')
  // Drop "(feat. …)" / "ft. …" credits.
  name = name.replace(/\s*\((?:feat|ft)\.[^)]*\)/gi, '')
  name = name.replace(/\s*(?:feat|ft)\..*$/gi, '')
  // Strip punctuation so "AC/DC" === "AC-DC" === "AC DC".
  name = name.replace(/[/\-_.]+/g, ' ')
  name = name.replace(/\s+/g, ' ').trim()
  return name
}

/** Of a set of variant names, pick the best one to keep. */
export function suggestCanonical(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  const scored = names.map((name) => {
    let score = 0
    if (!name.includes(', ')) score += 10 // prefer "Bob Dylan" over "Dylan, Bob"
    score += name.length / 10
    if (/\s+(and|&)\s+the\s+/i.test(name)) score += 5
    if (name === toTitleCase(name)) score += 3
    if (name !== name.toUpperCase() && name !== name.toLowerCase()) score += 2
    return { score, name }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].name
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

// --- junk-artist rules -----------------------------------------------------
const JUNK_WHITELIST = new Set([
  'a', 'x', 'u2', 'l7', 'oz', 'p!nk', 'sia', 'elo', 'reo', 'bad', 'yes',
  'ratt', 'tool', 'cake', 'hole', 'bush', 'live', 'ride', 'wire', 'gang',
  '2wo', '3eb', '10cc', 'inxs', 'nofx', 'mxpx', 'acdc', 'ac/dc', 'ac-dc',
])

const JUNK_RULES: { test: RegExp; label: string }[] = [
  { test: /^\d+$/, label: 'numeric only' },
  { test: /^.{1,2}$/, label: '≤2 characters' },
  { test: /^\d/, label: 'starts with a digit' },
  { test: /^[A-Z0-9]{12,}$/, label: 'long all-caps string' },
  {
    test: /\b(albums?|collections?|playlists?|discs?|volumes?|vol\.|tracks?|songs?|greatest hits|best of|anthology|box ?set|rarities|singles?|b-sides?)\b/i,
    label: 'looks like a category/label',
  },
]

export function analyzeArtists(artists: CleanupArtist[]): CleanupReport {
  // --- duplicate / variant groups ---
  const byNorm = new Map<string, CleanupArtist[]>()
  for (const a of artists) {
    const key = normalizeName(a.name)
    const list = byNorm.get(key)
    if (list) list.push(a)
    else byNorm.set(key, [a])
  }

  const groups: DuplicateGroup[] = []
  const grouped = new Set<string>()

  // Exact normalized matches first (e.g. "Dylan, Bob" ≈ "Bob Dylan").
  for (const list of byNorm.values()) {
    if (list.length > 1) {
      groups.push({ canonical: suggestCanonical(list.map((a) => a.name)), members: list, score: 100 })
      for (const a of list) grouped.add(a.id)
    }
  }

  // Then fuzzy matches over the rest. The standalone tool used 80, but on
  // short artist names that misfires badly ("Bangles, The" ≈ "Beatles, The"),
  // and it leaned on a human to deselect. We surface these only as review
  // suggestions, and use a stricter cut so the list stays trustworthy.
  const THRESHOLD = 90
  const remaining = artists.filter((a) => !grouped.has(a.id))
  const norms = remaining.map((a) => normalizeName(a.name))
  const used = new Set<string>()
  for (let i = 0; i < remaining.length; i++) {
    if (used.has(remaining[i].id)) continue
    const members = [remaining[i]]
    const scores: number[] = []
    used.add(remaining[i].id)
    for (let j = i + 1; j < remaining.length; j++) {
      if (used.has(remaining[j].id)) continue
      const best = Math.max(ratio(norms[i], norms[j]), tokenSortRatio(norms[i], norms[j]))
      if (best >= THRESHOLD) {
        members.push(remaining[j])
        scores.push(best)
        used.add(remaining[j].id)
      }
    }
    if (members.length > 1) {
      groups.push({
        canonical: suggestCanonical(members.map((a) => a.name)),
        members,
        score: scores.reduce((s, x) => s + x, 0) / scores.length,
      })
    }
  }
  groups.sort((a, b) => b.members.reduce((s, m) => s + m.trackCount, 0) - a.members.reduce((s, m) => s + m.trackCount, 0))

  // --- junk artists ---
  const junkArtists: JunkArtist[] = []
  for (const a of artists) {
    if (JUNK_WHITELIST.has(a.name.toLowerCase())) continue
    const reasons = JUNK_RULES.filter((r) => r.test.test(a.name)).map((r) => r.label)
    if (reasons.length > 0) junkArtists.push({ ...a, reasons })
  }

  return { duplicateGroups: groups, junkArtists }
}
