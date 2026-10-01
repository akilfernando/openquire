import * as pdfjs from 'pdfjs-dist'
import { zipSync } from 'fflate'
import { getSource } from './sources'
import type { PageEntry } from './types'

export async function renderPage(sourceId: string, pageIndex: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await getSource(sourceId).pdf.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
  return canvas
}

const toBytes = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Uint8Array>((res, rej) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((buf) => res(new Uint8Array(buf))) : rej(new Error('Render failed'))), type, quality),
  )

/** Renders a page to JPEG with its redaction boxes burned in, so the covered content is really gone. */
export async function rasterizeEntry(entry: PageEntry, scale: number, quality: number): Promise<Uint8Array> {
  const canvas = await renderPage(entry.sourceId, entry.pageIndex, scale)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  for (const a of entry.annots) {
    if (a.type === 'redact') ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale)
  }
  return toBytes(canvas, 'image/jpeg', quality)
}

// Thumbnails render one at a time so a large document doesn't stall the viewer.
const thumbs = new Map<string, Promise<string>>()
let queue: Promise<unknown> = Promise.resolve()

export function thumbUrl(entry: PageEntry): Promise<string> {
  const key = `${entry.sourceId}:${getSource(entry.sourceId).version}:${entry.pageIndex}`
  let p = thumbs.get(key)
  if (!p) {
    p = queue.then(async () => {
      const scale = 150 / Math.max(entry.width, entry.height)
      return (await renderPage(entry.sourceId, entry.pageIndex, scale)).toDataURL('image/jpeg', 0.7)
    })
    queue = p.catch(() => {})
    thumbs.set(key, p)
  }
  return p
}

const texts = new Map<string, Promise<string>>()

export function pageText(entry: PageEntry): Promise<string> {
  const src = getSource(entry.sourceId)
  const key = `${entry.sourceId}:${src.version}:${entry.pageIndex}`
  let p = texts.get(key)
  if (!p) {
    p = src.pdf
      .getPage(entry.pageIndex + 1)
      .then((page) => page.getTextContent())
      .then((tc) => tc.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''))
    texts.set(key, p)
  }
  return p
}

/** Renders every page of a finished PDF to PNG and returns them as a zip. */
export async function pdfToPngZip(pdfBytes: Uint8Array, baseName: string, scale = 2): Promise<Uint8Array> {
  const pdf = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise
  const files: Record<string, Uint8Array> = {}
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
    files[`${baseName}-${String(i).padStart(3, '0')}.png`] = await toBytes(canvas, 'image/png')
  }
  void pdf.destroy()
  return zipSync(files, { level: 0 })
}

export function download(bytes: Uint8Array | string, name: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

let measureCtx: CanvasRenderingContext2D | undefined
export function textWidth(text: string, size: number) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`
  return measureCtx.measureText(text).width
}
