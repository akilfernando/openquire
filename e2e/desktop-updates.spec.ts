import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { openReport } from './fixtures'

interface UpdateMockOptions {
  initialMode?: 'notify' | 'automatic' | 'manual'
  available?: boolean
  failCheck?: boolean
  failDownload?: boolean
  failRestart?: boolean
  holdDownload?: boolean
  holdPicker?: boolean
}

async function mockDesktopUpdates(page: Page, options: UpdateMockOptions = {}) {
  await page.addInitScript((options) => {
    if (!sessionStorage.getItem('__desktopUpdatesMockInitialized')) {
      if (options.initialMode) {
        localStorage.setItem('openquire.settings', JSON.stringify({ updateMode: options.initialMode }))
      }
      sessionStorage.setItem('__desktopUpdatesMockInitialized', 'true')
    }
    const state = {
      calls: [] as { command: string; args?: any }[],
      checks: 0,
      downloads: 0,
      installs: 0,
      restarts: 0,
      resourceCloses: [] as number[],
      failCheck: options.failCheck ?? false,
      failDownload: options.failDownload ?? false,
      failRestart: options.failRestart ?? false,
      holdDownload: options.holdDownload ?? false,
      downloadRelease: null as (() => void) | null,
      holdPicker: options.holdPicker ?? false,
      pickerCalls: 0,
      pickerReturned: false,
      pickerRelease: null as (() => void) | null,
    }
    const callbacks = new Map<number, (event: any) => void>()
    let nextCallback = 1
    Object.defineProperty(window, '__desktopUpdatesMock', { configurable: true, value: state })
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback: (event: unknown) => void) {
          const id = nextCallback++
          callbacks.set(id, callback as (event: any) => void)
          return id
        },
        unregisterCallback(id: number) { callbacks.delete(id) },
        async invoke(command: string, args?: any) {
          state.calls.push({ command, args })
          if (command === 'plugin:event|listen') return nextCallback++
          if (command === 'plugin:event|unlisten' || command === 'take_opened_files') return null
          if (command === 'native_tools') return { libreoffice: null, tesseract: null, tesseract_langs: [] }
          if (command === 'plugin:dialog|open') {
            state.pickerCalls++
            if (state.holdPicker) {
              await new Promise<void>(resolve => {
                state.pickerRelease = () => { state.holdPicker = false; resolve() }
              })
            }
            state.pickerReturned = true
            return null
          }
          if (command === 'plugin:updater|check') {
            state.checks++
            if (state.failCheck) throw new Error('Injected update check failure')
            if (!(options.available ?? true)) return null
            return {
              rid: 100,
              currentVersion: '0.2.0',
              version: '0.3.0',
              date: '2026-10-18T00:00:00Z',
              body: 'A release for browser tests.',
              rawJson: '{}',
            }
          }
          if (command === 'plugin:updater|download') {
            state.downloads++
            const callbackId = Number(args?.onEvent?.id)
            const callback = callbacks.get(callbackId)
            let index = 0
            callback?.({ index: index++, message: { event: 'Started', data: { contentLength: 100 } } })
            callback?.({ index: index++, message: { event: 'Progress', data: { chunkLength: 50 } } })
            if (state.holdDownload) {
              await new Promise<void>(resolve => { state.downloadRelease = resolve })
            }
            if (state.failDownload) throw new Error('Injected updater signature verification failure')
            callback?.({ index: index++, message: { event: 'Progress', data: { chunkLength: 50 } } })
            callback?.({ index, end: true })
            return 200
          }
          if (command === 'plugin:updater|install') { state.installs++; return null }
          if (command === 'plugin:process|restart') {
            state.restarts++
            if (state.failRestart) throw new Error('Injected process restart failure')
            return null
          }
          if (command === 'plugin:resources|close') {
            state.resourceCloses.push(Number(args?.rid))
            return null
          }
          return null
        },
      },
    })
  }, options)
}

async function openAbout(page: Page, navigate = true) {
  if (navigate) await page.goto('/')
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'About', exact: true }).click()
  return { settings, updates: page.getByRole('region', { name: 'App updates' }) }
}

