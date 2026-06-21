import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MoreVertical,
  Pencil,
  Trash2,
  Layers,
  Check,
  ChevronLeft,
  ImagePlus,
  Download,
  Loader2,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylists,
  getPlaylistTracks,
  renamePlaylist,
  deletePlaylist,
  combinePlaylists,
} from '../lib/api'
import {
  downloadTracks,
  removeDownloads,
  useCollectionStatus,
} from '../lib/downloads'
import type { Playlist } from '../lib/types'

interface PlaylistEditMenuProps {
  playlistId: string
  playlistName: string
  onRenamed: (newName: string) => void
  onDeleted: () => void
  /** Trigger the cover-art file picker (lives on the playlist header). */
  onEditArtwork?: () => void
}

type Mode = 'menu' | 'rename' | 'combine' | 'confirm'

/**
 * The "⋯" menu on a playlist: rename it, combine it with another playlist
 * (into a new one), or delete it. A `fixed`-positioned popover, anchored to
 * the button so it escapes any clipping container.
 */
export function PlaylistEditMenu({
  playlistId,
  playlistName,
  onRenamed,
  onDeleted,
  onEditArtwork,
}: PlaylistEditMenuProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const buttonRef = useRef<HTMLButtonElement>(null)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({
    top: 0,
  })
  const [mode, setMode] = useState<Mode>('menu')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)

  const { data: playlists } = useQuery({
    queryKey: ['playlists', conn.serverUrl, conn.userId],
    queryFn: () => getPlaylists(conn),
    enabled: open && mode === 'combine',
  })
  const others = (playlists ?? []).filter((p) => p.id !== playlistId)

  // Lazily load the playlist's tracks once the menu opens, so "Download
  // playlist" knows what to fetch and can reflect how much is already cached.
  const { data: tracks } = useQuery({
    queryKey: ['playlist-tracks', playlistId],
    queryFn: () => getPlaylistTracks(conn, playlistId),
    enabled: open,
  })
  const trackIds = (tracks ?? []).map((t) => t.id)
  const dl = useCollectionStatus(trackIds)

  function toggleDownload() {
    if (!tracks || tracks.length === 0) return
    if (dl.complete) {
      void run(() => removeDownloads(trackIds), 'Removed download')
    } else {
      void run(() => downloadTracks(conn, tracks), `Downloaded ${playlistName}`)
    }
  }

  const downloadLabel = !tracks
    ? 'Download playlist'
    : dl.busy
      ? `Downloading… ${dl.downloaded}/${dl.total}`
      : dl.complete
        ? 'Remove download'
        : dl.downloaded > 0
          ? `Download playlist (${dl.downloaded}/${dl.total})`
          : 'Download playlist'

  function openMenu() {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) {
      // Anchor to whichever side keeps the popover on-screen: open leftward
      // from a button in the right half (a list row's ⋮), rightward from one
      // on the left (next to a title).
      setPos(
        r.right > window.innerWidth / 2
          ? { top: r.bottom + 6, right: window.innerWidth - r.right }
          : { top: r.bottom + 6, left: r.left },
      )
    }
    setMode('menu')
    setName(playlistName)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    setMode('menu')
    setBusy(false)
    setDone(null)
  }

  async function run(work: () => Promise<void>, message: string) {
    setBusy(true)
    try {
      await work()
      setDone(message)
      window.setTimeout(close, 1000)
    } catch (err) {
      setBusy(false)
      setDone(err instanceof Error ? err.message : 'Something went wrong.')
    }
  }

  function doRename() {
    const trimmed = name.trim()
    if (!trimmed) return
    void run(async () => {
      await renamePlaylist(conn, playlistId, trimmed)
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      onRenamed(trimmed)
    }, 'Renamed')
  }

  function doDelete() {
    void run(async () => {
      await deletePlaylist(conn, playlistId)
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      onDeleted()
    }, 'Deleted')
  }

  function doCombine(other: Playlist) {
    const combinedName = `${playlistName} + ${other.name}`
    void run(async () => {
      await combinePlaylists(conn, combinedName, [playlistId, other.id])
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
    }, `Created “${combinedName}”`)
  }

  return (
    <div className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        aria-label="Playlist options"
        title="Playlist options"
        className={`rounded-md p-2 transition-colors ${
          open ? 'text-white' : 'text-white/85 hover:text-white'
        }`}
      >
        <MoreVertical className="h-5 w-5" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            className="fixed z-50 max-h-[60vh] min-w-[250px] overflow-y-auto rounded-lg border border-line bg-surface p-1.5 shadow-xl shadow-black/50"
            style={{ top: pos.top, left: pos.left, right: pos.right }}
          >
            {done ? (
              <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-white/75">
                <Check
                  className="h-4 w-4 shrink-0"
                  style={{ color: 'var(--accent)' }}
                />
                {done}
              </div>
            ) : mode === 'rename' ? (
              <div className="p-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') doRename()
                    if (e.key === 'Escape') setMode('menu')
                  }}
                  placeholder="Playlist name…"
                  autoCapitalize="off"
                  className="input w-full"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={doRename}
                    disabled={busy || !name.trim()}
                    className="flex-1 rounded-md py-1.5 text-sm font-semibold text-black transition-transform hover:scale-[1.02] disabled:opacity-40"
                    style={{ background: 'var(--accent)' }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('menu')}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/14"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : mode === 'confirm' ? (
              <div className="p-1.5">
                <p className="px-1 py-1 text-sm text-white/75">
                  Delete “{playlistName}”? The tracks stay in your library.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={doDelete}
                    disabled={busy}
                    className="flex-1 rounded-md bg-red-500/90 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-40"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('menu')}
                    className="rounded-md border border-line px-3 py-1.5 text-sm text-white/70 transition-colors hover:bg-white/14"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : mode === 'combine' ? (
              <>
                <button
                  type="button"
                  onClick={() => setMode('menu')}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
                >
                  <ChevronLeft className="h-4 w-4 shrink-0" />
                  Combine with…
                </button>
                <div className="my-1 h-px bg-line" />
                {others.map((other) => (
                  <button
                    key={other.id}
                    type="button"
                    onClick={() => doCombine(other)}
                    disabled={busy}
                    className="block w-full truncate rounded-md px-2.5 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/14 disabled:opacity-50"
                  >
                    {other.name}
                  </button>
                ))}
                {playlists && others.length === 0 && (
                  <div className="px-2.5 py-2 text-xs text-white/70">
                    No other playlists to combine with.
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={toggleDownload}
                  disabled={busy || !tracks || dl.busy}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14 disabled:opacity-50"
                >
                  {dl.busy ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
                  ) : dl.complete ? (
                    <Trash2 className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  ) : (
                    <Download className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  )}
                  {downloadLabel}
                </button>
                <div className="my-1 h-px bg-line" />
                <button
                  type="button"
                  onClick={() => setMode('rename')}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
                >
                  <Pencil className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => setMode('combine')}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
                >
                  <Layers className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  Combine with…
                </button>
                {onEditArtwork && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false)
                      onEditArtwork()
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-white/85 transition-colors hover:bg-white/14"
                  >
                    <ImagePlus className="h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                    Change artwork…
                  </button>
                )}
                <div className="my-1 h-px bg-line" />
                <button
                  type="button"
                  onClick={() => setMode('confirm')}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-red-300/90 transition-colors hover:bg-red-500/10"
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                  Delete playlist
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
