import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from '../core/context.js';
import { GitEngine } from '../git/git-engine.js';
import { extractFunctions, ExtractedFunction } from './function-extractor.js';

export interface LocalizationCandidate {
  rank: number;
  filePath: string;
  name: string;
  kind: 'FUNCTION' | 'METHOD' | 'TOP_LEVEL' | 'HUNK';
  startLine: number;
  endLine: number;
  score: number;
  signature?: string;
  changedLines: number;
  totalLines: number;
  reasons: string[];
  isNeighbor?: boolean;
  relatedTo?: string;
}

export interface LocalizationResult {
  baselineSha: string;
  baselineRule: 'INCIDENT_BASE_CHECKPOINT' | 'LAST_GOOD_CHECKPOINT' | 'NO_CHECKPOINT_HEAD' | 'EXPLICIT_BASELINE';
  warnings: string[];
  totalChangedFiles: number;
  analyzedFiles: number;
  candidates: LocalizationCandidate[];
}

export interface LocateCandidatesOptions {
  incidentId?: string;
  repoPath?: string;
  baselineSha?: string;
  maxCandidates?: number;
}

const EXCLUDED_DIR_PATTERNS = [
  /^(node_modules|dist|build|\.git)(\/|\\|$)/i,
  /(\/|\\)(node_modules|dist|build|\.git)(\/|\\|$)/i,
];

const EXCLUDED_FILE_PATTERNS = [
  /\.(png|jpe?g|gif|ico|exe|dll|so|dylib|wasm|zip|tar|gz|pdf|lock)$/i,
  /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i,
];

function isExcludedFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  if (EXCLUDED_DIR_PATTERNS.some((p) => p.test(norm))) return true;
  if (EXCLUDED_FILE_PATTERNS.some((p) => p.test(norm))) return true;
  return false;
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
            // Pure deletion trace: next line at deletion spot
            fileRecord.deletedTraces.push(newStart === 0 ? 1 : newStart);
          }
        }
      }
    }
  }

  return files;
}

