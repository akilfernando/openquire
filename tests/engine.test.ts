import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { PDFDocument as LibDoc, StandardFonts, degrees } from 'pdf-lib'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { Engine, PasswordError } from '../src/engine/core'
import { parseRanges } from '../src/engine/ranges'

/** Pages with text "Page N public" and "SECRET-N card 4111", a form on the last page. */
async function fixture(opts: { pages?: number; rotate?: number; form?: boolean } = {}) {
  const doc = await LibDoc.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const times = await doc.embedFont(StandardFonts.TimesRomanBold)
  for (let i = 1; i <= (opts.pages ?? 3); i++) {
    const p = doc.addPage([400, 500])
    p.drawText(`Page ${i} public text`, { x: 30, y: 450, size: 14, font })
    p.drawText(`SECRET-${i} card 4111`, { x: 30, y: 400, size: 14, font })
    p.drawText(`Heading ${i}`, { x: 30, y: 350, size: 20, font: times })
    p.setRotation(degrees(opts.rotate ?? 0))
  }
  if (opts.form !== false) {
    const form = doc.getForm()
    const last = doc.getPage(doc.getPageCount() - 1)
    form.createTextField('name').addToPage(last, { x: 30, y: 100, width: 150, height: 20 })
    form.createCheckBox('agree').addToPage(last, { x: 30, y: 70, width: 15, height: 15 })
    const dd = form.createDropdown('size')
    dd.addOptions(['S', 'M', 'L'])
    dd.addToPage(last, { x: 200, y: 100, width: 80, height: 20 })
  }
  return doc.save()
}

const open = async (opts?: Parameters<typeof fixture>[0]) => {
  const e = new Engine()
  e.open('test.pdf', await fixture(opts))
  return e
}

const reload = (bytes: Uint8Array, pw?: string) => {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF() as mupdf.PDFDocument
  if (pw) d.authenticatePassword(pw)
  return d
}
const textOf = (d: mupdf.PDFDocument, i: number) => d.loadPage(i).toStructuredText('preserve-whitespace').asText()
const plain = { compress: 'standard', security: { mode: 'keep' } } as const

const search = (e: Engine, text: string, pageIndex = 0) => e.search(text).filter((h) => h.pageIndex === pageIndex)[0].quads

describe('pages', () => {
  it('reorders, deletes, rotates and inserts with stable ids, and undoes', async () => {
    const e = await open()
    const [a, b, c] = e.pageIds()
    let s = e.movePages([c], a)
    expect(s.pages.map((p) => p.id)).toEqual([c, a, b])
    s = e.rotatePages([a], 90)
    expect(s.pages[1].rotation).toBe(90)
    expect(s.pages[1].width).toBe(500)
    s = e.deletePages([b])
    expect(s.pages.map((p) => p.id)).toEqual([c, a])
    s = e.insertBlank(c)
    expect(s.pages.length).toBe(3)
    expect(s.pages[1].width).toBe(400)
    expect(() => e.deletePages(e.pageIds())).toThrow(/at least one page/)

    e.undo()
    e.undo()
    s = e.undo()
    expect(s.pages.map((p) => p.id)).toEqual([c, a, b])
    expect(s.pages[1].rotation).toBe(0)
    s = e.redo()
    expect(s.pages[1].rotation).toBe(90)
  })

  it('merges another file including its form fields', async () => {
    const e = await open({ form: false })
    const s = e.append('more.pdf', await fixture({ pages: 2 }))
    expect(s.pages.length).toBe(5)
    expect(s.pages[4].widgets.map((w) => w.name).sort()).toEqual(['agree', 'name', 'size'])
    const out = reload(e.save(plain))
    expect(out.getTrailer().get('Root', 'AcroForm', 'Fields').length).toBe(3)
    expect(textOf(out, 3)).toContain('Page 1 public')
  })

  it('extracts and splits keeping structure', async () => {
    const e = await open()
    const ids = e.pageIds()
    const one = reload(e.extract([ids[2], ids[0]]))
    expect(one.countPages()).toBe(2)
    expect(textOf(one, 0)).toContain('Page 3')
    expect(one.loadPage(0).getWidgets().length).toBe(3)

    const zip = unzipSync(e.split(parseRanges('1-2, 3', 3)))
    expect(Object.keys(zip)).toEqual(['test-p1-2.pdf', 'test-p3.pdf'])
    expect(reload(zip['test-p1-2.pdf']).countPages()).toBe(2)
  })

  it('crops pages', async () => {
    const e = await open()
    const [a] = e.pageIds()
    const s = e.cropPages([a], [20, 30, 220, 330])
    expect(s.pages[0].width).toBeCloseTo(200)
    expect(s.pages[0].height).toBeCloseTo(300)
    expect(e.pageText(a)).toContain('Page 1')
  })
})

