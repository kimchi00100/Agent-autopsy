import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from '../core/context.js';
import { GitEngine } from '../git/git-engine.js';
import { extractFunctions, ExtractedFunction } from './function-extractor.js';

export interface ChangedFunction {
  filePath: string;
  name: string;
  kind: 'FUNCTION' | 'METHOD';
  startLine: number;
  endLine: number;
  signature?: string;
  addedLines: number[];
  deletedTraces: number[];
  changedLines: number;
  totalLines: number;
  reasons: string[];
}

export interface NeighborFunction {
  filePath: string;
  name: string;
  kind: 'FUNCTION' | 'METHOD';
  startLine: number;
  endLine: number;
  signature?: string;
  totalLines: number;
  relatedTo: string;
  relation: 'CALLS' | 'CALLED_BY';
  nameOnlyMatch: boolean;
  reasons: string[];
}

export interface TopLevelChange {
  filePath: string;
  name: string;
  kind: 'TOP_LEVEL';
  startLine: number;
  endLine: number;
  changedLines: number;
  totalLines: number;
  reasons: string[];
}

export interface HunkCandidate {
  filePath: string;
  name: string;
  kind: 'HUNK';
  startLine: number;
  endLine: number;
  changedLines: number;
  totalLines: number;
  reasons: string[];
}

export interface ScopeStats {
  totalRepoFunctions: number;
  changedFunctionCount: number;
  neighborFunctionCount: number;
  scopeFunctionCount: number;
  reductionRatio: number;
}

export interface ChangeScopeResult {
  baselineSha: string;
  baselineRule: 'INCIDENT_BASE_CHECKPOINT' | 'LAST_GOOD_CHECKPOINT' | 'NO_CHECKPOINT_HEAD' | 'EXPLICIT_BASELINE';
  warnings: string[];
  totalChangedFiles: number;
  analyzedFiles: number;
  changedFunctions: ChangedFunction[];
  neighborFunctions: NeighborFunction[];
  topLevelChanges: TopLevelChange[];
  hunks: HunkCandidate[];
  scopeStats: ScopeStats;
}

export interface LocateChangeScopeOptions {
  incidentId?: string;
  repoPath?: string;
  baselineSha?: string;
}

// Aliases for backwards compatibility
export type LocalizationResult = ChangeScopeResult;
export type LocateCandidatesOptions = LocateChangeScopeOptions;

const EXCLUDED_DIR_PATTERNS = [
  /^(node_modules|dist|build|\.git)(\/|\\|$)/i,
  /(\/|\\)(node_modules|dist|build|\.git)(\/|\\|$)/i,
];

const EXCLUDED_FILE_PATTERNS = [
  /\.(png|jpe?g|gif|ico|exe|dll|so|dylib|wasm|zip|tar|gz|pdf|lock)$/i,
  /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i,
];

const SUPPORTED_EXTENSIONS = new Set([
  '.py',
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
]);

function isExcludedFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  if (EXCLUDED_DIR_PATTERNS.some((p) => p.test(norm))) return true;
  if (EXCLUDED_FILE_PATTERNS.some((p) => p.test(norm))) return true;
  return false;
}

function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext) && !isExcludedFile(filePath);
}

interface ParsedDiffFile {
  filePath: string;
  addedLines: number[];
  deletedTraces: number[];
}

function parseGitDiffU0(diffOutput: string): Map<string, ParsedDiffFile> {
  const files = new Map<string, ParsedDiffFile>();
  const lines = diffOutput.split(/\r?\n/);
  let currentFile: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      if (!files.has(currentFile)) {
        files.set(currentFile, { filePath: currentFile, addedLines: [], deletedTraces: [] });
      }
    } else if (line.startsWith('@@ ') && currentFile) {
      // @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

        const fileRecord = files.get(currentFile);
        if (fileRecord) {
          if (newCount > 0) {
            for (let l = newStart; l < newStart + newCount; l++) {
              fileRecord.addedLines.push(l);
            }
          } else if (oldCount > 0 && newCount === 0) {
            fileRecord.deletedTraces.push(newStart === 0 ? 1 : newStart);
          }
        }
      }
    }
  }

  return files;
}

