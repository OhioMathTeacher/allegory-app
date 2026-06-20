import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ListMusic, Plus, Pencil, Sparkles, Loader2 } from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylists,
  getSongNotesIndex,
  createPlaylist,
  albumImageUrl,
  getArtists,
  getAlbums,
} from '../lib/api'
import { askAI, getStoredProvider } from '../lib/ai'
import { buildPlaylistFromDescriptionPrompt } from '../lib/socrates-prompt'
import { parseSocratesMessage, type PlaylistProposal } from '../lib/socrates-actions'
import { SocratesPlaylistCard } from './SocratesPlaylistCard'
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
  const providerId = getStoredProvider()
  const hasAI = !!providerId && providerId !== 'none'

  const [creating, setCreating] = useState(false)
  // Describe-it (AI) is the primary New flow when a provider is set up; the
  // plain name field is the fallback (and the only option without AI).
  const [mode, setMode] = useState<'describe' | 'name'>(hasAI ? 'describe' : 'name')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  // Describe-a-playlist state.
  const [description, setDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [proposal, setProposal] = useState<PlaylistProposal | null>(null)
  const [genError, setGenError] = useState<string | null>(null)

  const {
    data: playlists,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['playlists', conn.serverUrl, conn.userId],
    queryFn: () => getPlaylists(conn),
  })

  // Library context for the AI prompt — same cache keys as Socrates, so it's
  // shared, not re-fetched. Only needed for the describe flow.
  const { data: artists } = useQuery({
    queryKey: ['artists', conn.serverUrl, conn.userId],
    queryFn: () => getArtists(conn),
    enabled: hasAI,
  })
  const { data: albums } = useQuery({
    queryKey: ['albums', conn.serverUrl, conn.userId],
    queryFn: () => getAlbums(conn),
    enabled: hasAI,
  })

  // Shared cache key with the player bar / track pencils — drives the count
  // on the smart Notes playlist card.
  const { data: notesIndex } = useQuery({
    queryKey: ['song-notes', conn.serverUrl],
    queryFn: () => getSongNotesIndex(conn),
  })
  const notesCount = notesIndex?.length ?? 0

  function toggleCreating() {
    setCreating((c) => {
      const next = !c
      // Reset everything when the panel opens or closes so it's never stale.
      setNewName('')
      setDescription('')
      setProposal(null)
      setGenError(null)
      setMode(hasAI ? 'describe' : 'name')
      return next
    })
  }

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

  // Describe → Socrates builds a proposal we preview (resolved against the
  // library) before the user saves it. A focused, single-purpose AI call.
  async function handleGenerate() {
    const desc = description.trim()
    if (!desc || generating || !hasAI) return
    setGenError(null)
    setProposal(null)
    setGenerating(true)
    try {
      const sys = buildPlaylistFromDescriptionPrompt({
        artists: artists ?? [],
        albums: albums ?? [],
      })
      const reply = await askAI(providerId, [{ role: 'user', content: desc }], sys, undefined, 1200)
      const { proposals } = parseSocratesMessage(reply)
      if (proposals.length) {
        setProposal(proposals[0])
      } else {
        setGenError(
          "Socrates couldn't shape that into a playlist from your library — try describing it a little differently.",
        )
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Could not generate a playlist.')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div>
      <header className="sticky top-0 z-10 bg-bg/95 px-8 pt-8 pb-4 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">Playlists</h1>
            <p className="mt-1 text-sm text-white/85">
              {playlists
                ? `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`
                : 'Your playlists'}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleCreating}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-4 py-2 text-sm font-medium text-white/85 transition-colors hover:bg-white/5"
          >
            <Plus className="h-4 w-4" />
            New
          </button>
        </div>

        {creating && mode === 'describe' && hasAI && (
          <div className="mt-3">
            <div className="flex items-end gap-2">
              <textarea
                autoFocus
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleGenerate()
                  } else if (e.key === 'Escape') toggleCreating()
                }}
                rows={2}
                placeholder="Describe the playlist you want… (e.g. “late-night, melancholy, mostly acoustic”)"
                className="max-h-32 min-w-0 flex-1 resize-none rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-white outline-none placeholder:text-white/66 focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={!description.trim() || generating}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-black transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                style={{ background: 'var(--accent)' }}
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Generate
              </button>
            </div>

            {genError && (
              <p className="mt-2 text-xs text-amber-300/80">{genError}</p>
            )}

            {proposal && (
              <div className="mt-3">
                <SocratesPlaylistCard
                  proposal={proposal}
                  artists={artists ?? []}
                  albums={albums ?? []}
                  onCreated={(id, name, trackCount) => {
                    setCreating(false)
                    setDescription('')
                    setProposal(null)
                    onSelectPlaylist({ id, name, trackCount })
                  }}
                />
              </div>
            )}

            <button
              type="button"
              onClick={() => setMode('name')}
              className="mt-2 text-xs text-white/74 underline-offset-2 transition-colors hover:text-white/70 hover:underline"
            >
              or name an empty one instead
            </button>
          </div>
        )}

        {creating && (mode === 'name' || !hasAI) && (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  else if (e.key === 'Escape') toggleCreating()
                }}
                placeholder="New playlist name…"
                className="min-w-0 flex-1 rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-white outline-none placeholder:text-white/66 focus:border-[var(--accent)]"
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
            {hasAI && (
              <button
                type="button"
                onClick={() => setMode('describe')}
                className="mt-2 inline-flex items-center gap-1 text-xs text-white/74 underline-offset-2 transition-colors hover:text-white/70 hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                or describe it and let Socrates build it
              </button>
            )}
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
              <div className="truncate text-lg text-white/88">
                {notesCount} song{notesCount === 1 ? '' : 's'} with notes
              </div>
            </div>
          </button>
        )}

        {isLoading && <SkeletonList />}

        {isError && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/78">
            Couldn’t load your playlists. Make sure the server is reachable.
          </div>
        )}

        {playlists && playlists.length === 0 && notesCount === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 p-12 text-center">
            <ListMusic className="h-8 w-8 text-white/45" />
            <p className="text-sm text-white/74">No playlists yet.</p>
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
            <ListMusic className="h-5 w-5 text-white/55" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-semibold text-white">
            {playlist.name}
          </div>
          <div className="truncate text-lg text-white/88">
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
