#!/usr/bin/env bash
# Install (or refresh) the Allegory LaunchAgent so the Vite dev server starts at
# login and restarts itself on crash — the macOS counterpart of
# install-service.sh (systemd). Idempotent. Re-run after moving the repo or
# upgrading node. No sudo: it installs into your own ~/Library/LaunchAgents.
set -euo pipefail

# Portable repo resolution (BSD has no `readlink -f`).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$REPO/packaging/com.allegory.dev.plist.in"
LABEL="com.allegory.dev"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"
LOG="$HOME/Library/Logs/Allegory.log"

NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "error: npm not found on PATH" >&2; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"

mkdir -p "$DEST_DIR" "$(dirname "$LOG")"
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__NPM__|$NPM|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__LOG__|$LOG|g" \
    "$TEMPLATE" > "$DEST"

# Reload cleanly (ignore "not loaded" on first run).
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "Installed: $DEST"
echo "Pointing at: $REPO"
echo "Using npm:  $NPM"
echo
echo "Allegory now starts at login and restarts itself on crash."
echo "  Logs:    tail -f $LOG"
echo "  Status:  launchctl list | grep allegory"
echo "  Stop:    launchctl unload $DEST"
