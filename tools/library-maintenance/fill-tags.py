#!/usr/bin/env python3
"""Propose album/albumartist tags for files that are missing them, derived from
the folder structure Allegory already trusts.

DRY RUN BY DEFAULT — writes nothing unless --write is passed, and --write always
saves the originals to a JSON backup first.

Rules that keep this from making things worse:

  1. Never overwrite. Only fills a tag that is absent or empty.
  2. The canonical artist name comes from the artist folder's EXISTING tags,
     not the folder name. The convention here is "Last, First" (`Costello,
     Elvis`) while the tags mostly say "Elvis Costello" — writing folder names
     would deepen the artist-split problem instead of fixing it. Each artist
     folder votes on its own spelling; the folder name is a last resort, and
     the two folders with no tags to learn from are named explicitly below.
  3. Album folders carrying release years get them stripped. Four folders whose
     names are too cryptic to decode are skipped rather than guessed at.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

import mutagen

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

NAVIDROME_DIR = os.environ.get(
    "NAVIDROME_DIR", os.path.expanduser("~/navidrome-trial")
)

BACKUP_DIR = os.environ.get(
    "ALLEGORY_BACKUP_DIR", os.path.expanduser("~/navidrome-trial/backups")
)

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".oga",
              ".wav", ".aac", ".wma", ".aiff", ".aif", ".alac"}

# Folders with no existing tag to learn from — the vote can't help, so the
# correct spelling is stated outright rather than falling back to "Last, First".
CANONICAL_OVERRIDE = {
    "James, Rick": "Rick James",
    "Zombies, The": "The Zombies",
}

# Folder names that encode the album too cryptically to derive a title from.
# These keep their missing album tag; name them by hand later.
ALBUM_SKIP = {
    "04HUM(1993)",
    "02PUMPK(1989)",
    "0243_big_star_1_record_1972__mlib",
    "0594_the_sisters_of_mercy_floodland_1987__mlib",
}

# Same folding rules as allegory-app/server/scanner.ts
CD_SUBDIR = re.compile(r"^(?:(?:cd|dis[ck])[\s._-]*\d+|\d+)$|^(?:cd|dis[ck])[\s._-]*\d+", re.I)
JUNK_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f​-‍﻿-]")
YEAR_PREFIX = re.compile(r"^\s*[\(\[]?(?:19|20)\d{2}[\)\]]?\s*[-–_]*\s*")
YEAR_SUFFIX = re.compile(r"\s*[\(\[]?(?:19|20)\d{2}[\)\]]?\s*$")


def clean(s):
    if not s:
        return ""
    return re.sub(r"\s{2,}", " ", JUNK_CHARS.sub("", s)).strip()


def normalize_album(folder_name, artist):
    """Strip a leading 'Artist - ' and any surrounding release year."""
    n = clean(folder_name)
    if artist and n.lower().startswith(artist.lower() + " - "):
        n = n[len(artist) + 3:]
    n = YEAR_PREFIX.sub("", n)
    n = YEAR_SUFFIX.sub("", n)
    return n.strip(" -_") or clean(folder_name)


def tag_get(audio, key):
    try:
        v = audio.get(key)
    except Exception:
        return ""
    if not v:
        return ""
    if isinstance(v, list):
        v = v[0] if v else ""
    return clean(str(v))


def walk_audio():
    for root, dirs, files in os.walk(MUSIC):
        dirs[:] = [d for d in dirs if d != "Playlists" and not d.startswith(".")]
        for f in files:
            if f.startswith("._"):
                continue
            if os.path.splitext(f)[1].lower() in AUDIO_EXTS:
                yield os.path.join(root, f)


def artist_folder(path):
    return os.path.relpath(path, MUSIC).split(os.sep)[0]


def album_folder(path):
    d = os.path.dirname(path)
    if CD_SUBDIR.match(os.path.basename(d)):
        d = os.path.dirname(d)
    return d


def read_all(cache_path):
    if cache_path and os.path.exists(cache_path):
        print(f"reusing tag cache {cache_path}")
        with open(cache_path) as f:
            return json.load(f)
    print("Reading tags from every file — a few minutes over USB...", flush=True)
    existing = {}
    files = sorted(walk_audio())
    for n, p in enumerate(files, 1):
        if n % 2000 == 0:
            print(f"  ...{n}/{len(files)}", flush=True)
        try:
            a = mutagen.File(p, easy=True)
        except Exception:
            a = None
        existing[p] = None if a is None else {
            "album": tag_get(a, "album"),
            "albumartist": tag_get(a, "albumartist"),
            "artist": tag_get(a, "artist"),
        }
    if cache_path:
        with open(cache_path, "w") as f:
            json.dump(existing, f)
    return existing


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--backup", default=os.path.join(BACKUP_DIR, "fill-tags.json"))
    ap.add_argument("--cache", default=os.path.join(NAVIDROME_DIR, "tag-read.cache.json"))
    ap.add_argument("--restore", action="store_true")
    args = ap.parse_args()

    if args.restore:
        with open(args.backup) as f:
            saved = json.load(f)
        n = 0
        for p, tags in saved.items():
            try:
                a = mutagen.File(p, easy=True)
                for k, v in tags.items():
                    if v:
                        a[k] = v
                    elif k in a:
                        del a[k]
                a.save()
                n += 1
            except Exception as e:
                print(f"  FAILED {p}: {e}", file=sys.stderr)
        print(f"restored {n} files")
        return

    existing = read_all(args.cache)

    votes = defaultdict(Counter)
    for p, t in existing.items():
        if not t:
            continue
        name = t["albumartist"] or t["artist"]
        if name:
            votes[artist_folder(p)][name] += 1
    canonical = {f: c.most_common(1)[0][0] for f, c in votes.items()}
    canonical.update(CANONICAL_OVERRIDE)

    proposals, skipped_cryptic, needs_review = defaultdict(list), set(), []
    for p, t in existing.items():
        if t is None:
            continue
        af = artist_folder(p)
        name = canonical.get(af) or clean(af)
        want = {}
        if not t["albumartist"]:
            want["albumartist"] = name
        if not t["album"]:
            adir = album_folder(p)
            bn = os.path.basename(adir)
            if os.path.normpath(adir) == os.path.normpath(os.path.join(MUSIC, af)):
                needs_review.append(adir)
                continue
            if bn in ALBUM_SKIP:
                skipped_cryptic.add(adir)
            else:
                want["album"] = normalize_album(bn, name)
        if want:
            proposals[album_folder(p)].append((p, want))

    total = sum(len(v) for v in proposals.values())
    print()
    print("=" * 74)
    print(("WRITING" if args.write else "DRY RUN — nothing written") +
          f"   {total} files across {len(proposals)} folders")
    print("=" * 74)
    for adir in sorted(proposals):
        items = proposals[adir]
        s = items[0][1]
        print(f"  {os.path.relpath(adir, MUSIC)}   ({len(items)} files)")
        if "albumartist" in s:
            print(f"      albumartist -> {s['albumartist']!r}")
        if "album" in s:
            orig = os.path.basename(adir)
            note = "" if s["album"] == clean(orig) else f"   (from folder {orig!r})"
            print(f"      album       -> {s['album']!r}{note}")

    if skipped_cryptic:
        print(f"\n  SKIPPED — folder name too cryptic to decode ({len(skipped_cryptic)}):")
        for d in sorted(skipped_cryptic):
            print(f"      {os.path.relpath(d, MUSIC)}")
    if needs_review:
        print(f"\n  SKIPPED — no album folder ({len(set(needs_review))}):")
        for d in sorted(set(needs_review)):
            print(f"      {os.path.relpath(d, MUSIC)}")

    if not args.write:
        print("\nNothing written. Re-run with --write.")
        return

    backup = {}
    for adir, items in proposals.items():
        for p, _ in items:
            t = existing[p]
            backup[p] = {"album": t["album"], "albumartist": t["albumartist"]}
    os.makedirs(os.path.dirname(args.backup), exist_ok=True)
    with open(args.backup, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {args.backup}")

    wrote = 0
    for adir, items in proposals.items():
        for p, want in items:
            try:
                a = mutagen.File(p, easy=True)
                for k, v in want.items():
                    a[k] = v
                a.save()
                wrote += 1
            except Exception as e:
                print(f"  FAILED {os.path.relpath(p, MUSIC)}: {e}", file=sys.stderr)
    print(f"wrote {wrote} files")


if __name__ == "__main__":
    main()
