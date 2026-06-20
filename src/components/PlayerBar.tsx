import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Music2,
  Heart,
  Repeat,
  Repeat1,
  Pencil,
} from 'lucide-react'
import { usePlayer } from '../lib/player'
import { useConnected } from '../lib/connection'
import { trackImageUrl, getSongNotesIndex } from '../lib/api'
import { Cover } from './Cover'
import { SeekBar } from './SeekBar'
import { NotesEditor } from './NotesEditor'
import { formatTime } from '../lib/format'
import type { Album, Artist } from '../lib/types'

interface PlayerBarProps {
  /** Jump to the current track's album / artist pages from the bar. */
  onOpenAlbum: (album: Album) => void
  onOpenArtist: (artist: Artist) => void
}

// One player bar for every width — the same phone-style transport on desktop
// and phone alike.
export function PlayerBar({ onOpenAlbum, onOpenArtist }: PlayerBarProps) {
  const conn = useConnected()
  const player = usePlayer()
  const track = player.currentTrack
  const isFav = player.isCurrentFavorite
  // Snapshot the track when the pencil is clicked, so notes lock to THAT song
  // even if playback advances to the next track while the editor is open.
  const [editingTrack, setEditingTrack] = useState<
    { id: string; name: string; artist: string } | null
  >(null)

  // Which tracks have notes — shared with the track-list pencils (same key).
  const { data: notesIndex } = useQuery({
    queryKey: ['song-notes', conn.serverUrl],
    queryFn: () => getSongNotesIndex(conn),
  })
  const hasNotes = !!track && (notesIndex?.includes(track.id) ?? false)

  return (
    <div className="glass z-20 flex shrink-0 flex-col gap-2 border-t border-line px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-3">
        {track ? (
          <button
            type="button"
            onClick={() => {
              if (track.albumId)
                onOpenAlbum({
                  id: track.albumId,
                  name: track.album,
                  artist: track.artist,
                  artistId: track.artistId,
                  imageTag: track.albumImageTag,
                })
            }}
            disabled={!track.albumId}
            aria-label={`Open album ${track.album}`}
            className="h-12 w-12 shrink-0 overflow-hidden rounded-lg shadow-md transition-transform enabled:hover:scale-105 enabled:active:scale-95 disabled:cursor-default"
          >
            <Cover
              src={trackImageUrl(conn, track, 140)}
              alt={track.album}
              className="h-full w-full"
            />
          </button>
        ) : (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/62">
            <Music2 className="h-5 w-5" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate text-2xl font-semibold text-white">
            {track ? track.name : 'Nothing playing'}
          </div>
          {track &&
            (track.artistId ? (
              <button
                type="button"
                onClick={() => {
                  if (track.artistId)
                    onOpenArtist({ id: track.artistId, name: track.artist })
                }}
                className="truncate text-left text-lg text-white/88 transition-colors hover:text-white hover:underline"
              >
                {track.artist}
              </button>
            ) : (
              <div className="truncate text-lg text-white/88">{track.artist}</div>
            ))}
        </div>
        {/* Notes pencil — edit the curator notes that ground Socrates for this
            song. Filled/accent when the song already has notes. */}
        <button
          type="button"
          onClick={() =>
            track && setEditingTrack({ id: track.id, name: track.name, artist: track.artist })
          }
          disabled={!track}
          aria-label={hasNotes ? 'Edit notes for this song' : 'Add notes for this song'}
          aria-pressed={hasNotes}
          title={hasNotes ? 'Edit notes' : 'Add notes'}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/5 disabled:opacity-30"
          style={{ color: hasNotes ? 'var(--accent)' : 'rgba(255,255,255,0.55)' }}
        >
          <Pencil className={`h-5 w-5 ${hasNotes ? 'fill-current' : ''}`} />
        </button>
      </div>

      {editingTrack && (
        <NotesEditor
          track={editingTrack}
          onClose={() => setEditingTrack(null)}
        />
      )}

      <div className="flex items-center gap-2">
        <span className="w-9 text-right text-[11px] tabular-nums text-white/85">
          {formatTime(player.currentTime)}
        </span>
        <SeekBar
          value={player.currentTime}
          max={player.duration}
          onSeek={player.seek}
          className="flex-1"
        />
        <span className="w-9 text-[11px] tabular-nums text-white/85">
          {formatTime(player.duration)}
        </span>
      </div>

      {/* Transport — symmetric around the play button:
          Prev · Like · Play/Pause · Repeat · Next */}
      <div className="flex items-center justify-center gap-2 pt-1 sm:gap-3">
        <button
          onClick={player.prev}
          disabled={!track}
          aria-label="Previous"
          className="flex h-12 w-12 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
        >
          <SkipBack className="h-6 w-6 fill-current" />
        </button>
        <button
          onClick={player.toggleCurrentFavorite}
          disabled={!track}
          aria-label={isFav ? 'Remove favorite' : 'Favorite'}
          aria-pressed={isFav}
          className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/5 disabled:opacity-30"
          style={{ color: isFav ? 'var(--accent)' : 'rgba(255,255,255,0.85)' }}
        >
          <Heart className={`h-5 w-5 ${isFav ? 'fill-current' : ''}`} />
        </button>
        <button
          onClick={player.togglePlay}
          disabled={!track}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
          className="flex h-[54px] w-[54px] items-center justify-center rounded-full bg-white text-black shadow-xl transition-transform active:scale-95 disabled:opacity-30"
        >
          {player.isPlaying ? (
            <Pause className="h-6 w-6 fill-black" />
          ) : (
            <Play className="h-6 w-6 translate-x-[1px] fill-black" />
          )}
        </button>
        <button
          onClick={player.cycleRepeat}
          aria-label={
            player.repeatMode === 'one'
              ? 'Repeat one'
              : player.repeatMode === 'all'
                ? 'Repeat all'
                : 'Repeat'
          }
          aria-pressed={player.repeatMode !== 'off'}
          className="flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/5"
          style={{
            color: player.repeatMode === 'off' ? 'rgba(255,255,255,0.85)' : 'var(--accent)',
          }}
        >
          {player.repeatMode === 'one' ? (
            <Repeat1 className="h-5 w-5" />
          ) : (
            <Repeat className="h-5 w-5" />
          )}
        </button>
        <button
          onClick={player.next}
          disabled={!track}
          aria-label="Next"
          className="flex h-12 w-12 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
        >
          <SkipForward className="h-6 w-6 fill-current" />
        </button>
      </div>
    </div>
  )
}
