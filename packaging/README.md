# Allegory desktop launcher

A click-to-launch entry for the Cinnamon menu (works the same on Fedora
and Debian-based distros — the `.desktop` format is freedesktop, not
distro-specific).

On macOS the same launcher is wrapped in an `.app` bundle you can keep in the
Dock — see [macOS: a Dock icon](#macos-a-dock-icon) below. Both platforms run
the *same* `bin/allegory-launch`; only the thing that clicks it differs, so
everything in "What clicking it does", "Why it looks like an app", and "Opening
a library on another machine" applies to both.

## Install (Linux / Cinnamon)

From the repo root:

```sh
./packaging/install-launcher.sh
```

The installer does two idempotent things:

1. Writes a personalised copy of `allegory.desktop.in` (with the repo path
   filled in) to `~/.local/share/applications/allegory.desktop`.
2. **On Cinnamon, pins it to the panel automatically.** This is the step
   that bit us on every fresh install. Cinnamon is *not* GNOME: dropping a
   `.desktop` into the apps folder does **not** auto-create a panel icon the
   way GNOME Shell does. A panel icon in Cinnamon is an explicit *pin* into
   the panel's taskbar applet (`grouped-window-list`), which keeps its own
   `pinned-apps` list. The script appends `allegory.desktop` to that list
   (backing up each config it touches as `*.json.bak`).

Re-run the script any time — it's safe to run repeatedly (skips the pin if
it's already there) and you should re-run it after moving the repo to a new
path or setting up a new machine.

### After install: reload Cinnamon

Cinnamon live-watches its config, so the panel icon often appears on its
own. To be sure (and to refresh the menu entry), reload the shell:

```sh
cinnamon --replace &        # restarts the shell in place (brief flicker)
```

…or press **Ctrl+Alt+Esc**, or log out and back in. Once it's reloaded, the
pin sticks across restarts — you only do this the first time.

If you're on a different desktop (or the auto-pin couldn't find a
`grouped-window-list` config), the script tells you so and you can pin by
hand: open the menu → **Sound & Video** → right-click **Allegory** →
*Add to panel*.

## macOS: a Dock icon

macOS has no `.desktop` files and no menu to install into. The equivalent unit
is an application bundle — a directory named `Allegory.app` whose `Contents/`
holds an `Info.plist`, an icon, and an executable. Build one with:

```sh
./packaging/install-launcher-macos.sh
```

It writes `~/Applications/Allegory.app` and opens Finder on it. **Drag it to the
Dock once and it stays there** — clicking it runs exactly the same
`bin/allegory-launch` the Cinnamon icon runs. The script is idempotent: re-run
it after moving the repo, upgrading node, or changing the icon.

The bundle is three small pieces:

| Piece | Why |
| --- | --- |
| `Info.plist` | Names the app, points at the icon. No `LSUIElement` — the stub exits once the browser is open, but the Dock only accepts a normal foreground app as a permanent item. |
| `Contents/MacOS/Allegory` | A stub that sets `PATH` and `exec`s `bin/allegory-launch`. |
| `allegory.icns` | Built from `public/icon-512.png` with `sips` + `iconutil`. |

Two macOS details the stub exists to handle:

- **An app launched from the Dock has almost no `PATH`** — `/usr/bin:/bin:
  /usr/sbin:/sbin`, and nothing else, because no shell profile is ever read.
  Homebrew, MacPorts and nvm all live outside that list, so `npm` is simply not
  found. The installer resolves the node directory *at install time* and writes
  it into the stub, which is why you re-run it after upgrading node.
  (The removed `install-launchagent-macos.sh` baked in `__NODE_BIN__` for the
  same reason.)
- **Naming it `Allegory.app` collides with Safari.** "Add to Dock" writes its
  web apps to the same `~/Applications` under the same name, and
  `open_browser()` in `bin/allegory-launch` looks there. Left alone, the
  launcher would open *itself* and re-enter. The bundle therefore carries a
  marker file at `Contents/Resources/.allegory-launcher`: `open_browser()` skips
  any bundle that has it, and the installer refuses to overwrite any bundle that
  doesn't (so it can never clobber a Safari web app you were using).