export async function locateCandidates(
  ctx: CoreContext | { gitEngine: GitEngine; db?: any; ensureProject?: any },
  options: LocateCandidatesOptions
): Promise<LocalizationResult> {
  const warnings: string[] = [];
  let repoPath = options.repoPath || '';
  let baselineSha = options.baselineSha || '';
  let baselineRule: LocalizationResult['baselineRule'] = 'EXPLICIT_BASELINE';

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
      candidates: [],
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

  // 3. Extract functions and identify modified functions
  const candidatePool: LocalizationCandidate[] = [];
  const modifiedFunctions: Array<{
    func: ExtractedFunction;
    filePath: string;
    score: number;
    changedLines: number;
  }> = [];

  // Track extracted functions by name across analyzed files
  const functionRegistry = new Map<string, Array<{ func: ExtractedFunction; filePath: string }>>();

  for (const diffFile of filesToAnalyze) {
    const fullPath = path.resolve(repoPath, diffFile.filePath);
    if (!fs.existsSync(fullPath)) continue;

    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const extractRes = await extractFunctions(diffFile.filePath, content);
    const addedSet = new Set(diffFile.addedLines);
    const deletedSet = new Set(diffFile.deletedTraces);
    const totalLinesInFile = content.split(/\r?\n/).length;

    if (!extractRes.supported || extractRes.functions.length === 0) {
      if (extractRes.supported && extractRes.functions.length === 0) {
        // Supported file but no functions (e.g. script with only top-level statements)
        const changedLinesCount = diffFile.addedLines.length + diffFile.deletedTraces.length;
        if (changedLinesCount > 0) {
          const allChanged = [...diffFile.addedLines, ...diffFile.deletedTraces].sort((a, b) => a - b);
          candidatePool.push({
            rank: 0,
            filePath: diffFile.filePath,
            name: `${path.basename(diffFile.filePath)} (최상위 코드)`,
            kind: 'TOP_LEVEL',
            startLine: allChanged[0] || 1,
            endLine: allChanged[allChanged.length - 1] || totalLinesInFile,
            score: 50.0 + Math.min(changedLinesCount, 20) * 1.5,
            changedLines: changedLinesCount,
            totalLines: totalLinesInFile,
            reasons: [`함수 외부(파일 최상위)에서 ${changedLinesCount}줄 변경`],
          });
        }
      } else {
        // Unsupported language file: candidate hunk +/- 15 lines
        const allChanged = [...diffFile.addedLines, ...diffFile.deletedTraces].sort((a, b) => a - b);
        if (allChanged.length > 0) {
          const hunkStart = allChanged[0];
          const hunkEnd = allChanged[allChanged.length - 1];
          const startLine = Math.max(1, hunkStart - 15);
          const endLine = Math.min(totalLinesInFile, hunkEnd + 15);
          const ext = path.extname(diffFile.filePath) || '알 수 없음';
          candidatePool.push({
            rank: 0,
            filePath: diffFile.filePath,
            name: `(변경 덩어리 L${hunkStart}-L${hunkEnd})`,
            kind: 'HUNK',
            startLine,
            endLine,
            score: 40.0 + Math.min(allChanged.length, 10),
            changedLines: allChanged.length,
            totalLines: endLine - startLine + 1,
            reasons: [`미지원 언어(${ext}) 파일의 변경 덩어리 (L${hunkStart}-L${hunkEnd})`],
          });
        }
      }
      continue;
    }

    // Supported language with functions
    const coveredLines = new Set<number>();

    for (const func of extractRes.functions) {
      // Register function for call resolution
      const baseName = func.name.includes('.') ? func.name.split('.').pop()! : func.name;
      const entry = { func, filePath: diffFile.filePath };
      if (!functionRegistry.has(func.name)) functionRegistry.set(func.name, []);
      functionRegistry.get(func.name)!.push(entry);
      if (baseName !== func.name) {
        if (!functionRegistry.has(baseName)) functionRegistry.set(baseName, []);
        functionRegistry.get(baseName)!.push(entry);
      }

      let funcAdded = 0;
      let funcDeleted = 0;
      for (let l = func.startLine; l <= func.endLine; l++) {
        if (addedSet.has(l)) funcAdded++;
        if (deletedSet.has(l)) funcDeleted++;
        coveredLines.add(l);
      }

      const funcChanged = funcAdded + funcDeleted;
      if (funcChanged > 0) {
        const totalLines = func.endLine - func.startLine + 1;
        const ratio = funcChanged / Math.max(1, totalLines);
        // Scoring formula for directly modified functions:
        // score = 100.0 + min(changedLines, 50) * 2.0 + (ratio * 30.0)
        const score = Number((100.0 + Math.min(funcChanged, 50) * 2.0 + ratio * 30.0).toFixed(2));
        const reasons = [
          `기준 시점 이후 이 함수에서 ${funcAdded}줄 추가, ${funcDeleted}줄 삭제`,
          `함수 전체 ${totalLines}줄 중 ${funcChanged}줄(${Math.round(ratio * 100)}%) 변경됨`,
        ];

        const cand: LocalizationCandidate = {
          rank: 0,
          filePath: diffFile.filePath,
          name: func.name,
          kind: func.name.includes('.') ? 'METHOD' : 'FUNCTION',
          startLine: func.startLine,
          endLine: func.endLine,
          score,
          signature: func.signature,
          changedLines: funcChanged,
          totalLines,
          reasons,
        };

        candidatePool.push(cand);
        modifiedFunctions.push({
          func,
          filePath: diffFile.filePath,
          score,
          changedLines: funcChanged,
        });
      }
    }

    // Check for top-level changes outside any function
    const fileLines = content.split(/\r?\n/);
    const uncoveredChanged: number[] = [];
    for (const l of diffFile.addedLines) {
      if (!coveredLines.has(l)) {
        if (fileLines[l - 1] && fileLines[l - 1].trim().length > 0) {
          uncoveredChanged.push(l);
        }
      }
    }
    for (const l of diffFile.deletedTraces) {
      if (!coveredLines.has(l)) uncoveredChanged.push(l);
    }

    if (uncoveredChanged.length > 0) {
      uncoveredChanged.sort((a, b) => a - b);
      candidatePool.push({
        rank: 0,
        filePath: diffFile.filePath,
        name: `${path.basename(diffFile.filePath)} (최상위 코드)`,
        kind: 'TOP_LEVEL',
        startLine: uncoveredChanged[0],
        endLine: uncoveredChanged[uncoveredChanged.length - 1],
        score: 50.0 + Math.min(uncoveredChanged.length, 20) * 1.5,
        changedLines: uncoveredChanged.length,
        totalLines: totalLinesInFile,
        reasons: [`함수 외부(파일 최상위)에서 ${uncoveredChanged.length}줄 변경`],
      });
    }
  }

  // 4. Neighbor Function Resolution (Callees and Callers within 1 step)
  for (const mod of modifiedFunctions) {
    const callerFunc = mod.func;
    const callerFile = mod.filePath;

    // 4-A. Callees: Functions called by callerFunc
    for (const calleeName of callerFunc.calls) {
      // Find matching function definitions
      let matches = functionRegistry.get(calleeName);
      if (!matches || matches.length === 0) {
        // Search repo for this function via git grep
        try {
          const grepResult = gitEngine.runGit(repoPath, ['grep', '-l', '-w', calleeName]);
          for (const rawLine of grepResult.split(/\r?\n/)) {
            const rel = rawLine.trim();
            if (!rel || isExcludedFile(rel)) continue;
            const fp = path.resolve(repoPath, rel);
            if (fs.existsSync(fp)) {
              const c = fs.readFileSync(fp, 'utf8');
              const res = await extractFunctions(rel, c);
              for (const f of res.functions) {
                const bName = f.name.includes('.') ? f.name.split('.').pop()! : f.name;
                const reg = { func: f, filePath: rel };
                if (!functionRegistry.has(f.name)) functionRegistry.set(f.name, []);
                functionRegistry.get(f.name)!.push(reg);
                if (bName !== f.name) {
                  if (!functionRegistry.has(bName)) functionRegistry.set(bName, []);
                  functionRegistry.get(bName)!.push(reg);
                }
              }
            }
          }
        } catch {}
        matches = functionRegistry.get(calleeName);
      }

      if (matches) {
        for (const target of matches) {
          // Check if already in candidate pool
          const existing = candidatePool.find(
            (c) => c.filePath === target.filePath && c.name === target.func.name
          );
          if (existing) {
            existing.score += 10.0;
            existing.reasons.push(`변경 함수 ${callerFunc.name}이(가) 호출함`);
            if (existing.relatedTo && !existing.relatedTo.includes(callerFunc.name)) {
              existing.relatedTo += `, ${callerFunc.name}`;
            } else if (!existing.relatedTo) {
              existing.relatedTo = callerFunc.name;
            }
          } else {
            // New neighbor candidate
            const totalLines = target.func.endLine - target.func.startLine + 1;
            const neighborScore = Math.max(30.0, mod.score * 0.6);
            const reasons = [`변경 함수 ${callerFunc.name}이(가) 호출함`];
            if (matches.length > 1) {
              reasons.push('이름만으로 연결됨');
            }

            candidatePool.push({
              rank: 0,
              filePath: target.filePath,
              name: target.func.name,
              kind: target.func.name.includes('.') ? 'METHOD' : 'FUNCTION',
              startLine: target.func.startLine,
              endLine: target.func.endLine,
              score: neighborScore,
              signature: target.func.signature,
              changedLines: 0,
              totalLines,
              reasons,
              isNeighbor: true,
              relatedTo: callerFunc.name,
            });
          }
        }
      }
    }

    // 4-B. Callers: Functions that call callerFunc
    const baseCallerName = callerFunc.name.includes('.')
      ? callerFunc.name.split('.').pop()!
      : callerFunc.name;
    const namesToSearch = [callerFunc.name];
    if (baseCallerName !== callerFunc.name) namesToSearch.push(baseCallerName);

    for (const nameToSearch of namesToSearch) {
      try {
        const grepResult = gitEngine.runGit(repoPath, ['grep', '-l', '-w', nameToSearch]);
        for (const rawLine of grepResult.split(/\r?\n/)) {
          const rel = rawLine.trim();
          if (!rel || isExcludedFile(rel)) continue;
          const fp = path.resolve(repoPath, rel);
          if (fs.existsSync(fp)) {
            const c = fs.readFileSync(fp, 'utf8');
            const res = await extractFunctions(rel, c);
            for (const f of res.functions) {
              if (f.calls.includes(callerFunc.name) || f.calls.includes(baseCallerName)) {
                const existing = candidatePool.find(
                  (c) => c.filePath === rel && c.name === f.name
                );
                if (existing) {
                  existing.score += 10.0;
                  existing.reasons.push(`변경 함수 ${callerFunc.name}을(를) 호출함`);
                  if (existing.relatedTo && !existing.relatedTo.includes(callerFunc.name)) {
                    existing.relatedTo += `, ${callerFunc.name}`;
                  } else if (!existing.relatedTo) {
                    existing.relatedTo = callerFunc.name;
                  }
                } else {
                  const totalLines = f.endLine - f.startLine + 1;
                  const neighborScore = Math.max(30.0, mod.score * 0.6);
                  candidatePool.push({
                    rank: 0,
                    filePath: rel,
                    name: f.name,
                    kind: f.name.includes('.') ? 'METHOD' : 'FUNCTION',
                    startLine: f.startLine,
                    endLine: f.endLine,
                    score: neighborScore,
                    signature: f.signature,
                    changedLines: 0,
                    totalLines,
                    reasons: [`변경 함수 ${callerFunc.name}을(를) 호출함`],
                    isNeighbor: true,
                    relatedTo: callerFunc.name,
                  });
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  // 5. Ranking and Mandatory Top-5 Neighbor Inclusion
  candidatePool.sort((a, b) => b.score - a.score);

  const maxCandidates = options.maxCandidates || 5;

  if (candidatePool.length > 0) {
    const rank1 = candidatePool[0];
    const top5 = candidatePool.slice(0, Math.min(maxCandidates, candidatePool.length));

    // Check if any candidate in top 5 is a caller or callee of rank 1
    const hasRank1NeighborInTop5 = top5.some(
      (c) =>
        c !== rank1 &&
        ((c.relatedTo && c.relatedTo.includes(rank1.name)) ||
          (rank1.relatedTo && rank1.relatedTo.includes(c.name)))
    );

    if (!hasRank1NeighborInTop5 && candidatePool.length > maxCandidates) {
      // Find the best neighbor of rank 1 outside top 5
      const neighborIdx = candidatePool.findIndex(
        (c, idx) =>
          idx >= maxCandidates &&
          ((c.relatedTo && c.relatedTo.includes(rank1.name)) ||
            (rank1.relatedTo && rank1.relatedTo.includes(c.name)))
      );
      if (neighborIdx !== -1) {
        const neighborCand = candidatePool.splice(neighborIdx, 1)[0];
        // Insert into the 5th position (index 4)
        candidatePool.splice(maxCandidates - 1, 0, neighborCand);
      }
    }
  }

  const finalCandidates = candidatePool.slice(0, maxCandidates).map((c, i) => ({
    ...c,
    rank: i + 1,
  }));

  return {
    baselineSha,
    baselineRule,
    warnings,
    totalChangedFiles,
    analyzedFiles,
    candidates: finalCandidates,
  };
}
