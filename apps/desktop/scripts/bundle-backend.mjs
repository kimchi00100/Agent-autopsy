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

  // 3. Copy Tree-sitter WASM files for standalone localization
  const wasmOutDir = path.resolve(outDir, 'wasm');
  if (!fs.existsSync(wasmOutDir)) {
    fs.mkdirSync(wasmOutDir, { recursive: true });
  }

  const wtsWasmCandidates = [
    path.resolve(root, 'packages/core/node_modules/web-tree-sitter/tree-sitter.wasm'),
    path.resolve(root, 'node_modules/web-tree-sitter/tree-sitter.wasm'),
    path.resolve(root, 'node_modules/.pnpm/web-tree-sitter@0.24.7/node_modules/web-tree-sitter/tree-sitter.wasm'),
  ];
  const wtsWasmSrc = wtsWasmCandidates.find((p) => fs.existsSync(p));
  if (wtsWasmSrc) {
    fs.copyFileSync(wtsWasmSrc, path.resolve(wasmOutDir, 'tree-sitter.wasm'));
    console.log('✅ tree-sitter.wasm copied successfully');
  } else {
    throw new Error('tree-sitter.wasm not found for bundling');
  }

  const tswCandidates = [
    path.resolve(root, 'packages/core/node_modules/tree-sitter-wasms/out'),
    path.resolve(root, 'node_modules/tree-sitter-wasms/out'),
    path.resolve(root, 'node_modules/.pnpm/tree-sitter-wasms@0.1.13/node_modules/tree-sitter-wasms/out'),
  ];
  const tswSrcDir = tswCandidates.find((p) => fs.existsSync(p));
  if (tswSrcDir) {
    const requiredWasms = [
      'tree-sitter-python.wasm',
      'tree-sitter-javascript.wasm',
      'tree-sitter-typescript.wasm',
      'tree-sitter-tsx.wasm',
      'tree-sitter-c.wasm',
      'tree-sitter-cpp.wasm',
    ];
    for (const wasmFile of requiredWasms) {
      const src = path.resolve(tswSrcDir, wasmFile);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.resolve(wasmOutDir, wasmFile));
      } else {
        throw new Error(`Required grammar wasm not found: ${wasmFile}`);
      }
    }
    console.log('✅ Grammar WASM files copied successfully');
  } else {
    throw new Error('tree-sitter-wasms/out directory not found for bundling');
  }
}

bundle().catch((err) => {
  console.error('❌ Bundle failed:', err);
  process.exit(1);
});
