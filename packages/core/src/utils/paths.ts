import * as path from 'node:path';
import * as fs from 'node:fs';
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
 * Normalizes a file path relative to a repository root.
 * Resolves relative segments (./, ../), unifies separators to '/',
 * and lowercases on Windows so path variants match deterministically.
 */
export function normalizePathUnderRepo(repoPath: string, targetPath: string): string {
  const resolved = path.resolve(repoPath, targetPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Checks whether two file paths under a repository resolve to the exact same file.
 * Handles './file', '.\file', 'sub/../file', full repo paths, and case variants on Windows.
 */
export function isSamePathUnderRepo(repoPath: string, pathA: string, pathB: string): boolean {
  return normalizePathUnderRepo(repoPath, pathA) === normalizePathUnderRepo(repoPath, pathB);
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

/**
 * Validates that a file path is a strictly safe relative path within baseDirectory.
 * Blocks absolute paths, directory traversal, drive indicators, NTFS ADS, .git folders,
 * and symlink/junction escapes.
 * Returns the normalized repository-relative path with '/' separators on success.
 * Throws Error with code 'INVALID_FILE_PATH' on failure.
 */
export function validateRepoRelativeFilePath(baseDirectory: string, filePath: string): string {
  if (typeof filePath !== 'string' || filePath.trim() === '' || filePath.includes('\0')) {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 파일 경로가 유효하지 않습니다 (빈 문자열, 공백 또는 NUL 문자 포함). 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule b: Absolute paths (starts with / or \, UNC)
  if (filePath.startsWith('/') || filePath.startsWith('\\')) {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 절대 경로 또는 UNC 경로는 허용되지 않습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요 (절대 경로 및 UNC 경로 금지).',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule c: Colon anywhere (drive letters C:\, C:/, C:foo, and NTFS alternate data stream file.js:stream)
  if (filePath.includes(':')) {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 경로에 콜론(:) 문자가 포함되어 있어 허용되지 않습니다 (드라이브 지정자 또는 NTFS 대체 데이터 스트림 차단). 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요 (드라이브 지정자 및 대체 데이터 스트림 금지).',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule f: Ends with slash (directory)
  if (filePath.endsWith('/') || filePath.endsWith('\\')) {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 디렉터리를 가리키는 경로는 허용되지 않습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '디렉터리가 아닌 파일의 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule d: Normalize and verify not escaping repo root
  const unified = filePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(unified);

  if (normalized === '.' || normalized === '') {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 저장소 루트 디렉터리 자체는 대상 파일이 될 수 없습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  if (normalized.startsWith('../') || normalized === '..') {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: 저장소 루트 외부("..")를 가리키는 경로는 허용되지 않습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요 (상위 디렉터리 탈출 금지).',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule e: First segment is .git (case-insensitive)
  const segments = normalized.split('/');
  if (segments[0].toLowerCase() === '.git') {
    const err: any = new Error(
      '[INVALID_FILE_PATH]: .git 디렉터리 내부 파일은 수정할 수 없습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.'
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출해 주세요 (.git 디렉터리 수정 금지).',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  // Rule g: Folder link escape (symlink / junction)
  let realBase: string;
  try {
    realBase = fs.realpathSync(baseDirectory);
  } catch {
    realBase = path.resolve(baseDirectory);
  }

  const fullTarget = path.resolve(baseDirectory, normalized);
  let checkPath = fullTarget;
  while (!fs.existsSync(checkPath)) {
    const parent = path.dirname(checkPath);
    if (parent === checkPath) break;
    checkPath = parent;
  }

  let realCheck: string;
  try {
    realCheck = fs.realpathSync(checkPath);
  } catch {
    realCheck = path.resolve(checkPath);
  }

  const isWin = process.platform === 'win32';
  const normBase = isWin ? path.resolve(realBase).toLowerCase() : path.resolve(realBase);
  const normCheck = isWin ? path.resolve(realCheck).toLowerCase() : path.resolve(realCheck);
  const rel = path.relative(normBase, normCheck);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err: any = new Error(
      `[INVALID_FILE_PATH]: 심볼릭 링크 또는 폴더 연결(정션)을 통해 저장소 외부("${realCheck}")를 가리키는 경로는 허용되지 않습니다. 저장소 루트 기준 상대 경로(예: src/calc.js)로 다시 제출하세요.`
    );
    err.code = 'INVALID_FILE_PATH';
    err.next_action = {
      actor: 'AGENT',
      action: 'FIX_REPAIR',
      agent_should: '저장소 내부의 실제 파일 상대 경로(예: src/calc.js)로 다시 제출해 주세요 (외부 디렉터리 링크 참조 금지).',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
    throw err;
  }

  return normalized;
}
