import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from '../core/context.js';
import {
  ChangeScopeResult,
  ChangedFunction,
  locateChangeScope,
} from './change-localizer.js';
import { Incident } from '../types.js';

export interface PackagedChangeScope {
  packageText: string;
  scopeResult: ChangeScopeResult;
  baselineSha: string;
  baselineRule: string;
  warnings: string[];
  truncationStep: number;
  truncationReason?: string;
  characterCount: number;
}

export interface PackChangeScopeOptions {
  maxCharacters?: number;
}

function getLanguageForExt(filePath: string): { lang: string; commentPrefix: string } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.py') {
    return { lang: 'python', commentPrefix: '#' };
  }
  if (['.ts', '.tsx'].includes(ext)) {
    return { lang: 'typescript', commentPrefix: '//' };
  }
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    return { lang: 'javascript', commentPrefix: '//' };
  }
  if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) {
    return { lang: 'cpp', commentPrefix: '//' };
  }
  return { lang: 'text', commentPrefix: '//' };
}

interface SliceInterval {
  start: number;
  end: number;
}

function mergeIntervals(intervals: SliceInterval[]): SliceInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const result: SliceInterval[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = result[result.length - 1];
    if (cur.start <= prev.end + 1) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      result.push(cur);
    }
  }
  return result;
}

function renderFunctionCode(
  fileLines: string[],
  func: ChangedFunction,
  mode: 'FULL' | 'WINDOW_15' | 'WINDOW_5',
  commentPrefix: string
): string {
  const { startLine, endLine, addedLines, deletedTraces } = func;
  const addedSet = new Set(addedLines);
  const deletedSet = new Set(deletedTraces);
  const changedLinesSet = new Set([...addedLines, ...deletedTraces]);

  const output: string[] = [];

  const renderLinesRange = (rangeStart: number, rangeEnd: number) => {
    for (let lineNum = rangeStart; lineNum <= rangeEnd; lineNum++) {
      if (deletedSet.has(lineNum)) {
        output.push(`${commentPrefix} >>> AUTOPSY 이 위치에서 줄 삭제됨`);
      }
      if (addedSet.has(lineNum)) {
        output.push(`${commentPrefix} >>> AUTOPSY 변경된 줄`);
      }
      const lineIdx = lineNum - 1;
      if (lineIdx >= 0 && lineIdx < fileLines.length) {
        output.push(fileLines[lineIdx]);
      }
    }
  };

  if (mode === 'FULL') {
    renderLinesRange(startLine, endLine);
    return output.join('\n');
  }

  // Windowed rendering
  const windowSize = mode === 'WINDOW_15' ? 15 : 5;
  const intervals: SliceInterval[] = [];

  // In WINDOW_5 mode, always include signature line (startLine)
  if (mode === 'WINDOW_5') {
    intervals.push({ start: startLine, end: Math.min(startLine, endLine) });
  }

  if (changedLinesSet.size === 0) {
    intervals.push({
      start: startLine,
      end: Math.min(endLine, startLine + windowSize),
    });
  } else {
    for (const cl of changedLinesSet) {
      const s = Math.max(startLine, cl - windowSize);
      const e = Math.min(endLine, cl + windowSize);
      intervals.push({ start: s, end: e });
    }
  }

  const merged = mergeIntervals(intervals);

  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i];
    if (i > 0) {
      output.push(`${commentPrefix} ... (생략) ...`);
    } else if (cur.start > startLine) {
      output.push(`${commentPrefix} ... (생략) ...`);
    }
    renderLinesRange(cur.start, cur.end);
    if (i === merged.length - 1 && cur.end < endLine) {
      output.push(`${commentPrefix} ... (생략) ...`);
    }
  }

  return output.join('\n');
}

