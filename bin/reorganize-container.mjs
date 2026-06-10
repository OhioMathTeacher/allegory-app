#!/usr/bin/env node
/**
 * Reorganize a "container" folder — one directory holding albums by many
 * different artists (e.g. "Live Albums") — into the Artist/Album layout the
 * scanner expects. The real artist + album come from each album's track tags
 * (album-artist preferred), falling back to the folder name.
 *
 * Dry-run by default: prints the planned moves and changes nothing. Pass
 * --apply to actually move folders on disk.
 *
 *   node bin/reorganize-container.mjs "/home/todd/Music/Live Albums"
 *   node bin/reorganize-container.mjs "/home/todd/Music/Live Albums" --apply
 */
import { readdir, stat, mkdir, rename, rmdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.oga',
  '.wav', '.aac', '.wma', '.aiff', '.aif', '.alac',
])

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const container = args.find((a) => !a.startsWith('--'))
if (!container) {
  console.error('usage: reorganize-container.mjs <container-folder> [--apply]')
  process.exit(1)
}
const musicDir = dirname(container)

/** Make a name safe to use as a single path segment. */
function safeFsName(s) {
  return s
    .replace(/[/\\]/g, '-')        // path separators
    .replace(/[:*?"<>|]/g, '')     // filesystem-illegal punctuation
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')        // no trailing dots/space (Windows-hostile)
}

/** First audio file anywhere under dir (depth-first, name-sorted). */
async function firstAudio(dir) {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith('.')) // skip dotfiles + macOS ._ AppleDouble
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (e.isFile() && AUDIO_EXTS.has(extname(e.name).toLowerCase())) return join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await firstAudio(join(dir, e.name))
      if (found) return found
    }
  }
  return null
}

async function readTags(file) {
  try {
    const mm = await import('music-metadata')
    const md = await mm.parseFile(file, { duration: false, skipCovers: true })
    return {
      artist: (md.common.albumartist || md.common.artist || '').trim(),
      album: (md.common.album || '').trim(),
    }
  } catch (e) {
    console.error(`  ! tag read failed for ${basename(file)}: ${e.message}`)
    return { artist: '', album: '' }
  }
}

const subdirs = (await readdir(container, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const plan = []
for (const sub of subdirs) {
  const src = join(container, sub)
  const audio = await firstAudio(src)
  const tags = audio ? await readTags(audio) : { artist: '', album: '' }
  const artist = safeFsName(tags.artist) || safeFsName(sub)
  const album = safeFsName(tags.album) || safeFsName(sub)
  const dest = join(musicDir, artist, album)
  let exists = false
  try { await stat(dest); exists = true } catch { /* good, no clash */ }
  plan.push({ sub, src, artist, album, dest, exists, taggedArtist: tags.artist, taggedAlbum: tags.album })
}

console.log(`\nContainer: ${container}`)
console.log(`Music dir: ${musicDir}`)
console.log(`Mode:      ${apply ? 'APPLY (moving files)' : 'DRY-RUN (no changes)'}\n`)
for (const p of plan) {
  console.log(`  ${p.sub}`)
  console.log(`    tags : artist="${p.taggedArtist || '(none)'}"  album="${p.taggedAlbum || '(none)'}"`)
  console.log(`    ->   : ${p.artist}/${p.album}${p.exists ? '   ⚠ DEST EXISTS — will SKIP' : ''}`)
}

if (!apply) {
  console.log(`\nDry-run only. Re-run with --apply to perform these moves.\n`)
  process.exit(0)
}

let moved = 0
for (const p of plan) {
  if (p.exists) { console.log(`SKIP (exists): ${p.dest}`); continue }
  await mkdir(join(musicDir, p.artist), { recursive: true })
  await rename(p.src, p.dest)
  console.log(`moved: ${p.sub} -> ${p.artist}/${p.album}`)
  moved++
}
// Remove the container if it's now empty.
try {
  const left = await readdir(container)
  if (left.length === 0) { await rmdir(container); console.log(`removed empty container: ${container}`) }
  else console.log(`container not empty (${left.length} left): ${container}`)
} catch { /* already gone */ }
console.log(`\nDone. Moved ${moved}/${plan.length}.\n`)
