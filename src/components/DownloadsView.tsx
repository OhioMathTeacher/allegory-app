import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Download,
  Trash2,
  Play,
  Shuffle,
  HardDrive,
  WifiOff,
  Music2,
} from 'lucide-react'
import { usePlayer } from '../lib/player'
import {
  useDownloads,
  removeDownload,
  clearAllDownloads,
  storageEstimate,
  type DownloadRecord,
} from '../lib/downloads'
import { shuffle } from '../lib/shuffle'
import { formatTime, ticksToSeconds } from '../lib/format'
import { Equalizer } from './Equalizer'
import { Cover } from './Cover'

/** Bytes → a compact human size (e.g. "1.4 GB"). */
function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Downloaded tracks for one album, in disc/track order. */
interface AlbumGroup {
  key: string
  album: string
  artUrl: string
  records: DownloadRecord[]
}

/** Everything downloaded for one artist — their albums plus a flat, ordered
 *  queue across all of them (album order, then track order). */
interface ArtistGroup {
  key: string
  artist: string
  /** Representative cover (first album's art) for the list avatar. */
  artUrl: string
  albums: AlbumGroup[]
  /** All of the artist's downloaded tracks, album-then-track order. */
  records: DownloadRecord[]
}

/** Order tracks within an album by disc, then track index. */
function byTrackOrder(a: DownloadRecord, b: DownloadRecord): number {
  const disc = (a.track.discNumber ?? 0) - (b.track.discNumber ?? 0)
  if (disc !== 0) return disc
  return (a.track.index ?? 0) - (b.track.index ?? 0)
}

/** Group the flat download list into artists → albums → tracks. */
function groupByArtist(downloads: DownloadRecord[]): ArtistGroup[] {
  const artists = new Map<string, { artist: string; albums: Map<string, AlbumGroup> }>()
  for (const rec of downloads) {
    const artistKey = rec.track.artist || 'Unknown Artist'
    let a = artists.get(artistKey)
    if (!a) {
      a = { artist: artistKey, albums: new Map() }
      artists.set(artistKey, a)
    }
    const albumKey = rec.track.albumId ?? rec.track.album ?? rec.id
    let al = a.albums.get(albumKey)
    if (!al) {
      al = { key: albumKey, album: rec.track.album, artUrl: rec.artUrl, records: [] }
      a.albums.set(albumKey, al)
    }
    al.records.push(rec)
  }

  const groups: ArtistGroup[] = []
  for (const [key, a] of artists) {
    const albums = [...a.albums.values()]
    albums.forEach((al) => al.records.sort(byTrackOrder))
    albums.sort((x, y) => x.album.localeCompare(y.album))
    groups.push({
      key,
      artist: a.artist,
      artUrl: albums[0]?.artUrl ?? '',
      albums,
      records: albums.flatMap((al) => al.records),
    })
  }
  groups.sort((x, y) => x.artist.localeCompare(y.artist, undefined, { sensitivity: 'base' }))
  return groups
}

/**
 * The Downloads tab: the offline library, browsed like a local Artists tab.
 * Lists downloaded artists; tap one to see their albums and play all of their
 * downloads — or just one album. Everything plays straight from the audio cache
 * so it works with the server unreachable.
 */
export function DownloadsView() {
  const downloads = useDownloads()
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  // Which artist's page is open, by artist key. Null shows the artist list.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const artists = useMemo(() => groupByArtist(downloads), [downloads])
  // Resolve the open artist fresh each render so removing their last track
  // (which drops them from `artists`) falls back to the list cleanly.
  const selected = selectedKey
    ? artists.find((a) => a.key === selectedKey) ?? null
    : null

  if (downloads.length === 0) {
    return (
      <div className="px-8 py-8">
        <Header online={online} />
        <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 px-6 py-16 text-center">
          <Download className="h-8 w-8 text-white/45" />
          <p className="text-base font-medium text-white/70">No downloads yet</p>
          <p className="max-w-sm text-sm text-white/74">
            Use the <span className="font-semibold text-white/70">⋮</span> menu on any
            song or album to download it. Downloads play here even when the server
            is unreachable.
          </p>
        </div>
      </div>
    )
  }

  if (selected) {
    return (
      <ArtistDownloads
        group={selected}
        online={online}
        onBack={() => setSelectedKey(null)}
      />
    )
  }

  return (
    <ArtistList
      artists={artists}
      downloads={downloads}
      online={online}
      onSelect={(g) => setSelectedKey(g.key)}
    />
  )
}

