# Allegory desktop launcher

A click-to-launch entry for the Cinnamon menu (works the same on Fedora
and Debian-based distros — the `.desktop` format is freedesktop, not
distro-specific).

## Install

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
4. Otherwise: checks `node_modules/` exists (offering `npm install` in a
   Zenity dialog if not), starts `npm run dev` detached, waits for the Vite
   plugin to publish the live URL to `.allegory-cache/url`, and opens it.

On any failure (server crash, timeout), it pops a Zenity error dialog with the
last 20-ish lines of `.allegory-cache/launcher.log`.

The server keeps running after the launcher exits. Click the icon
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
if the library is password-protected. It stays logged in after that.

Firefox is preferred when present, purely because that is what this
launcher has always opened. To use something else — a Chromium-family
`--app=` window is the cleaner result of the two — set `ALLEGORY_BROWSER`:

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
