# Allegory

A fast, focused music player for a **local music library** — the clean,
art-forward UI of Jellyfin Sound Machine, but with no server: it scans a
folder of music files on disk and plays them straight from the drive.

What sets Allegory apart from an ordinary player is the **Socrates sidebar**:
an AI thinking partner that listens along and discusses the meaning of what
you're playing — connecting a song's lyrics to ideas, history, and philosophy.
Bring your own model (a local one, or a cloud provider with your own key).

Allegory is a Vite app with a small built-in backend (a Vite plugin). The plugin
scans the music directory, builds an in-memory index, and serves a local
`/api` for browsing, streaming and playlists. There is no database and no
separate server process — `npm run dev` is the whole app.

> Allegory grew out of [Jellyfin Sound Machine](#relationship-to-jsm). Every
> screen is shared; only the data layer (`src/lib/api.ts`, `src/lib/
> connection.ts`) and the `server/` plugin differ.

## Features

- **Album library** — a fast, art-forward grid
- **Album view** with the full track listing and durations
- **Artists** — browse artists and their discographies
- **Playlists** — browse, create, add and remove tracks; stored as portable
  `.m3u` files
- **Playback** — queue, play/pause, next/previous, seek, shuffle, volume
- **Now Playing** screen with an ambient accent colour pulled from the cover
- **Output-device picker** — send audio to specific speakers / headphones
- **Lock-screen / Control-Center controls** via the Media Session API
- **Rescan** — pick up newly added music without restarting
- Direct file streaming with HTTP Range support, so the browser knows each
  track's length and can seek
- **Socrates sidebar** — an AI thinking partner that discusses the music
  you're playing; pick any model (local or bring-your-own-key) in AI Settings

## Running it

Requirements: **Node.js 20 or newer** (Vite 8 needs it) and a folder of music
on disk. Don't have Node? On Debian/Ubuntu/Mint:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Then clone, enter the folder, install dependencies, and start the dev server:

```bash
git clone https://github.com/OhioMathTeacher/allegory-app.git
cd allegory-app
npm install
npm run dev
```

Open **http://localhost:5173/** in your browser. The first time you load it,
Allegory will tell you no music directory is set — click into **Settings**
and pick the folder that holds your music. That's the whole install.

The other npm scripts (run them one at a time, only when you need them):

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server with hot-reload at http://localhost:5173/ |
| `npm run build` | Type-check and build a production bundle into `dist/` |
| `npm run preview` | Serve the production build locally (also runs the `/api` plugin) |
| `npm run lint` | Run ESLint over the source tree |

### Configuration (optional)

Instead of picking the music folder from the Settings dialog, you can preset
it with an env file. Copy the template and edit the path:

```bash
cp .env.example .env.local
$EDITOR .env.local
```

```ini
# .env.local
ALLEGORY_MUSIC_DIR=/data/music
```

The library is expected to be laid out as `Artist/Album/NN Title.ext`, with
cover art as `folder.jpg` / `cover.jpg` in each album folder. CD1/CD2
sub-folders are folded back into their album. Supported audio: MP3, FLAC,
M4A/AAC, OGG/Opus, WAV.

Browsing data comes from the folder structure (so a scan is a fast directory
walk); per-track tags — real titles, durations, disc numbers — are read the
first time an album or playlist is opened.

### Always-on (optional)

If you'd rather Allegory always be running — so the `localhost:5173` bookmark
just works whenever you open it — install the systemd user service:

```bash
./packaging/install-service.sh
```

It starts on login and restarts itself on crash. See
[`packaging/README.md`](packaging/README.md) for stop/disable commands and the
linger trick that keeps it serving even when you're logged out (useful for
reaching it from your phone over Tailscale).

### Tags

Allegory keeps a **tag tree** — your own hierarchy, not a flat list. File
`Delta blues` under `Blues` under `Roots`, and a filter for Blues finds
everything beneath it. A tag has a kind (genre, mood, era, instrument, context,
other), and a tag cannot be moved inside itself.

The two halves are stored in different places on purpose:

- **The tree** is in `.allegory-cache/tags.json`. It is your construct — "Delta
  blues is a kind of Blues" is true whatever happens to be on the drive.
- **The assignments** are in a `.allegory-tags.json` sidecar inside each album
  folder, keyed by filename, the same way `.allegory-artist.json` works. They
  travel with the music: move an album, rename it, or move the whole drive, and
  the tagging comes too.

They are deliberately *not* keyed on a track id, because a track id is a hash of
the file's path. Renaming one folder would otherwise throw the tagging away
without saying so.

