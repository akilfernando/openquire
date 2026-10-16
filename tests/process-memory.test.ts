import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processTreeRss } from '../benchmarks/process-memory'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('counts only the browser tree, including grandchildren and names with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'openquire-proc-')); roots.push(root)
  for (const [pid, parent, rss] of [[10, 1, 100], [11, 10, 200], [12, 11, 300], [20, 1, 900]]) {
    mkdirSync(join(root, String(pid)))
    writeFileSync(join(root, String(pid), 'stat'), `${pid} (browser (worker)) S ${parent} 0 0`)
    writeFileSync(join(root, String(pid), 'status'), `Name:\tbrowser\nVmRSS:\t${rss} kB\n`)
  }
  expect(processTreeRss(10, root)).toBe(600 * 1024)
  expect(processTreeRss(99, root)).toBeNull()
})

it('reports unavailable process data instead of a zero-memory measurement', () => {
  const root = mkdtempSync(join(tmpdir(), 'openquire-proc-')); roots.push(root)
  mkdirSync(join(root, '10'))
  writeFileSync(join(root, '10', 'stat'), '10 (browser) S 1 0 0')
  expect(processTreeRss(10, root)).toBeNull()
  expect(processTreeRss(10, join(root, 'absent'))).toBeNull()
})
