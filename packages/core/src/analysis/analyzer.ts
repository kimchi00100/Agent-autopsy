import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EvidenceStrength,
  CauseCandidate,
  FlowNode,
  FlowEdge,
  IncidentFlowData,
  Incident,
  ThreeLevelHealth,
  HealthLevelStatus,
  CauseVerdict,
  VerificationType,
} from '../types.js';

export interface DiffFileInfo {
  filePath: string;
  addedLines: number;
  removedLines: number;
  /** New file line ranges modified */
  ranges: Array<{ start: number; end: number }>;
  /** Symbols extracted from modified lines */
  symbols: string[];
}

export interface StackFrame {
  filePath: string;
  line: number;
}

export interface IncidentAnalysis {
  failedStage: { kind: 'RUNTIME' | 'BUILD' | 'TEST' | 'UNKNOWN'; summary: string };
  stackFrames: StackFrame[];
  failedTests: string[];
  changedFiles: DiffFileInfo[];
  candidates: CauseCandidate[];
  flowData: IncidentFlowData;
  threeLevelHealth?: ThreeLevelHealth;
  causeVerdict?: CauseVerdict;
  missingEvidenceChecklist?: string[];
  verificationType?: VerificationType;
}

export interface DiscoveredModule {
  filePath: string;
  chain: string[];
  depth: number;
  importedBy: string;
  symbols: string[];
}

const IGNORED_IDENTIFIERS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'import', 'from',
  'export', 'default', 'new', 'this', 'true', 'false', 'null', 'undefined', 'async', 'await', 'def', 'self',
  'None', 'True', 'False', 'in', 'of', 'and', 'or', 'not', 'typeof', 'throw', 'try', 'catch', 'require',
]);

/**
 * Recursively crawls static import and require statements from start files up to maxDepth.
 */
export function crawlStaticDependencies(
  repoRoot: string,
  startFiles: string[],
  maxDepth: number = 2
): DiscoveredModule[] {
  const discovered: DiscoveredModule[] = [];
  const visited = new Set<string>();
  const queue: Array<{ absPath: string; relPath: string; chain: string[]; depth: number }> = [];

  for (const start of startFiles) {
    const abs = path.isAbsolute(start) ? start : path.resolve(repoRoot, start);
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    visited.add(rel.toLowerCase());
    queue.push({ absPath: abs, relPath: rel, chain: [path.basename(rel)], depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    let content = '';
    try {
      if (fs.existsSync(current.absPath) && fs.statSync(current.absPath).isFile()) {
        content = fs.readFileSync(current.absPath, 'utf8');
      }
    } catch {
      continue;
    }

    if (!content) continue;

    // Match import ... from '...' or require('...')
    const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const importTarget = match[1];
      const dir = path.dirname(current.absPath);

      const candidatePaths = [
        path.resolve(dir, importTarget),
        path.resolve(dir, importTarget + '.js'),
        path.resolve(dir, importTarget + '.ts'),
        path.resolve(dir, importTarget + '.mjs'),
        path.resolve(dir, importTarget + '.cjs'),
        path.resolve(dir, importTarget, 'index.js'),
        path.resolve(dir, importTarget, 'index.ts'),
      ];

      let resolvedAbs: string | null = null;
      for (const p of candidatePaths) {
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            resolvedAbs = p;
            break;
          }
        } catch {}
      }

      if (!resolvedAbs) continue;

      const targetRel = path.relative(repoRoot, resolvedAbs).replace(/\\/g, '/');
      const targetRelLower = targetRel.toLowerCase();
      if (visited.has(targetRelLower)) continue;
      visited.add(targetRelLower);

      const targetSymbols: string[] = [];
      try {
        const targetSrc = fs.readFileSync(resolvedAbs, 'utf8');
        const symMatches = targetSrc.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
        const symSet = new Set<string>();
        for (const token of symMatches) {
          if (!IGNORED_IDENTIFIERS.has(token)) symSet.add(token);
        }
        targetSymbols.push(...Array.from(symSet).slice(0, 40));
      } catch {}

      const newChain = [...current.chain, path.basename(targetRel)];
      discovered.push({
        filePath: targetRel,
        chain: newChain,
        depth: current.depth + 1,
        importedBy: current.relPath,
        symbols: targetSymbols,
      });

      queue.push({
        absPath: resolvedAbs,
        relPath: targetRel,
        chain: newChain,
        depth: current.depth + 1,
      });
    }
  }

  return discovered;
}

export function parseUnifiedDiff(diff: string): DiffFileInfo[] {
  const files: DiffFileInfo[] = [];
  let current: DiffFileInfo | null = null;
  let newLine = 0;
  let rangeStart = -1;
  const symbols = new Map<string, Set<string>>();

  const closeRange = (endLine: number) => {
    if (current && rangeStart !== -1) {
      current.ranges.push({ start: rangeStart, end: Math.max(rangeStart, endLine) });
    }
    rangeStart = -1;
  };

  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      closeRange(newLine);
      const m = raw.match(/ b\/(.+)$/);
      current = { filePath: m ? m[1] : 'unknown', addedLines: 0, removedLines: 0, ranges: [], symbols: [] };
      symbols.set(current.filePath, new Set());
      files.push(current);
      continue;
    }
    if (!current) {
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (m) {
        current = { filePath: m[1], addedLines: 0, removedLines: 0, ranges: [], symbols: [] };
        symbols.set(current.filePath, new Set());
        files.push(current);
      }
      continue;
    }
    if (raw.startsWith('+++ ') || raw.startsWith('--- ') || raw.startsWith('index ')) continue;

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      closeRange(newLine);
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      if (rangeStart === -1) rangeStart = newLine;
      current.addedLines++;
      collectSymbols(raw.slice(1), symbols.get(current.filePath)!);
      newLine++;
    } else if (raw.startsWith('-')) {
      if (rangeStart === -1) rangeStart = newLine;
      current.removedLines++;
      collectSymbols(raw.slice(1), symbols.get(current.filePath)!);
    } else {
      closeRange(newLine - 1);
      newLine++;
    }
  }
  closeRange(newLine);

  for (const f of files) {
    f.symbols = [...(symbols.get(f.filePath) ?? [])].slice(0, 40);
  }
  return files;
}

