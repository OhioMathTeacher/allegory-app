#!/usr/bin/env node
// Allegory's mark, in one place.
//
// Before this script the mark existed in four unconnected copies —
// Logo.tsx, public/favicon.svg, icon-192.png, icon-512.png — which is how
// Cinnamon ended up showing a purple lightning bolt that nothing else in the
// app used any more. Everything is generated from MARKS below; change the
// geometry once and re-run.
//
//   node tools/make-icons.mjs                 write the chosen mark everywhere
//   node tools/make-icons.mjs --mark=column   use a different mark
//   node tools/make-icons.mjs --preview DIR   render every candidate, 22px and 192px
//
// 22px is the size that decides: that is roughly what the Cinnamon panel
// gives an applet, and a mark that turns to mud there has already failed.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// The mark the app ships. Change this line to adopt a candidate.
const CHOSEN = 'cave'

const INK = '#818cf8' // --accent, src/index.css
const FIELD = '#09090b' // --background / manifest theme_color

/**
 * Each mark returns SVG children drawn in a 24×24 box, using `currentColor`
 * so Logo.tsx can tint it per album the way the rest of the UI is tinted.
 */
const MARKS = {
  // What ships today: five bars, graduated. Reads as an equalizer, or,
  // as Todd put it, an upside-down Tower of Hanoi. Kept so the generator
  // can reproduce the current icon exactly, and for side-by-side previews.
  bars: () => `
    <rect x="2"    y="4" width="2.4" height="5"  rx="1.2"/>
    <rect x="6.4"  y="4" width="2.4" height="10" rx="1.2"/>
    <rect x="10.8" y="4" width="2.4" height="18" rx="1.2"/>
    <rect x="15.2" y="4" width="2.4" height="10" rx="1.2"/>
    <rect x="19.6" y="4" width="2.4" height="5"  rx="1.2"/>`,

  // A Doric column's fluting is already a row of vertical parallel lines.
  // Give the bars a capital and a base and the same silhouette reads as
  // architecture and as a level meter depending on how long you look.
  column: () => `
    <rect x="1.6" y="2.4"  width="20.8" height="2.6" rx="0.7"/>
    <rect x="2.8" y="5.0"  width="18.4" height="1.1"/>
    <rect x="4.0"  y="7.4" width="2.2" height="9.6"  rx="1.1"/>
    <rect x="7.45" y="7.4" width="2.2" height="9.6"  rx="1.1"/>
    <rect x="10.9" y="7.4" width="2.2" height="9.6"  rx="1.1"/>
    <rect x="14.35" y="7.4" width="2.2" height="9.6" rx="1.1"/>
    <rect x="17.8" y="7.4" width="2.2" height="9.6"  rx="1.1"/>
    <rect x="2.8" y="17.9" width="18.4" height="1.1"/>
    <rect x="1.6" y="19.0" width="20.8" height="2.6" rx="0.7"/>`,

  // The conceit the app is named for: a recording is a shadow of a
  // performance. A disc, and the flat shape it throws. Legible at any size
  // because it is two shapes, not a scene.
  shadow: () => `
    <circle cx="12" cy="8.6" r="5.9"/>
    <ellipse cx="12" cy="19.4" rx="9.2" ry="2.5" opacity="0.45"/>`,

  // The fire behind the prisoners. Same vertical family as today's bars,
  // but tapered and radiating, so they read as light spilling past a
  // barrier rather than as an equalizer.
  fire: () => `
    <circle cx="12" cy="3.6" r="2.4"/>
    <path d="M10.6 8.2h2.8l2.0 13.4h-6.8z"/>
    <path d="M6.4 8.6h2.2l-2.6 13.0h-3.2z" opacity="0.62"/>
    <path d="M15.4 8.6h2.2l5.8 13.0h-3.2z" opacity="0.62"/>`,

  // Fire and shadows: the whole allegory in one shape. A single source at
  // the top, three shadows thrown from it, widening as they fall, and the
  // wall they land on. Shadows widen with distance, so the splay is the
  // physics and not a flourish — and it is also a level meter seen upside
  // down, which is the dual reading the bars never earned.
  cave: () => `
    <circle cx="12" cy="3.5" r="2.3"/>
    <path d="M10.75 9.2h2.5l2.45 11.1h-7.4z"/>
    <path d="M6.9 9.6h2.0l-2.5 10.7h-4.3z" opacity="0.6"/>
    <path d="M15.1 9.6h2.0l4.8 10.7h-4.3z" opacity="0.6"/>
    <rect x="0.8" y="20.8" width="22.4" height="1.6" rx="0.8"/>`,
}