async function mockState(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).__desktopUpdatesMock
    return {
      checks: state.checks,
      downloads: state.downloads,
      installs: state.installs,
      restarts: state.restarts,
      hasDownloadRelease: !!state.downloadRelease,
      pickerCalls: state.pickerCalls,
      pickerReturned: state.pickerReturned,
      commands: state.calls.map((entry: { command: string }) => entry.command),
    }
  })
}

test('default notify mode reports an available update without downloading or installing', async ({ page }) => {
  await mockDesktopUpdates(page)
  const { updates } = await openAbout(page)

  await expect(updates.getByLabel('Keep OpenQuire up to date')).toHaveValue('notify')
  await expect.poll(async () => (await mockState(page)).checks).toBe(1)
  await expect(updates).toContainText('OpenQuire 0.3.0 is available.')
  const state = await mockState(page)
  expect(state.downloads).toBe(0)
  expect(state.installs).toBe(0)
  expect(state.restarts).toBe(0)
})

test('manual mode persists across reload and suppresses the startup check', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'notify', available: true })
  let { updates } = await openAbout(page)
  await updates.getByLabel('Keep OpenQuire up to date').selectOption('manual')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}').updateMode)).toBe('manual')

  await page.reload()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.locator('button[aria-label="Settings"]:visible').first().click()
  await settings.getByRole('button', { name: 'About', exact: true }).click()
  updates = page.getByRole('region', { name: 'App updates' })
  await expect(updates.getByLabel('Keep OpenQuire up to date')).toHaveValue('manual')
  await page.waitForTimeout(5_200)

  expect((await mockState(page)).checks).toBe(0)
  expect((await mockState(page)).downloads).toBe(0)
  expect((await mockState(page)).installs).toBe(0)
})

test('an explicit check can download and install when no PDF is open', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual' })
  const { updates } = await openAbout(page)

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('OpenQuire 0.3.0 is available.')
  await updates.getByRole('button', { name: 'Download and install' }).click()
  await expect.poll(async () => (await mockState(page)).restarts).toBe(1)

  const state = await mockState(page)
  expect(state.checks).toBe(1)
  expect(state.downloads).toBe(1)
  expect(state.installs).toBe(1)
  expect(state.commands).toContain('plugin:process|restart')
})

test('an open PDF blocks install until the user clicks install again after closing it', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual' })
  await openReport(page)
  await expect(page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', { name: 'Close report', exact: true })).toBeVisible()
  const { settings, updates } = await openAbout(page, false)

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('OpenQuire 0.3.0 is available.')
  await updates.getByRole('button', { name: 'Download and install' }).click()
  await expect(updates).toContainText('Close your PDFs and finish any active tasks before installing.')
  await expect(updates).toContainText('OpenQuire 0.3.0 is ready to install.')
  await expect(page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', { name: 'Close report', exact: true })).toBeVisible()
  expect((await mockState(page)).installs).toBe(0)

  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', { name: 'Close report', exact: true }).click()
  expect((await mockState(page)).installs).toBe(0)

  const reopened = await openAbout(page, false)
  const readyUpdates = reopened.updates
  await expect(readyUpdates.getByRole('button', { name: 'Install and restart' })).toBeVisible()
  await readyUpdates.getByRole('button', { name: 'Install and restart' }).click()
  await expect.poll(async () => (await mockState(page)).restarts).toBe(1)
  expect((await mockState(page)).installs).toBe(1)
})

test('download or signature verification failure reports that nothing was installed', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual', failDownload: true })
  const { updates } = await openAbout(page)

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('OpenQuire 0.3.0 is available.')
  await updates.getByRole('button', { name: 'Download and install' }).click()
  await expect(updates).toContainText('The update could not be downloaded or verified. Nothing was installed.')

  const state = await mockState(page)
  expect(state.downloads).toBe(1)
  expect(state.installs).toBe(0)
  expect(state.restarts).toBe(0)
})

