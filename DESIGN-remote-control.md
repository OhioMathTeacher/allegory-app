# Allegory — Design Note: Islands, Remote Control & Server Selection

*Captured 2026-05-31, from a design conversation. This is the agreed
direction for turning "voyeur mode" into real remote control, and for
letting a phone choose which computer it drives. Nothing here is built
yet — it's the map. Update this doc in the same commit when the shape
changes.*

---

## 1. The island model (this is a feature, not a bug)

Every running Allegory instance is a fully **independent server-island**:

- It scans its **own local music folder** (`ALLEGORY_MUSIC_DIR`) on its own
  disk. Two islands can hold completely different libraries.
- Its state — favorites, queue, settings — lives in **localStorage, per
  device**. Nothing syncs it between machines.
- It runs its **own `/remote` WebSocket relay** with a single "host" slot
  (`server/remote.ts`). That slot only arbitrates clients of *that one
  server*; it has no idea other islands exist.

**GitHub syncs only the *code*** (`.gitignore` excludes `.env`,
`.allegory-cache`, `node_modules`, `dist`). Pulling does not share music,
favorites, or playback state. So:

> There is **no global "source of truth"** across machines. iMac-Fedora,
> ToddGPT-Fedora, and a conference laptop are three independent islands
> that happen to run the same program.

**Why this is a plus:** if one island goes down, bring up another. The
phone just re-points at a live one. Resilience by replication.

---

## 2. Two roles, one rule

A running instance is in exactly one role at a time:

| Role | Owns a library? | Audio comes out of | Connection target |
|------|-----------------|--------------------|-------------------|
| **Player** | yes | itself | hardwired to **self** (relative `/api`) |
| **Controller** | no | the island it controls | a **chosen** server URL |

- The desktop running its own music is a **Player**. It never needs a
  server picker.
- The phone driving a desktop is a **Controller**. The server picker lives
  **here and only here**.

**The rule that prevents the "chain of pain":**

> Selecting a server means *"become a controller of it."* It **never**
> means *"re-serve that server's library as if it were mine."* No island
> ever delegates its library through another island.

Because no server proxies another's library, there is no recursion — a
desktop "pointing at another server" is just that machine choosing to act
as a controller, which is identical to what the phone does, and perfectly
sane.

This maps onto the existing `local` / `remote` mode toggle
(`src/lib/remote-mode.tsx`). Today "remote" hardcodes the target to
*whoever served the page*. **This feature = make that target configurable.**

---

## 3. The interaction: engaging remote mode picks the server

Tapping the remote icon **is** the act of saying "I want to control a
computer" — so that's the moment to ask *which one*.

- Tapping remote opens a **"Control which computer?"** sheet (instead of an
  instant toggle). Choosing an island engages remote mode against it.
- That single choice sets **both** channels: the control WebSocket *and*
  (once song-selection lands) the browse/data API — you browse and command
  the **same** island.
- Tapping again / "Stop controlling" returns to local (phone plays its own
  sound, streamed from its origin server).

**Fast path:** when there's only one remembered server, *tap* = reconnect
it instantly (no sheet). Reveal the picker only via long-press / a chevron,
so there's no "choose" tax when there's nothing to choose.

**Deliberate simplification (YAGNI):** data-server and play-target are
coupled to one selection. You can't yet browse island A while playing on
the phone. Decouple later only if a real need appears.

---

## 4. The server menu — three feeders, one list

The dropdown is a **union** of three sources, each row with a live
reachability dot (green = up, grey = down):

1. **Tailscale-discovered** (named, automatic). The browser can't run
   `tailscale status`, so the **server** exposes e.g. `GET /api/peers`,
   which runs `tailscale status --json` on its host, **probes each peer**
   for a live Allegory server (filters out the phone itself and non-Allegory
   devices), and returns the survivors with their MagicDNS names
   (`imac-fedora`, `toddgpt-fedora`, …).
2. **Remembered** — every island connected to before, in localStorage.
3. **Manual entry** — type a host/IP. Always available.

**Why all three:** Tailscale gives friendly names and zero-config discovery
**when there's internet**, but it needs internet to coordinate peers — so
it is *not* the resilient path in a dead venue. The remembered/manual feeder
(e.g. a laptop-hotspot IP) is what carries the offline demo. Same menu;
different feeders light up depending on the room.

---

## 5. Known caveats (flag now, don't block)

- **CORS** — once the data origin can differ from the shell origin, the
  server must send permissive CORS headers on `/api` and `/stream` (trivial
  for a LAN tool).
- **Visualizer analyser** — a cross-origin audio stream needs
  `crossOrigin="anonymous"` on the audio element, or the Web Audio analyser
  (`getAnalyser`) goes silent-to-the-graph and the Visualizer dies.
- **No service worker yet** — there's a `manifest.webmanifest` (installable
  icon) but no offline caching. The phone still needs *some* live server to
  load the app shell. So the server-picker gives **in-session failover**
  (dead server mid-use → repoint to a backup); **cold-start-after-death**
  needs the future offline-PWA shell.
