#!/usr/bin/env node
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../core-manager.js';
import { ApiServer } from '../server/api-server.js';

let currentDir = process.cwd();
try {
  if (typeof __dirname !== 'undefined') {
    currentDir = __dirname;
  } else if (import.meta && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
} catch {}

// Search for apps/desktop/dist
const possibleDistPaths = [
  path.resolve(currentDir, '../../../../apps/desktop/dist'),
  path.resolve(currentDir, '../../../apps/desktop/dist'),
  path.resolve(currentDir, '../dist'),
  path.resolve(process.cwd(), 'apps/desktop/dist'),
  path.resolve(process.cwd(), 'dist'),
];

let staticDir: string | undefined;
for (const p of possibleDistPaths) {
  if (fs.existsSync(p)) {
    staticDir = p;
    break;
  }
}

const core = new CoreManager();
const server = new ApiServer(core, staticDir);

const port = Number(process.env.PORT) || 3847;
server.start(port).then((p) => {
  console.log(`AUTOPSY_PORT=${p}`);
  console.log(`\n========================================================`);
  console.log(`🔬 Agent Autopsy Dashboard & API Server live at:`);
  console.log(`👉 http://127.0.0.1:${p}`);
  if (staticDir) {
    console.log(`📦 Serving UI static bundle from: ${staticDir}`);
  } else {
    console.log(`⚠️ UI bundle not found yet. Run 'pnpm build' to bundle the UI.`);
  }
  console.log(`========================================================\n`);
});

process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPERM' && (err as any)?.syscall === 'watch') {
    // Ignore OneDrive / Windows file watch permission glitches
    return;
  }
  console.error('[Agent Autopsy] Uncaught error:', err);
});

const cleanup = async () => {
  console.log('\nShutting down Agent Autopsy server...');
  try {
    await server.stop();
    await core.shutdown();
  } catch {}
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
