import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../../..');
const outDir = path.resolve(__dirname, '../electron/bundled');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

console.log('[Bundle Backend] Bundling backend server and MCP server for standalone Electron deployment...');

async function bundle() {
  // 1. Bundle server-cli
  await esbuild.build({
    entryPoints: [path.resolve(root, 'packages/core/src/bin/server-cli.ts')],
    outfile: path.resolve(outDir, 'server-cli.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node:sqlite', 'fsevents'],
    banner: {
      js: '/* Agent Autopsy Standalone Backend Server Bundle */',
    },
    sourcemap: false,
    minify: false,
  });
  console.log('✅ server-cli.cjs bundled successfully');

  // 2. Bundle mcp-server
  await esbuild.build({
    entryPoints: [path.resolve(root, 'packages/mcp-server/src/index.ts')],
    outfile: path.resolve(outDir, 'mcp-server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['node:sqlite', 'fsevents'],
    banner: {
      js: '/* Agent Autopsy Standalone MCP Server Bundle */',
    },
    sourcemap: false,
    minify: false,
  });
  console.log('✅ mcp-server.cjs bundled successfully');
}

bundle().catch((err) => {
  console.error('❌ Bundle failed:', err);
  process.exit(1);
});
