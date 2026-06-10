/** Jellyfin reports durations in "ticks" of 100 nanoseconds. */
export function ticksToSeconds(ticks: number): number {
  return ticks / 10_000_000
}

/** mm:ss for a track-length / playback position. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Human total like "42 min" or "1 hr 7 min". */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  return `${hours} hr ${totalMinutes % 60} min`
}
