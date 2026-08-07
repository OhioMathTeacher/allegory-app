#!/usr/bin/env python3
"""Give every track a sort name so artists file under surname, not first name.

`ALBUMARTIST` is what a client displays; `ALBUMARTISTSORT` is what it sorts on.
Setting the pair means "Neil Young" still reads as Neil Young but files under Y.

The sort key comes from the FOLDER NAME, because that is already the convention
in this library — people are filed "Young, Neil" and "Cave, Nick & The Bad
Seeds", bands are filed plainly. So the user's own filing becomes the sort
order, and nothing has to guess whether a name belongs to a person or a band.

The one transform applied on top: a folder starting with "The " sorts without
it, so "The Doors" files under D.

DRY RUN unless --write. Originals backed up first.
"""
import json
import os
import sys

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/sort-names.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif"}
SKIP_TOP = {"lost+found", "Playlists"}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def sort_key(folder):
    f = folder.strip()
    if f.lower().startswith("the "):
        return f"{f[4:].strip()}, The"
    return f


def main():
    write = "--write" in sys.argv
    plan, samples = [], []

    for top in sorted(os.listdir(MUSIC)):
        base = os.path.join(MUSIC, top)
        if not os.path.isdir(base) or top in SKIP_TOP:
            continue
        key = sort_key(top)
        changed = 0
        for root, dirs, files in os.walk(base):
            for f in files:
                if f.startswith(".") or os.path.splitext(f)[1].lower() not in AUD:
                    continue
                p = os.path.join(root, f)
                try:
                    a = mutagen.File(p, easy=True)
                except Exception:
                    continue
                if a is None:
                    continue
                if g(a, "albumartistsort") != key or g(a, "artistsort") != key:
                    plan.append((p, key))
                    changed += 1
        if changed:
            try:
                a = mutagen.File(plan[-1][0], easy=True)
                disp = g(a, "albumartist") or g(a, "artist")
            except Exception:
                disp = "?"
            samples.append((top, disp, key, changed))

    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files across {len(samples)} folders\n")
    print(f"  {'displays as':<34} {'sorts under':<30}")
    print("  " + "-" * 66)
    for top, disp, key, n in samples[:28]:
        print(f"  {disp[:33]:<34} {key[:29]:<30} ({n})")
    if len(samples) > 28:
        print(f"  ... and {len(samples)-28} more folders")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {}
    for p, _ in plan:
        try:
            a = mutagen.File(p, easy=True)
            backup[p] = {"albumartistsort": g(a, "albumartistsort"),
                         "artistsort": g(a, "artistsort")}
        except Exception:
            pass
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    n = 0
    for p, key in plan:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartistsort"] = key
            a["artistsort"] = key
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
