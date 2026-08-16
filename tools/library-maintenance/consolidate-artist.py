#!/usr/bin/env python3
"""Collapse an artist folder's albumartist variants into one canonical name.

Unlike fill-tags.py this DOES overwrite existing tags — that is the whole point,
since the variants are what split the artist. Two safeguards:

  * Every original tag is written to a JSON backup first, so the change is
    fully reversible with --restore.
  * Collaboration credits are preserved by moving them down to the track-level
    `artist` tag rather than discarding them. `Neil Young & Crazy Horse` stops
    being a separate artist in the library but is still visible per track.
"""
import argparse
import json
import os
import sys

import mutagen

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

AUDIO = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif"}


def audio_files(base):
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in sorted(files):
            if f.startswith("._"):
                continue
            if os.path.splitext(f)[1].lower() in AUDIO:
                yield os.path.join(root, f)


def get(a, k):
    v = a.get(k)
    if isinstance(v, list):
        v = v[0] if v else ""
    return (v or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="artist folder under /media/MUSIC")
    ap.add_argument("--canonical", required=True, help="the one true albumartist")
    ap.add_argument("--backup", required=True, help="JSON backup path")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--restore", action="store_true", help="undo using the backup")
    args = ap.parse_args()

    base = os.path.join(MUSIC, args.folder)
    if not os.path.isdir(base):
        sys.exit(f"no such folder: {base}")

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
        print(f"restored {n} files from {args.backup}")
        return

    backup, changes = {}, []
    for p in audio_files(base):
        try:
            a = mutagen.File(p, easy=True)
        except Exception:
            a = None
        if a is None:
            continue
        aa, ar = get(a, "albumartist"), get(a, "artist")
        backup[p] = {"albumartist": aa, "artist": ar}

        new_aa = args.canonical
        # A collaboration credit sitting in albumartist is what splits the
        # artist. Move it to the track artist so the information survives.
        new_ar = aa if (aa and aa != args.canonical and args.canonical in aa) else ar
        if not new_ar or new_ar != args.canonical:
            if not (new_ar and args.canonical in new_ar):
                new_ar = args.canonical

        if aa != new_aa or ar != new_ar:
            changes.append((p, aa, new_aa, ar, new_ar))

    print(f"{len(changes)} of {len(backup)} files would change\n")
    by = {}
    for p, oaa, naa, oar, nar in changes:
        alb = os.path.relpath(os.path.dirname(p), base)
        by.setdefault(alb, [0, oaa, naa, oar, nar])[0] += 1
    for alb, (n, oaa, naa, oar, nar) in sorted(by.items()):
        print(f"  {alb}  ({n} files)")
        if oaa != naa:
            print(f"      albumartist  {oaa!r} -> {naa!r}")
        if oar != nar:
            print(f"      artist       {oar!r} -> {nar!r}")

    if not args.write:
        print("\nDRY RUN — nothing written.")
        return

    os.makedirs(os.path.dirname(args.backup), exist_ok=True)
    with open(args.backup, "w") as f:
        json.dump(backup, f, indent=1)
    print(f"\nbacked up {len(backup)} files -> {args.backup}")

    n = 0
    for p, oaa, naa, oar, nar in changes:
        try:
            a = mutagen.File(p, easy=True)
            a["albumartist"] = naa
            a["artist"] = nar
            a.save()
            n += 1
        except Exception as e:
            print(f"  FAILED {os.path.relpath(p, base)}: {e}", file=sys.stderr)
    print(f"wrote {n} files")


if __name__ == "__main__":
    main()
