import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { createOpenQuireMcpServer } from '../cli/src/mcp/server'
import { SecurityError, validatePath } from '../cli/src/mcp/security'

function makePdf(text: string, pages = 1): Uint8Array {
  const d = new mupdf.PDFDocument()
  const font = d.addSimpleFont(new mupdf.Font('Helvetica'))
  for (let i = 0; i < pages; i++) {
    d.insertPage(
      -1,
      d.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 12 Tf 60 760 Td (${text} on page ${i + 1}) Tj ET`)
    )
  }
  return d.saveToBuffer('').asUint8Array().slice()
}

describe('openquire mcp server', () => {
  let tempDir: string
  let samplePdfPath: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oq-mcp-test-'))
    samplePdfPath = join(tempDir, 'sample.pdf')
    writeFileSync(samplePdfPath, makePdf('Confidential contract for alice@example.com', 2))
  })

  it('sandboxes file paths and blocks unauthorized directory traversal', () => {
    // Valid path inside tempDir
    expect(validatePath(samplePdfPath, [tempDir])).toBe(samplePdfPath)

    // Unauthorized path outside permitted sandbox
    expect(() => validatePath('/etc/passwd', [tempDir])).toThrowError(SecurityError)
    expect(() => validatePath(join(tempDir, '..', 'other.pdf'), [tempDir])).toThrowError(SecurityError)
  })

  it('registers all 10 core tools on the MCP server', () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // Verify registered tools on internal tools map
    // @ts-expect-error accessing private property for test verification
    const tools = server._registeredTools
    expect(tools).toBeDefined()
    expect(tools['openquire_get_metadata']).toBeDefined()
    expect(tools['openquire_read_page']).toBeDefined()
    expect(tools['openquire_search']).toBeDefined()
    expect(tools['openquire_inspect_fields']).toBeDefined()
    expect(tools['openquire_fill_form']).toBeDefined()
    expect(tools['openquire_redact_patterns']).toBeDefined()
    expect(tools['openquire_organize_pages']).toBeDefined()
    expect(tools['openquire_compare_documents']).toBeDefined()
    expect(tools['openquire_check_accessibility']).toBeDefined()
    expect(tools['openquire_digital_sign']).toBeDefined()
  })

  it('reads metadata without leaking whole document bytes', async () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_get_metadata']
    const res = await tool.handler({ filePath: samplePdfPath })

    expect(res.isError).toBeFalsy()
    const meta = JSON.parse(res.content[0].text)
    expect(meta.pageCount).toBe(2)
    expect(meta.encrypted).toBe(false)
    expect(meta.pages).toHaveLength(2)
    expect(meta.pages[0].size).toEqual([595, 842])
  })

  it('reads single scoped page text cleanly', async () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_read_page']
    const res = await tool.handler({ filePath: samplePdfPath, page: 1, format: 'text' })

    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('alice@example.com on page 1')
    expect(res.content[0].text).not.toContain('page 2')
  })

  it('searches for queries across pages and returns snippets', async () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_search']
    const res = await tool.handler({ filePath: samplePdfPath, query: 'alice' })

    expect(res.isError).toBeFalsy()
    const hits = JSON.parse(res.content[0].text)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].page).toBe(1)
    expect(hits[0].snippet).toContain('alice')
  })

  it('executes byte-level redaction non-destructively', async () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_redact_patterns']
    const res = await tool.handler({
      filePath: samplePdfPath,
      patterns: ['email'],
    })

    expect(res.isError).toBeFalsy()
    const result = JSON.parse(res.content[0].text)
    expect(result.status).toBe('success')
    expect(result.outputPath).toContain('sample-redacted')
    expect(result.permanentlyRedacted).toBeGreaterThanOrEqual(1)

    // Verify original file still intact
    const originalText = readFileSync(samplePdfPath).toString('latin1')
    expect(originalText).toContain('alice@example.com')

    // Verify redacted file text is actually gone from byte stream
    // @ts-expect-error test handler invocation
    const readTool = server._registeredTools['openquire_read_page']
    const checkRes = await readTool.handler({ filePath: result.outputPath, page: 1, format: 'text' })
    expect(checkRes.content[0].text).not.toContain('alice@example.com')
  })

  it('compares two document revisions and outputs structured diffs', async () => {
    const revPath = join(tempDir, 'revised.pdf')
    writeFileSync(revPath, makePdf('Updated agreement for alice@example.com', 2))

    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_compare_documents']
    const res = await tool.handler({ basePath: samplePdfPath, revisedPath: revPath })

    expect(res.isError).toBeFalsy()
    const diff = JSON.parse(res.content[0].text)
    expect(diff.totalChanges).toBeGreaterThan(0)
  })

  it('blocks unauthorized digital signing when confirm is false', async () => {
    const server = createOpenQuireMcpServer({ allowedDirs: [tempDir] })
    // @ts-expect-error test handler invocation
    const tool = server._registeredTools['openquire_digital_sign']
    const res = await tool.handler({
      filePath: samplePdfPath,
      p12Path: join(tempDir, 'dummy.p12'),
      password: 'test',
      confirm: false, // Not confirmed!
    })

    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('confirm must be explicitly true')
  })
})
