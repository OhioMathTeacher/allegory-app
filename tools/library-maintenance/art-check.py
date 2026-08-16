#!/usr/bin/env python3
import os
import sqlite3

NAVIDROME_DB = os.environ.get(
    "NAVIDROME_DB", os.path.expanduser("~/navidrome-trial/data/navidrome.db")
)

con = sqlite3.connect(f"file:{NAVIDROME_DB}?mode=ro", uri=True)
q = lambda s: con.execute(s).fetchone()[0]

no_art = q("SELECT COUNT(*) FROM album WHERE COALESCE(embed_art_path,'')=''")
tracks = q("SELECT COUNT(*) FROM media_file WHERE missing=0 AND has_cover_art=0")
print(f"  albums with no art path: {no_art}   (was 793)")
print(f"  tracks w/o cover art:    {tracks}   (was 8789)")

print("\n  albums still lacking any art, by artist:")
rows = con.execute("""
  SELECT album_artist, COUNT(*) FROM album
  WHERE COALESCE(embed_art_path,'')='' GROUP BY album_artist
  ORDER BY 2 DESC LIMIT 12
""").fetchall()
for a, n in rows:
    print(f"    {n:>3}  {a}")