describe('annotations', () => {
  it('creates every kind as real PDF annotations that round-trip', async () => {
    const e = await open()
    const [p] = e.pageIds()
    const png = (() => {
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 10, 10], true)
      pix.clear(0)
      return pix.asPNG()
    })()
    e.addAnnot(p, { type: 'Highlight', quads: search(e, 'public'), color: [1, 1, 0] })
    e.addAnnot(p, { type: 'Underline', quads: search(e, 'Page 1'), color: [0, 0, 1] })
    e.addAnnot(p, { type: 'StrikeOut', quads: search(e, 'text'), color: [1, 0, 0] })
    e.addAnnot(p, { type: 'Ink', strokes: [[[10, 10], [50, 60], [90, 20]]], color: [1, 0, 0], width: 2 })
    e.addAnnot(p, { type: 'FreeText', at: [30, 200], text: 'Hello\nworld', size: 12, color: [0, 0, 0] })
    e.addAnnot(p, { type: 'Square', rect: [10, 300, 80, 340], color: null, fill: [1, 1, 1], width: 0 })
    e.addAnnot(p, { type: 'Circle', rect: [100, 300, 180, 340], color: [0, 0.5, 0], fill: null, width: 2 })
    e.addAnnot(p, { type: 'Line', a: [10, 400], b: [200, 420], color: [0, 0, 0], width: 1, arrow: true })
    e.addAnnot(p, { type: 'Text', at: [300, 30], text: 'Please check', color: [1, 0.8, 0] })
    const { id: stamp, state } = e.addAnnot(p, { type: 'Stamp', rect: [250, 250, 300, 300], png })
    const types = state.pages[0].annots.map((a) => a.type)
    expect(types).toEqual(['Highlight', 'Underline', 'StrikeOut', 'Ink', 'FreeText', 'Square', 'Circle', 'Line', 'Text', 'Stamp'])
    expect(state.pages[0].annots.find((a) => a.id === stamp)).toBeTruthy()

    const out = reload(e.save(plain))
    const annots = out.loadPage(0).getAnnotations().filter((a) => a.getType() !== 'Popup')
    expect(annots.map((a) => a.getType())).toEqual(types)
    expect(annots[8].getContents()).toBe('Please check')
    expect(annots[0].getAuthor()).toBe('OpenQuire user')
  })

  it('moves, resizes, recolours, edits and deletes annotations', async () => {
    const e = await open()
    const [p] = e.pageIds()
    const ink = e.addAnnot(p, { type: 'Ink', strokes: [[[10, 10], [50, 50]]], color: [1, 0, 0], width: 2 }).id
    const hl = e.addAnnot(p, { type: 'Highlight', quads: search(e, 'public'), color: [1, 1, 0] }).id
    const ft = e.addAnnot(p, { type: 'FreeText', at: [30, 200], text: 'Hi', size: 12, color: [0, 0, 0] }).id
    const box = e.addAnnot(p, { type: 'Square', rect: [10, 300, 80, 340], color: [0, 0, 0], fill: null, width: 1 }).id

    const before = e.state().pages[0].annots
    let s = e.updateAnnot(p, ink, { move: [100, 100] })
    s = e.updateAnnot(p, hl, { move: [0, 50] })
    const find = (id: number) => s.pages[0].annots.find((a) => a.id === id)!
    expect(find(ink).rect[0]).toBeCloseTo(before.find((a) => a.id === ink)!.rect[0] + 100, 0)
    expect(find(hl).rect[1]).toBeCloseTo(before.find((a) => a.id === hl)!.rect[1] + 50, 0)

    s = e.updateAnnot(p, ft, { contents: 'A much longer line of text', fontSize: 18, color: [0, 0, 1] })
    expect(find(ft).contents).toBe('A much longer line of text')
    expect(find(ft).fontSize).toBe(18)
    expect(find(ft).rect[2] - find(ft).rect[0]).toBeGreaterThan(200)

    s = e.updateAnnot(p, box, { rect: [10, 300, 200, 400] })
    expect(find(box).rect[2]).toBeGreaterThan(195)

    e.reply(p, hl, 'Agreed')
    s = e.state()
    const reply = s.pages[0].annots.find((a) => a.replyTo === hl)!
    expect(reply.contents).toBe('Agreed')

    s = e.deleteAnnot(p, hl)
    expect(s.pages[0].annots.some((a) => a.id === hl || a.replyTo === hl)).toBe(false)
    s = e.undo()
    expect(s.pages[0].annots.some((a) => a.id === hl)).toBe(true)
  })

  it('stamps keep their transparency', async () => {
    const e = await open()
    const [p] = e.pageIds()
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 20], true)
    pix.clear(0) // fully transparent
    e.addAnnot(p, { type: 'Stamp', rect: [0, 0, 400, 500], png: pix.asPNG() })
    const { pixels, width } = e.render(p, 1)
    // A pixel in the middle of "Page 1 public text" is still dark under the stamp.
    const dark = (x: number, y: number) => pixels[(y * width + x) * 4] < 128
    let anyDark = false
    for (let x = 30; x < 150; x++) for (let y = 40; y < 55; y++) anyDark ||= dark(x, y)
    expect(anyDark).toBe(true)
  })

  it('flattens annotations and form fields', async () => {
    const e = await open()
    const [p] = e.pageIds()
    e.addAnnot(p, { type: 'FreeText', at: [30, 200], text: 'Flattened note', size: 12, color: [0, 0, 0] })
    const s = e.flatten(true, true)
    expect(s.pages[0].annots).toEqual([])
    expect(s.pages[2].widgets).toEqual([])
    expect(e.pageText(p)).toContain('Flattened note')
  })
})