/** The list of downloaded artists, plus the storage meter. */
function ArtistList({
  artists,
  downloads,
  online,
  onSelect,
}: {
  artists: ArtistGroup[]
  downloads: DownloadRecord[]
  online: boolean
  onSelect: (group: ArtistGroup) => void
}) {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    let alive = true
    void storageEstimate().then((e) => {
      if (alive) setUsage(e)
    })
    return () => {
      alive = false
    }
  }, [downloads])

  const totalBytes = useMemo(
    () => downloads.reduce((sum, r) => sum + r.size, 0),
    [downloads],
  )

  return (
    <div className="px-8 py-8">
      <Header online={online} />

      {/* Storage meter. */}
      <div className="mt-5 rounded-xl border border-line bg-surface/60 p-4">
        <div className="flex items-center gap-2 text-sm text-white/70">
          <HardDrive className="h-4 w-4 text-white/70" />
          <span>
            {downloads.length} song{downloads.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(totalBytes)}
            {usage && usage.quota > 0 && (
              <span className="text-white/70">
                {'  '}of {formatBytes(usage.quota)} available
              </span>
            )}
          </span>
        </div>
        {usage && usage.quota > 0 && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, (usage.usage / usage.quota) * 100)}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-7 flex flex-col">
        {artists.map((group) => (
          <ArtistRow key={group.key} group={group} onSelect={onSelect} />
        ))}
      </div>

      {/* Destructive action kept out of the way at the very bottom. */}
      <div className="mt-8 flex justify-center border-t border-line/40 pt-6">
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Remove all downloads? This frees the space they use.')) {
              void clearAllDownloads()
            }
          }}
          className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2 text-xs font-medium text-red-300/80 transition-colors hover:bg-red-500/10 hover:text-red-200"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove all downloads
        </button>
      </div>
    </div>
  )
}

/** One artist in the list: avatar, name, a count, and a scoped play button. */
function ArtistRow({
  group,
  onSelect,
}: {
  group: ArtistGroup
  onSelect: (group: ArtistGroup) => void
}) {
  const player = usePlayer()
  const songs = group.records.length
  const albums = group.albums.length

  return (
    <div className="group relative flex items-center gap-3 rounded-lg border-b border-line/50 px-2 py-2 hover:bg-white/14">
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-elevated">
        {group.artUrl ? (
          <Cover src={group.artUrl} alt={group.artist} className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Music2 className="h-4 w-4 text-white/15" />
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onSelect(group)}
        className="min-w-0 flex-1 cursor-pointer select-none text-left"
      >
        <div className="truncate text-xl font-semibold text-white">{group.artist}</div>
        <div className="truncate text-sm text-white/82">
          {albums} album{albums === 1 ? '' : 's'} · {songs} song{songs === 1 ? '' : 's'}
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          player.playQueue(group.records.map((r) => r.track), 0)
        }}
        aria-label={`Play ${group.artist}`}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
        style={{ background: 'var(--accent)' }}
      >
        <Play className="h-3.5 w-3.5 translate-x-[1px] fill-black text-black" />
      </button>
    </div>
  )
}

/** One artist's page: a header with scoped Play/Shuffle, then each album with
 *  its own play control and track rows. Tapping a track plays its album. */
