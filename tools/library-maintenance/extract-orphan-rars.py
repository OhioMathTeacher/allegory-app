#!/usr/bin/env python3
"""Extract the .rar archives in lost+found whose albums exist nowhere else.

The fsck recovery left both extracted audio and the original download packages.
Most archives duplicate audio sitting beside them, but seven are the only copy
of their album. Those get extracted, read for their album tag, and filed under
Melvins/<Album>.

Extracts to a staging directory first so a bad archive cannot scatter files
into the library. Skips any album that already exists.

DRY RUN unless --write.
"""
import os
import shutil
import subprocess
import sys
import tempfile

import mutagen

MUSIC = "/media/MUSIC"
LF = os.path.join(MUSIC, "lost+found")
ARTIST = "Melvins"
AUD = {".mp3", ".flac", ".m4a", ".ogg", ".wav"}


def orphan_archives():
    out = []
    for root, dirs, files in os.walk(LF):
        for f in files:
            if not f.lower().endswith(".rar"):
                continue
            has_audio = any(os.path.splitext(x)[1].lower() in AUD
                            for r, d, fs in os.walk(root) for x in fs)
            if not has_audio:
                out.append(os.path.join(root, f))
    return sorted(out)


def album_of(d):
    for root, dirs, files in os.walk(d):
        for f in sorted(files):
            if os.path.splitext(f)[1].lower() not in AUD:
                continue
            try:
                a = mutagen.File(os.path.join(root, f), easy=True)
            except Exception:
                continue
            if a is None:
                continue
            v = (a.get("album") or [""])[0].strip()
            if v:
                return v
    return ""


def main():
    write = "--write" in sys.argv
    archives = orphan_archives()
    print(f"{'EXTRACTING' if write else 'DRY RUN'} — {len(archives)} archives\n")

    staging = tempfile.mkdtemp(prefix="rar-extract-")
    results = []
    try:
        for rar in archives:
            name = os.path.basename(rar)
            out = os.path.join(staging, name.replace(".rar", ""))
            os.makedirs(out, exist_ok=True)
            r = subprocess.run(["unrar-free", "-x", rar, out],
                               capture_output=True, text=True, timeout=600)
            audio = [os.path.join(rt, f) for rt, d, fs in os.walk(out)
                     for f in fs if os.path.splitext(f)[1].lower() in AUD]
            if not audio:
                print(f"  FAILED to extract audio: {name}  {r.stderr.strip()[:60]}")
                continue
            album = album_of(out) or os.path.basename(os.path.dirname(rar))
            dest = os.path.join(MUSIC, ARTIST, album)
            exists = os.path.isdir(dest)
            results.append((name, album, len(audio), out, dest, exists))
            flag = "  ALREADY EXISTS - skip" if exists else ""
            print(f"  {name:<12} -> {ARTIST}/{album!r}  ({len(audio)} tracks){flag}")

        if not write:
            print("\nNothing filed. Re-run with --write.")
            return

        filed = 0
        for name, album, n, out, dest, exists in results:
            if exists:
                continue
            # The archive usually contains one top folder; lift its contents.
            entries = os.listdir(out)
            src = os.path.join(out, entries[0]) if (
                len(entries) == 1 and os.path.isdir(os.path.join(out, entries[0]))) else out
            shutil.copytree(src, dest)
            filed += 1
            print(f"  filed {album!r} ({n} tracks)")
        print(f"\n  filed {filed} albums")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()