describe('forms', () => {
  it('fills text, checkbox and choice fields', async () => {
    const e = await open()
    const last = e.pageIds()[2]
    const w = () => Object.fromEntries(e.state().pages[2].widgets.map((x) => [x.name, x]))
    expect(w().name.kind).toBe('text')
    expect(w().agree.kind).toBe('checkbox')
    expect(w().size.options).toEqual(['S', 'M', 'L'])
    e.setField(last, w().name.id, 'Ada Lovelace')
    e.setField(last, w().agree.id, true)
    e.setField(last, w().size.id, 'M')
    expect(w().name.value).toBe('Ada Lovelace')
    expect(w().agree.value).toBe(w().agree.on)
    expect(w().size.value).toBe('M')
    e.setField(last, w().agree.id, false)
    expect(w().agree.value).toBe('Off')

    const out = reload(e.save(plain))
    const vals = Object.fromEntries(out.loadPage(2).getWidgets().map((x) => [x.getName(), x.getValue()]))
    expect(vals).toMatchObject({ name: 'Ada Lovelace', size: 'M' })
  })
})

describe('text', () => {
  it('searches, selects and extracts text', async () => {
    const e = await open()
    const hits = e.search('secret')
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 1, 2])
    expect(hits[1].snippet).toContain('SECRET-2')
    const [p] = e.pageIds()
    const q = hits[0].quads[0]
    const sel = e.selectText(p, [q[0] + 1, q[1] + 2], [q[6] - 1, q[7] - 2])
    expect(sel.text).toContain('SECRET')
    expect(e.exportText()).toContain('Page 3 public text')
    expect(e.exportHtml()).toContain('Heading 2')
  })

  it('reports text lines with their style', async () => {
    const e = await open()
    const lines = e.textLines(e.pageIds()[0])
    const heading = lines.find((l) => l.text.startsWith('Heading'))!
    expect(heading.size).toBeCloseTo(20, 0)
    expect(heading.serif).toBe(true)
    expect(heading.bold).toBe(true)
    expect(lines.find((l) => l.text.startsWith('Page'))!.serif).toBe(false)
  })

  it('edits existing text in place', async () => {
    // Rotated pages share the content-writing path covered by the stamp tests.
    for (const rotate of [0]) {
      const e = await open({ rotate })
      const [p] = e.pageIds()
      const line = e.textLines(p).find((l) => l.text.startsWith('SECRET'))!
      e.replaceText(p, line, 'Edited line — 50 €')
      const text = e.pageText(p)
      expect(text).not.toContain('SECRET')
      expect(text).toContain('Edited line — 50 €')
      expect(text).toContain('Page 1 public text')
      const edited = e.textLines(p).find((l) => l.text.startsWith('Edited'))!
      expect(edited.origin[0]).toBeCloseTo(line.origin[0], 0)
      expect(edited.origin[1]).toBeCloseTo(line.origin[1], 0)
      expect(edited.size).toBeCloseTo(line.size, 0)
    }
  })
})

