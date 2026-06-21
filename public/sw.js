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
// User-downloaded audio + its cover art. Unlike the shell cache these are
// explicit, user-managed downloads (see src/lib/downloads.ts) and survive SW
// version bumps — the activate cleanup below only prunes old shell caches.
const AUDIO_CACHE = 'allegory-audio-v1'
const ART_CACHE = 'allegory-art-v1'

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

  // Downloaded audio: serve cache-first from the user-managed download cache.
  // Only tracks the user explicitly downloaded are ever in here, so anything
  // not downloaded falls through to the network. Range requests (seeking, and
  // iOS's mandatory probe) are answered from the cached body as a synthesised
  // 206 — a cached 200 does NOT auto-satisfy a Range request.
  if (url.pathname.startsWith('/api/stream/')) {
    // Downloads fetch with ?dl=1 — let the browser fetch directly, bypassing
    // the SW. The download manager writes the cache itself, and piping a large
    // download through the SW can hang on iOS.
    if (url.searchParams.has('dl')) return
    event.respondWith(serveAudio(req))
    return
  }

  // Cover art for downloaded items: cache-first so the Downloads view and the
  // player have artwork offline. Populated only by the download manager (not on
  // ordinary online browsing), so this cache stays scoped to downloads.
  if (url.pathname.startsWith('/api/art/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ART_CACHE)
        const hit = await cache.match(req, { ignoreSearch: true })
        if (hit) return hit
        try {
          return await fetch(req)
        } catch {
          return hit || Response.error()
        }
      })(),
    )
    return
  }

  // Everything else (notably the rest of /api): go to the network untouched.
})

/** Serve a /stream/* request from the download cache, answering Range requests. */
async function serveAudio(req) {
  const cache = await caches.open(AUDIO_CACHE)
  // ignoreSearch: the player appends ?can=<caps>, which can differ from when
  // the track was downloaded (and across devices). The id in the path is the key.
  const cached = await cache.match(req, { ignoreSearch: true })
  if (!cached) {
    // Not downloaded — straight to network (don't cache; downloads are explicit).
    // Offline this rejects, and the UI surfaces a "not available offline" state.
    return fetch(req)
  }
  const range = req.headers.get('range')
  return range ? buildRangeResponse(cached, range) : cached
}

/**
 * Hand-build a 206 Partial Content response by slicing the cached full body.
 * The <audio> element (mandatory on iOS) sends `Range:` headers and expects a
 * 206; a cached 200 won't auto-answer one, which is the difference between
 * offline audio that plays/seeks and one that silently fails.
 */
async function buildRangeResponse(cached, rangeHeader) {
  const buf = await cached.arrayBuffer()
  const size = buf.byteLength
  const type = cached.headers.get('Content-Type') || 'audio/mpeg'

  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m) {
    // Unparseable Range — return the full body and let the element cope.
    return new Response(buf, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    })
  }

  let start = m[1] === '' ? NaN : parseInt(m[1], 10)
  let end = m[2] === '' ? NaN : parseInt(m[2], 10)
  if (Number.isNaN(start)) {
    // Suffix range: bytes=-N → the final N bytes.
    const n = Number.isNaN(end) ? 0 : end
    start = Math.max(0, size - n)
    end = size - 1
  } else if (Number.isNaN(end)) {
    end = size - 1
  }
  if (start > end || start >= size) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${size}` },
    })
  }
  end = Math.min(end, size - 1)

  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
    },
  })
}