export async function locateChangeScope(
  ctx: CoreContext | { gitEngine: GitEngine; db?: any; ensureProject?: any },
  options: LocateChangeScopeOptions
): Promise<ChangeScopeResult> {
  const warnings: string[] = [];
  let repoPath = options.repoPath || '';
  let baselineSha = options.baselineSha || '';
  let baselineRule: ChangeScopeResult['baselineRule'] = 'EXPLICIT_BASELINE';

  // 1. Resolve Repo Path and Baseline SHA
  if (options.incidentId && ctx.db) {
    const incident = ctx.db.getIncident(options.incidentId);
    if (incident) {
      const project = ctx.db.getProject(incident.projectId);
      if (project) {
        repoPath = project.rootPath;
      }
      // Rule 1: baseCheckpointId worktreeCommitSha -> gitHeadSha
      if (incident.baseCheckpointId) {
        const cp = ctx.db.getCheckpoint(incident.baseCheckpointId);
        if (cp) {
          baselineSha = cp.worktreeCommitSha || cp.gitHeadSha || '';
          if (baselineSha) baselineRule = 'INCIDENT_BASE_CHECKPOINT';
        }
      }
      // Rule 2: Good checkpoint like getChangesSinceGoodCheckpoint
      if (!baselineSha && project) {
        const checkpoints = ctx.db.listCheckpoints(project.id);
        const goodCp =
          checkpoints.find((cp: any) => cp.gitStashSha === null && cp.changedFiles.length === 0) ||
          checkpoints[0];
        if (goodCp) {
          baselineSha = goodCp.worktreeCommitSha || goodCp.gitHeadSha || '';
          if (baselineSha) baselineRule = 'LAST_GOOD_CHECKPOINT';
        }
      }
    }
  } else if (repoPath && !baselineSha && ctx.db && ctx.ensureProject) {
    try {
      const project = ctx.ensureProject(repoPath);
      const checkpoints = ctx.db.listCheckpoints(project.id);
      const goodCp =
        checkpoints.find((cp: any) => cp.gitStashSha === null && cp.changedFiles.length === 0) ||
        checkpoints[0];
      if (goodCp) {
        baselineSha = goodCp.worktreeCommitSha || goodCp.gitHeadSha || '';
        if (baselineSha) baselineRule = 'LAST_GOOD_CHECKPOINT';
      }
    } catch {}
  }

  // Rule 3: Fallback to HEAD
  if (!baselineSha) {
    baselineSha = 'HEAD';
    baselineRule = 'NO_CHECKPOINT_HEAD';
    warnings.push('기준 시점 없음 — HEAD 대비 미커밋 변경만 분석함');
  }

  if (!repoPath) {
    warnings.push('저장소 경로를 확인할 수 없습니다.');
    return {
      baselineSha,
      baselineRule,
      warnings,
      totalChangedFiles: 0,
      analyzedFiles: 0,
      changedFunctions: [],
      neighborFunctions: [],
      topLevelChanges: [],
      hunks: [],
      scopeStats: {
        totalRepoFunctions: 0,
        changedFunctionCount: 0,
        neighborFunctionCount: 0,
        scopeFunctionCount: 0,
        reductionRatio: 0,
      },
    };
  }

  // 2. Change Collection via git diff -U0 and git ls-files
  const gitEngine = ctx.gitEngine;
  let diffOutput = '';
  try {
    diffOutput = gitEngine.runGit(repoPath, ['diff', '-U0', baselineSha]);
  } catch (err: any) {
    warnings.push(`git diff 실행 실패: ${err.message}`);
  }

  const fileDiffs = parseGitDiffU0(diffOutput);

  // Untracked files via git ls-files --others --exclude-standard
  try {
    const untrackedRaw = gitEngine.runGit(repoPath, ['ls-files', '--others', '--exclude-standard']);
    for (const rawLine of untrackedRaw.split(/\r?\n/)) {
      const relPath = rawLine.trim();
      if (!relPath || isExcludedFile(relPath)) continue;
      const fullPath = path.resolve(repoPath, relPath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lineCount = content.split(/\r?\n/).length;
        const addedLines: number[] = [];
        for (let l = 1; l <= lineCount; l++) addedLines.push(l);
        fileDiffs.set(relPath, {
          filePath: relPath,
          addedLines,
          deletedTraces: [],
        });
      }
    }
  } catch {}

  // Filter out excluded files
  for (const [filePath] of Array.from(fileDiffs.entries())) {
    if (isExcludedFile(filePath)) {
      fileDiffs.delete(filePath);
    }
  }

  const totalChangedFiles = fileDiffs.size;
  let filesToAnalyze = Array.from(fileDiffs.values());

  // Truncate to top 50 if too many changed files
  if (filesToAnalyze.length > 50) {
    filesToAnalyze.sort(
      (a, b) =>
        b.addedLines.length + b.deletedTraces.length - (a.addedLines.length + a.deletedTraces.length)
    );
    filesToAnalyze = filesToAnalyze.slice(0, 50);
    warnings.push(
      `변경 파일이 50개를 초과하여 (${totalChangedFiles}개), 변경 줄 수가 많은 상위 50개 파일만 분석했습니다.`
    );
  }

  const analyzedFiles = filesToAnalyze.length;

  // 3. Scan all tracked & untracked supported files in repository
  const allRepoFiles = new Set<string>();
  try {
    const trackedRaw = gitEngine.runGit(repoPath, ['ls-files']);
    for (const line of trackedRaw.split(/\r?\n/)) {
      const p = line.trim();
      if (p && isSupportedFile(p)) allRepoFiles.add(p);
    }
    const untrackedRaw = gitEngine.runGit(repoPath, ['ls-files', '--others', '--exclude-standard']);
    for (const line of untrackedRaw.split(/\r?\n/)) {
      const p = line.trim();
      if (p && isSupportedFile(p)) allRepoFiles.add(p);
    }
  } catch {}

  let totalRepoFunctions = 0;
  const functionRegistry = new Map<string, Array<{ func: ExtractedFunction; filePath: string }>>();
  const fileExtractedCache = new Map<string, ExtractedFunction[]>();

  for (const relPath of allRepoFiles) {
    const fullPath = path.resolve(repoPath, relPath);
    if (!fs.existsSync(fullPath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const res = await extractFunctions(relPath, content);
    if (res.supported) {
      totalRepoFunctions += res.functions.length;
      fileExtractedCache.set(relPath, res.functions);
      for (const func of res.functions) {
        const baseName = func.name.includes('.') ? func.name.split('.').pop()! : func.name;
        const entry = { func, filePath: relPath };
        if (!functionRegistry.has(func.name)) functionRegistry.set(func.name, []);
        functionRegistry.get(func.name)!.push(entry);
        if (baseName !== func.name) {
          if (!functionRegistry.has(baseName)) functionRegistry.set(baseName, []);
          functionRegistry.get(baseName)!.push(entry);
        }
      }
    }
  }

  // 4. Identify changed functions, top-level changes, and hunks
  const changedFunctions: ChangedFunction[] = [];
  const topLevelChanges: TopLevelChange[] = [];
  const hunks: HunkCandidate[] = [];

  for (const diffFile of filesToAnalyze) {
    const fullPath = path.resolve(repoPath, diffFile.filePath);
    if (!fs.existsSync(fullPath)) continue;

    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const addedSet = new Set(diffFile.addedLines);
    const deletedSet = new Set(diffFile.deletedTraces);
    const fileLines = content.split(/\r?\n/);
    const totalLinesInFile = fileLines.length;

    const functions = fileExtractedCache.get(diffFile.filePath) || [];
    const isSupported = isSupportedFile(diffFile.filePath);

    if (!isSupported) {
      // Unsupported language file: candidate hunk +/- 15 lines
      const allChanged = [...diffFile.addedLines, ...diffFile.deletedTraces].sort((a, b) => a - b);
      if (allChanged.length > 0) {
        const hunkStart = allChanged[0];
        const hunkEnd = allChanged[allChanged.length - 1];
        const startLine = Math.max(1, hunkStart - 15);
        const endLine = Math.min(totalLinesInFile, hunkEnd + 15);
        const ext = path.extname(diffFile.filePath) || '알 수 없음';
        hunks.push({
          filePath: diffFile.filePath,
          name: `(변경 덩어리 L${hunkStart}-L${hunkEnd})`,
          kind: 'HUNK',
          startLine,
          endLine,
          changedLines: allChanged.length,
          totalLines: endLine - startLine + 1,
          reasons: [`미지원 언어(${ext}) 파일의 변경 덩어리 (L${hunkStart}-L${hunkEnd})`],
        });
      }
      continue;
    }

    if (functions.length === 0) {
      // Supported file but no functions (script with only top-level code)
      const nonBlankChanged: number[] = [];
      for (const l of diffFile.addedLines) {
        if (fileLines[l - 1] && fileLines[l - 1].trim().length > 0) {
          nonBlankChanged.push(l);
        }
      }
      for (const l of diffFile.deletedTraces) {
        nonBlankChanged.push(l);
      }

      if (nonBlankChanged.length > 0) {
        nonBlankChanged.sort((a, b) => a - b);
        topLevelChanges.push({
          filePath: diffFile.filePath,
          name: `${path.basename(diffFile.filePath)} (최상위 코드)`,
          kind: 'TOP_LEVEL',
          startLine: nonBlankChanged[0] || 1,
          endLine: nonBlankChanged[nonBlankChanged.length - 1] || totalLinesInFile,
          changedLines: nonBlankChanged.length,
          totalLines: totalLinesInFile,
          reasons: [`함수 외부(파일 최상위)에서 ${nonBlankChanged.length}줄 변경`],
        });
      }
      continue;
    }

    // Supported file with functions
    const coveredLines = new Set<number>();
    for (const func of functions) {
      const funcAdded: number[] = [];
      const funcDeleted: number[] = [];
      for (let l = func.startLine; l <= func.endLine; l++) {
        if (addedSet.has(l)) funcAdded.push(l);
        if (deletedSet.has(l)) funcDeleted.push(l);
        coveredLines.add(l);
      }

      const funcChangedCount = funcAdded.length + funcDeleted.length;
      if (funcChangedCount > 0) {
        const totalLines = func.endLine - func.startLine + 1;
        changedFunctions.push({
          filePath: diffFile.filePath,
          name: func.name,
          kind: func.name.includes('.') ? 'METHOD' : 'FUNCTION',
          startLine: func.startLine,
          endLine: func.endLine,
          signature: func.signature,
          addedLines: funcAdded,
          deletedTraces: funcDeleted,
          changedLines: funcChangedCount,
          totalLines,
          reasons: [
            `기준 시점 이후 이 함수에서 ${funcAdded.length}줄 추가, ${funcDeleted.length}줄 삭제`,
            `함수 전체 ${totalLines}줄 중 ${funcChangedCount}줄 변경됨`,
          ],
        });
      }
    }

    // Top-level lines in file with functions
    const uncoveredNonBlank: number[] = [];
    for (const l of diffFile.addedLines) {
      if (!coveredLines.has(l) && fileLines[l - 1] && fileLines[l - 1].trim().length > 0) {
        uncoveredNonBlank.push(l);
      }
    }
    for (const l of diffFile.deletedTraces) {
      if (!coveredLines.has(l)) {
        uncoveredNonBlank.push(l);
      }
    }

    if (uncoveredNonBlank.length > 0) {
      uncoveredNonBlank.sort((a, b) => a - b);
      topLevelChanges.push({
        filePath: diffFile.filePath,
        name: `${path.basename(diffFile.filePath)} (최상위 코드)`,
        kind: 'TOP_LEVEL',
        startLine: uncoveredNonBlank[0],
        endLine: uncoveredNonBlank[uncoveredNonBlank.length - 1],
        changedLines: uncoveredNonBlank.length,
        totalLines: totalLinesInFile,
        reasons: [`함수 외부(파일 최상위)에서 ${uncoveredNonBlank.length}줄 변경`],
      });
    }
  }

  // 5. 1-Step Neighbor Functions (Callers & Callees)
  const changedKeySet = new Set(changedFunctions.map((f) => `${f.filePath}::${f.name}`));
  const neighborMap = new Map<string, NeighborFunction>();

  for (const changedFunc of changedFunctions) {
    const funcsInFile = fileExtractedCache.get(changedFunc.filePath) || [];
    const astFunc = funcsInFile.find(
      (f) => f.name === changedFunc.name && f.startLine === changedFunc.startLine
    );
    if (!astFunc) continue;

    // 5-A. Callees: functions called by changedFunc
    for (const calleeName of astFunc.calls) {
      const matches = functionRegistry.get(calleeName);
      if (matches) {
        for (const target of matches) {
          const key = `${target.filePath}::${target.func.name}`;
          if (changedKeySet.has(key)) continue; // Already directly changed

          if (neighborMap.has(key)) {
            const existing = neighborMap.get(key)!;
            if (!existing.relatedTo.includes(changedFunc.name)) {
              existing.relatedTo += `, ${changedFunc.name}`;
              existing.reasons.push(`변경 함수 ${changedFunc.name}이(가) 호출함`);
            }
          } else {
            const totalLines = target.func.endLine - target.func.startLine + 1;
            const nameOnlyMatch = matches.length > 1;
            const reasons = [`변경 함수 ${changedFunc.name}이(가) 호출함`];
            if (nameOnlyMatch) {
              reasons.push('이름만으로 연결됨');
            }

            neighborMap.set(key, {
              filePath: target.filePath,
              name: target.func.name,
              kind: target.func.name.includes('.') ? 'METHOD' : 'FUNCTION',
              startLine: target.func.startLine,
              endLine: target.func.endLine,
              signature: target.func.signature,
              totalLines,
              relatedTo: changedFunc.name,
              relation: 'CALLED_BY',
              nameOnlyMatch,
              reasons,
            });
          }
        }
      }
    }

    // 5-B. Callers: functions in repo that call changedFunc
    const baseChangedName = changedFunc.name.includes('.')
      ? changedFunc.name.split('.').pop()!
      : changedFunc.name;

    for (const [relPath, funcs] of fileExtractedCache.entries()) {
      for (const f of funcs) {
        if (f.calls.includes(changedFunc.name) || f.calls.includes(baseChangedName)) {
          const key = `${relPath}::${f.name}`;
          if (changedKeySet.has(key)) continue; // Already directly changed

          if (neighborMap.has(key)) {
            const existing = neighborMap.get(key)!;
            if (!existing.relatedTo.includes(changedFunc.name)) {
              existing.relatedTo += `, ${changedFunc.name}`;
              existing.reasons.push(`변경 함수 ${changedFunc.name}을(를) 호출함`);
            }
          } else {
            const totalLines = f.endLine - f.startLine + 1;
            neighborMap.set(key, {
              filePath: relPath,
              name: f.name,
              kind: f.name.includes('.') ? 'METHOD' : 'FUNCTION',
              startLine: f.startLine,
              endLine: f.endLine,
              signature: f.signature,
              totalLines,
              relatedTo: changedFunc.name,
              relation: 'CALLS',
              nameOnlyMatch: false,
              reasons: [`변경 함수 ${changedFunc.name}을(를) 호출함`],
            });
          }
        }
      }
    }
  }

  // 6. Sort all groups by filePath -> startLine (No rank, no score)
  const sortFn = (
    a: { filePath: string; startLine: number },
    b: { filePath: string; startLine: number }
  ) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine;

  changedFunctions.sort(sortFn);
  const neighborFunctions = Array.from(neighborMap.values()).sort(sortFn);
  topLevelChanges.sort(sortFn);
  hunks.sort(sortFn);

  // 7. Scope statistics
  const changedFunctionCount = changedFunctions.length;
  const neighborFunctionCount = neighborFunctions.length;
  const scopeFunctionCount = changedFunctionCount + neighborFunctionCount;
  const reductionRatio =
    totalRepoFunctions > 0
      ? Number(((totalRepoFunctions - scopeFunctionCount) / totalRepoFunctions).toFixed(4))
      : 0;

  return {
    baselineSha,
    baselineRule,
    warnings,
    totalChangedFiles,
    analyzedFiles,
    changedFunctions,
    neighborFunctions,
    topLevelChanges,
    hunks,
    scopeStats: {
      totalRepoFunctions,
      changedFunctionCount,
      neighborFunctionCount,
      scopeFunctionCount,
      reductionRatio,
    },
  };
}

export const locateCandidates = locateChangeScope;