- **Tailscale ≠ resilient in a dead exhibit hall** — see §4. Lean on
  hotspot + remembered/manual for Cincy AI Week.

---

## 6. Build order

These are two hats on one feature ("make the controller→server
relationship explicit and real"). Build the plumbing first:

1. **Command channel** — un-stub `playQueue` / `playTrackAt` / `playNext` /
   `addToQueue` in `src/lib/remote-player.tsx`; extend `CmdMsg` in
   `remote-protocol.ts` (+ server relay) to carry a `Track[]` payload; add
   the cases to `HostBridge` (`src/lib/player.tsx`). *This alone fixes the
   "can only pause/skip, can't pick a song" gap.*
2. **Configurable connection target** — make `useConnected()`
   (`src/lib/connection.ts`) return an **absolute** base when a server is
   chosen (default = self/relative); make `remoteUrl()` use the chosen host.
3. **Picker UI** — the "Control which computer?" sheet + reachability dots +
   remembered list + manual entry.
4. **Tailscale discovery** — the `/api/peers` endpoint + probe; merge into
   the picker.

---

## 7. Explicitly deferred (not on the critical path)

- **Offline-PWA shell** — service worker + cached audio, for a phone that
  works with *no* island present. (Cold-start resilience.)
- **Cross-device favorites/library sync** — a real shared backend or sync
  protocol. The island model means "favorites follow me across all my
  computers" does not exist for free.
- **Decoupled data-server vs. play-target** — see §3.

---

## 8. Cincy AI Week demo posture

- The conference laptop is a **self-contained island**: `git clone` +
  `npm ci`, put demo music on its disk, run it. Home machines are
  irrelevant.
- Make the **phone↔laptop link independent of the venue**: run the laptop
  as a Wi-Fi **hotspot** (or bring a travel router). Then bad venue wifi and
  dead cellular are not in the path.
- **Rehearse in the failure mode**: cellular off, venue wifi forgotten,
  phone joined only to the laptop's hotspot — run the *entire* phone demo
  cold. If it works on the couch like that, it works in the hall.
- **Tailscale is not the demo's safety net** — the hotspot + a remembered
  hotspot IP is.

### Demo machine: the x86 Lenovo (not the M2 MacBook)

The demo island is an ~8-year-old **x86-64 Lenovo**, being switched from
PopOS to **Fedora x86_64**. Chosen over the M2 MacBook *on purpose*: the
MacBook runs Fedora Asahi (ARM), and software that expects Intel
occasionally fights it. x86 makes the whole stack — hotspot, OBS, UxPlay,
ffmpeg, Allegory — boring and broadly supported. For a live talk, boring
wins. Prep checklist:

- Fedora x86_64 installed; `git clone` + `npm ci` Allegory; demo music on
  its disk; `ALLEGORY_MUSIC_DIR` pointed at it.
- Verify the **Wi-Fi card can run a hotspot** (`nmcli device wifi hotspot`
  — most Intel cards do).
- Verify the **battery** still holds a charge; bring the charger regardless.
- **Specs TBD** — confirm CPU/RAM/disk after the OS swap, *then* order the
  A/V kit on Amazon.

### A/V: putting the live iPhone on the projector

No slide tool (Google Slides / PowerPoint / **Beamer** — which is static
PDF) can embed a *live* app window. The pattern is: **mirror the iPhone to
the laptop as a live window, then switch to that window** (fullscreen, or
composited in an OBS scene with a phone-bezel overlay). "Inside the slide"
becomes "alt-tab to the mirror." The thing being used here is **AirPlay
screen mirroring** (same idea as mirroring to the Roku).

**Primary path — wired capture (bulletproof, zero network, Asahi-/ARM-proof
because UVC needs no drivers):**

1. **Apple Lightning Digital AV Adapter** (official) — iPhone is Lightning
   (iPhone 14 / older). Picks up the HDCP handshake so the app UI mirrors.
2. Short **HDMI cable** (1–3 ft).
3. **USB-A UVC HDMI→USB capture dongle** (MS2109-class, ~$12–20). Plugs
   straight into the Lenovo's USB-A — no USB-C adapter needed. Show it via
   OBS, or simply `ffplay /dev/video0` / VLC / mpv.

> Chain: iPhone → Lightning AV adapter → HDMI cable → **USB** capture dongle
> → laptop USB-A. The laptop's own HDMI port is **output only** — it cannot
> capture; the iPhone HDMI must go through the USB dongle.

> Avoid any capture device that needs a driver/app download or vendor
> software — plain **UVC** only.

**Wireless backup — UxPlay:** an open-source AirPlay receiver for Linux;
the iPhone mirrors to it over the laptop's hotspot (no venue network). Free,
slightly flakier and higher-latency than the wire. Configure it as the
fallback, rehearse with both.
