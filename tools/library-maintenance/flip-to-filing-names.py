#!/usr/bin/env python3
"""Display people by their filing name — "Young, Neil" rather than "Neil Young".

Setting the sort tag alone only helps if the client honours it. Putting the
filing form in the display name itself sorts correctly everywhere, with no
client cooperation required.

Applied narrowly, and only where it is provably safe: the folder name and the
current artist name must be the SAME NAME REORDERED. "Young, Neil" and "Neil
Young" normalise identically, so that flips. "AC_DC" and "AC/DC" do not, so
AC/DC keeps its proper name instead of acquiring an underscore. Bands are
untouched for the same reason — "Melvins" is already "Melvins" either way.

Artists whose folder does not cleanly reorder (Cave, Nick & The Bad Seeds) keep
their display name and rely on the sort tag.

DRY RUN unless --write. Originals backed up first.
"""
import json
import os
import re
import sys
import unicodedata

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/filing-names.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif"}
SKIP_TOP = {"lost+found", "Playlists", "Various Artists"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9,\s]", "", s)
    if s.startswith("the "):
        s = s[4:]
    if s.endswith(", the"):
        s = s[:-5]
    if "," in s:
        a, b = s.split(",", 1)
        if b.strip():
            s = f"{b.strip()} {a.strip()}"
    return re.sub(r"[^a-z0-9]", "", s)


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def main():
    write = "--write" in sys.argv
    plan, skipped = [], []

    for top in sorted(os.listdir(MUSIC)):
        base = os.path.join(MUSIC, top)
        if not os.path.isdir(base) or top in SKIP_TOP:
            continue
        # Only a folder in "Surname, Forename" shape is a candidate.
        if ", " not in top:
            continue
        # "Beatles, The" is a band filed catalogue-style, not a person. The
        # sort tag already files it under B, so leave the display name as
        # "The Beatles" — the request was surnames, not catalogue style.
        if top.lower().endswith(", the"):
            continue

        files = []
        for root, dirs, fs in os.walk(base):
            for f in fs:
                if f.startswith(".") or os.path.splitext(f)[1].lower() not in AUD:
                    continue
                files.append(os.path.join(root, f))
        if not files:
            continue

        try:
            a = mutagen.File(files[0], easy=True)
        except Exception:
            continue
        if a is None:
            continue
        current = g(a, "albumartist") or g(a, "artist")
        if not current:
            continue

        if norm(current) != norm(top):
            skipped.append((top, current))
            continue
        if current == top:
            continue

        for p in files:
            plan.append((p, top, current))

    folders = sorted({(t, c) for _, t, c in plan})
    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files across {len(folders)} artists\n")
    print(f"  {'now displays as':<32} {'will display as':<32}")
    print("  " + "-" * 66)
    for top, cur in folders[:30]:
        print(f"  {cur[:31]:<32} {top[:31]:<32}")
    if len(folders) > 30:
        print(f"  ... and {len(folders)-30} more")

    if skipped:
        print(f"\n  LEFT ALONE — folder is not the same name reordered ({len(skipped)}):")
        for t, c in skipped[:12]:
            print(f"    folder {t!r}  vs artist {c!r}")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {p: {"albumartist": cur} for p, _, cur in plan}
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    n = 0
    for p, top, _ in plan:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartist"] = top
            a["artist"] = top
            a["albumartistsort"] = top
            a["artistsort"] = top
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
