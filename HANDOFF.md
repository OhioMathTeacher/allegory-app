# Allegory — Handoff: next four features

This picks up where the JSM→Allegory conversion left off (commit `c9b072b`).
Nine features are shipped; this document specs the **next four**.

---

## Ground rules (read first)

- **npm is frozen.** Do **not** run `npm install`. Every feature below is
  built with browser Web APIs, Node built-ins, the system `ffmpeg` CLI
  (`/usr/bin/ffmpeg`), and Ollama over plain HTTP. If you think you need a
  package — you don't; find the no-dependency path. Reinstall with `npm ci`,
  never `npm update`.
- **Local only.** No network exposure, no open ports, no Tailscale. Allegory runs
  on the machine with the music and speakers, reachable at `localhost:5173`.
- Run it: `npm run dev`. Typecheck: `npx tsc -b`. There is no automated UI
  test harness — verify backends with `curl`, and look at the screen.

## Architecture refresher

Allegory is a Vite + React app with a small backend built **as a Vite plugin** —
no separate server process.

| Path | What it is |
|---|---|
| `server/scanner.ts` | Scans the music dir; the library index; tag reading; search; artist art; album merge |
| `server/playlists.ts` | `.m3u` playlists in `<musicDir>/Playlists` |
| `server/router.ts` | The `/api` HTTP routes (browsing, streaming, art, uploads) |
| `server/plugin.ts` | Glues the above into Vite's dev + preview servers |
| `src/lib/api.ts` | Client-side `/api` calls — one function per endpoint |
| `src/lib/player.tsx` | Playback + the Web Audio graph (`getAnalyser()`) |
| `src/components/` | Every screen (AppShell, Library, AlbumView, …) |

Music lives at `/data/music` (`ALLEGORY_MUSIC_DIR` in `.env`), laid out
`Artist/Album/NN Title.ext`.

## Shipped so far (don't redo)

Search · persisted volume · working play buttons · repeat + queue panel ·
`._` junk-file fix · playlist editing · artist images · liquid-light
visualizer · combine duplicate albums.

---

## 1. Audio processing — EQ, reverb, playback speed

**Goal:** a graphic EQ, a reverb, and a variable playback-speed control.

**Approach** — all Web Audio API, zero dependencies:

- **Playback speed** is independent and easy: set `audio.playbackRate` on the
  element in `player.tsx` (add `playbackRate` state + setter). Keep
  `audio.preservesPitch = true` so it doesn't chipmunk; optionally expose a
  toggle. UI: a 0.5×–2× control.
- **EQ + reverb** extend the existing Web Audio graph. Today `getAnalyser()`
  builds `source → analyser → destination`. Rebuild it as:
  `source → preamp(GainNode) → [EQ: BiquadFilterNode chain] → [reverb: dry
  GainNode + ConvolverNode→wet GainNode] → analyser → destination`.
- **EQ bands:** ~7 `BiquadFilterNode`s, type `peaking` (use `lowshelf` /
  `highshelf` for the ends), at e.g. 60 / 150 / 400 / 1k / 2.4k / 6k / 12k Hz,
  each with a −12…+12 dB gain slider.
- **Reverb:** a `ConvolverNode`. Generate the impulse response in JS — a
  stereo noise buffer with an exponential decay envelope (~10 lines, no IR
  file needed). Mix wet/dry with two `GainNode`s.
- Persist the settings to `localStorage` (same pattern as `allegory.volume`).

**Key files:** `src/lib/player.tsx` (the graph), a new
`src/lib/audio-fx.ts` (graph construction), a new `src/components/Effects.tsx`
(the slider panel), a button to open it (PlayerBar or NowPlaying).

**Watch out for:** `createMediaElementSource` is one-shot and permanent —
build the graph once. Routing through an `AudioContext` can affect the
output-device picker (`setSinkId`) — see the existing comment in
`player.tsx`. The user listens via the system default sink, so this is
low-risk, but test it.

## 2. AI features — local Ollama

**Goal:** natural-language playlists, an AI DJ, semantic search, and a
library-cleanup assistant. **All local, via Ollama** (`localhost:11434`).

**Model choice — important.** `gemma3:27b` (used while building Allegory) is
~17 GB — too large for a modest home machine. These tasks don't *need* a big
model: the catalog is supplied in-context, so the model only has to follow
instructions and emit reliable JSON. A small instruct model handles that.

- **Start with a stock small model** — `gemma3:4b` (~3 GB, same family) or
  `qwen2.5:7b` (~5 GB, very strong at structured output). Pick what fits.
- **Make the model configurable** — read `ALLEGORY_OLLAMA_MODEL` from `.env`,
  default to a small model. Never hardcode it; it must be swappable.
- **Use Ollama's structured-output mode** — pass a JSON schema in the
  `format` parameter. This is what makes a *small* model reliable here; do
  not trust freeform text.
- **Semantic search** uses `nomic-embed-text` (~0.3 GB) — runs anywhere,
  no change needed.
