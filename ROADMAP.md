# Allegory — Roadmap

The version map. Each release groups features that ship together because
they share plumbing or unlock each other. Per-feature detail lives in
[HANDOFF.md](HANDOFF.md); this doc is the *ordering*.

> **Naming note:** originally **Todd Sound Machine (TSM)**, renamed to
> **Allegory** in v1.4. Internal symbol rename (`ALLEGORY_MUSIC_DIR`,
> `.allegory-cache`, `allegory.*` localStorage keys, `[allegory]` log
> prefixes, `allegory-library` Vite plugin) completed 2026-05-23.

**Ground rules** (also see HANDOFF.md):

- npm is frozen — every feature here is built with browser Web APIs,
  Node built-ins, the system `ffmpeg`, and Ollama/Whisper/etc. over plain
  HTTP. Use `npm ci`, never `npm install` or `npm update`.
- Local-first — runs on your own machine. `npm run dev` uses `--host`, so a
  phone on the same LAN (or over Tailscale) can reach it, and remote-control
  ("Cast") mode lets the phone drive desktop playback. No third-party
  network services or accounts.
- Run with `npm run dev`. Typecheck with `npx tsc -b`. Verify in the
  browser, not just the test suite.

---

## v1.4 — UX polish + AI plumbing *(shipped)*

The cleanup pass: things that needed to exist before any AI work.

- "Play next" and "Add to queue" on the track three-dot menu
- Visualizer button on the PlayerBar (no longer hidden inside Now Playing)
- In-app Settings dialog with first-run wizard — music library location
  is editable from the UI; `.env.local` only seeds the default on first
  boot. Hot-swap library + playlists without restarting Vite.
- Multi-provider AI dispatch (local / free / paid) ported from
  orbit-explorer-classroom. One `askAI(provId, messages, system)` call.
- App renamed visibly to **Allegory** (sidebar wordmark, page title).
  New SVG logo (5-bar EQ silhouette) with hue-breathe animation, Outfit
  Black wordmark font.
- Sidebar reorganised into tabs (**Queue / Files / Post**), Queue first +
  default; Search and Playlists pinned as icons in the sidebar header
  with toggle-to-return behaviour. *(Superseded in v1.6 — the sidebar and
  the hamburger drawer are gone; navigation is the corner-button cycle.)*
- Persistence: queue + cursor, playback rate, Socrates chat history,
  sidebar tab, settings, AI keys/provider — all survive reload via
  localStorage.

## v1.5 — Small wins + retag *(mostly shipped)*

- **Long-press to edit album metadata** *(shipped)* — name / artist / year +
  Cover art tab with drag-or-pick upload. Writes via
  `ffmpeg -map 0 -c copy` (keeps embedded cover art); a name- or
  artist-change also renames the folder so the grid stays in sync.
- **Five album views** *(shipped, then superseded in v1.6)* — Grid, List,
  Wall, Detail, and **Bins** (vinyl-store layout). Replaced by the single
  list-only browse; the view toggles are gone.
- **Plex-style album selection + contextual Combine** *(shipped)* —
  corner-circle selectors on Grid view; "Combine N" in the header. *(The
  Grid view is gone in v1.6; album-combine still works from the album
  editor / cleanup flow.)*
- **Playback speed** *(shipped)* — with magnetic detent at 1.00×,
  visible tick at 1.0, double-click to reset, 0.01 step.
- **Search overhaul** *(shipped)* — separator folding (`ac-dc`, `ac_dc`,
  `ac dc`, `acdc` all match "ACDC"); placeholder-folder hints when an
  empty artist folder matches the query. (Now the primary find mechanism —
  the A–Z alpha index was dropped in v1.6.)
- **CD-wrapper subfolder fix** *(shipped)* — scanner folds `1`, `2`,
  `CD_7243…` etc. back into their parent album. (Largely moot in v1.6:
  artist grouping is folder-top + tag-based, not parent-folder-based.)
- **Drag-and-drop folder upload** *(shipped)* — drop a folder onto the
  library; structure preserved on disk; auto-rescan; collision-safe.
  *(See v1.6 "upload hygiene" — uploads still need a metadata-validation
  pass before ingest.)*
- Still pending: **Recently Added**, **Favorites**, **"Show your work"
  panel** (BPM/key/dynamic-range display).

## v1.6 — One interface + library integrity *(released — `v1.6.0`)*

