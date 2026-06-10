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

`allegory.desktop` runs `bin/allegory-launch`, which:

1. Checks `node_modules/` exists — if not, offers to run `npm install`
   in a Zenity dialog.
2. If a previous launch's URL file is still valid, opens that URL in
   Firefox and exits (instant re-launch).
3. Otherwise starts `npm run dev` detached, waits for the Vite plugin
   to publish the live URL to `.allegory-cache/url`, and opens it.
4. On any failure (server crash, timeout), pops a Zenity error dialog
   with the last 20-ish lines of `.allegory-cache/launcher.log`.

The server keeps running after the launcher exits. Click the icon
again and it'll reuse the same server (just opens a new browser tab).

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
