#!/usr/bin/env python3
import sqlite3

con = sqlite3.connect("file:/home/todd/navidrome-trial/data/navidrome.db?mode=ro", uri=True)
q = lambda s: con.execute(s).fetchone()[0]

print("AFTER FULL RESCAN")
print(f"  tracks:                   {q('SELECT COUNT(*) FROM media_file')}")
print(f"  [Unknown Album] tracks:   {q(chr(39).join(['SELECT COUNT(*) FROM media_file WHERE album=', '[Unknown Album]', '']))}   (was 627)")
print(f"  [Unknown Album] entities: {q(chr(39).join(['SELECT COUNT(*) FROM album WHERE name=', '[Unknown Album]', '']))}   (was 37)")
print(f"  distinct albumartists:    {q('SELECT COUNT(DISTINCT album_artist) FROM media_file')}   (was 613)")

print("\n  remaining unknown-album groups:")
for r in con.execute("SELECT album_artist, song_count FROM album WHERE name = '[Unknown Album]' ORDER BY song_count DESC"):
    print(f"    {r[1]:>4}  {r[0]!r}")

print("\n  Neil Young:")
for r in con.execute("SELECT album_artist, COUNT(DISTINCT name), SUM(song_count) FROM album WHERE album_artist LIKE '%Neil Young%' GROUP BY album_artist"):
    print(f"    {r[0]!r}: {r[1]} albums, {r[2]} songs")

print("\n  folders still naming >1 albumartist (was 73):")
import os
from collections import defaultdict
split = defaultdict(set)
for p, aa in con.execute("SELECT path, album_artist FROM media_file"):
    f = p.split(os.sep)[0]
    if aa and aa != "[Unknown Artist]":
        split[f].add(aa)
multi = {k: v for k, v in split.items() if len(v) > 1}
print(f"    {len(multi)} of {len(split)}")