The pivot: stop maintaining two layouts, and trust the *tags* over the
folder names. Desktop and phone become the **same** interface, so a change
can be tested from either device. **The interface half shipped as the
`v1.6.0` release** — the first build that's genuinely nicer to use than
Apple Music on the phone. The library-cleanup items below are still
pending and carry forward. The next major chapter (**v2**) is Socrates.

- **One interface, everywhere** *(shipped)* — the phone layout renders at
  every width inside a centred max-width column (`--app-max-width`, default
  1440px) with empty margins on a wide screen; every overlay (Queue,
  Socrates, Settings, Visualizer) is bounded to the column. Desktop and
  phone are identical by construction.
- **One player, no song view** *(shipped)* — the redundant full-screen
  "Now Playing" view is gone; the bottom player carries full transport,
  seek, and queue at every width, and the Visualizer lives in the top bar.
- **Polish pass** *(shipped)* — uniform responsive page titles across
  Artists / Recently / Queue / Playlists; Recently's accordion headers are
  full-bar toggles (tap anywhere to show/hide).
- **List-only browse** *(shipped)* — Artists, Playlists, and the artist's
  album list all render as single lists. Supersedes v1.5's five album views
  and the grid-only Combine selection; the view toggles and the A–Z alpha
  index are gone. Search (now in the top bar) is the find mechanism.
- **Corner-button navigation** *(shipped)* — two rotated-logo buttons in the
  bottom corners cycle the four windows (Artists → Recently → Queue →
  Playlists). Replaces the hamburger drawer + v1.4 sidebar tabs. Settings
  moved into the top bar; the **volume slider is gone everywhere** (use OS /
  output routing).
- **Tag-trust scanner** *(shipped)* — artists are grouped by the cleaned
  **top-level folder** and albums named by **ID3 tag**, so cryptic or
  extra-nested folders ("1992DC", "BS70DLX") and garbage per-track artist
  tags ("$peedranch", "21bigplayer") no longer become phantom artists.
  Private-Use-Area / control characters are stripped from displayed names
  ("Melvins" with a smuggled U+F028 → "Melvins"). Header tags are read once
  per scan and cached to `.allegory-cache/tags-cache.json`; duration stays
  lazy. Net: ~513 noisy artists → 488 clean ones.
- **In-app cleanup engine** *(shipped, backend)* — `server/cleanup.ts` +
  `GET /api/cleanup`: duplicate/variant artist detection (normalize + fuzzy,
  ported from the `jellyfin-music-cleanup` routines) and junk-artist
  flagging. Merges reuse the existing `renameArtist` (rewrites artist /
  album_artist tags on every track and folds the source folder into the
  target).
