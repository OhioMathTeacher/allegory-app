#!/usr/bin/env bash
#
# Sync curated song notes — the `.md` sidecars that ground Socrates — between
# this machine's music library and the repo, so they travel between computers
# (e.g. the Fedora workstation and the MacBook Air).
#
#   ./bin/sync-curation-notes.sh            import: repo  -> music tree (default)
#   ./bin/sync-curation-notes.sh --export   export: music -> repo (then commit)
#
# A note is a `.md` file sitting next to a track. The repo keeps a mirror under
# curation/ keyed by each note's path relative to the music dir, so it
# lands in the right place on any machine whose library shares that layout.
# (Only `.md` is treated as notes — `.txt`/`.lrc` are lyrics/other and ignored.)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIRROR="$ROOT/curation"

# Resolve the music dir: env override -> app settings -> default.
MUSIC="${ALLEGORY_MUSIC_DIR:-}"
if [ -z "$MUSIC" ] && [ -f "$ROOT/.allegory-cache/settings.json" ]; then
  MUSIC="$(python3 -c "import json;print(json.load(open('$ROOT/.allegory-cache/settings.json')).get('musicDir',''))" 2>/dev/null || true)"
fi
MUSIC="${MUSIC:-/data/music}"

if [ "${1:-}" = "--export" ]; then
  [ -d "$MUSIC" ] || { echo "music dir not found: $MUSIC" >&2; exit 1; }
  echo "Export  $MUSIC/**/*.md  ->  curation/"
  n=0
  while IFS= read -r -d '' f; do
    rel="${f#"$MUSIC"/}"
    mkdir -p "$MIRROR/$(dirname "$rel")"
    cp -p "$f" "$MIRROR/$rel"
    echo "  + $rel"
    n=$((n + 1))
  done < <(find "$MUSIC" -type f -iname '*.md' -print0)
  echo "Exported $n note(s). Then: git add curation && git commit && git push"
else
  [ -d "$MIRROR" ] || { echo "no notes mirror at $MIRROR" >&2; exit 1; }
  [ -d "$MUSIC" ] || { echo "music dir not found: $MUSIC (set ALLEGORY_MUSIC_DIR)" >&2; exit 1; }
  echo "Import  curation/  ->  $MUSIC/"
  n=0; skipped=0
  while IFS= read -r -d '' f; do
    rel="${f#"$MIRROR"/}"
    dest="$MUSIC/$rel"
    if [ ! -d "$(dirname "$dest")" ]; then
      echo "  ! skip (no matching album folder here): $rel" >&2
      skipped=$((skipped + 1)); continue
    fi
    cp -p "$f" "$dest"
    echo "  -> $rel"
    n=$((n + 1))
  done < <(find "$MIRROR" -type f -iname '*.md' ! -name 'README.md' -print0)
  echo "Imported $n note(s), skipped $skipped (no matching folder on this machine)."
fi
