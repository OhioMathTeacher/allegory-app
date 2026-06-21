import { Download } from 'lucide-react'
import { useDownloadProgress } from '../lib/downloads'

/**
 * A persistent, app-wide download status bar — shown above the player bar
 * whenever a download is running. Surfaces which track is downloading, how far
 * through the batch we are, and a live percent, so a slow (or stuck) download
 * is visible instead of a mysterious spinner.
 */
export function DownloadProgressBar() {
  const dl = useDownloadProgress()
  if (!dl.active) return null
  const pct = Math.round(dl.currentPct * 100)
  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 py-2 sm:px-6">
      <div className="flex items-center gap-2 text-sm font-medium text-white">
        <Download className="h-4 w-4 shrink-0 animate-pulse" style={{ color: 'var(--accent)' }} />
        <span className="min-w-0 flex-1 truncate">
          Downloading {Math.min(dl.done + 1, dl.total)}/{dl.total}
          {dl.currentName ? <span className="text-white/80"> · {dl.currentName}</span> : null}
        </span>
        <span className="shrink-0 tabular-nums text-white/80">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/15">
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{ width: `${pct}%`, background: 'var(--accent)' }}
        />
      </div>
    </div>
  )
}
