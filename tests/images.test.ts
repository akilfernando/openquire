import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import type { Rect } from '../src/engine/types'

const solid = (hex: string, w = 8, h = 8) => {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
  const px = pix.getPixels()
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  for (let i = 0; i < px.length; i += 3) px.set([r, g, b], i)
  return pix
}

/** A page with a pale background image, a red "logo" image, text and a black box outline. */
function imagePdf(rotate: 0 | 90 = 0) {
  const d = new mupdf.PDFDocument()
  const bg = d.addImage(new mupdf.Image(solid('#e0f0ff')))
  const logo = d.addImage(new mupdf.Image(solid('#ff0000')))
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  const content = [
    'q 400 0 0 300 0 0 cm /Bg Do Q',
    'q 80 0 0 40 20 240 cm /Logo Do Q',
    'BT /F1 14 Tf 150 250 Td (Caption text) Tj ET',
    '0 0 0 RG 2 w 20 20 100 40 re S',
  ].join('\n')
  d.insertPage(-1, d.addPage([0, 0, 400, 300], rotate, { XObject: { Bg: bg, Logo: logo }, Font: { F1: font } }, content))
  return d.saveToBuffer('').asUint8Array().slice()
}

const near = (a: Rect, b: Rect) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 0))

function colorAt(e: Engine, pageId: number, x: number, y: number) {
  const { pixels, width } = e.render(pageId, 1)
  const i = (Math.round(y) * width + Math.round(x)) * 4
  return [pixels[i], pixels[i + 1], pixels[i + 2]]
}
const isRed = (c: number[]) => c[0] > 200 && c[1] < 60 && c[2] < 60

describe('image editing', () => {
  it('lists, moves, replaces and deletes an image without touching the rest', () => {
    const e = new Engine()
    const s = e.open('img.pdf', imagePdf())
    const id = s.pages[0].id
    const images = e.pageImages(id)
    expect(images).toHaveLength(2)
    near(images[0].rect, [0, 0, 400, 300])
    near(images[1].rect, [20, 20, 100, 60]) // top-left page space: PDF y 240..280 -> 20..60

    expect(isRed(colorAt(e, id, 60, 40))).toBe(true)
    e.moveImage(id, 1, [200, 150, 360, 230])
    near(e.pageImages(id)[1].rect, [200, 150, 360, 230])
    expect(isRed(colorAt(e, id, 280, 190))).toBe(true)
    expect(isRed(colorAt(e, id, 60, 40))).toBe(false)

    // Replacing with a wide blue image fits it inside the old bounds.
    const blue = solid('#0000ff', 40, 10)
    e.replaceImage(id, 1, blue.asPNG())
    const replaced = e.pageImages(id)[1].rect
    expect(replaced[2] - replaced[0]).toBeCloseTo(160, 0)
    expect(replaced[3] - replaced[1]).toBeCloseTo(40, 0)
    const c = colorAt(e, id, 280, 190)
    expect(c[2] > 200 && c[0] < 60).toBe(true)

    e.deleteImage(id, 1)
    expect(e.pageImages(id)).toHaveLength(1)
    expect(e.pageText(id)).toContain('Caption text')
    // The background is still there.
    expect(colorAt(e, id, 300, 280)).toEqual([224, 240, 255])

    e.undo()
    e.undo()
    e.undo()
    near(e.pageImages(id)[1].rect, [20, 20, 100, 60])
  })

  it('works on rotated pages', () => {
    const e = new Engine()
    const s = e.open('img.pdf', imagePdf(90))
    const id = s.pages[0].id
    const before = e.pageImages(id)[1].rect
    const target: Rect = [before[0] + 30, before[1] + 40, before[2] + 30, before[3] + 40]
    e.moveImage(id, 1, target)
    near(e.pageImages(id)[1].rect, target)
    expect(isRed(colorAt(e, id, (target[0] + target[2]) / 2, (target[1] + target[3]) / 2))).toBe(true)
  })

  it('erases vector graphics in an area but keeps text and images', () => {
    const e = new Engine()
    const s = e.open('img.pdf', imagePdf())
    const id = s.pages[0].id
    // The box outline runs along PDF y=20, which is page y=280.
    const dark = (c: number[]) => c[0] < 80 && c[1] < 80 && c[2] < 80
    expect(dark(colorAt(e, id, 60, 280))).toBe(true)
    e.eraseGraphics(id, [10, 230, 130, 290])
    expect(dark(colorAt(e, id, 60, 280))).toBe(false)
    expect(e.pageText(id)).toContain('Caption text')
    expect(e.pageImages(id)).toHaveLength(2)
  })
})
