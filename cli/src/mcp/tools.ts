import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Engine } from '../../../src/engine/core'
import { REDACTION_PATTERNS, type PatternName } from '../../../src/engine/patterns'
import type { Change } from '../../../src/engine/compare'
import { resolveOutputPath, validatePath } from './security'

export interface McpToolOptions {
  allowedDirs?: string[]
  allowOverwrite?: boolean
}

/** Helper to run an engine action with automatic memory cleanup and zeroization */
async function withEngine<T>(
  filePath: string,
  allowedDirs: string[] | undefined,
  password: string | undefined,
  fn: (engine: Engine, absPath: string) => Promise<T> | T
): Promise<T> {
  const absPath = validatePath(filePath, allowedDirs)
  const raw = readFileSync(absPath)
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const engine = new Engine()
  try {
    engine.open(basename(absPath), bytes, password)
    return await fn(engine, absPath)
  } finally {
    try {
      engine.close()
    } catch {
      // ignore close errors during teardown
    }
    bytes.fill(0)
  }
}

export function registerOpenQuireTools(server: McpServer, options: McpToolOptions = {}) {
  const allowedDirs = options.allowedDirs

  // 1. openquire_get_metadata
  server.tool(
    'openquire_get_metadata',
    'Get structural and cryptographic metadata of a local PDF document (page count, encryption, bookmarks, form fields count, signatures).',
    {
      filePath: z.string().describe('Absolute or relative path to the local PDF file'),
      password: z.string().optional().describe('Password if the PDF is encrypted'),
    },
    async ({ filePath, password }) => {
      try {
        const result = await withEngine(filePath, allowedDirs, password, (engine) => {
          const state = engine.state()
          const a11y = engine.checkAccessibility()
          const pdfA = engine.checkPdfA()
          return {
            fileName: state.name,
            pageCount: state.pages.length,
            encrypted: state.encrypted,
            meta: state.meta,
            signatures: state.signatures.map((s) => ({
              signer: s.signer,
              valid: s.valid,
              trusted: s.trust.trusted,
              timestamped: !!s.timestamp,
            })),
            formFieldsCount: state.pages.reduce((n, p) => n + p.widgets.length, 0),
            commentsCount: state.pages.reduce((n, p) => n + p.annots.length, 0),
            attachmentsCount: state.attachments.length,
            bookmarksCount: state.outline.length,
            isPdfA: !!pdfA.part && pdfA.problems.length === 0,
            isTagged: a11y.tagged,
            pages: state.pages.map((p, idx) => ({
              pageNumber: idx + 1,
              size: [Math.round(p.width), Math.round(p.height)],
              rotation: p.rotation,
              widgetsCount: p.widgets.length,
            })),
          }
        })
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 2. openquire_read_page
  server.tool(
    'openquire_read_page',
    'Extract text from a specific page or bounding rectangle in points [x0, y0, x1, y1]. Prevents uploading the whole document into LLM context.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      page: z.number().int().min(1).describe('1-based page number'),
      rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe('Optional bounding box [x0, y0, x1, y1] in PDF points'),
      format: z.enum(['text', 'lines']).default('text').describe('Return plain text or structured lines with bounding boxes'),
      password: z.string().optional(),
    },
    async ({ filePath, page, rect, format, password }) => {
      try {
        const text = await withEngine(filePath, allowedDirs, password, async (engine) => {
          const state = engine.state()
          if (page < 1 || page > state.pages.length) {
            throw new Error(`Page ${page} is out of bounds (document has ${state.pages.length} pages)`)
          }
          const pageId = state.pages[page - 1].id
          if (format === 'lines' || rect) {
            const lines = await engine.textLines(pageId)
            const filtered = rect
              ? lines.filter((l) => l.bbox[0] >= rect[0] && l.bbox[1] >= rect[1] && l.bbox[2] <= rect[2] && l.bbox[3] <= rect[3])
              : lines
            if (format === 'lines') {
              return JSON.stringify(filtered.map((l) => ({ text: l.text, bbox: l.bbox })), null, 2)
            }
            return filtered.map((l) => l.text).join('\n')
          }
          return await engine.pageText(pageId)
        })
        return { content: [{ type: 'text', text }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 3. openquire_search
  server.tool(
    'openquire_search',
    'Search for exact text or phrases across the document, returning matching snippets and page locations.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      query: z.string().min(1).describe('Search query string'),
      maxHits: z.number().int().min(1).max(100).default(20).describe('Maximum number of search hits to return'),
      password: z.string().optional(),
    },
    async ({ filePath, query, maxHits, password }) => {
      try {
        const results = await withEngine(filePath, allowedDirs, password, async (engine) => {
          const hits = await engine.search(query)
          const state = engine.state()
          return hits.slice(0, maxHits).map((h) => {
            const pageIdx = state.pages.findIndex((p) => p.id === h.pageId)
            return {
              page: pageIdx >= 0 ? pageIdx + 1 : h.pageIndex + 1,
              snippet: h.snippet,
              quadCount: h.quads.length,
            }
          })
        })
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 4. openquire_inspect_fields
  server.tool(
    'openquire_inspect_fields',
    'Inspect interactive AcroForm fields (text fields, checkboxes, dropdowns, radio groups) with their values and coordinates.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      page: z.number().int().min(1).optional().describe('Optional 1-based page number to inspect only that page'),
      password: z.string().optional(),
    },
    async ({ filePath, page, password }) => {
      try {
        const fields = await withEngine(filePath, allowedDirs, password, (engine) => {
          const state = engine.state()
          const pages = page ? [state.pages[page - 1]].filter(Boolean) : state.pages
          return pages.flatMap((p, idx) => {
            const pageNum = page ? page : idx + 1
            return p.widgets.map((w) => ({
              page: pageNum,
              name: w.name,
              kind: w.kind,
              value: w.value,
              readOnly: w.readOnly,
              options: w.options,
              rect: w.rect,
            }))
          })
        })
        return { content: [{ type: 'text', text: JSON.stringify(fields, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 5. openquire_fill_form
  server.tool(
    'openquire_fill_form',
    'Fill interactive AcroForm fields in a PDF and save to a new non-destructive file or specified output path.',
    {
      filePath: z.string().describe('Path to the PDF file to fill'),
      values: z.record(z.string(), z.union([z.string(), z.boolean()])).describe('Dictionary of field names to values'),
      outputPath: z.string().optional().describe('Target output path; if omitted, saves to document-filled.pdf'),
      allowOverwrite: z.boolean().default(false).describe('Allow overwriting an existing output file'),
      password: z.string().optional(),
    },
    async ({ filePath, values, outputPath, allowOverwrite, password }) => {
      try {
        const out = resolveOutputPath(filePath, outputPath, 'filled', allowedDirs, allowOverwrite || options.allowOverwrite)
        const filled = await withEngine(filePath, allowedDirs, password, (engine) => {
          const state = engine.state()
          const filledList: string[] = []
          for (const [key, val] of Object.entries(values)) {
            const strVal = typeof val === 'boolean' ? (val ? 'Yes' : 'Off') : String(val)
            for (const p of state.pages) {
              const widget = p.widgets.find((w) => w.name === key)
              if (widget) {
                engine.setField(p.id, widget.id, strVal)
                filledList.push(key)
                break
              }
            }
          }
          const savedBytes = engine.save({ compress: 'medium', security: { mode: 'keep' } })
          writeFileSync(out, savedBytes)
          return filledList
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  outputPath: out,
                  filledCount: filled.length,
                  filledFields: filled,
                },
                null,
                2
              ),
            },
          ],
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 6. openquire_redact_patterns
  server.tool(
    'openquire_redact_patterns',
    'Execute permanent byte-level redaction of PII (emails, phone numbers, cards, dates) or specific search terms.',
    {
      filePath: z.string().describe('Path to the PDF file to redact'),
      patterns: z.array(z.enum(['email', 'phone', 'card', 'date', 'url'])).optional().describe('Standard PII patterns to redact'),
      terms: z.array(z.string()).optional().describe('Exact text strings or names to permanently redact'),
      outputPath: z.string().optional().describe('Target output path; if omitted, saves to document-redacted.pdf'),
      allowOverwrite: z.boolean().default(false).describe('Allow overwriting existing output file'),
      password: z.string().optional(),
    },
    async ({ filePath, patterns, terms, outputPath, allowOverwrite, password }) => {
      try {
        if (!patterns?.length && !terms?.length) {
          throw new Error('Provide at least one pattern or term to redact.')
        }
        const out = resolveOutputPath(filePath, outputPath, 'redacted', allowedDirs, allowOverwrite || options.allowOverwrite)
        const summary = await withEngine(filePath, allowedDirs, password, (engine) => {
          let marked = 0
          if (patterns) {
            for (const p of patterns) {
              marked += engine.markPattern(REDACTION_PATTERNS[p as PatternName]).count
            }
          }
          if (terms) {
            for (const t of terms) {
              marked += engine.markForRedaction([t]).count
            }
          }
          const { count } = engine.applyRedactions()
          const savedBytes = engine.save({ compress: 'medium', security: { mode: 'keep' } })
          writeFileSync(out, savedBytes)
          return { markedMatches: marked, permanentlyRedacted: count }
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'success', outputPath: out, ...summary }, null, 2),
            },
          ],
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 7. openquire_organize_pages
  server.tool(
    'openquire_organize_pages',
    'Rotate or delete pages in a PDF and save to a new file.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      rotations: z
        .array(
          z.object({
            page: z.number().int().min(1).describe('1-based page number'),
            degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]).describe('Clockwise rotation in degrees'),
          })
        )
        .optional()
        .describe('List of pages to rotate'),
      deletePages: z.array(z.number().int().min(1)).optional().describe('1-based page numbers to delete'),
      outputPath: z.string().optional().describe('Target output path; if omitted, saves to document-organized.pdf'),
      allowOverwrite: z.boolean().default(false),
      password: z.string().optional(),
    },
    async ({ filePath, rotations, deletePages, outputPath, allowOverwrite, password }) => {
      try {
        const out = resolveOutputPath(filePath, outputPath, 'organized', allowedDirs, allowOverwrite || options.allowOverwrite)
        const result = await withEngine(filePath, allowedDirs, password, (engine) => {
          const state = engine.state()
          if (rotations) {
            for (const r of rotations) {
              const p = state.pages[r.page - 1]
              if (p) engine.rotatePages([p.id], r.degrees)
            }
          }
          if (deletePages?.length) {
            const pageIds = deletePages.map((num) => state.pages[num - 1]?.id).filter((id): id is number => typeof id === 'number')
            engine.deletePages(pageIds)
          }
          const savedBytes = engine.save({ compress: 'medium', security: { mode: 'keep' } })
          writeFileSync(out, savedBytes)
          return { originalPageCount: state.pages.length, newPageCount: engine.state().pages.length }
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'success', outputPath: out, ...result }, null, 2),
            },
          ],
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 8. openquire_compare_documents
  server.tool(
    'openquire_compare_documents',
    'Compare two PDF documents (e.g. contract revisions) for text insertions, deletions, modifications and visual shifts.',
    {
      basePath: z.string().describe('Path to the base/original PDF'),
      revisedPath: z.string().describe('Path to the revised PDF'),
      password: z.string().optional(),
    },
    async ({ basePath, revisedPath, password }) => {
      try {
        const absBase = validatePath(basePath, allowedDirs)
        const absRevised = validatePath(revisedPath, allowedDirs)
        const rawBase = readFileSync(absBase)
        const rawRevised = readFileSync(absRevised)
        const baseBytes = new Uint8Array(rawBase.buffer, rawBase.byteOffset, rawBase.byteLength)
        const revisedBytes = new Uint8Array(rawRevised.buffer, rawRevised.byteOffset, rawRevised.byteLength)
        const baseEngine = new Engine()
        const revisedEngine = new Engine()
        try {
          baseEngine.open(basename(absBase), baseBytes, password)
          revisedEngine.open(basename(absRevised), revisedBytes, password)
          const diff = revisedEngine.compareWith(baseEngine)
          const summary = {
            totalChanges: diff.changes.length,
            insertions: diff.changes.filter((c: Change) => c.kind === 'insert').length,
            deletions: diff.changes.filter((c: Change) => c.kind === 'delete').length,
            modifications: diff.changes.filter((c: Change) => c.kind === 'change').length,
            movedText: diff.changes.filter((c: Change) => c.kind === 'move').length,
            visualChanges: diff.visual.length,
            addedPages: diff.addedPages,
            removedPages: diff.removedPages,
            sampleChanges: diff.changes.slice(0, 15).map((c: Change) => ({
              kind: c.kind,
              oldText: c.old?.text,
              newText: c.new?.text,
              page: (c.new?.page ?? c.old?.page ?? 0) + 1,
            })),
          }
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
        } finally {
          baseEngine.close()
          revisedEngine.close()
          baseBytes.fill(0)
          revisedBytes.fill(0)
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 9. openquire_check_accessibility
  server.tool(
    'openquire_check_accessibility',
    'Verify PDF/UA accessibility compliance, tag trees, and heading structures.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      password: z.string().optional(),
    },
    async ({ filePath, password }) => {
      try {
        const report = await withEngine(filePath, allowedDirs, password, (engine) => {
          const a11y = engine.checkAccessibility()
          return {
            isTagged: a11y.tagged,
            problemsCount: a11y.problems.length,
            errors: a11y.problems.filter((p) => p.severity === 'error').map((p) => ({ page: p.page, message: p.message })),
            warnings: a11y.problems.filter((p) => p.severity === 'warning').map((p) => ({ page: p.page, message: p.message })),
          }
        })
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 10. openquire_digital_sign (Safety-Gated)
  server.tool(
    'openquire_digital_sign',
    'Sign a document with a PKCS#12 (.p12/.pfx) digital certificate using OpenQuire zeroized Rust crypto. REQUIRES explicit confirm=true.',
    {
      filePath: z.string().describe('Path to the PDF file to sign'),
      p12Path: z.string().describe('Path to the .p12 or .pfx certificate file'),
      password: z.string().describe('Password for the .p12 certificate file'),
      confirm: z.boolean().describe('Safety gate: MUST be explicitly set to true by the user to execute legal cryptographic signing'),
      reason: z.string().optional().describe('Reason for signing (e.g. "Approved")'),
      location: z.string().optional().describe('Location of signer'),
      outputPath: z.string().optional().describe('Target output path; if omitted, saves to document-signed.pdf'),
      allowOverwrite: z.boolean().default(false),
      airGapped: z.boolean().default(true).describe('Air-gapped signing: disallows online TSA timestamping network calls'),
    },
    async ({ filePath, p12Path, password, confirm, reason, location, outputPath, allowOverwrite, airGapped }) => {
      try {
        if (!confirm) {
          throw new Error('Digital signing aborted: confirm must be explicitly true to authorize legal signing.')
        }
        const absP12 = validatePath(p12Path, allowedDirs)
        const p12Bytes = new Uint8Array(readFileSync(absP12))
        const out = resolveOutputPath(filePath, outputPath, 'signed', allowedDirs, allowOverwrite || options.allowOverwrite)

        try {
          await withEngine(filePath, allowedDirs, undefined, async (engine) => {
            await engine.sign({
              p12: p12Bytes,
              password,
              pageId: null, // invisible approval signature by default
              reason,
              location,
              airGapped,
            })
            const savedBytes = engine.save({ compress: 'medium', security: { mode: 'keep' } })
            writeFileSync(out, savedBytes)
          })
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'success', outputPath: out, signed: true, airGapped }, null, 2),
              },
            ],
          }
        } finally {
          p12Bytes.fill(0) // memory zeroization of certificate buffer
        }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )

  // 11. openquire_to_markdown
  server.tool(
    'openquire_to_markdown',
    'Convert a PDF document (or specific page range) to clean, LLM-optimized GitHub-Flavored Markdown (GFM) with preserved tables, headings, and lists.',
    {
      filePath: z.string().describe('Path to the PDF file'),
      pages: z.array(z.number().int().min(1)).optional().describe('Optional list of 1-based page numbers to extract (e.g. [1, 2, 3]). Defaults to all pages.'),
      includePageMarkers: z.boolean().default(true).describe('Include HTML comment page markers (e.g. <!-- Page 1 -->) for citation and grounding.'),
      frontmatter: z.boolean().default(false).describe('Include YAML frontmatter with title, author, and keywords.'),
      outputPath: z.string().optional().describe('Optional path to write the .md file to disk; if omitted, returns the markdown directly in the response content.'),
      allowOverwrite: z.boolean().default(false).describe('Allow overwriting existing output file when outputPath is provided.'),
      password: z.string().optional(),
    },
    async ({ filePath, pages, includePageMarkers, frontmatter, outputPath, allowOverwrite, password }) => {
      try {
        const md = await withEngine(filePath, allowedDirs, password, (engine) => {
          let pageIds: number[] | undefined
          if (pages?.length) {
            const state = engine.state()
            pageIds = pages
              .map((p) => state.pages[p - 1]?.id)
              .filter((id): id is number => typeof id === 'number')
          }
          return engine.exportMarkdown({
            pageMarkers: includePageMarkers,
            frontmatter,
            pageIds,
          })
        })

        if (outputPath) {
          const out = resolveOutputPath(filePath, outputPath, 'markdown', allowedDirs, allowOverwrite || options.allowOverwrite, '.md')
          writeFileSync(out, md, 'utf8')
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ status: 'success', outputPath: out, characterCount: md.length }, null, 2),
              },
            ],
          }
        }

        return { content: [{ type: 'text', text: md }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] }
      }
    }
  )
}

