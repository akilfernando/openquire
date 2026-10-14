/**
 * High-fidelity Markdown conversion for PDF documents.
 * Reconstructs semantic structure (headings, tables, lists, code blocks,
 * bold/italic emphasis, and page markers) into clean GitHub-Flavored Markdown (GFM).
 */
import type { Table } from './tables'
import type { Metadata, Rect, TextBlock } from './types'
import type { ExportPage } from './office'
import { headingLevels } from './office'

export interface MarkdownOptions {
  /** Include YAML frontmatter with document metadata if available. Default: false */
  frontmatter?: boolean
  /** Include HTML comments identifying page numbers (e.g. `<!-- Page 1 -->`). Default: true */
  pageMarkers?: boolean
  /** Include horizontal rule page breaks (`---`) between pages. Default: false */
  pageBreaks?: boolean
  /** Include placeholder comments for embedded figures/images. Default: true */
  includeImages?: boolean
}

const inside = (r: Rect, box: Rect) => {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  return cx >= box[0] - 1 && cx <= box[2] + 1 && cy >= box[1] - 1 && cy <= box[3] + 1
}

/** Clean cell text for Markdown table syntax: escape pipes and collapse internal newlines to <br> */
function cleanTableCell(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim()
}

/** Format a detected table into GitHub-Flavored Markdown */
function formatTable(t: Table): string {
  if (!t.rows.length) return ''
  const colCount = Math.max(t.columns.length, ...t.rows.map((r) => r.cells.length))
  if (colCount === 0) return ''

  const rows = t.rows.map((r) => {
    const cells = [...r.cells]
    while (cells.length < colCount) cells.push('')
    return cells.map(cleanTableCell)
  })

  // First row is the header row
  const header = rows[0]
  const separator = Array(colCount).fill('---')
  const body = rows.slice(1)

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** Format an inline run or paragraph with bold/italic/code emphasis */
function formatInline(text: string, bold: boolean, italic: boolean, mono: boolean): string {
  let res = text.trim()
  if (!res) return ''
  if (mono) return res.includes('`') ? `\`\` ${res} \`\`` : `\`${res}\``
  if (bold && italic) return `***${res}***`
  if (bold) return `**${res}**`
  if (italic) return `*${res}*`
  return res
}

/** Determine if a line is a list item bullet and extract the bullet marker and text */
function parseBullet(text: string): { marker: string; content: string } | null {
  const trimmed = text.trim()
  // Bullet match: •, -, *, ◦, ▪, or WinAnsi mojibake â€¢
  const bulletMatch = /^(?:â€¢|[•\u2022\u25cf\u25cb\u25aa\u25ab·\-\*])\s+(.*)$/.exec(trimmed)
  if (bulletMatch) {
    return { marker: '-', content: bulletMatch[1].trim() }
  }
  // Numbered list match: 1. or 1)
  const numMatch = /^(\d+)[\.\)]\s+(.*)$/.exec(trimmed)
  if (numMatch) {
    return { marker: `${numMatch[1]}.`, content: numMatch[2].trim() }
  }
  return null
}

/** Format a text block into Markdown */
function formatBlock(b: TextBlock, heading: number): string {
  const rawText = b.text.trim()
  if (!rawText) return ''

  // Heading
  if (heading > 0) {
    const prefix = '#'.repeat(heading)
    const singleLine = rawText.replace(/\r?\n+/g, ' ')
    return `${prefix} ${singleLine}`
  }

  // Code block (monospaced multi-line)
  if (b.mono && b.lines.length > 1) {
    const code = b.lines.map((l) => l.text).join('\n')
    return `\`\`\`\n${code}\n\`\`\``
  }

  // Check if every line is a bullet item or if paragraph starts as a list
  const lines = b.lines.map((l) => l.text.trim()).filter(Boolean)
  const parsedLines = lines.map(parseBullet)
  const isAllBullets = parsedLines.length > 0 && parsedLines.every((p) => p !== null)

  if (isAllBullets) {
    return parsedLines
      .map((p) => `${p!.marker} ${p!.content}`)
      .join('\n')
  }

  // Single bullet with continuation lines
  const firstBullet = parseBullet(lines[0] || '')
  if (firstBullet && lines.length > 1) {
    const rest = lines.slice(1).join(' ')
    return `${firstBullet.marker} ${firstBullet.content} ${rest}`
  }

  // Multi-line short lines (e.g. address, poem, or broken items)
  if (b.text.includes('\n')) {
    return lines
      .map((l) => formatInline(l, b.bold, b.italic, b.mono))
      .join('  \n') // Two spaces at end of line indicates a Markdown line break
  }

  // Standard prose paragraph
  return formatInline(rawText, b.bold, b.italic, b.mono)
}

export function buildMarkdown(
  pages: ExportPage[],
  meta?: Metadata,
  options: MarkdownOptions = {}
): string {
  const {
    frontmatter = false,
    pageMarkers = true,
    pageBreaks = false,
    includeImages = true,
  } = options

  const level = headingLevels(pages)
  const chunks: string[] = []

  // Optional YAML Frontmatter
  if (frontmatter && meta && (meta.title || meta.author || meta.subject || meta.keywords)) {
    const fmLines = ['---']
    if (meta.title) fmLines.push(`title: ${JSON.stringify(meta.title)}`)
    if (meta.author) fmLines.push(`author: ${JSON.stringify(meta.author)}`)
    if (meta.subject) fmLines.push(`subject: ${JSON.stringify(meta.subject)}`)
    if (meta.keywords) fmLines.push(`keywords: ${JSON.stringify(meta.keywords)}`)
    fmLines.push('---\n')
    chunks.push(fmLines.join('\n'))
  }

  pages.forEach((page, pi) => {
    const pageNum = pi + 1
    const pageItems: { y: number; md: string }[] = []

    if (pageMarkers) {
      pageItems.push({ y: -1, md: `<!-- Page ${pageNum} -->` })
    }

    // 1. Tables
    for (const t of page.tables) {
      const tableMd = formatTable(t)
      if (tableMd) {
        pageItems.push({ y: t.bbox[1], md: tableMd })
      }
    }

    // 2. Text blocks outside tables
    const blocks = page.blocks.filter((b) => !page.tables.some((t) => inside(b.bbox, t.bbox)))
    for (const b of blocks) {
      const blockMd = formatBlock(b, level(b))
      if (blockMd) {
        pageItems.push({ y: b.bbox[1], md: blockMd })
      }
    }

    // 3. Images (figures)
    if (includeImages) {
      for (const im of page.images) {
        const w = Math.round(im.rect[2] - im.rect[0])
        const h = Math.round(im.rect[3] - im.rect[1])
        pageItems.push({ y: im.rect[1], md: `<!-- Figure (${w}x${h}pt) -->` })
      }
    }

    // Sort page items top-to-bottom
    pageItems.sort((a, b) => a.y - b.y)

    const pageContent = pageItems.map((item) => item.md).join('\n\n')
    if (pageContent) {
      chunks.push(pageContent)
    }

    if (pageBreaks && pi < pages.length - 1) {
      chunks.push('---')
    }
  })

  return chunks.join('\n\n').trim() + '\n'
}
