#!/usr/bin/env bash
# Build (or refresh) ~/Applications/Allegory.app — a Dock-able launcher that runs
# bin/allegory-launch. The macOS counterpart of install-launcher.sh (.desktop +
# Cinnamon panel pin), which is still the right script on Linux and is not
# replaced by this one.
#
# Idempotent. Re-run after moving the repo, upgrading node, or changing the icon.
# No sudo: everything lands in your own ~/Applications.
set -euo pipefail

# BSD readlink has no -f on older systems, and the bundle is built from a known
# path anyway.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Allegory.app"
ICON_SRC="$REPO/public/icon-512.png"
MARKER="$APP/Contents/Resources/.allegory-launcher"

[ "$(uname -s)" = "Darwin" ] || {
  echo "error: this is the macOS installer; on Linux run install-launcher.sh" >&2
  exit 1
}

NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "error: npm not found on PATH" >&2; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"

# Safari's "Add to Dock" also writes ~/Applications/Allegory.app, and that bundle
# is a real web app someone may be using. Overwriting it would replace a working
# app window with a shell script and leave no way back but re-adding it by hand,
# so refuse rather than clobber. Our own bundle carries the marker and is always
# safe to rebuild.
if [ -d "$APP" ] && [ ! -e "$MARKER" ]; then
  echo "error: $APP exists and was not created by this script." >&2
  echo "       It is most likely a Safari web app (File > Add to Dock)." >&2
  echo "       Delete or rename it first if you want the launcher instead." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- Info.plist --------------------------------------------------------------
# LSUIElement is deliberately absent. The stub exits as soon as the browser is
# open, so the icon bounces and goes — but the bundle still has to be a normal
# foreground app for the Dock to accept it as a permanent item, and for
# osascript's error dialogs to come to the front.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Allegory</string>
  <key>CFBundleDisplayName</key>       <string>Allegory</string>
  <key>CFBundleIdentifier</key>        <string>com.allegory.launcher</string>
  <key>CFBundleExecutable</key>        <string>Allegory</string>
  <key>CFBundleIconFile</key>          <string>allegory</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key>           <string>1</string>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

# --- the stub ----------------------------------------------------------------
# An app launched from the Dock inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin and
# nothing else — not your shell's PATH, because no shell profile is ever read.
# Homebrew, MacPorts and nvm all live outside that list, so the node directory is
# resolved now, at install time, and written in. (The LaunchAgent installer that
# used to sit beside this took the same approach, and was removed on 2026-09-09.)
cat > "$APP/Contents/MacOS/Allegory" <<STUB
#!/bin/bash
export PATH="$NODE_BIN:\$PATH"

# To pin a particular browser, uncomment and edit. Anything whose first word
# contains "firefox" takes the Firefox path; anything else must understand
# --app=. See open_browser() in bin/allegory-launch.
# export ALLEGORY_BROWSER="/Applications/Firefox.app/Contents/MacOS/firefox"

exec "$REPO/bin/allegory-launch"
STUB
chmod +x "$APP/Contents/MacOS/Allegory"

touch "$MARKER"

# --- the icon ----------------------------------------------------------------
# iconutil wants a directory of exact sizes; sips resizes one PNG into all of
# them. The source is 512px, so the two 1024px entries are upscales — they only
# matter on a Retina Dock at maximum magnification, and their absence would mean
# a blurrier icon there, not a missing one.
if [ -f "$ICON_SRC" ]; then
  ICONSET="$(mktemp -d)/allegory.iconset"
  mkdir -p "$ICONSET"
  for spec in 16:16x16 32:16x16@2x 32:32x32 64:32x32@2x \
              128:128x128 256:128x128@2x 256:256x256 512:256x256@2x \
              512:512x512 1024:512x512@2x; do
    px="${spec%%:*}"; name="${spec#*:}"
    sips -z "$px" "$px" "$ICON_SRC" --out "$ICONSET/icon_$name.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/allegory.icns"
  rm -rf "$(dirname "$ICONSET")"
else
  echo "warning: $ICON_SRC missing — the app gets the generic icon" >&2
fi

# --- signing (optional) ------------------------------------------------------
# Not needed to run this here. Gatekeeper checks the quarantine attribute, and a
# bundle built on the machine it runs on never gets one — only downloads,
# AirDrops and email attachments do.
#
# It matters the moment the .app reaches a second Mac by any of those routes: an
# unsigned bundle is refused outright, and a signed-but-not-notarized one still
# needs a right-click > Open. So this is opt-in, and off by default:
#
#     ALLEGORY_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
#       ./packaging/install-launcher-macos.sh
#
# Sign last — codesign seals the bundle's contents, so anything written
# afterwards (the icon, the marker) would invalidate the signature.
if [ -n "${ALLEGORY_SIGN_ID:-}" ]; then
  codesign --force --deep --options runtime \
    --sign "$ALLEGORY_SIGN_ID" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  echo "Signed with: $ALLEGORY_SIGN_ID"
fi

# The Finder caches bundle metadata by mtime; without this the icon and name can
# stay stale through a rebuild.
touch "$APP"

cat <<EOF
Installed: $APP
Pointing at: $REPO
Using node:  $NODE_BIN

Drag it to the Dock to keep it there (Finder is opening on it now).
Clicking it starts the dev server if it isn't running, then opens the app
in a chromeless window. Quit the server with: $REPO/bin/allegory-quit
EOF

open -R "$APP"
