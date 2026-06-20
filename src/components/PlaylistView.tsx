import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Shuffle, ListMusic, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import {
  getPlaylistTracks,
  albumImageUrl,
  movePlaylistTrack,
  uploadPlaylistImage,
  uploadPlaylistImageFromUrl,
} from '../lib/api'
import { ArtFromUrl } from './ArtFromUrl'
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

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="flex w-52 shrink-0 flex-col gap-2">
          <div className="relative h-52 w-52">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="Change artwork"
              className="group flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-elevated shadow-2xl shadow-black/60"
            >
              {playlist.imageTag || artVersion > 0 ? (
                <Cover
                  src={
                    albumImageUrl(conn, playlist.id, playlist.imageTag, 520) +
                    (artVersion ? `&v=${artVersion}` : '')
                  }
                  alt={name}
                  className="h-full w-full"
                />
              ) : (
                <ListMusic className="h-16 w-16 text-white/45" />
              )}
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
                <Pencil className="h-6 w-6 text-white" />
                <span className="text-xs font-medium text-white">
                  {uploadingArt ? 'Uploading…' : 'Change artwork'}
                </span>
              </div>
              {/* Phones have no hover, so without a persistent badge the cover
                  gives no hint it's tappable. Always-visible affordance. */}
              <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[11px] font-semibold text-white ring-1 ring-white/25">
                <Pencil className="h-3 w-3" />
                {uploadingArt ? 'Uploading…' : 'Edit'}
              </div>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleArtFile}
            />
          </div>
          <ArtFromUrl
            onSubmit={(url) => uploadPlaylistImageFromUrl(conn, playlist.id, url)}
            onDone={() => {
              setArtVersion((v) => v + 1)
              queryClient.invalidateQueries({ queryKey: ['playlists'] })
            }}
          />
        </div>
        <div className="min-w-0 pb-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/82">
            Playlist
          </div>
          <div className="mt-2 flex items-center gap-2">
            <h1 className="min-w-0 truncate text-4xl font-bold tracking-tight">
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
          <div className="mt-2 text-sm text-white/85">
            {[
              tracks ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}` : null,
              totalSeconds ? formatDuration(totalSeconds) : null,
            ]
              .filter(Boolean)
              .join('  ·  ')}
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
              className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/5 disabled:opacity-40"
            >
              <Shuffle className="h-4 w-4" />
              Shuffle
            </button>
          </div>
        </div>
      </div>

      <div className="mt-9">
        {isLoading && <TrackSkeleton />}
        {tracks && tracks.length === 0 && (
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/74">
            This playlist is empty.
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
