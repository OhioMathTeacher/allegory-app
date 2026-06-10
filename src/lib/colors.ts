export interface Palette {
  /** Vivid color for highlights — kept bright enough for black text. */
  accent: string
  /** Dark, desaturated tint for ambient background glows. */
  soft: string
}

const FALLBACK: Palette = { accent: '#818cf8', soft: '#1e1b35' }

/**
 * Pulls a small palette out of an album cover with a 2D canvas.
 * No dependency — if the image can't be read (CORS taint), we fall back.
 */
export async function extractPalette(imageUrl: string): Promise<Palette> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        resolve(analyze(img))
      } catch {
        resolve(FALLBACK)
      }
    }
    img.onerror = () => resolve(FALLBACK)
    img.src = imageUrl
  })
}

function analyze(img: HTMLImageElement): Palette {
  const size = 40
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return FALLBACK
  ctx.drawImage(img, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)

  let best = { score: -1, r: 129, g: 140, b: 248 }
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let count = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (data[i + 3] < 200) continue

    sumR += r
    sumG += g
    sumB += b
    count++

    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const saturation = max === 0 ? 0 : (max - min) / max
    const lightness = max / 255
    // favour vivid, mid-bright pixels for the accent
    const score = saturation * (1 - Math.abs(lightness - 0.55) * 1.4)
    if (score > best.score) best = { score, r, g, b }
  }

  return {
    accent: brighten(best.r, best.g, best.b),
    soft: darkTint(
      count ? sumR / count : 30,
      count ? sumG / count : 27,
      count ? sumB / count : 53,
    ),
  }
}

/** Scale a color up so its brightest channel stays legible under black text. */
function brighten(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b, 1)
  const scale = max < 205 ? 205 / max : 1
  const clamp = (v: number) => Math.round(Math.min(255, v * scale))
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`
}

/** Deep, dim version of the average color for the ambient background. */
function darkTint(r: number, g: number, b: number): string {
  const dim = (channel: number, floor: number) =>
    Math.round(Math.max(floor, channel * 0.2))
  return `rgb(${dim(r, 14)}, ${dim(g, 14)}, ${dim(b, 20)})`
}
