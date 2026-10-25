import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

  const req = createRequire(path.resolve(root, 'packages/core/package.json'));

  // Resolve web-tree-sitter wasm dynamically
  let wtsWasmSrc = null;
  try {
    const wtsPkg = req.resolve('web-tree-sitter');
    const candidate = path.join(path.dirname(wtsPkg), 'tree-sitter.wasm');
    if (fs.existsSync(candidate)) wtsWasmSrc = candidate;
  } catch {}

  if (!wtsWasmSrc) {
    const fallbacks = [
      path.resolve(root, 'packages/core/node_modules/web-tree-sitter/tree-sitter.wasm'),
      path.resolve(root, 'node_modules/web-tree-sitter/tree-sitter.wasm'),
    ];
    wtsWasmSrc = fallbacks.find((p) => fs.existsSync(p));
  }

  if (wtsWasmSrc) {
    fs.copyFileSync(wtsWasmSrc, path.resolve(wasmOutDir, 'tree-sitter.wasm'));
    console.log('✅ tree-sitter.wasm copied successfully');
  } else {
    throw new Error('tree-sitter.wasm not found for bundling');
  }

  // Resolve tree-sitter-wasms dynamically
  let tswSrcDir = null;
  try {
    const tswPkg = req.resolve('tree-sitter-wasms/package.json');
    const candidate = path.join(path.dirname(tswPkg), 'out');
    if (fs.existsSync(candidate)) tswSrcDir = candidate;
  } catch {}

  if (!tswSrcDir) {
    const fallbacks = [
      path.resolve(root, 'packages/core/node_modules/tree-sitter-wasms/out'),
      path.resolve(root, 'node_modules/tree-sitter-wasms/out'),
    ];
    tswSrcDir = fallbacks.find((p) => fs.existsSync(p));
  }

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
