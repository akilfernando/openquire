import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

export class SecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
  }
}

/**
 * Validates that target path is within one of the allowed directories.
 * Defaults to current working directory if allowedDirs is empty.
 */
export function validatePath(filePath: string, allowedDirs: string[] = []): string {
  const abs = resolve(filePath)
  const roots = (allowedDirs.length > 0 ? allowedDirs : [process.cwd()]).map((d) => resolve(d))

  const isAllowed = roots.some((root) => abs === root || abs.startsWith(root + '/'))
  if (!isAllowed) {
    throw new SecurityError(
      `Access denied: "${filePath}" is outside permitted directories (${roots.join(', ')}). Use --allow-dir to permit additional paths.`
    )
  }

  if (!existsSync(abs)) {
    throw new SecurityError(`File not found: "${filePath}"`)
  }

  return abs
}

/**
 * Resolves a safe output path.
 * If outputPath is provided, validates that it falls within allowedDirs.
 * If not provided, generates a non-destructive filename (e.g. document-filled.pdf).
 */
export function resolveOutputPath(
  inputPath: string,
  outputPath: string | undefined,
  suffix: string,
  allowedDirs: string[] = [],
  allowOverwrite = false
): string {
  const roots = (allowedDirs.length > 0 ? allowedDirs : [process.cwd()]).map((d) => resolve(d))

  let target: string
  if (outputPath) {
    target = resolve(outputPath)
    const isAllowed = roots.some((root) => target === root || target.startsWith(root + '/'))
    if (!isAllowed) {
      throw new SecurityError(`Access denied for output: "${outputPath}" is outside permitted directories.`)
    }
    if (!allowOverwrite && existsSync(target)) {
      throw new SecurityError(
        `Output file "${outputPath}" already exists. Set allowOverwrite or choose another path to prevent data loss.`
      )
    }
  } else {
    const dir = dirname(inputPath)
    const base = basename(inputPath, extname(inputPath))
    const ext = extname(inputPath) || '.pdf'
    target = join(dir, `${base}-${suffix}${ext}`)
    // If generated default exists, append timestamp or incremental counter to ensure non-destructive behavior
    if (existsSync(target) && !allowOverwrite) {
      target = join(dir, `${base}-${suffix}-${Date.now()}${ext}`)
    }
  }

  return target
}
