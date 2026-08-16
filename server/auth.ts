/**
 * Shared-password authentication for Allegory.
 *
 * Allegory is a household app, not a multi-user service, so there are no
 * accounts — one password gets you in. What this module protects is the whole
 * `/api` surface: browsing, streaming, the folder picker, tag edits and the
 * in-app updater. Before it existed, anything that could reach the port could
 * do all of that.
 *
 * Three deliberate choices, each of which has bitten someone before:
 *
 *   1. **Localhost is exempt — unless a foreign web page is asking.** Requests
 *      from 127.0.0.1 skip the check, so `bin/allegory-launch` and any local
 *      script keep working. Against a shell that concedes nothing: anyone with
 *      a login on the box can read the music files directly, so a password at
 *      the console would be theatre. Against a *browser* it concedes
 *      everything, because a page on any site you visit can fetch localhost
 *      and its requests are indistinguishable by address. So the exemption is
 *      withdrawn whenever the request carries a cross-site `Origin`.
 *
 *   2. **Sessions are stateless.** The cookie carries an HMAC-signed token
 *      rather than an id into a session table, so a server restart doesn't log
 *      the phone out — which matters when the updater restarts the service
 *      under you. Changing the password rotates the signing secret and so
 *      invalidates every outstanding session, which is the behaviour you want.
 *
 *   3. **Three ways to present a token.** The cookie covers same-origin use,
 *      including `<audio src>` and `<img src>` (media elements can't set
 *      headers). Cross-origin — one island driving another, where SameSite
 *      blocks the cookie — the client falls back to an `Authorization` header
 *      for fetches and a `?k=` query parameter for media. All three land here.
 *
 * The password is never stored: only a scrypt hash and its salt, in
 * `.allegory-cache/auth.json`, which is gitignored along with the rest of the
 * cache.
 */
import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import type { IncomingMessage } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

/** Cookie name. Prefixed so it can't collide with anything else on localhost. */
export const COOKIE_NAME = 'allegory_session'

/** How long a session lasts. A year — it's your house, not a bank. */
const SESSION_MAX_AGE_SEC = 365 * 24 * 60 * 60

/** scrypt output length, in bytes. */
const KEY_LEN = 64

interface AuthFile {
  /** Hex salt for the scrypt hash. */
  salt: string
  /** Hex scrypt hash of the password. */
  hash: string
  /** Hex HMAC key that signs session tokens. Rotates when the password does. */
  secret: string
  /** ISO timestamp, for the "password last changed" line in Settings. */
  updatedAt: string
}

/**
 * Failed-attempt throttle. A four-word password is not brute-forceable over a
 * LAN at one guess per second, but an unthrottled endpoint invites someone to
 * try anyway and fill the logs. Backs off per source address, and forgets a
 * client once it succeeds.
 */
const failures = new Map<string, { count: number; last: number }>()
const THROTTLE_AFTER = 5
const THROTTLE_MAX_MS = 5_000

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/**
 * Milliseconds this caller must still wait before another guess is accepted.
 *
 * The wait is measured from the last failure, not from the first: once you've
 * served your few seconds, you get another try. An earlier version of this
 * returned the raw backoff and never consulted `last`, which meant five
 * fat-fingered attempts locked the household out until someone restarted the
 * server — a denial of service against the owner, not the attacker.
 */
function throttleDelay(key: string): number {
  const f = failures.get(key)
  if (!f || f.count < THROTTLE_AFTER) return 0
  const over = f.count - THROTTLE_AFTER + 1
  const required = Math.min(THROTTLE_MAX_MS, over * 500)
  const waited = Date.now() - f.last
  return waited >= required ? 0 : required - waited
}

/**
 * True when the request reached us through a reverse proxy.
 *
 * This is the qualifier the loopback exemption cannot do without. A proxy —
 * `tailscale serve`, nginx, Caddy — connects to the app over localhost, so
 * every request it forwards arrives from 127.0.0.1 no matter which machine
 * it started on. Without this check, publishing the app through such a proxy
 * silently hands the whole library, and every write behind the gate, to
 * anyone who can reach the proxy.
 *
 * Forging these headers can only ever *deny* the exemption and ask for a
 * password, never grant it, so treating their presence as proof of a proxy
 * fails closed.
 */
function isProxied(req: IncomingMessage): boolean {
  const h = req.headers
  return Boolean(h['x-forwarded-for'] || h['forwarded'] || h['x-real-ip'])
}

