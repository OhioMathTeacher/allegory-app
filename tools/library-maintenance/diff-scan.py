#!/usr/bin/env python3
"""Diff Allegory's tags-cache index against Navidrome's scan.

Answers the question that decides the architecture: does Navidrome read this
library the same way Allegory does? Reports coverage gaps and, more importantly,
naming disagreements that would break the curation/ join.
"""
import json
import os
import sqlite3
import sys
from collections import defaultdict

ALLEGORY = "/home/todd/Repos/allegory-app/.allegory-cache/tags-cache.json"
NAVI_DB = "/home/todd/navidrome-trial/data/navidrome.db"
MUSIC = "/media/MUSIC"
CURATION = "/home/todd/Repos/allegory-app/curation"


def load_allegory():
    with open(ALLEGORY) as f:
        raw = json.load(f)
    tracks = {}
    for path, meta in raw.items():
        rel = os.path.relpath(path, MUSIC)
        tracks[rel] = meta
    return tracks


def load_navidrome():
    con = sqlite3.connect(f"file:{NAVI_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cols = {r[1] for r in con.execute("PRAGMA table_info(media_file)")}
    # Navidrome has moved this column around across versions; probe for it.
    artist_col = next((c for c in ("artist", "album_artist") if c in cols), None)
    rows = con.execute(f"SELECT path, title, album, {artist_col} AS artist FROM media_file").fetchall()
    con.close()

    tracks = {}
    for r in rows:
        p = r["path"]
        rel = os.path.relpath(p, MUSIC) if p.startswith(MUSIC) else p
        tracks[rel] = {"artist": r["artist"], "album": r["album"], "title": r["title"]}
    return tracks


def folder_artist(rel):
    """Top-level folder name — how curation/ keys its entries."""
    return rel.split(os.sep)[0]


def main():
    if not os.path.exists(NAVI_DB):
        sys.exit(f"Navidrome DB not found at {NAVI_DB} — has the scan run?")

    alg = load_allegory()
    nav = load_navidrome()

    print("=" * 66)
    print("COVERAGE")
    print("=" * 66)
    print(f"  Allegory tracks:  {len(alg):>6}")
    print(f"  Navidrome tracks: {len(nav):>6}")

    only_alg = set(alg) - set(nav)
    only_nav = set(nav) - set(alg)
    both = set(alg) & set(nav)
    print(f"  In both:          {len(both):>6}")
    print(f"  Allegory only:    {len(only_alg):>6}  (Navidrome missed these)")
    print(f"  Navidrome only:   {len(only_nav):>6}  (Allegory missed these)")

    if only_alg:
        print("\n  Sample missed by Navidrome:")
        for p in sorted(only_alg)[:8]:
            print(f"    {p}")
        exts = defaultdict(int)
        for p in only_alg:
            exts[os.path.splitext(p)[1].lower()] += 1
        print(f"  By extension: {dict(sorted(exts.items(), key=lambda x: -x[1]))}")

    if only_nav:
        print("\n  Sample missed by Allegory:")
        for p in sorted(only_nav)[:8]:
            print(f"    {p}")

    print()
    print("=" * 66)
    print("TAG DISAGREEMENTS  (same file, different reading)")
    print("=" * 66)
    diff_artist, diff_album = [], []
    for p in both:
        a, n = alg[p], nav[p]
        if (a.get("artist") or "").strip() != (n.get("artist") or "").strip():
            diff_artist.append((p, a.get("artist"), n.get("artist")))
        if (a.get("album") or "").strip() != (n.get("album") or "").strip():
            diff_album.append((p, a.get("album"), n.get("album")))

    pct_a = 100 * len(diff_artist) / max(len(both), 1)
    pct_b = 100 * len(diff_album) / max(len(both), 1)
    print(f"  Artist differs: {len(diff_artist):>6}  ({pct_a:.1f}%)")
    print(f"  Album differs:  {len(diff_album):>6}  ({pct_b:.1f}%)")

    for label, rows in (("ARTIST", diff_artist), ("ALBUM", diff_album)):
        if rows:
            print(f"\n  {label} — sample:")
            for p, av, nv in sorted(rows)[:10]:
                print(f"    {p}")
                print(f"        allegory={av!r}")
                print(f"        navidrome={nv!r}")

    print()
    print("=" * 66)
    print("CURATION JOIN  (folder name -> Navidrome artist)")
    print("=" * 66)
    folder_to_nav = defaultdict(set)
    for p, n in nav.items():
        folder_to_nav[folder_artist(p)].add(n.get("artist"))

    if os.path.isdir(CURATION):
        curated = [d for d in os.listdir(CURATION) if os.path.isdir(os.path.join(CURATION, d))]
        print(f"  {len(curated)} curated artists\n")
        for c in sorted(curated):
            names = folder_to_nav.get(c)
            if not names:
                print(f"  {c:<32} -> NO MATCH (folder absent from Navidrome)")
            else:
                shown = sorted(x for x in names if x)[:3]
                exact = c in names
                mark = "exact" if exact else "DIFFERS"
                print(f"  {c:<32} -> {mark}: {shown}")
    else:
        print(f"  curation dir not found at {CURATION}")

    print()
    print("=" * 66)
    print("VERDICT")
    print("=" * 66)
    cov = 100 * len(both) / max(len(alg), 1)
    print(f"  Track coverage: {cov:.2f}% of Allegory's index found by Navidrome")
    if cov > 99.5 and pct_a < 1:
        print("  -> Navidrome reads this library essentially the same way.")
    elif cov > 97:
        print("  -> Close, but check the gaps above before trusting it as source of truth.")
    else:
        print("  -> Material disagreement. Do NOT make Navidrome authoritative yet.")


if __name__ == "__main__":
    main()
