import { useEffect, useMemo, useState } from 'react'
import { Download, Trash2, Play, HardDrive, WifiOff } from 'lucide-react'
import { usePlayer } from '../lib/player'
import {
  useDownloads,
  removeDownload,
  clearAllDownloads,
  storageEstimate,
  type DownloadRecord,
} from '../lib/downloads'
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

interface AlbumGroup {
  key: string
  album: string
  artist: string
  artUrl: string
  records: DownloadRecord[]
}

/**
 * The Downloads tab: the offline library. Lists everything that's been
 * downloaded (grouped by album), plays it straight from the audio cache — so
 * it works with the server unreachable — and lets the user see storage usage
 * and delete to free space.
 */
export function DownloadsView() {
  const downloads = useDownloads()
  const player = usePlayer()
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Refresh the storage meter whenever the download set changes.
  useEffect(() => {
    let alive = true
    void storageEstimate().then((e) => {
      if (alive) setUsage(e)
    })
    return () => {
      alive = false
    }
  }, [downloads])

  // A flat queue across all downloads, so a tap plays into the wider list.
  const queue = useMemo(() => downloads.map((r) => r.track), [downloads])
  const indexOf = useMemo(() => {
    const m = new Map<string, number>()
    downloads.forEach((r, i) => m.set(r.id, i))
    return m
  }, [downloads])

  const groups = useMemo<AlbumGroup[]>(() => {
    const m = new Map<string, AlbumGroup>()
    for (const rec of downloads) {
      const key = rec.track.albumId ?? rec.track.album ?? rec.id
      let g = m.get(key)
      if (!g) {
        g = {
          key,
          album: rec.track.album,
          artist: rec.track.artist,
          artUrl: rec.artUrl,
          records: [],
        }
        m.set(key, g)
      }
      g.records.push(rec)
    }
    return [...m.values()]
  }, [downloads])

  const totalBytes = useMemo(
    () => downloads.reduce((sum, r) => sum + r.size, 0),
    [downloads],
  )

  if (downloads.length === 0) {
    return (
      <div className="px-8 py-8">
        <Header online={online} />
        <div className="mt-10 flex flex-col items-center gap-3 rounded-xl border border-line bg-surface/60 px-6 py-16 text-center">
          <Download className="h-8 w-8 text-white/20" />
          <p className="text-base font-medium text-white/70">No downloads yet</p>
          <p className="max-w-sm text-sm text-white/45">
            Use the <span className="font-semibold text-white/70">⋮</span> menu on any
            song or album to download it. Downloads play here even when the server
            is unreachable.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-8 py-8">
      <Header online={online} />

      {/* Storage meter + manage. */}
      <div className="mt-5 rounded-xl border border-line bg-surface/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-white/70">
            <HardDrive className="h-4 w-4 text-white/40" />
            <span>
              {downloads.length} song{downloads.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(totalBytes)}
              {usage && usage.quota > 0 && (
                <span className="text-white/40">
                  {'  '}of {formatBytes(usage.quota)} available
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Remove all downloads? This frees the space they use.')) {
                void clearAllDownloads()
              }
            }}
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/5"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove all
          </button>
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

      <div className="mt-8 flex flex-col gap-7">
        {groups.map((group) => (
          <div key={group.key}>
            <div className="mb-2 flex items-center gap-3">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-elevated">
                <Cover src={group.artUrl} alt={group.album} className="h-full w-full" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-white">
                  {group.album}
                </div>
                <div className="truncate text-sm text-white/55">{group.artist}</div>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-line">
              {group.records.map((rec) => {
                const idx = indexOf.get(rec.id) ?? 0
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
                      onClick={() => player.playQueue(queue, idx)}
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
                      onClick={() => player.playQueue(queue, idx)}
                      className="min-w-0 flex-1 truncate py-2.5 pl-4 text-left text-lg font-semibold text-white"
                      style={isCurrent ? { color: 'var(--accent)' } : undefined}
                    >
                      {rec.track.name}
                    </button>
                    <span className="shrink-0 px-3 text-xs tabular-nums text-white/35">
                      {formatTime(ticksToSeconds(rec.track.durationTicks))}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeDownload(rec.id)}
                      aria-label="Remove download"
                      title="Remove download"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/30 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Header({ online }: { online: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-2xl font-bold tracking-tight">Downloads</h1>
      {!online && (
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-3 py-1 text-xs font-medium text-white/60">
          <WifiOff className="h-3.5 w-3.5" />
          Offline
        </span>
      )}
    </div>
  )
}
