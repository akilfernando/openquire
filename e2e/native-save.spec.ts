import { expect, test, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { openReport } from './fixtures'

async function editName(page: Page, name: string) {
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.widget.text').fill(name)
  await page.locator('.widget.text').press('Enter')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    type NativeMock = {
      savePath: string | null
      saveCalls: number
      failWrite?: boolean
      holdWrite?: boolean
      releaseWrite?: () => void
      writes: { path: string; bytes: number[] }[]
    }
    const state: NativeMock = { savePath: null, saveCalls: 0, writes: [] }
    const callbacks = new Map<number, (event: unknown) => void>()
    let nextCallback = 1
    Object.defineProperty(window, '__nativeSaveMock', { configurable: true, value: state })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback: (event: unknown) => void) {
          const id = nextCallback++
          callbacks.set(id, callback)
          return id
        },
        unregisterCallback(id: number) { callbacks.delete(id) },
        async invoke(command: string, args?: unknown, options?: { headers?: { path?: string } }) {
          if (command === 'plugin:event|listen') return nextCallback++
          if (command === 'plugin:event|unlisten') return null
          if (command === 'take_opened_files') return []
          if (command === 'native_tools') return { libreoffice: null, tesseract: null, tesseract_langs: [] }
          if (command === 'plugin:dialog|save') {
            state.saveCalls++
            return state.savePath
          }
          if (command === 'write_file') {
            if (state.holdWrite) await new Promise<void>(resolve => { state.releaseWrite = resolve })
            if (state.failWrite) throw new Error('Injected native export failure')
            const bytes = args instanceof Uint8Array ? args : new Uint8Array(args as ArrayBuffer)
            const path = decodeURIComponent(options?.headers?.path ?? '')
            state.writes.push({ path, bytes: Array.from(bytes) })
            return null
          }
          return null
        },
      },
    })
  })

})

test('cancelled native saves preserve edits and an accepted save writes the edited PDF', async ({ page }) => {
  await openReport(page)
  await editName(page, 'Ada Lovelace')

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeSaveMock: { saveCalls: number } }).__nativeSaveMock.saveCalls)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __nativeSaveMock: { writes: unknown[] } }).__nativeSaveMock.writes)).toEqual([])
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()

  const tabs = page.getByRole('navigation', { name: 'Open documents' })
  await tabs.getByRole('button', { name: 'Close report', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Save and close' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeSaveMock: { saveCalls: number } }).__nativeSaveMock.saveCalls)).toBe(2)
  await expect(dialog).toBeVisible()
  await expect(tabs.getByRole('button', { name: 'Close report', exact: true })).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Keep editing' }).click()

  await page.evaluate(() => {
    (window as unknown as { __nativeSaveMock: { savePath: string | null } }).__nativeSaveMock.savePath = '/tmp/selected-name.pdf'
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeSaveMock: { writes: unknown[] } }).__nativeSaveMock.writes.length)).toBe(1)
  await expect(page.locator('.status-bar')).toContainText('selected-name.pdf')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)

  const saved = await page.evaluate(() => (window as unknown as { __nativeSaveMock: { writes: { path: string; bytes: number[] }[] } }).__nativeSaveMock.writes[0])
  expect(saved.path).toBe('/tmp/selected-name.pdf')
  const pdf = await PDFDocument.load(new Uint8Array(saved.bytes))
  expect(pdf.getForm().getTextField('full_name').getText()).toBe('Ada Lovelace')
})


test('native exports await writes and report cancellation or failure honestly', async ({ page }) => {
  await openReport(page)
  await page.getByRole('searchbox', { name: 'Search document tools' }).fill('export')
  const output = page.getByRole('button', { name: 'Text', exact: true })
  await output.click()
  await expect(page.locator('.status-bar [role=status]')).toHaveText('Export cancelled. No file was saved.')
  await page.evaluate(() => {
    const mock = (window as any).__nativeSaveMock
    mock.savePath = '/tmp/exported.txt'
    mock.holdWrite = true
  })
  await output.click()
  await expect.poll(() => page.evaluate(() => !!(window as any).__nativeSaveMock.releaseWrite)).toBe(true)
  await expect(page.locator('.status-bar .spin')).toBeVisible()
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })).toBe(true)
  await page.evaluate(() => (window as any).__nativeSaveMock.releaseWrite())
  await expect(page.locator('.status-bar [role=status]')).toHaveText('Export saved: exported.txt')
  const writes = await page.evaluate(() => (window as any).__nativeSaveMock.writes)
  expect(writes).toHaveLength(1)
  expect(new TextDecoder().decode(new Uint8Array(writes[0].bytes))).toContain('Quarterly Report')
  await page.evaluate(() => {
    const mock = (window as any).__nativeSaveMock
    mock.holdWrite = false
    mock.failWrite = true
  })
  await output.click()
  await expect(page.locator('.status-bar [role=status]')).toContainText('Injected native export failure')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)
})
