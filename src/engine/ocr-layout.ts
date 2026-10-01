import type { OcrWord } from './types'

// The subset of Tesseract's block output that the text layer needs.
interface Box { x0: number; y0: number; x1: number; y1: number }
export interface OcrBlock {
  paragraphs: { lines: { bbox: Box; baseline: Box; words: { text: string; bbox: Box; confidence: number }[] }[] }[]
}

/** Converts Tesseract words (in image pixels) to page-space words for the text layer. */
export function wordsFromBlocks(blocks: OcrBlock[] | null, scale: number, minConfidence = 30): OcrWord[] {
  const out: OcrWord[] = []
  for (const block of blocks ?? [])
    for (const para of block.paragraphs)
      for (const line of para.lines) {
        const { baseline: b, bbox: lb } = line
        const slope = b.x1 > b.x0 ? (b.y1 - b.y0) / (b.x1 - b.x0) : 0
        // Ascender to baseline is about 0.75 em in the standard fonts.
        const size = Math.max(2, (Math.max(b.y0, b.y1) - lb.y0) / 0.75 / scale)
        for (const w of line.words) {
          if (w.confidence < minConfidence || !w.text.trim()) continue
          const baseline = (b.y0 + slope * ((w.bbox.x0 + w.bbox.x1) / 2 - b.x0)) / scale
          out.push({
            text: w.text,
            bbox: [w.bbox.x0 / scale, w.bbox.y0 / scale, w.bbox.x1 / scale, w.bbox.y1 / scale],
            baseline,
            size,
          })
        }
      }
  return out
}
