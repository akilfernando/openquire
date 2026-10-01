import { isDesktop, saveAs } from './native'
import type { DocState, PageInfo, Point, Quad, Rect } from './engine/types'

export function download(bytes: Uint8Array | string, name: string, type = 'application/pdf') {
  // The desktop app saves with a native dialog instead of downloading.
  if (isDesktop) return void saveAs(name, bytes)
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`)

export const quadPoints = (q: Quad) => `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`

export const normRect = (a: Point, b: Point): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]

/** Re-encodes any browser-readable image as PNG, capped in size. */
export async function imageToPng(file: Blob, maxDim = 1600): Promise<{ png: Uint8Array; aspect: number }> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * k)
  canvas.height = Math.round(bmp.height * k)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return { png: await canvasPng(canvas), aspect: bmp.width / bmp.height }
}

export const canvasPng = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((res, rej) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((buf) => res(new Uint8Array(buf))) : rej(new Error('Image encoding failed'))), 'image/png'),
  )

export const pageIndex = (doc: DocState, id: number) => doc.pages.findIndex((p) => p.id === id)

export const isResizable = (type: string) => ['Square', 'Circle', 'Stamp', 'Redact'].includes(type)

export type { PageInfo }
