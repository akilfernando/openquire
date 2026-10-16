import { expect, test, type Page } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { bytesOf, openFile, openReport, reportPdf } from './fixtures'

async function editName(page: Page, name: string) {
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.widget.text').fill(name)
  await page.locator('.widget.text').press('Enter')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
}

async function savedName(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes)).getForm().getTextField('full_name').getText()
}

async function beforeUnloadPrevented(page: Page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
}

// Delay only delivery of the save response, after the worker captured its bytes.
// This keeps the real engine and UI in use while making the race deterministic.
async function delaySaveResponses(page: Page) {
  await page.addInitScript(() => {
    const RealWorker = window.Worker
    const state = globalThis as unknown as {
      holdSave: boolean; snapshotReady: boolean; releaseSave: () => void
    }
    state.holdSave = false
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        let handler: ((event: MessageEvent) => void) | null = null
        const saveIds = new Set<number>()
        const held: MessageEvent[] = []
        Object.defineProperty(this, 'onmessage', { get: () => handler, set: (value) => { handler = value } })
        super.addEventListener('message', (event) => {
          if (state.holdSave && saveIds.has(event.data.id)) {
            held.push(event)
            state.snapshotReady = true
          } else handler?.(event)
        })
        const post = this.postMessage.bind(this)
        this.postMessage = ((message: { id: number; method: string }, transfer?: Transferable[]) => {
          if (message.method === 'saveSnapshot') saveIds.add(message.id)
          post(message, transfer ?? [])
        }) as typeof this.postMessage
        state.releaseSave = () => {
          state.holdSave = false
          for (const event of held.splice(0)) handler?.(event)
        }
      }
    }
  })
}

test('Keep editing preserves changes; Discard closes only the requested tab', async ({ page }) => {
  await openReport(page)
  await editName(page, 'Ada Lovelace')
  const tabs = page.getByRole('navigation', { name: 'Open documents' })
  await tabs.getByRole('button', { name: 'Close report', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing' }).click()
  await expect(page.locator('.widget.text')).toHaveValue('Ada Lovelace')
  await tabs.getByRole('button', { name: 'Close report', exact: true }).click()
  await dialog.getByRole('button', { name: 'Discard changes' }).click()
  await expect(tabs.getByRole('button', { name: 'Close report', exact: true })).toHaveCount(0)
})

test('Save and close downloads the edited document before removing the tab', async ({ page }) => {
  await openReport(page)
  await editName(page, 'Ada Lovelace')
  await page.getByRole('button', { name: 'Close report', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save and close' }).click()
  expect(await savedName(await bytesOf(await download))).toBe('Ada Lovelace')
  await expect(page.getByRole('button', { name: 'Close report', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toHaveCount(0)
})

test('a save targets its original document after the user switches tabs', async ({ page }) => {
  await delaySaveResponses(page)
  await openReport(page)
  await editName(page, 'Original document')
  await openFile(page, 'other.pdf', await reportPdf())
  const tabs = page.getByRole('navigation', { name: 'Open documents' })
  await tabs.locator('.tab-title').filter({ hasText: 'report' }).click()
  await page.evaluate(() => { (globalThis as unknown as { holdSave: boolean }).holdSave = true })
  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { snapshotReady: boolean }).snapshotReady)).toBe(true)
  await tabs.getByRole('button', { name: 'other', exact: true }).click()
  await expect(tabs.getByRole('button', { name: 'other', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.evaluate(() => (globalThis as unknown as { releaseSave: () => void }).releaseSave())
  const file = await download
  expect(file.suggestedFilename()).toBe('report.pdf')
  expect(await savedName(await bytesOf(file))).toBe('Original document')
  await expect(tabs.getByRole('button', { name: 'other', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await expect(page.locator('.widget.text')).toHaveValue('')
})

test('edits made after a save snapshot remain unsaved', async ({ page }) => {
  await delaySaveResponses(page)
  await openReport(page)
  await editName(page, 'First revision')
  await page.evaluate(() => { (globalThis as unknown as { holdSave: boolean }).holdSave = true })
  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { snapshotReady: boolean }).snapshotReady)).toBe(true)
  await editName(page, 'Later revision')
  await page.evaluate(() => (globalThis as unknown as { releaseSave: () => void }).releaseSave())
  expect(await savedName(await bytesOf(await download))).toBe('First revision')
  await expect(page.locator('.widget.text')).toHaveValue('Later revision')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
  await page.getByRole('button', { name: 'Close report', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Unsaved changes' })).toBeVisible()
})

test('a failed download leaves the document open and dirty', async ({ page }) => {
  await openReport(page)
  await editName(page, 'Keep this edit')
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('Injected output failure') } })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.status-bar')).toContainText('Injected output failure')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
  await expect(page.locator('.widget.text')).toHaveValue('Keep this edit')
})

test('beforeunload is prevented for dirty documents and allowed at the saved revision', async ({ page }) => {
  await openReport(page)
  expect(await beforeUnloadPrevented(page)).toBe(false)

  await editName(page, 'Saved revision')
  expect(await beforeUnloadPrevented(page)).toBe(true)

  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  await download
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)
  expect(await beforeUnloadPrevented(page)).toBe(false)
})

test('undo back to the saved revision clears the dirty marker and redo restores it', async ({ page }) => {
  await openReport(page)
  await editName(page, 'Saved revision')

  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  await download
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)

  await editName(page, 'Later revision')
  await page.locator('.status-bar').click()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.widget.text')).toHaveValue('Saved revision')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toHaveCount(0)

  await page.keyboard.press('Control+y')
  await expect(page.locator('.widget.text')).toHaveValue('Later revision')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
})
