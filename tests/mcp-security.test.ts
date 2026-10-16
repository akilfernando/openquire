import { afterEach, beforeEach, describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { SecurityError, resolveOutputPath, validatePath } from '../cli/src/mcp/security'

describe('MCP filesystem boundaries', () => {
  let temp: string
  let allowed: string
  let outside: string
  let input: string

  beforeEach(() => {
    // Canonicalize tmpdir too: /var can itself be a symlink on macOS.
    temp = realpathSync(mkdtempSync(join(tmpdir(), 'oq-mcp-security-')))
    allowed = join(temp, 'allowed')
    outside = join(temp, 'allowed-sibling')
    mkdirSync(allowed)
    mkdirSync(outside)
    input = join(allowed, 'input.pdf')
    writeFileSync(input, 'original')
    writeFileSync(join(outside, 'private.pdf'), 'private')
  })

  afterEach(() => rmSync(temp, { recursive: true, force: true }))

  // Windows directory junctions do not require symbolic-link privileges. These
  // same tests exercise native Windows separators when run on Windows CI.
  const directoryLink = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')

  it('allows native absolute and relative paths inside a permitted directory', () => {
    assert.equal(validatePath(input, [allowed]), input)
    assert.equal(validatePath(relative(process.cwd(), input), [allowed]), input)
    assert.equal(resolveOutputPath(input, join(allowed, 'new.pdf'), 'filled', [allowed]), join(allowed, 'new.pdf'))
  })

  it('rejects sibling prefixes and traversal for input and output', () => {
    for (const path of [join(outside, 'private.pdf'), `${allowed}/../allowed-sibling/private.pdf`]) {
      assert.throws(() => validatePath(path, [allowed]), SecurityError)
      assert.throws(() => resolveOutputPath(input, path, 'filled', [allowed], true), SecurityError)
    }
  })

  it('reports a missing input inside the permitted root', () => {
    assert.throws(() => validatePath(join(allowed, 'missing.pdf'), [allowed]), /File not found/)
  })

  it('does not let an unavailable root disable another permitted directory', () => {
    const missing = join(temp, 'missing-root')
    const roots = [missing, allowed]
    assert.equal(validatePath(input, roots), input)
    assert.equal(resolveOutputPath(input, undefined, 'filled', roots), join(allowed, 'input-filled.pdf'))
    assert.throws(() => resolveOutputPath(input, join(missing, 'new.pdf'), 'filled', roots), SecurityError)
  })

  it('checks inputs reached through directory links', () => {
    const escape = join(allowed, 'escape')
    directoryLink(outside, escape)
    assert.throws(() => validatePath(join(escape, 'private.pdf'), [allowed]), SecurityError)
  })

  it('rejects output through linked parents, including uncreated descendants', () => {
    const escape = join(allowed, 'escape')
    directoryLink(outside, escape)
    for (const path of [join(escape, 'new.pdf'), join(escape, 'new-folder', 'new.pdf')]) {
      assert.throws(() => resolveOutputPath(input, path, 'filled', [allowed]), SecurityError)
      assert.throws(() => resolveOutputPath(input, path, 'filled', [allowed], true), SecurityError)
    }
  })

  it('returns canonical paths for permitted directory aliases', () => {
    const realDir = join(allowed, 'documents')
    mkdirSync(realDir)
    writeFileSync(join(realDir, 'file.pdf'), 'document')
    const alias = join(allowed, 'alias')
    directoryLink(realDir, alias)
    assert.equal(validatePath(join(alias, 'file.pdf'), [allowed]), join(realDir, 'file.pdf'))
    assert.equal(resolveOutputPath(input, join(alias, 'new.pdf'), 'filled', [allowed]), join(realDir, 'new.pdf'))
  })

  it('supports an explicitly permitted root that is itself a directory alias', () => {
    const alias = join(temp, 'root-alias')
    directoryLink(allowed, alias)
    assert.equal(validatePath(join(alias, 'input.pdf'), [alias]), input)
    assert.equal(resolveOutputPath(join(alias, 'input.pdf'), undefined, 'filled', [alias]), join(allowed, 'input-filled.pdf'))
  })

  it('applies containment to generated outputs as well', () => {
    assert.throws(() => resolveOutputPath(join(outside, 'private.pdf'), undefined, 'filled', [allowed]), SecurityError)
    const escape = join(allowed, 'escape')
    directoryLink(outside, escape)
    assert.throws(() => resolveOutputPath(join(escape, 'private.pdf'), undefined, 'filled', [allowed]), SecurityError)
  })

  it('validates an output beneath missing directories using the existing ancestor', () => {
    const output = join(allowed, 'new-folder', 'nested', 'output.pdf')
    assert.equal(resolveOutputPath(input, output, 'filled', [allowed]), output)
  })

  it('requires overwrite permission for an existing output', () => {
    assert.throws(() => resolveOutputPath(input, input, 'filled', [allowed]), /already exists/)
    assert.equal(resolveOutputPath(input, input, 'filled', [allowed], true), input)
    assert.equal(readFileSync(input, 'utf8'), 'original')
  })

  it('skips every occupied generated filename without changing existing data', () => {
    for (const name of ['input-filled.pdf', 'input-filled-1.pdf', 'input-filled-2.pdf']) {
      writeFileSync(join(allowed, name), 'keep')
    }
    assert.equal(resolveOutputPath(input, undefined, 'filled', [allowed]), join(allowed, 'input-filled-3.pdf'))
    assert.equal(readFileSync(join(allowed, 'input-filled-1.pdf'), 'utf8'), 'keep')
  })

  it('defaults to the current directory', () => {
    // Avoid changing process.cwd(), which is shared with other test workers.
    const output = resolve('openquire-mcp-security-test-output.pdf')
    assert.equal(resolveOutputPath('input.pdf', output, 'filled'), canonicalCwdOutput(output))
    assert.throws(() => validatePath(input), SecurityError)
  })

  function canonicalCwdOutput(path: string): string {
    return join(realpathSync(process.cwd()), relative(process.cwd(), path))
  }

  // File symlinks require extra privileges on Windows; directory-junction
  // coverage above still runs there without those privileges.
  it.skipIf(process.platform === 'win32')('rejects file symlinks that point outside the root, including overwrite', () => {
    const link = join(allowed, 'linked.pdf')
    symlinkSync(join(outside, 'private.pdf'), link)
    assert.throws(() => validatePath(link, [allowed]), SecurityError)
    assert.throws(() => resolveOutputPath(input, link, 'filled', [allowed], true), SecurityError)
    assert.equal(readFileSync(join(outside, 'private.pdf'), 'utf8'), 'private')
  })

  it.skipIf(process.platform === 'win32')('rejects dangling explicit links and skips dangling generated filenames', () => {
    const dangling = join(allowed, 'input-filled.pdf')
    symlinkSync(join(outside, 'missing.pdf'), dangling)
    assert.throws(() => validatePath(dangling, [allowed]), SecurityError)
    assert.throws(() => resolveOutputPath(input, dangling, 'filled', [allowed]), SecurityError)
    assert.throws(() => resolveOutputPath(input, dangling, 'filled', [allowed], true), SecurityError)
    assert.equal(resolveOutputPath(input, undefined, 'filled', [allowed]), join(allowed, 'input-filled-1.pdf'))
  })
})
