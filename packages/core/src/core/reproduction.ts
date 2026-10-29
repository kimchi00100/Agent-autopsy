import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CoreContext } from './context.js';
import {
  ReproductionResult,
  ReproductionStatus,
  ReproductionFailureKind,
  BaselineComparisonVerdict,
  ReproductionRunRecord,
  BaselineComparison,
  Incident,
  AssertFlipVerdict,
  AssertFlipResult,
  AssertFlipNonAssertionLine,
  RunReproductionOptions,
  ReproductionLock,
  ReproductionLockHistoryEntry,
  ReproductionLockStatus,
  NextAction,
  MAX_REPRODUCTION_ATTEMPTS,
  ADDITIONAL_ATTEMPTS_PER_GRANT,
  ReproductionGateState,
  ReproductionGateAttempt,
  ReproductionGateInfo,
  AuditHeadAnchor,
} from '../types.js';
import { parseStackFrames, analyzeIncident } from '../analysis/analyzer.js';
import {
  verifyTestCommandSignature,
  getInstallationSecretKey,
  computeNormalizedContentHash,
  computeReproductionLockSignature,
  verifyReproductionLockSignature,
  computeAuditEntryHash,
  verifyAuditHeadSignature,
  hashAuditPayload,
} from '../utils/security.js';
import { locateChangeScope } from '../localization/change-localizer.js';
import { SnapshotResult } from '../git/git-engine.js';
import { isSamePathUnderRepo } from '../utils/paths.js';
import type Parser from 'web-tree-sitter';
import { parseWithTreeSitterForRunner } from '../localization/function-extractor.js';

type SupportedRunnerType = 'pytest' | 'unittest' | 'node:test' | 'unsupported';

interface ExecutionRunsResult {
  runs: ReproductionRunRecord[];
  lastEval: EvaluationOutput;
  lastTestResult: { exitCode: number; output: string };
  durationNote?: string;
}

