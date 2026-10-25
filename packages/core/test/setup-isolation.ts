import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

function normalizePath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrSubDirectory(target: string, parentDir: string): boolean {
  const normTarget = normalizePath(target);
  const normParent = normalizePath(parentDir);
  if (normTarget === normParent) return true;
  const prefix = normParent.endsWith('/') ? normParent : normParent + '/';
  return normTarget.startsWith(prefix);
}

// 1. Determine real user data directory (%APPDATA%\AgentAutopsy on Windows)
const baseAppData =
  process.env.APPDATA ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null) ||
  process.env.HOME ||
  '.';
const realUserDataDir = path.resolve(baseAppData, 'AgentAutopsy');

// Also determine real user cache directory (%LOCALAPPDATA%\AgentAutopsy)
const baseLocalAppData =
  process.env.LOCALAPPDATA ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
const realUserCacheDir = baseLocalAppData
  ? path.resolve(baseLocalAppData, 'AgentAutopsy')
  : path.resolve(realUserDataDir, 'cache');

// 2. Validate AUTOPSY_DATA_DIR: if set, ensure it NEVER points to real user directory or its subdirectories
if (process.env.AUTOPSY_DATA_DIR && process.env.AUTOPSY_DATA_DIR.trim()) {
  const dataDir = process.env.AUTOPSY_DATA_DIR.trim();
  if (
    isSameOrSubDirectory(dataDir, realUserDataDir) ||
    (realUserCacheDir && isSameOrSubDirectory(dataDir, realUserCacheDir))
  ) {
    console.error(
      `[TEST ISOLATION ERROR] AUTOPSY_DATA_DIR points to real user directory: "${dataDir}". Aborting test execution immediately.`
    );
    process.exit(1);
  }
} else {
  // Empty -> Create isolated temporary directory
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-test-data-'));
  process.env.AUTOPSY_DATA_DIR = tmpDataDir;
}

// 3. Validate AUTOPSY_CACHE_DIR: if set, ensure it NEVER points to real user directory or its subdirectories
if (process.env.AUTOPSY_CACHE_DIR && process.env.AUTOPSY_CACHE_DIR.trim()) {
  const cacheDir = process.env.AUTOPSY_CACHE_DIR.trim();
  if (
    isSameOrSubDirectory(cacheDir, realUserDataDir) ||
    (realUserCacheDir && isSameOrSubDirectory(cacheDir, realUserCacheDir))
  ) {
    console.error(
      `[TEST ISOLATION ERROR] AUTOPSY_CACHE_DIR points to real user directory: "${cacheDir}". Aborting test execution immediately.`
    );
    process.exit(1);
  }
} else {
  // Empty -> Create isolated temporary directory
  const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-test-cache-'));
  process.env.AUTOPSY_CACHE_DIR = tmpCacheDir;
}
