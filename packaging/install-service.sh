#!/usr/bin/env bash
# Install (or refresh) the Allegory systemd --user service so the Vite
# dev server starts on login and restarts itself on crash. Re-run after
# moving the repo or upgrading node. Idempotent.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TEMPLATE="$REPO/packaging/allegory.service.in"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DEST="$DEST_DIR/allegory.service"

# Resolve node/npm so the unit works under systemd's minimal PATH.
NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "error: npm not found on PATH" >&2; exit 1; }
NODE_BIN="$(dirname "$(readlink -f "$(command -v node)")")"

mkdir -p "$DEST_DIR"
sed -e "s|__REPO__|$REPO|g" \
    -e "s|__NPM__|$NPM|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$TEMPLATE" > "$DEST"
chmod 644 "$DEST"

systemctl --user daemon-reload
systemctl --user enable --now allegory.service

echo "Installed: $DEST"
echo "Pointing at: $REPO"
echo "Using npm:  $NPM"
echo
systemctl --user --no-pager status allegory.service | head -n 5 || true
echo
echo "Allegory now starts on login and restarts itself on crash."
echo "  Logs:    journalctl --user -u allegory -f"
echo "  Stop:    systemctl --user stop allegory"
echo "  Disable: systemctl --user disable --now allegory"
echo
echo "Tip: to keep it running even when you're logged out, run:"
echo "  loginctl enable-linger $USER"
