#!/usr/bin/env bash
# Install (or refresh) the Allegory launcher.
#
# Two steps, both idempotent so it's safe to re-run after moving the repo
# or setting up a new machine:
#   1. Write the .desktop into the user's app menu (freedesktop standard).
#   2. On Cinnamon (X-Cinnamon), PIN it to the panel. This is the step that
#      bites every new install: Cinnamon is not GNOME — dropping a .desktop
#      in ~/.local/share/applications does NOT auto-add a panel icon the way
#      GNOME Shell does. A panel icon in Cinnamon means an explicit pin into
#      the panel's taskbar applet (grouped-window-list), which keeps its own
#      "pinned-apps" list. We add allegory.desktop to that list directly.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TEMPLATE="$REPO/packaging/allegory.desktop.in"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DEST="$DEST_DIR/allegory.desktop"
APP_ID="allegory.desktop"

# --- 1. Install the .desktop -------------------------------------------------
mkdir -p "$DEST_DIR"
sed "s|__REPO__|$REPO|g" "$TEMPLATE" > "$DEST"
chmod 644 "$DEST"

# Validate (warns if Cinnamon would reject anything; non-fatal).
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$DEST" || true
fi

# Nudge the freedesktop menu cache so the menu entry appears.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DEST_DIR" >/dev/null 2>&1 || true
fi

echo "Installed: $DEST"
echo "Pointing at: $REPO"

# --- 2. Pin to the Cinnamon panel -------------------------------------------
# grouped-window-list is the default Cinnamon taskbar applet. Different
# Cinnamon versions store the applet config in different places:
#   - newer (Mint 22+):  ~/.cinnamon/configs/<applet>/<instance>.json
#   - older:             ~/.config/cinnamon/spices/<applet>/<instance>.json
# Each instance JSON has a "pinned-apps" list of .desktop ids. We append
# ours to every instance that has such a list. Cinnamon live-watches these
# files, so the icon usually appears without a restart.
pinned_any=0
GWL_DIRS=(
  "$HOME/.cinnamon/configs/grouped-window-list@cinnamon.org"
  "${XDG_CONFIG_HOME:-$HOME/.config}/cinnamon/spices/grouped-window-list@cinnamon.org"
)

if command -v python3 >/dev/null 2>&1; then
  for GWL_DIR in "${GWL_DIRS[@]}"; do
    [ -d "$GWL_DIR" ] || continue
    for cfg in "$GWL_DIR"/*.json; do
      [ -e "$cfg" ] || continue
      if python3 - "$cfg" "$APP_ID" <<'PY'
import json, sys, shutil
cfg, app_id = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(cfg))
except Exception:
    sys.exit(1)
node = data.get("pinned-apps")
if not isinstance(node, dict) or not isinstance(node.get("value"), list):
    sys.exit(1)          # not a config with a pinned list; skip
if app_id in node["value"]:
    sys.exit(2)          # already pinned; nothing to do
shutil.copy2(cfg, cfg + ".bak")
node["value"].append(app_id)
json.dump(data, open(cfg, "w"), indent=4, ensure_ascii=False)
sys.exit(0)
PY
      then
        echo "Pinned to Cinnamon panel: $(basename "$cfg") (backup: $cfg.bak)"
        pinned_any=1
      else
        case $? in
          2) echo "Already pinned to Cinnamon panel: $(basename "$cfg")"; pinned_any=1 ;;
        esac
      fi
    done
  done
fi

echo
if [ "$pinned_any" = "1" ]; then
  echo "Done. Restart Cinnamon to be sure the panel icon shows:"
  echo "    cinnamon --replace &        (or Ctrl+Alt+Esc, or log out/in)"
elif [ "${XDG_CURRENT_DESKTOP:-}" = "X-Cinnamon" ]; then
  echo "You're on Cinnamon but no grouped-window-list panel config was found."
  echo "Pin it by hand: open the menu, find Allegory under Sound & Video,"
  echo "right-click it and choose 'Add to panel'."
else
  echo "Look for 'Allegory' in your app menu (Sound & Video) and pin it as"
  echo "your desktop environment prefers."
fi
