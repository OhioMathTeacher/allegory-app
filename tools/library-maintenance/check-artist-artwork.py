#!/usr/bin/env python3
"""Find artist folders whose artwork belongs to a DIFFERENT artist.

Whatever fetched this artwork matched on artist name, and short or ambiguous
names collided — the `Brad` folder was given Brad Paisley's logo, banner,
backdrop and cover. Since `logo.png` is almost always the artist's name as
wordmark, OCR reads it and compares against the folder name.

Screening tool, not an executioner: stylised logos OCR badly, so this reports
suspects for you to eyeball. Nothing is deleted.
"""
import os
import re
import subprocess
import sys

MUSIC = "/media/MUSIC"


def norm(s):
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9,\s]", "", s)
    if s.startswith("the "):
        s = s[4:]
    if s.endswith(", the"):
        s = s[:-5]
    if "," in s:  # "Cave, Nick" -> "nick cave"
        a, b = s.split(",", 1)
        if b.strip():
            s = f"{b.strip()} {a.strip()}"
    return re.sub(r"[^a-z0-9]", "", s)


def ocr(path):
    try:
        r = subprocess.run(["tesseract", path, "stdout", "--psm", "7"],
                           capture_output=True, text=True, timeout=30)
        return " ".join(r.stdout.split())
    except Exception:
        return ""


def main():
    folders = [d for d in sorted(os.listdir(MUSIC))
               if os.path.isdir(os.path.join(MUSIC, d))
               and os.path.exists(os.path.join(MUSIC, d, "logo.png"))]
    print(f"OCR-ing {len(folders)} artist logos...\n", flush=True)

    suspect, unreadable, ok = [], [], 0
    for i, d in enumerate(folders, 1):
        if i % 50 == 0:
            print(f"  ...{i}/{len(folders)}", flush=True)
        text = ocr(os.path.join(MUSIC, d, "logo.png"))
        nt, nd = norm(text), norm(d)
        if not nt:
            unreadable.append(d)
        elif nd and (nd in nt or nt in nd):
            ok += 1
        else:
            suspect.append((d, text))

    print(f"\n  matched:    {ok}")
    print(f"  unreadable: {len(unreadable)}  (stylised logo — OCR got nothing)")
    print(f"  SUSPECT:    {len(suspect)}\n")
    print("  folder name                          logo appears to read")
    print("  " + "-" * 66)
    for d, text in suspect:
        print(f"  {d[:34]:<36} {text[:30]!r}")


if __name__ == "__main__":
    main()
