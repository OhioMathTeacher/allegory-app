/**
 * Matching an outside artist name to one in this library.
 *
 * Harder than string equality, because folder-derived names carry conventions
 * the outside world doesn't share:
 *
 *   "Dio, Ronnie James"   vs Last.fm's "Dio"
 *   "Gillan, Ian"         vs "Ian Gillan"
 *   "Malmsteen, Yngwie"   vs "Yngwie Malmsteen"
 *   "WASP"                vs "W.A.S.P."
 *
 * Three tiers, most precise first — the same ladder `src/lib/socrates-actions.ts`
 * uses to resolve proposed playlist tracks (see 5bcafa0). It's duplicated rather
 * than shared because that module is client-side and this one runs in the
 * server; if a third caller appears, promote it to a shared module.
 *
 * Note that separators are DELETED, not turned into spaces. That's what lets
 * "W.A.S.P." meet "WASP" — replacing them with spaces yields "w a s p", which
 * matches nothing.
 */

const SEPARATORS = /[\s_\-./&'":!?,()[\]]+/g

/** Lowercase, drop a leading "the", strip separators and punctuation. */
export function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(SEPARATORS, '')
}

/**
 * Order-insensitive form: tokens sorted, then joined. Reconciles a
 * "Sort, Name" folder with "Name Sort" — "Gillan, Ian" and "Ian Gillan" both
 * collapse to "gillanian".
 */
export function normSorted(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .split(SEPARATORS)
    .filter(Boolean)
    .sort()
    .join('')
}

/** Lowercased word tokens, "the" dropped — for subset matching. */
export function nameTokens(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .split(SEPARATORS)
    .filter(Boolean)
}

/**
 * An index over the library's artists that can be asked "do we have this?"
 * Build it once per request; `find` is then O(1) for the first two tiers.
 */
export function createArtistIndex<T extends { id: string; name: string }>(
  artists: T[],
) {
  const byNorm = new Map<string, T>()
  const bySorted = new Map<string, T>()
  const tokenSets = artists.map((a) => ({
    artist: a,
    tokens: new Set(nameTokens(a.name)),
    // A comma means the folder uses the "Last, First" convention. That is the
    // only reason a one-word query should reach a multi-word artist, and it's
    // what separates "Dio" → "Dio, Ronnie James" (right) from "Overkill" →
    // "Urge Overkill" (a different band entirely).
    sortName: a.name.includes(','),
  }))

  for (const a of artists) {
    const key = norm(a.name)
    if (key && !byNorm.has(key)) byNorm.set(key, a)
    const sorted = normSorted(a.name)
    if (sorted && !bySorted.has(sorted)) bySorted.set(sorted, a)
  }

  /**
   * The library artist this name refers to, or null.
   *   1. exact normalised match
   *   2. order-insensitive ("Gillan, Ian" ≡ "Ian Gillan")
   *   3. query ⊆ library: every token of `name` appears in exactly ONE library
   *      artist, so "Dio" finds "Dio, Ronnie James". The uniqueness guard is
   *      what keeps an ambiguous token like "John" binding to the wrong artist.
   *   4. library ⊆ query, the other direction: "Tony Iommi" finds "Iommi" and
   *      "Michael Schenker Group" finds "Schenker, Michael".
   *
   * Tier 4 is the dangerous one: a one-word library artist sits inside any
   * phrase that mentions it, and "Saxon Shore", "UFO Club" and "Rainbow Bridge"
   * are all real bands that are NOT this library's Saxon, UFO or Rainbow. The
   * guard comes from how the two cases differ — a person's name gains words at
   * the FRONT ("Tony" Iommi) while a different band's gains them at the END
   * (Saxon "Shore"). So a single-token library name must land on the query's
   * LAST token, and a multi-token one must cover at least half the query.
   */
  function find(name: string): T | null {
    const exact = byNorm.get(norm(name))
    if (exact) return exact
    const sorted = bySorted.get(normSorted(name))
    if (sorted) return sorted

    const tokens = nameTokens(name)
    if (tokens.length === 0) return null

    const forward = tokenSets.filter(
      ({ tokens: have, sortName }) =>
        tokens.every((t) => have.has(t)) &&
        (tokens.length === have.size || sortName),
    )
    if (forward.length === 1) return forward[0].artist

    const queryTokens = new Set(tokens)
    const last = tokens[tokens.length - 1]
    const reverse = tokenSets.filter(({ tokens: have }) => {
      if (have.size === 0) return false
      if (![...have].every((t) => queryTokens.has(t))) return false
      if (have.size > 1) return have.size * 2 >= tokens.length
      // A single-token artist may only claim the query's last token, and only
      // if it's distinctive enough to mean something — "Iommi" yes, "X" no,
      // or "Racer X" would collapse onto the band called X.
      return have.has(last) && last.length >= 4
    })
    return reverse.length === 1 ? reverse[0].artist : null
  }

  return { find }
}