- **Still pending:**
  - **Cleanup UI** — review/merge duplicate groups and flag/rename junk
    artists on top of `/api/cleanup`. Note: the multi-artist "Live Albums"
    catch-all needs *re-foldering by tag*, not a merge.
  - **Last-name sort** — normalise "First Last" people to sort by surname
    like the curated "Last, First" folders. Needs a human in the loop — a
    computer can't tell "Arcade Fire" the band from "Arthur Lee" the person.
  - **Middle-window content** — *resolved (2026-05-31):* the standalone Queue
    page was removed entirely (the queue is just an ephemeral playlist), so the
    nav is now **three** windows. A "recently played" history may return as a
    *special playlist* instead (see the post-v1.6 section below).
  - **Both connection scenarios** — *real remote control shipped
    (2026-05-31):* the phone now **picks songs and the desktop plays them**,
    not just transport mirroring. A configurable server target ("which
    computer?") is the remaining piece — see below and
    [DESIGN-remote-control.md](DESIGN-remote-control.md).
  - **Debugging tools on both** — port the crash-log + DiagnosticsPanel so
    the (currently buggy) phone build can be diagnosed in-app.
  - **Upload hygiene** — when the upload path is revisited, validate/clean
    metadata first (prefer tags, strip PUA/control chars, skip macOS
    sidecar files) so the library can't re-pollute.

## Post-v1.6 — Remote control + playlist polish *(in progress)*

The pivot after the interface unification: make the phone genuinely **drive**
the desktop, and treat the **track-list** as Allegory's core object. Two
principles run through it — *playback is shared truth (syncs both ways via the
`/remote` socket); navigation/views stay local per-device* — and *the queue,
favorites, and recently-played are all just track-lists with different
lifecycles.* Full design in
[DESIGN-remote-control.md](DESIGN-remote-control.md).

- **Real remote control** *(shipped 2026-05-31)* — tapping a song / album /
  playlist on the phone **plays it on the desktop host**, not just play / pause
  / skip. The phone forwards the resolved tracks; the host plays them.
- **Queue removed** *(shipped 2026-05-31)* — it was an ephemeral playlist;
  album/playlist playback implies "what's next." The page, its nav window, and
  Play-next / Add-to-queue are gone; the internal play-through queue remains.
- **Visualizer removed** *(shipped 2026-05-31)* — never worked in remote mode;
  its top-bar slot became a direct **Playlists** button. Also clears the Web
  Audio `crossOrigin` concern for the server-picker.
- **Playlist management** *(shipped 2026-05-31)* — a vertical **⋮** menu on
  every playlist row (rename / combine / delete) and a smart "add to playlist"
  menu (5 most-recent + searchable More).
- **Special playlists** *(next)* — **Favorites** and **Recently-Played (20)**
  as auto-managed *virtual* playlists, pinned **below** the curated ones. One
  scaffold (local Track-snapshot stores + a virtual playlist view) yields both;
  requires favorites to store full Track snapshots, not just ids. (Supersedes
  v1.5's standalone "Favorites" / "Recently Added" pending items.)
- **Favorite-heart sync in remote mode** *(next)* — make the heart shared
  truth: host publishes favorite state, phone sends a `toggleFavorite` command.
- **M3U playlist export** *(next)* — export with absolute stream URLs so other
  apps / other islands can play it (lighter cousin of v1.11's HTML export).
- **Server-picker** *(next)* — configurable controller target via a "which
  computer?" sheet (Tailscale ∪ remembered ∪ manual; **names, not IPs**).
- **PlaylistView compaction + 2×2 montage cover** *(pending from the morning)*.

## v1.7 — Audio FX + tag enrichment

Two themes that share the "one background pass" mechanic.

- **EQ + reverb** — HANDOFF #1. ~7-band BiquadFilterNode chain + a
  ConvolverNode with a JS-generated impulse response. Build the Web
  Audio graph once. Persist settings to `localStorage`.
- **Tag-enrichment pass** — read genre per album once, cache to
  `.allegory-cache/albums-meta.json`. (Year already lands at scan time as
  of v1.6.) Foundation for the two below.
- **Genres view** — browse by genre, once the enrichment cache exists.
- **Genre tabs in browse** — "Camelot Music 1983" mode: a horizontal tab
  strip (All / Rock / Jazz / Country / Classical / …) derived from the
  enriched tags. Filter to a single genre with one click.
- **Year-sorted discographies** — `ArtistView` orders albums by year.

## v1.8 — Foundation: history + notes

Quiet release that unlocks everything in v1.10.

- **Local SQLite scrobble** — every play logged with a timestamp.
  `.allegory-cache/scrobbles.sqlite`, single-file, append-only. Export to
  Last.fm-compatible CSV later if you want.
- **Per-track / per-album notes** — searchable, exportable, lives in
  `.allegory-cache/notes.json` keyed by track-id and album-id. The
  "soul of Allegory" feature; everything else is replaceable, this isn't.
- **On this day** — cards on the home screen showing what you played
  1, 5, 10 years ago. Sits on top of scrobble history; trivial once it
  exists.
- **Time-of-day biasing** — small "after 11pm, lean darker/slower"
  shuffle bias. Cheap if scrobble + genre tagging are in place.

## v1.9 — Import + per-track edits

- **Per-track metadata edits** — track-title and track-number edits on
  the track row's three-dot menu. The album-level editor shipped in
  v1.5, but per-track is its own UI.
- **iTunes XML import** — playlists + ratings from an iTunes Library
  export. Cleanest migration story for older Mac users.

## v1.10 — Socrates upgrades + deeper cleanup

Socrates the record-shop philosopher shipped in v1.4 (chat panel) and
v1.5 (playlist action protocol — fenced JSON blocks become inline
playlist cards with Play/Save buttons). What he still doesn't have:

- **Grounded recall** — currently only knows the artist + album list +
  currently playing. With v1.8's scrobble history and notes in place,
  he can answer "what was I playing this week" and "what did I think
  of this?" reliably.
- **Semantic search / "more like this"** — embed each album's metadata
  with `nomic-embed-text`. Cache in `.allegory-cache/embeddings.json`.
  Album-level only (1,500 vectors, not 17,000). Lets Socrates resolve
  "albums that feel like X" without naming X explicitly.
- **MusicBrainz tag enrichment** — the next layer on v1.6's cleanup
  engine: MusicBrainz album lookup, an audit list of albums with
  sparse/missing tags, and batch cover-art import via the Cover Art
  Archive. (The duplicate/variant + junk-artist detection already landed
  in v1.6's cleanup engine.)

## v1.11 — Share + liner notes

Two features that share fetch/cache plumbing.

- **Self-contained HTML playlist export** — export a playlist as one
  static page that streams from your Tailscale-exposed library or
  from public URLs you supply. No account, no Spotify embed.
  v1.8's notes make the exported page meaningfully richer.
- **Liner-notes archive** — start with Bandcamp blurbs only (cleanest
  source legally). Cache locally so playback is offline-friendly.
  Reviews/interviews are tempting but a scraping-maintenance liability —
  add only if a stable source exists.
- **"Saw them live" tag** — falls out of this work essentially free.

## v2.0 — Wildcards

High-magic, brittle if rushed. Don't ship until the boring stuff is solid.

- **Voice control via local Whisper** — `whisper.cpp` (CPU is fine for
  a 1-second utterance). Push-to-talk hotkey. Intent parser routes
  "play …" / "queue …" / "next" / "louder" through Allegory's existing
  player actions. **No always-on listening.**
- **Jen mode** — start with a manual toggle in the UI (small change,
  big payoff). LAN-detect (mDNS/ARP) comes as a v2.x add-on once the
  bias logic itself is proven; auto-detect is opt-in.
- **Concert radar** — Bandsintown-backed lookup of tour dates for
  most-played artists, filtered to driving range. Isolate hard so a
  dead third-party API doesn't break Allegory.

---

## v2.1 — Cast to TV (parked — pending upstream)

The dream is real (Allegory audio → Roku in the living room) but doesn't
land on current Ubuntu. Status:

- All 3 of Todd's Rokus advertise **AirPlay 2** (`_airplay._tcp`) and
  the receiver is enabled — confirmed via mDNS + `curl /info`.
- Ubuntu 24.04 ships **PipeWire 1.0.5**; its `raop-discover` module
  looks for `_raop._tcp` (AirPlay 1 audio only). Roku doesn't speak
  AirPlay 1.
- The PipeWire config snippet (`~/.config/pipewire/pipewire.conf.d/raop.conf`)
  is in place and harmless; activates automatically when either an
  AirPlay 1 receiver appears OR Ubuntu ships PipeWire 1.2+ (which has
  AirPlay 2 sender support).
- **Workarounds today**: `owntone` (separate AirPlay 2 daemon, gives
  up Allegory as the player), Plex on Roku (gives up Allegory), or HDMI cable.
- **Action when triggered**: revisit when upgrading Ubuntu / when
  PipeWire 1.2+ lands in repos — Allegory's output routing should
  Just Work once Rokus appear as system audio sinks.

---

## From the road

Raw feedback captured while actually using Allegory on the phone (in
the car, away from the desk). It groups into three themes — an
enhanced UI, more robust playback + observability, and stronger
playlist / favorite features. Unprioritised within each theme; to be
triaged into the version list above.

> *Captured against the pre-v1.6 build, so a few references are now
> stale — `CarModeProvider`, the `Library` grid views, and the
> full-screen Now Playing view were removed in the v1.6 unification.
> The ideas still stand; only the implementation notes need re-pointing
> at the current single-interface shell.*

### Theme 1 — Friendlier-by-default UI

**Largely shipped 2026-05-31** (see HANDOFF-2026-05-31.md). The default UI is
now sized for limited vision / imperfect aim — no separate "car mode" needed.

- [~] **Retire car mode in favor of universal accessibility.** Make the
  default UI usable for anyone with limited vision or imperfect aim — same
  wins on an iPad across the room, a phone in a car cradle, or greasy
  kitchen hands.
  - [x] **Larger, bolder type everywhere** — page titles 30px, now-playing
    24px, list items ~20px (130%), Recently accordion headers 20px + 24px
    glyphs/chevrons, Socrates chat 18px. One consistent scale.
  - [x] **Larger tap targets** — top-bar chips 36→52px; the sub-44px chrome
    buttons bumped. (Remaining: a few in-row controls like the hover play
    button are still small — audit per row component if desired.)
  - [x] **Higher contrast** — secondary `text-white/X` opacities brightened
    off the too-dim /30–/45 range across lists, bars, play bar, Socrates.
    *(Optional light theme: still not done.)*
  - [~] **Taller rows** — rows grew taller from the bigger type; no extra
    per-row padding was added (user was happy without it).
  - Car mode never shipped to the unified v1.6 shell, so nothing to remove —
    the idea stays retired and its wins are now the defaults.

### Theme 2 — Robust playback + observability

The player is unreliable on iOS and we don't have enough signal to
know why. These two items are paired: better instrumentation tells us
what's actually killing playback, and that knowledge unblocks the
fixes.

- [ ] **Survive a mic interruption.** When the microphone activates
  (Siri, voice-to-text, dictation), Allegory's audio stops completely
  and the system audio session hands off to whatever the iPhone treats
  as the default music app — usually Plex. Allegory should keep the
  audio session, and when the interruption ends it should resume the
  exact track at the exact position it was at, not restart from the
  beginning and not surrender to another app.
  - *Agreed (2026-05-31) this is the real fix for the "dictation stops the
    music" problem — especially acute on the **Socrates page**, where the
    point is discussing the song that's playing. A web app cannot disable the
    system keyboard's dictation key (no web API), so a UI nudge ("type rather
    than dictate — the mic pauses playback") shipped as a stopgap; this
    resume-after-interruption work is the actual cure and benefits the whole
    app. Note: any mic use stops playback, so the planned v2.0 push-to-talk
    (Whisper) hits the same wall until this lands.*

- [~] **Catch the silent stops, not just the crashes.** The symptom
  we're seeing is the player just *stopping* mid-track with no error
  and no visible crash — audio goes quiet, the UI stays alive. The
  diagnostic ring-buffer logger (`crash-log` + Diagnostics panel) has
  been **re-ported into the unified shell** — Settings → Diagnostics,
  with Copy / Download. The player now logs:
  - [x] track changes, media `error` (with code/message), `stalled`,
    `waiting`, `abort`, and `play()` rejections.
  - [x] every `pause` with the inferred cause (user vs. unexpected) and
    the `currentTime` at the moment — an unexpected mid-track pause is
    flagged `warn`.
  - [x] a 2s heartbeat that flags a silent stop when `currentTime`
    stops advancing (or the element is paused) while we think we're
    playing — captures `readyState`/`networkState`/`online`.
  - **Next:** replay the issue in the car, open Diagnostics, and read
    what fired at the stop. If the cause is ambiguous, add a network
    probe (HEAD on the stream URL) to tell "server went away" from
    "browser suspended audio."

### Theme 3 — Stronger playlist + favorite features

- [ ] **One-tap actions on the currently playing song.** Right now the
  player bar shows you what's playing but gives you nothing to *do*
  with it. From whatever's currently playing, the user wants:
  - **Favorite** — a single tap on a heart-style icon to mark this
    track as a favorite. The minimum-viable version of this note.
  - **Add to playlist** — a dropdown / sheet listing every existing
    playlist so the current track can be appended with one extra tap.

---

## Parked / not on the immediate plan

Good ideas, but the cost-benefit isn't yet in their favor.

- **Plexamp backend mode** — turn Allegory into a UI shell in front of
  `/data/music`. Big scope expansion; postpone unless Allegory-as-player
  stops being enough.
- **Listening session context** (mood/weather/who's around) — privacy
  story is great, but only worth it if inference is automatic (time,
  weather API, devices on LAN). Manual logging = nobody logs.
- **BPM/key/dynamic-range analysis pass** — Essentia or aubio batch
  job. CPU-heavy one-time cost. Worth it only if the "show your work"
  panel makes you want the numbers.
- **iPod legacy import** — niche; revisit if asked.

---

## How to read this

Each version's *theme* is the constraint: features in v1.7 ship together
because they share the "one background pass" mechanic; v1.11 features
ship together because they share fetch/cache plumbing. **Cross-version
borrowing is a smell** — if v1.6 wants something from v1.8, either v1.8
moves earlier or v1.6 finds a workaround.

When a feature gets dropped or moved, edit this doc in the same commit.
Don't let it drift.
