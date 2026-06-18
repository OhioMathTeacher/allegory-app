/**
 * Optional online enrichment for artist-name matching.
 *
 * When Socrates proposes an artist the local library can't place (e.g. the
 * model says "Ozzy Osbourne" but the library folder is some other variant),
 * we ask MusicBrainz for that artist's canonical name, sort-name, and aliases.
 * Those alternates are then re-run through the local matcher. MusicBrainz's
 * sort-name is "Last, First" — exactly the convention many libraries fold by —
 * so it often bridges the gap on its own.
 *
 * No API key required. Every path is best-effort: offline, a network error, a
 * non-OK response, a timeout, or malformed JSON all resolve to `[]`, so a
 * playlist build never breaks or stalls waiting on this.
 */

const MUSICBRAINZ_ARTIST = 'https://musicbrainz.org/ws/2/artist'
const TIMEOUT_MS = 4000

/** True unless the browser explicitly reports it's offline. */
export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Return alternate names for an artist (canonical name, sort-name, aliases)
 * from MusicBrainz, or `[]` if offline / on any failure. Never throws.
 */
export async function lookupArtistNames(name: string): Promise<string[]> {
  const q = name.trim()
  if (!q || !isOnline()) return []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `${MUSICBRAINZ_ARTIST}?query=${encodeURIComponent(q)}&fmt=json&limit=3`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      artists?: Array<{
        name?: string
        'sort-name'?: string
        aliases?: Array<{ name?: string }>
      }>
    }
    const names = new Set<string>()
    for (const a of data.artists ?? []) {
      if (a.name) names.add(a.name)
      if (a['sort-name']) names.add(a['sort-name'])
      for (const alias of a.aliases ?? []) if (alias.name) names.add(alias.name)
    }
    return [...names]
  } catch {
    // Offline mid-flight, aborted (timeout), or unparseable — all non-fatal.
    return []
  } finally {
    clearTimeout(timer)
  }
}
