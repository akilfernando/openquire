import { expect, test, type Page } from '@playwright/test'
import { LINES, openReport, pagePoint, pdfText, save } from './fixtures'

type ClipboardStub = {
  writes: string[]
  resolve: () => void
  reject: () => void
}

async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    const stub: ClipboardStub = { writes: [], resolve: () => {}, reject: () => {} }
    Object.assign(window, { clipboardStub: stub })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => new Promise<void>((resolve, reject) => {
        stub.writes.push(text)
        stub.resolve = resolve
        stub.reject = () => reject(new Error('Clipboard denied'))
      }),
    } })
  })
}

async function selectRevenue(page: Page) {
  const a = await pagePoint(page, 0, 60, 122)
  const b = await pagePoint(page, 0, 410, 122)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.selbar')).toBeVisible()
}

const state = () => (window as unknown as { clipboardStub: ClipboardStub }).clipboardStub

for (const path of ['button', 'keyboard'] as const) {
  const copy = async (page: Page) => {
    if (path === 'button') await page.locator('.selbar').getByRole('button', { name: 'Copy', exact: true }).click()
    else await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })))
  }

  test(`clipboard ${path} waits, handles rejection and retries the same selection`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await stubClipboard(page)
    await openReport(page)
    await selectRevenue(page)
    await copy(page)
    await expect.poll(() => page.evaluate(state).then(s => s.writes.length)).toBe(1)
    await expect(page.locator('.status-bar')).not.toContainText('Copied')
    await expect(page.locator('.selbar')).toBeVisible()
    await page.evaluate(() => (window as unknown as { clipboardStub: ClipboardStub }).clipboardStub.reject())
    await expect(page.locator('.status-bar')).toContainText('Could not copy')
    await expect(page.locator('.selbar')).toBeVisible()
    await copy(page)
    await expect.poll(() => page.evaluate(state).then(s => s.writes.length)).toBe(2)
    const writes = (await page.evaluate(state)).writes
    expect(writes[0]).toContain('Revenue')
    expect(writes[1]).toBe(writes[0])
    await expect(page.locator('.status-bar')).not.toContainText('Copied')
    await page.evaluate(() => (window as unknown as { clipboardStub: ClipboardStub }).clipboardStub.resolve())
    await expect(page.locator('.status-bar')).toContainText('Copied')
    await expect(page.locator('.selbar')).toHaveCount(path === 'button' ? 0 : 1)
    expect(errors).toEqual([])
    const text = pdfText(await save(page))
    for (const line of Object.values(LINES)) expect(text).toContain(line)
  })

  test(`clipboard ${path} reports unavailable API and retains selection`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }))
    await openReport(page)
    await selectRevenue(page)
    await copy(page)
    await expect(page.locator('.status-bar')).toContainText('Could not copy')
    await expect(page.locator('.selbar')).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('document copy leaves input and contenteditable shortcuts to the browser', async ({ page }) => {
  await stubClipboard(page)
  await openReport(page)
  await selectRevenue(page)
  await page.keyboard.press('Control+f')
  const input = page.getByPlaceholder('Find...')
  await input.fill('ordinary input')
  await input.evaluate(el => (el as HTMLInputElement).select())
  expect(await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })))).toBe(true)
  // A synthetic editable target verifies routing without using the OS clipboard.
  expect(await page.evaluate(() => {
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    document.body.append(editable)
    const allowed = editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true }))
    editable.remove()
    return allowed
  })).toBe(true)
  expect((await page.evaluate(state)).writes).toEqual([])
  await expect(page.locator('.selbar')).toBeVisible()
})

test('an older copy completion does not replace a newer failure or clear its retry selection', async ({ page }) => {
  await stubClipboard(page)
  await openReport(page)
  await selectRevenue(page)
  const copy = page.locator('.selbar').getByRole('button', { name: 'Copy', exact: true })
  await copy.click()
  await page.evaluate(() => {
    const w = window as unknown as { clipboardStub: ClipboardStub; resolveFirst: () => void }
    w.resolveFirst = w.clipboardStub.resolve
  })
  await copy.click()
  await page.evaluate(() => (window as unknown as { clipboardStub: ClipboardStub }).clipboardStub.reject())
  await expect(page.locator('.status-bar')).toContainText('Could not copy')
  await page.evaluate(() => (window as unknown as { resolveFirst: () => void }).resolveFirst())
  await expect(page.locator('.status-bar')).toContainText('Could not copy')
  await expect(copy).toBeVisible()
  await copy.click()
  expect((await page.evaluate(state)).writes).toHaveLength(3)
  await page.evaluate(() => (window as unknown as { clipboardStub: ClipboardStub }).clipboardStub.resolve())
  await expect(page.locator('.status-bar')).toContainText('Copied')
  await expect(copy).toHaveCount(0)
})
