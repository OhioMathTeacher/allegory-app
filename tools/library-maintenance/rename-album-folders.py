#!/usr/bin/env python3
"""Rename cryptic album folders to their real album names, taken from tags.

Purely cosmetic as far as the apps go — Allegory reads album names from tags
(`tagAlbum || folderAlbum`) and Navidrome reads them entirely from tags, so
neither changes what it displays. This is for navigating the filesystem by hand.

Also flattens the `CODE/CODE/*.mp3` nesting left by the archive extractions, so
an album ends up one level under the artist like everything else.

Skips a folder whose files disagree about the album name. DRY RUN unless
--write.
"""
import os
import re
import shutil
import sys
from collections import Counter

import mutagen

MUSIC = "/media/MUSIC"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".aiff"}
CD_SUBDIR = re.compile(r"^(?:(?:cd|dis[ck])[\s._-]*\d+|\d+)$|^(?:cd|dis[ck])[\s._-]*\d+", re.I)


def safe(s):
    return re.sub(r'[/\\:*?"<>|]', "-", s).strip().rstrip(".")


def album_of(d):
    names = Counter()
    for f in os.listdir(d):
        p = os.path.join(d, f)
        if not os.path.isfile(p) or os.path.splitext(f)[1].lower() not in AUD:
            continue
        try:
            a = mutagen.File(p, easy=True)
        except Exception:
            continue
        if a is None:
            continue
        v = (a.get("album") or [""])[0].strip()
        if v:
            names[v] += 1
    return names


def main():
    argv = sys.argv[1:]
    write = "--write" in argv
    every = "--all" in argv
    safe_only = "--safe" in argv
    artists = [a for a in argv if not a.startswith("--")]
    if every:
        artists = [d for d in sorted(os.listdir(MUSIC))
                   if os.path.isdir(os.path.join(MUSIC, d))
                   and d not in ("lost+found", "Playlists")]
    elif not artists:
        artists = ["Melvins", "Dinosaur Jr"]

    moves, skips, loose = [], [], []
    # (safe_only is read inside the loop below)
    for artist in artists:
        base = os.path.join(MUSIC, artist)
        if not os.path.isdir(base):
            continue
        # Audio sitting directly under the artist folder belongs in an album
        # subfolder like everything else. Group it by its album tag.
        root_audio = [f for f in os.listdir(base)
                      if os.path.isfile(os.path.join(base, f))
                      and os.path.splitext(f)[1].lower() in AUD]
        if root_audio:
            groups = {}
            for f in root_audio:
                try:
                    a = mutagen.File(os.path.join(base, f), easy=True)
                except Exception:
                    a = None
                alb = safe((a.get("album") or [""])[0]) if a else ""
                groups.setdefault(alb or "Unsorted", []).append(f)
            for alb, fs in groups.items():
                for f in fs:
                    loose.append((os.path.join(base, f), os.path.join(base, alb, f)))

        for root, dirs, files in os.walk(base):
            if root == base:
                continue
            if not any(os.path.splitext(f)[1].lower() in AUD for f in files):
                continue
            names = album_of(root)
            if not names:
                skips.append((root, "no album tag"))
                continue
            if len(names) > 1 and names.most_common(1)[0][1] < sum(names.values()) * 0.8:
                skips.append((root, f"disagreeing tags: {dict(names)}"))
                continue
            album = safe(names.most_common(1)[0][0])

            # Album tags are not reliably better than folder names — seen in the
            # wild: "Rubber Soul" tagged as "The Beatles Collection", and
            # "Black Gives Way to Blue" tagged with a track title. Only rename
            # when the folder name carries no information of its own: an opaque
            # code (BSLAT, LS) or a scene-release string. Everything else is
            # reported for review rather than renamed.
            folder_name = os.path.basename(root)
            # CD1/Disc 2/etc are disc subfolders, not albums — Allegory already
            # folds them into the parent. Renaming them would collapse both
            # discs of a set onto one target.
            if CD_SUBDIR.match(folder_name):
                continue
            # An opaque code needs at least two letters, so real album names
            # that happen to be numeric ("77", "1983") are not swept up.
            cryptic = (bool(re.match(r"^[A-Z0-9]{2,10}$", folder_name))
                       and len(re.findall(r"[A-Z]", folder_name)) >= 2)
            scene = bool(re.search(r"[-_]\d{4}[-_]|__mlib|www\.|-cd-|-flac-",
                                   folder_name.lower()))
            if safe_only and not (cryptic or scene):
                continue
            if re.search(r"unknown album|^track\d|^audiotrack", album, re.I):
                skips.append((root, f"junk album tag: {album!r}"))
                continue

            dest = os.path.join(base, album)
            if os.path.normpath(dest) == os.path.normpath(root):
                continue
            if os.path.exists(dest):
                skips.append((root, f"target exists: {album!r}"))
                continue
            moves.append((root, dest))

    targets = Counter(d for _, d in moves)
    collisions = {d for d, n in targets.items() if n > 1}
    if collisions:
        moves = [(s_, d) for s_, d in moves if d not in collisions]
        for d in sorted(collisions):
            skips.append((d, "COLLISION — two folders map to this name"))

    print(f"{'APPLYING' if write else 'DRY RUN'} — "
          f"{len(moves)} folders renamed, {len(loose)} loose files filed\n")
    for src, dst in sorted(moves):
        print(f"  {os.path.relpath(src, MUSIC)}")
        print(f"    -> {os.path.relpath(dst, MUSIC)}")
    if loose:
        print("\n  LOOSE FILES -> album subfolder:")
        seen = set()
        for src, dst in sorted(loose):
            d = os.path.dirname(dst)
            if d in seen:
                continue
            seen.add(d)
            n = sum(1 for s, x in loose if os.path.dirname(x) == d)
            print(f"    {n:>3} files  {os.path.relpath(d, MUSIC)}")
    if skips:
        print(f"\n  SKIPPED ({len(skips)}):")
        for d, why in skips:
            print(f"    {os.path.relpath(d, MUSIC)}  — {why}")

    if not write:
        print("\nNothing renamed. Re-run with --write.")
        return

    filed = 0
    for src, dst in loose:
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            filed += 1
        except OSError as e:
            print(f"  FAILED {src}: {e}", file=sys.stderr)
    if filed:
        print(f"  filed {filed} loose files into album folders")

    done = 0
    for src, dst in moves:
        try:
            shutil.move(src, dst)
            done += 1
        except OSError as e:
            print(f"  FAILED {src}: {e}", file=sys.stderr)
    print(f"\n  renamed {done} folders")

    # Drop the now-empty CODE wrappers left behind by the flattening.
    for artist in artists:
        base = os.path.join(MUSIC, artist)
        for d in sorted(os.listdir(base), key=len, reverse=True):
            p = os.path.join(base, d)
            if os.path.isdir(p) and not os.listdir(p):
                os.rmdir(p)
                print(f"  removed empty: {artist}/{d}")


if __name__ == "__main__":
    main()
