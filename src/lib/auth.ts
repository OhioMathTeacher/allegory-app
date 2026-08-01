/**
 * Client half of Allegory's shared-password gate (server/auth.ts).
 *
 * Two transports, because one isn't enough:
 *
 *   - **Same origin** (the normal case): the session cookie does everything.
 *     It rides along on `fetch`, and — crucially — on `<audio src>` and
 *     `<img src>`, which can't carry headers at all. Nothing here has to help.
 *
 *   - **Another island** (remote mode with a target, see remote-target.ts):
 *     that's a cross-site request, and a SameSite=Lax cookie is deliberately
 *     not sent on those. So we keep the token the login handed back, in
 *     localStorage under the island's origin, and present it as an
 *     `Authorization` header on fetches and a `?k=` parameter on media URLs
 *     and the WebSocket handshake.
 *
 * A token per origin, not one global token: each island has its own password,
 * so logging into the upstairs machine shouldn't imply anything about the one
 * in the basement.
 */

const PREFIX = 'allegory.auth.token.'

/**
 * The origin a connection points at, or `''` when it's this one.
 *
 * `conn.serverUrl` is either the relative `/api` (same origin) or an absolute
 * `http://host:port/api` (another island) — see connection.ts.
 */
export function originOf(serverUrl: string): string {
  if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) return ''
  try {
    return new URL(serverUrl).origin
  } catch {
    return ''
  }
}

export function isCrossOrigin(serverUrl: string): boolean {
  const origin = originOf(serverUrl)
  return origin !== '' && origin !== window.location.origin
}

export function getToken(origin: string): string | null {
  try {
    return localStorage.getItem(PREFIX + (origin || window.location.origin))
  } catch {
    return null // private mode, or storage disabled
  }
}

export function setToken(origin: string, token: string): void {
  try {
    localStorage.setItem(PREFIX + (origin || window.location.origin), token)
  } catch {
    // Not fatal: same-origin still works off the cookie.
  }
}

export function clearToken(origin: string): void {
  try {
    localStorage.removeItem(PREFIX + (origin || window.location.origin))
  } catch {
    // ignore
  }
}

/**
 * Headers that carry the session when the cookie can't. Empty for same-origin
 * requests, where the cookie is both sufficient and safer than a header the
 * page's own JavaScript can read.
 */
export function authHeaders(serverUrl: string): Record<string, string> {
  if (!isCrossOrigin(serverUrl)) return {}
  const token = getToken(originOf(serverUrl))
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Append the token to a media URL (`<audio>`, `<img>`, download fetches) when
 * it points at another island. Same-origin URLs are returned untouched so the
 * token never lands in this origin's history, logs, or a service-worker cache
 * key.
 */
export function withKey(url: string, serverUrl: string): string {
  if (!isCrossOrigin(serverUrl)) return url
  const token = getToken(originOf(serverUrl))
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(token)}`
}

/** Same idea for the `/remote` WebSocket, which also can't set headers. */
export function withKeyForSocket(wsUrl: string, targetOrigin: string | null): string {
  if (!targetOrigin || targetOrigin === window.location.origin) return wsUrl
  const token = getToken(targetOrigin)
  if (!token) return wsUrl
  return `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}k=${encodeURIComponent(token)}`
}

export interface AuthStatus {
  /** True once a password has been set on that island. */
  enabled: boolean
  /** True if this request was already authorised (session, or loopback). */
  authenticated: boolean
  /** True when the server saw the request as coming from itself. */
  loopback: boolean
  lastChanged: string
}

export async function getAuthStatus(serverUrl: string): Promise<AuthStatus> {
  const res = await fetch(`${serverUrl}/auth/status`, {
    credentials: 'include',
    headers: authHeaders(serverUrl),
  })
  if (!res.ok) throw new Error(`Auth status failed (${res.status})`)
  return (await res.json()) as AuthStatus
}

/** Exchange a password for a session. Stores the token for cross-origin use. */
export async function login(serverUrl: string, password: string): Promise<void> {
  const res = await fetch(`${serverUrl}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `Sign-in failed (${res.status})`)
  if (data.token) setToken(originOf(serverUrl), data.token)
}

export async function logout(serverUrl: string): Promise<void> {
  await fetch(`${serverUrl}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(serverUrl),
  }).catch(() => undefined)
  clearToken(originOf(serverUrl))
}

/**
 * Set, change, or (with an empty `password`) remove the password. `current` is
 * only needed when changing one from a session that isn't already signed in.
 */
export async function setPassword(
  serverUrl: string,
  password: string,
  current?: string,
): Promise<void> {
  const res = await fetch(`${serverUrl}/auth/password`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders(serverUrl) },
    body: JSON.stringify({ password, current }),
  })
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
  if (!res.ok) throw new Error(data.error ?? `Could not save the password (${res.status})`)
  if (data.token) setToken(originOf(serverUrl), data.token)
  else clearToken(originOf(serverUrl))
}