### Which browser to pick on macOS

`open_browser()` tries the same order it does on Linux, and all three families
work. If you have a preference, set `ALLEGORY_BROWSER` — there is a commented-out
line in the stub for exactly this:

```sh
export ALLEGORY_BROWSER="/Applications/Firefox.app/Contents/MacOS/firefox"
```

- **Brave / Chrome / Chromium / Edge / Vivaldi — the default, and the one to
  want.** `--app=URL` is a supported flag that gives a real chromeless window
  with nothing to install. `chromium_app_command()` looks inside
  `/Applications/*.app/Contents/MacOS/` because macOS ships browsers as bundles,
  which `command -v` cannot see.
- **Firefox works**, via the dedicated profile and `userChrome.css` described
  below; on macOS that profile lives in `~/Library/Application Support/Allegory/
  firefox-app`. It is a stylesheet reaching into Mozilla's own UI, so it holds
  only as long as those element IDs do — fine, but more fragile than a flag.
- **Safari can't be scripted into an app window at all** — no `--app`
  equivalent, no profile hook. The supported route is the manual one: open
  `http://localhost:5173/` in Safari, then **File → Add to Dock**. That makes a
  genuine web app that honours `manifest.webmanifest`, which is the *nicest*
  window of the three. Note the one real functional cost: **Safari does not
  implement `HTMLMediaElement.setSinkId`, so the output-device picker
  disappears.** It degrades rather than breaks — `OUTPUT_SUPPORTED` in
  `src/lib/player.tsx` feature-detects it and hides the control — but if you
  send audio to specific speakers, use a Chromium.

If you do take the Safari route, remember it is still only a window: something
must be serving `localhost:5173`. Keep the Dock launcher (or the LaunchAgent)
for that.

### Signing

Not needed to run this on the machine that built it. Gatekeeper keys off the
`com.apple.quarantine` attribute, and a locally built bundle never gets one —
only downloads, AirDrops and mail attachments do.

It matters only if the `.app` travels to another Mac by one of those routes. If
you have a Developer ID:

```sh
ALLEGORY_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
  ./packaging/install-launcher-macos.sh
```

Signing happens last, after the icon and marker are written — `codesign` seals
the bundle, so anything added afterwards invalidates it. Signed-but-not-notarized
still needs a right-click → Open on the receiving Mac; notarization is a further
step this script doesn't do.

### Always-on, and stopping it

**There is no always-on server on macOS, and that is deliberate.** A LaunchAgent
running `npm run dev` at login used to live here; it was removed on 2026-09-09
after one had been serving `*:5173` on MacGuffey for fifteen days unnoticed.
Nothing needed it — the app is served by `allegory.service` on the iMac, and a
Mac is a place you look at Allegory from, not a place that serves it.

To develop, type `npm run dev`. To use the app, open the Dock launcher, which
points at the iMac.

`bin/allegory-quit` stops a dev server the launcher started, on either platform.

## What clicking it does

`allegory.desktop` runs `bin/allegory-launch`, which tries these in order and
stops at the first that works:

1. **A remote library**, if one is configured — see the next section. Opens
   that URL and exits without starting anything locally.
2. **The systemd service**, if `allegory.service` is active — probes
   `localhost:4173` and opens it. Checked before starting a dev server,
   because starting a second server when one is already running is how you
   end up looking at the wrong one.
3. **A previous launch's URL file**, if the server it names still answers —
   opens that URL in Firefox and exits (instant re-launch).
4. Otherwise: explains that nothing is answering and where the library
   actually lives. **It does not start a server** — that fallback was removed on
   2026-09-09, because opening a launcher on a machine where nothing was up is
   how that machine quietly became a second Allegory.


The message names the iMac's URL, how to check the service is up, how to point
the launcher elsewhere via `.allegory-cache/remote`, and how to run `npm run
dev` if you actually meant to develop.

The iMac's server keeps running regardless of the launcher. Click the icon
again and it'll reuse the same server, opening a second app window.

## Why it looks like an app and not a browser tab

