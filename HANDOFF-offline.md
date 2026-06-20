# HANDOFF — Offline downloads & playback (phase 2)

Goal: let the phone **download some music** and **play it when the home server is
unreachable** (driving out of Wi-Fi / server off). Phone-only feature. Written
so a fresh Claude Code session can execute it cold.

---

## TL;DR — where things stand

- ✅ **Phase 1 (done & pushed):** a service worker (`public/sw.js`) caches the
  **app shell** so the UI loads with the server down. Registered from
  `src/main.tsx` (prod builds, secure context only).
- ⬜ **Phase 2 (this doc):** download audio + browse/play it offline.

The SW already exists and is the foundation. Phase 2 mostly adds an **audio
cache + download manager + offline UI** on top of it.

---

## STEP 0 — Prerequisite: a trusted HTTPS origin (do this first, verify it works)

A service worker only registers over a **secure context with a trusted cert**.
The phone currently reaches the dev server at `http://<tailscale-ip>:5173`
(plain HTTP) → **SW will NOT register there.** Fix with Tailscale HTTPS:

```bash
# On the server box (imac-fedora). Serve the BUILT app (stable hashed assets):
cd ~/Repos/allegory-app
npm run build
npm run preview -- --port 4173        # preview runs the API too (configurePreviewServer)

# In another shell: front it with a Tailscale-issued (publicly trusted) cert:
tailscale serve --bg https / http://localhost:4173
```

Then on the phone open: **`https://imac-fedora.tail7162dd.ts.net`**
(MagicDNS name for this tailnet, `tail7162dd.ts.net`).

**Verify before building anything:** phone Chrome/Safari → it loads over https
with no cert warning → DevTools (or desktop at the same URL) → Application →
Service Workers shows **activated**. If the SW won't register, STOP and fix the
cert/origin first — nothing else matters until it does.

> Note: `npm run dev` will NOT activate the SW (registration is gated to
> `import.meta.env.PROD`). Use `build` + `preview` for anything offline.

---

## STEP 1 — SW: audio cache + offline playback (the hard part)

Extend `public/sw.js` with a second cache, e.g. `allegory-audio-v1`, and a
fetch rule for `/stream/...`:

- **Cache-first for `/stream/*`**: if the request is in `allegory-audio-v1`,
  serve it (this is how offline playback works); otherwise go to network and
  **do not** auto-cache (downloads are explicit, see Step 2). Only
  user-downloaded tracks are ever in this cache, so non-downloaded tracks
  naturally fall through to the network.

**Two gotchas that will bite — handle them explicitly:**

1. **Range requests (seeking).** The `<audio>` element sends `Range:` headers;
   iOS *requires* a `206 Partial Content` response. A cached full `200` response
   does **not** auto-satisfy a Range request. The SW must detect a `Range`
   header on a cached audio hit, read the cached body as an ArrayBuffer, slice
   the requested byte range, and return a hand-built `206` with
   `Content-Range`/`Accept-Ranges`/`Content-Length`. This is the #1 thing that
   makes offline audio "work" vs "silently fail to play/seek." Test seeking.

2. **The `?can=` query param.** `audioStreamUrl()` (see `src/lib/api.ts`)
   appends `?can=<caps>` and the server may transcode based on it. The cache key
   the player requests must match what was stored. Safest: match `/stream/`
   responses with **`ignoreSearch: true`**, and when downloading, store under a
   normalized key. Confirm the same track plays from cache on a *different*
   device/session (caps can differ).

---

## STEP 2 — Download manager (client)

New `src/lib/downloads.ts`:

- `downloadTrack(track)`: `fetch(audioStreamUrl(conn, track.id))` **without** a
  Range header (get a full `200`), `cache.put(url, response)` into
  `allegory-audio-v1`; also cache the album-art URL; write a metadata entry to
  IndexedDB (Step 3).
- `downloadAlbum(albumId)` / `downloadPlaylist(id)`: resolve tracks, loop.
- `removeDownload(trackId)`, `isDownloaded(trackId)`, `listDownloads()`.
- `navigator.storage.estimate()` for a storage meter.
- Emit progress (per-track) so the UI can show a spinner/percent.

Decisions to make (ask the user or pick sensible defaults):
- **What's downloadable:** albums + playlists + "all favorites"? (favorites are
  client-side localStorage today — fine for this since downloads are client-side
  too.)
- **Format/size:** the streamed response may already be transcoded AAC for
  risky formats; downloading the streamed bytes is simplest and plays anywhere.
- **Budget/eviction:** show usage; let the user delete. iOS evicts under
  pressure (Android/Pixel is far more generous — user is considering a Pixel 9a).

---

## STEP 3 — IndexedDB index (browse offline)

Store track/album/artist metadata for downloaded items so the Downloads view and
offline browsing work with **no server**. A tiny hand-rolled wrapper or
`idb-keyval` is fine. Keep it minimal: enough to render album/track rows and
build a play queue offline.

---

## STEP 4 — UI

- **Download buttons** on: `AlbumView.tsx`, `TrackList.tsx` (`TrackRow`),
  `PlaylistView.tsx`, maybe `ArtistView.tsx`. Show downloaded/queued/▼ states.
- **A "Downloads" view** (offline library): list downloaded albums/songs from
  IndexedDB, play from the audio cache. Add a nav entry (see the corner buttons
  / `TopButton`s in `AppShell.tsx`).
- **Storage meter + manage/delete.**
- **Offline detection:** when the server health-check fails (or
  `navigator.onLine === false`), route the app to the Downloads view and surface
  an "offline" indicator. The player keeps working because the SW serves cached
  `/stream` audio; just make sure non-essential server calls (`reportPlay`,
  palette extraction, art that isn't cached) **fail gracefully** rather than
  throwing.

---

## Key files / integration points

| Concern | File |
| --- | --- |
| Service worker | `public/sw.js` (extend with audio cache + Range handling) |
| SW registration | `src/main.tsx` (already done; PROD + secure-context gated) |
| Stream URL to cache | `src/lib/api.ts` → `audioStreamUrl()` (note `?can=`) |
| Audio element / player | `src/lib/player.tsx` (should need ~no changes) |
| Download buttons | `AlbumView.tsx`, `TrackList.tsx`, `PlaylistView.tsx`, `ArtistView.tsx` |
| Nav + offline routing | `src/components/AppShell.tsx` |

**Backend:** phase 2 is **client-only** — no server changes expected. (FYI the
server lives in BOTH `allegory-app/server` and `allegory/server`, kept identical;
the app runs `allegory-app/server`. Only relevant if you do touch the server.)

---

## Verification checklist

1. SW registers over the Tailscale HTTPS URL on the phone (Step 0).
2. Download an album → it appears in Downloads with correct metadata.
3. `navigator.storage.estimate()` reflects the size; delete frees it.
4. **Kill the server**, reload the app → UI loads (shell cache) AND a downloaded
   album **plays** AND **seeks** (the Range/206 test). This is the real win.
5. A non-downloaded track shows a clear "not available offline" state, doesn't
   hang.

---

## Platform note

The user may switch to a **Pixel 9a (Android)**. Nothing here is iPhone-specific
— it's a PWA. Android Chrome is actually the *easier* target: first-class
service workers, far more generous storage, no aggressive eviction. The iOS bits
already in the code (mic-interruption resume, safe-area insets, apple meta tags)
are harmless no-ops on Android. The trusted-HTTPS step (Step 0) is the same on
both.
