// Name folding and artist matching for the upload filing flow. Pure functions,
// kept out of the component file so Fast Refresh can treat that file as
// components only.

/**
 * Fold a name to its comparable core: case, spaces and punctuation all go, so
 * "AC/DC", "AC_DC" and "ac dc" are one thing. Mirrors the separator-folding
 * the scanner does server-side when matching artist folders.
 */
export function foldName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Existing artists that match what's been typed, best first: prefix matches
 * before interior ones, then alphabetical. Empty query lists everything, so
 * the dropdown is browsable before typing.
 */
export function matchArtists(all: string[], query: string): string[] {
  const q = foldName(query)
  if (!q) return [...all].sort((a, b) => a.localeCompare(b))
  const starts: string[] = []
  const contains: string[] = []
  for (const name of all) {
    const f = foldName(name)
    if (f.startsWith(q)) starts.push(name)
    else if (f.includes(q)) contains.push(name)
  }
  starts.sort((a, b) => a.localeCompare(b))
  contains.sort((a, b) => a.localeCompare(b))
  return [...starts, ...contains]
}
