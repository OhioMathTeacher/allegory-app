# Allegory 2.0 — Vision: a self-contained desktop app (Electron)

_Status: idea / not started. Captured 2026-06-02._

## The one-line vision

Ship Allegory as a **double-click desktop app** that bundles its own browser
(Electron), instead of a web app you run from a terminal and open in whatever
browser the OS happens to have.

## Why — the reasoning that led here

Allegory is fundamentally a **local-files player**: each machine runs its own
copy, points at its own music folder, and plays files straight off that
machine's disk (see [README.md](README.md), `ALLEGORY_MUSIC_DIR`, the in-app
Settings folder picker). That single fact rules out the "host it once and
everyone opens a URL" model, for a hard browser-security reason:

> A web page served from machine A **cannot read the local disk of machine B**
> that's viewing it. In Allegory the part that reads/streams music is the
> **Node backend** ([server/scanner.ts](server/scanner.ts),
> [server/router.ts](server/router.ts)) — not the page. So the backend must run
> on the same machine as the music.

That means each workstation has to run the whole app locally anyway. Given
that, the questions become:

1. How do we make per-machine install **painless** (no `git clone` + `npm
   install` + terminal)?
2. How do we stop being **tied to a particular browser**? (The File System
   Access API route would lock us to Chromium-only browsers; today's launcher
   just opens Firefox/`xdg-open`.)

**Both answers are the same thing: ship our own browser → Electron.** Once we
bundle Chromium + Node:

- Browser lock-in disappears (we *are* the browser).
- We get full local filesystem access for free — no File System Access API,
  **no data-layer rewrite**.
- Install becomes a single download + double-click.
- No tunnel, no hosting, no "server went down," no campus-IT eyebrows. The app
  runs only while it's open.

### Not the Zoom anti-pattern

To be explicit: this is **not** the 2019 Zoom localhost-server fiasco. There is
no hidden daemon, nothing that survives uninstall, nothing that reinstalls
itself. The local HTTP server lives *inside* the Electron process and dies when
you quit the app. It's the VS Code / Slack / Spotify-desktop model, not the
Zoom one.

## Why this is easier than a typical Electron port

The backend is **already decoupled from Vite**. The Vite plugin
([server/plugin.ts](server/plugin.ts)) doesn't contain the logic — it just
*mounts* framework-agnostic modules (`createLibrary`, `createPlaylists`,
`createRouter`, `createSettings`, `attachRemote`) as middleware.
[server/router.ts](server/router.ts) is a plain Node `(req, res)` handler with
nothing Vite-specific in it.

So the port is essentially **writing a second harness**:

- A tiny `http.createServer()` in Electron's **main process** that mounts the
  same `createRouter(...)` + `attachRemote(...)`.
- A `BrowserWindow` pointed at `http://127.0.0.1:PORT`.
- Because the frontend calls `/api` **same-origin**
  ([src/lib/config.ts](src/lib/config.ts): `API_BASE = '/api'`), the entire
  React app needs **zero changes**.

## Scope / effort

| Tier | What you get | Rough effort |
|---|---|---|
| **MVP** | Real double-click app on one OS: boots the existing backend in-process, loads the UI, plays local music | **2–4 focused days** |
| **Polished, 3-platform** | Signed installers for mac/win/linux, icons, native folder picker, CI builds | **+1–2 weeks part-time** |

MVP tasks:

1. Add `electron` + `electron-builder`.
2. `main.js`: lift the wiring out of `plugin.ts` into a plain `http.createServer`;
   open a `BrowserWindow` on the local port.
3. `vite build` → serve `dist/` from that same server.
4. Rebuild **`sharp`** (cover-art native module) for Electron's ABI via
   `@electron/rebuild`. _(the one real gotcha)_
5. Native folder picker → `settings.json` _(optional for MVP — the in-app
   Settings UI already sets the music dir)._

## Multiplatform: one codebase, three installers

- **One codebase** — written once, runs on all three OSes.
- **Separate installers per OS** — unavoidable; each bundles its own
  platform-specific Chromium+Node and uses its own package format:
  - **macOS** → `.dmg` (arm64 vs x64 — universal build or two)
  - **Windows** → `.exe`/NSIS or `.msi`
  - **Linux** → AppImage / `.deb` / `.rpm` / Flatpak
- `electron-builder` generates all of them from **one config**. Catch: build
  each on its own OS (or a **CI matrix** — GitHub Actions has mac/win/linux
  runners), because the native `sharp` module and Mac signing can't be
  cross-built reliably from Linux.

## Gotchas

- **`sharp` native rebuild** is the main technical friction. Escape hatch: swap
  it for a pure-JS thumbnailer and the native-module problem disappears
  (tradeoff: slower cover-art resizing).
- **Code-signing / notarization** is the unpredictable time-sink and the only
  *cost*: Apple Developer ($99/yr) + a Windows cert. **Skippable for
  personal/campus use** — users click through the "unidentified developer"
  warning once.
- **~100–150 MB per installer** (Chromium is in the box). Normal for Electron.

## The one product decision to settle up front

Today the app binds **all interfaces** (`host: true` in
[vite.config.ts](vite.config.ts)) for phone/Tailscale access, and has a
"remote-control another island" feature ([server/remote.ts](server/remote.ts),
[DESIGN-remote-control.md](DESIGN-remote-control.md)). As a desktop app the
natural default is **127.0.0.1 loopback only** — simpler, no self-signed cert,
not exposed to the LAN.

**Decision needed:** keep the remote/Tailscale features in 2.0, or go
pure-local? This is the one place 2.0 changes the *product*, not just the
packaging.

## Electron vs Tauri (why Electron)

Tauri makes much smaller apps (~10 MB) by using the OS's *native* webview — but
that **reintroduces engine variance** (WebKit on macOS/Linux, not Chromium),
which is the exact thing we're trying to escape, and its shell is Rust, so the
Node backend would have to run as a "sidecar" process. For this goal, **Electron
is the truer fit**: one known browser engine everywhere, and the existing Node
backend runs as-is.

## Open questions

- Loopback-only vs keep remote/Tailscale (see above).
- `sharp` rebuild vs pure-JS thumbnailer.
- Auto-update (`electron-updater`) — worth it, or ship manual downloads?
- Code-sign now, or ship unsigned for personal use first?
- Migrate `.allegory-cache/` location to a proper per-OS app-data dir
  (`app.getPath('userData')`).
