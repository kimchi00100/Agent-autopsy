import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Returns the unified runtime data directory for Agent Autopsy (%APPDATA%\AgentAutopsy on Windows).
 * Shared identically across Desktop App, Core Engine, API Server, and MCP Servers.
 */
export function resolveDataDir(): string {
  if (process.env.AUTOPSY_DATA_DIR && process.env.AUTOPSY_DATA_DIR.trim()) {
    return path.resolve(process.env.AUTOPSY_DATA_DIR);
  }
  const base = process.env.APPDATA || process.env.HOME || '.';
  return path.resolve(base, 'AgentAutopsy');
}

/**
 * Returns the unified cache directory for Agent Autopsy (%LOCALAPPDATA%\AgentAutopsy\cache on Windows).
 */
export function resolveCacheDir(): string {
  if (process.env.AUTOPSY_CACHE_DIR && process.env.AUTOPSY_CACHE_DIR.trim()) {
    return path.resolve(process.env.AUTOPSY_CACHE_DIR);
  }
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.HOME || '.';
  return path.resolve(base, 'AgentAutopsy', 'cache');
}

/**
 * Normalizes a repository path across platforms, converting backslashes to forward slashes
 * and lowercasing drive letters on Windows so equivalent paths match deterministically.
 */
export function normalizeRepoPath(targetPath: string): string {
  const resolved = path.resolve(targetPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Generates a deterministic project ID based on the SHA-256 hash of the normalized root path.
 * Guarantees that the exact same repository path always yields the identical Project ID
 * across different processes, working directories, or DB instances.
 */
export function generateDeterministicProjectId(repoRootPath: string): string {
  const norm = normalizeRepoPath(repoRootPath);
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  return `prj_${hash}`;
}
