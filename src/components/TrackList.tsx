import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Play, Pencil } from 'lucide-react'
import { Equalizer } from './Equalizer'
import { TrackMenu } from './TrackMenu'
import { NotesEditor } from './NotesEditor'
import { useConnected } from '../lib/connection'
import { getSongNotesIndex } from '../lib/api'
import { formatTime, ticksToSeconds } from '../lib/format'
import type { Artist, Track } from '../lib/types'

interface TrackRowProps {
  track: Track
  number: number
  isCurrent: boolean
  isPlaying: boolean
  onPlay: () => void
  /** When set, the track's artist name becomes a link to that artist. */
  onSelectArtist?: (artist: Artist) => void
  /** When set, the "Add to playlist" menu omits this playlist (you're
   *  already inside it). */
  excludePlaylistId?: string
}

/** One row in an album or playlist track listing.
 *
 *  The row is split into separate buttons — index, title and duration all
 *  play the track; the artist name navigates; the ⋯ opens its menu — so no
 *  interactive element is nested inside another. */
export function TrackRow({
  track,
  number,
  isCurrent,
  isPlaying,
  onPlay,
  onSelectArtist,
  excludePlaylistId,
}: TrackRowProps) {
  const accentStyle = { color: 'var(--accent)' }
  const artistId = track.artistId
  const conn = useConnected()
  const [editing, setEditing] = useState(false)
  // Shared index (same query key as the player bar) — one fetch, many rows.
  const { data: notesIndex } = useQuery({
    queryKey: ['song-notes', conn.serverUrl],
    queryFn: () => getSongNotesIndex(conn),
  })
  const hasNotes = notesIndex?.includes(track.id) ?? false

  return (
    <div
      className={`group flex w-full items-center border-b border-line pr-2 transition-colors last:border-b-0 ${
        isCurrent ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
      }`}
    >
      <button
        onClick={onPlay}
        aria-label="Play"
        className="flex shrink-0 items-center py-2.5 pl-4"
      >
        <span className="flex h-5 w-5 items-center justify-center">
          {isPlaying ? (
            <Equalizer />
          ) : (
            <>
              <span
                className="text-sm tabular-nums text-white/66 group-hover:hidden"
                style={isCurrent ? accentStyle : undefined}
              >
                {number}
              </span>
              <Play className="hidden h-3.5 w-3.5 fill-white text-white group-hover:block" />
            </>
          )}
        </span>
      </button>

      <div className="min-w-0 flex-1 py-2.5 pl-4">
        <button
          onClick={onPlay}
          className="block max-w-full truncate text-left text-xl font-semibold text-white"
          style={isCurrent ? accentStyle : undefined}
        >
          {track.name}
        </button>
        {onSelectArtist && artistId ? (
          <button
            onClick={() => {
              if (onSelectArtist && artistId)
                onSelectArtist({ id: artistId, name: track.artist })
            }}
            className="block max-w-full truncate text-left text-lg text-white/88 transition-colors hover:text-white/80 hover:underline"
          >
            {track.artist}
          </button>
        ) : (
          <div className="truncate text-lg text-white/88">{track.artist}</div>
        )}
      </div>

      <button
        onClick={onPlay}
        aria-label="Play"
        className="shrink-0 px-3 py-2.5 text-xs tabular-nums text-white/66"
      >
        {formatTime(ticksToSeconds(track.durationTicks))}
      </button>

      {/* Notes pencil — always present (so row sizing is identical whether or
          not a song has notes); accent + filled when this song is annotated. */}
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label={hasNotes ? 'Edit notes' : 'Add notes'}
        title={hasNotes ? 'Edit notes' : 'Add notes'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-white/10"
        style={{ color: hasNotes ? 'var(--accent)' : 'rgba(255,255,255,0.35)' }}
      >
        <Pencil className={`h-4 w-4 ${hasNotes ? 'fill-current' : ''}`} />
      </button>

      <TrackMenu track={track} excludePlaylistId={excludePlaylistId} />

      {editing && (
        <NotesEditor
          track={{ id: track.id, name: track.name, artist: track.artist }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

/** Placeholder rows shown while a track listing loads. */
export function TrackSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="h-12 animate-pulse rounded-lg bg-white/14" />
      ))}
    </div>
  )
}
