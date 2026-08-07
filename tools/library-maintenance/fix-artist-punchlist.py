#!/usr/bin/env python3
"""Merge the artist entries flagged by eye, and remove the duplicate tag fields
that were producing two rows for one artist.

Two separate problems:

1. SECONDARY NAME FIELDS. 374 files carry a second artist name in a legacy or
   vendor field alongside the standard one — `album artist` (with a space),
   `album_artist` (underscore), `ARTISTS`, `Discogs_Artist_Name`. Navidrome
   reads them all and joins the values, which is why one file showed as
   "Bob Marley • Bob Marley & The Wailers" and why merging the standard tag
   alone never collapsed the entry. MusicBrainz IDs are deliberately left
   alone — they are identifiers, not display names.

2. NAMES NEEDING A HUMAN. Aliases, side projects and outright junk that no
   heuristic should decide: The Stooges under Iggy Pop, the Mothers under
   Zappa, an asterisk stuck on Foghat.

DRY RUN unless --write. Originals backed up first.
"""
import json
import os
import sys

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/artist-punchlist.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif"}

# old value (matched case-insensitively, trimmed) -> new value
RENAME = {
    "foghat*": "Foghat",
    "the mothers": "Frank Zappa",
    "the mothers of invention": "Frank Zappa",
    "frank zappa , the mothers": "Frank Zappa",
    "frank zappa and the mothers of invention": "Frank Zappa",
    "sentino": "Eels",
    "stills & nash crosby": "Crosby, Stills & Nash",
    "crosby, stills, nash & young": "Crosby, Stills & Nash",
    "the stooges": "Iggy Pop",
    "iggy & the stooges": "Iggy Pop",
    "the night tripper dr. john": "Dr. John",
    "dr. john, the night tripper": "Dr. John",
    "yngwie j. malmsteen’s rising force": "Yngwie J. Malmsteen",
    "yngwie j. malmsteen's rising force": "Yngwie J. Malmsteen",
    "various": "Various Artists",
    "langegan, mark": "Mark Lanegan",
    "big brother & the holding company": "Big Brother & The Holding Company",
    "stevie ray vaughan and double trouble": "Stevie Ray Vaughan & Double Trouble",
    "captain beefheart & his magic band": "Captain Beefheart and The Magic Band",
}

# Field names that carry a *display name* and duplicate the standard tag.
# Anything containing "musicbrainz" is an identifier and is preserved.
DUPE_FIELDS = {"album artist", "album_artist", "artists", "discogs_artist_name",
               "albumartists", "artist_credit", "performer"}


def is_dupe_field(key):
    k = key.lower()
    if "musicbrainz" in k or k.startswith("priv:"):
        return False
    k = k.split(":")[-1].strip().lower()
    return k in DUPE_FIELDS


def main():
    write = "--write" in sys.argv
    plan = []

    for root, dirs, files in os.walk(MUSIC):
        if "lost+found" in root:
            continue
        for f in files:
            if f.startswith(".") or os.path.splitext(f)[1].lower() not in AUD:
                continue
            p = os.path.join(root, f)
            try:
                raw = mutagen.File(p)
                easy = mutagen.File(p, easy=True)
            except Exception:
                continue
            if raw is None or easy is None or not hasattr(raw, "keys"):
                continue

            def g(k):
                v = easy.get(k)
                if isinstance(v, list):
                    v = v[0] if v else ""
                return (v or "").strip()

            aa, ar = g("albumartist"), g("artist")
            new_aa = RENAME.get(aa.lower(), aa)
            new_ar = RENAME.get(ar.lower(), ar)
            strip = [k for k in raw.keys() if is_dupe_field(k)]

            if new_aa != aa or new_ar != ar or strip:
                plan.append((p, aa, new_aa, ar, new_ar, strip))

    renames = [x for x in plan if x[2] != x[1] or x[4] != x[3]]
    strips = [x for x in plan if x[5]]
    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files "
          f"({len(renames)} renamed, {len(strips)} with duplicate fields to strip)\n")

    from collections import Counter
    moves = Counter()
    for _, aa, naa, ar, nar, _ in renames:
        if naa != aa:
            moves[(aa, naa)] += 1
        if nar != ar and (ar, nar) != (aa, naa):
            moves[(ar, nar)] += 1
    for (old, new), n in moves.most_common():
        print(f"  {old!r} -> {new!r}   ({n} files)")

    sf = Counter()
    for _, _, _, _, _, s in strips:
        for k in s:
            sf[k.split(":")[-1]] += 1
    if sf:
        print("\n  duplicate fields to remove:")
        for k, n in sf.most_common():
            print(f"    {n:>4}  {k!r}")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {}
    for p, aa, _, ar, _, s in plan:
        backup[p] = {"albumartist": aa, "artist": ar, "stripped": s}
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    n = 0
    for p, aa, naa, ar, nar, strip in plan:
        try:
            raw = mutagen.File(p)
            for k in strip:
                if k in raw:
                    del raw[k]
            if strip:
                raw.save()
            if naa != aa or nar != ar:
                e = mutagen.File(p, easy=True)
                if naa:
                    e["albumartist"] = naa
                if nar:
                    e["artist"] = nar
                e.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
