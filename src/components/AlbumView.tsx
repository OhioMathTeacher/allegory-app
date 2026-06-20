import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Play, Pencil } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { getAlbumTracks, albumImageUrl } from '../lib/api'
import { usePlayer } from '../lib/player'
import { shuffle } from '../lib/shuffle'
import { formatDuration, ticksToSeconds } from '../lib/format'
import { Cover } from './Cover'
import { TrackRow, TrackSkeleton } from './TrackList'
import { AlbumEditor } from './AlbumEditor'
import { AlbumMenu } from './AlbumMenu'
import type { Album, Artist } from '../lib/types'

interface AlbumViewProps {
  album: Album
  onBack: () => void
  onSelectArtist: (artist: Artist) => void
}

export function AlbumView({ album, onBack, onSelectArtist }: AlbumViewProps) {
  const conn = useConnected()
  const player = usePlayer()
  const [editing, setEditing] = useState(false)
  const { data: tracks, isLoading } = useQuery({
    queryKey: ['tracks', album.id],
    queryFn: () => getAlbumTracks(conn, album.id),
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
        Library
      </button>

      <div className="flex items-center gap-4 sm:items-end sm:gap-6">
        <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl shadow-black/60 sm:h-52 sm:w-52">
          <Cover
            src={albumImageUrl(conn, album.id, album.imageTag, 520)}
            alt={album.name}
            className="h-full w-full"
          />
        </div>
        <div className="min-w-0 pb-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/82">
            Album
          </div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-4xl">{album.name}</h1>
          {album.artistId ? (
            <button
              onClick={() => {
                if (album.artistId)
                  onSelectArtist({ id: album.artistId, name: album.artist })
              }}
              className="mt-2 block text-left text-white/82 transition-colors hover:text-white hover:underline"
            >
              {album.artist}
            </button>
          ) : (
            <div className="mt-2 text-white/82">{album.artist}</div>
          )}
          <div className="mt-1 text-sm text-white/85">
            {[
              album.year,
              tracks ? `${tracks.length} track${tracks.length === 1 ? '' : 's'}` : null,
              totalSeconds ? formatDuration(totalSeconds) : null,
            ]
              .filter(Boolean)
              .join('  ·  ')}
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
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
          onClick={() => setEditing(true)}
          title="Edit album name / artist / year / cover"
          className="flex items-center gap-2 rounded-full border border-line px-4 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/5"
        >
          <Pencil className="h-4 w-4" />
          Edit
        </button>
        <div className="flex items-center rounded-full border border-line px-1 py-1 text-white/80">
          <AlbumMenu album={album} />
        </div>
      </div>

      {editing && (
        <AlbumEditor album={album} onClose={() => setEditing(false)} />
      )}

      <div className="mt-9">
        {isLoading && <TrackSkeleton />}
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