function svg(markName, { color = 'currentColor', field = null, pad = 0 } = {}) {
  const body = MARKS[markName]
  if (!body) throw new Error(`unknown mark ${markName}; have ${Object.keys(MARKS).join(', ')}`)
  // A maskable icon needs its content inside the safe zone, so the mark is
  // scaled down about its centre rather than redrawn.
  const s = 1 - pad * 2
  const inner = pad ? `<g transform="translate(${24 * pad} ${24 * pad}) scale(${s})">${body()}</g>` : body()
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="${color}">` +
    (field ? `<rect width="24" height="24" fill="${field}"/>` : '') +
    inner +
    `</svg>\n`
}

async function png(markName, size, out, { pad = 0 } = {}) {
  const src = svg(markName, { color: INK, field: FIELD, pad })
  await sharp(Buffer.from(src), { density: Math.max(72, size * 8) })
    .resize(size, size)
    .png()
    .toFile(out)
  return out
}

const args = process.argv.slice(2)
const markArg = (args.find((a) => a.startsWith('--mark=')) || '').split('=')[1]
const previewIdx = args.indexOf('--preview')

if (previewIdx !== -1) {
  const dir = args[previewIdx + 1]
  if (!dir) throw new Error('--preview needs a directory')
  await mkdir(dir, { recursive: true })
  for (const name of Object.keys(MARKS)) {
    // 22px is the Cinnamon panel. 192 is the installed app and the dock.
    for (const size of [22, 192]) {
      await png(name, size, join(dir, `${name}-${size}.png`))
    }
    await writeFile(join(dir, `${name}.svg`), svg(name, { color: INK, field: FIELD }))
  }
  console.log(`previewed ${Object.keys(MARKS).length} marks at 22px and 192px -> ${dir}`)
} else {
  const mark = markArg || CHOSEN
  const wrote = []
  // The SVG favicon stays monochrome and transparent: index.html and the
  // .desktop both use it, and currentColor lets the app tint it.
  const faviconPath = join(REPO, 'public/favicon.svg')
  await writeFile(faviconPath, svg(mark, { color: INK }))
  wrote.push(faviconPath)
  wrote.push(await png(mark, 180, join(REPO, 'public/icon-180.png')))
  wrote.push(await png(mark, 192, join(REPO, 'public/icon-192.png')))
  wrote.push(await png(mark, 512, join(REPO, 'public/icon-512.png')))
  // Maskable: Android crops to a circle, so the mark needs the safe zone.
  wrote.push(await png(mark, 512, join(REPO, 'public/icon-512-maskable.png'), { pad: 0.1 }))

  // Logo.tsx is generated too, or the on-screen mark drifts from the icon —
  // which is exactly how the lightning bolt outlived its own logo.
  const logo = `import type { CSSProperties } from 'react'

interface LogoProps {
  className?: string
  style?: CSSProperties
}

/**
 * Allegory mark. GENERATED — do not edit.
 * Source: tools/make-icons.mjs (mark: ${mark}). Re-run that to change it,
 * so the on-screen logo and the app icons cannot drift apart.
 */
export function Logo({ className, style }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Allegory"
    >${MARKS[mark]().replace(/\n {4}/g, '\n      ')}
    </svg>
  )
}
`
  const logoPath = join(REPO, 'src/components/Logo.tsx')
  await writeFile(logoPath, logo)
  wrote.push(logoPath)
  console.log(`mark "${mark}" written to:`)
  for (const w of wrote) console.log('  ' + w.replace(REPO + '/', ''))
}
