#!/usr/bin/env python3
"""File audio sitting loose at the root of an artist folder into a proper album
subfolder, named from the album tag.

Two shapes:

  Normal artist   Artist/*.mp3            ->  Artist/<Album>/*.mp3
  Compilation     'V.A. - Foo (1980)/*'   ->  Various Artists/<Album>/*

The compilation case matters because Allegory derives the artist name from the
TOP-LEVEL folder, so a compilation parked at the root currently shows up as an
artist called "V.A. - Metal Explosion [Compilation] (1980)". Moving it under
Various Artists/ matches the albumartist tag those tracks already carry.

Only moves when every file in the folder agrees on the album name. DRY RUN
unless --write.
"""
import os
import re
import shutil
import sys
from collections import Counter

import mutagen

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

AUD = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aiff"}
VARIOUS = "Various Artists"
SKIP_TOP = {"lost+found", "Playlists"}


def safe(s):
    return re.sub(r'[/\\:*?"<>|]', "-", s).strip().rstrip(".")


def main():
    write = "--write" in sys.argv
    plan, skips = [], []

    for d in sorted(os.listdir(MUSIC)):
        base = os.path.join(MUSIC, d)
        if not os.path.isdir(base) or d in SKIP_TOP:
            continue
        loose = [f for f in os.listdir(base)
                 if os.path.isfile(os.path.join(base, f))
                 and os.path.splitext(f)[1].lower() in AUD]
        if not loose:
            continue

        albums = Counter()
        for f in loose:
            try:
                a = mutagen.File(os.path.join(base, f), easy=True)
            except Exception:
                a = None
            albums[((a.get("album") or [""])[0] if a else "").strip()] += 1
        if len(albums) != 1 or not list(albums)[0]:
            skips.append((d, dict(albums)))
            continue

        album = safe(list(albums)[0])
        is_comp = d.lower().startswith(("v.a.", "va -", "various"))
        dest_dir = os.path.join(MUSIC, VARIOUS, album) if is_comp else os.path.join(base, album)

        # Artwork travels with the album; dotfiles do not. `.allegory-artist.json`
        # is per-ARTIST metadata and has to stay at the artist root.
        files = loose + [f for f in os.listdir(base)
                         if os.path.isfile(os.path.join(base, f))
                         and f not in loose and not f.startswith(".")]
        plan.append((base, dest_dir, files, is_comp))

    print(f"{'APPLYING' if write else 'DRY RUN'} — {len(plan)} folders\n")
    for base, dest, files, is_comp in plan:
        kind = "COMPILATION" if is_comp else "artist"
        print(f"  [{kind}] {os.path.relpath(base, MUSIC)}")
        print(f"      {len(files)} files -> {os.path.relpath(dest, MUSIC)}")
    if skips:
        print("\n  SKIPPED — files disagree on album name:")
        for d, albums in skips:
            print(f"    {d}: {albums}")

    if not write:
        print("\nNothing moved. Re-run with --write.")
        return

    moved = 0
    for base, dest, files, is_comp in plan:
        os.makedirs(dest, exist_ok=True)
        for f in files:
            src = os.path.join(base, f)
            dst = os.path.join(dest, f)
            if os.path.exists(dst):
                continue
            try:
                shutil.move(src, dst)
                moved += 1
            except OSError as e:
                print(f"  FAILED {f}: {e}", file=sys.stderr)
        # A compilation folder should disappear once emptied.
        if is_comp:
            try:
                if not os.listdir(base):
                    os.rmdir(base)
                    print(f"  removed empty top-level folder: {os.path.relpath(base, MUSIC)}")
            except OSError:
                pass
    print(f"\n  moved {moved} files")


if __name__ == "__main__":
    main()
