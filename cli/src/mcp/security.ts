import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

function isWithin(target: string, root: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function permittedRoots(allowedDirs: string[]): string[] {
  return (allowedDirs.length > 0 ? allowedDirs : [process.cwd()]).map((d) => resolve(normalizePath(d)))
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    throw new SecurityError(`Cannot resolve path: "${path}". It must exist and be accessible.`)
  }
}

function canonicalRoots(roots: string[]): string[] {
  return roots.flatMap((root) => {
    try {
      return [realpathSync(root)]
    } catch {
      // A missing or inaccessible root grants no access, but must not disable
      // a different explicitly permitted directory that is still available.
      return []
    }
  })
}

function assertAllowed(target: string, roots: string[]): void {
  if (!roots.some((root) => isWithin(target, root))) {
    throw new SecurityError(
      `Access denied: "${target}" is outside permitted directories (${roots.join(', ')}). Use --allow-dir to permit additional paths.`
    )
  }
}

// Unlike existsSync, lstat sees dangling symlinks, which must never be treated as
// an available output filename. Permission and malformed-path errors fail closed.
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new SecurityError(`Cannot inspect path: "${path}".`)
  }
}

/** Resolve links in an output's existing ancestors, even when its leaf is new. */
function canonicalOutput(target: string): string {
  const missing: string[] = []
  let ancestor = target
  while (!entryExists(ancestor)) {
    missing.unshift(basename(ancestor))
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new SecurityError(`Cannot resolve output: "${target}".`)
    ancestor = parent
  }
  return resolve(canonical(ancestor), ...missing)
}

/**
 * Validate both the requested path and its real destination against allowed
 * directories. Return the real path so callers do not reopen the original alias.
 * Defaults to the current working directory if allowedDirs is empty.
 */
export function validatePath(filePath: string, allowedDirs: string[] = []): string {
  const abs = resolve(normalizePath(filePath))
  const roots = permittedRoots(allowedDirs)
  assertAllowed(abs, roots)
  if (!entryExists(abs)) throw new SecurityError(`File not found: "${filePath}"`)
  const real = canonical(abs)
  assertAllowed(real, canonicalRoots(roots))
  return real
}

/**
 * Resolve explicit and generated outputs against the same directory policy.
 * Callers must use exclusive creation when allowOverwrite is false: validation
 * does not reserve a filename. These path checks are not a defense against an
 * adversary concurrently changing the filesystem during I/O (including a leaf
 * symlink when overwriting is explicitly enabled).
 */
export function resolveOutputPath(
  inputPath: string,
  outputPath: string | undefined,
  suffix: string,
  allowedDirs: string[] = [],
  allowOverwrite = false,
  extension?: string
): string {
  const normInput = resolve(normalizePath(inputPath))
  const roots = permittedRoots(allowedDirs)
  const dir = dirname(normInput)
  const base = basename(normInput, extname(normInput))
  const ext = extension ?? (extname(normInput) || '.pdf')
  let target = outputPath ? resolve(normalizePath(outputPath)) : join(dir, `${base}-${suffix}${ext}`)

  assertAllowed(target, roots)
  if (!outputPath && !allowOverwrite) {
    let counter = 1
    while (entryExists(target)) {
      target = join(dir, `${base}-${suffix}-${counter++}${ext}`)
    }
    assertAllowed(target, roots)
  }

  const real = canonicalOutput(target)
  assertAllowed(real, canonicalRoots(roots))
  if (!allowOverwrite && entryExists(real)) {
    throw new SecurityError(
      `Output file "${target}" already exists. Set allowOverwrite or choose another path to prevent data loss.`
    )
  }
  return real
}