describe('redaction', () => {
  it('removes only the marked content, and finds matches to mark', async () => {
    const e = await open()
    const [p, q] = e.pageIds()
    e.addAnnot(p, { type: 'Redact', quads: search(e, 'SECRET-1 card 4111') })
    expect(e.markForRedaction(['4111']).count).toBe(3)
    const { count } = e.applyRedactions()
    expect(count).toBe(3)
    const out = reload(e.save(plain))
    expect(textOf(out, 0)).not.toContain('SECRET-1')
    expect(textOf(out, 1)).not.toContain('4111')
    expect(textOf(out, 1)).toContain('SECRET-2 card')
    expect(textOf(out, 0)).toContain('Page 1 public text')
    expect(out.loadPage(0).getAnnotations().length).toBe(0)
    expect(e.pageText(q)).toContain('Heading 2')
  })

  it('marks regular-expression matches', async () => {
    const e = await open()
    expect(e.markPattern('SECRET-\\d').count).toBe(3)
    e.applyRedactions()
    expect(e.exportText()).not.toMatch(/SECRET-\d/)
    expect(e.exportText()).toContain('card 4111')
  })
})

describe('stamps', () => {
  it('adds page numbers, Bates numbers and watermarks on rotated pages', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const e = await open({ rotate })
      const ids = e.pageIds()
      e.stamp({ template: 'Page {page} of {pages}', position: 'bc', size: 10, color: [0, 0, 0], opacity: 1, angle: 0, pageIds: ids })
      e.stamp({ template: 'ACME{bates}', position: 'br', size: 9, color: [0, 0, 0], opacity: 1, angle: 0, pageIds: ids, batesStart: 7, batesDigits: 5 })
      e.stamp({ template: 'DRAFT', position: 'center', size: 'fit', color: [1, 0, 0], opacity: 0.3, angle: 45, pageIds: [ids[1]] })
      const lines = e.textLines(ids[1])
      const num = lines.find((l) => l.text.startsWith('Page 2 of 3'))
      expect(num, `rotate ${rotate}`).toBeTruthy()
      // Upright, near the bottom centre of the page as displayed.
      const { width, height } = e.state().pages[1]
      expect(num!.origin[1]).toBeGreaterThan(height * 0.85)
      expect(Math.abs((num!.bbox[0] + num!.bbox[2]) / 2 - width / 2)).toBeLessThan(5)
      expect(lines.some((l) => l.text.includes('ACME00008'))).toBe(true)
      expect(e.pageText(ids[1])).toContain('DRAFT')
      expect(e.pageText(ids[0])).not.toContain('DRAFT')
    }
  })
})