function ArtistDownloads({
  group,
  online,
  onBack,
}: {
  group: ArtistGroup
  online: boolean
  onBack: () => void
}) {
  const player = usePlayer()
  const artistTracks = useMemo(() => group.records.map((r) => r.track), [group])
  const songs = group.records.length

  return (
    <div className="px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-base font-semibold text-white transition-colors hover:text-white/80"
        >
          <ArrowLeft className="h-5 w-5" />
          Downloads
        </button>
        {!online && <OfflineBadge />}
      </div>

      <div className="mt-6 flex items-center gap-4">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-elevated shadow-lg shadow-black/40 sm:h-20 sm:w-20">
          {group.artUrl ? (
            <Cover src={group.artUrl} alt={group.artist} className="h-full w-full" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Music2 className="h-6 w-6 text-white/15" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-white/82">
            Downloaded
          </div>
          <h1 className="mt-1 break-words text-2xl font-bold tracking-tight sm:text-3xl">
            {group.artist}
          </h1>
          <div className="mt-1 text-sm text-white/85">
            {group.albums.length} album{group.albums.length === 1 ? '' : 's'} · {songs}{' '}
            song{songs === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={() => player.playQueue(artistTracks, 0)}
          className="flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-semibold text-black transition-transform hover:scale-105"
          style={{ background: 'var(--accent)' }}
        >
          <Play className="h-4 w-4 fill-black" />
          Play
        </button>
        <button
          onClick={() => player.playQueue(shuffle(artistTracks), 0)}
          className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/14"
        >
          <Shuffle className="h-4 w-4" />
          Shuffle
        </button>
      </div>

      <div className="mt-8 flex flex-col gap-7">
        {group.albums.map((album) => (
          <AlbumSection key={album.key} album={album} />
        ))}
      </div>
    </div>
  )
}

/** One album within an artist's page: header (with a scoped play) + track rows.
 *  Playback here is scoped to this album's queue. */
function AlbumSection({ album }: { album: AlbumGroup }) {
  const player = usePlayer()
  const albumTracks = useMemo(() => album.records.map((r) => r.track), [album])

  return (
    <div>
      <div className="group mb-2 flex items-center gap-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-elevated">
          <Cover src={album.artUrl} alt={album.album} className="h-full w-full" />
        </div>
        <button
          type="button"
          onClick={() => player.playQueue(albumTracks, 0)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-base font-semibold text-white">{album.album}</div>
          <div className="truncate text-sm text-white/82">
            {album.records.length} song{album.records.length === 1 ? '' : 's'}
          </div>
        </button>
        <button
          type="button"
          onClick={() => player.playQueue(albumTracks, 0)}
          aria-label={`Play ${album.album}`}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
          style={{ background: 'var(--accent)' }}
        >
          <Play className="h-3.5 w-3.5 translate-x-[1px] fill-black text-black" />
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {album.records.map((rec, idx) => {
          const isCurrent = player.currentTrack?.id === rec.id
          const isPlaying = isCurrent && player.isPlaying
          return (
            <div
              key={rec.id}
              className={`group flex w-full items-center border-b border-line pr-2 transition-colors last:border-b-0 ${
                isCurrent ? 'bg-white/[0.05]' : 'hover:bg-white/[0.03]'
              }`}
            >
              <button
                onClick={() => player.playQueue(albumTracks, idx)}
                aria-label="Play"
                className="flex shrink-0 items-center py-2.5 pl-4"
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  {isPlaying ? (
                    <Equalizer />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-white text-white" />
                  )}
                </span>
              </button>
              <button
                onClick={() => player.playQueue(albumTracks, idx)}
                className="min-w-0 flex-1 truncate py-2.5 pl-4 text-left text-lg font-semibold text-white"
                style={isCurrent ? { color: 'var(--accent)' } : undefined}
              >
                {rec.track.name}
              </button>
              <span className="shrink-0 px-3 text-xs tabular-nums text-white/66">
                {formatTime(ticksToSeconds(rec.track.durationTicks))}
              </span>
              <button
                type="button"
                onClick={() => void removeDownload(rec.id)}
                aria-label="Remove download"
                title="Remove download"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/62 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Header({ online }: { online: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Downloads</h1>
      {!online && <OfflineBadge />}
    </div>
  )
}

function OfflineBadge() {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-white/85">
      <WifiOff className="h-3.5 w-3.5" />
      Offline
    </span>
  )
}
