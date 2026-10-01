import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'
import { uid, type PageEntry } from './types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assets = import.meta.env.BASE_URL + 'pdfjs/'

export interface Source {
  id: string
  name: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  version: number
}

const sources = new Map<string, Source>()

async function openPdf(bytes: Uint8Array) {
  try {
    // pdf.js takes ownership of the buffer, so hand it a copy.
    return await pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: assets + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: assets + 'standard_fonts/',
    }).promise
  } catch (e) {
    if ((e as Error).name === 'PasswordException') throw new Error('Password-protected PDFs are not supported yet.')
    throw e
  }
}

export function getSource(id: string): Source {
  const s = sources.get(id)
  if (!s) throw new Error('Unknown source document')
  return s
}

/** Registers a PDF and returns one page entry per page. */
export async function addSource(name: string, bytes: Uint8Array): Promise<PageEntry[]> {
  const pdf = await openPdf(bytes)
  const id = uid()
  sources.set(id, { id, name, bytes, pdf, version: 0 })
  const entries: PageEntry[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 })
    entries.push({ id: uid(), sourceId: id, pageIndex: i, rotation: 0, width: vp.width, height: vp.height, annots: [] })
  }
  return entries
}

/** Swaps a source's bytes (e.g. after filling its form), keeping its page entries valid. */
export async function replaceSourceBytes(id: string, bytes: Uint8Array) {
  const s = getSource(id)
  const pdf = await openPdf(bytes)
  void s.pdf.destroy()
  s.bytes = bytes
  s.pdf = pdf
  s.version++
}

export function clearSources() {
  for (const s of sources.values()) void s.pdf.destroy()
  sources.clear()
}

export async function blankPdf(width = 595.28, height = 841.89): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([width, height])
  return doc.save()
}

/** Wraps an image file in a single-page PDF sized to the image. */
export async function imageToPdf(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file)
  const doc = await PDFDocument.create()
  let bytes = new Uint8Array(await file.arrayBuffer())
  const isPng = file.type === 'image/png'
  if (!isPng && file.type !== 'image/jpeg') {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'))
    bytes = new Uint8Array(await blob.arrayBuffer())
  }
  const img = isPng || file.type !== 'image/jpeg' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
  // Treat image pixels as 96 dpi.
  const w = bitmap.width * 0.75
  const h = bitmap.height * 0.75
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h })
  return doc.save()
}
