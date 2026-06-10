import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Play, Shuffle, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getSongNotesTracks } from '../lib/api'
import { usePlayer } from '../lib/player'
import { shuffle } from '../lib/shuffle'
import { formatDuration, ticksToSeconds } from '../lib/format'
import { TrackRow, TrackSkeleton } from './TrackList'
import type { Artist } from '../lib/types'

interface NotesViewProps {
  onBack: () => void
  onSelectArtist: (artist: Artist) => void
}

/**
 * The smart "Notes" playlist: every song that has a curator notes sidecar
 * (the illuminated-pencil songs). Read-only and always in sync with the
 * library — there's no .m3u behind it, just the live set of annotated tracks.
 */
export function NotesView({ onBack, onSelectArtist }: NotesViewProps) {
  const conn = useConnected()
  const player = usePlayer()

  const { data: tracks, isLoading } = useQuery({
    queryKey: ['song-notes-tracks', conn.serverUrl],
    queryFn: () => getSongNotesTracks(conn),
  })

  const totalSeconds =
    tracks?.reduce((sum, t) => sum + ticksToSeconds(t.durationTicks), 0) ?? 0

  function play(shuffled: boolean) {
    if (!tracks || tracks.length === 0) return
    player.playQueue(shuffled ? shuffle(tracks) : tracks, 0)
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
        <div
          className="flex h-52 w-52 shrink-0 items-center justify-center overflow-hidden rounded-2xl shadow-2xl shadow-black/60"
          style={{ background: 'var(--accent-soft)' }}
        >
          <Pencil className="h-20 w-20" style={{ color: 'var(--accent)' }} />
        </div>
        <div className="min-w-0 pb-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/55">
            Smart playlist
          </div>
          <h1 className="mt-2 min-w-0 truncate text-4xl font-bold tracking-tight">
            Notes
          </h1>
          <div className="mt-2 text-sm text-white/60">
            {[
              tracks ? `${tracks.length} song${tracks.length === 1 ? '' : 's'} with notes` : null,
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
          <div className="rounded-xl border border-line bg-surface/60 p-10 text-center text-sm text-white/45">
            No songs have notes yet. Tap the pencil on a song to add some.
          </div>
        )}
        {tracks && tracks.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-line">
            {tracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                number={i + 1}
                onSelectArtist={onSelectArtist}
                isCurrent={player.currentTrack?.id === track.id}
                isPlaying={
                  player.isPlaying && player.currentTrack?.id === track.id
                }
                onPlay={() => player.playQueue(tracks, i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
