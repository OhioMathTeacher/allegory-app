#!/usr/bin/env python3
"""Remove dead albums outright, and dead files from otherwise-healthy folders.

Two explicit lists rather than heuristics, because this deletes real playable
audio and a wrong guess is unrecoverable:

  PURGE_TREE   folders removed entirely. Either every audio track is dead, or
               the user chose to drop the surviving fragment and re-acquire.
  FILES_ONLY   healthy folders that merely contain zero-byte artwork; only the
               dead files go, the music stays.

Note `Shudder to Think` is NOT a tree purge — its root holds only junk images
but its subfolders contain the actual (intact) albums.
"""
import os
import shutil
import sys

MUSIC = "/media/MUSIC"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".wma", ".aac"}

PURGE_TREE = [
    # every audio track dead
    "Black Sabbath/Forbidden",
    "Linkin Park/From Zero",
    "Melvins/1991 Bullhead",
    "Melvins/1992DC/DC",
    "Wussy/Wussy - 2016 - Forever Sounds - Flac",
    # surviving fragments dropped by choice
    "Melvins/1989Oz",
    "Wussy/Wussy - 2005 - Funeral Dress - Flac",
    "Wussy/Wussy - 2018 - What Heaven Is Like - Flac",
    "Wussy/Wussy - 2014 - Attica! - Flac",
]

FILES_ONLY = [
    "Cars/Panorama",
    "Incubus/incubus-monuments-and-melodies",
    "Sweet, Matthew/Altered Beast",
    "Shudder to Think",
    "Shudder to Think/Curses, Spells, Voodoo, Mooses",
    "Shudder to Think/Funeral at the Movies",
    "Shudder to Think/Get Your Goat",
]


def is_dead(p):
    if os.path.getsize(p) == 0:
        return True
    with open(p, "rb") as f:
        while True:
            b = f.read(65536)
            if not b:
                return True
            if b.count(0) != len(b):
                return False


def main():
    go = "--delete" in sys.argv
    tree_files = tree_audio = tree_bytes = 0
    print("PURGE ENTIRE FOLDER")
    for rel in PURGE_TREE:
        d = os.path.join(MUSIC, rel)
        if not os.path.isdir(d):
            print(f"  MISSING: {rel}")
            continue
        n = a = b = 0
        for root, _, files in os.walk(d):
            for f in files:
                p = os.path.join(root, f)
                n += 1
                b += os.path.getsize(p)
                if os.path.splitext(f)[1].lower() in AUD:
                    a += 1
        tree_files += n
        tree_audio += a
        tree_bytes += b
        print(f"  {n:>3} files ({a} audio, {b/1e6:.0f} MB)   {rel}")

    print("\nDEAD FILES ONLY (music kept)")
    singles = []
    for rel in FILES_ONLY:
        d = os.path.join(MUSIC, rel)
        if not os.path.isdir(d):
            print(f"  MISSING: {rel}")
            continue
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if os.path.isfile(p) and is_dead(p):
                singles.append(p)
                print(f"  {rel}/{f}")

    print(f"\n  folders removed:     {len(PURGE_TREE)}")
    print(f"  files in those:      {tree_files}  ({tree_audio} audio, {tree_bytes/1e6:.0f} MB)")
    print(f"  loose dead files:    {len(singles)}")
    print(f"  TOTAL deleted:       {tree_files + len(singles)} files")

    if not go:
        print("\nDRY RUN. Pass --delete to execute.")
        return

    for rel in PURGE_TREE:
        d = os.path.join(MUSIC, rel)
        if os.path.isdir(d):
            shutil.rmtree(d)
            print(f"  removed tree: {rel}")
    for p in singles:
        try:
            os.remove(p)
        except OSError as e:
            print(f"  FAILED {p}: {e}", file=sys.stderr)
    print(f"  removed {len(singles)} loose files")

    # Tidy up artist folders left empty by the purge.
    for rel in PURGE_TREE:
        parent = os.path.dirname(os.path.join(MUSIC, rel))
        try:
            if os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent)
                print(f"  removed now-empty folder: {os.path.relpath(parent, MUSIC)}")
        except OSError:
            pass


if __name__ == "__main__":
    main()
