import { expect, test, type Page } from '@playwright/test'
import { openReport } from './fixtures'

async function recordCount(page: Page) {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('openquire_vault')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('recovery')) { db.close(); resolve(0); return }
      const tx = db.transaction('recovery', 'readonly')
      const count = tx.objectStore('recovery').count()
      tx.oncomplete = () => { db.close(); resolve(count.result) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  }))
}

async function edit(page: Page, text: string) {
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await page.locator('.widget.text').fill(text)
  await page.locator('.widget.text').press('Enter')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
}

async function consent(page: Page, enabled: boolean) {
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Privacy & Security', exact: true }).click()
  await settings.getByRole('checkbox', { name: 'Encrypted document recovery', exact: true }).setChecked(enabled)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
}

test('recovery is off by default and an explicit opt-in restores an unsaved checkpoint', async ({ page }) => {
  await openReport(page)
  await edit(page, 'Recover Ada')
  // Allow at least one scheduled checkpoint opportunity before enabling it.
  await page.waitForTimeout(3000)
  expect(await recordCount(page)).toBe(0)
  await consent(page, true)
  await expect.poll(() => recordCount(page), { timeout: 15_000 }).toBe(1)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved documents' })
  await expect(recovery).toBeVisible()
  await recovery.getByRole('button', { name: 'Restore report', exact: true }).click()
  await expect(recovery).toHaveCount(0)
  await page.locator('.page').nth(1).scrollIntoViewIfNeeded()
  await expect(page.locator('.widget.text')).toHaveValue('Recover Ada')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.keyboard.press('Control+s')
  await download
  await expect.poll(() => recordCount(page)).toBe(0)
})

test('turning recovery off removes checkpoints while keeping the edited document open', async ({ page }) => {
  await openReport(page)
  await consent(page, true)
  await edit(page, 'Keep editing locally')
  await expect.poll(() => recordCount(page), { timeout: 15_000 }).toBe(1)
  await consent(page, false)
  await expect.poll(() => recordCount(page)).toBe(0)
  await expect(page.locator('.widget.text')).toHaveValue('Keep editing locally')
  await expect(page.locator('.tab.is-active').getByLabel('Unsaved changes')).toBeVisible()
})
