import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerOpenQuireTools, type McpToolOptions } from './tools'

export interface ServerConfig extends McpToolOptions {
  version?: string
}

export function createOpenQuireMcpServer(config: ServerConfig = {}) {
  const server = new McpServer({
    name: 'openquire',
    version: config.version || '1.0.0',
  })

  registerOpenQuireTools(server, config)
  return server
}

export async function runMcpServer(config: ServerConfig = {}) {
  const server = createOpenQuireMcpServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[openquire-mcp] OpenQuire MCP Server v${config.version || '1.0.0'} active over stdio.`)
  if (config.allowedDirs?.length) {
    console.error(`[openquire-mcp] Sandboxed to: ${config.allowedDirs.join(', ')}`)
  }
}