export function isLoopback(req: IncomingMessage): boolean {
  // A proxied request's socket address describes the proxy, not the caller.
  if (isProxied(req)) return false
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * True when the request is a browser request from *another* site.
 *
 * This exists to qualify the loopback exemption, which is otherwise wider than
 * it looks. A browser running on the server machine is itself a loopback
 * client: JavaScript on any page you happen to visit can `fetch()`
 * `http://127.0.0.1:4173/api/...`, and those requests arrive from 127.0.0.1
 * like any other local process. Left unqualified, the exemption hands a
 * hostile page the whole library — and, since it also skips the gate on
 * writes, the ability to change the password or trigger the updater.
 *
 * The distinction that matters is not *where* the request came from but
 * *who wrote the code that made it*. A shell script has no `Origin` header;
 * the app itself sends one matching the server's own `Host`. A page from
 * somewhere else sends its own, and that is exactly the case to refuse.
 */
export function isForeignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return false // curl, the launcher, any non-browser caller
  const host = req.headers.host
  if (!host) return true
  try {
    // `Origin: null` (sandboxed iframes, some redirects) fails to parse and
    // is treated as foreign, which is the safe reading.
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/** Pull a cookie value out of a request's Cookie header. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

/**
 * Find a token on a request, wherever it was put: the session cookie
 * (same-origin), an `Authorization: Bearer` header (cross-origin fetch), or a
 * `k` query parameter (cross-origin media, which can't set headers).
 */
export function tokenFrom(req: IncomingMessage): string | null {
  const cookie = readCookie(req, COOKIE_NAME)
  if (cookie) return cookie

  const header = req.headers.authorization
  if (header && /^bearer /i.test(header)) return header.slice(7).trim()

  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const k = url.searchParams.get('k')
    if (k) return k
  } catch {
    // unparseable URL — no token
  }
  return null
}

export function createAuth(cacheDir: string) {
  const file = join(cacheDir, 'auth.json')
  let cached: AuthFile | null = null
  let loaded = false

  async function load(): Promise<AuthFile | null> {
    if (loaded) return cached
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<AuthFile>
      cached =
        typeof parsed.salt === 'string' &&
        typeof parsed.hash === 'string' &&
        typeof parsed.secret === 'string'
          ? {
              salt: parsed.salt,
              hash: parsed.hash,
              secret: parsed.secret,
              updatedAt: parsed.updatedAt ?? '',
            }
          : null
    } catch {
      cached = null // no file yet, or unreadable — treat as "no password set"
    }
    loaded = true
    return cached
  }

  /** True once a password has been set. Until then the API is open as before. */
  async function isEnabled(): Promise<boolean> {
    return (await load()) !== null
  }

  async function lastChanged(): Promise<string> {
    return (await load())?.updatedAt ?? ''
  }

  /**
   * Set (or change) the password. Rotating `secret` alongside it is what logs
   * every other device out — the point of changing a password in the first
   * place.
   */
  async function setPassword(password: string): Promise<void> {
    const salt = randomBytes(16)
    const hash = await scrypt(password, salt, KEY_LEN)
    const next: AuthFile = {
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      secret: randomBytes(32).toString('hex'),
      updatedAt: new Date().toISOString(),
    }
    await mkdir(cacheDir, { recursive: true })
    // 0600: the hash is not the password, but there's no reason for anyone
    // else on the machine to read it.
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    cached = next
    loaded = true
  }

  /** Remove the password entirely, reopening the API. Requires the old one. */
  async function clearPassword(): Promise<void> {
    await mkdir(cacheDir, { recursive: true })
    await writeFile(file, JSON.stringify({}, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    cached = null
    loaded = true
  }

  async function verifyPassword(password: string): Promise<boolean> {
    const auth = await load()
    if (!auth) return false
    const salt = Buffer.from(auth.salt, 'hex')
    const expected = Buffer.from(auth.hash, 'hex')
    const actual = await scrypt(password, salt, expected.length)
    // Constant-time: a length mismatch can't happen here (both are KEY_LEN),
    // but guard anyway so timingSafeEqual never throws.
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  }

  /**
   * A session token is `issuedAt.signature`, where the signature covers the
   * issue time under the current secret. No server-side state, so restarts
   * (and the in-app updater) don't sign anyone out.
   */
  async function issueToken(): Promise<string> {
    const auth = await load()
    if (!auth) throw new Error('No password set')
    const issued = Date.now().toString(36)
    const sig = createHmac('sha256', auth.secret).update(issued).digest('hex')
    return `${issued}.${sig}`
  }

  async function checkToken(token: string | null): Promise<boolean> {
    if (!token) return false
    const auth = await load()
    if (!auth) return false
    const dot = token.indexOf('.')
    if (dot <= 0) return false
    const issued = token.slice(0, dot)
    const sig = token.slice(dot + 1)
    const expected = createHmac('sha256', auth.secret).update(issued).digest('hex')
    const a = Buffer.from(sig, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false
    const issuedMs = parseInt(issued, 36)
    if (!Number.isFinite(issuedMs)) return false
    return Date.now() - issuedMs < SESSION_MAX_AGE_SEC * 1000
  }

  /**
   * The gate. True means "let this request through": either no password is
   * set, or it came from localhost, or it carried a valid token.
   */
  async function authorize(req: IncomingMessage): Promise<boolean> {
    if (!(await isEnabled())) return true
    // Loopback is exempt, but only for requests that are genuinely local:
    // not a web page from another site (isForeignOrigin), and not something a
    // reverse proxy forwarded here from the network (isProxied). Both reach us
    // from 127.0.0.1 without being local in any sense that should matter.
    if (isLoopback(req) && !isForeignOrigin(req)) return true
    return checkToken(tokenFrom(req))
  }

  /** Record a bad password guess and report how long this caller must wait. */
  function noteFailure(req: IncomingMessage): void {
    const key = clientKey(req)
    const f = failures.get(key) ?? { count: 0, last: 0 }
    f.count += 1
    f.last = Date.now()
    failures.set(key, f)
  }

  function clearFailures(req: IncomingMessage): void {
    failures.delete(clientKey(req))
  }

  /** How long this caller is currently throttled for, in ms (0 = not). */
  function currentThrottle(req: IncomingMessage): number {
    return throttleDelay(clientKey(req))
  }

  function cookieHeader(token: string): string {
    // No `Secure`: Allegory is normally served over plain HTTP on a LAN, and a
    // Secure cookie would simply never be stored. SameSite=Lax still blocks
    // the cross-site request forgery this is most exposed to.
    return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`
  }

  function clearCookieHeader(): string {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  }

  return {
    isEnabled,
    lastChanged,
    setPassword,
    clearPassword,
    verifyPassword,
    issueToken,
    checkToken,
    authorize,
    noteFailure,
    clearFailures,
    currentThrottle,
    cookieHeader,
    clearCookieHeader,
    file,
  }
}

export type Auth = ReturnType<typeof createAuth>
