#!/usr/bin/env python3
import os
import re
import sqlite3
import unicodedata

NAVIDROME_DB = os.environ.get(
    "NAVIDROME_DB", os.path.expanduser("~/navidrome-trial/data/navidrome.db")
)

con = sqlite3.connect(f"file:{NAVIDROME_DB}?mode=ro", uri=True)
q = lambda s: con.execute(s).fetchone()[0]


def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[^a-z0-9,\s]", "", s)
    if "," in s:
        a, b = s.split(",", 1)
        if b.strip():
            s = f"{b.strip()} {a.strip()}"
    return re.sub(r"[^a-z0-9]", "", s)


arts = {r[0]: r[1] for r in con.execute(
    "SELECT album_artist, COUNT(*) FROM media_file WHERE missing=0 GROUP BY album_artist")}
names = sorted(arts)
dupes = [(a, b) for i, a in enumerate(names) for b in names[i + 1:]
         if norm(a) and norm(a) == norm(b)]

print(f"  tracks:               {q('SELECT COUNT(*) FROM media_file WHERE missing=0')}")
print(f"  album-artists:        {len(arts)}")
print(f"  duplicate pairs:      {len(dupes)} {dupes if dupes else ''}")
print(f"""  unknown-album tracks: {q("SELECT COUNT(*) FROM media_file WHERE missing=0 AND album='[Unknown Album]'")}""")
print(f"""  unknown-artist:       {q("SELECT COUNT(*) FROM media_file WHERE missing=0 AND album_artist='[Unknown Artist]'")}""")
print()
print("  Melvins:", con.execute(
    "SELECT COUNT(DISTINCT name), SUM(song_count) FROM album WHERE album_artist='Melvins'").fetchone())
for n in ("Live Albums", "Native American Music", "Various", "Unknown artist"):
    print(f"  {n!r} present: {n in arts}")
print()
print("  sort check — these should file under their surname:")
for n in ("Young, Neil", "Zappa, Frank", "Marley, Bob", "Pop, Iggy", "Morrison, Van"):
    print(f"    {n!r}: {arts.get(n, 0)} tracks")
