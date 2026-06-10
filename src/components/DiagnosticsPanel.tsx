import { useEffect, useState } from 'react'
import { Copy, Trash2, RefreshCw, Check, Download } from 'lucide-react'
import {
  getCrashLog,
  clearCrashLog,
  subscribeCrashLog,
  type LogEntry,
} from '../lib/crash-log'

function formatTime(t: number): string {
  const d = new Date(t)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function entriesAsText(entries: LogEntry[]): string {
  return entries
    .map((e) => {
      const head = `${formatTime(e.t)} [${e.level.toUpperCase()}] ${e.source} — ${e.message}`
      return e.data ? `${head}\n  ${e.data.replace(/\n/g, '\n  ')}` : head
    })
    .join('\n')
}

export function DiagnosticsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>(() => getCrashLog())
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    return subscribeCrashLog(() => setEntries(getCrashLog()))
  }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(entriesAsText(entries))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard blocked — fall back to selection.
    }
  }

  function download() {
    const blob = new Blob([entriesAsText(entries)], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    a.href = url
    a.download = `allegory-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mt-5">
      <p className="mb-3 text-sm text-white/55">
        A rolling log of playback + lifecycle events, kept in this browser so
        it survives a crash. When playback dies in the car, open this, find the
        last events, and Copy or Download them.
      </p>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-xs text-white/45">
          {entries.length} event{entries.length === 1 ? '' : 's'} · most recent at the bottom
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setEntries(getCrashLog())}
            title="Refresh"
            aria-label="Refresh"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={entries.length === 0}
            title="Copy log"
            aria-label="Copy log"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={download}
            disabled={entries.length === 0}
            title="Download log"
            aria-label="Download log"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              clearCrashLog()
              setEntries([])
            }}
            disabled={entries.length === 0}
            title="Clear log"
            aria-label="Clear log"
            className="rounded-md p-1.5 text-white/50 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-line/60 bg-surface/30 p-6 text-center text-sm text-white/45">
          No events recorded yet.
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-line/60 bg-black/30 font-mono text-[11px] leading-relaxed">
          {entries.map((e, i) => (
            <div
              key={i}
              className={`border-b border-line/30 px-3 py-1.5 last:border-b-0 ${
                e.level === 'error'
                  ? 'text-red-300/90'
                  : e.level === 'warn'
                    ? 'text-amber-300/85'
                    : 'text-white/70'
              }`}
            >
              <div className="flex gap-2">
                <span className="shrink-0 text-white/35">{formatTime(e.t)}</span>
                <span className="shrink-0 uppercase tracking-wide text-white/45">
                  {e.source}
                </span>
                <span className="min-w-0 flex-1 break-words">{e.message}</span>
              </div>
              {e.data && (
                <pre className="mt-1 whitespace-pre-wrap break-words pl-[6.5rem] text-white/40">
                  {e.data}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