Allegory draws its own chrome. Stacking a tab strip, a bookmarks bar and
an address bar on top of that makes it read as a web page you happen to
have open rather than a program you launched — and the tab strip is the
worst of the three, because it shows every unrelated tab in the window.

None of this is per-browser code *in the app*: `manifest.webmanifest`
already declares `display: standalone`, and that is the whole of the app's
side. What differs is how each browser is asked to open a chromeless
window, and `open_browser()` in `bin/allegory-launch` holds all of it:

| Browser | How | Setup |
| --- | --- | --- |
| Chrome, Chromium, Brave, Edge, Vivaldi | `--app=URL` | none |
| Firefox | dedicated profile + `userChrome.css` | written automatically |
| Safari | **File → Add to Dock** | one manual step, then it's an `.app` |

Firefox is the odd one out. Mozilla built a site-specific-browser mode and
then removed it, so there is no flag to ask for. The substitute is a
profile of our own at `~/.local/share/allegory/firefox-app` (on macOS,
`~/Library/Application Support/Allegory/firefox-app`) whose
`chrome/userChrome.css` collapses the three bars and whose `user.js` turns
on a real titlebar to keep the window controls. The launcher rewrites both
files on every start — a stale `userChrome.css` after a Firefox update is a
half-hidden toolbar with no obvious cause. Everything you accumulate (the
login cookie, window size, zoom) lives elsewhere in that profile and
survives.

Because it is a separate profile, the first launch asks you to log in once
if the library is password-protected. It stays logged in after that. The
same is true the first time the app opens in Brave rather than in the
Firefox you had been using.

The launcher tries them in that order and stops at the first that works, so
there is no browser it *requires*. Brave leads because `--app=` is a
supported flag doing exactly what it says, where the Firefox path is a
stylesheet reaching into someone else's UI and holds only as long as that UI
keeps its element IDs. If Brave is absent it falls through to any other
Chromium-family browser — Chrome, Chromium, **Edge**, Vivaldi, native package
or Flatpak, all of which take the same `--app=` flag and give the same window
— then to a Safari-made web app on macOS, then to Firefox, and finally to
plain `xdg-open`. Something always opens.

To pin a specific one, set `ALLEGORY_BROWSER`:

```bash
ALLEGORY_BROWSER='flatpak run com.brave.Browser' bin/allegory-launch
```

Put it in the `.desktop` file's `Exec=` line (as `env ALLEGORY_BROWSER=… \
/path/to/bin/allegory-launch`) to make it stick.

## Opening a library on another machine

The machine you sit at is not always the machine holding the music — a laptop
with a partial library on an external drive, and a desktop holding the whole
collection, is a common enough split. Left to itself the launcher always starts
the *local* server, so the menu entry quietly opens the smaller library.

Write a URL into `.allegory-cache/remote` and that becomes what the icon opens:

```sh
echo 'http://other-machine.example:4173/' > .allegory-cache/remote
```

`ALLEGORY_REMOTE` in the environment does the same thing and takes precedence.
To go back to the local library, delete the file.

Three deliberate details:

- **It is not the `url` file.** That one is scratch state and gets deleted
  whenever a probe fails. Configuration must not evaporate because a tunnel
  was down for a minute.
- **An unreachable remote asks first**, rather than opening the local library
  unannounced. A silent fallback is indistinguishable from a library that has
  lost most of its tracks.
- **A 401 counts as reachable.** The question is whether a server answers, not
  whether this device is logged in yet.

`.allegory-cache/` is gitignored, so this is machine-local and survives the
in-app updater (which runs `reset --hard origin/main`). It is also the right
place for an address you don't want committed.

## Always-on (systemd user service)

If you'd rather never hit a "Problem loading page" when you open the
`localhost:5173` bookmark directly, install the systemd `--user`
service. It starts Vite on login and restarts it automatically if it
crashes:

```sh
./packaging/install-service.sh
```

That fills `allegory.service.in` (repo path + resolved `node`/`npm`)
into `~/.config/systemd/user/allegory.service`, then enables and starts
it. Re-run after moving the repo or upgrading node.

### Which port the service actually uses

