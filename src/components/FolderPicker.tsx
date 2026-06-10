import { useEffect, useState } from 'react'
import {
  ChevronRight,
  ChevronLeft,
  Folder,
  Home,
  HardDrive,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import { browseFolders, type FolderListing } from '../lib/api'

interface FolderPickerProps {
  /** Starting directory; falls back to $HOME server-side if unset. */
  initialPath?: string
  /** Called with the absolute path the user picked. */
  onPick: (path: string) => void
  onCancel: () => void
}

/**
 * Server-backed folder picker. Lists the immediate subdirectories of a path,
 * with a clickable breadcrumb to climb back up and shortcuts to common roots.
 * The browser can't read filesystem paths directly, so this UI is the cleanest
 * way to let the user navigate to anywhere Allegory can reach.
 */
export function FolderPicker({ initialPath, onPick, onCancel }: FolderPickerProps) {
  const conn = useConnected()
  const [current, setCurrent] = useState<string | undefined>(initialPath)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void browseFolders(conn, current)
      .then((data) => {
        if (cancelled) return
        setListing(data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not read folder.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [conn, current])

  function nav(path: string) {
    setCurrent(path)
  }

  const path = listing?.path ?? current ?? ''
  const segs = path.split('/').filter(Boolean)

  return (
    <div className="rounded-md border border-line bg-white/[0.02]">
      {/* Shortcuts row */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line/60 px-2.5 py-2">
        {listing?.shortcuts.map((s) => (
          <button
            key={s.path}
            type="button"
            onClick={() => nav(s.path)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-white/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            {s.name === 'Home' ? (
              <Home className="h-3 w-3" />
            ) : (
              <HardDrive className="h-3 w-3" />
            )}
            {s.name}
          </button>
        ))}
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 overflow-x-auto px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => nav('/')}
          className="text-white/55 hover:text-white"
        >
          /
        </button>
        {segs.map((name, i) => {
          const segPath = '/' + segs.slice(0, i + 1).join('/')
          return (
            <div key={segPath} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-3 w-3 text-white/30" />
              <button
                type="button"
                onClick={() => nav(segPath)}
                className={`hover:text-white ${
                  i === segs.length - 1 ? 'font-medium text-white/90' : 'text-white/55'
                }`}
              >
                {name}
              </button>
            </div>
          )
        })}
      </div>

      {/* Folder list */}
      <div className="max-h-[260px] overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-white/45">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="flex items-start gap-1.5 px-3 py-3 text-sm text-red-300/85">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : (
          <>
            {listing?.parent && (
              <button
                type="button"
                onClick={() => nav(listing.parent!)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-white/65 transition-colors hover:bg-white/5 hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="text-white/45">..</span>
              </button>
            )}
            {listing?.entries.length === 0 ? (
              <div className="px-3 py-3 text-sm text-white/40">
                No subfolders here.
              </div>
            ) : (
              listing?.entries.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  onClick={() => nav(e.path)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-white/85 transition-colors hover:bg-white/5"
                >
                  <Folder className="h-4 w-4 shrink-0 text-white/55" />
                  <span className="truncate">{e.name}</span>
                </button>
              ))
            )}
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 border-t border-line/60 px-3 py-2">
        <span className="truncate font-mono text-[11px] text-white/45">
          {path}
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => path && onPick(path)}
            disabled={!path}
            className="rounded-md px-3 py-1 text-xs font-semibold text-black disabled:opacity-40"
            style={{ background: 'var(--accent)' }}
          >
            Pick this folder
          </button>
        </div>
      </div>
    </div>
  )
}
