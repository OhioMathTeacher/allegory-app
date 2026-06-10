import { useState } from 'react'
import type { MouseEvent } from 'react'
import { Play, Loader2, Check } from 'lucide-react'
import { useConnected } from '../lib/connection'
import { usePlayer } from '../lib/player'
import { getAlbumTracks, albumImageUrl } from '../lib/api'
import { Cover } from './Cover'
import { AlbumEditor } from './AlbumEditor'
import { useLongPress } from '../lib/use-long-press'
import type { Album } from '../lib/types'

interface AlbumCardProps {
  album: Album
  index: number
  onSelect: (album: Album) => void
  /** 1-based position in the selection (1 = the merge target / kept album). */
  selectIndex?: number
  /** True when any album is currently selected — keeps the circle visible. */
  hasSelection?: boolean
  /** Toggle this album in/out of the selection. */
  onToggleSelect?: () => void
}

export function AlbumCard({
  album,
  onSelect,
  selectIndex,
  hasSelection,
  onToggleSelect,
}: AlbumCardProps) {
  const conn = useConnected()
  const player = usePlayer()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  const isSelected = selectIndex != null
  const isTarget = selectIndex === 1

  const longPress = useLongPress({
    onLongPress: () => setEditing(true),
    onClick: () => onSelect(album),
  })

  async function playAlbum(e: MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const tracks = await getAlbumTracks(conn, album.id)
      if (tracks.length > 0) player.playQueue(tracks, 0)
    } finally {
      setBusy(false)
    }
  }

  function clickCircle(e: MouseEvent) {
    e.stopPropagation()
    onToggleSelect?.()
  }

  return (
    <div
      id={`album-${album.id}`}
      className="group text-left scroll-mt-32"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 360px' }}
    >
      <div
        className="relative aspect-square overflow-hidden rounded-xl border-2 bg-elevated shadow-lg shadow-black/40 transition-all duration-300 group-hover:-translate-y-1"
        style={{
          borderColor: !isSelected
            ? 'transparent'
            : isTarget
              ? 'var(--accent)'
              : 'rgba(255,255,255,0.55)',
        }}
      >
        <Cover
          src={albumImageUrl(conn, album.id, album.imageTag, 256)}
          alt={album.name}
          className="h-full w-full transition-transform duration-500 group-hover:scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <button
          type="button"
          onClick={() => onSelect(album)}
          aria-label={album.name}
          className="absolute inset-0"
        />
        {onToggleSelect && (
          <button
            type="button"
            onClick={clickCircle}
            aria-label={isSelected ? 'Deselect' : 'Select'}
            title={isSelected ? 'Deselect' : 'Select for combine'}
            className={`absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 backdrop-blur-sm transition-all duration-150 ${
              isSelected
                ? 'opacity-100'
                : hasSelection
                  ? 'opacity-80 hover:opacity-100'
                  : 'opacity-0 group-hover:opacity-90 hover:opacity-100'
            }`}
            style={{
              borderColor: isSelected
                ? isTarget
                  ? 'var(--accent)'
                  : 'rgba(255,255,255,0.85)'
                : 'rgba(255,255,255,0.6)',
              background: isSelected
                ? isTarget
                  ? 'var(--accent)'
                  : 'rgba(255,255,255,0.9)'
                : 'rgba(0,0,0,0.5)',
              color: isSelected ? '#000' : '#fff',
            }}
          >
            {isSelected ? (
              <span className="text-[11px] font-bold tabular-nums">{selectIndex}</span>
            ) : (
              <Check className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={playAlbum}
          aria-label={`Play ${album.name}`}
          className="absolute bottom-3 right-3 flex h-11 w-11 translate-y-3 items-center justify-center rounded-full opacity-0 shadow-xl transition-all duration-300 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100"
          style={{ background: 'var(--accent)' }}
        >
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin text-black" />
          ) : (
            <Play className="h-5 w-5 translate-x-[1px] fill-black text-black" />
          )}
        </button>
      </div>
      <div
        {...longPress}
        role="button"
        tabIndex={0}
        title="Click to open · long-press to edit"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(album)
          }
        }}
        className="mt-3 block w-full cursor-pointer select-none text-left"
      >
        <div className="truncate text-xl font-semibold text-white">
          {album.name}
        </div>
        <div className="truncate text-lg text-white/65">{album.artist}</div>
      </div>
      {editing && (
        <AlbumEditor album={album} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}