The committed template runs the **dev server on 5173** (`ExecStart=__NPM__ run
dev`). A deployment may instead serve the **built `dist/` on 4173** via
`vite preview`, which is what the upstairs machine does — and
`bin/allegory-launch` probes `localhost:4173` when `allegory.service` is active,
so it assumes that arrangement.

If you install the service from the template unmodified, you get 5173 and the
launcher's 4173 probe simply misses, falling through to the URL-file and
dev-server steps. Worth knowing before you go hunting: the template and the
launcher currently disagree, and the rest of this file describes the 5173 path.

A `dist/`-serving deployment needs `npm run build` after code changes; a restart
alone won't pick them up.

Useful commands:

```sh
journalctl --user -u allegory -f      # follow the server log
systemctl --user restart allegory     # restart it
systemctl --user stop allegory        # stop it (note: see below)
systemctl --user disable --now allegory   # turn the whole thing off
```

By default a user service only runs while you're logged in. To keep it
serving even when logged out (e.g. so a phone on the LAN can reach it):

```sh
loginctl enable-linger "$USER"
```

The launcher icon still works alongside the service — it just finds the
already-running server and opens a tab. Note that `bin/allegory-quit`
will *not* permanently stop a service-managed server: systemd restarts
it. Use `systemctl --user stop allegory` instead.

## Reaching it from away (the car)

The phone reaches the home machine over **Tailscale** — no port-forwarding,
no public exposure. With WiFi off, traffic goes over cellular straight to
the host. Bookmark the **Tailscale** address on the phone, not localhost:

```
http://<tailscale-ip>:5173/         e.g. http://100.x.y.z:5173/
http://<host>.<tailnet>.ts.net:5173/   (if MagicDNS is on)
```

(Substitute **4173** if the host serves the built `dist/` rather than the dev
server. Use the full `.ts.net` name, not the bare short host name — vite's
anti-DNS-rebinding guard only allows `.ts.net`, and rejects the short form with
`Blocked request. This host … is not allowed.`)

Vite binds every interface (`server.host: true` in `vite.config.ts`) and
the port is pinned (`port: 5173`, `strictPort: true`) so that bookmark
never drifts. For this to work away from home, two host-side settings
matter:

1. **Linger on** (above) — so the server runs even when you're logged out
   or after a reboot.
2. **Never sleep** — if the host suspends, its Tailscale node drops off and
   the phone gets nothing. Set the desktop to never suspend on AC (Cinnamon:
   *Menu → Power → On AC power: Suspend = Never*), and belt-and-suspenders,
   mask the systemd sleep targets so nothing can suspend it:

   ```sh
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   ```

   (Display blanking is fine — that's just the monitor, not the machine.)

## Stopping the server

`bin/allegory-quit` kills the running dev server for this repo (when
it's *not* managed by systemd — see above). You can wire it up to a
second `.desktop` file the same way, or just run it from a terminal.

## The port is pinned (5173)

This section is about the **dev server**. The preview server (`vite preview`,
serving the built `dist/`) is configured separately and listens on **4173** —
see "Which port the service actually uses" above.

`vite.config.ts` sets `port: 5173, strictPort: true`, so the server always
lives at 5173 — that's what keeps the phone's Tailscale bookmark stable.
If 5173 is ever already taken, Vite now **fails loudly** instead of silently
moving to 5174 (which used to break the bookmark). The local launcher still
reads the live URL from `.allegory-cache/url` (written by the
`allegoryLibrary` plugin once the server is listening), so clicking the icon
keeps working regardless.

## Uninstall

```sh
rm ~/.local/share/applications/allegory.desktop
```

On macOS:

```sh
rm -rf ~/Applications/Allegory.app                        # the Dock launcher

# If an old LaunchAgent from before 2026-09-09 is still installed, it will keep
# starting a dev server at every login until it is unloaded:
launchctl unload ~/Library/LaunchAgents/com.allegory.dev.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.allegory.dev.plist
```

Remove the Dock item itself by dragging it off. A Safari-made web app (if you
made one) is a separate `~/Applications/Allegory.app` and is not touched by the
installer — delete it the same way.
