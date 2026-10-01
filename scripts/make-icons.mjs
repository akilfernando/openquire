// Draws the app icons: a stack of sheets (a "quire") on a dark tile, with an amber corner fold.
// Run with `node scripts/make-icons.mjs`; outputs are committed in public/.
import * as mupdf from 'mupdf'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

function roundRect(path, x, y, w, h, r) {
  const k = 0.5523 * r
  path.moveTo(x + r, y)
  path.lineTo(x + w - r, y)
  path.curveTo(x + w - r + k, y, x + w, y + r - k, x + w, y + r)
  path.lineTo(x + w, y + h - r)
  path.curveTo(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h)
  path.lineTo(x + r, y + h)
  path.curveTo(x + r - k, y + h, x, y + h - r + k, x, y + h - r)
  path.lineTo(x, y + r)
  path.curveTo(x, y + r - k, x + r - k, y, x + r, y)
  path.closePath()
}

/** Draws on a 100x100 design grid; `inset` shrinks the artwork for maskable icons. */
function icon(size, { inset = 0, tile = true } = {}) {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, size, size], true)
  pix.clear(0)
  const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix)
  const s = size / 100
  const fill = (build, hex, alpha = 1, m = mupdf.Matrix.scale(s, s)) => {
    const p = new mupdf.Path()
    build(p)
    dev.fillPath(p, false, m, mupdf.ColorSpace.DeviceRGB, rgb(hex), alpha)
  }
  if (tile) fill((p) => roundRect(p, 0, 0, 100, 100, inset ? 0 : 22), '#202020')
  const k = 1 - inset * 2
  const art = mupdf.Matrix.concat(mupdf.Matrix.concat(mupdf.Matrix.translate(-50, -50), mupdf.Matrix.scale(k, k)), mupdf.Matrix.translate(50, 50))
  const m = mupdf.Matrix.concat(art, mupdf.Matrix.scale(s, s))
  // Two sheets behind, offset like a gathered quire.
  fill((p) => roundRect(p, 34, 20, 40, 52, 4), '#5c5c5c', 1, m)
  fill((p) => roundRect(p, 30, 24, 40, 52, 4), '#999999', 1, m)
  // Front sheet with its top-right corner folded.
  fill((p) => {
    p.moveTo(30, 32); p.curveTo(30, 29.8, 31.8, 28, 34, 28)
    p.lineTo(56, 28); p.lineTo(66, 38); p.lineTo(66, 76)
    p.curveTo(66, 78.2, 64.2, 80, 62, 80); p.lineTo(34, 80)
    p.curveTo(31.8, 80, 30, 78.2, 30, 76); p.closePath()
  }, '#f4f1ea', 1, m.map((v, i) => (i === 4 ? v - 4 * s * k : v)))
  // The amber fold.
  fill((p) => { p.moveTo(52, 28); p.lineTo(62, 38); p.lineTo(54, 38); p.curveTo(52.9, 38, 52, 37.1, 52, 36); p.closePath() }, '#f5a524', 1, m)
  // Text lines on the front sheet, the first one highlighted.
  fill((p) => roundRect(p, 31, 46, 26, 6, 1.5), '#f5a524', 0.45, m)
  for (const [y, w] of [[48, 22], [56, 26], [63, 26], [70, 16]]) fill((p) => roundRect(p, 33, y, w, 2.6, 1.3), '#3a3a3a', 1, m)
  dev.close()
  return pix.asPNG()
}

writeFileSync(join(out, 'icon-192.png'), icon(192))
writeFileSync(join(out, 'icon-512.png'), icon(512))
writeFileSync(join(out, 'icon-maskable-512.png'), icon(512, { inset: 0.12 }))
writeFileSync(join(out, 'apple-touch-icon.png'), icon(180, { inset: 0.06 }))
writeFileSync(join(out, 'favicon-32.png'), icon(32))
console.log('icons written to public/')
