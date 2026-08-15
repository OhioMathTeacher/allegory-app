import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Play,
  Shuffle,
  ListMusic,
  Pencil,
  AlertTriangle,
  CopyMinus,
} from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylistTracks,
  albumImageUrl,
  movePlaylistTrack,
  removePlaylistDuplicates,
  uploadPlaylistImage,
} from '../lib/api'
import { usePlayer } from '../lib/player'
import { shuffle } from '../lib/shuffle'
import { formatDuration, ticksToSeconds } from '../lib/format'
import { Cover } from './Cover'
import { TrackRow, TrackSkeleton } from './TrackList'
import { PlaylistEditMenu } from './PlaylistEditMenu'
import type { Artist, Playlist } from '../lib/types'

interface PlaylistViewProps {
  playlist: Playlist
  onBack: () => void
  onSelectArtist: (artist: Artist) => void
}

export function PlaylistView({ playlist, onBack, onSelectArtist }: PlaylistViewProps) {
  const conn = useConnected()
  const player = usePlayer()
  const queryClient = useQueryClient()
  // Local copy of the name so a rename shows immediately (the prop is stale).
  const [name, setName] = useState(playlist.name)
  const dragFrom = useRef<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  // Custom artwork: a hidden file input on the cover, with a version bump to
  // cache-bust the image after a successful upload.
  const fileRef = useRef<HTMLInputElement>(null)
  const [artVersion, setArtVersion] = useState(0)
  const [uploadingArt, setUploadingArt] = useState(false)
  // Duplicate count comes from the list query, so — like `name` — the prop is
  // stale the moment we act on it. Track it locally from that starting point.
  const [dupCount, setDupCount] = useState(playlist.duplicateCount ?? 0)
  const [deduping, setDeduping] = useState(false)
  const [dedupeResult, setDedupeResult] = useState<string | null>(null)

  async function handleArtFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!file) return
    setUploadingArt(true)
    try {
      await uploadPlaylistImage(conn, playlist.id, file)
      setArtVersion((v) => v + 1)
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
    } finally {
      setUploadingArt(false)
    }
  }

  const { data: tracks, isLoading } = useQuery({
    queryKey: ['playlist-tracks', playlist.id],
    queryFn: () => getPlaylistTracks(conn, playlist.id),
  })

  const totalSeconds =
    tracks?.reduce((sum, t) => sum + ticksToSeconds(t.durationTicks), 0) ?? 0

  // `trackCount` counts lines in the `.m3u`; `tracks` counts the ones that
  // matched a real file. A gap means the playlist points at something the
  // library doesn't have — which otherwise renders as an unexplained empty
  // playlist, indistinguishable from one you never filled in.
  const listedCount = playlist.trackCount ?? null
  const missingCount =
    tracks && listedCount !== null ? Math.max(0, listedCount - tracks.length) : 0

  async function deleteDuplicates() {
    setDeduping(true)
    setDedupeResult(null)
    try {
      const removed = await removePlaylistDuplicates(conn, playlist.id)
      setDupCount(0)
      setDedupeResult(
        removed === 0
          ? 'No duplicates found.'
          : `Removed ${removed} duplicate${removed === 1 ? '' : 's'}.`,
      )
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] })
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
    } catch (err) {
      setDedupeResult(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setDeduping(false)
    }
  }

  function play(shuffled: boolean) {
    if (!tracks || tracks.length === 0) return
    player.playQueue(shuffled ? shuffle(tracks) : tracks, 0)
  }

  function handleDrop(to: number) {
    const from = dragFrom.current
    dragFrom.current = null
    setOverIndex(null)
    if (from === null || from === to || !tracks) return
    // Reorder optimistically, then persist and reconcile.
    const reordered = tracks.slice()
    const [moved] = reordered.splice(from, 1)
    reordered.splice(to, 0, moved)
    queryClient.setQueryData(['playlist-tracks', playlist.id], reordered)
    const settle = () =>
      queryClient.invalidateQueries({
        queryKey: ['playlist-tracks', playlist.id],
      })
    movePlaylistTrack(conn, playlist.id, from, to).then(settle, settle)
  }

  return (
    <div className="px-8 py-8">
      <button
        onClick={onBack}
        className="mb-7 flex items-center gap-2 text-base font-semibold text-white transition-colors hover:text-white/80"
      >
        <ArrowLeft className="h-5 w-5" />
        Playlists
      </button>

      {/* Hidden picker stays mounted so the small cover + ⋮ → "Change artwork…"
          can open it. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleArtFile}
      />
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title={uploadingArt ? 'Uploading…' : 'Change artwork'}
          className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-elevated shadow-lg shadow-black/40 sm:h-20 sm:w-20"
        >
          {playlist.imageTag || artVersion > 0 ? (
            <Cover
              src={
                albumImageUrl(conn, playlist.id, playlist.imageTag, 160) +
                (artVersion ? `&v=${artVersion}` : '')
              }
              alt={name}
              className="h-full w-full"
            />
          ) : (
            <ListMusic className="h-7 w-7 text-white/45" />
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
            <Pencil className="h-4 w-4 text-white" />
          </div>
        </button>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/82">
            Playlist
          </div>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="min-w-0 truncate text-2xl font-bold tracking-tight sm:text-3xl">
              {name}
            </h1>
            <PlaylistEditMenu
              playlistId={playlist.id}
              playlistName={name}
              onRenamed={setName}
              onDeleted={onBack}
              onEditArtwork={() => fileRef.current?.click()}
            />
          </div>
          <div className="mt-1 text-sm text-white/85">
            {[
              tracks ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}` : null,
              totalSeconds ? formatDuration(totalSeconds) : null,
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={() => play(false)}
          disabled={!tracks?.length}
          className="flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold text-black transition-transform hover:scale-105 disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
        >
          <Play className="h-4 w-4 fill-black" />
          Play
        </button>
        <button
          onClick={() => play(true)}
          disabled={!tracks?.length}
          className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/14 disabled:opacity-40"
        >
          <Shuffle className="h-4 w-4" />
          Shuffle
        </button>
        {/* Only worth offering when there's something to remove. Once it's
            run, the result line replaces it rather than leaving a dead
            button sitting there. */}
        {dupCount > 0 && (
          <button
            onClick={deleteDuplicates}
            disabled={deduping}
            title="Remove entries that repeat a track already in this playlist"
            className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/14 disabled:opacity-40"
          >
            <CopyMinus className="h-4 w-4" />
            {deduping
              ? 'Removing…'
              : `Delete Duplicates (${dupCount})`}
          </button>
        )}
        {dedupeResult && (
          <span className="text-sm text-white/70">{dedupeResult}</span>
        )}
      </div>

      <div className="mt-9">
        {isLoading && <TrackSkeleton />}
        {missingCount > 0 && tracks && tracks.length > 0 && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300/90">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {missingCount} of {listedCount} entries in this playlist could not be found
              on disk, so they aren’t shown.
            </span>
          </div>
        )}
        {tracks && tracks.length === 0 && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/74">
            {missingCount > 0 ? (
              <>
                None of this playlist’s {listedCount} entries could be found on disk. The
                tracks may have been moved or renamed, or the file’s paths may be written
                for a different player.
              </>
            ) : (
              'This playlist is empty.'
            )}
          </div>
        )}
        {tracks && tracks.length > 0 && (
          <>
            <p className="mb-3 text-xs text-white/62">Drag a track to reorder.</p>
            <div className="overflow-hidden rounded-xl border border-line">
              {tracks.map((track, i) => (
                <div
                  key={track.playlistItemId ?? `${track.id}-${i}`}
                  draggable
                  onDragStart={() => {
                    dragFrom.current = i
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setOverIndex(i)
                  }}
                  onDragLeave={() =>
                    setOverIndex((o) => (o === i ? null : o))
                  }
                  onDrop={() => handleDrop(i)}
                  onDragEnd={() => {
                    dragFrom.current = null
                    setOverIndex(null)
                  }}
                  className={`border-t-2 ${
                    overIndex === i
                      ? 'border-[var(--accent)]'
                      : 'border-transparent'
                  }`}
                >
                  <TrackRow
                    track={track}
                    number={i + 1}
                    excludePlaylistId={playlist.id}
                    onSelectArtist={onSelectArtist}
                    isCurrent={player.currentTrack?.id === track.id}
                    isPlaying={
                      player.isPlaying && player.currentTrack?.id === track.id
                    }
                    onPlay={() => player.playQueue(tracks, i)}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