- **Fine-tuning is Plan B, not Plan A.** A small model fine-tuned on Todd's
  own playlists/listening would curate more to taste — worthwhile *later*,
  once the stock model is in use and there's real usage data to train on.
  Don't fine-tune before trying stock + JSON mode; it's very likely enough.

**Approach** — `fetch` to Ollama from the Allegory server; no SDK:

- New `server/ai.ts`: a tiny Ollama client (`POST /api/chat`,
  `/api/embeddings`). New routes in `server/router.ts` under `/api/ai/*`.
- **NL playlist builder:** build a compact catalog string (the ~1,574 album
  `"Name — Artist"` lines fit comfortably in gemma3:27b's context). Prompt:
  "from this library, choose albums/tracks for: «vibe»; reply as JSON."
  Parse the reply, resolve to tracks, create a `.m3u` via `playlists.ts`.
- **AI DJ:** send a track list, ask for an ordering with an energy/mood arc,
  apply it to the queue.
- **Semantic search / "more like this":** embed each album's metadata with
  `nomic-embed-text` (1,574 albums — do album-level, not 17k tracks). Cache
  the vectors in `.allegory-cache/embeddings.json`. Query = embed the text,
  cosine-similarity against the cache.
- **Library cleanup:** feed the LLM metadata, have it flag inconsistent
  artist names, stray "feat." tags, likely duplicate albums → suggestions
  that feed features 4 and the album-merge tool.

**Key files:** `server/ai.ts` (new), `server/router.ts`, `src/lib/api.ts`,
new UI components.

**Watch out for:** confirm the catalog prompt fits the model's context — if
not, send artists only or chunk. Embedding is a batch job; run it once and
cache, with a visible "building index…" state.

## 3. More browsing — Recently Added, Favorites, Genres, year-sorted

**Goal:** more ways into the library than the A–Z album grid.

**Approach:**

- **Recently Added:** capture each album folder's mtime during the scan
  (`stat` the dir in `server/scanner.ts`, store on `ScannedAlbum`). New
  endpoint `/api/albums/recent` sorted newest-first. A section or view.
- **Favorites:** a heart toggle on tracks. Simplest store — a dedicated
  `Favorites.m3u` (reuses `playlists.ts`), or a `favorites.json` in
  `.allegory-cache`. A "Favorites" view.
- **Genres & year-sorted discographies** both need album-level tag data
  (genre, year) that the scanner currently reads only lazily per-album.
  **Recommendation:** add one background **tag-enrichment pass** after the
  structural scan — read tags for ~one track per album, cache `year` and
  `genre` to `.allegory-cache/albums-meta.json`. Then: a Genres view, and
  `ArtistView` sorts albums by year instead of name.

**Key files:** `server/scanner.ts` (mtime + the enrichment pass),
`server/router.ts` (new endpoints), new browse views in `src/components/`,
`src/components/ArtistView.tsx` (year sort).

**Watch out for:** do the enrichment pass once and cache it — don't re-read
17k files on every start. Invalidate the cache on rescan.

## 4. Metadata editing — fix bad tags

**Goal:** fix the bad metadata in the library. Interaction (the user's
idea): **long-press** the text under an album card to edit it; a normal
**click still navigates** to the album.

**Approach:**

- **Long-press:** in `Library.tsx`'s `AlbumCard`, on the text `<button>`,
  use pointer events — `onPointerDown` starts a ~500 ms timer; if it fires,
  open the editor; if `pointerup`/`pointermove` happens first, it was a
  click → navigate. (Keep the normal click path intact.)
- **Writing tags:** `music-metadata` is read-only — use the **`ffmpeg` CLI**
  via `child_process.spawn`. New `server/metadata.ts`. To set tags losslessly:
  `ffmpeg -i in.ext -map 0 -c copy -metadata album="…" -metadata artist="…"
  out.ext`, then replace the original. `-map 0` is essential — it keeps the
  embedded cover art. Do it per file across the album.
- New route `POST /api/albums/:id/metadata { name?, artist?, year? }`,
  then rescan.

**Watch out for — a real design decision:** Allegory derives the album/artist
*shown in the grid* from the **folder names**, not the tags (tags only
refine on album open). So "edit album name" should probably **both** write
the tags **and rename the folder** so the two agree — otherwise the grid
won't reflect the edit. Decide this up front. Folder renaming can follow the
pattern in `playlists.ts`'s `rename()`.

---

## Later (not in this batch)

- **Phone as a remote control** — Server-Sent Events + HTTP POST (plain Node
  `http`, no `ws` package). The computer stays the player; the phone drives
  it. Deprioritized — occasional use.
- **Stems** — vocal/instrument isolation. That's Demucs (Python) — separate
  from Allegory and from npm entirely.

## Suggested order

1 (audio processing) and 3 (more browsing) are self-contained and low-risk —
good warm-ups. 4 (metadata editing) needs the folder-vs-tags decision made
first. 2 (AI) is the biggest; the embedding cache is the long pole.
