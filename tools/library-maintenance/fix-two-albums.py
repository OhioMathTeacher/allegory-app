#!/usr/bin/env python3
"""Fix the two albums that the folder-derived pass could not handle.

  NWOBHM compilation — 30 tracks by 30 different bands. Twelve had the album
  tag with albumartist wrongly set to Diamond Head (the first band on the
  record); eighteen had nothing, so each became its own one-song album. Fixed
  by giving every track the same album + `Various Artists` albumartist and
  setting the compilation flag, which is what makes clients group a various-
  artists record as one album instead of thirty.

  Elysian Fields / Queen Of The Meadow — the label (Vicious Circle Records)
  ended up in the artist field, titles carry a "Elysian Fields - ... (official
  audio)" wrapper, and there are no track numbers. Track order comes from the
  Bandcamp release the user supplied.

DRY RUN by default. --write saves originals to a JSON backup first.
"""
import json
import os
import sys

import mutagen
from mutagen.easyid3 import EasyID3

# EasyID3 has no compilation key by default; TCMP is the de-facto ID3 frame.
EasyID3.RegisterTextKey("compilation", "TCMP")

NWOBHM_DIR = "/media/MUSIC/V.A. - New Wave of British Heavy Metal '79 Revisited (1990)"
NWOBHM_ALBUM = "New Wave of British Heavy Metal '79 Revisited"
NWOBHM_YEAR = "1990"

EF_DIR = "/media/MUSIC/Elysian Fields"
EF_ALBUM = "Queen Of The Meadow"
EF_ARTIST = "Elysian Fields"
EF_YEAR = "2000"

# Track order from the Bandcamp release page.
EF_ORDER = [
    "Black Acres", "Bayonne", "Bend Your Mind", "Tides of the Moon",
    "Hearts Are Open Graves", "Rope of Weeds", "Dream Within a Dream",
    "Barely Recognize You", "Fright Night", "Queen of the Meadow",
    "Cities Will Fall",
]

# Unambiguous artist typos/casing on the compilation. `Sazon` is a misspelling
# of Saxon — the filename has it right.
ARTIST_FIX = {
    "Sazon": "Saxon",
    "Diamond head": "Diamond Head",
    "Angel witch": "Angel Witch",
    "Tygers of pan tang": "Tygers of Pan Tang",
}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def ef_title(filename):
    """'Elysian Fields - Black Acres (official audio).m4a' -> 'Black Acres'"""
    t = os.path.splitext(filename)[0]
    if t.lower().startswith(EF_ARTIST.lower() + " - "):
        t = t[len(EF_ARTIST) + 3:]
    for suffix in (" (official audio)", " (Official Audio)"):
        if t.endswith(suffix):
            t = t[: -len(suffix)]
    return t.strip()


def plan():
    changes = []

    for f in sorted(os.listdir(NWOBHM_DIR)):
        p = os.path.join(NWOBHM_DIR, f)
        if not os.path.isfile(p) or f.startswith("."):
            continue
        try:
            a = mutagen.File(p, easy=True)
        except Exception as e:
            print(f"  SKIP (unreadable) {f}: {e}", file=sys.stderr)
            continue
        if a is None:
            continue
        want = {
            "album": NWOBHM_ALBUM,
            "albumartist": "Various Artists",
            "compilation": "1",
            "date": NWOBHM_YEAR,
        }
        cur_artist = g(a, "artist")
        if cur_artist in ARTIST_FIX:
            want["artist"] = ARTIST_FIX[cur_artist]
        changes.append((p, a, want))

    order = {t.lower(): i + 1 for i, t in enumerate(EF_ORDER)}
    for f in sorted(os.listdir(EF_DIR)):
        p = os.path.join(EF_DIR, f)
        if not os.path.isfile(p) or f.startswith("."):
            continue
        try:
            a = mutagen.File(p, easy=True)
        except Exception as e:
            print(f"  SKIP (unreadable) {f}: {e}", file=sys.stderr)
            continue
        if a is None:
            continue
        title = ef_title(f)
        n = order.get(title.lower())
        if n is None:
            print(f"  !! not in Bandcamp tracklist, skipping: {title!r}", file=sys.stderr)
            continue
        changes.append((p, a, {
            "album": EF_ALBUM,
            "albumartist": EF_ARTIST,
            "artist": EF_ARTIST,
            "title": title,
            "tracknumber": str(n),
            "date": EF_YEAR,
        }))

    return changes


def main():
    write = "--write" in sys.argv
    backup_path = "/home/todd/navidrome-trial/backups/two-albums.json"
    changes = plan()

    print(f"{'WRITING' if write else 'DRY RUN'} — {len(changes)} files\n")
    cur_dir = None
    for p, a, want in changes:
        d = os.path.dirname(p)
        if d != cur_dir:
            cur_dir = d
            print(f"  {os.path.relpath(d, '/media/MUSIC')}")
        name = os.path.basename(p)
        bits = []
        for k in ("title", "tracknumber", "artist"):
            if k in want and want[k] != g(a, k):
                bits.append(f"{k}: {g(a, k)!r} -> {want[k]!r}")
        print(f"    {name[:58]}")
        for b in bits:
            print(f"        {b}")

    first = changes[0][2] if changes else {}
    print(f"\n  all NWOBHM tracks -> album={NWOBHM_ALBUM!r}, albumartist='Various Artists', compilation=1")
    print(f"  all Elysian tracks -> album={EF_ALBUM!r}, albumartist={EF_ARTIST!r}")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {}
    for p, a, _ in changes:
        backup[p] = {k: g(a, k) for k in
                     ("album", "albumartist", "artist", "title", "tracknumber", "date", "compilation")}
    os.makedirs(os.path.dirname(backup_path), exist_ok=True)
    with open(backup_path, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {backup_path}")

    n = 0
    for p, a, want in changes:
        try:
            for k, v in want.items():
                a[k] = v
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.basename(p)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