Each assignment records **who said so** — `user`, `file` (a genre frame in the
audio file), `scraped`, or `ai`. An `ai` tag is a *suggestion*: it is invisible
to filtering until you accept it in Settings, and dismissing one is remembered
so it cannot be proposed again.

Genres already written into your files are folded in automatically on startup,
as root-level tags you can then arrange. That pass is idempotent, so it costs
nothing on later boots, and it will not re-add a genre you have dismissed or
reset the parent of one you have since filed somewhere.

Tag a single song from its `⋯` menu, or a whole album from the album's `⋮` menu.
The tree itself is managed in **Settings**.

### Tests

```bash
npm test
```

Node's built-in runner (`node --test`), no test framework and no extra
dependencies — Node runs the TypeScript directly, which is why the server
tsconfig sets `erasableSyntaxOnly`. Tests live beside the code they cover as
`server/*.test.ts`, so `tsc -b` and `eslint` check them too.

A test here is expected to fail for the right reason. The playlist-path tests
resolve each written `.m3u` line the way an outside player does — against the
folder holding the playlist file — and require a real file to be there, because
the bug they cover was one Allegory's own parser read back perfectly.

### Playlists

Playlists are plain `.m3u` files in `<ALLEGORY_MUSIC_DIR>/Playlists`, with paths
written relative to the playlist file itself — a track in `Artist/Album`
appears as `../Artist/Album/01 Track.flac`. That is the rule other players
apply, so the same files are readable by Plex, VLC, **Navidrome** and the
Subsonic clients on top of it (Amperfy and friends), not just by Allegory.
Tracks outside the music directory are written as absolute paths. Every edit
Allegory makes is a line operation on the file.

Playlists written by older versions used paths relative to the music
directory. Those are still read, and the ones Allegory owns are rewritten to
the new form on startup — if that happens you'll see a
`rewrote N playlist(s)` line in the log, and Navidrome needs a rescan to pick
them up. Hand-made `.m3u` files are left alone, since rewriting them would
discard their `#EXTINF` lines.

## Local AI for the Socrates sidebar

Socrates listens along and discusses what you're playing. The recommended
path is a **local model via Ollama** — fully private, no key, no per-token
bill, and exactly in keeping with the rest of Allegory (your music and your
listening stay on your own machine).

### Ollama + qwen2.5:3b (recommended starter)

[Ollama](https://ollama.com/) is a one-binary local LLM runner. Install it,
pull a small model, and Allegory auto-discovers it at `localhost:11434`.

On Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:3b
```

On macOS: download [Ollama.app](https://ollama.com/download) (drag to
Applications), then `ollama pull qwen2.5:3b` in Terminal.

On Windows: download the installer from [ollama.com/download](https://ollama.com/download),
then `ollama pull qwen2.5:3b` in PowerShell.

`qwen2.5:3b` is ~2 GB and runs comfortably on most laptops (including
older machines without a discrete GPU). In Allegory, open **AI Settings**
and pick the local model. That's it — no key, no account.

Got a beefier machine? Try `qwen2.5:7b` (~5 GB, very strong at structured
output) or `gemma3:4b` (~3 GB; same family as the larger Gemma models).
On a workstation with plenty of VRAM, `gemma3:27b` is what was used while
building Allegory.

### Cloud model (alternative)

If you'd rather use a hosted model, pick a cloud provider in **AI Settings**
and paste your own API key. Keys are stored only in your browser and never
written into the source.

## It stays local

Allegory runs on the machine that has the music and the speakers. Nothing is
served over the network and no ports are opened — `npm run dev` (or a
`build` + `preview`) is the whole thing, reachable only at `localhost:5173`
on that machine. Send the audio wherever you like with your OS's normal
output routing, or with the in-app output-device picker.

## Relationship to JSM

Allegory is a fork-in-place of Jellyfin Sound Machine. JSM talks to a Jellyfin
server's API; Allegory replaced that with the local `server/` plugin. The React
components are identical, so UI work done in either can be ported to the
other.

## Roadmap

- [ ] Repeat (repeat-one / repeat-all) and a queue view
- [ ] Playlist editing — reorder, rename, combine playlists, delete
- [ ] Recently Added, Favourites, Search, Genres
- [ ] Year-sorted artist discographies (needs the tag-enrichment pass)
- [ ] PWA: installable, reliable background audio
- [ ] Loudness normalization, sleep timer, gapless playback, lyrics (`.lrc`)
- [ ] In-app metadata / cover-art editing
- [ ] Skip loose, un-organized folders (or treat them separately) so the
      Artists list isn't led by stray recording folders

## Tech stack

React 19 · TypeScript · Vite 8 · Tailwind CSS 4 · TanStack Query · Motion ·
lucide-react · music-metadata · sharp
