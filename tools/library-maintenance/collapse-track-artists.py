#!/usr/bin/env python3
"""Make the track `artist` tag agree with the folder's canonical artist.

Subsonic clients build their artist list from track artists as well as
albumartists, so anything sitting in `artist` becomes a browsable entry. That is
why the phone shows ~1,478 artists against ~517 real ones: every collaboration
credit ("Bob Marley & The Wailers", "Black Sabbath featuring Tony Iommi") and
every uploader handle left in a rip ("ACCFsuperfabian1020", "bobglickman",
"iMet87") gets its own row.

This sets both tags to the folder's canonical name so one artist means one
entry. The cost is real and worth stating: the collaboration credit is lost
from the tags. It usually survives in the album title anyway — Live Rust and
Ragged Glory are self-evidently Crazy Horse records.

PROTECTED, never touched:
  * anything under Various Artists/
  * any album flagged compilation=1
  * folders whose tracks are genuinely by many different artists (a tribute
    record, a mixtape) — detected by the spread of artist values

DRY RUN unless --write. Originals are backed up to JSON first.
"""
import json
import os
import re
import sys
import unicodedata
from collections import Counter

import mutagen

MUSIC = "/media/MUSIC"
BACKUP = "/home/todd/navidrome-trial/backups/collapse-track-artists.json"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif"}
SKIP_TOP = {"lost+found", "Playlists", "Various Artists"}


def g(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def norm(s):
    # Fold diacritics, or "Blue Öyster Cult" and "Blue Oyster Cult" read as two
    # different artists — as do Amon Düül II and Amon Duul.
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
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


def main():
    write = "--write" in sys.argv
    plan, protected = [], []

    for top in sorted(os.listdir(MUSIC)):
        base = os.path.join(MUSIC, top)
        if not os.path.isdir(base) or top in SKIP_TOP:
            continue

        files = []
        for root, dirs, fs in os.walk(base):
            for f in fs:
                if f.startswith(".") or os.path.splitext(f)[1].lower() not in AUD:
                    continue
                files.append(os.path.join(root, f))
        if not files:
            continue

        tags = {}
        aa_votes, comp = Counter(), 0
        for p in files:
            try:
                a = mutagen.File(p, easy=True)
            except Exception:
                continue
            if a is None:
                continue
            tags[p] = (g(a, "albumartist"), g(a, "artist"), g(a, "compilation"))
            if tags[p][0]:
                aa_votes[tags[p][0]] += 1
            if tags[p][2] == "1":
                comp += 1
        if not tags:
            continue

        # A folder that is mostly flagged as a compilation keeps its per-track
        # artists — that is the whole point of a various-artists record.
        if comp > len(tags) * 0.5:
            protected.append((top, "compilation flag", len(tags)))
            continue

        if not aa_votes:
            protected.append((top, "no albumartist to canonicalise on", len(tags)))
            continue
        # Prefer a natural "First Last" spelling over the "Last, First" filing
        # form, even when the latter is more common in the tags.
        ranked = aa_votes.most_common()
        canonical = ranked[0][0]
        # "Various" is a filing placeholder, not an artist.
        if canonical.strip().lower() in ("various", "various artists", "unknown artist"):
            protected.append((top, f"canonical would be {canonical!r}", len(tags)))
            continue
        if "," in canonical:
            swapped = next((n for n, _ in ranked
                            if "," not in n and norm(n) == norm(canonical)), None)
            if swapped:
                canonical = swapped
            else:
                # No natural spelling in the tags — derive it. "Isbell, Jason"
                # becomes "Jason Isbell"; the filing form stays in the folder
                # name, where it belongs.
                last, first = canonical.split(",", 1)
                if first.strip():
                    canonical = f"{first.strip()} {last.strip()}"

        # Protection is judged PER ALBUM, not per folder: a tribute record or a
        # split single lives inside an artist folder but is genuinely by other
        # bands. Nativity in Black sits under Black Sabbath; Tad tracks sit
        # under Melvins. Folder-level checks miss both.
        by_album = {}
        for p, v in tags.items():
            by_album.setdefault(os.path.dirname(p), {})[p] = v

        for adir, entries in by_album.items():
            arts = Counter(v[1] for v in entries.values() if v[1])
            unrelated = sum(n for name, n in arts.items()
                            if norm(canonical) not in norm(name)
                            and norm(name) not in norm(canonical))
            # More than half the album is by someone unrelated -> leave it alone.
            if arts and unrelated > len(entries) * 0.5:
                protected.append((os.path.relpath(adir, MUSIC),
                                  f"{len(arts)} artists, mostly not {canonical!r}",
                                  len(entries)))
                continue
            for p, (aa, ar, _) in entries.items():
                # An individual track by a clearly different artist inside an
                # otherwise-normal album is a guest credit — leave it too.
                if ar and norm(canonical) not in norm(ar) and norm(ar) not in norm(canonical):
                    continue
                if aa != canonical or ar != canonical:
                    plan.append((p, canonical, aa, ar))

    folders = len({os.path.relpath(p, MUSIC).split(os.sep)[0] for p, _, _, _ in plan})
    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} files across {folders} folders\n")

    by_top = {}
    for p, canon, aa, ar in plan:
        top = os.path.relpath(p, MUSIC).split(os.sep)[0]
        by_top.setdefault(top, (canon, Counter()))[1][ar or "(empty)"] += 1
    for top in sorted(by_top):
        canon, olds = by_top[top]
        shown = ", ".join(f"{k!r}×{v}" for k, v in olds.most_common(4))
        print(f"  {top}  ->  {canon!r}")
        print(f"      was: {shown}")

    if protected:
        print(f"\n  PROTECTED — left alone ({len(protected)}):")
        for t, why, n in protected:
            print(f"    {t[:40]:<42} {n:>4} tracks  — {why}")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {p: {"albumartist": aa, "artist": ar} for p, _, aa, ar in plan}
    os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
    with open(BACKUP, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {BACKUP}")

    n = 0
    for p, canon, _, _ in plan:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartist"] = canon
            a["artist"] = canon
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
