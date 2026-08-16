#!/usr/bin/env python3
"""Unify album tags within a folder so one album stops reading as several.

Navidrome groups by album name, so a single differing character splits a record
("Freak Out!" vs "Freak Out"). Majority vote is NOT safe on its own: in the
"We're Only In It For the Money" folder 18 tracks carry a wrong album name and
only one is right. So the folder name breaks the tie — whichever tag value most
resembles the folder wins, falling back to majority when nothing resembles it.
"""
import os
import difflib, json, os, re, sys
from collections import Counter
import mutagen

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff"}
CD = re.compile(r"^(?:(?:cd|dis[ck])[\s._-]*\d+|\d+)$", re.I)
norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())

write = "--write" in sys.argv
plan, backup = [], {}
for root, dirs, files in os.walk(MUSIC):
    if "/Playlists" in root:
        continue
    auds = [f for f in files if os.path.splitext(f)[1].lower() in AUD and not f.startswith(".")]
    if not auds:
        continue
    tags, votes = {}, Counter()
    for f in auds:
        p = os.path.join(root, f)
        try:
            a = mutagen.File(p, easy=True)
        except Exception:
            continue
        if a is None:
            continue
        v = ((a.get("album") or [""])[0] or "").strip()
        tags[p] = v
        if v:
            votes[v] += 1
    if len(votes) < 2:
        continue
    base = os.path.basename(root)
    if CD.match(base):
        base = os.path.basename(os.path.dirname(root))
    best = max(votes, key=lambda v: (difflib.SequenceMatcher(None, norm(v), norm(base)).ratio(), votes[v]))
    for p, v in tags.items():
        # Only unify names that are essentially the same string — "Freak Out!"
        # vs "Freak Out". Genuinely different album names in one folder (a
        # multi-disc set, a compilation of singles) must stay distinct.
        if v and v != best and difflib.SequenceMatcher(None, norm(v), norm(best)).ratio() > 0.9:
            plan.append((p, best, v))

print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files")
shown = Counter()
for p, best, old in plan:
    shown[(os.path.relpath(os.path.dirname(p), MUSIC), old, best)] += 1
for (d, old, new), n in list(shown.items())[:12]:
    print(f"  {d}\n      {old!r} -> {new!r}  ({n})")

if write:
    for p, best, old in plan:
        backup[p] = {"album": old}
        try:
            a = mutagen.File(p, easy=True)
            a["album"] = best
            a.save()
        except Exception as e:
            print(f"  FAILED {p}: {e}", file=sys.stderr)
    os.makedirs("backups", exist_ok=True)
    json.dump(backup, open("backups/album-names.json", "w"), indent=1)
    print(f"  wrote {len(plan)} files")