test('changing automatic mode during a download prevents its later automatic install', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual', holdDownload: true })
  const { updates } = await openAbout(page)
  await updates.getByLabel('Keep OpenQuire up to date').selectOption('automatic')

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('Downloading update')
  await expect.poll(async () => (await mockState(page)).hasDownloadRelease).toBe(true)
  await updates.getByLabel('Keep OpenQuire up to date').selectOption('notify')
  await page.evaluate(() => (window as any).__desktopUpdatesMock.downloadRelease())

  await expect(updates).toContainText('OpenQuire 0.3.0 is ready to install.')
  const state = await mockState(page)
  expect(state.downloads).toBe(1)
  expect(state.installs).toBe(0)
  expect(state.restarts).toBe(0)
})

test('a failed update check shows an error rather than the current-version message', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual', failCheck: true })
  const { updates } = await openAbout(page)

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('Could not check for updates. Check your connection and try again.')
  await expect(updates).not.toContainText('You’re up to date.')
  expect((await mockState(page)).checks).toBe(1)
})

test('restart failure keeps the installed update and retries only restart with Enter', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual', failRestart: true })
  const { updates } = await openAbout(page)

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect(updates).toContainText('OpenQuire 0.3.0 is available.')
  await updates.getByRole('button', { name: 'Download and install' }).click()

  const restartDialog = page.getByRole('dialog', { name: 'Restart to finish updating' })
  await expect(restartDialog).toBeVisible()
  await expect(restartDialog).toContainText('The update is installed. Restart OpenQuire to finish.')
  const state = await mockState(page)
  expect(state.installs).toBe(1)
  expect(state.restarts).toBe(1)

  await page.evaluate(() => { (window as any).__desktopUpdatesMock.failRestart = false })
  const restartButton = restartDialog.getByRole('button', { name: 'Restart OpenQuire', exact: true })
  await restartButton.focus()
  await restartButton.press('Enter')
  await expect.poll(async () => (await mockState(page)).restarts).toBe(2)
  expect((await mockState(page)).installs).toBe(1)
})

test('About update controls remain usable and accessible at mobile width', async ({ page }) => {
  await mockDesktopUpdates(page, { initialMode: 'manual' })
  await page.setViewportSize({ width: 390, height: 844 })
  const { updates } = await openAbout(page)

  await expect(updates.getByLabel('Keep OpenQuire up to date')).toBeVisible()
  await expect(updates.getByRole('button', { name: 'Check for updates' })).toBeVisible()
  expect(await updates.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const axe = await new AxeBuilder({ page }).include('.update-settings').withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(axe.violations).toEqual([])
})

test('automatic install waits for an open native file picker and retries on the next timer after cancellation', async ({ page }) => {
  await page.clock.install()
  await mockDesktopUpdates(page, { initialMode: 'manual', holdDownload: true, holdPicker: true })
  const { settings, updates } = await openAbout(page)
  // Consume the initial five-second startup tick while manual mode is selected.
  await page.clock.fastForward(5_000)
  await updates.getByLabel('Keep OpenQuire up to date').selectOption('automatic')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('openquire.settings') ?? '{}').updateMode)).toBe('automatic')

  await updates.getByRole('button', { name: 'Check for updates' }).click()
  await expect.poll(async () => (await mockState(page)).hasDownloadRelease).toBe(true)
  await settings.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('main', { name: 'Make more of your PDFs.' }).getByRole('button', { name: /Open a file/ }).click()
  await expect.poll(async () => (await mockState(page)).pickerCalls).toBe(1)
  await page.evaluate(() => (window as any).__desktopUpdatesMock.downloadRelease())
  await expect(page.getByRole('status', { name: 'App update' })).toContainText('OpenQuire 0.3.0 is ready to install')
  expect((await mockState(page)).installs).toBe(0)
  expect((await mockState(page)).restarts).toBe(0)

  await page.evaluate(() => (window as any).__desktopUpdatesMock.pickerRelease())
  await expect.poll(async () => (await mockState(page)).pickerReturned).toBe(true)
  // The startup timer has already fired; advance to the 30-second interval without wall-clock waiting.
  await page.clock.fastForward(30_000)
  await expect.poll(async () => (await mockState(page)).restarts).toBe(1)
  expect((await mockState(page)).installs).toBe(1)
})
