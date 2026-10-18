import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { watchWindowClose, closeNativeWindow } from '../src/native'

// Exercise the real Tauri SDK, enforcing the shipped window permissions at IPC.
const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'))
let requestClose: () => Promise<void>
let destroyed: number

beforeEach(() => {
  destroyed = 0
  const callbacks = new Map<number, (event: unknown) => Promise<void>>()
  let nextId = 1
  let closeHandler = 0
  requestClose = async () => {
    await callbacks.get(closeHandler)!({ event: 'tauri://close-requested', id: closeHandler, payload: null })
  }
  vi.stubGlobal('window', {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback: (event: unknown) => Promise<void>) {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      },
      async invoke(command: string, args: Record<string, unknown>) {
        if (command === 'plugin:event|listen') {
          expect(args.event).toBe('tauri://close-requested')
          closeHandler = args.handler as number
          return closeHandler
        }
        if (command === 'plugin:event|unlisten') return
        const operation = command.replace('plugin:window|', '')
        expect(capability.windows).toContain('main')
        expect(capability.permissions).toContain(`core:window:allow-${operation}`)
        if (operation === 'destroy') destroyed++
        else if (operation === 'close') await requestClose()
        else throw new Error(`Unexpected window command: ${command}`)
      },
    },
  })
})
afterEach(() => vi.unstubAllGlobals())

it('allows the title-bar close request to destroy a clean window', async () => {
  const prompt = vi.fn()
  const stop = await watchWindowClose(() => false, prompt)
  await requestClose()
  expect(destroyed).toBe(1)
  expect(prompt).not.toHaveBeenCalled()
  stop()
})

it('keeps a guarded window open until the app explicitly allows closing', async () => {
  let guarded = true
  const prompt = vi.fn()
  await watchWindowClose(() => guarded, prompt)
  await requestClose()
  expect(prompt).toHaveBeenCalledOnce()
  expect(destroyed).toBe(0)
  // Keep editing (or an operation still running): repeated requests remain guarded.
  await requestClose()
  expect(destroyed).toBe(0)
  guarded = false
  await closeNativeWindow()
  expect(destroyed).toBe(1)
})
