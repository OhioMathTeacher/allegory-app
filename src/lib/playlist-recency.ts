/**
 * Tiny most-recently-used tracker for playlists, so the track "⋯" menu can
 * surface the handful you actually add to instead of the whole list. Just an
 * ordered list of playlist ids in localStorage, most-recent first. Bumped
 * whenever a track is added to a playlist (or one is created).
 */
const KEY = 'allegory.playlistRecency'
const CAP = 50

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr as string[]) : []
  } catch {
    return []
  }
}

/** Move a playlist to the front of the recency list. */
export function bumpPlaylist(id: string): void {
  const next = [id, ...read().filter((x) => x !== id)].slice(0, CAP)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage full/disabled — recency is best-effort
  }
}

/**
 * Return the items most-recently-used first. Items never used keep their
 * original relative order, after the ranked ones (Array.sort is stable).
 */
export function sortByRecency<T extends { id: string }>(items: T[]): T[] {
  const rank = new Map(read().map((id, i) => [id, i]))
  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  )
}