// 간단한 줄 패턴 검사
function isAssertionLine(rawLine: string, runnerType: SupportedRunnerType): boolean {
  const line = rawLine.trim();
  if (!line) return false;

  if (runnerType === 'pytest' || runnerType === 'unittest') {
    // pytest/unittest: assert 문, self.assert*( 호출, pytest.approx를 포함한 assert
    if (line.startsWith('assert ') || line.startsWith('assert(') || line === 'assert') {
      return true;
    }
    if (/^self\.assert\w*\s*\(/.test(line)) {
      return true;
    }
    return false;
  }

  if (runnerType === 'node:test') {
    // node:test: assert.*( 호출, assert( 호출, expect( 호출
    const unwrapped = line.startsWith('await ') ? line.slice(6).trim() : line;
    if (/^assert\.\w+\s*\(/.test(unwrapped)) {
      return true;
    }
    if (/^assert\s*\(/.test(unwrapped)) {
      return true;
    }
    if (/^expect\s*\(/.test(unwrapped)) {
      return true;
    }
    return false;
  }

  return false;
}

// 간단한 줄 패턴 검사
function isPathOutsideRepo(repoPath: string, targetFilePath: string): boolean {
  const rel = path.relative(path.resolve(repoPath), path.resolve(targetFilePath));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function isConstantTrueAssertion(rawLine: string): boolean {
  const line = rawLine.trim();
  if (/^assert\s+(?:True|1|['"][^'"]+['"])(?:\s*,.*)?$/.test(line)) return true;
  if (/^assert\s*\(\s*(?:True|1|true|['"][^'"]+['"])\s*(?:,.*)?\)$/.test(line)) return true;
  if (/^assert\s+(?:True\s*==\s*True|1\s*==\s*1|0\s*==\s*0)(?:\s*,.*)?$/.test(line)) return true;

  if (/^self\.assertTrue\s*\(\s*(?:True|1)\s*(?:,.*)?\)$/.test(line)) return true;
  if (/^self\.assertFalse\s*\(\s*(?:False|0)\s*(?:,.*)?\)$/.test(line)) return true;
  if (/^self\.assertEqual\s*\(\s*(?:(True|False|None|\d+|['"][^'"]*['"]))\s*,\s*\1\s*(?:,.*)?\)$/.test(line)) return true;

  const unwrapped = line.startsWith('await ') ? line.slice(6).trim() : line;
  if (/^assert(?:\.ok)?\s*\(\s*(?:true|1|['"][^'"]+['"])\s*(?:,.*)?\)$/.test(unwrapped)) return true;
  if (/^assert\.(?:strictEqual|equal|deepStrictEqual)\s*\(\s*(?:(true|false|null|undefined|\d+|['"][^'"]*['"]))\s*,\s*\1\s*(?:,.*)?\)$/.test(unwrapped)) return true;

  return false;
}

function isSetupOrAssignmentLine(rawLine: string): boolean {
  const line = rawLine.trim();
  // Python assignment: var = ..., var: type = ..., a, b = ...
  if (/^[a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*\s*(?::\s*[^=]+)?\s*=(?!=)/.test(line)) {
    return true;
  }
  // JS/TS assignment: const/let/var x = ..., x = ...
  if (/^(?:const|let|var)\s+[a-zA-Z_$]\w*/.test(line)) {
    return true;
  }
  if (/^[a-zA-Z_$]\w*\s*=(?!=)/.test(line)) {
    return true;
  }
  // Standalone call statement that is not an assertion
  const unwrapped = line.startsWith('await ') ? line.slice(6).trim() : line;
  if (/^[a-zA-Z_$][\w.]*\s*\(/.test(unwrapped)) {
    if (
      /^assert\b/.test(unwrapped) ||
      /^expect\b/.test(unwrapped) ||
      /^self\.assert\w*/.test(unwrapped)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function normalizeValueTokens(line: string): string {
  return line
    .replace(/(["'`])(?:(?=(\\?))\2[\s\S])*?\1/g, '<VAL>')
    .replace(/\b(?:True|False|None|true|false|null|undefined)\b/g, '<VAL>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<VAL>');
}

function isInvertedComparisonPair(preRaw: string, flippedRaw: string, runnerType: SupportedRunnerType): boolean {
  if (!isAssertionLine(preRaw, runnerType) || !isAssertionLine(flippedRaw, runnerType)) {
    return false;
  }
  const pre = preRaw.trim();
  const flipped = flippedRaw.trim();

  // ok(x) <-> ok(!x)
  const okPreToFlipped = pre.replace(/\(\s*!([^)]+)\)/, '($1)');
  const okFlippedToPre = flipped.replace(/\(\s*!([^)]+)\)/, '($1)');
  if (okPreToFlipped === flipped || okFlippedToPre === pre) {
    return true;
  }

  const tokenPairs: [RegExp, string, RegExp, string][] = [
    [/\bdeepStrictEqual\b/g, 'notDeepStrictEqual', /\bnotDeepStrictEqual\b/g, 'deepStrictEqual'],
    [/\bstrictEqual\b/g, 'notStrictEqual', /\bnotStrictEqual\b/g, 'strictEqual'],
    [/\bequal\b/g, 'notEqual', /\bnotEqual\b/g, 'equal'],
    [/\bassertEqual\b/g, 'assertNotEqual', /\bassertNotEqual\b/g, 'assertEqual'],
    [/\bassertIsNone\b/g, 'assertIsNotNone', /\bassertIsNotNone\b/g, 'assertIsNone'],
    [/\bassertIsNot\b/g, 'assertIs', /\bassertIs\b/g, 'assertIsNot'],
    [/\bassertNotIn\b/g, 'assertIn', /\bassertIn\b/g, 'assertNotIn'],
    [/\bassertTrue\b/g, 'assertFalse', /\bassertFalse\b/g, 'assertTrue'],
    [/===/g, '!==', /!==/g, '==='],
    [/(?<!=)==(?!=)/g, '!=', /(?<!=)!=(?!=)/g, '=='],
    [/\bis not\b/g, 'is', /\bis\b/g, 'is not'],
    [/\bnot in\b/g, 'in', /\bin\b/g, 'not in'],
  ];

  for (const [reA, strB, reB, strA] of tokenPairs) {
    if (pre.replace(reA, strB) === flipped) return true;
    if (pre.replace(reB, strA) === flipped) return true;
  }

  return false;
}

const PYTHON_STATEMENT_TYPES = new Set([
  'assert_statement',
  'expression_statement',
  'return_statement',
  'raise_statement',
  'pass_statement',
  'break_statement',
  'continue_statement',
  'import_statement',
  'import_from_statement',
  'for_statement',
  'while_statement',
  'if_statement',
  'with_statement',
  'try_statement',
  'function_definition',
  'class_definition',
]);

const JS_STATEMENT_TYPES = new Set([
  'expression_statement',
  'lexical_declaration',
  'variable_declaration',
  'return_statement',
  'throw_statement',
  'break_statement',
  'continue_statement',
  'import_statement',
  'export_statement',
  'if_statement',
  'for_statement',
  'for_in_statement',
  'for_of_statement',
  'while_statement',
  'do_statement',
  'try_statement',
  'switch_statement',
  'function_declaration',
  'class_declaration',
]);

function findEnclosingStatement(
  rootNode: Parser.SyntaxNode,
  line0Indexed: number,
  runnerType: SupportedRunnerType
): Parser.SyntaxNode | null {
  const statementTypes =
    runnerType === 'pytest' || runnerType === 'unittest'
      ? PYTHON_STATEMENT_TYPES
      : JS_STATEMENT_TYPES;

  let bestNode: Parser.SyntaxNode | null = null;

  function visit(node: Parser.SyntaxNode) {
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;

    if (line0Indexed < startRow || line0Indexed > endRow) {
      return;
    }

    if (statementTypes.has(node.type)) {
      bestNode = node;
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  }

  visit(rootNode);
  return bestNode;
}

function isNodeAssertion(
  node: Parser.SyntaxNode | null,
  lines: string[],
  runnerType: SupportedRunnerType
): boolean {
  if (!node) return false;
  if (node.type === 'assert_statement') return true;
  const firstLine = lines[node.startPosition.row] ?? '';
  return isAssertionLine(firstLine, runnerType);
}

// 간단한 줄 패턴 검사: 변경 덩어리(hunk) 안에서 1:1 짝을 맞춰 값 또는 비교 뒤집기 검사
async function diffAssertionLines(
  preFlipContent: string,
  flippedContent: string,
  runnerType: SupportedRunnerType
): Promise<{
  changedLineCount: number;
  nonAssertionChangedLines: AssertFlipNonAssertionLine[];
  note?: string;
}> {
  const lines1 = preFlipContent.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  const lines2 = flippedContent.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  if (lines1.length > 0 && lines1[lines1.length - 1] === '') lines1.pop();
  if (lines2.length > 0 && lines2[lines2.length - 1] === '') lines2.pop();

  const n = lines1.length;
  const m = lines2.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (lines1[i] === lines2[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  interface DiffOp {
    type: 'keep' | 'delete' | 'insert';
    line1?: number;
    line2?: number;
    content: string;
  }

  const ops: DiffOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && lines1[i - 1] === lines2[j - 1]) {
      ops.push({ type: 'keep', line1: i, line2: j, content: lines1[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', line2: j, content: lines2[j - 1] });
      j--;
    } else {
      ops.push({ type: 'delete', line1: i, content: lines1[i - 1] });
      i--;
    }
  }
  ops.reverse();

  interface Hunk {
    preLines: AssertFlipNonAssertionLine[];
    flippedLines: AssertFlipNonAssertionLine[];
  }

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const op of ops) {
    if (op.type === 'keep') {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
    } else if (op.type === 'delete') {
      if (!currentHunk) currentHunk = { preLines: [], flippedLines: [] };
      currentHunk.preLines.push({ line: op.line1!, content: op.content });
    } else if (op.type === 'insert') {
      if (!currentHunk) currentHunk = { preLines: [], flippedLines: [] };
      currentHunk.flippedLines.push({ line: op.line2!, content: op.content });
    }
  }
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  let totalChangedCount = 0;
  for (const hunk of hunks) {
    totalChangedCount += hunk.preLines.length + hunk.flippedLines.length;
  }

  // 1. Check if total pairs is 0
  if (totalChangedCount === 0 || hunks.length === 0) {
    return {
      changedLineCount: 0,
      nonAssertionChangedLines: [{ line: 0, content: '(내용 변경 없음)' }],
      note: '바뀐 줄이 0쌍임 (짝 개수 불일치)',
    };
  }

  // 2. Check if any hunk has mismatched line counts
  for (const hunk of hunks) {
    if (hunk.preLines.length !== hunk.flippedLines.length) {
      const failingLines = [...hunk.preLines, ...hunk.flippedLines];
      return {
        changedLineCount: totalChangedCount,
        nonAssertionChangedLines: failingLines,
        note: '바뀐 줄의 짝 개수 불일치 (한쪽에만 줄이 있음)',
      };
    }
  }

  // 3. For each pair within each hunk, check rules using tree-sitter statement boundaries
  let preTree: Parser.Tree | null = null;
  let flippedTree: Parser.Tree | null = null;
  let usedFallback = false;

  try {
    preTree = await parseWithTreeSitterForRunner(runnerType, preFlipContent);
    flippedTree = await parseWithTreeSitterForRunner(runnerType, flippedContent);
  } catch {
    preTree = null;
    flippedTree = null;
  }

  const nonAssertionChangedLines: AssertFlipNonAssertionLine[] = [];
  let note: string | undefined;

  for (const hunk of hunks) {
    for (let k = 0; k < hunk.preLines.length; k++) {
      const pre = hunk.preLines[k];
      const flipped = hunk.flippedLines[k];

      // Check constant true assertion on pre-flip side
      if (isConstantTrueAssertion(pre.content)) {
        nonAssertionChangedLines.push(pre);
        if (!note) {
          note = '뒤집기 전 테스트에 항상 참인 단언이 포함됨 (상수 단언)';
        }
        continue;
      }

      // Check inverted comparison (나)
      if (isInvertedComparisonPair(pre.content, flipped.content, runnerType)) {
        continue;
      }

      // 구문 분석기(tree-sitter)로 바뀐 줄을 감싸는 가장 작은 문장 노드를 찾아 단언인지 판정
      let isPreAssertion = false;
      let isFlippedAssertion = false;

      if (preTree && flippedTree) {
        const preStmt = findEnclosingStatement(preTree.rootNode, pre.line - 1, runnerType);
        const flippedStmt = findEnclosingStatement(flippedTree.rootNode, flipped.line - 1, runnerType);
        isPreAssertion = isNodeAssertion(preStmt, lines1, runnerType);
        isFlippedAssertion = isNodeAssertion(flippedStmt, lines2, runnerType);
      } else {
        // 구문 분석 실패/미지원 시 줄 첫머리 판정(isAssertionLine)으로 폴백
        usedFallback = true;
        isPreAssertion = isAssertionLine(pre.content, runnerType);
        isFlippedAssertion = isAssertionLine(flipped.content, runnerType);
      }

      // Check value-only difference (가)
      // Must belong to an assertion statement and (in fallback mode) must not be a setup/assignment statement line
      if (
        isPreAssertion &&
        isFlippedAssertion &&
        (!usedFallback || (!isSetupOrAssignmentLine(pre.content) && !isSetupOrAssignmentLine(flipped.content)))
      ) {
        const normPre = normalizeValueTokens(pre.content);
        const normFlipped = normalizeValueTokens(flipped.content);
        if (normPre === normFlipped) {
          continue;
        }
      }

      // Failed both (가) and (나)
      nonAssertionChangedLines.push(pre, flipped);
      if (!note) {
        note = '단언 줄에서 값·비교 말고 다른 부분이 바뀜';
      }
    }
  }

  if (usedFallback && !note) {
    note = '구문 분석(tree-sitter) 미지원 또는 구문 오류로 줄 첫머리 판정으로 대체됨';
  }

  return {
    changedLineCount: totalChangedCount,
    nonAssertionChangedLines,
    note,
  };
}

async function executeTestRuns(
  ctx: CoreContext,
  sandboxDir: string,
  hostFile: string,
  relTestPath: string,
  effectiveCommand: string,
  runnerType: SupportedRunnerType,
  timeoutMs: number,
  childEnv: NodeJS.ProcessEnv
): Promise<ExecutionRunsResult> {
  const runs: ReproductionRunRecord[] = [];
  let lastEval: EvaluationOutput = { status: 'CANNOT_RUN', testCount: 0 };
  let lastTestResult: { exitCode: number; output: string } = { exitCode: 1, output: '' };
  let durationNote: string | undefined;

  for (let i = 0; i < 3; i++) {
    let runCommand = effectiveCommand;
    let tempReportDir: string | undefined;
    let reportFilePath: string | undefined;

    if (runnerType === 'pytest' || runnerType === 'node:test') {
      tempReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-autopsy-repro-'));
      if (runnerType === 'pytest') {
        reportFilePath = path.join(tempReportDir, `report-${i}.xml`);
        const normalizedReport = reportFilePath.replace(/\\/g, '/');
        runCommand = `${effectiveCommand} --junitxml="${normalizedReport}"`;
      } else if (runnerType === 'node:test') {
        reportFilePath = path.join(tempReportDir, `report-${i}.tap`);
        const normalizedReport = reportFilePath.replace(/\\/g, '/');
        runCommand = `node --test --test-reporter=tap --test-reporter-destination="${normalizedReport}" --test-reporter=spec --test-reporter-destination=stdout "${relTestPath}"`;
      }
    }

    const start = Date.now();
    try {
      const testResult = await ctx.worktreeRunner.runTest(sandboxDir, runCommand, timeoutMs, childEnv);
      const durationMs = Date.now() - start;
      lastTestResult = testResult;

      let evalOutput: EvaluationOutput;
      if (runnerType === 'pytest') {
        evalOutput = evaluatePytestReproduction(reportFilePath, testResult);
      } else if (runnerType === 'unittest') {
        evalOutput = evaluateUnittestReproduction(testResult);
      } else if (runnerType === 'node:test') {
        const hostContent = fs.readFileSync(hostFile, 'utf8');
        evalOutput = evaluateNodeTestReproduction(reportFilePath, testResult, hostContent);
      } else {
        evalOutput = evaluateUnsupportedReproduction(effectiveCommand, testResult);
      }
      lastEval = evalOutput;

      runs.push({
        runIndex: i + 1,
        status: evalOutput.status,
        failureKind: evalOutput.failureKind,
        durationMs,
      });

      if (i === 0 && durationMs > 3000) {
        durationNote = `첫 실행 소요 시간(${durationMs}ms)이 3초를 초과하여 반복 실행을 생략하고 1회만 실행함 (runCount: 1)`;
        break;
      }
    } finally {
      if (tempReportDir) {
        try {
          fs.rmSync(tempReportDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  return { runs, lastEval, lastTestResult, durationNote };
}

export function getReproductionGateState(ctx: CoreContext, incidentId: string): ReproductionGateInfo {
  const incident = ctx.db.getIncident(incidentId);

  // 1. Verify audit chain first
  const chainCheck = ctx.db.verifyAuditChain();
  if (!chainCheck.valid) {
    let verifiedWaived = false;
    try {
      const anchorPath = ctx.db.getAnchorPath();
      if (fs.existsSync(anchorPath)) {
        const secret = getInstallationSecretKey();
        const raw = fs.readFileSync(anchorPath, 'utf8');
        const anchor: AuditHeadAnchor = JSON.parse(raw);
        if (verifyAuditHeadSignature(secret, anchor)) {
          // Check if this incident has a REPRODUCTION_WAIVED entry verified up to anchor.seq
          const waivedRow = (ctx.db as any).db
            .prepare(
              "SELECT * FROM audit_log WHERE entity_type = 'INCIDENT' AND entity_id = ? AND kind = 'REPRODUCTION_WAIVED' ORDER BY seq DESC LIMIT 1"
            )
            .get(incidentId) as any;

          if (waivedRow && Number(waivedRow.seq) <= Number(anchor.seq)) {
            const waivedSeq = Number(waivedRow.seq);
            const anchorSeq = Number(anchor.seq);
            const subRows = (ctx.db as any).db
              .prepare('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq ASC')
              .all(waivedSeq, anchorSeq) as any[];

            if (subRows.length === anchorSeq - waivedSeq + 1) {
              let subChainValid = true;
              for (let i = 0; i < subRows.length; i++) {
                const r = subRows[i];
                const expectedSeq = waivedSeq + i;
                if (Number(r.seq) !== expectedSeq) {
                  subChainValid = false;
                  break;
                }
                const expectedHash = computeAuditEntryHash(secret, {
                  prev_hash: String(r.prev_hash),
                  seq: expectedSeq,
                  created_at: String(r.created_at),
                  kind: String(r.kind),
                  entity_type: String(r.entity_type),
                  entity_id: String(r.entity_id),
                  payload_hash: String(r.payload_hash),
                });
                if (String(r.entry_hash) !== expectedHash) {
                  subChainValid = false;
                  break;
                }
                if (i > 0 && String(r.prev_hash) !== String(subRows[i - 1].entry_hash)) {
                  subChainValid = false;
                  break;
                }
              }
              if (
                subChainValid &&
                String(subRows[subRows.length - 1].entry_hash) === String(anchor.entryHash)
              ) {
                verifiedWaived = true;
              }
            }
          }
        }
      }
    } catch {
      verifiedWaived = false;
    }

    if (verifiedWaived) {
      return {
        state: 'WAIVED',
        attemptsUsed: 0,
        attemptsAllowed: MAX_REPRODUCTION_ATTEMPTS,
        history: incident?.reproductionGate?.history,
        discrepancyWarning: `Audit log hash chain is broken (${chainCheck.reasonCode}), but user WAIVED decision is verified by HMAC-signed audit_head anchor.`,
      };
    }

    return {
      state: 'AUDIT_BROKEN',
      attemptsUsed: 0,
      attemptsAllowed: MAX_REPRODUCTION_ATTEMPTS,
      history: incident?.reproductionGate?.history,
      discrepancyWarning: `Audit log hash chain is broken (${chainCheck.reasonCode}: ${chainCheck.message}). Gate state is set to AUDIT_BROKEN.`,
    };
  }

  // 2. Normal gate calculation
  const auditLogs = ctx.db.getIncidentReproductionAuditLogs(incidentId);

  let hasReproduced = false;
  let hasWaived = false;
  let grantsCount = 0;
  let failedAttempts = 0;
  let hasAbandonedLog = false;

  for (const entry of auditLogs) {
    if (entry.kind === 'REPRODUCTION_SUCCEEDED') {
      hasReproduced = true;
    } else if (entry.kind === 'REPRODUCTION_ATTEMPTED') {
      failedAttempts++;
    } else if (entry.kind === 'REPRODUCTION_WAIVED') {
      hasWaived = true;
    } else if (entry.kind === 'REPRODUCTION_ATTEMPTS_GRANTED') {
      grantsCount++;
    } else if (entry.kind === 'REPRODUCTION_ABANDONED') {
      hasAbandonedLog = true;
    }
  }

  const allowedAttempts = MAX_REPRODUCTION_ATTEMPTS + ADDITIONAL_ATTEMPTS_PER_GRANT * grantsCount;
  const attemptsUsed = failedAttempts;

  let state: ReproductionGateState;
  if (hasReproduced) {
    state = 'REPRODUCED';
  } else if (hasWaived) {
    state = 'WAIVED';
  } else if (failedAttempts >= allowedAttempts) {
    state = 'ABANDONED';
    if (!hasAbandonedLog) {
      ctx.db.appendAuditLog({
        kind: 'REPRODUCTION_ABANDONED',
        entityType: 'INCIDENT',
        entityId: incidentId,
        payloadHash: hashAuditPayload({
          incidentId,
          attemptsUsed,
          attemptsAllowed: allowedAttempts,
          abandonedAt: new Date().toISOString(),
        }),
      });
    }
  } else if (failedAttempts === 0) {
    state = 'NOT_ATTEMPTED';
  } else {
    state = 'IN_PROGRESS';
  }

  let discrepancyWarning: string | null = null;
  const storedGate = incident?.reproductionGate;
  if (storedGate) {
    if (
      storedGate.state !== state ||
      storedGate.attemptsUsed !== attemptsUsed ||
      storedGate.attemptsAllowed !== allowedAttempts
    ) {
      discrepancyWarning = `Reproduction gate discrepancy detected: audit calculation (state: ${state}, used: ${attemptsUsed}, allowed: ${allowedAttempts}) does not match incident stored gate (state: ${storedGate.state}, used: ${storedGate.attemptsUsed}, allowed: ${storedGate.attemptsAllowed}). Audit log state takes precedence.`;
    }
  } else if (state !== 'NOT_ATTEMPTED' && incident) {
    discrepancyWarning = `Reproduction gate discrepancy detected: reproduction_gate_json is missing in database, but audit log indicates state '${state}' with ${attemptsUsed}/${allowedAttempts} attempts. Audit log state takes precedence.`;
  }

  return {
    state,
    attemptsUsed,
    attemptsAllowed: allowedAttempts,
    history: storedGate?.history,
    discrepancyWarning: discrepancyWarning ?? undefined,
  };
}

export function decideReproduction(
  ctx: CoreContext,
  incidentId: string,
  decision: 'PROCEED_WITHOUT_REPRODUCTION' | 'ALLOW_MORE_ATTEMPTS',
  repoPath: string,
  reason?: string
): ReproductionGateInfo {
  const incident = ctx.db.getIncident(incidentId);
  if (!incident) {
    const err: any = new Error(`Incident with ID "${incidentId}" not found.`);
    err.code = 'INCIDENT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const project = ctx.ensureProject(repoPath);
  if (incident.projectId !== project.id) {
    const err: any = new Error(`[PROJECT_MISMATCH]: Incident ${incidentId} does not belong to project ${project.id}.`);
    err.code = 'PROJECT_MISMATCH';
    err.statusCode = 403;
    throw err;
  }

  const currentState = getReproductionGateState(ctx, incidentId);
  if (currentState.state === 'AUDIT_BROKEN') {
    if (decision === 'ALLOW_MORE_ATTEMPTS') {
      const err: any = new Error('[NOT_ABANDONED]: Incident reproduction gate is currently "AUDIT_BROKEN". ALLOW_MORE_ATTEMPTS is rejected when audit chain is broken.');
      err.code = 'NOT_ABANDONED';
      err.statusCode = 409;
      throw err;
    }
    // PROCEED_WITHOUT_REPRODUCTION is permitted
  } else if (currentState.state !== 'ABANDONED') {
    const err: any = new Error(`[NOT_ABANDONED]: Incident reproduction gate is currently "${currentState.state}", not "ABANDONED". Decision can only be made on abandoned incidents.`);
    err.code = 'NOT_ABANDONED';
    err.statusCode = 409;
    throw err;
  }

  const decidedAt = new Date().toISOString();
  if (decision === 'PROCEED_WITHOUT_REPRODUCTION') {
    const chainCheck = ctx.db.verifyAuditChain();
    const payload: any = {
      incidentId,
      decision,
      reason: reason || null,
      decidedAt,
    };
    if (!chainCheck.valid) {
      payload.chainStatus = 'BROKEN';
      payload.brokenReason = chainCheck.reasonCode;
    }
    ctx.db.appendAuditLog({
      kind: 'REPRODUCTION_WAIVED',
      entityType: 'INCIDENT',
      entityId: incidentId,
      payloadHash: hashAuditPayload(payload),
    });
  } else if (decision === 'ALLOW_MORE_ATTEMPTS') {
    ctx.db.appendAuditLog({
      kind: 'REPRODUCTION_ATTEMPTS_GRANTED',
      entityType: 'INCIDENT',
      entityId: incidentId,
      payloadHash: hashAuditPayload({
        incidentId,
        decision,
        additionalAttempts: ADDITIONAL_ATTEMPTS_PER_GRANT,
        reason: reason || null,
        decidedAt,
      }),
    });
  } else {
    const err: any = new Error(`[INVALID_DECISION]: Unsupported reproduction decision "${decision}".`);
    err.code = 'INVALID_ARGUMENT';
    err.statusCode = 400;
    throw err;
  }

  const updatedGate = getReproductionGateState(ctx, incidentId);
  ctx.db.updateIncidentReproductionGate(incidentId, updatedGate);

  ctx.emitChange('incident_updated', {
    incidentId,
    reproductionGate: updatedGate,
  });

  return updatedGate;
}

export async function runReproduction(
  ctx: CoreContext,
  repoPath: string,
  incidentId: string,
  testFilePath: string,
  baselineCheckpointIdOrOptions?: string | RunReproductionOptions,
  timeoutMs: number = 30000
): Promise<ReproductionResult> {
  const options: RunReproductionOptions =
    typeof baselineCheckpointIdOrOptions === 'string'
      ? { baselineCheckpointId: baselineCheckpointIdOrOptions }
      : (baselineCheckpointIdOrOptions || {});
  const baselineCheckpointId = options.baselineCheckpointId;
  const preFlipTestFilePath = options.preFlipTestFilePath;
  const effectiveTimeout = options.timeoutMs ?? timeoutMs;

  const targetPath = path.resolve(repoPath);
  const incident = ctx.db.getIncident(incidentId);
  if (!incident) {
    throw new Error(`Incident with ID "${incidentId}" not found.`);
  }

  const project = ctx.ensureProject(targetPath);

  // Check reproduction gate: if AUDIT_BROKEN, reject immediately with AUDIT_CHAIN_BROKEN
  const currentGate = getReproductionGateState(ctx, incidentId);
  if (currentGate.state === 'AUDIT_BROKEN') {
    const err: any = new Error('[AUDIT_CHAIN_BROKEN]: 감사 기록이 바깥에서 변경되었습니다. 더 진행하지 말고 사용자에게 알립니다.');
    err.code = 'AUDIT_CHAIN_BROKEN';
    err.next_action = {
      actor: 'USER',
      action: 'STOP_AND_REPORT',
      agent_should: '감사 기록이 바깥에서 변경되었다. 더 진행하지 말고 사용자에게 알린다.',
      forbidden: ['DB 직접 수정', '감사 기록 수정', 'audit_head.json 수정'],
    };
    throw err;
  }
  if (currentGate.state === 'ABANDONED') {
    const err: any = new Error('[REPRODUCTION_ABANDONED]: 재현 시도가 3회 실패하여 사건이 기권 상태입니다. 사용자가 앱에서 결정을 내릴 때까지 추가 재현 또는 수정안 제출이 거부됩니다.');
    err.code = 'REPRODUCTION_ABANDONED';
    err.next_action = {
      actor: 'USER',
      action: 'ABSTAIN_REPRODUCTION',
      agent_should: "재현 시도를 멈추고, 시도한 테스트와 실패 이유를 사용자에게 짧게 요약한 뒤, Agent Autopsy 앱에서 '재현 없이 진행' 또는 '시도 더 허락'을 결정해 달라고 요청한다.",
      forbidden: ['재현 없이 수정안 제출', 'DB 직접 수정', '감사 기록 수정', '재현 테스트를 다른 이름으로 다시 시도'],
    };
    throw err;
  }

  // Check reproduction test lock at start
  let initialLockStatus: ReproductionLockStatus | undefined;
  let initialLockWarning: string | undefined;
  let initialLockNextAction: NextAction | undefined;

  const existingLock = incident.reproductionLock;
  if (existingLock) {
    const secret = getInstallationSecretKey();
    if (!verifyReproductionLockSignature(secret, existingLock)) {
      initialLockStatus = 'LOCK_SIGNATURE_INVALID';
      initialLockWarning = '재현 테스트 잠금의 서명이 올바르지 않습니다 (잠금 변조 의심).';
    } else {
      const hostLockedFile = path.resolve(targetPath, existingLock.testFilePath);
      let currentLockedHash = '';
      if (fs.existsSync(hostLockedFile)) {
        currentLockedHash = computeNormalizedContentHash(fs.readFileSync(hostLockedFile, 'utf8'));
      }
      if (currentLockedHash !== existingLock.contentHash) {
        initialLockStatus = 'LOCKED_TEST_MODIFIED';
        initialLockWarning = '잠금된 재현 테스트 파일이 디스크에서 변경되었습니다.';
        initialLockNextAction = {
          actor: 'AGENT',
          action: 'RESTORE_OR_REPLACE_LOCK',
          agent_should: `잠금된 테스트 파일(${existingLock.testFilePath})이 변경되었습니다. 원래 내용으로 복원하거나 replace_lock: true와 replace_reason을 지정하여 잠금을 갱신하세요.`,
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      }
    }
  } else if (ctx.db.hasIncidentReproductionLockAudit(incidentId)) {
    initialLockStatus = 'LOCK_REMOVED';
    initialLockWarning = '과거에 생성된 재현 테스트 잠금이 외부에서 삭제되었습니다 (잠금 삭제 변조 의심).';
    initialLockNextAction = {
      actor: 'AGENT',
      action: 'REPRODUCE_FIRST',
      agent_should: '과거 잠금 기록이 삭제된 상태입니다. run_reproduction으로 재현 테스트를 다시 실행하여 잠금을 새로 생성하세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
  }

  // 1. Validate that input is strictly a file path and contains no shell metacharacters
  const rawPath = String(testFilePath || '').trim().replace(/^["']|["']$/g, '');
  if (!rawPath || /[\r\n;&|`$><]/.test(rawPath)) {
    const reproductionResult: ReproductionResult = {
      status: 'CANNOT_RUN',
      command: '',
      testFilePath: rawPath,
      exitCode: 1,
      output: '유효하지 않은 테스트 파일 경로입니다. 재현 테스트에는 임의의 셸 명령이나 제어 문자를 전달할 수 없으며 오직 단일 파일 경로만 허용됩니다.',
      executedAt: new Date().toISOString(),
    };
    const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 파일 경로 유효성 검증 실패`];
    ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
    reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
    return reproductionResult;
  }

  const hostFile = path.resolve(targetPath, rawPath);
  if (isPathOutsideRepo(targetPath, hostFile)) {
    const reproductionResult: ReproductionResult = {
      status: 'CANNOT_RUN',
      command: '',
      testFilePath: rawPath,
      exitCode: 1,
      output: '저장소 밖 경로는 재현 테스트로 쓸 수 없음',
      executedAt: new Date().toISOString(),
    };
    const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 저장소 밖 경로는 재현 테스트로 쓸 수 없음`];
    ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
    reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
    return reproductionResult;
  }

  // 1b. Validate preFlipTestFilePath if provided
  let relPreFlipPath: string | undefined;
  let hostPreFlipFile: string | undefined;
  if (preFlipTestFilePath) {
    const rawPreFlip = String(preFlipTestFilePath || '').trim().replace(/^["']|["']$/g, '');
    if (!rawPreFlip || /[\r\n;&|`$><]/.test(rawPreFlip)) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        testFilePath: rawPath,
        exitCode: 1,
        output: '유효하지 않은 뒤집기 전 테스트 파일 경로입니다. 셸 메타문자가 포함될 수 없습니다.',
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 뒤집기 전 파일 경로 유효성 검증 실패`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
      return reproductionResult;
    }
    hostPreFlipFile = path.resolve(targetPath, rawPreFlip);
    if (isPathOutsideRepo(targetPath, hostPreFlipFile)) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        testFilePath: rawPath,
        exitCode: 1,
        output: '저장소 밖 경로는 재현 테스트로 쓸 수 없음',
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 저장소 밖 경로는 재현 테스트로 쓸 수 없음`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
      return reproductionResult;
    }
    if (!fs.existsSync(hostPreFlipFile) || !fs.statSync(hostPreFlipFile).isFile()) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        testFilePath: rawPath,
        exitCode: 1,
        output: `뒤집기 전 테스트 파일이 존재하지 않습니다: ${rawPreFlip}`,
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 뒤집기 전 파일 없음: ${rawPreFlip}`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
      return reproductionResult;
    }
    relPreFlipPath = path.relative(targetPath, hostPreFlipFile).replace(/\\/g, '/');
  }

  // 2. Check if host test file exists
  if (!fs.existsSync(hostFile) || !fs.statSync(hostFile).isFile()) {
    const reproductionResult: ReproductionResult = {
      status: 'CANNOT_RUN',
      command: '',
      testFilePath: rawPath,
      exitCode: 1,
      output: `재현 테스트 파일이 존재하지 않습니다: ${rawPath}`,
      executedAt: new Date().toISOString(),
    };
    const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 파일 없음: ${rawPath}`];
    ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
    reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
    return reproductionResult;
  }

  // 3. Check for confirmed test runner with valid signature
  const isRunnerConfirmed = Boolean(
    project.testCommand &&
    project.testCommandSignature &&
    verifyTestCommandSignature(project.id, project.testCommand, project.testCommandSignature)
  );

  if (!isRunnerConfirmed) {
    const reproductionResult: ReproductionResult = {
      status: 'CANNOT_RUN',
      command: '',
      testFilePath: rawPath,
      exitCode: 1,
      output: '확정된 테스트 러너가 없습니다. 앱 프로젝트 설정에서 테스트 명령을 먼저 확정한 후 재현 테스트를 실행할 수 있습니다.',
      executedAt: new Date().toISOString(),
    };
    const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 확정된 테스트 러너 없음`];
    ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
    reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
    return reproductionResult;
  }

  // 4. Construct execution command using confirmed runner and relative file path
  const relTestPath = path.relative(targetPath, hostFile).replace(/\\/g, '/');
  const effectiveCommand = buildReproductionCommand(project.testCommand!, relTestPath);
  const runnerType = detectRunnerType(effectiveCommand);

  // 5. Variables declared before try/finally so cleanup always occurs
  let currentSnapshot: SnapshotResult | undefined;
  let currentSandboxDir: string | undefined;
  let baselineSandboxDir: string | undefined;

  try {
    // 6. Resolve baseline checkpoint and rule using the unified locateChangeScope
    const ignoreList = [relTestPath];
    if (relPreFlipPath) {
      ignoreList.push(relPreFlipPath);
    }
    const scopeResult = await locateChangeScope(ctx, {
      repoPath: targetPath,
      incidentId,
      baselineCheckpointId,
      ignoreFilePath: relTestPath,
      ignoreFilePaths: ignoreList,
    });

    // 7. Capture "현재" snapshot (live working directory including untracked & uncommitted changes)
    const reproSnapshotId = `repro-snap-${incidentId.slice(0, 8)}-${Date.now()}`;
    try {
      currentSnapshot = ctx.gitEngine.createSnapshot(targetPath, reproSnapshotId, 'Reproduction transient snapshot');
    } catch (snapErr: any) {
      const errMsg = snapErr?.message || String(snapErr);
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: effectiveCommand,
        testFilePath: relTestPath,
        exitCode: 1,
        output: `현재 작업 폴더 스냅샷을 만들지 못해 재현하지 않음: ${errMsg}`,
        executedAt: new Date().toISOString(),
        failureReason: `현재 작업 폴더 스냅샷을 만들지 못해 재현하지 않음: ${errMsg}`,
      };
      const causeEvidence = [
        ...(incident.causeEvidence || []),
        `[실행 증거] 현재 작업 폴더 스냅샷을 만들지 못해 재현하지 않음: ${errMsg} - ${effectiveCommand}`,
      ];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      reproductionResult.reproductionGate = getReproductionGateState(ctx, incidentId);
      return reproductionResult;
    }
    const currentCommit = currentSnapshot.worktreeCommitSha;

    // 8. Check if baseline tree is byte-for-byte identical to current snapshot tree
    let treeIdentical = false;
    if (scopeResult.baselineSha && scopeResult.baselineSha !== 'HEAD' && currentCommit) {
      try {
        const currentTree = ctx.gitEngine.runGit(targetPath, ['rev-parse', `${currentCommit}^{tree}`]).trim();
        const baselineTree = ctx.gitEngine.runGit(targetPath, ['rev-parse', `${scopeResult.baselineSha}^{tree}`]).trim();
        if (currentTree && baselineTree && currentTree === baselineTree) {
          treeIdentical = true;
        } else {
          const diffFiles = ctx.gitEngine.runGit(targetPath, ['diff', '--name-only', scopeResult.baselineSha, currentCommit]);
          const changedExcludingTest = diffFiles
            .split(/\r?\n/)
            .map((f) => f.trim().replace(/\\/g, '/'))
            .filter((f) => f && f.toLowerCase() !== relTestPath.toLowerCase() && (!relPreFlipPath || f.toLowerCase() !== relPreFlipPath.toLowerCase()));
          if (changedExcludingTest.length === 0) {
            treeIdentical = true;
          }
        }
      } catch {}
    }

    // Child environment without NODE_TEST_CONTEXT or NODE_TEST_WORKER_ID
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;

    // 9. Run on "현재" (Current)
    const currentSandboxId = `repro-cur-${incidentId.slice(0, 8)}-${Date.now()}`;
    const curWorktree = ctx.worktreeRunner.createWorktree(targetPath, currentSandboxId, currentCommit, [], effectiveCommand);
    currentSandboxDir = curWorktree.sandboxDir;

    // Copy reproduction test file into sandbox
    const curDestFile = path.resolve(currentSandboxDir, relTestPath);
    fs.mkdirSync(path.dirname(curDestFile), { recursive: true });
    fs.copyFileSync(hostFile, curDestFile);

    if (relPreFlipPath && hostPreFlipFile) {
      const curPreFlipDest = path.resolve(currentSandboxDir, relPreFlipPath);
      fs.mkdirSync(path.dirname(curPreFlipDest), { recursive: true });
      fs.copyFileSync(hostPreFlipFile, curPreFlipDest);
    }

    const currentExec = await executeTestRuns(
      ctx,
      currentSandboxDir,
      hostFile,
      relTestPath,
      effectiveCommand,
      runnerType,
      effectiveTimeout,
      childEnv
    );

    const currentRuns = currentExec.runs;
    let currentStatus: ReproductionStatus = currentExec.lastEval.status;
    let currentFailureKind = currentExec.lastEval.failureKind;
    let currentFailureReason = currentExec.lastEval.failureReason;

    if (currentRuns.length > 1) {
      const allReproduced = currentRuns.every((r) => r.status === 'REPRODUCED');
      const allNotReproduced = currentRuns.every((r) => r.status === 'NOT_REPRODUCED');
      const allSameStatus = currentRuns.every(
        (r) => r.status === currentRuns[0].status && r.failureKind === currentRuns[0].failureKind
      );

      if (allReproduced) {
        currentStatus = 'REPRODUCED';
      } else if (allNotReproduced) {
        currentStatus = 'NOT_REPRODUCED';
      } else if (allSameStatus) {
        currentStatus = currentRuns[0].status;
        currentFailureKind = currentRuns[0].failureKind;
      } else {
        // Mixed results across runs -> FLAKY
        currentStatus = 'WRONG_FAILURE';
        currentFailureKind = 'FLAKY';
        currentFailureReason = '실행마다 결과가 달라짐 (FLAKY)';
      }
    }

    // 10. Baseline Comparison
    let verdict: BaselineComparisonVerdict;
    let baselineRuns: ReproductionRunRecord[] = [];
    let note: string | undefined = currentExec.durationNote;

    const canCompareBaseline =
      !treeIdentical &&
      Boolean(scopeResult.baselineSha) &&
      scopeResult.baselineRule !== 'NO_CHECKPOINT_HEAD';

    if (currentStatus !== 'REPRODUCED') {
      verdict = 'SKIPPED';
      const skipNote = '현재에서 재현(REPRODUCED)되지 않아 정상 시점 실행을 생략함';
      note = note ? `${note}; ${skipNote}` : skipNote;
    } else if (!canCompareBaseline) {
      verdict = 'NO_BASELINE';
      const noBaseNote = treeIdentical
        ? '정상 시점과 현재 트리가 동일하여 비교 대상 없음'
        : '정상 시점 체크포인트가 없어 비교 대상 없음';
      note = note ? `${note}; ${noBaseNote}` : noBaseNote;
    } else {
      // Run baseline worktree
      const baselineSandboxId = `repro-base-${incidentId.slice(0, 8)}-${Date.now()}`;
      const baseWorktree = ctx.worktreeRunner.createWorktree(
        targetPath,
        baselineSandboxId,
        scopeResult.baselineSha,
        [],
        effectiveCommand
      );
      baselineSandboxDir = baseWorktree.sandboxDir;

      const baseDestFile = path.resolve(baselineSandboxDir, relTestPath);
      fs.mkdirSync(path.dirname(baseDestFile), { recursive: true });
      fs.copyFileSync(hostFile, baseDestFile);

      const baselineExec = await executeTestRuns(
        ctx,
        baselineSandboxDir,
        hostFile,
        relTestPath,
        effectiveCommand,
        runnerType,
        effectiveTimeout,
        childEnv
      );

      baselineRuns = baselineExec.runs;
      if (baselineExec.durationNote) {
        note = note ? `${note}; ${baselineExec.durationNote}` : baselineExec.durationNote;
      }

      const allBaselinePassed = baselineRuns.every((r) => r.status === 'NOT_REPRODUCED');
      const allBaselineReproduced = baselineRuns.every((r) => r.status === 'REPRODUCED');
      const allBaselineCannotRunOrWrong = baselineRuns.every(
        (r) => r.status === 'WRONG_FAILURE' || r.status === 'CANNOT_RUN' || r.status === 'UNVERIFIED_FAILURE'
      );

      if (allBaselinePassed) {
        verdict = 'REGRESSION_CONFIRMED';
      } else if (allBaselineReproduced) {
        verdict = 'PRE_EXISTING';
      } else if (allBaselineCannotRunOrWrong) {
        verdict = 'BASELINE_CANNOT_RUN';
      } else {
        verdict = 'BASELINE_FLAKY';
      }
    }

    const baselineComparison: BaselineComparison = {
      baselineCheckpointId: scopeResult.baselineCheckpointId,
      baselineSha: scopeResult.baselineSha,
      baselineRule: scopeResult.baselineRule,
      verdict,
      runs: {
        current: currentRuns,
        baseline: baselineRuns.length > 0 ? baselineRuns : undefined,
      },
      note,
    };

    // 11. AssertFlip check (Run pre-flip test in current sandbox & check line diff)
    let assertFlip: AssertFlipResult;
    if (!relPreFlipPath || !hostPreFlipFile) {
      assertFlip = {
        verdict: 'NOT_PROVIDED',
      };
    } else if (currentStatus !== 'REPRODUCED' || runnerType === 'unsupported') {
      assertFlip = {
        preFlipTestFilePath: relPreFlipPath,
        verdict: 'SKIPPED',
        runs: [],
        note: currentStatus !== 'REPRODUCED'
          ? '뒤집은 테스트가 REPRODUCED가 아니므로 뒤집기 전 테스트 실행 생략'
          : '지원하지 않는 실행기이므로 뒤집기 전 테스트 실행 생략',
      };
    } else {
      // Execute pre-flip test in currentSandboxDir
      const preFlipCommand = buildReproductionCommand(project.testCommand!, relPreFlipPath);
      const preFlipExec = await executeTestRuns(
        ctx,
        currentSandboxDir,
        hostPreFlipFile,
        relPreFlipPath,
        preFlipCommand,
        runnerType,
        effectiveTimeout,
        childEnv
      );

      // Line diff check between pre-flip and flipped test files ("간단한 줄 패턴 검사")
      const preFlipContent = fs.readFileSync(hostPreFlipFile, 'utf8');
      const flippedContent = fs.readFileSync(hostFile, 'utf8');
      const diffResult = await diffAssertionLines(preFlipContent, flippedContent, runnerType);

      const preFlipRuns = preFlipExec.runs;
      const allPreFlipPassed = preFlipRuns.length > 0 && preFlipRuns.every((r) => r.status === 'NOT_REPRODUCED');
      const allSameStatus = preFlipRuns.length > 0 && preFlipRuns.every(
        (r) => r.status === preFlipRuns[0].status && r.failureKind === preFlipRuns[0].failureKind
      );

      if (diffResult.changedLineCount > 10 || diffResult.nonAssertionChangedLines.length > 0) {
        assertFlip = {
          preFlipTestFilePath: relPreFlipPath,
          verdict: 'FLIP_CHANGED_NON_ASSERTION',
          runs: preFlipRuns,
          changedLineCount: diffResult.changedLineCount,
          nonAssertionChangedLines: diffResult.nonAssertionChangedLines.slice(0, 5),
          note: diffResult.changedLineCount > 10
            ? `바뀐 줄 수(${diffResult.changedLineCount}줄)가 상한(10줄)을 초과함`
            : (diffResult.note || '단언 줄이 아닌 줄이 변경됨'),
        };
      } else if (!allSameStatus) {
        assertFlip = {
          preFlipTestFilePath: relPreFlipPath,
          verdict: 'PRE_FLIP_FLAKY',
          runs: preFlipRuns,
          changedLineCount: diffResult.changedLineCount,
          note: '뒤집기 전 테스트 결과가 실행마다 다름',
        };
      } else if (!allPreFlipPassed) {
        assertFlip = {
          preFlipTestFilePath: relPreFlipPath,
          verdict: 'PRE_FLIP_NOT_PASSING',
          runs: preFlipRuns,
          changedLineCount: diffResult.changedLineCount,
          note: preFlipExec.lastEval.failureReason || '뒤집기 전 테스트가 통과하지 않음',
        };
      } else {
        assertFlip = {
          preFlipTestFilePath: relPreFlipPath,
          verdict: 'FLIP_CONFIRMED',
          runs: preFlipRuns,
          changedLineCount: diffResult.changedLineCount,
          note: '뒤집기 전 테스트 통과, 단언 줄만 변경되어 뒤집은 테스트 단언 실패 확인',
        };
      }
    }

    let lockStatus: ReproductionLockStatus | undefined = initialLockStatus;
    let reproductionLock: ReproductionLock | undefined = existingLock || undefined;
    let lockWarning: string | undefined = initialLockWarning;
    let lockNextAction: NextAction | undefined = initialLockNextAction;

    const secret = getInstallationSecretKey();
    const curContent = fs.readFileSync(hostFile, 'utf8');
    const curContentHash = computeNormalizedContentHash(curContent);
    let curPreFlipContentHash: string | undefined;
    if (hostPreFlipFile && fs.existsSync(hostPreFlipFile)) {
      curPreFlipContentHash = computeNormalizedContentHash(fs.readFileSync(hostPreFlipFile, 'utf8'));
    }

    if (currentStatus === 'REPRODUCED' && currentFailureKind !== 'FLAKY') {
      if (!existingLock) {
        // 1. First time locking
        const lockData = {
          testFilePath: relTestPath,
          contentHash: curContentHash,
          lockedAt: new Date().toISOString(),
          baselineVerdict: verdict,
          assertFlipVerdict: assertFlip?.verdict,
          preFlipFilePath: relPreFlipPath,
          preFlipContentHash: curPreFlipContentHash,
        };
        const signature = computeReproductionLockSignature(secret, lockData);
        const newLock: ReproductionLock = { ...lockData, signature };
        ctx.db.updateIncidentReproductionLock(incidentId, newLock);
        ctx.db.appendAuditLog({
          kind: 'REPRODUCTION_LOCKED',
          entityType: 'INCIDENT',
          entityId: incidentId,
          payloadHash: hashAuditPayload(newLock),
        });
        lockStatus = 'LOCKED';
        reproductionLock = newLock;
        lockWarning = undefined;
        lockNextAction = undefined;
      } else {
        // 2. Existing lock present
        const isSameFile = isSamePathUnderRepo(targetPath, existingLock.testFilePath, relTestPath);
        const isSameHash = existingLock.contentHash === curContentHash;

        if (initialLockStatus === 'LOCK_SIGNATURE_INVALID' && !options.replace_lock) {
          lockStatus = 'LOCK_SIGNATURE_INVALID';
          lockWarning = '재현 테스트 잠금의 서명이 올바르지 않습니다 (잠금 변조 의심).';
          reproductionLock = existingLock;
        } else if (isSameFile && isSameHash) {
          lockStatus = 'LOCKED';
          reproductionLock = existingLock;
          lockWarning = undefined;
          lockNextAction = undefined;
        } else {
          if (!options.replace_lock) {
            lockStatus = 'LOCK_KEPT';
            lockWarning = `잠금된 테스트와 다름: 이미 잠금된 재현 테스트(${existingLock.testFilePath})와 다릅니다. 기존 잠금이 유지됩니다.`;
            reproductionLock = existingLock;
            lockNextAction = {
              actor: 'AGENT',
              action: 'REUSE_OR_REPLACE_LOCK',
              agent_should: `기존 잠금 테스트(${existingLock.testFilePath})로 다시 실행하거나, 테스트를 변경해야 한다면 replace_lock: true와 변경 사유(replace_reason)를 함께 전달하세요.`,
              forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
            };
          } else {
            const historyEntry: ReproductionLockHistoryEntry = {
              testFilePath: existingLock.testFilePath,
              contentHash: existingLock.contentHash,
              lockedAt: existingLock.lockedAt,
              baselineVerdict: existingLock.baselineVerdict,
              assertFlipVerdict: existingLock.assertFlipVerdict,
              preFlipFilePath: existingLock.preFlipFilePath,
              preFlipContentHash: existingLock.preFlipContentHash,
              replaceReason: options.replace_reason || '사유 미지정',
            };
            const history = [...(existingLock.history || []), historyEntry];
            const lockData = {
              testFilePath: relTestPath,
              contentHash: curContentHash,
              lockedAt: new Date().toISOString(),
              baselineVerdict: verdict,
              assertFlipVerdict: assertFlip?.verdict,
              preFlipFilePath: relPreFlipPath,
              preFlipContentHash: curPreFlipContentHash,
              history,
            };
            const signature = computeReproductionLockSignature(secret, lockData);
            const newLock: ReproductionLock = { ...lockData, signature };
            ctx.db.updateIncidentReproductionLock(incidentId, newLock);
            ctx.db.appendAuditLog({
              kind: 'REPRODUCTION_LOCK_REPLACED',
              entityType: 'INCIDENT',
              entityId: incidentId,
              payloadHash: hashAuditPayload(newLock),
            });
            lockStatus = 'LOCK_REPLACED';
            reproductionLock = newLock;
            lockWarning = undefined;
            lockNextAction = undefined;
          }
        }
      }
    }

    const reproductionResult: ReproductionResult = {
      status: currentStatus,
      command: effectiveCommand,
      testFilePath: relTestPath,
      exitCode: currentExec.lastTestResult.exitCode,
      output: currentExec.lastTestResult.output,
      failedLocation: currentExec.lastEval.failedLocation,
      executedAt: new Date().toISOString(),
      failureKind: currentFailureKind,
      failureReason: currentFailureReason,
      testCount: currentExec.lastEval.testCount,
      baselineComparison,
      assertFlip,
      lockStatus,
      reproductionLock,
      lockWarning,
      next_action: lockNextAction,
    };

    // 12. Update incident in DB with execution evidence & re-evaluate causeVerdict
    const updatedIncident: Incident = {
      ...incident,
      reproductionResult,
    };

    const analysis = analyzeIncident(
      incident.errorOutput,
      incident.diffSummary,
      targetPath,
      project.name,
      'HEAD',
      updatedIncident
    );

    const causeEvidence = [...(incident.causeEvidence || [])];
    const verdictSuffix = ` [비교: ${verdict}]`;
    const flipSuffix = assertFlip ? ` [AssertFlip: ${assertFlip.verdict}]` : '';
    if (currentStatus === 'REPRODUCED') {
      const locNote = reproductionResult.failedLocation ? ` (${reproductionResult.failedLocation.filePath}:${reproductionResult.failedLocation.line})` : '';
      causeEvidence.push(`[실행 증거] 재현 테스트 실행으로 실패 재현 확인${locNote}${verdictSuffix}${flipSuffix} - ${effectiveCommand}`);
    } else if (currentStatus === 'NOT_REPRODUCED') {
      causeEvidence.push(`[실행 증거] 재현 테스트에서 실패가 재현되지 않음${verdictSuffix}${flipSuffix} - ${effectiveCommand}`);
    } else if (currentStatus === 'WRONG_FAILURE') {
      const reason = currentFailureReason ? `: ${currentFailureReason}` : '';
      causeEvidence.push(`[실행 증거] 재현 테스트가 단언 실패가 아닌 다른 이유로 실패함${reason}${verdictSuffix}${flipSuffix} - ${effectiveCommand}`);
    } else if (currentStatus === 'UNVERIFIED_FAILURE') {
      causeEvidence.push(`[실행 증거] 지원하지 않는 실행기로 실패 이유를 검증하지 못함${verdictSuffix}${flipSuffix} - ${effectiveCommand}`);
    } else {
      causeEvidence.push(`[실행 증거] 재현 테스트 실행 불가${verdictSuffix}${flipSuffix} - ${effectiveCommand}`);
    }

    ctx.db.updateIncidentReproduction(
      incidentId,
      reproductionResult,
      analysis.causeVerdict,
      causeEvidence
    );

    // Record reproduction attempt in audit log
    const attemptedAt = new Date().toISOString();
    const isSuccess = currentStatus === 'REPRODUCED';
    const auditKind = isSuccess ? 'REPRODUCTION_SUCCEEDED' : 'REPRODUCTION_ATTEMPTED';

    ctx.db.appendAuditLog({
      kind: auditKind,
      entityType: 'INCIDENT',
      entityId: incidentId,
      payloadHash: hashAuditPayload({
        incidentId,
        status: currentStatus,
        failureKind: currentFailureKind ?? null,
        testFilePath: relTestPath,
        attemptedAt,
      }),
    });

    // Compute updated gate state & persist history to display column
    const latestIncident = ctx.db.getIncident(incidentId);
    const existingHistory = latestIncident?.reproductionGate?.history || [];
    const updatedHistory: ReproductionGateAttempt[] = [
      ...existingHistory,
      {
        attemptedAt,
        status: currentStatus,
        failureKind: currentFailureKind ?? null,
        testFilePath: relTestPath,
      },
    ].slice(-20);

    const updatedGate = getReproductionGateState(ctx, incidentId);
    updatedGate.history = updatedHistory;
    ctx.db.updateIncidentReproductionGate(incidentId, updatedGate);

    reproductionResult.reproductionGate = updatedGate;

    ctx.emitChange('incident_updated', {
      incidentId,
      reproductionResult,
      causeVerdict: analysis.causeVerdict,
      reproductionGate: updatedGate,
    });

    return reproductionResult;
  } finally {
    if (currentSandboxDir) {
      ctx.worktreeRunner.cleanupWorktree(targetPath, currentSandboxDir);
    }
    if (baselineSandboxDir) {
      ctx.worktreeRunner.cleanupWorktree(targetPath, baselineSandboxDir);
    }
    if (currentSnapshot?.gitRef) {
      try {
        ctx.gitEngine.runGit(targetPath, ['update-ref', '-d', currentSnapshot.gitRef]);
      } catch {}
    }
  }
}

  /**
   * Helper to construct a single test execution command from confirmed test runner and relative test file path.
   */
  export function buildReproductionCommand(confirmedRunner: string, relTestPath: string): string {
    const trimmed = confirmedRunner.trim();
    if (trimmed.includes('{file}')) {
      return trimmed.replace(/\{file\}/g, `"${relTestPath}"`);
    }
    const pyMpytestMatch = trimmed.match(/^((?:python\d*|py)(?:\.exe)?\s+-m\s+pytest)\b/i);
    if (pyMpytestMatch) {
      return `${pyMpytestMatch[1]} "${relTestPath}"`;
    }
    const pyMunittestMatch = trimmed.match(/^((?:python\d*|py)(?:\.exe)?\s+-m\s+unittest)\b/i);
    if (pyMunittestMatch) {
      return `${pyMunittestMatch[1]} "${relTestPath}"`;
    }
    if (/\bpython\b.*-m\s+unittest/i.test(trimmed)) {
      return `python -m unittest "${relTestPath}"`;
    }
    if (/\bpytest\b/i.test(trimmed)) {
      return `pytest "${relTestPath}"`;
    }
    if (/\bnode\s+--test\b/i.test(trimmed)) {
      return `node --test "${relTestPath}"`;
    }
    if (/^(npm|pnpm|yarn)(\.cmd)?\s+test/i.test(trimmed)) {
      return `${trimmed} -- "${relTestPath}"`;
    }
    if (/^go\s+test/i.test(trimmed)) {
      return `go test "${relTestPath}"`;
    }
    if (/^cargo\s+test/i.test(trimmed)) {
      return `cargo test -- "${relTestPath}"`;
    }
    if (trimmed === 'node' || trimmed === 'node.exe') {
      return `node "${relTestPath}"`;
    }
    return `${trimmed} "${relTestPath}"`;
  }

  function detectRunnerType(command: string): SupportedRunnerType {
    const trimmed = command.trim();
    if (/^(?:pytest|(?:python\d*|py)(?:\.exe)?\s+-m\s+pytest)\b/i.test(trimmed)) {
      return 'pytest';
    }
    if (/^(?:python\d*|py)(?:\.exe)?\s+-m\s+unittest\b/i.test(trimmed)) {
      return 'unittest';
    }
    if (/^node(?:\.exe)?\s+--test\b/i.test(trimmed)) {
      return 'node:test';
    }
    return 'unsupported';
  }

  interface EvaluationOutput {
    status: ReproductionStatus;
    failureKind?: ReproductionFailureKind;
    failureReason?: string;
    testCount?: number;
    failedLocation?: { filePath: string; line: number };
  }

  function decodeXml(str: string): string {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#10;/g, '\n')
      .replace(/&#13;/g, '\r')
      .replace(/&amp;/g, '&');
  }

  function evaluatePytestReproduction(
    reportFilePath: string | undefined,
    testResult: { success: boolean; exitCode: number; output: string }
  ): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'pytest 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    if (testResult.success) {
      if (!reportFilePath || !fs.existsSync(reportFilePath)) {
        return {
          status: 'NOT_REPRODUCED',
          failureReason: '테스트가 성공했습니다',
        };
      }
      const xml = fs.readFileSync(reportFilePath, 'utf8');
      const testsMatch = /tests="(\d+)"/.exec(xml);
      const testCount = testsMatch ? parseInt(testsMatch[1], 10) : 0;
      if (testCount === 0) {
        return {
          status: 'WRONG_FAILURE',
          failureKind: 'NO_TESTS',
          failureReason: 'pytest가 실행한 테스트가 0개입니다',
          testCount: 0,
        };
      }
      return {
        status: 'NOT_REPRODUCED',
        testCount,
      };
    }

    // Unsuccessful run
    if (testResult.exitCode === 124 || /시간이 초과되었습니다|timed out|timeout/i.test(output)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'TIMEOUT',
        failureReason: 'pytest 실행 시간 초과 (timeout)',
      };
    }

    if (!reportFilePath || !fs.existsSync(reportFilePath)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_REPORT',
        failureReason: 'pytest JUnit XML 리포트 파일이 생성되지 않았습니다',
      };
    }

    const xml = fs.readFileSync(reportFilePath, 'utf8');
    const testsMatch = /tests="(\d+)"/.exec(xml);
    const errorsMatch = /errors="(\d+)"/.exec(xml);
    const failuresMatch = /failures="(\d+)"/.exec(xml);
    const testCount = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const errorCount = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;
    const failureCount = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;

    if (testCount === 0) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'pytest가 실행한 테스트가 0개입니다',
        testCount: 0,
      };
    }

    if (errorCount > 0) {
      const isCollectionError =
        /<error[^>]*message="collection failure"|<error[^>]*>[\s\S]*?(?:ImportError|ModuleNotFoundError|SyntaxError)/i.test(
          xml
        );
      return {
        status: 'WRONG_FAILURE',
        failureKind: isCollectionError ? 'COLLECTION_ERROR' : 'RUNTIME_ERROR',
        failureReason: isCollectionError
          ? 'pytest 테스트 수집 중 오류가 발생했습니다 (collection failure)'
          : `pytest 테스트 설정/수행 중 오류(${errorCount}건)가 발생했습니다`,
        testCount,
      };
    }

    const failureRegex = /<failure(?:\s+message="([^"]*)")?>([\s\S]*?)<\/failure>/g;
    let match: RegExpExecArray | null;
    let allAssertions = true;
    let nonAssertionReason = '';
    let parsedFailures = 0;
    let failedLocation: { filePath: string; line: number } | undefined;

    while ((match = failureRegex.exec(xml)) !== null) {
      parsedFailures++;
      const rawMessage = match[1] || '';
      const rawBody = match[2] || '';
      const decodedMessage = decodeXml(rawMessage);
      const decodedBody = decodeXml(rawBody);

      const runtimeErrPattern =
        /(?:^|\n)\s*(?:E\s+)?(TypeError|NameError|AttributeError|ValueError|IndexError|KeyError|ZeroDivisionError|ImportError|ModuleNotFoundError|SyntaxError|UnboundLocalError|FileNotFoundError|OSError):/m;
      const isRuntime = runtimeErrPattern.test(decodedMessage) || runtimeErrPattern.test(decodedBody);
      if (isRuntime) {
        allAssertions = false;
        const errMatch = runtimeErrPattern.exec(decodedMessage) || runtimeErrPattern.exec(decodedBody);
        nonAssertionReason = errMatch ? errMatch[1] : '런타임 예외';
        break;
      }

      const isAssertMsg = /^(?:AssertionError|Failed:|assert\b)/i.test(decodedMessage);
      const isAssertBody =
        /(?:^|\n)\s*(?:E\s+)?(?:AssertionError|Failed)(?::|\b)|\bAssertionError\s*$/m.test(decodedBody);
      if (!isAssertMsg && !isAssertBody) {
        allAssertions = false;
        nonAssertionReason = '단언 실패가 아닌 다른 오류';
        break;
      }

      if (!failedLocation) {
        const locMatch =
          /(?:^|\n)([^\n:]+\.py):(\d+): (?:AssertionError|Failed)/m.exec(decodedBody) ||
          /(?:^|\n)\s*File "([^"]+)", line (\d+)/m.exec(decodedBody);
        if (locMatch) {
          failedLocation = { filePath: locMatch[1].replace(/\\\\/g, '\\'), line: parseInt(locMatch[2], 10) };
        }
      }
    }

    if (allAssertions && (failureCount > 0 || parsedFailures > 0) && errorCount === 0 && testCount >= 1) {
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: '단언 실패가 확인되었습니다',
        testCount,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: `pytest 실행 중 오류가 발생했습니다 (${nonAssertionReason || '런타임 예외'})`,
      testCount,
    };
  }

  function evaluateUnittestReproduction(testResult: {
    success: boolean;
    exitCode: number;
    output: string;
  }): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'unittest 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    const ranMatch = /Ran (\d+) tests?/i.exec(output);
    const testCount = ranMatch ? parseInt(ranMatch[1], 10) : 0;

    if (testResult.exitCode === 5 || /NO TESTS RAN/i.test(output) || (ranMatch && testCount === 0)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'unittest가 실행한 테스트가 0개입니다 (NO TESTS RAN)',
        testCount: 0,
      };
    }

    if (testResult.success) {
      return {
        status: 'NOT_REPRODUCED',
        testCount,
      };
    }

    const failedSummaryMatch = /FAILED\s*\((.*?)\)/.exec(output);
    if (!failedSummaryMatch) {
      if (/ImportError|ModuleNotFoundError|SyntaxError/i.test(output)) {
        return {
          status: 'WRONG_FAILURE',
          failureKind: 'COLLECTION_ERROR',
          failureReason: 'unittest 테스트 임포트 또는 문법 오류가 발생했습니다',
          testCount,
        };
      }
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'RUNTIME_ERROR',
        failureReason: 'unittest 요약 줄을 찾을 수 없습니다',
        testCount,
      };
    }

    const summary = failedSummaryMatch[1];
    const failuresMatch = /failures=(\d+)/.exec(summary);
    const errorsMatch = /errors=(\d+)/.exec(summary);
    const failures = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;
    const errors = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;

    if (errors > 0) {
      const isCollectionError =
        /ImportError: Failed to import test module|ModuleNotFoundError|No module named/i.test(output);
      return {
        status: 'WRONG_FAILURE',
        failureKind: isCollectionError ? 'COLLECTION_ERROR' : 'RUNTIME_ERROR',
        failureReason: isCollectionError
          ? 'unittest 테스트 모듈 임포트 실패 (ImportError)'
          : `unittest 테스트 실행 중 오류(errors=${errors})가 발생했습니다`,
        testCount,
      };
    }

    if (failures > 0 && errors === 0 && testCount >= 1) {
      const frames = parseStackFrames(output);
      let failedLocation: { filePath: string; line: number } | undefined;
      if (frames.length > 0) {
        failedLocation = { filePath: frames[0].filePath, line: frames[0].line };
      }
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: `단언 실패가 확인되었습니다 (failures=${failures})`,
        testCount,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: 'unittest 실패 조건을 만족하지 않습니다',
      testCount,
    };
  }

  function evaluateNodeTestReproduction(
    reportFilePath: string | undefined,
    testResult: { success: boolean; exitCode: number; output: string },
    hostFileContent: string
  ): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'node --test 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    const hasTestFuncs = /\b(?:test|it|describe)\s*\(/m.test(hostFileContent);
    if (!hasTestFuncs) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'node:test 테스트 파일에 테스트 함수(test, it, describe)가 정의되지 않았습니다',
        testCount: 0,
      };
    }

    if (!reportFilePath || !fs.existsSync(reportFilePath)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_REPORT',
        failureReason: 'node:test TAP 리포트 파일이 생성되지 않았습니다',
      };
    }

    const tap = fs.readFileSync(reportFilePath, 'utf8');
    const testsMatch = /# tests\s+(\d+)/m.exec(tap);
    const passMatch = /# pass\s+(\d+)/m.exec(tap);
    const failMatch = /# fail\s+(\d+)/m.exec(tap);
    const cancelledMatch = /# cancelled\s+(\d+)/m.exec(tap);

    const totalTests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
    const cancelledCount = cancelledMatch ? parseInt(cancelledMatch[1], 10) : 0;

    if (testResult.success && failCount === 0 && cancelledCount === 0) {
      return {
        status: 'NOT_REPRODUCED',
        testCount: totalTests,
      };
    }

    if (cancelledCount > 0 || /failureType:\s*'testTimeoutFailure'/i.test(tap)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'TIMEOUT',
        failureReason: 'node:test 실행 시간 초과 (testTimeoutFailure)',
        testCount: totalTests,
      };
    }

    if (
      /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(tap) ||
      /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(output)
    ) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'COLLECTION_ERROR',
        failureReason: 'node:test 모듈 임포트 실패 (ERR_MODULE_NOT_FOUND)',
        testCount: totalTests,
      };
    }

    const allFailureParts = tap.split(/(?:^|\n)\s*not ok \d+ - /m).slice(1);
    if (allFailureParts.length === 0) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'RUNTIME_ERROR',
        failureReason: 'node:test 실패 항목을 파싱할 수 없습니다',
        testCount: totalTests,
      };
    }

    // Filter out parent aggregate failure blocks (e.g. describe suite or parent test with failureType: 'subtestsFailed')
    const failureParts = allFailureParts.filter(
      (part) => !/failureType:\s*['"]?subtestsFailed['"]?/i.test(part)
    );
    const partsToEvaluate = failureParts.length > 0 ? failureParts : allFailureParts;

    let allAssertions = true;
    let nonAssertionReason = '';
    let failedLocation: { filePath: string; line: number } | undefined;

    for (const part of partsToEvaluate) {
      const isAssertion = /code:\s*'ERR_ASSERTION'/i.test(part) || /name:\s*'AssertionError'/i.test(part);
      if (!isAssertion) {
        allAssertions = false;
        const typeErrorMatch = /name:\s*'([^']+)'/.exec(part);
        nonAssertionReason = typeErrorMatch ? typeErrorMatch[1] : '런타임 오류';
        break;
      }
      if (!failedLocation) {
        const locMatch =
          /location:\s*'([^']+)[:/](\d+)[:/]\d+'/i.exec(part) ||
          /stack:[\s\S]*?\((?:file:\/\/\/)?([^:]+):(\d+):\d+\)/i.exec(part);
        if (locMatch) {
          failedLocation = { filePath: locMatch[1].replace(/\\\\/g, '\\'), line: parseInt(locMatch[2], 10) };
        }
      }
    }

    if (allAssertions && failCount > 0 && totalTests >= 1) {
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: '단언 실패가 확인되었습니다 (AssertionError)',
        testCount: totalTests,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: `node:test 실행 중 런타임 오류가 발생했습니다 (${nonAssertionReason || '런타임 예외'})`,
      testCount: totalTests,
    };
  }

  function evaluateUnsupportedReproduction(
    effectiveCommand: string,
    testResult: { success: boolean; exitCode: number; output: string }
  ): EvaluationOutput {
    if (testResult.success) {
      return {
        status: 'NOT_REPRODUCED',
      };
    }
    const isCommandMissing =
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        testResult.output
      );
    if (isCommandMissing) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: '테스트 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }
    const frames = parseStackFrames(testResult.output);
    let failedLocation: { filePath: string; line: number } | undefined;
    if (frames.length > 0) {
      failedLocation = { filePath: frames[0].filePath, line: frames[0].line };
    }
    return {
      status: 'UNVERIFIED_FAILURE',
      failureKind: 'UNKNOWN_RUNNER',
      failureReason: '지원하지 않는 실행기이므로 실패 이유를 판정할 수 없습니다',
      failedLocation,
    };
  }

  /**
   * Returns structured next_action for an incident based on missing intents.
   */