#!/usr/bin/env node
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CoreManager } from '@agent-autopsy/core';
import { registerAllTools } from './tools/index.js';

const coreManager = new CoreManager();

// Cross-process Real-Time Sync: Ping local running Agent Autopsy dashboard (dynamic port from runtime.json)
function notifyLocalServer(type: string, data?: any) {
  try {
    const targetPort = coreManager.getActivePort();
    const payload = JSON.stringify({ type, data });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: '/api/internal/notify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 600,
      },
      () => {}
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

coreManager.subscribe((type, data) => {
  notifyLocalServer(type, data);
});

const server = new McpServer({
  name: 'agent-autopsy',
  version: '0.1.0',
});

// Helper: resolve default path
function resolvePath(p?: string): string {
  if (p && p.trim()) return p;
  try {
    const projects = coreManager.getDatabase().listProjects();
    if (projects.length > 0) {
      return projects[0].rootPath;
    }
  } catch {}
  return process.cwd();
}


// Register all 17 MCP tools
registerAllTools(server, coreManager, resolvePath);

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Agent Autopsy MCP server running on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`Fatal error running Agent Autopsy MCP server: ${error}\n`);
  process.exit(1);
});
