import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { Check, Loader2, Monitor, Smartphone, Trash2, X } from 'lucide-react'
import { useRemoteMode } from '../lib/remote-mode'
import {
  hostLabel,
  normalizeOrigin,
  probeServer,
  selfOrigin,
} from '../lib/remote-target'

/**
 * "Control which computer?" — tapping the Cast icon opens this instead of a
 * blind toggle. One choice engages remote control of an island (its `/remote`
 * WebSocket + its `/api` data, per design §3). Feeders: this computer (the
 * serving host), every remembered island, and manual host/IP entry. Each row
 * carries a live reachability dot. "Stop controlling" returns to local play.
 */
export function RemoteControlSheet({ onClose }: { onClose: () => void }) {
  const { target, servers, control, stopControlling, forgetServer } = useRemoteMode()
  const self = selfOrigin()
  // True when this device served the page to itself (desktop on localhost).
  // In that case "control the serving host" would be a self-loop that kills
  // its own playback, so we hide it and only offer "play here".
  const selfIsLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(self)

  // Reachability: origin → up/down/unknown. Re-probed on open.
  const [reach, setReach] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  // The full set of rows is self + remembered (deduped; self may also be
  // remembered after you've controlled it).
  const origins = Array.from(new Set([self, ...servers.map((s) => s.url)]))
  const originsKey = origins.join('|')

  // Re-probe reachability whenever the set of islands changes (open / add /
  // forget). `origins` is intentionally read from the closure; the primitive
  // `originsKey` is what actually drives re-runs.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      origins.map(async (o) => [o, await probeServer(o)] as const),
    ).then((pairs) => {
      if (!cancelled) setReach(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originsKey])

  function engage(origin: string) {
    control(origin)
    onClose()
  }

  function addManual() {
    const origin = normalizeOrigin(adding)
    setAddError(null)
    if (!origin) {
      setAddError('Enter a host or IP, e.g. 192.168.1.50 or 192.168.1.50:5173')
      return
    }
    engage(origin)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onClick={onClose}
      className="absolute inset-0 z-[70] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
    >
      <motion.div
        initial={{ scale: 0.96, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-line bg-surface shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-lg font-semibold">Control which computer?</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid max-h-[60vh] grid-cols-1 gap-2 overflow-y-auto p-4">
          {/* Local playback — this device plays the audio. Always available. */}
          <ServerRow
            icon={<Smartphone className="h-5 w-5" />}
            title="Play on this device"
            sub="Audio comes out here"
            up={true}
            selected={target === null}
            onClick={() => {
              stopControlling()
              onClose()
            }}
          />

          {/* The computer that served this page — only when it's a DIFFERENT
              machine (loaded over the network, e.g. a phone served by the
              laptop). On a desktop serving itself this would be a self-loop
              that stops its own playback, so it's hidden. */}
          {!selfIsLoopback && (
            <ServerRow
              icon={<Monitor className="h-5 w-5" />}
              title="This computer (served this page)"
              sub={hostLabel(self)}
              up={reach[self]}
              selected={target === self}
              onClick={() => engage(self)}
            />
          )}

          {/* Remembered islands (excluding self, already shown above). */}
          {servers
            .filter((s) => s.url !== self)
            .map((s) => (
              <ServerRow
                key={s.url}
                icon={<Monitor className="h-5 w-5" />}
                title={s.label || hostLabel(s.url)}
                sub={hostLabel(s.url)}
                up={reach[s.url]}
                selected={target === s.url}
                onClick={() => engage(s.url)}
                onForget={() => forgetServer(s.url)}
              />
            ))}

          {/* Manual add by host/IP. */}
          <div className="mt-1 rounded-xl border border-dashed border-line/70 p-3">
            <label className="text-[11px] font-medium uppercase tracking-wide text-white/45">
              Add by IP or host
            </label>
            <div className="mt-1 flex gap-2">
              <input
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addManual()
                  if (e.key === 'Escape') {
                    setAdding('')
                    setAddError(null)
                  }
                }}
                placeholder="192.168.1.50"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="input min-w-0 flex-1 font-mono text-sm"
              />
              <button
                type="button"
                onClick={addManual}
                disabled={!adding.trim()}
                className="shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
                style={{ background: 'var(--accent)' }}
              >
                Connect
              </button>
            </div>
            {addError && <div className="mt-1 text-xs text-red-300/85">{addError}</div>}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

interface ServerRowProps {
  icon: React.ReactNode
  title: string
  sub: string
  /** undefined = still probing, true = reachable, false = down. */
  up: boolean | undefined
  selected: boolean
  onClick: () => void
  onForget?: () => void
}

function ServerRow({ icon, title, sub, up, selected, onClick, onForget }: ServerRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        selected
          ? 'bg-white/[0.06]'
          : 'border-line/60 bg-white/[0.02] hover:border-line hover:bg-white/[0.05]'
      }`}
      style={selected ? { borderColor: 'var(--accent)' } : undefined}
    >
      <span className="shrink-0 text-white/70">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-white/90">{title}</span>
          {selected && <Check className="h-4 w-4" style={{ color: 'var(--accent)' }} />}
        </div>
        <div className="truncate text-xs text-white/50">{sub}</div>
      </div>
      {/* Reachability dot. */}
      {up === undefined ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/35" />
      ) : (
        <span
          title={up ? 'Reachable' : 'Not reachable'}
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            up ? 'bg-emerald-400' : 'bg-white/25'
          }`}
        />
      )}
      {onForget && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onForget()
          }}
          title="Forget this computer"
          className="shrink-0 rounded p-1 text-white/30 opacity-0 transition-colors hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
