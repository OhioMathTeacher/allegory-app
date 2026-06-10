/**
 * The "which island am I controlling?" store.
 *
 * A *target* is the origin (e.g. `http://192.168.1.50:5173`) of another
 * Allegory instance this device drives as a remote control. `null` means
 * local playback — this device is its own player.
 *
 * One chosen target sets BOTH channels (design doc §3): the `/remote`
 * WebSocket (control) and the `/api` base (browse/art/stream), so you browse
 * and command the same island. Persisted in localStorage, per device.
 */

export interface RememberedServer {
  /** Normalized origin, e.g. `http://192.168.1.50:5173`. No trailing slash. */
  url: string
  /** Optional friendly label; falls back to the host in the UI. */
  label?: string
}

const KEYS = {
  target: 'allegory.remote.target',
  servers: 'allegory.remote.servers',
}

/**
 * Coerce loose user input into a clean origin:
 *   `192.168.1.5`            → `http://192.168.1.5:<page-port>`
 *   `192.168.1.5:5173`       → `http://192.168.1.5:5173`
 *   `http://host:5173/foo/`  → `http://host:5173`
 * Missing scheme defaults to http (Allegory is served over plain http on a
 * LAN); a missing port inherits the port this page is served on, since the
 * same app on another machine almost always uses the same port. Returns null
 * if it can't be parsed into a host.
 */
export function normalizeOrigin(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (!u.hostname) return null
  // Inherit the current page's port when the user didn't type one.
  if (!u.port && window.location.port) u.port = window.location.port
  return `${u.protocol}//${u.host}`
}

/** The origin of whoever served this page — the zero-config "this computer". */
export function selfOrigin(): string {
  return window.location.origin
}

export function getTarget(): string | null {
  try {
    return localStorage.getItem(KEYS.target) || null
  } catch {
    return null
  }
}

export function setTarget(origin: string | null): void {
  try {
    if (origin) localStorage.setItem(KEYS.target, origin)
    else localStorage.removeItem(KEYS.target)
  } catch {
    // ignore quota / privacy-mode failures
  }
}

export function getServers(): RememberedServer[] {
  try {
    const raw = localStorage.getItem(KEYS.servers)
    const arr = raw ? (JSON.parse(raw) as RememberedServer[]) : []
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s.url === 'string') : []
  } catch {
    return []
  }
}

export function setServers(servers: RememberedServer[]): void {
  try {
    localStorage.setItem(KEYS.servers, JSON.stringify(servers))
  } catch {
    // ignore
  }
}

/** Probe an island's `/api/status` to light its reachability dot. */
export async function probeServer(origin: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/** A short host label for a row, e.g. `192.168.1.50:5173`. */
export function hostLabel(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
