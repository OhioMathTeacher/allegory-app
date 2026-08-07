#!/usr/bin/env python3
"""Fix three albums whose artist tags are rip artefacts, not real credits.

collapse-track-artists.py protects albums whose tracks are by many different
artists, because that is what a tribute record or compilation looks like. These
three fooled it in different ways, so they are named explicitly rather than
having the heuristic loosened — loosening it would put Nativity in Black and the
Easy Rider soundtrack back at risk.

  Tupelo Honey        albumartist is correct, but all 11 tracks carry a
                      different YouTube uploader handle as the artist, which
                      reads as a various-artists record.
  Korn Greatest Hits  BOTH tags are the uploader handle on every track, so
                      there was no correct value to canonicalise on.
  Built to Destroy    albumartist is an unrelated artist entirely; the artist
                      tag is the band's abbreviation.

DRY RUN unless --write. Originals backed up first.
"""
import json
import os
import sys

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/junk-artist-albums.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".wav"}

FIXES = {
    "Morrison, Van/Tupelo Honey": "Van Morrison",
    "Korn/Greatest Hits Volume 1": "Korn",
    "Schenker, Michael/Built to Destroy": "Michael Schenker Group",
}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def main():
    write = "--write" in sys.argv
    plan = []
    for rel, canonical in FIXES.items():
        d = os.path.join(MUSIC, rel)
        if not os.path.isdir(d):
            print(f"  MISSING: {rel}")
            continue
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if not os.path.isfile(p) or os.path.splitext(f)[1].lower() not in AUD:
                continue
            try:
                a = mutagen.File(p, easy=True)
            except Exception:
                continue
            if a is None:
                continue
            aa, ar = g(a, "albumartist"), g(a, "artist")
            if aa != canonical or ar != canonical:
                plan.append((p, canonical, aa, ar))

    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files\n")
    cur = None
    for p, canon, aa, ar in plan:
        d = os.path.dirname(p)
        if d != cur:
            cur = d
            print(f"  {os.path.relpath(d, MUSIC)}  ->  {canon!r}")
        print(f"      {os.path.basename(p)[:46]:<48} was artist={ar!r}")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {p: {"albumartist": aa, "artist": ar} for p, _, aa, ar in plan}
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)

    n = 0
    for p, canon, _, _ in plan:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartist"] = canon
            a["artist"] = canon
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {p}: {e}", file=sys.stderr)
    print(f"\n  backed up to {BACKUP}\n  wrote {n} files")


if __name__ == "__main__":
    main()
