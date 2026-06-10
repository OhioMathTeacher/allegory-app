# Allegory — Handoff 2026-05-31 (afternoon)

An **architecture-led feature run**: the phone went from a view-only "voyeur"
remote to genuinely **driving the desktop**, and the playlist/track UI got a
real management pass. Everything below is committed **and pushed** to
`origin/main`; working tree clean (only the usual untracked `icons/` and
`jellyfin-sound-machine.code-workspace`). The morning's work is in
[HANDOFF-2026-05-31.md](HANDOFF-2026-05-31.md); the remote/island design lives
in [DESIGN-remote-control.md](DESIGN-remote-control.md).

> **Note:** Allegory's repo is now **private** (part of a GitHub-hygiene pass —
> see `../summer-2026/cleanup-tracking.md`, local-only). It'll be republished
> clean + **AGPL-3.0** before the June 9 Cincy AI Week talk.

---

## The organizing idea (read this first)

Two principles emerged and drove every decision:

1. **Playback is shared truth; navigation is local.** The play bar
   (now-playing, transport, position) flows through the `/remote` WebSocket
   both ways, so it syncs across devices. Pages/views are each device's own
   lens, so they don't. Every "should this sync?" question resolves against
   this line.
2. **Allegory's core object is the *track-list*.** Playlists are its canonical,
   persistent form; the **queue** is an ephemeral track-list with a cursor;
   **favorites** / **recently-played** are *auto-managed* track-lists. Seeing
   this collapsed several features into one mental model ("special playlists").

---

## What shipped this session (commits `15c41c5` → `c260323`)

1. **Real remote control** (`15c41c5`). Un-stubbed `playQueue` / `playNext` /
   `addToQueue` / `playTrackAt` in `RemotePlayerProvider` so they forward the
   resolved `Track[]` to the host; extended `CmdMsg` with `tracks`/`index`
   (`remote-protocol.ts` + `server/remote.ts` mirror); `HostBridge`
   (`player.tsx`) applies them. **Tap a song on the phone → it plays on the
   desktop.** No round-trip: the phone already has the tracks from browsing.
   *Verified on the real phone↔desktop pair — snappy.*
2. **Killed the Queue** (`1e7a4f7`). The queue *is* a playlist minus
   persistence, and album/playlist playback implies "what's next." Removed the
   Queue page, its corner-nav window (cycle is now **3**: Artists → Recently →
   Playlists), and **Play next / Add to queue** from the track ⋯ menu (now
   pure playlist management). Deleted `Queue.tsx` / `QueueList.tsx` /
   `QueuePanel.tsx`. The internal play-through queue in the player is untouched.
3. **Removed the Visualizer + dead analyser** (`4ba949a`). It never worked in
   remote mode (no local audio element) and the Web Audio analyser was the only
   thing that would've forced a `crossOrigin` headache in the future
   server-picker. Its top-bar slot became a direct **Playlists** button
   (brand · Search · Cast · **Playlists** · Settings · Socrates).
4. **Smart track ⋯ menu** (`0a8e45a`). "Add to playlist" now shows the **5
   most-recently-used** playlists (new `src/lib/playlist-recency.ts`,
   localStorage, bumped on add/create) with a **More…** that reveals a **search
   box** over the full list — scales to a big library without leaving the
   add-this-track flow.
5. **Playlist row ⋮ menu** (`c260323`). Reused `PlaylistEditMenu` on every
   row of the global Playlists list (Rename / Combine / Delete) so management
   no longer requires opening the playlist first. Switched its icon to a
   **vertical ⋮**, made the popover **anchor left or right by position** (so
   it never runs off the right edge on a row), and the row name **truncates**
   while the ⋮ stays put. Same component on the detail page → the two menus
   are **identical by construction**.

---

## Known gaps in remote mode (by design, not bugs)

The phone-as-controller MVP forwards playback only. These are **no-ops on the
phone**, so don't be surprised:

- ❤️ **Favorite heart** — favorites are `localStorage` *per device*, so tapping
  the heart on the phone doesn't fill it on the desktop. (See next-steps — the
  on-pattern fix is small.)
