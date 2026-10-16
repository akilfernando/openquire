export interface ImportResult {
  name: string
  status: 'completed' | 'failed' | 'skipped'
  error?: string
}

/** Stops only between files. Each committed document remains available. */
export async function importFiles<T extends { name: string }>(files: T[], options: {
  signal: AbortSignal
  progress: (file: T, index: number) => void
  load: (file: T, index: number) => Promise<boolean>
}): Promise<ImportResult[]> {
  const results: ImportResult[] = []
  for (const [index, file] of files.entries()) {
    if (options.signal.aborted) {
      results.push({ name: file.name, status: 'skipped' })
      continue
    }
    options.progress(file, index)
    try {
      results.push({ name: file.name, status: await options.load(file, index) ? 'completed' : 'skipped' })
    } catch (error) {
      results.push({ name: file.name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}
