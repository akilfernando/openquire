import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface ClaudeConfig {
  mcpServers?: Record<string, {
    command: string
    args?: string[]
    env?: Record<string, string>
  }>
  [key: string]: unknown
}

/** Returns all possible platform-specific paths to claude_desktop_config.json */
export function getAllClaudeDesktopConfigPaths(): string[] {
  const os = platform()
  const home = homedir()
  const paths: string[] = []

  if (os === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  } else if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const storePath = join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
    paths.push(storePath)
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    paths.push(join(appData, 'Claude', 'claude_desktop_config.json'))
  } else {
    // Linux and other Unixes
    const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
    paths.push(join(configHome, 'Claude', 'claude_desktop_config.json'))
  }

  return paths
}

/** Returns the primary platform-specific path to claude_desktop_config.json */
export function getClaudeDesktopConfigPath(): string {
  const paths = getAllClaudeDesktopConfigPaths()
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return paths[0]
}

/** Checks if openquire is available globally in PATH */
function isGloballyInstalled(): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which'
    execFileSync(cmd, ['openquire'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export interface SetupOptions {
  binaryPath?: string
  allowedDir?: string
  log?: (msg: string) => void
}

/** Installs or updates OpenQuire in Claude Desktop's MCP configuration */
export function setupClaudeDesktop(options: SetupOptions = {}): { configPath: string; status: 'installed' | 'updated' } {
  const log = options.log || console.log
  const paths = getAllClaudeDesktopConfigPaths()
  const allowedDir = options.allowedDir ? resolve(options.allowedDir) : homedir()
  const isGlobal = isGloballyInstalled()
  const isWin = platform() === 'win32'

  // Determine command & args
  let command: string
  let args: string[]

  if (options.binaryPath) {
    command = resolve(options.binaryPath)
    args = ['mcp', '--allow-dir', allowedDir]
  } else if (isGlobal) {
    if (isWin) {
      command = 'cmd.exe'
      args = ['/c', 'openquire', 'mcp', '--allow-dir', allowedDir]
    } else {
      command = 'openquire'
      args = ['mcp', '--allow-dir', allowedDir]
    }
  } else {
    // Zero-install fallback via npx
    if (isWin) {
      command = 'cmd.exe'
      args = ['/c', 'npx', '-y', 'openquire', 'mcp', '--allow-dir', allowedDir]
    } else {
      command = 'npx'
      args = ['-y', 'openquire', 'mcp', '--allow-dir', allowedDir]
    }
  }

  // Update target config files (all existing ones, or the primary one)
  const targetPaths = paths.filter((p) => existsSync(dirname(p)))
  const filesToUpdate = targetPaths.length > 0 ? targetPaths : [paths[0]]

  let primaryStatus: 'installed' | 'updated' = 'installed'

  for (const configPath of filesToUpdate) {
    const configDir = dirname(configPath)
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    let config: ClaudeConfig = {}
    let exists = false

    if (existsSync(configPath)) {
      exists = true
      try {
        const content = readFileSync(configPath, 'utf8').trim()
        if (content) config = JSON.parse(content)
      } catch {
        const backupCorrupt = `${configPath}.corrupt-${Date.now()}`
        writeFileSync(backupCorrupt, readFileSync(configPath))
        log(`Warning: Existing config was unreadable JSON. Backed up to ${backupCorrupt}`)
      }
    }

    if (exists) {
      try {
        writeFileSync(`${configPath}.bak`, readFileSync(configPath))
      } catch {
        // Ignore backup error
      }
    }

    if (!config.mcpServers) {
      config.mcpServers = {}
    }

    if ('openquire' in config.mcpServers) {
      primaryStatus = 'updated'
    }

    config.mcpServers['openquire'] = {
      command,
      args,
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  }

  return {
    configPath: filesToUpdate[0],
    status: primaryStatus,
  }
}

/** Removes OpenQuire from Claude Desktop's MCP configuration */
export function uninstallClaudeDesktop(): { configPath: string; removed: boolean } {
  const paths = getAllClaudeDesktopConfigPaths()
  let anyRemoved = false

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue
    try {
      const config: ClaudeConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      if (config.mcpServers && 'openquire' in config.mcpServers) {
        delete config.mcpServers['openquire']
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
        anyRemoved = true
      }
    } catch {
      // ignore
    }
  }

  return { configPath: paths[0], removed: anyRemoved }
}

/** Checks whether OpenQuire is currently configured in Claude Desktop */
export function getClaudeDesktopStatus(): { configPath: string; isConfigured: boolean; details?: unknown } {
  const paths = getAllClaudeDesktopConfigPaths()
  for (const configPath of paths) {
    if (!existsSync(configPath)) continue
    try {
      const config: ClaudeConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      const entry = config.mcpServers?.['openquire']
      if (entry) {
        return {
          configPath,
          isConfigured: true,
          details: entry,
        }
      }
    } catch {
      // ignore
    }
  }

  return { configPath: paths[0], isConfigured: false }
}