- **Repeat**, **playback speed**, **queue reorder/remove**, **clear up-next**,
  **output device** — all `noop` in `RemotePlayerProvider`.

---

## What comes next (in rough priority)

1. **Favorite-heart sync in remote mode** — the bookend to the favorites idea
   we opened the day with. Same pattern as the command channel: host
   **publishes** whether the current track is favorited (in the state
   snapshot), the phone's heart reflects the **host's** state, and tapping it
   sends a **`toggleFavorite`** command. Touches ~5 small spots.
2. **Special-playlist scaffolding** — the big one, and architecturally clean.
   Pinned **virtual playlists** in the Playlists window, **always sorted below
   the user's curated ones** (a subtle "Smart" divider), each opening into the
   normal track-list view fed from a local store. Yields **Favorites** *and*
   **Recently-Played (20)** from one mechanism. Build order:
   1. `recent-plays.ts` — capped-20 **Track snapshots**, hooked into the
      existing play event (`reportPlay`).
   2. **Favorites → Track snapshots** — `toggleFavorite` must store the full
      `Track` (we have it in the PlayerBar), not just the id, so it can render
      as a playlist. *This is the change flagged in hour one.*
   3. Playlists window renders the curated list, then a Smart section below.
   4. A virtual playlist view (PlaylistView variant) fed directly from the
      local store — fully playable.
3. **M3U export** — drop an **Export** option into the playlist ⋮ menu.
   Generate client-side from the playlist's tracks with **absolute** stream
   URLs (`http://<server>/api/stream/<id>`) so other apps / other islands can
   play it. (The lighter cousin of v1.11's "self-contained HTML export.")
4. **PlaylistView compaction + montage cover** — *still pending* from the
   morning's list. Give the detail page the compact AlbumView-style header
   (96px cover + title/meta, actions below) and a Plex-style **2×2 montage**
   of the first 4 distinct album covers (single-cover → icon fallbacks). The
   detail page has the tracks loaded, so the montage is easy there.
5. **Server-picker** (DESIGN-remote-control.md steps 2–4) — make the
   controller's target **configurable** (`connection.ts` → absolute base;
   `remoteUrl()` → chosen host), a "Control which computer?" sheet on engaging
   remote mode, a 3-feeder dropdown (Tailscale ∪ remembered ∪ manual, friendly
   names — Todd hates IPs). Removing the analyser already cleared the
   cross-origin concern here.

**Parked:** swipe-left-to-delete a playlist row — it fights the app-wide
horizontal page-swipe. Resolvable (row claims the gesture; reveal-then-tap
Delete, never delete on bare swipe) but the ⋮ menu already covers it, so it's
nice-to-have polish, not essential.

---

## Working rhythm (keep doing this)

> **one small change → Todd looks on the real device → commit immediately →
> next.** It worked beautifully all session.

- Typecheck after every change: `npx tsc -p tsconfig.app.json --noEmit`.
- Dev server is a **systemd user service**: `systemctl --user restart allegory`
  (serves `:5173`). Reload **both** desktop and phone after a restart.
- Commit messages carry the Claude co-author trailer. Allegory is private, so
  pushing is safe; push when Todd asks.

---

## Key files touched

- `src/lib/remote-protocol.ts`, `src/lib/remote-player.tsx`, `src/lib/player.tsx`,
  `server/remote.ts` — the command channel.
- `src/components/AppShell.tsx` — 3-window nav, Playlists top-bar button,
  visualizer removed.
- `src/components/TrackMenu.tsx` + `src/lib/playlist-recency.ts` — smart
  add-to-playlist menu.
- `src/components/Playlists.tsx`, `src/components/PlaylistEditMenu.tsx` — row ⋮
  menu, vertical icon, position-aware popover.
- `src/lib/player-context.ts` — dropped `getAnalyser` from the interface.
- **Deleted:** `Queue.tsx`, `QueueList.tsx`, `QueuePanel.tsx`, `Visualizer.tsx`.
