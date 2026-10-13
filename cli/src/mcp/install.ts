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

/** Returns the platform-specific path to claude_desktop_config.json */
export function getClaudeDesktopConfigPath(): string {
  const os = platform()
  const home = homedir()

  if (os === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const storePath = join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
    if (existsSync(storePath)) {
      return storePath
    }
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  // Linux and other Unixes
  const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(configHome, 'Claude', 'claude_desktop_config.json')
}

export interface SetupOptions {
  binaryPath?: string
  allowedDir?: string
  log?: (msg: string) => void
}

/** Installs or updates OpenQuire in Claude Desktop's MCP configuration */
export function setupClaudeDesktop(options: SetupOptions = {}): { configPath: string; status: 'installed' | 'updated' } {
  const log = options.log || console.log
  const configPath = getClaudeDesktopConfigPath()
  const configDir = dirname(configPath)
  const allowedDir = options.allowedDir ? resolve(options.allowedDir) : homedir()

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  let config: ClaudeConfig = {}
  let exists = false

  if (existsSync(configPath)) {
    exists = true
    try {
      const content = readFileSync(configPath, 'utf8').trim()
      if (content) {
        config = JSON.parse(content)
      }
    } catch {
      // Backup corrupted file
      const backupCorrupt = `${configPath}.corrupt-${Date.now()}`
      writeFileSync(backupCorrupt, readFileSync(configPath))
      log(`Warning: Existing config was unreadable JSON. Backed up to ${backupCorrupt}`)
    }
  }

  // Backup existing config
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

  const isAlreadyConfigured = 'openquire' in config.mcpServers

  // Determine command & args
  let command: string
  let args: string[]

  if (options.binaryPath) {
    command = resolve(options.binaryPath)
    args = ['mcp', '--allow-dir', allowedDir]
  } else {
    // Standard command: use openquire directly if installed globally, or node with entrypoint
    command = 'openquire'
    args = ['mcp', '--allow-dir', allowedDir]
  }

  config.mcpServers['openquire'] = {
    command,
    args,
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

  return {
    configPath,
    status: isAlreadyConfigured ? 'updated' : 'installed',
  }
}

/** Removes OpenQuire from Claude Desktop's MCP configuration */
export function uninstallClaudeDesktop(): { configPath: string; removed: boolean } {
  const configPath = getClaudeDesktopConfigPath()
  if (!existsSync(configPath)) {
    return { configPath, removed: false }
  }

  try {
    const config: ClaudeConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    if (config.mcpServers && 'openquire' in config.mcpServers) {
      delete config.mcpServers['openquire']
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
      return { configPath, removed: true }
    }
  } catch {
    // ignore
  }

  return { configPath, removed: false }
}

/** Checks whether OpenQuire is currently configured in Claude Desktop */
export function getClaudeDesktopStatus(): { configPath: string; isConfigured: boolean; details?: unknown } {
  const configPath = getClaudeDesktopConfigPath()
  if (!existsSync(configPath)) {
    return { configPath, isConfigured: false }
  }

  try {
    const config: ClaudeConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    const entry = config.mcpServers?.['openquire']
    return {
      configPath,
      isConfigured: !!entry,
      details: entry,
    }
  } catch {
    return { configPath, isConfigured: false }
  }
}
