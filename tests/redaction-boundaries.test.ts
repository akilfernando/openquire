import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { Engine } from '../src/engine/core'
import { SECRET, separateTextObjectsPdf } from './fixtures/contracts'

describe('redaction text-object boundaries', () => {
  for (const layout of ['adjacent', 'columns', 'lines'] as const) {
    it(`matches terms and patterns only across adjacent fragments: ${layout}`, async () => {
      const bytes = await separateTextObjectsPdf(layout)
      // Include extraction diagnostics in failed CI output, without customer data.
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf')
      const page = doc.loadPage(0)
      const spans = page.toStructuredText('preserve-whitespace,preserve-spans')
      const natural = page.toStructuredText('preserve-whitespace')
      const diagnostic = JSON.stringify({ spans: spans.asText(), natural: natural.asText() })
      spans.destroy()
      natural.destroy()
      page.destroy()
      doc.destroy()
      for (const mode of ['term', 'pattern'] as const) {
        const engine = new Engine()
        try {
          engine.open('fragments.pdf', bytes.slice())
          const result = mode === 'term'
            ? engine.markForRedaction([SECRET])
            : engine.markPattern('alice@example\\.com')
          expect(result.count, `${mode}: ${diagnostic}`).toBe(layout === 'adjacent' ? 1 : 0)
        } finally {
          engine.close()
        }
      }
    })
  }
})
