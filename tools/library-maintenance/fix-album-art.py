#!/usr/bin/env python3
"""Make existing cover art discoverable by naming it cover.jpg.

Navidrome looks for embedded art, then for a folder image named cover / folder /
front / album / albumart. Plenty of albums here have perfectly good artwork
under names it never checks — "A.jpg" (the front of a scanned digipak), "CD.jpg",
"hqdefault-1602920343.jpeg" from a YouTube rip. Nothing needs downloading; the
file just needs a name the scanner recognises.

Also handles disc subfolders: a CD1/CD2 directory with no image of its own
inherits its parent album's cover.

COPIES rather than renames, so the original filenames survive. DRY RUN unless
--write.
"""
import os
import re
import shutil
import sys

MUSIC = "/media/MUSIC"
IMG = {".jpg", ".jpeg", ".png", ".webp"}
STD = ("cover", "folder", "front", "album", "albumart")
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff"}
CD_SUBDIR = re.compile(r"^(?:(?:cd|dis[ck])[\s._-]*\d+|\d+)$", re.I)

# Which image is most likely the front cover, best first. "A" is how these
# scans label the front of a gatefold; "B" is the back.
def rank(name):
    stem = os.path.splitext(name)[0].lower()
    for i, pat in enumerate(("front", "cover", "folder", "a", "a1", "album")):
        if stem == pat:
            return i
    if "front" in stem or "cover" in stem:
        return 6
    return 10


def main():
    write = "--write" in sys.argv
    plan, inherited, hopeless = [], [], []

    for root, dirs, files in os.walk(MUSIC):
        audio = [f for f in files if os.path.splitext(f)[1].lower() in AUD]
        if not audio:
            continue
        imgs = [f for f in files if os.path.splitext(f)[1].lower() in IMG]
        if any(os.path.splitext(f)[0].lower() in STD for f in imgs):
            continue  # already discoverable

        if imgs:
            best = sorted(imgs, key=lambda f: (rank(f),
                                               -os.path.getsize(os.path.join(root, f))))[0]
            plan.append((os.path.join(root, best), os.path.join(root, "cover.jpg")))
            continue

        # No image here — a disc subfolder can borrow its parent's.
        if CD_SUBDIR.match(os.path.basename(root)):
            parent = os.path.dirname(root)
            pimgs = [f for f in os.listdir(parent)
                     if os.path.splitext(f)[1].lower() in IMG] if os.path.isdir(parent) else []
            if pimgs:
                best = sorted(pimgs, key=lambda f: (rank(f),
                                                    -os.path.getsize(os.path.join(parent, f))))[0]
                inherited.append((os.path.join(parent, best), os.path.join(root, "cover.jpg")))
                continue
        hopeless.append(root)

    print(f"{'APPLYING' if write else 'DRY RUN'}\n")
    print(f"  {len(plan)} albums have art under a name Navidrome ignores:")
    for src, dst in plan[:12]:
        print(f"    {os.path.relpath(os.path.dirname(src), MUSIC)}")
        print(f"        {os.path.basename(src)} -> cover.jpg")
    if len(plan) > 12:
        print(f"    ... and {len(plan)-12} more")

    print(f"\n  {len(inherited)} disc subfolders can inherit the parent album cover")
    for src, dst in inherited[:5]:
        print(f"    {os.path.relpath(os.path.dirname(dst), MUSIC)}  <- {os.path.basename(src)}")

    print(f"\n  {len(hopeless)} albums have no artwork anywhere — nothing local to use:")
    for d in hopeless[:10]:
        print(f"    {os.path.relpath(d, MUSIC)}")
    if len(hopeless) > 10:
        print(f"    ... and {len(hopeless)-10} more")

    if not write:
        print("\nNothing written. Re-run with --write.")
        return

    n = 0
    for src, dst in plan + inherited:
        try:
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
                n += 1
        except OSError as e:
            print(f"  FAILED {dst}: {e}", file=sys.stderr)
    print(f"\n  created {n} cover.jpg files")


if __name__ == "__main__":
    main()
