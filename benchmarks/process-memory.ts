import { readdirSync, readFileSync } from 'node:fs'

/** Linux browser process-tree RSS, including renderer/worker processes. This is
 * an observation, not an exact peak; short-lived allocations can be missed. */
export function processTreeRss(rootPid: number, procRoot = '/proc'): number | null {
  const parents = new Map<number, number>()
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const stat = readFileSync(`${procRoot}/${entry}/stat`, 'utf8')
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        parents.set(Number(entry), Number(fields[1]))
      } catch { /* Processes may exit between enumeration and reading. */ }
    }
  } catch { return null }
  if (!parents.has(rootPid)) return null
  const included = new Set([rootPid])
  let previousSize = 0
  while (included.size !== previousSize) {
    previousSize = included.size
    for (const [pid, parent] of parents) if (included.has(parent)) included.add(pid)
  }
  let bytes = 0
  for (const pid of included) {
    try {
      const status = readFileSync(`${procRoot}/${pid}/status`, 'utf8')
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)
      if (rss) bytes += Number(rss[1]) * 1024
    } catch { /* Exited processes no longer contribute resident memory. */ }
  }
  return bytes || null
}
