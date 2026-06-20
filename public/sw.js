/**
 * Allegory service worker — offline app shell (spike).
 *
 * Goal of this first pass: make the *app itself* load when the server is
 * unreachable. It caches the navigation document and the hashed JS/CSS/font
 * assets, so opening Allegory in the car with the home server down still boots
 * the UI (which can then show downloaded music — a later phase).
 *
 * Strategy:
 *   - navigations  → network-first, fall back to the cached shell (SPA: '/').
 *   - hashed assets → cache-first (they're immutable once built).
 *   - /api + /stream → straight to network for now; offline audio comes next,
 *     as a dedicated cache the user explicitly downloads into.
 *
 * Registered only from production builds over a secure context (see main.tsx),
 * so the Vite dev server + HMR are never intercepted.
 */
const SHELL_CACHE = 'allegory-shell-v1'

self.addEventListener('install', () => {
  // Take over as soon as we're ready; the shell fills in as pages load.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop superseded shell caches on a version bump.
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith('allegory-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

/** Immutable, same-origin app assets worth serving cache-first. */
function isShellAsset(url) {
  if (url.origin !== self.location.origin) return false
  const p = url.pathname
  return (
    p.startsWith('/assets/') ||
    p.startsWith('/fonts/') ||
    p.endsWith('.js') ||
    p.endsWith('.css') ||
    p.endsWith('.woff2') ||
    p.endsWith('.woff') ||
    p === '/manifest.webmanifest' ||
    p === '/favicon.svg'
  )
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // App boot: try the network, but fall back to the cached shell so the app
  // opens with the server down. index.html is the shell for every SPA route.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req)
          const cache = await caches.open(SHELL_CACHE)
          cache.put('/', fresh.clone())
          return fresh
        } catch {
          const cache = await caches.open(SHELL_CACHE)
          return (await cache.match('/')) || Response.error()
        }
      })(),
    )
    return
  }

  // Hashed build assets: cache-first, populating the cache on first online hit.
  if (isShellAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE)
        const hit = await cache.match(req)
        if (hit) return hit
        try {
          const fresh = await fetch(req)
          if (fresh.ok) cache.put(req, fresh.clone())
          return fresh
        } catch {
          return hit || Response.error()
        }
      })(),
    )
    return
  }

  // Everything else (notably /api and /stream): go to the network untouched.
  // Offline audio is the next phase — an explicit, user-managed download cache.
})
