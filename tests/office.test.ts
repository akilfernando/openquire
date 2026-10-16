import { describe, expect, it } from 'vitest'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { Engine } from '../src/engine/core'
import { cellValue } from '../src/engine/office'
import { reportPdf as report } from './fixtures/report'

describe('Office export', () => {
  it('reads numbers the way a spreadsheet would', () => {
    expect(cellValue('1,250,000')).toEqual({ n: 1250000, percent: false })
    expect(cellValue('$1,200.50')).toEqual({ n: 1200.5, percent: false })
    expect(cellValue('12%')).toEqual({ n: 0.12, percent: true })
    expect(cellValue('(450)')).toEqual({ n: -450, percent: false })
    expect(cellValue('-3%')).toEqual({ n: -0.03, percent: true })
    expect(cellValue('North')).toBeNull()
    expect(cellValue('12,34')).toBeNull()
    expect(cellValue('2026-01-01')).toBeNull()
  })

  it('finds a table and not running text', () => {
    const [p1, p2] = report().tables()
    expect(p1).toHaveLength(1)
    expect(p1[0].rows.map((r) => r.cells)).toEqual([['Region', 'Revenue', 'Growth'], ['North', '1,250,000', '12%'], ['South', '980,500', '-3%'], ['West', '1,100,250', '7.5%']])
    expect(p2).toEqual([])
  })

  it('exports an editable Word document', async () => {
    const docx = report().exportDocx()
    const { value: html, messages } = await mammoth.convertToHtml({ buffer: Buffer.from(docx) })
    expect(messages.filter((m) => m.type === 'error')).toEqual([])
    expect(html).toMatch(/<h1>Quarterly Report<\/h1>/)
    expect(html).toMatch(/<h2>Results by region<\/h2>/)
    expect(html).toMatch(/<h2>Outlook<\/h2>/)
    // The two lines of the first paragraph flow into one paragraph.
    expect(html).toContain('<p>Revenue grew in every region this quarter, led by new customers in the north. Costs stayed flat, and the full figures are in the table below.</p>')
    expect(html).toMatch(/<table>.*North.*1,250,000.*12%.*<\/table>/s)
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
    // Reading order: heading, then the table, then the picture below it.
    expect(html.indexOf('Results by region')).toBeLessThan(html.indexOf('<table>'))
    expect(html.indexOf('<table>')).toBeLessThan(html.indexOf('<img'))
  })

  it('exports tables to Excel with numbers as numbers', () => {
    const xlsx = report().exportXlsx()!
    const wb = XLSX.read(xlsx, { type: 'array' })
    expect(wb.SheetNames).toEqual(['Page 1'])
    const sheet = wb.Sheets['Page 1']
    expect(sheet.A1.v).toBe('Region')
    expect(sheet.B2).toMatchObject({ t: 'n', v: 1250000 })
    expect(sheet.C3).toMatchObject({ t: 'n', v: -0.03 })
    expect(sheet.A4.v).toBe('West')
  })

  it('has no workbook when there are no tables', () => {
    const e = new Engine()
    e.newBlank()
    expect(e.exportXlsx()).toBeNull()
  })
})
