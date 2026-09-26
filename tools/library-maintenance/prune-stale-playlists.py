#!/usr/bin/env python3
"""Remove Navidrome playlist rows whose .m3u file no longer exists.

Navidrome imports each `.m3u` in the music folder as a playlist row and keeps
`sync=1` on it, meaning "this came from a file". It does not drop the row when
the file goes away, so combining or renaming playlists in Allegory leaves a
trail: 34 rows for 18 files, 14 of them showing zero songs in Amperfy.

Only rows with `sync=1` AND a `path` that is missing from disk are removed. A
playlist made by hand in Navidrome or Amperfy has no path and is never touched,
and a `sync=1` row whose file still exists is left alone even if it is empty —
an empty playlist on disk is a real playlist that happens to be empty.

Nothing here is clever, and that is deliberate: it stops the service first so
SQLite is not being written underneath it, copies the database before touching
it, and refuses to run at all if it would delete every row.

    ./prune-stale-playlists.py            # show what would go, change nothing
    ./prune-stale-playlists.py --apply    # do it

No sudo: the database and the systemd unit are both the user's own.
"""
import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import time

ND = os.environ.get("NAVIDROME_DIR", os.path.expanduser("~/navidrome-trial"))
DB = os.environ.get("NAVIDROME_DB", os.path.join(ND, "data", "navidrome.db"))
BACKUPS = os.environ.get("ALLEGORY_BACKUP_DIR", os.path.join(ND, "backups"))
UNIT = os.environ.get("NAVIDROME_UNIT", "navidrome")

CHILD_TABLES = ("playlist_tracks", "playlist_fields")


def service(action):
    subprocess.run(["systemctl", "--user", action, UNIT], check=True)


def is_active():
    return subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", UNIT]
    ).returncode == 0


def survey(con):
    """(stale, keep) — stale is imported rows whose file is gone."""
    rows = con.execute("SELECT id, name, song_count, sync, path FROM playlist").fetchall()
    stale, keep = [], []
    for row in rows:
        _id, _name, _count, sync, path = row
        (stale if (sync and path and not os.path.exists(path)) else keep).append(row)
    return stale, keep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    args = ap.parse_args()

    if not os.path.exists(DB):
        sys.exit(f"no database at {DB} (set NAVIDROME_DB)")

    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    stale, keep = survey(con)
    con.close()

    print(f"{len(stale) + len(keep)} playlist rows: {len(keep)} to keep, {len(stale)} stale\n")
    if not stale:
        print("Nothing to do.")
        return
    for _id, name, count, _sync, path in sorted(stale, key=lambda r: r[1].lower()):
        print(f"  {count:>4} songs  {name[:46]:<46}  {os.path.basename(path)}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to delete these rows.")
        return
    if not keep:
        sys.exit("\nREFUSING: that would delete every playlist row.")

    was_active = is_active()
    if was_active:
        print("\nstopping navidrome…")
        service("stop")
        for _ in range(20):
            if not is_active():
                break
            time.sleep(0.5)
        if is_active():
            sys.exit("REFUSING: navidrome would not stop; nothing deleted.")

    try:
        os.makedirs(BACKUPS, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = os.path.join(BACKUPS, f"navidrome-db-{stamp}.db")
        shutil.copy2(DB, backup)
        if os.path.getsize(backup) == 0:
            sys.exit("REFUSING: the backup came out empty; nothing deleted.")
        print(f"backup: {backup}")

        ids = [r[0] for r in stale]
        marks = ",".join("?" * len(ids))
        con = sqlite3.connect(DB)
        try:
            # Children first, so nothing is orphaned whether or not the schema
            # declares ON DELETE CASCADE.
            for table in CHILD_TABLES:
                cols = [c[1] for c in con.execute(f"PRAGMA table_info({table})")]
                if "playlist_id" not in cols:
                    print(f"  {table}: no playlist_id column — skipped")
                    continue
                n = con.execute(
                    f"DELETE FROM {table} WHERE playlist_id IN ({marks})", ids
                ).rowcount
                print(f"  {table}: {n} row(s)")
            n = con.execute(f"DELETE FROM playlist WHERE id IN ({marks})", ids).rowcount
            print(f"  playlist: {n} row(s)")
            con.commit()

            left = con.execute("SELECT COUNT(*) FROM playlist").fetchone()[0]
            orphans = con.execute(
                "SELECT COUNT(*) FROM playlist_tracks "
                "WHERE playlist_id NOT IN (SELECT id FROM playlist)"
            ).fetchone()[0]
            print(f"\n{left} playlist rows remain, {orphans} orphaned track rows")
        finally:
            con.close()
    finally:
        if was_active:
            print("starting navidrome…")
            service("start")

    print(f"\nTo undo: systemctl --user stop {UNIT} && cp -p {backup} {DB} "
          f"&& systemctl --user start {UNIT}")


if __name__ == "__main__":
    main()
