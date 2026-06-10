/**
 * Ring-buffered diagnostic log persisted in localStorage so it survives a
 * Safari OOM kill of the tab. When the user comes back after a "crash" we
 * can read what was happening in the seconds before the process went away.
 *
 * Nothing here is reactive; the Diagnostics UI polls via `subscribe` to know
 * when to re-render.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  source: string
  message: string
  data?: string
}

const STORAGE_KEY = 'allegory.crashLog'
const MAX_ENTRIES = 300

const listeners = new Set<() => void>()
let cache: LogEntry[] | null = null

function read(): LogEntry[] {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    cache = Array.isArray(parsed) ? (parsed as LogEntry[]) : []
  } catch {
    cache = []
  }
  return cache
}

function write(entries: LogEntry[]): void {
  cache = entries
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota exceeded — drop oldest half and try once more.
    const trimmed = entries.slice(-Math.floor(MAX_ENTRIES / 2))
    cache = trimmed
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      // Storage is hopeless; keep the in-memory cache.
    }
  }
  for (const fn of listeners) fn()
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) {
      return v.stack ? `${v.name}: ${v.message}\n${v.stack}` : `${v.name}: ${v.message}`
    }
    if (typeof v === 'string') return v
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function logCrash(
  level: LogLevel,
  source: string,
  message: string,
  data?: unknown,
): void {
  const entry: LogEntry = {
    t: Date.now(),
    level,
    source,
    message,
    data: data === undefined ? undefined : safeStringify(data),
  }
  const entries = read().concat(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  write(entries)
}

export function getCrashLog(): LogEntry[] {
  return [...read()]
}

export function clearCrashLog(): void {
  write([])
}

export function subscribeCrashLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// --- global installer ----------------------------------------------------

let installed = false

/**
 * One-time setup of window-level handlers. Safe to call repeatedly.
 * Logs a boot marker so the user can see where the previous session ended.
 */
export function installCrashHandlers(): void {
  if (installed) return
  installed = true

  logCrash('info', 'boot', 'session start', {
    ua: navigator.userAgent,
    platform: navigator.platform,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    online: navigator.onLine,
  })

  window.addEventListener('error', (e) => {
    logCrash('error', 'window.error', e.message || 'unknown error', {
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    })
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    const msg = reason instanceof Error ? reason.message : String(reason)
    logCrash('error', 'unhandled-rejection', msg, reason)
  })

  document.addEventListener('visibilitychange', () => {
    logCrash('info', 'visibility', document.visibilityState)
  })

  window.addEventListener('online', () => logCrash('info', 'network', 'online'))
  window.addEventListener('offline', () => logCrash('warn', 'network', 'offline'))
  window.addEventListener('pagehide', () =>
    logCrash('info', 'lifecycle', 'pagehide'),
  )

  // Chrome-only JS heap polling. Safari (incl. iOS) doesn't expose this,
  // so we just no-op there.
  type PerfWithMemory = Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
  }
  const perf = performance as PerfWithMemory
  if (perf.memory) {
    let lastReport = 0
    const mb = (n: number) => `${Math.round(n / 1024 / 1024)}MB`
    window.setInterval(() => {
      const m = perf.memory
      if (!m) return
      const pct = m.usedJSHeapSize / m.jsHeapSizeLimit
      const now = Date.now()
      const interval = pct > 0.7 ? 10_000 : 60_000
      if (now - lastReport < interval) return
      lastReport = now
      const level: LogLevel = pct > 0.85 ? 'error' : pct > 0.7 ? 'warn' : 'info'
      logCrash(
        level,
        'memory',
        `${mb(m.usedJSHeapSize)} / ${mb(m.jsHeapSizeLimit)} (${Math.round(pct * 100)}%)`,
      )
    }, 10_000)
  }
}