export function packChangeScopeFromScope(
  incident: Incident | null,
  scopeResult: ChangeScopeResult,
  repoPath: string,
  options?: PackChangeScopeOptions
): PackagedChangeScope {
  const maxCharacters = options?.maxCharacters || 12000;

  // File cache for function extraction
  const fileCache = new Map<string, string[]>();
  const getFileLines = (relPath: string): string[] => {
    if (fileCache.has(relPath)) return fileCache.get(relPath)!;
    try {
      const fullPath = path.resolve(repoPath, relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      fileCache.set(relPath, lines);
      return lines;
    } catch {
      fileCache.set(relPath, []);
      return [];
    }
  };

  // Build package text helper
  const renderPackage = (
    step: number,
    stripBodyStartIndex: number = Infinity
  ): string => {
    const parts: string[] = [];

    // 1. Notice
    parts.push(
      '아래는 기준 시점 이후 바뀐 함수와 그 호출 관계에 있는 함수다. 순위가 아니며, 실행 증거로 확인된 원인도 아니다. 저장소 전체를 처음부터 읽지 말고, 먼저 이 범위의 함수들을 사용자 원문(userReportText)과 비교하라. 큰 변경이 버그라는 뜻이 아니다. 계산식, 비교 연산자, 빠진 필드처럼 작은 변경도 확인하라.'
    );
    parts.push('');

    // 2. User original report & intents
    if (incident) {
      parts.push('[사용자 보고 원문 (userReportText)]');
      parts.push(incident.userReportText || incident.title || '(내용 없음)');
      parts.push('');

      if (incident.intents) {
        parts.push('[사용자 의도 및 동작 정의]');
        const { expectedBehavior, observedBehavior, reproductionCondition, verificationMethod } = incident.intents;
        if (expectedBehavior?.value) {
          parts.push(`- 기대 동작 [${expectedBehavior.source || 'USER_QUOTE'}]: ${expectedBehavior.value}`);
        }
        if (observedBehavior?.value) {
          parts.push(`- 실제 증상 [${observedBehavior.source || 'USER_QUOTE'}]: ${observedBehavior.value}`);
        }
        if (reproductionCondition?.value) {
          parts.push(`- 재현 조건 [${reproductionCondition.source || 'USER_QUOTE'}]: ${reproductionCondition.value}`);
        }
        if (verificationMethod?.value) {
          parts.push(`- 검증 방법 [${verificationMethod.source || 'USER_QUOTE'}]: ${verificationMethod.value}`);
        }
        parts.push('');
      }
    }

    // 3. Baseline & Scope Statistics
    parts.push('[기준 시점 및 범위 통계]');
    parts.push(`- 기준 시점: ${scopeResult.baselineSha} (${scopeResult.baselineRule})`);
    parts.push(`- 저장소 전체 함수 수: ${scopeResult.scopeStats.totalRepoFunctions}`);
    parts.push(
      `- 범위 포함 함수 수: ${scopeResult.scopeStats.scopeFunctionCount} (직접 변경: ${scopeResult.scopeStats.changedFunctionCount}, 이웃: ${scopeResult.scopeStats.neighborFunctionCount})`
    );
    parts.push(`- 범위 축소 비율: ${(scopeResult.scopeStats.reductionRatio * 100).toFixed(1)}%`);

    if (scopeResult.warnings.length > 0) {
      parts.push(`- 경고: ${scopeResult.warnings.join('; ')}`);
    }

    if (step > 0) {
      parts.push(
        `- 패키지 축소 안내: ${step}단계 적용됨 (사유: 패키지 크기 상한 ${maxCharacters}자 대응)`
      );
    }
    parts.push('');

    // 4. Changed Functions
    parts.push(`[직접 변경된 함수 목록] (${scopeResult.changedFunctions.length}개)`);
    if (scopeResult.changedFunctions.length === 0) {
      parts.push('- 변경된 함수가 없습니다.');
    } else {
      for (let i = 0; i < scopeResult.changedFunctions.length; i++) {
        const cf = scopeResult.changedFunctions[i];
        const { lang, commentPrefix } = getLanguageForExt(cf.filePath);
        const funcLinesCount = cf.endLine - cf.startLine + 1;

        parts.push(
          `### ${i + 1}. ${cf.filePath}:${cf.startLine}-${cf.endLine} \`${cf.name}\``
        );
        parts.push(`- 변경 줄 수: ${cf.changedLines}줄 / 전체 ${funcLinesCount}줄`);
        parts.push(`- 근거: ${cf.reasons.join(', ')}`);

        if (step === 3 && i >= stripBodyStartIndex) {
          parts.push('*(패키지 크기 상한 초과로 본문 생략됨 - 파일 직접 확인 필요)*');
        } else {
          let renderMode: 'FULL' | 'WINDOW_15' | 'WINDOW_5' = 'FULL';
          if (step >= 2) {
            renderMode = 'WINDOW_5';
          } else if (step === 1 && funcLinesCount > 100) {
            renderMode = 'WINDOW_15';
          }

          const fileLines = getFileLines(cf.filePath);
          const codeSnippet = renderFunctionCode(fileLines, cf, renderMode, commentPrefix);
          parts.push(`\`\`\`${lang}`);
          parts.push(codeSnippet);
          parts.push('```');
        }
        parts.push('');
      }
    }

    // 5. Neighbor Functions
    parts.push(`[1단계 이웃 함수 목록] (${scopeResult.neighborFunctions.length}개)`);
    parts.push('(시그니처와 관계 정보만 제공됩니다. 상세 코드는 필요 시 직접 확인하세요.)');
    if (scopeResult.neighborFunctions.length === 0) {
      parts.push('- 이웃 함수가 없습니다.');
    } else {
      for (const nf of scopeResult.neighborFunctions) {
        const matchNote = nf.nameOnlyMatch ? ' (이름 매칭)' : '';
        const sig = nf.signature ? ` | 시그니처: \`${nf.signature}\`` : '';
        parts.push(
          `- \`${nf.name}\` (${nf.filePath}:${nf.startLine}-${nf.endLine}) [${nf.relation} ${nf.relatedTo}]${matchNote}${sig}`
        );
      }
    }
    parts.push('');

    // 6. Top Level Changes
    if (scopeResult.topLevelChanges.length > 0) {
      parts.push(`[함수 밖 변경 사항] (${scopeResult.topLevelChanges.length}건)`);
      for (const tc of scopeResult.topLevelChanges) {
        parts.push(
          `- ${tc.filePath}:${tc.startLine}-${tc.endLine} (${tc.reasons.join(', ')})`
        );
      }
      parts.push('');
    }

    // 7. Hunks (Unsupported Languages)
    if (scopeResult.hunks.length > 0) {
      parts.push(`[미지원 언어 변경 덩어리] (${scopeResult.hunks.length}건)`);
      for (const h of scopeResult.hunks) {
        parts.push(
          `- ${h.filePath}:${h.startLine}-${h.endLine} (${h.reasons.join(', ')})`
        );
      }
      parts.push('');
    }

    return parts.join('\n');
  };

  // Determine truncation step
  let finalStep = 0;
  let finalReason: string | undefined = undefined;
  let text = renderPackage(0, Infinity);

  if (text.length > maxCharacters) {
    // Try Step 1: truncate >100 line functions
    finalStep = 1;
    finalReason = '100줄 초과 함수의 본문을 변경 줄 ±15줄로 축소함';
    text = renderPackage(1, Infinity);

    if (text.length > maxCharacters) {
      // Try Step 2: all functions signature + ±5 lines
      finalStep = 2;
      finalReason = '전체 크기 상한 초과로 모든 바뀐 함수를 시그니처 및 변경 줄 ±5줄로 축소함';
      text = renderPackage(2, Infinity);

      if (text.length > maxCharacters) {
        // Try Step 3: strip bodies starting from the last function backward
        finalStep = 3;
        const totalFuncs = scopeResult.changedFunctions.length;
        let chosenCut = 0;
        for (let k = totalFuncs - 1; k >= 0; k--) {
          const candidateText = renderPackage(3, k);
          if (candidateText.length <= maxCharacters) {
            chosenCut = k;
            text = candidateText;
            finalReason = `전체 크기 상한 초과로 뒤쪽 ${totalFuncs - k}개 함수의 본문을 생략하고 위치 정보만 유지함`;
            break;
          }
        }
        if (chosenCut === 0 && text.length > maxCharacters) {
          text = renderPackage(3, 0);
          finalReason = '전체 크기 상한 초과로 모든 바뀐 함수의 본문을 생략하고 위치 정보만 유지함';
        }
      }
    }
  }

  return {
    packageText: text,
    scopeResult,
    baselineSha: scopeResult.baselineSha,
    baselineRule: scopeResult.baselineRule,
    warnings: scopeResult.warnings,
    truncationStep: finalStep,
    truncationReason: finalReason,
    characterCount: text.length,
  };
}

export async function packChangeScope(
  ctx: CoreContext | { db: any; gitEngine: any; ensureProject: any },
  incidentId: string,
  options?: PackChangeScopeOptions
): Promise<PackagedChangeScope> {
  const incident: Incident | null = ctx.db ? ctx.db.getIncident(incidentId) : null;
  let repoPath = '';
  if (incident && ctx.db) {
    const project = ctx.db.getProject(incident.projectId);
    if (project) {
      repoPath = project.rootPath;
    }
  }

  const scopeResult = await locateChangeScope(ctx, { incidentId, repoPath });
  return packChangeScopeFromScope(incident, scopeResult, repoPath, options);
}
