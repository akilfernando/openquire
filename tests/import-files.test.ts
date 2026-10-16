import { expect, it } from 'vitest'
import { importFiles } from '../src/import-files'

it('finishes the current import on stop and skips remaining files without loading them', async () => {
  const controller = new AbortController()
  const loaded: string[] = []
  const result = await importFiles([{ name: 'one' }, { name: 'two' }], {
    signal: controller.signal, progress: () => {},
    load: async file => { controller.abort(); await Promise.resolve(); loaded.push(file.name); return true },
  })
  expect(loaded).toEqual(['one'])
  expect(result).toEqual([{ name: 'one', status: 'completed' }, { name: 'two', status: 'skipped' }])
})

it('reports errors and password cancellations while continuing later imports', async () => {
  const result = await importFiles([{ name: 'broken' }, { name: 'cancelled' }, { name: 'good' }], {
    signal: new AbortController().signal, progress: () => {},
    load: async file => {
      if (file.name === 'broken') throw new Error('Unsupported input')
      return file.name === 'good'
    },
  })
  expect(result).toEqual([
    { name: 'broken', status: 'failed', error: 'Unsupported input' },
    { name: 'cancelled', status: 'skipped' }, { name: 'good', status: 'completed' },
  ])
})
