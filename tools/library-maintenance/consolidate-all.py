#!/usr/bin/env python3
"""Collapse every artist folder that names more than one albumartist, using the
same approach that worked for Neil Young.

Each variant in a folder is classified, and only the first two classes are ever
rewritten:

  VARIANT       same artist, different spelling — "Cure, The" vs "The Cure",
                "Alice In Chains" vs "Alice in Chains". Rewritten to canonical.
  COLLAB        a credit containing the canonical name — "Neil Young & Crazy
                Horse". albumartist becomes canonical so the artist stops
                splitting; the full credit moves to the track artist so the
                collaboration is not lost.
  UNRELATED     a genuinely different artist sitting in this folder (a stray
                track, or "Various" on a tribute record). NEVER touched —
                reported for you to move or retag by hand.

The canonical name is the variant with the most tracks, excluding collabs.
DRY RUN unless --write. Originals are always backed up first.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/consolidate-all.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".wma", ".aac"}

# Not artist folders. `lost+found` is ext4's fsck recovery directory that
# happens to sit at the root of the music drive.
EXCLUDE_FOLDERS = {"lost+found", "Playlists", "Live Albums"}

# Majority rule picks the wrong spelling in these folders — all-caps, a dropped
# apostrophe, or the "Last, First" form winning on count alone.
CANONICAL_OVERRIDE = {
    "Smiths, The": "The Smiths",
    "King's X": "King's X",
    "Walsh, Joe": "Joe Walsh",
    "Desert Sessions": "The Desert Sessions",
    "Corrosion Of Conformity": "Corrosion of Conformity",
}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def norm(s):
    """Fold spelling differences: case, punctuation, leading/trailing 'The',
    and the "Last, First" convention."""
    s = (s or "").lower().strip()
    s = re.sub(r"[^\w\s,]", "", s)
    if s.startswith("the "):
        s = s[4:]
    if s.endswith(", the"):
        s = s[:-5]
    if "," in s:  # "young, neil" -> "neil young"
        parts = [p.strip() for p in s.split(",", 1)]
        if len(parts) == 2 and parts[1]:
            s = f"{parts[1]} {parts[0]}"
    return re.sub(r"\s+", " ", s).strip()


def classify(variant, canonical):
    if norm(variant) == norm(canonical):
        return "VARIANT"
    nv, nc = norm(variant), norm(canonical)
    if nc and (nv.startswith(nc + " ") or f" {nc} " in f" {nv} "):
        return "COLLAB"
    return "UNRELATED"


def scan():
    """folder -> {albumartist: [paths]}"""
    folders = defaultdict(lambda: defaultdict(list))
    for root, dirs, files in os.walk(MUSIC):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.startswith(".") or os.path.splitext(f)[1].lower() not in AUD:
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, MUSIC)
            if os.sep not in rel:
                continue
            top = rel.split(os.sep)[0]
            if top in EXCLUDE_FOLDERS:
                continue
            try:
                a = mutagen.File(p, easy=True)
            except Exception:
                continue
            if a is None:
                continue
            aa = g(a, "albumartist") or g(a, "artist")
            if aa:
                folders[top][aa].append(p)
    return folders


def main():
    write = "--write" in sys.argv
    print("Reading tags — a few minutes...", flush=True)
    folders = scan()

    multi = {f: v for f, v in folders.items() if len(v) > 1}
    print(f"\n{len(multi)} of {len(folders)} folders name more than one albumartist\n")

    plan, unrelated_report = [], []
    for folder in sorted(multi):
        variants = multi[folder]
        counts = Counter({k: len(v) for k, v in variants.items()})
        # canonical = biggest variant that isn't itself a collab of another
        ranked = counts.most_common()
        canonical = ranked[0][0]
        for name, _ in ranked:
            if all(classify(name, other) != "COLLAB" for other, _ in ranked if other != name):
                canonical = name
                break
        if folder in CANONICAL_OVERRIDE:
            canonical = CANONICAL_OVERRIDE[folder]

        rows = []
        for name, paths in variants.items():
            kind = "CANONICAL" if name == canonical else classify(name, canonical)
            rows.append((kind, name, paths))
        if not any(k in ("VARIANT", "COLLAB") for k, _, _ in rows):
            for k, n, p in rows:
                if k == "UNRELATED":
                    unrelated_report.append((folder, n, len(p)))
            continue

        print(f"  {folder}   -> {canonical!r}")
        for kind, name, paths in sorted(rows, key=lambda r: -len(r[2])):
            mark = {"CANONICAL": "  keep ", "VARIANT": "  fix  ",
                    "COLLAB": " collab", "UNRELATED": "  SKIP "}[kind]
            print(f"    {mark} {len(paths):>4}  {name!r}")
            if kind == "VARIANT":
                for p in paths:
                    plan.append((p, canonical, None))
            elif kind == "COLLAB":
                for p in paths:
                    plan.append((p, canonical, name))
            elif kind == "UNRELATED":
                unrelated_report.append((folder, name, len(paths)))

    print(f"\n  {len(plan)} files to rewrite")
    if unrelated_report:
        print(f"\n  LEFT ALONE — different artist in the folder ({len(unrelated_report)}):")
        for folder, name, n in sorted(unrelated_report):
            print(f"    {folder:<38} {n:>4} tracks as {name!r}")

    if not write:
        print("\nDRY RUN. Pass --write to apply.")
        return

    backup = {}
    for p, _, _ in plan:
        try:
            a = mutagen.File(p, easy=True)
            backup[p] = {"albumartist": g(a, "albumartist"), "artist": g(a, "artist")}
        except Exception:
            pass
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    n = 0
    for p, canonical, collab in plan:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartist"] = canonical
            if collab:
                a["artist"] = collab
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
