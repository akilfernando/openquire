import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

export class SecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
  }
}

/** Converts Windows-style paths (C:\Users\...) to WSL mount paths (/mnt/c/Users/...) on Linux */
export function normalizePath(p: string): string {
  if (process.platform === 'linux') {
    const match = p.match(/^([a-zA-Z]):[\\/](.*)/)
    if (match) {
      const drive = match[1].toLowerCase()
      const rest = match[2].replace(/\\/g, '/')
      return `/mnt/${drive}/${rest}`
    }
  }
  return p
}

/**
 * Validates that target path is within one of the allowed directories.
 * Defaults to current working directory if allowedDirs is empty.
 */
export function validatePath(filePath: string, allowedDirs: string[] = []): string {
  const abs = resolve(normalizePath(filePath))
  const roots = (allowedDirs.length > 0 ? allowedDirs : [process.cwd()]).map((d) => resolve(normalizePath(d)))

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
  const normInput = normalizePath(inputPath)
  const roots = (allowedDirs.length > 0 ? allowedDirs : [process.cwd()]).map((d) => resolve(normalizePath(d)))

  let target: string
  if (outputPath) {
    target = resolve(normalizePath(outputPath))
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
    const dir = dirname(normInput)
    const base = basename(normInput, extname(normInput))
    const ext = extname(normInput) || '.pdf'
    target = join(dir, `${base}-${suffix}${ext}`)
    // If generated default exists, append timestamp or incremental counter to ensure non-destructive behavior
    if (existsSync(target) && !allowOverwrite) {
      target = join(dir, `${base}-${suffix}-${Date.now()}${ext}`)
    }
  }

  return target
}
