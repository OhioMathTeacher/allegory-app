import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MoreVertical, Download, Check, Loader2, Trash2, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getAlbumTracks } from '../lib/api'
import {
  downloadTracks,
  removeDownloads,
  useCollectionStatus,
} from '../lib/downloads'
import type { Album } from '../lib/types'

interface AlbumMenuProps {
  album: Album
  /** When set, an "Edit album" item appears (opens the caller's editor). */
  onEdit?: () => void
  /** Extra classes for the trigger button (e.g. hover-reveal in a row). */
  className?: string
}

/**
 * The "⋮" (3-vertical-dot) contextual menu for an album, mirroring TrackMenu's
 * per-song one. Its headline action is Download — download every track in the
 * album into the offline cache, or remove them. The album's track listing is
 * fetched lazily the first time the menu opens (shared by query key with the
 * AlbumView, so it's cached).
 *
 * The popover is positioned `fixed` (anchored to the button's screen rect) so
 * it escapes any `overflow-hidden` clipping on the surrounding list.
 */
export function AlbumMenu({ album, onEdit, className }: AlbumMenuProps) {
  const conn = useConnected()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const { data: tracks } = useQuery({
    queryKey: ['tracks', album.id],
    queryFn: () => getAlbumTracks(conn, album.id),
    enabled: open,
  })

  const ids = (tracks ?? []).map((t) => t.id)
  const status = useCollectionStatus(ids)

  function openMenu() {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    setOpen(true)
  }
  function close() {
    setOpen(false)
    setBusy(false)
    setDone(null)
  }

  async function run(work: () => Promise<void>, message: string) {
    setBusy(true)
    try {
      await work()
      setDone(message)
      window.setTimeout(close, 900)
    } catch (err) {
      setBusy(false)
      setDone(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  function toggleDownload() {
    if (!tracks || tracks.length === 0) return
    if (status.complete) {
      void run(() => removeDownloads(ids), 'Removed download')
    } else {
      void run(() => downloadTracks(conn, tracks), `Downloaded ${album.name}`)
    }
  }

  const downloadLabel = !tracks
    ? 'Download album'
    : status.busy
      ? `Downloading… ${status.downloaded}/${status.total}`
      : status.complete
        ? 'Remove download'
        : status.downloaded > 0
          ? `Download album (${status.downloaded}/${status.total})`
          : 'Download album'

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (open) close()
          else openMenu()
        }}
        aria-label="Album options"
        title="Album options"
        className={`rounded-md p-2 transition-colors ${
          open ? 'text-white' : 'text-white/85 hover:text-white'
        } ${className ?? ''}`}
      >
        <MoreVertical className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="fixed z-50 min-w-[220px] overflow-hidden rounded-lg border border-line bg-surface p-1.5 shadow-xl shadow-black/50"
            style={{ top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
          >
            {done ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-white/75">
                <Check className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                {done}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleDownload}
                  disabled={busy || !tracks || status.busy}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14 disabled:opacity-50"
                >
                  {status.busy ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                  ) : status.complete ? (
                    <Trash2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  ) : (
                    <Download className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  )}
                  {downloadLabel}
                </button>
                {onEdit && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <button
                      type="button"
                      onClick={() => {
                        close()
                        onEdit()
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
                    >
                      <Pencil className="h-4 w-4 shrink-0 text-white/82" />
                      Edit album
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