function collectSymbols(line: string, into: Set<string>): void {
  const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [];
  for (const token of matches) {
    if (!IGNORED_IDENTIFIERS.has(token)) into.add(token);
  }
}

export interface StackTracePattern {
  name: string;
  pattern: RegExp;
  extract: (match: RegExpExecArray) => { filePath: string; line: number } | null;
}

export const STACK_TRACE_PATTERNS: StackTracePattern[] = [
  // 1. Python traceback: File "tests/test_calc.py", line 12, in test_add
  {
    name: 'Python Traceback',
    pattern: /File "([^"]+)", line (\d+)/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 2. JS / Node / TS: at Object.<anonymous> (test/calc.test.js:12:5) or at test/calc.test.js:12:5
  {
    name: 'JavaScript / TypeScript',
    pattern: /(?:(?:^|\s)at (?:[^\n()]+ \()?|^\s*at\s+)((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.(?:[cm]?[jt]sx?)):(\d+)(?::\d+)?\)?/gm,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 3. C / C++ Compiler (GCC, Clang): src/calc.c:25:5: error: ...
  {
    name: 'C/C++ Compiler (GCC/Clang)',
    pattern: /(?:^|\n)((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.(?:c|cc|cpp|cxx|h|hpp)):(\d+)(?::\d+)?: (?:fatal error|error|warning):/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 4. GoogleTest: test/calc_test.cpp:15: Failure
  {
    name: 'GoogleTest',
    pattern: /(?:^|\n)((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.(?:cc|cpp|cxx|h|hpp|c)):(\d+): Failure/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 5. C/C++ Sanitizer / ASan / UBSan: #0 0x401234 in main src/calc.c:42:10
  {
    name: 'C/C++ Sanitizer (ASan/UBSan)',
    pattern: /(?:#\d+\s+0x[0-9a-fA-F]+\s+in\s+\S+\s+|\bin\s+)((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.(?:c|cc|cpp|cxx|h|hpp)):(\d+)/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 6. Java / Kotlin: at com.example.CalcTest.testDiv(CalcTest.java:34)
  {
    name: 'Java / Kotlin',
    pattern: /at\s+[\w.$]+\((?:.*[/\\])?([^\s():]+\.(?:java|kt)):(\d+)\)/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 7. Go: \tsrc/calc_test.go:28 +0x5a
  {
    name: 'Go',
    pattern: /(?:^|\s)((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.go):(\d+)(?:\s+\+0x[0-9a-fA-F]+)?/gm,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 8. Rust: --> tests/calc_test.rs:18:9 or at tests/calc_test.rs:18
  {
    name: 'Rust',
    pattern: /(?:-->|at)\s+((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.rs):(\d+)(?::\d+)?/g,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
  // 9. Generic File Line Fallback: path/to/file.ext:line(:col)
  {
    name: 'Generic File Line',
    pattern: /(?:^|[\s('"<[])((?:[A-Za-z]:)?[^\s()'"<>|:*?]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|c|cc|cpp|cxx|h|hpp|cs)):(\d+)(?::\d+)?(?:$|[\s)'">\]])/gm,
    extract: (m) => ({ filePath: m[1], line: Number(m[2]) }),
  },
];

export function parseStackFrames(errorOutput: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();
  const push = (filePath: string, line: number) => {
    const normalized = filePath.replace(/\\/g, '/').replace(/^file:\/\/\//, '');
    const key = `${normalized.toLowerCase()}:${line}`;
    if (!seen.has(key) && !normalized.includes('node_modules') && !normalized.startsWith('node:')) {
      seen.add(key);
      frames.push({ filePath: normalized, line });
    }
  };

  for (const entry of STACK_TRACE_PATTERNS) {
    const re = new RegExp(entry.pattern.source, entry.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(errorOutput)) !== null) {
      const extracted = entry.extract(m);
      if (extracted && extracted.filePath && !isNaN(extracted.line) && extracted.line > 0) {
        push(extracted.filePath, extracted.line);
      }
    }
  }
  return frames;
}

function parseFailedTests(errorOutput: string): string[] {
  const names = new Set<string>();
  for (const re of [/^\s*(?:not ok|✖|×|FAIL)\s+(?:\d+\s+-\s+)?(.+)$/gm, /^\s*FAILED\s+(\S+)/gm]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(errorOutput)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name.slice(0, 160));
    }
  }
  return [...names].slice(0, 10);
}

function summarizeError(errorOutput: string): { kind: IncidentAnalysis['failedStage']['kind']; summary: string } {
  const lines = errorOutput.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errLine =
    lines.find((l) => /^(\w*Error|AssertionError|SyntaxError|TypeError|ReferenceError|Error:)/.test(l) || /\b\w+Error\b:/.test(l)) ??
    lines.find((l) => /fail|error|expected/i.test(l)) ??
    lines[0] ??
    '오류 출력이 기록되지 않았습니다.';

  let kind: IncidentAnalysis['failedStage']['kind'] = 'UNKNOWN';
  if (/SyntaxError|Cannot find module|TS\d{4}|compilation|build failed|error\[E\d+\]/i.test(errorOutput)) kind = 'BUILD';
  else if (/AssertionError|not ok|FAIL|assert|expected/i.test(errorOutput)) kind = 'TEST';
  else if (/TypeError|ReferenceError|RangeError|Traceback|panic/i.test(errorOutput)) kind = 'RUNTIME';
  return { kind, summary: errLine.slice(0, 240) };
}

function samePath(changed: string, frame: string): boolean {
  const a = changed.replace(/\\/g, '/').toLowerCase();
  const b = frame.replace(/\\/g, '/').toLowerCase();
  return b === a || b.endsWith('/' + a);
}

/**
 * 3-Track Causal Analyzer providing:
 * Track 1: DIFF_CHANGED (Git Diff modifications)
 * Track 2: OBSERVED_FAILURE (Stack traces, failed assertions)
 * Track 3: STATIC_INFERRED (Static import/require dependency tree crawling)
 * - Evidence strength: HIGH | MEDIUM | LOW | UNKNOWN
 * - Strict separation of OBSERVED (solid) vs INFERRED (dashed)
 */
export function analyzeIncident(
  errorOutput: string,
  diffSummary: string,
  repoRoot?: string,
  projectName: string = 'project',
  headSha: string = 'HEAD',
  incident?: Partial<Incident>
): IncidentAnalysis {
  const changedFiles = parseUnifiedDiff(diffSummary);
  const stackFrames = parseStackFrames(errorOutput);
  const failedTests = parseFailedTests(errorOutput);
  const failedStage = summarizeError(errorOutput);

  // Track 1 & 2: Candidates from changed files
  const candidates: CauseCandidate[] = changedFiles.map((file) => {
    const supportingEvidence: string[] = [];
    const counterEvidence: string[] = [];
    let score = 0;

    const frames = stackFrames.filter((f) => samePath(file.filePath, f.filePath));
    const exactFrame = frames.find((f) => file.ranges.some((r) => f.line >= r.start - 1 && f.line <= r.end + 1));

    if (exactFrame) {
      score += 85;
      supportingEvidence.push(
        `[스택] ${path.basename(exactFrame.filePath)}:${exactFrame.line} (변경된 코드 줄 범위와 직접 일치)`
      );
      counterEvidence.push('에러 발생 줄은 일치하나 상위 호출부(Caller)의 인자 전달 부작용 가능성 있음');
    } else if (frames.length > 0) {
      score += 45;
      supportingEvidence.push(
        `[스택] ${path.basename(file.filePath)}:${frames[0].line} (오류 스택트레이스에 포함됨)`
      );
      counterEvidence.push('스택트레이스에는 등장하나 이번에 직접 수정된 줄 범위와는 겹치지 않음');
    } else {
      counterEvidence.push('오류 스택트레이스에 해당 파일이 직접 등장하지 않음');
    }

    const totalDiff = file.addedLines + file.removedLines;
    if (totalDiff > 0) {
      supportingEvidence.push(`[변경] 최근 체크포인트 이후 ${totalDiff}줄 수정됨 (+${file.addedLines}/-${file.removedLines})`);
    }

    if (incident?.reproductionResult) {
      const repro = incident.reproductionResult;
      const verdictSuffix = repro.baselineComparison
        ? ` [비교: ${repro.baselineComparison.verdict}]`
        : '';
      if (repro.status === 'REPRODUCED') {
        if (repro.failedLocation && samePath(file.filePath, repro.failedLocation.filePath)) {
          score += 90;
          supportingEvidence.push(
            `[재현] 에이전트가 만든 재현 테스트가 이 줄(${repro.failedLocation.line}행)에서 실패함${verdictSuffix} (${repro.command})`
          );
        } else {
          score += 35;
          supportingEvidence.push(
            `[재현] 에이전트가 만든 재현 테스트 실행으로 실패 재현됨${verdictSuffix} (${repro.command})`
          );
        }
      } else if (repro.status === 'NOT_REPRODUCED') {
        counterEvidence.push(`[재현] 에이전트가 작성한 재현 테스트에서 실패가 재현되지 않음${verdictSuffix} (${repro.command})`);
      } else if (repro.status === 'WRONG_FAILURE') {
        const reason = repro.failureReason ? `: ${repro.failureReason}` : '';
        counterEvidence.push(`[재현] 재현 테스트가 단언 실패가 아닌 다른 이유로 실패함${reason}${verdictSuffix} (${repro.command})`);
      } else if (repro.status === 'UNVERIFIED_FAILURE') {
        counterEvidence.push(`[재현] 지원하지 않는 실행기로 실패 이유를 검증하지 못함${verdictSuffix} (${repro.command})`);
      } else {
        counterEvidence.push(`[재현] 재현 테스트 실행 불가${verdictSuffix} (${repro.command})`);
      }
    }

    if (incident?.coverageLines) {
      const covered = incident.coverageLines[file.filePath];
      if (covered && covered.length > 0) {
        score += 50;
        supportingEvidence.push(`[커버리지] 실패 테스트가 실행함 (${covered.length}줄 실행 확인)`);
      } else if (incident.enableCoverage) {
        score = Math.max(10, score - 30);
        counterEvidence.push('[커버리지] 실패 테스트가 이 파일을 한 번도 실행하지 않음 (순위 하향)');
      }
    }

    const hitSymbols = file.symbols.filter((s) => new RegExp(`\\b${escapeRegExp(s)}\\b`).test(errorOutput));
    if (hitSymbols.length > 0) {
      score += 25;
      supportingEvidence.push(`[심볼] 오류 출력에 변경된 심볼(${hitSymbols.slice(0, 3).join(', ')})이 직접 언급됨`);
    }

    const base = path.basename(file.filePath, path.extname(file.filePath));
    if (frames.length === 0 && base.length > 2 && new RegExp(`\\b${escapeRegExp(base)}\\b`).test(errorOutput)) {
      score += 15;
      supportingEvidence.push(`[모듈] 오류 로그에서 모듈 이름 "${base}" 이(가) 언급됨`);
    }

    if (repoRoot && frames.length === 0) {
      for (const f of stackFrames) {
        const abs = path.isAbsolute(f.filePath) ? f.filePath : path.join(repoRoot, f.filePath);
        try {
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            const src = fs.readFileSync(abs, 'utf8');
            const importRe = new RegExp(`(?:require|import)[^\\n]*['"][^'"]*${escapeRegExp(base)}(?:\\.[a-z]+)?['"]`);
            if (importRe.test(src)) {
              score += 25;
              supportingEvidence.push(`[참조] 실패 지점 모듈(${path.basename(f.filePath)})이 이 파일(${base})을 직접 참조함`);
              break;
            }
          }
        } catch {
          // Ignored
        }
      }
    }

    const temporalOnly = supportingEvidence.length === 0;
    if (temporalOnly) {
      score = 15;
      counterEvidence.push('직접 연관된 증거가 없으며, 단순 시간상 선행 수정 이력만 확인됨');
    } else {
      counterEvidence.push('반대 증거: 다른 독립 모듈과의 부수 효과 검증 필요');
    }

    const matchPercentage = Math.min(95, Math.max(15, score));
    const evidenceStrength: EvidenceStrength =
      matchPercentage >= 80 ? 'HIGH' : matchPercentage >= 45 ? 'MEDIUM' : temporalOnly ? 'UNKNOWN' : 'LOW';

    return {
      filePath: file.filePath,
      evidenceStrength,
      confidence: evidenceStrength,
      matchPercentage,
      score,
      reasons: [...supportingEvidence, ...counterEvidence],
      supportingEvidence,
      counterEvidence,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
      ranges: file.ranges,
      temporalOnly,
    };
  });

  // Track 3: STATIC_INFERRED - Crawl static dependency tree even on Clean Git repository
  let discoveredModules: DiscoveredModule[] = [];
  const startFiles: string[] = [];

  if (repoRoot) {
    for (const frame of stackFrames) {
      const rel = path.isAbsolute(frame.filePath) ? path.relative(repoRoot, frame.filePath).replace(/\\/g, '/') : frame.filePath;
      if (!startFiles.includes(rel)) startFiles.push(rel);
    }
    for (const cf of changedFiles) {
      if (!startFiles.includes(cf.filePath)) startFiles.push(cf.filePath);
    }

    if (startFiles.length === 0) {
      // Discover test files in repoRoot
      const commonTests = ['test.js', 'test/test.js', 'test/game-hunter.test.js'];
      for (const t of commonTests) {
        if (fs.existsSync(path.join(repoRoot, t))) {
          startFiles.push(t);
          break;
        }
      }
      if (startFiles.length === 0) {
        try {
          const testDir = path.join(repoRoot, 'test');
          if (fs.existsSync(testDir) && fs.statSync(testDir).isDirectory()) {
            const files = fs.readdirSync(testDir);
            for (const f of files) {
              if (f.endsWith('.js') || f.endsWith('.ts')) {
                startFiles.push(path.join('test', f).replace(/\\/g, '/'));
              }
            }
          }
        } catch {}
      }
    }

    if (startFiles.length > 0) {
      discoveredModules = crawlStaticDependencies(repoRoot, startFiles, 2);

      for (const mod of discoveredModules) {
        const existing = candidates.find((c) => samePath(c.filePath, mod.filePath));
        if (existing) {
          existing.reasons.push(`정적 의존성 체인: ${mod.chain.join(' ➔ ')}`);
          existing.supportingEvidence.push(`실패 지점 모듈과 정적 의존성으로 연결됨 (${mod.chain.join(' ➔ ')})`);
          continue;
        }

        const hitSymbols = mod.symbols.filter((s) => new RegExp(`\\b${escapeRegExp(s)}\\b`).test(errorOutput));
        let staticScore = 40 - mod.depth * 5;
        const supportingEvidence: string[] = [
          `실패한 테스트(${path.basename(startFiles[0])})로부터 정적 모듈 의존성 체인을 통해 연결됨 (${mod.chain.join(' ➔ ')})`,
        ];
        const counterEvidence: string[] = [
          '런타임 스택트레이스에 직접 잡히지 않은 정적 코드 추론(INFERRED) 상태임',
        ];

        if (hitSymbols.length > 0) {
          staticScore += Math.min(30, hitSymbols.length * 10);
          supportingEvidence.push(`오류 로그/단정문에 모듈 내 심볼(${hitSymbols.slice(0, 3).join(', ')})이 언급됨`);
        }

        const base = path.basename(mod.filePath, path.extname(mod.filePath));
        if (new RegExp(`\\b${escapeRegExp(base)}\\b`, 'i').test(errorOutput)) {
          staticScore += 15;
          supportingEvidence.push(`오류 로그에 모듈명 "${base}" 이(가) 언급됨`);
        }

        const matchPercentage = Math.min(75, Math.max(30, staticScore));
        const evidenceStrength: EvidenceStrength = matchPercentage >= 60 ? 'MEDIUM' : 'LOW';

        candidates.push({
          filePath: mod.filePath,
          evidenceStrength,
          confidence: evidenceStrength,
          matchPercentage,
          score: staticScore,
          reasons: [...supportingEvidence, ...counterEvidence],
          supportingEvidence,
          counterEvidence,
          causeVerdict: 'LIKELY',
          addedLines: 0,
          removedLines: 0,
          ranges: [],
          temporalOnly: false,
        });
      }
    }
  }

  candidates.sort((a, b) => b.matchPercentage - a.matchPercentage);

  // 3-Level Verification Health
  let codeHealth: HealthLevelStatus = 'PASS';
  let functionalHealth: HealthLevelStatus = 'FAIL';
  let reqHealth: HealthLevelStatus = 'FAIL';

  if (failedStage.kind === 'BUILD' || /SyntaxError|ReferenceError|TypeError|Error:/i.test(errorOutput)) {
    codeHealth = 'FAIL';
  } else {
    codeHealth = 'PASS';
  }

  if (incident?.threeLevelHealth) {
    codeHealth = incident.threeLevelHealth.code;
    functionalHealth = incident.threeLevelHealth.functional;
    reqHealth = incident.threeLevelHealth.requirement;
  }

  const topCandidate = candidates[0];
  let causeVerdict: CauseVerdict = incident?.causeVerdict || 'UNKNOWN';
  const missingEvidenceChecklist: string[] = [];

  // 3단계 원인 확신도 판정:
  // CONFIRMED는 오직 '실행 증거'가 있을 때만 부여한다:
  //  1) 재현 테스트가 실패를 재현(REPRODUCED)했고, 실패 위치가 후보 파일/줄과 일치하거나,
  //  2) 커버리지에서 실패 테스트가 해당 줄을 실행한 경우.
  // 정적 점수(evidenceStrength HIGH)만 높으면 최대 LIKELY로 제한된다.
  const hasReproExecutionEvidence = Boolean(
    incident?.reproductionResult?.status === 'REPRODUCED' &&
    topCandidate &&
    incident.reproductionResult.failedLocation &&
    samePath(topCandidate.filePath, incident.reproductionResult.failedLocation.filePath)
  );

  const hasCoverageExecutionEvidence = Boolean(
    incident?.coverageLines &&
    topCandidate &&
    incident.coverageLines[topCandidate.filePath] &&
    incident.coverageLines[topCandidate.filePath].length > 0 &&
    (
      topCandidate.ranges.length === 0 ||
      topCandidate.ranges.some((r) =>
        incident.coverageLines![topCandidate.filePath].some((l) => l >= r.start && l <= r.end)
      )
    )
  );

  const hasExecutionEvidence = hasReproExecutionEvidence || hasCoverageExecutionEvidence;

  if (hasExecutionEvidence && topCandidate && topCandidate.evidenceStrength !== 'LOW' && topCandidate.evidenceStrength !== 'UNKNOWN') {
    causeVerdict = 'CONFIRMED';
    topCandidate.causeVerdict = 'CONFIRMED';
    topCandidate.hasExecutionEvidence = true;
  } else if (topCandidate && topCandidate.supportingEvidence.length > 0) {
    causeVerdict = 'LIKELY';
    topCandidate.causeVerdict = 'LIKELY';
    topCandidate.hasExecutionEvidence = false;
    if (topCandidate.evidenceStrength === 'HIGH' && !hasExecutionEvidence) {
      missingEvidenceChecklist.push(
        '정적 점수(스택/변경)는 높으나 재현 테스트 또는 커버리지 실행 증거가 없어 LIKELY로 제한되었습니다. run_reproduction 도구로 재현 테스트를 실행하세요.'
      );
    }
  } else {
    causeVerdict = 'UNKNOWN';
    if (topCandidate) {
      topCandidate.causeVerdict = 'UNKNOWN';
      topCandidate.hasExecutionEvidence = false;
    }
    missingEvidenceChecklist.push('스택트레이스 또는 로그에 직접 변경된 코드 줄 번호 증거가 없음');
    missingEvidenceChecklist.push('격리 환경에서의 재현 실행(입출력 값 대조 프로브) 증거 수집 필요');
    missingEvidenceChecklist.push('추측성 코드 수정을 중단하고 추가 로그나 테스트를 먼저 보강하세요');
  }

  const verificationType: VerificationType = incident?.verificationType || (
    /component|render|dom|click|button|view/i.test(incident?.expectedBehavior || '') ? 'UI_FLOW' :
    /database|sql|table|storage|cache|api|response/i.test(incident?.expectedBehavior || '') ? 'DATA_STATE' :
    /game|unity|player|monster|hunt|target/i.test(incident?.expectedBehavior || '') ? 'MANUAL_CHECK' :
    'LOGIC_TEST'
  );

  const threeLevelHealth: ThreeLevelHealth = incident?.threeLevelHealth || {
    code: codeHealth,
    functional: functionalHealth,
    requirement: reqHealth,
    details: {
      codeSummary: codeHealth === 'PASS' ? '빌드 및 타입 검사 정상 (문법 에러 없음)' : failedStage.summary,
      functionalSummary: functionalHealth === 'PASS' ? '함수 실행 및 상태 변경 정상' : '사용자 입력 대비 기대 동작 미수행',
      requirementSummary: reqHealth === 'PASS' ? '사용자 의도 달성 완료' : '사용자가 요구한 최종 결과 미충족',
    },
  };

  // Build Dual Flow Graph Data (Behavior Flow & File Structure Flow)
  const flowData = buildDualFlowData(
    projectName,
    headSha,
    changedFiles,
    candidates,
    failedTests,
    failedStage,
    incident,
    threeLevelHealth,
    startFiles,
    stackFrames,
    discoveredModules,
    repoRoot
  );

  return { failedStage, stackFrames, failedTests, changedFiles, candidates, flowData, threeLevelHealth, causeVerdict, missingEvidenceChecklist, verificationType };
}

function buildDualFlowData(
  projectName: string,
  headSha: string,
  changedFiles: DiffFileInfo[],
  candidates: CauseCandidate[],
  failedTests: string[],
  failedStage: IncidentAnalysis['failedStage'],
  incident?: Partial<Incident>,
  threeLevelHealth?: ThreeLevelHealth,
  startFiles: string[] = [],
  stackFrames: StackFrame[] = [],
  discoveredModules: DiscoveredModule[] = [],
  repoRoot?: string
): IncidentFlowData {
  // 1. Behavior Flow (Default)
  const behavior = buildBehaviorFlow(projectName, changedFiles, candidates, failedStage, incident, threeLevelHealth, startFiles);

  // 2. File Structure Flow
  const fileFlow = buildFileStructureFlow(
    projectName,
    headSha,
    changedFiles,
    candidates,
    failedTests,
    failedStage,
    stackFrames,
    discoveredModules,
    repoRoot
  );

  return {
    nodes: behavior.nodes,
    edges: behavior.edges,
    behaviorNodes: behavior.nodes,
    behaviorEdges: behavior.edges,
    fileNodes: fileFlow.nodes,
    fileEdges: fileFlow.edges,
  };
}

function buildBehaviorFlow(
  projectName: string,
  changedFiles: DiffFileInfo[],
  candidates: CauseCandidate[],
  failedStage: IncidentAnalysis['failedStage'],
  incident?: Partial<Incident>,
  threeLevelHealth?: ThreeLevelHealth,
  startFiles: string[] = []
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  const expectedText = incident?.expectedBehavior || '사용자가 의도한 기능 (기대 동작)';
  const observedText = incident?.observedBehavior || failedStage.summary || '코드/빌드는 정상이나 실제 동작 미반영';
  const brokenStepText = incident?.brokenStep || '데이터/상태 갱신 끊김 지점';

  // 1. Requirement Node
  const reqId = 'node_req_0';
  nodes.push({
    id: reqId,
    type: 'requirement',
    label: '사용자 기대 요구사항',
    sublabel: expectedText.length > 36 ? expectedText.slice(0, 36) + '...' : expectedText,
    status: 'neutral',
    x: 60,
    y: 220,
    expectedValue: expectedText,
    observedValue: observedText,
    isObserved: true,
    threeLevelStatus: threeLevelHealth,
  });

  // 2. Call Steps (Execution Path Chain)
  let prevId = reqId;
  let startX = 420;

  let traceSteps = incident?.executionTrace && incident.executionTrace.length > 0 ? incident.executionTrace : null;

  if (!traceSteps) {
    if (changedFiles.length > 0) {
      traceSteps = changedFiles.slice(0, 2).map((cf, idx) => ({
        id: `trace_${idx}`,
        stepNumber: idx + 1,
        name: idx === 0 ? `${path.basename(cf.filePath)} ➔ 호출 실행` : `${path.basename(cf.filePath)} ➔ 상태 갱신`,
        codeLocation: `${cf.filePath}:${cf.ranges[0]?.start || 1}`,
        expected: '정상 인자 전달 및 반환값 처리',
        observed: idx === 0 ? '정상 인자 수신됨' : '반환값 누락 또는 부작용 발생',
        status: idx === 0 ? ('PASS' as const) : ('FAIL' as const),
        isObserved: idx === 0,
      }));
    } else if (candidates.length > 0) {
      const testFile = startFiles[0] || 'test.js';
      const topCand = candidates[0];
      traceSteps = [
        {
          id: 'trace_0',
          stepNumber: 1,
          name: `${path.basename(testFile)} ➔ 테스트 단정문 실행`,
          codeLocation: `${testFile}:1`,
          expected: expectedText,
          observed: '런타임 실행 및 단정문 진입',
          status: 'PASS' as const,
          isObserved: true,
        },
        {
          id: 'trace_1',
          stepNumber: 2,
          name: `${path.basename(topCand.filePath)} ➔ 비즈니스 로직 처리`,
          codeLocation: `${topCand.filePath}:1`,
          expected: '기대 상태 갱신 및 값 반환',
          observed: observedText,
          status: 'FAIL' as const,
          isObserved: false, // Inferred dependency (dashed)
        },
      ];
    } else {
      traceSteps = [];
    }
  }

  traceSteps.forEach((step, idx) => {
    const stepId = `node_call_step_${idx}`;
    nodes.push({
      id: stepId,
      type: 'call_step',
      label: step.name,
      sublabel: step.codeLocation || '호출 체인',
      path: step.codeLocation,
      status: step.status === 'PASS' ? 'modified' : 'broken',
      x: startX,
      y: 150 + idx * 100,
      isObserved: step.isObserved,
      expectedValue: step.expected,
      observedValue: step.observed,
      threeLevelStatus: {
        code: 'PASS',
        functional: step.status,
        requirement: step.status === 'PASS' ? 'UNKNOWN' : 'FAIL',
      },
    });

    edges.push({
      id: `edge_${prevId}_${stepId}`,
      source: prevId,
      target: stepId,
      style: step.isObserved ? 'solid' : 'dashed',
      color: step.status === 'FAIL' ? 'red' : step.isObserved ? 'blue' : 'orange',
      label: step.isObserved ? '관찰됨 (OBSERVED)' : '정적 추론 (INFERRED)',
      isObserved: step.isObserved,
      expected: step.expected,
      observed: step.observed,
    });
    prevId = stepId;
    startX += 360;
  });

  // 3. Broken Point Node
  const brokenId = 'node_broken_point';
  nodes.push({
    id: brokenId,
    type: 'broken_point',
    label: '기능 끊김 / 불일치 지점',
    sublabel: brokenStepText.length > 36 ? brokenStepText.slice(0, 36) + '...' : brokenStepText,
    status: 'broken',
    x: Math.max(startX, 800),
    y: 220,
    expectedValue: expectedText,
    observedValue: observedText,
    isObserved: true,
    threeLevelStatus: {
      code: 'PASS',
      functional: 'FAIL',
      requirement: 'FAIL',
      details: {
        codeSummary: '빌드/타입 에러 없음 (코드 정상)',
        functionalSummary: '동작 도중 기대한 상태 갱신이 누락됨 (기능 비정상)',
        requirementSummary: '사용자의 최종 의도 달성 실패',
      },
    },
  });

  edges.push({
    id: `edge_${prevId}_${brokenId}`,
    source: prevId,
    target: brokenId,
    style: 'solid',
    color: 'red',
    label: '불일치 발생',
    isObserved: true,
  });

  // 4. Cause Candidate Node
  const topCandidate = candidates[0];
  const causeId = 'node_cause_candidate';
  nodes.push({
    id: causeId,
    type: 'cause_candidate',
    label: topCandidate ? `${path.basename(topCandidate.filePath)} 수정 영향` : '원인 후보 분석 중',
    sublabel: topCandidate ? `일치도 ${topCandidate.matchPercentage}% · ${topCandidate.evidenceStrength}` : '분석 중',
    path: topCandidate?.filePath,
    status: 'candidate',
    x: Math.max(startX + 360, 1180),
    y: 220,
    expectedValue: '버그 없는 구현',
    observedValue: topCandidate ? topCandidate.reasons.join('\n') : '원인 분석 중',
    isObserved: topCandidate?.evidenceStrength === 'HIGH',
  });

  edges.push({
    id: `edge_${brokenId}_${causeId}`,
    source: brokenId,
    target: causeId,
    style: 'dashed',
    color: 'orange',
    label: '원인 추정',
    isObserved: false,
  });

  // 5. Verification Node
  const verifyId = 'node_verification';
  nodes.push({
    id: verifyId,
    type: 'verification',
    label: '격리 검증 및 복구',
    sublabel: 'Worktree 검증 후 승인 대기',
    status: 'neutral',
    x: Math.max(startX + 720, 1560),
    y: 220,
    threeLevelStatus: {
      code: 'PASS',
      functional: 'UNKNOWN',
      requirement: 'UNKNOWN',
    },
  });

  edges.push({
    id: `edge_${causeId}_${verifyId}`,
    source: causeId,
    target: verifyId,
    style: 'solid',
    color: 'gray',
    label: '검증 대기',
    isObserved: false,
  });

  return { nodes, edges };
}

function buildFileStructureFlow(
  projectName: string,
  headSha: string,
  changedFiles: DiffFileInfo[],
  candidates: CauseCandidate[],
  failedTests: string[],
  failedStage: IncidentAnalysis['failedStage'],
  stackFrames: StackFrame[] = [],
  discoveredModules: DiscoveredModule[] = [],
  repoRoot?: string
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // 1. Root Node (left column: x=60, y=220)
  const rootId = 'node_root';
  nodes.push({
    id: rootId,
    type: 'root',
    label: projectName,
    sublabel: '프로젝트 루트',
    path: headSha.slice(0, 7),
    status: 'neutral',
    x: 60,
    y: 220,
  });

  const normalizeRel = (p: string) => {
    let normalized = p.replace(/\\/g, '/');
    if (repoRoot) {
      const normRoot = repoRoot.replace(/\\/g, '/');
      if (normalized.toLowerCase().startsWith(normRoot.toLowerCase())) {
        normalized = normalized.slice(normRoot.length).replace(/^\/+/, '');
      }
    }
    return normalized;
  };

  // Collect all unique file paths across changed files, candidates, stack frames, and discovered modules
  const filePaths = new Set<string>();
  for (const cf of changedFiles) filePaths.add(normalizeRel(cf.filePath));
  for (const c of candidates) filePaths.add(normalizeRel(c.filePath));
  for (const f of stackFrames) filePaths.add(normalizeRel(f.filePath));
  for (const m of discoveredModules) filePaths.add(normalizeRel(m.filePath));

  // Group files by directory
  const topDirs = new Map<string, string[]>();
  for (const fp of filePaths) {
    const parts = fp.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : 'root/';
    if (!topDirs.has(dir)) topDirs.set(dir, []);
    topDirs.get(dir)!.push(fp);
  }

  if (topDirs.size === 0) {
    topDirs.set('tests/', ['test.js']);
  }

  const dirList = Array.from(topDirs.keys());
  let currentY = 80;
  const fileNodeMap = new Map<string, string>(); // relPath -> nodeId

  // 2. Directory & File Nodes
  dirList.forEach((dir, dirIdx) => {
    const dirId = `node_dir_${dirIdx}`;
    const files = topDirs.get(dir) || [];
    const isTestDir = dir.includes('test');

    nodes.push({
      id: dirId,
      type: 'dir',
      label: dir,
      sublabel: isTestDir ? '테스트 디렉토리' : '소스 디렉토리',
      status: isTestDir && failedTests.length > 0 ? 'failure' : 'neutral',
      x: 280,
      y: currentY,
    });

    edges.push({
      id: `edge_root_${dirId}`,
      source: rootId,
      target: dirId,
      style: 'solid',
      color: isTestDir ? 'red' : 'blue',
      isObserved: true,
    });

    let fileY = currentY - 20;
    files.forEach((fp, fIdx) => {
      const fileId = `node_file_${dirIdx}_${fIdx}`;
      fileNodeMap.set(fp.toLowerCase(), fileId);
      const isTestFile = fp.includes('test') || fp.endsWith('.test.js') || fp.endsWith('.spec.js');
      const isCandidate = candidates.some((c) => samePath(c.filePath, fp) && c.evidenceStrength !== 'UNKNOWN');
      const isModified = changedFiles.some((cf) => samePath(cf.filePath, fp));
      const isFailedTest = isTestFile && (failedTests.length > 0 || stackFrames.some((sf) => samePath(sf.filePath, fp)));

      const cf = changedFiles.find((c) => samePath(c.filePath, fp));
      const cand = candidates.find((c) => samePath(c.filePath, fp));

      let status: FlowNode['status'] = 'related';
      if (isFailedTest) status = 'failure';
      else if (isModified) status = 'modified';
      else if (isCandidate) status = 'candidate';

      nodes.push({
        id: fileId,
        type: isTestFile ? 'test_file' : 'file',
        label: path.basename(fp),
        sublabel: isCandidate ? `원인 후보 (${cand?.matchPercentage}%)` : isFailedTest ? '실패한 테스트' : isModified ? '수정된 파일' : '참조 모듈',
        path: fp,
        status,
        diffBadge: cf ? { added: cf.addedLines, removed: cf.removedLines } : undefined,
        x: 520,
        y: fileY,
      });

      edges.push({
        id: `edge_${dirId}_${fileId}`,
        source: dirId,
        target: fileId,
        style: 'solid',
        color: status === 'failure' ? 'red' : isCandidate ? 'orange' : isModified ? 'blue' : 'gray',
        isObserved: true,
      });

      fileY += 75;
    });

    currentY += Math.max(140, files.length * 75 + 50);
  });

  // 3. Connect cross-file dependency edges (Discovered Modules)
  discoveredModules.forEach((mod, idx) => {
    const srcNodeId = fileNodeMap.get(mod.importedBy.toLowerCase());
    const tgtNodeId = fileNodeMap.get(mod.filePath.toLowerCase());
    if (srcNodeId && tgtNodeId && srcNodeId !== tgtNodeId) {
      const inStack = stackFrames.some((sf) => samePath(sf.filePath, mod.filePath));
      edges.push({
        id: `edge_dep_${idx}`,
        source: srcNodeId,
        target: tgtNodeId,
        style: inStack ? 'solid' : 'dashed',
        color: inStack ? 'red' : 'orange',
        label: inStack ? '실제 호출 (OBSERVED)' : '정적 의존성 (INFERRED)',
        isObserved: inStack,
      });
    }
  });

  // 4. Test Failure Node & Cause Candidate Node
  const failureId = 'node_test_failure';
  nodes.push({
    id: failureId,
    type: 'test_failure',
    label: '테스트 실행 실패',
    sublabel: failedStage.summary.slice(0, 48),
    status: 'failure',
    x: 820,
    y: 140,
    isObserved: true,
  });

  const topCandidate = candidates[0];
  const candidateId = 'node_cause_candidate';
  nodes.push({
    id: candidateId,
    type: 'cause_candidate',
    label: topCandidate ? `${path.basename(topCandidate.filePath)}` : '원인 후보 분석 중',
    sublabel: topCandidate ? `일치도 ${topCandidate.matchPercentage}% · ${topCandidate.evidenceStrength}` : '증거 분석 중',
    status: 'candidate',
    x: 820,
    y: 300,
    isObserved: topCandidate?.evidenceStrength === 'HIGH',
  });

  // Connect test nodes to failure node
  const failedFileNodes = nodes.filter((n) => n.type === 'test_file');
  if (failedFileNodes.length > 0) {
    for (const tNode of failedFileNodes) {
      edges.push({
        id: `edge_${tNode.id}_failure`,
        source: tNode.id,
        target: failureId,
        style: 'solid',
        color: 'red',
        label: '실패 지점 (OBSERVED)',
        isObserved: true,
      });
    }
  }

  // Connect candidate file nodes to cause candidate node
  if (topCandidate) {
    const topNodeId = fileNodeMap.get(topCandidate.filePath.toLowerCase());
    if (topNodeId) {
      const isDirectDiff = changedFiles.some((cf) => samePath(cf.filePath, topCandidate.filePath));
      edges.push({
        id: `edge_${topNodeId}_candidate`,
        source: topNodeId,
        target: candidateId,
        style: isDirectDiff ? 'solid' : 'dashed',
        color: 'orange',
        label: isDirectDiff ? '코드 수정 (OBSERVED)' : '원인 추정 (INFERRED)',
        isObserved: isDirectDiff,
      });
    }
  }

  return { nodes, edges };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
