#!/usr/bin/env python3
"""Restore music that ext4's fsck orphaned into /media/MUSIC/lost+found.

Three groups, from a filesystem corruption that emptied album folders in place
while fsck preserved the actual data under recovered inode numbers:

  #8267466   the Melvins collection — 27 albums, 196 tracks, all healthy. The
             live Melvins folder still has the album directories but almost all
             are empty husks, so names line up exactly and this is a clean merge.
  #8259409   Dinosaur Jr — mostly a duplicate of an intact live copy; only
             genuinely missing files get restored.
  #121897xx  15 loose files with no directory entry: a complete Talking Heads
             live album. Rebuilt into a proper album folder, named from tags.

COPIES rather than moves, so lost+found stays intact as a safety net until you
choose to clear it. Never overwrites an existing file.
"""
import os
import re
import shutil
import sys

import mutagen

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

LF = os.path.join(MUSIC, "lost+found")
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aiff"}

TREES = [("#8267466", "Melvins"), ("#8259409", "Dinosaur Jr")]
TH_ALBUM = "Talking Heads/Boarding House San Francisco 1978-09-16"


def safe(s):
    return re.sub(r'[/\\:*?"<>|]', "-", s).strip()


def plan_trees():
    """Audio and artwork only. The .rar files are the original download
    packages; they are not playable and mostly duplicate the extracted audio
    sitting beside them, so they are reported instead of copied."""
    jobs, archives = [], []
    for inode, dest_artist in TREES:
        src_root = os.path.join(LF, inode)
        for root, dirs, files in os.walk(src_root):
            has_audio = any(os.path.splitext(f)[1].lower() in AUD for f in files)
            for f in files:
                if f.startswith("._"):
                    continue
                ext = os.path.splitext(f)[1].lower()
                src = os.path.join(root, f)
                if ext in (".rar", ".zip", ".7z"):
                    archives.append((src, has_audio))
                    continue
                rel = os.path.relpath(src, src_root)
                jobs.append((src, os.path.join(MUSIC, dest_artist, rel)))
    return jobs, archives


def plan_talking_heads():
    jobs = []
    for e in sorted(os.listdir(LF)):
        p = os.path.join(LF, e)
        if os.path.isdir(p) or e.startswith("._"):
            continue
        try:
            a = mutagen.File(p, easy=True)
        except Exception:
            a = None
        if a is None:
            continue
        g = lambda k: (a.get(k) or [""])[0]
        if "talking heads" not in g("artist").lower():
            continue
        num = g("tracknumber").split("/")[0].zfill(2)
        title = safe(g("title")) or e
        # fsck-orphaned files have no extension, and the container is NOT
        # guaranteed to be MP3 — these turned out to be Ogg Vorbis. Navidrome
        # dispatches on the extension, so guessing wrong makes a perfectly
        # playable file scan as [Unknown Album].
        ext = {"OggVorbis": ".ogg", "OggOpus": ".opus", "FLAC": ".flac",
               "MP4": ".m4a", "MP3": ".mp3"}.get(type(mutagen.File(p)).__name__, ".mp3")
        dst = os.path.join(MUSIC, TH_ALBUM, f"{num} {title}{ext}")
        jobs.append((p, dst))
    return jobs


def main():
    write = "--write" in sys.argv
    tree_jobs, archives = plan_trees()
    jobs = tree_jobs + plan_talking_heads()

    todo, skipped = [], []
    for src, dst in jobs:
        (skipped if os.path.exists(dst) else todo).append((src, dst))

    by_dest = {}
    for src, dst in todo:
        d = os.path.dirname(dst)
        by_dest.setdefault(d, []).append(src)

    print(f"{'RESTORING' if write else 'DRY RUN'} — {len(todo)} files to copy, "
          f"{len(skipped)} already present (skipped)\n")
    total = 0
    for d in sorted(by_dest):
        n = len(by_dest[d])
        b = sum(os.path.getsize(s) for s in by_dest[d])
        total += b
        print(f"  {n:>3} files  {b/1e6:>7.0f} MB   {os.path.relpath(d, MUSIC)}")
    print(f"\n  total: {total/1e9:.2f} GB")
    if skipped:
        print(f"\n  skipped (already exist): {len(skipped)}")
        for s, d in skipped[:5]:
            print(f"    {os.path.relpath(d, MUSIC)}")

    orphan_archives = [s for s, has_audio in archives if not has_audio]
    if archives:
        print(f"\n  ARCHIVES not copied: {len(archives)} "
              f"({sum(os.path.getsize(s) for s, _ in archives)/1e9:.2f} GB)")
        if orphan_archives:
            print("  Of those, these have NO extracted audio beside them —")
            print("  the only copy of that album is inside the archive:")
            for s in sorted(orphan_archives):
                print(f"    {os.path.getsize(s)/1e6:>6.0f} MB  {os.path.relpath(s, LF)}")

    if not write:
        print("\nNothing copied. Re-run with --write.")
        return

    ok = 0
    for src, dst in todo:
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            ok += 1
        except OSError as e:
            print(f"  FAILED {os.path.basename(src)}: {e}", file=sys.stderr)
    print(f"\n  copied {ok} files")


if __name__ == "__main__":
    main()
