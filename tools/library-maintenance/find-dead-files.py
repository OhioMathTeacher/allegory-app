#!/usr/bin/env python3
"""Find files that are dead weight: zero bytes, or non-zero size but entirely
null content (an interrupted copy that allocated space and wrote nothing).

The all-null case is the nastier one — the file looks real to anything that
only checks size, which is why Navidrome indexed Black Sabbath's Forbidden and
why the scanner's zero-byte filter misses it.

Read-only unless --delete is passed. Aborts rather than deleting if the count
looks implausible.
"""
import os
import sys
from collections import defaultdict

MUSIC = os.environ.get("ALLEGORY_MUSIC_DIR", "/media/MUSIC")

SANITY_LIMIT = 500
CHUNK = 65536


def is_all_null(path, size):
    """True if every byte is zero. Bails on the first non-zero byte."""
    try:
        with open(path, "rb") as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    return True
                if b.count(0) != len(b):
                    return False
    except OSError:
        return False


def main():
    delete = "--delete" in sys.argv
    zero, null = [], []
    scanned = 0

    for root, dirs, files in os.walk(MUSIC):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            p = os.path.join(root, f)
            try:
                sz = os.path.getsize(p)
            except OSError:
                continue
            scanned += 1
            if scanned % 5000 == 0:
                print(f"  ...{scanned} files", flush=True)
            if sz == 0:
                zero.append((p, 0))
            elif is_all_null(p, sz):
                null.append((p, sz))

    print(f"\nscanned {scanned} files\n")
    print("=" * 72)
    print(f"ZERO-BYTE: {len(zero)}     ALL-NULL (non-zero size): {len(null)}")
    print("=" * 72)

    by_album = defaultdict(lambda: [0, 0, 0])  # zero, null, bytes
    for p, _ in zero:
        by_album[os.path.dirname(p)][0] += 1
    for p, sz in null:
        d = by_album[os.path.dirname(p)]
        d[1] += 1
        d[2] += sz

    for d in sorted(by_album):
        z, n, b = by_album[d]
        rel = os.path.relpath(d, MUSIC)
        total = len([f for f in os.listdir(d) if os.path.isfile(os.path.join(d, f))])
        waste = f", {b/1e6:.0f} MB wasted" if b else ""
        print(f"  {z + n:>3} dead of {total:>3} files  ({z} empty, {n} all-null{waste})")
        print(f"       {rel}")

    dead = zero + null
    reclaim = sum(sz for _, sz in dead)
    print(f"\n  total dead files: {len(dead)}   disk reclaimed: {reclaim/1e6:.0f} MB")

    if not delete:
        print("\n  Read-only. Pass --delete to remove them.")
        return

    if len(dead) > SANITY_LIMIT:
        sys.exit(f"\n  ABORT: {len(dead)} files exceeds sanity limit {SANITY_LIMIT}. Review first.")

    ok = 0
    for p, _ in dead:
        try:
            os.remove(p)
            ok += 1
        except OSError as e:
            print(f"  FAILED {p}: {e}", file=sys.stderr)
    print(f"\n  deleted {ok} files")

    # Remove any album folders left completely empty.
    removed_dirs = 0
    for d in sorted({os.path.dirname(p) for p, _ in dead}, key=len, reverse=True):
        try:
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
                removed_dirs += 1
                print(f"  removed empty folder: {os.path.relpath(d, MUSIC)}")
        except OSError:
            pass
    if removed_dirs:
        print(f"  removed {removed_dirs} empty folders")


if __name__ == "__main__":
    main()
