import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ListMusic, Plus, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getPlaylists, getSongNotesIndex, createPlaylist, albumImageUrl } from '../lib/api'
import { Cover } from './Cover'
import { PlaylistEditMenu } from './PlaylistEditMenu'
import type { Playlist } from '../lib/types'

interface PlaylistsProps {
  onSelectPlaylist: (playlist: Playlist) => void
  /** Open the smart "Notes" playlist (all songs with a notes sidecar). */
  onOpenNotes: () => void
}

export function Playlists({ onSelectPlaylist, onOpenNotes }: PlaylistsProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const {
    data: playlists,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['playlists', conn.serverUrl, conn.userId],
    queryFn: () => getPlaylists(conn),
  })

  // Shared cache key with the player bar / track pencils — drives the count
  // on the smart Notes playlist card.
  const { data: notesIndex } = useQuery({
    queryKey: ['song-notes', conn.serverUrl],
    queryFn: () => getSongNotesIndex(conn),
  })
  const notesCount = notesIndex?.length ?? 0

  async function handleCreate() {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      const id = await createPlaylist(conn, name, [])
      await queryClient.invalidateQueries({ queryKey: ['playlists'] })
      setCreating(false)
      setNewName('')
      onSelectPlaylist({ id, name, trackCount: 0 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <header className="sticky top-0 z-10 bg-bg/95 px-8 pt-8 pb-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">Playlists</h1>
            <p className="mt-1 text-sm text-white/60">
              {playlists
                ? `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`
                : 'Your playlists'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating((c) => !c)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/5"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>

        {creating && (
          <div className="mt-3 flex items-center gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                else if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              placeholder="New playlist name…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-white outline-none placeholder:text-white/35 focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={!newName.trim() || busy}
              className="shrink-0 rounded-lg px-4 py-2 text-sm font-semibold text-black transition-transform hover:scale-105 disabled:opacity-40"
              style={{ background: 'var(--accent)' }}
            >
              Create
            </button>
          </div>
        )}
      </header>

      <div className="px-8 pb-8">
        {/* Smart playlist: every song that has a curator notes sidecar
            (the illuminated-pencil songs). Always first when any exist. */}
        {notesCount > 0 && (
          <button
            type="button"
            onClick={onOpenNotes}
            className="mb-4 flex w-full items-center gap-4 rounded-xl border border-line bg-surface/40 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
          >
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'var(--accent-soft)' }}
            >
              <Pencil className="h-5 w-5" style={{ color: 'var(--accent)' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-semibold text-white">Notes</div>
              <div className="truncate text-lg text-white/65">
                {notesCount} song{notesCount === 1 ? '' : 's'} with notes
              </div>
            </div>
          </button>
        )}

        {isLoading && <SkeletonList />}

        {isError && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/50">
            Couldn’t load your playlists. Make sure the server is reachable.
          </div>
        )}

        {playlists && playlists.length === 0 && notesCount === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 p-12 text-center">
            <ListMusic className="h-8 w-8 text-white/20" />
            <p className="text-sm text-white/45">No playlists yet.</p>
          </div>
        )}

        {playlists && playlists.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line">
            {playlists.map((playlist, i) => (
              <PlaylistRow
                key={playlist.id}
                playlist={playlist}
                index={i}
                onSelect={onSelectPlaylist}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface PlaylistRowProps {
  playlist: Playlist
  index: number
  onSelect: (playlist: Playlist) => void
}

function PlaylistRow({ playlist, index, onSelect }: PlaylistRowProps) {
  const conn = useConnected()
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['playlists'] })
  return (
    <motion.div
      id={`playlist-${playlist.id}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.3,
        delay: Math.min(index * 0.03, 0.4),
        ease: [0.22, 1, 0.36, 1],
      }}
      className="flex w-full items-center border-b border-line transition-colors last:border-b-0 hover:bg-white/[0.03] scroll-mt-32"
    >
      <button
        type="button"
        onClick={() => onSelect(playlist)}
        className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left"
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
          {playlist.imageTag ? (
            <Cover
              src={albumImageUrl(conn, playlist.id, playlist.imageTag, 120)}
              alt={playlist.name}
              className="h-full w-full"
            />
          ) : (
            <ListMusic className="h-5 w-5 text-white/25" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-semibold text-white">
            {playlist.name}
          </div>
          <div className="truncate text-lg text-white/65">
            {playlist.trackCount != null
              ? `${playlist.trackCount} track${playlist.trackCount === 1 ? '' : 's'}`
              : 'Playlist'}
          </div>
        </div>
      </button>
      <div className="shrink-0 pr-2">
        <PlaylistEditMenu
          playlistId={playlist.id}
          playlistName={playlist.name}
          onRenamed={refresh}
          onDeleted={refresh}
        />
      </div>
    </motion.div>
  )
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-[72px] animate-pulse rounded-lg bg-white/5" />
      ))}
    </div>
  )
}
