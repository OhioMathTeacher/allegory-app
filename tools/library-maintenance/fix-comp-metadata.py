#!/usr/bin/env python3
"""Corrections to the two V.A. compilations, verified against Wikipedia and Discogs.

NWOBHM '79 Revisited (Caroline/Metal Blade 1990, compiled by Lars Ulrich and
Geoff Barton): the local rip has all 30 tracks of the original two-disc release
but sequenced flat 1-30 in the Metal Blade reissue order, which is internally
consistent — so the numbering is left alone. Only outright misspellings are
corrected.

Metal Explosion (Trash, 1980; full title "Metal Explosion From The Friday Rock
Show", all tracks from Tommy Vance's show): already correctly tagged. Only two
titles carry a stray leading space, plus the compilation flag.
"""
import json
import os
import sys

import mutagen
from mutagen.easyid3 import EasyID3

EasyID3.RegisterTextKey("compilation", "TCMP")

NWOBHM = "/media/MUSIC/V.A. - New Wave of British Heavy Metal '79 Revisited (1990)"
METAL_EX = "/media/MUSIC/V.A. - Metal Explosion [Compilation] (1980)"
BACKUP = "/home/todd/navidrome-trial/backups/comp-metadata.json"

# Verified against the Wikipedia track listing.
TITLE_FIX = {"Motorcysle Man": "Motorcycle Man", "Vise versa": "Vice Versa"}
ARTIST_FIX = {"Tresspass": "Trespass"}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def plan():
    out = []
    for d in (NWOBHM, METAL_EX):
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if not os.path.isfile(p) or f.startswith("."):
                continue
            try:
                a = mutagen.File(p, easy=True)
            except Exception as e:
                print(f"  SKIP {f}: {e}", file=sys.stderr)
                continue
            if a is None:
                continue
            want = {}
            raw_title, raw_artist = g(a, "title"), g(a, "artist")
            if raw_title in TITLE_FIX:
                want["title"] = TITLE_FIX[raw_title]
            elif raw_title != (a.get("title") or [""])[0]:
                want["title"] = raw_title  # strips stray leading/trailing space
            if raw_artist in ARTIST_FIX:
                want["artist"] = ARTIST_FIX[raw_artist]
            if g(a, "compilation") != "1":
                want["compilation"] = "1"
            if want:
                out.append((p, a, want))
    return out


def main():
    write = "--write" in sys.argv
    changes = plan()
    print(f"{'WRITING' if write else 'DRY RUN'} — {len(changes)} files\n")
    cur = None
    for p, a, want in changes:
        d = os.path.dirname(p)
        if d != cur:
            cur = d
            print(f"  {os.path.basename(d)}")
        shown = {k: v for k, v in want.items() if k != "compilation"}
        if shown:
            print(f"    {os.path.basename(p)[:52]}")
            for k, v in shown.items():
                print(f"        {k}: {g(a, k)!r} -> {v!r}")
    n_flag = sum(1 for _, _, w in changes if "compilation" in w)
    print(f"\n  + compilation flag set on {n_flag} files")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {p: {k: g(a, k) for k in ("title", "artist", "compilation")} for p, a, _ in changes}
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    ok = 0
    for p, a, want in changes:
        try:
            for k, v in want.items():
                a[k] = v
            a.save()
            ok += 1
        except Exception as e:
            print(f"  FAILED {os.path.basename(p)}: {e}", file=sys.stderr)
    print(f"wrote {ok} files")


if __name__ == "__main__":
    main()