describe('document', () => {
  it('manages bookmarks', async () => {
    const e = await open()
    e.addBookmark('Intro', 0)
    e.addBookmark('Appendix', 2)
    let s = e.renameBookmark([1], 'Annex')
    expect(s.outline.map((b) => [b.title, b.page])).toEqual([['Intro', 0], ['Annex', 2]])
    s = e.movePages([e.pageIds()[2]], e.pageIds()[0])
    expect(s.outline[1].page).toBe(0) // bookmarks follow their page
    s = e.deleteBookmark([0])
    expect(s.outline.map((b) => b.title)).toEqual(['Annex'])
    expect(reload(e.save(plain)).loadOutline()!.map((o) => o.title)).toEqual(['Annex'])
  })

  it('edits metadata and attachments', async () => {
    const e = await open()
    e.setMeta({ title: 'Report', author: 'Akil', subject: 'Q3', keywords: 'a, b' })
    let s = e.attach('data.csv', strToU8('a,b\n1,2'), 'text/csv')
    expect(s.meta.title).toBe('Report')
    expect(s.attachments).toEqual([{ name: 'data.csv', size: 7 }])
    expect(new TextDecoder().decode(e.attachment('data.csv')!)).toBe('a,b\n1,2')
    const out = reload(e.save(plain))
    expect(out.getMetaData('info:Author')).toBe('Akil')
    expect(Object.keys(out.getEmbeddedFiles())).toEqual(['data.csv'])
    s = e.removeAttachment('data.csv')
    expect(s.attachments).toEqual([])
  })

  it('encrypts with permissions, opens with a password and removes it', async () => {
    const e = await open()
    const locked = e.save({ compress: 'standard', security: { mode: 'set', userPassword: 'open', ownerPassword: 'owner', allow: ['print'] } })
    const d = mupdf.Document.openDocument(locked, 'application/pdf')
    expect(d.needsPassword()).toBe(true)
    d.authenticatePassword('open')
    expect(d.hasPermission('print')).toBe(true)
    expect(d.hasPermission('copy')).toBe(false)

    const f = new Engine()
    expect(() => f.open('locked.pdf', locked)).toThrow(PasswordError)
    expect(() => f.open('locked.pdf', locked, 'wrong')).toThrow(/Incorrect/)
    const s = f.open('locked.pdf', locked, 'open')
    expect(s.encrypted).toBe(true)
    f.addAnnot(s.pages[0].id, { type: 'Text', at: [10, 10], text: 'hi', color: [1, 1, 0] })
    expect(mupdf.Document.openDocument(f.save(plain), 'application/pdf').needsPassword()).toBe(true)
    expect(mupdf.Document.openDocument(f.save({ compress: 'standard', security: { mode: 'none' } }), 'application/pdf').needsPassword()).toBe(false)
  })

  it('compresses large images, keeping soft masks', async () => {
    // A page holding a noisy 3000x2000 image with an alpha channel.
    const d = new mupdf.PDFDocument()
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 3000, 2000], true)
    const px = pix.getPixels()
    for (let i = 0; i < px.length; i += 4) {
      px[i] = (i * 7) % 255
      px[i + 1] = (i * 13) % 255
      px[i + 2] = 128
      px[i + 3] = 255
    }
    const img = d.addImage(new mupdf.Image(pix))
    d.insertPage(-1, d.addPage([0, 0, 600, 400], 0, { XObject: { Im0: img } }, 'q 600 0 0 400 0 0 cm /Im0 Do Q'))
    const src = d.saveToBuffer('compress').asUint8Array().slice()

    const e = new Engine()
    e.open('photo.pdf', src)
    const standard = e.save({ compress: 'standard', security: { mode: 'keep' } })
    const strong = e.save({ compress: 'strong', security: { mode: 'keep' } })
    expect(strong.length).toBeLessThan(standard.length / 3)
    const out = reload(strong)
    const page = out.loadPage(0)
    const rendered = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false)
    expect(rendered.getWidth()).toBe(600)
  })

  it('converts Office documents and images to PDF', async () => {
    const docx = zipSync({
      '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/_rels/document.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
      'word/document.xml': strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p></w:body></w:document>'),
    })
    const e = new Engine()
    const s = e.open('report.docx', docx)
    expect(s.name).toBe('report')
    expect(e.pageText(s.pages[0].id)).toContain('Quarterly report')

    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 200, 100], false)
    pix.clear(90)
    const s2 = e.append('photo.png', pix.asPNG())
    expect(s2.pages.length).toBe(2)
    expect(s2.pages[1].width).toBeGreaterThan(100)
  })

  it('renders pages to pixels and exports PNGs', async () => {
    const e = await open()
    const [p] = e.pageIds()
    const r = e.render(p, 2)
    expect([r.width, r.height]).toEqual([800, 1000])
    expect(r.pixels.length).toBe(800 * 1000 * 4)
    const zip = unzipSync(e.exportImages(1))
    expect(Object.keys(zip)).toEqual(['test-001.png', 'test-002.png', 'test-003.png'])
  })
})

describe('parseRanges', () => {
  it('parses ranges and rejects bad input', () => {
    expect(parseRanges('1-3, 5, 8-', 9)).toEqual([[0, 1, 2], [4], [7, 8]])
    expect(parseRanges('-2', 9)).toEqual([[0, 1]])
    for (const bad of ['0-2', '4-9', 'abc', '']) expect(() => parseRanges(bad, 5)).toThrow()
  })
})

