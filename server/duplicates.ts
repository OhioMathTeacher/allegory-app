/**
 * Duplicate *file* detection — the album-side counterpart to playlist dedupe,
 * and deliberately a different animal.
 *
 * A playlist entry is a reference: two lines naming one file, and removing one
 * costs nothing. A library file IS the music, so "removing a duplicate" here
 * deletes audio. That asymmetry sets every rule below.
 *
 * Only byte-identical files are reported. Two different encodings of one song
 * — an album rip and a greatest-hits rip — are NOT duplicates as far as this
 * module is concerned: nothing it can measure distinguishes a remaster from a
 * reissue, and guessing costs someone a recording they wanted.
 *
 * Nothing is ever unlinked. Confirmed duplicates move to `.duplicates/` inside
 * the music dir, keeping their relative path, so a wrong call is undone by
 * moving the file back. The scanner already skips dot-folders, so quarantined
 * files leave the library immediately without being destroyed.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** Where quarantined files go, inside the music dir. */
export const QUARANTINE_DIRNAME = '.duplicates'

export interface DuplicateFile {
  /** The scanner's track id — what the client sends back to act on a file. */
  id: string
  /** Path relative to the music dir, for display. */
  relPath: string
  size: number
  mtimeMs: number
}

export interface DuplicateGroup {
  /** Content hash shared by every member. */
  hash: string
  size: number
  /** Two or more byte-identical files, keeper first. */
  members: DuplicateFile[]
}

export interface DuplicateReport {
  /** How many files were considered. */
  scanned: number
  /** How many needed hashing (i.e. shared a size with something else). */
  hashed: number
  groups: DuplicateGroup[]
  /** Bytes freed if every group were reduced to its keeper. */
  reclaimable: number
}

/** A file the scan can see: enough to identify and rank it. */
export interface ScanCandidate {
  id: string
  path: string
}

/**
 * Which copy to suggest keeping.
 *
 * Preference order, most to least decisive:
 *   1. not obviously a copy — `foo (1).flac`, `foo copy.flac`, `.../Copy of X/`
 *   2. shallower in the tree — a stray duplicate usually sits in an extra
 *      folder, and the canonical file is the one filed properly
 *   3. older — the original predates the copy
 *   4. path order, so the result never depends on directory-read order
 */
const COPY_MARKER = /(\(\d+\)|\bcopy\b|\bduplicate\b|-\s*copy)/i

function keeperRank(f: DuplicateFile): [number, number, number, string] {
  return [
    COPY_MARKER.test(f.relPath) ? 1 : 0,
    f.relPath.split(sep).length,
    f.mtimeMs,
    f.relPath,
  ]
}

function byKeeperRank(a: DuplicateFile, b: DuplicateFile): number {
  const ra = keeperRank(a)
  const rb = keeperRank(b)
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1
    if (ra[i] > rb[i]) return 1
  }
  return 0
}

/** Stream a file through sha256 — never loads a whole track into memory. */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (chunk) => h.update(chunk))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * Find byte-identical files among `candidates`.
 *
 * Two passes, because hashing 17,000 files would read the whole library off
 * disk for nothing. Size comes from a stat and settles the vast majority:
 * files of different lengths cannot be identical, so only files sharing an
 * exact size are ever read. Zero-byte files are skipped — they are all
 * trivially "identical" to each other and are already excluded from the index.
 */
export async function findDuplicates(
  musicDir: string,
  candidates: ScanCandidate[],
): Promise<DuplicateReport> {
  // Pass 1 — group by exact size.
  const bySize = new Map<number, DuplicateFile[]>()
  let scanned = 0
  for (const c of candidates) {
    // A file already quarantined is not a library duplicate.
    if (c.path.split(sep).includes(QUARANTINE_DIRNAME)) continue
    let st
    try {
      st = await stat(c.path)
    } catch {
      continue // vanished since the scan — not our problem to report here
    }
    if (st.size === 0) continue
    scanned++
    const entry: DuplicateFile = {
      id: c.id,
      relPath: relative(musicDir, c.path),
      size: st.size,
      mtimeMs: st.mtimeMs,
    }
    const list = bySize.get(st.size)
    if (list) list.push(entry)
    else bySize.set(st.size, [entry])
  }

  // Pass 2 — hash only within same-size groups.
  const byHash = new Map<string, DuplicateFile[]>()
  let hashed = 0
  for (const [, sameSize] of bySize) {
    if (sameSize.length < 2) continue
    for (const f of sameSize) {
      let hash: string
      try {
        hash = await hashFile(join(musicDir, f.relPath))
      } catch {
        continue // unreadable — leave it alone rather than guess
      }
      hashed++
      const list = byHash.get(hash)
      if (list) list.push(f)
      else byHash.set(hash, [f])
    }
  }

  const groups: DuplicateGroup[] = []
  let reclaimable = 0
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue
    members.sort(byKeeperRank)
    groups.push({ hash, size: members[0].size, members })
    reclaimable += members[0].size * (members.length - 1)
  }
  // Biggest wins first — that is the order someone reviewing this cares about.
  groups.sort((a, b) => b.size * (b.members.length - 1) - a.size * (a.members.length - 1))

  return { scanned, hashed, groups, reclaimable }
}

export interface QuarantineResult {
  moved: number
  failed: string[]
  /** Absolute path of the folder the files were moved into. */
  dir: string
}

/**
 * Move files into `.duplicates/<YYYY-MM-DD>/<original relative path>`.
 *
 * Keeping the relative path means a mistake is undone by moving the file back
 * to the same place, and it keeps two same-named tracks from different albums
 * from colliding in the quarantine.
 */
export async function quarantineFiles(
  musicDir: string,
  paths: string[],
  today: string,
): Promise<QuarantineResult> {
  const dir = join(musicDir, QUARANTINE_DIRNAME, today)
  const failed: string[] = []
  let moved = 0
  for (const abs of paths) {
    const rel = relative(musicDir, abs)
    // Refuse anything that escapes the music dir, however it was spelled.
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      failed.push(rel || abs)
      continue
    }
    const dest = join(dir, rel)
    try {
      await mkdir(dirname(dest), { recursive: true })
      try {
        await rename(abs, dest)
      } catch (err) {
        // Different device (the library can span mounts) — copy then remove.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await copyFile(abs, dest)
        await unlink(abs)
      }
      moved++
    } catch {
      failed.push(rel)
    }
  }
  return { moved, failed, dir }
}
