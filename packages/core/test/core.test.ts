import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as url from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, execSync, spawn, ChildProcess } from 'node:child_process';
import { CoreManager } from '../src/core-manager.js';
import { detectUnapprovedFiles } from '../src/core/project.js';
import { buildReproductionCommand } from '../src/core/reproduction.js';
import { Incident } from '../src/types.js';
import { ApiServer } from '../src/server/api-server.js';
import { WorktreeRunner } from '../src/runner/worktree-runner.js';
import { analyzeIncident, parseStackFrames, STACK_TRACE_PATTERNS } from '../src/analysis/analyzer.js';
import { verifyApprovalSignature } from '../src/utils/security.js';
import {
  resolveDataDir,
  resolveCacheDir,
  generateDeterministicProjectId,
  normalizeRepoPath,
} from '../src/utils/paths.js';

describe('Agent Autopsy Core Engine Integration Tests', () => {
  const testRoot = path.resolve(process.cwd(), '.autopsy_test_sandbox');
  const repoPath = path.join(testRoot, 'sample_project');
  const dbPath = path.join(testRoot, 'test_autopsy.db');

  let core: CoreManager;

  before(() => {
    // Clean up prior test runs
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(repoPath, { recursive: true });

    // Initialize git repository
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });

    // Create a sample project with code and a test runner
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify(
        {
          name: 'sample-calculator',
          scripts: {
            test: 'node test.js',
          },
        },
        null,
        2
      )
    );

    fs.writeFileSync(
      path.join(repoPath, 'calculator.js'),
      `function divide(a, b) {\n  return a / b;\n}\nmodule.exports = { divide };\n`
    );

    fs.writeFileSync(
      path.join(repoPath, 'test.js'),
      `const { divide } = require('./calculator.js');\nconst assert = require('assert');\nassert.strictEqual(divide(10, 2), 5);\nassert.strictEqual(divide(10, 0), 0, 'Zero division should yield 0');\nconsole.log('ALL TESTS PASSED');\n`
    );

    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'feat: initial calculator implementation'], {
      cwd: repoPath,
    });

    core = new CoreManager({
      customDbPath: dbPath,
    });
    // User confirms legitimate test command with cryptographic signature
    core.updateProjectSettings(repoPath, { testCommand: 'node test.js' });
  });

  after(async () => {
    await core.shutdown();
    try {
      if (fs.existsSync(testRoot)) {
        fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      }
    } catch {}
  });

  test('1. Checkpoint capture (clean and dirty)', () => {
    // 1. Clean checkpoint
    const cp1 = core.captureCheckpoint(repoPath, 'Baseline 1.0', 'antigravity');
    assert.ok(cp1.id.startsWith('cp_'));
    assert.strictEqual(cp1.label, 'Baseline 1.0');
    assert.strictEqual(cp1.gitStashSha, null);

    // 2. Introduce a dirty change
    fs.appendFileSync(path.join(repoPath, 'calculator.js'), '// dirty note\n');
    const cp2 = core.captureCheckpoint(repoPath, 'Checkpoint with uncommitted changes', 'codex');
    assert.ok(cp2.gitStashSha !== null, 'Stash SHA should be captured for dirty changes');
    assert.ok(cp2.changedFiles.includes('calculator.js'));
  });

  test('2. Inspect project health state', () => {
    const health = core.inspectProjectState(repoPath);
    assert.strictEqual(health.projectName, 'sample_project');
    assert.ok(health.recentCommits.length > 0);
    assert.ok(health.latestCheckpoint !== null);
  });

  test('3. Incident collection on test failure', async () => {
    // The current test.js fails on divide(10, 0) because calculator.js does not handle 0 division!
    const incident = await core.collectIncidentBundle(
      repoPath,
      'Zero division assertion failed in calculator',
      'AssertionError: Zero division should yield 0'
    );

    assert.ok(incident.id.startsWith('inc_'));
    assert.strictEqual(incident.status, 'OPEN');
    assert.ok(incident.errorOutput.includes('Zero division'));
  });

  test('4. Propose and verify repair in isolated worktree', async () => {
    const incidents = core.getDatabase().listIncidents(core.ensureProject(repoPath).id);
    const incident = incidents[0];

    // Propose a fix using Search & Replace
    const { proposal, executionResult } = await core.proposeAndVerifyRepair(
      repoPath,
      incident.id,
      'Add defensive check for zero division in calculator.js',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: '  return a / b;',
              replace: '  if (b === 0) return 0;\n  return a / b;',
            },
          ],
        },
      ]
    );

    // Verify proposal object
    assert.ok(proposal.id.startsWith('prop_'));
    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    assert.strictEqual(proposal.approvalStatus, 'AWAITING_USER');
    assert.ok(proposal.patchDiff.includes('if (b === 0) return 0;'));

    // Critical check: Did the test pass in the isolated worktree?
    assert.strictEqual(executionResult.success, true);
    assert.ok(executionResult.output.includes('ALL TESTS PASSED'));

    // Verify isolation: Original workspace calculator.js MUST NOT have been modified!
    const currentContent = fs.readFileSync(path.join(repoPath, 'calculator.js'), 'utf8');
    assert.ok(
      !currentContent.includes('if (b === 0) return 0;'),
      'Original workspace must remain untouched during isolated verification!'
    );
  });

  test('5. Hard Security Gate: applying unapproved repair must throw error', () => {
    const incidents = core.getDatabase().listIncidents(core.ensureProject(repoPath).id);
    const proposals = core.getDatabase().listProposalsForIncident(incidents[0].id);
    const proposal = proposals[0];

    // Attempting to apply directly without approval MUST throw
    assert.throws(
      () => {
        core.applyApprovedRepair(repoPath, proposal.id);
      },
      /SECURITY GATE VIOLATION/,
      'Must reject applyApprovedRepair when proposal is not yet approved by user'
    );
  });

  test('6. User approval and clean patch application', () => {
    const incidents = core.getDatabase().listIncidents(core.ensureProject(repoPath).id);
    const proposals = core.getDatabase().listProposalsForIncident(incidents[0].id);
    const proposal = proposals[0];

    // Simulate user clicking [Approve] in Desktop UI
    core.approveProposal(proposal.id);

    // Now application must succeed!
    const result = core.applyApprovedRepair(repoPath, proposal.id);
    assert.strictEqual(result.applied, true);

    // Verify that the code in repoPath now contains the fix!
    const updatedContent = fs.readFileSync(path.join(repoPath, 'calculator.js'), 'utf8');
    assert.ok(updatedContent.includes('if (b === 0) return 0;'));

    // Verify incident status updated to RESOLVED
    const updatedIncident = core.getDatabase().getIncident(incidents[0].id);
    assert.strictEqual(updatedIncident?.status, 'RESOLVED');
  });

  test('7. Rollback to baseline checkpoint restores exact state', () => {
    // Get the initial baseline checkpoint
    const project = core.ensureProject(repoPath);
    const checkpoints = core.getDatabase().listCheckpoints(project.id);
    const baseline = checkpoints[checkpoints.length - 1]; // oldest checkpoint

    // Rollback to baseline
    const rollbackResult = core.rollbackToCheckpoint(repoPath, baseline.id);
    assert.strictEqual(rollbackResult.restored, true);

    // Verify that calculator.js is back to the clean baseline without the fix
    const restoredContent = fs.readFileSync(path.join(repoPath, 'calculator.js'), 'utf8');
    assert.ok(!restoredContent.includes('if (b === 0) return 0;'));
  });

  test('8. Risk-Adaptive Evidence Gate & Orchestration Decision', () => {
    const project = core.ensureProject(repoPath);

    // 1. Simple low-risk check (no sensitive paths, low lines)
    core.updateProjectSettings(repoPath, { sensitivePaths: [], verificationMode: 'AUTO' });
    const lowProject = core.ensureProject(repoPath);
    const lowDecision = core.evaluateOrchestrationDecision(
      lowProject,
      '오타 수정',
      '',
      'diff',
      ['calculator.js'],
      'CONFIRMED'
    );
    assert.strictEqual(lowDecision.riskLevel, 'LOW');
    assert.strictEqual(lowDecision.requiresOrchestration, false);

    // 2. High-risk user-designated sensitive path
    core.updateProjectSettings(repoPath, { sensitivePaths: ['src/shop/**'] });
    const sensProject = core.ensureProject(repoPath);
    const highDecision = core.evaluateOrchestrationDecision(
      sensProject,
      'VIP 할인 쿠폰 결제 검증 로직 수정',
      'AssertionError: discount overflow',
      'diff',
      ['src/shop/discount.js', 'src/shop/payment.js'],
      'UNKNOWN'
    );
    assert.strictEqual(highDecision.riskLevel, 'HIGH');
    assert.strictEqual(highDecision.requiresOrchestration, true);
    assert.ok(highDecision.riskSignals.some((s) => s.includes('민감 경로')));

    // 3. MAIN_ONLY mode honors user preference while preserving risk warnings
    core.updateProjectSettings(repoPath, { verificationMode: 'MAIN_ONLY', sensitivePaths: ['payment.js'] });
    const mainOnlyProject = core.ensureProject(repoPath);
    const mainOnlyDecision = core.evaluateOrchestrationDecision(
      mainOnlyProject,
      '결제 로직 수정',
      'error',
      'diff',
      ['payment.js'],
      'UNKNOWN'
    );
    assert.strictEqual(mainOnlyDecision.requiresOrchestration, false);
    assert.strictEqual(mainOnlyDecision.riskLevel, 'HIGH');
  });

  test('9. Independent Orchestration Review & Hard Gate Enforcement', async () => {
    // Reset back to AUTO mode with sensitive path designated
    core.updateProjectSettings(repoPath, { verificationMode: 'AUTO', sensitivePaths: ['calculator.js'] });

    // Create an incident
    const highRiskIncident = await core.collectIncidentBundle(
      repoPath,
      '결제 및 할인 쿠폰 취소 롤백 실패',
      'AssertionError: discount balance mismatch'
    );

    // Propose a repair touching sensitive path (calculator.js)
    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      highRiskIncident.id,
      '할인 롤백 방어 로직 추가',
      [
        {
          filePath: 'calculator.js',
          replacements: [{ search: 'return a / b;', replace: 'if (b === 0) return 0; return a / b;' }],
        },
      ]
    );

    // High risk proposal touching sensitive path should be HIGH risk and BLOCKED_AWAITING_REVIEW
    assert.strictEqual(proposal.riskLevel, 'HIGH');
    assert.strictEqual(proposal.approvalReadiness, 'BLOCKED_AWAITING_REVIEW');

    // Standard approval must be blocked without explicit force acknowledgement
    assert.throws(
      () => {
        core.approveProposal(proposal.id, undefined, false);
      },
      /RISK_GATE_VIOLATION/,
      'High risk proposal must not be approved without review or force acknowledgement'
    );

    // Main AI proxy review (without subagent transcript) yields COMPLETED_UNVERIFIED
    const proxyReviewResult = core.submitOrchestrationReview(repoPath, {
      proposalId: proposal.id,
      reviewer: 'Main AI Proxy',
      findings: ['코드 정적 검토 완료'],
      submittedByRole: 'MAIN_AGENT_PROXY',
    });
    assert.strictEqual(proxyReviewResult.review.status, 'COMPLETED_UNVERIFIED');
    assert.strictEqual(proxyReviewResult.proposal.approvalReadiness, 'APPROVABLE_WITH_RISK_WARNING');

    // Spoofing attempt: Claiming SUBAGENT_DIRECT without physical transcript MUST be downgraded to COMPLETED_UNVERIFIED!
    const fakeSubagentResult = core.submitOrchestrationReview(repoPath, {
      proposalId: proposal.id,
      reviewer: 'Spoofed subagent',
      findings: ['가짜 서브에이전트 검토 시도'],
      submittedByRole: 'SUBAGENT_DIRECT',
    });
    assert.strictEqual(
      fakeSubagentResult.review.status,
      'COMPLETED_UNVERIFIED',
      'Must reject fake SUBAGENT_DIRECT without physical host transcript as unverified'
    );

    // Genuine subagent review with verifiable physical host transcript
    const fakeTranscriptPath = path.join(testRoot, 'subagent_transcript.log');
    fs.writeFileSync(
      fakeTranscriptPath,
      JSON.stringify({ action: 'invoke_subagent', role: 'Reviewer', proposalId: proposal.id, patchHash: proposal.patchHash })
    );

    const verifiedReviewResult = core.submitOrchestrationReview(repoPath, {
      proposalId: proposal.id,
      reviewer: 'Gemini 2.5 Pro subagent',
      findings: ['경계값 0 나눗셈 및 롤백 무결성 확인 완료'],
      transcriptPath: fakeTranscriptPath,
      submittedByRole: 'SUBAGENT_DIRECT',
    });
    assert.strictEqual(verifiedReviewResult.review.status, 'COMPLETED_VERIFIED');
    assert.strictEqual(verifiedReviewResult.proposal.approvalReadiness, 'READY_FOR_APPROVAL');

    // Now normal approval succeeds without force override!
    const fingerprint = core.approveProposal(proposal.id);
    assert.ok(fingerprint.patchHash);

    // Reset sensitivePaths so subsequent tests are not affected
    core.updateProjectSettings(repoPath, { sensitivePaths: [] });
  });

  test('10. Non-destructive safety quarantine on unexpected working tree changes', async () => {
    // 1. Create an active incident
    const inc = await core.collectIncidentBundle(
      repoPath,
      '활성 사건 테스트',
      'AssertionError: active test'
    );

    // 2. Introduce an unapproved dirty change and untracked file directly to working tree
    fs.appendFileSync(path.join(repoPath, 'calculator.js'), '// direct unapproved modification\n');
    fs.writeFileSync(path.join(repoPath, 'unapproved_new_file.txt'), 'precious user work');

    // 3. Inspect project state should detect unapproved changes and create a quarantine backup
    const health = core.inspectProjectState(repoPath);
    assert.strictEqual(health.unapprovedModificationsDetected, true);
    assert.ok(health.quarantineBackupRef, 'Quarantine backup ref must be created');
    assert.ok(health.quarantineBackupRef.startsWith('refs/autopsy/checkpoints/quarantine_'));

    // 4. Critical check: user files MUST NOT be wiped out or destroyed!
    assert.ok(fs.existsSync(path.join(repoPath, 'unapproved_new_file.txt')), 'Untracked files must not be deleted');
    const content = fs.readFileSync(path.join(repoPath, 'calculator.js'), 'utf8');
    assert.ok(content.includes('direct unapproved modification'), 'Direct user work must be preserved in place');

    // Clean up test 10 unapproved files so subsequent tests start with clean baseline
    if (fs.existsSync(path.join(repoPath, 'unapproved_new_file.txt'))) {
      fs.unlinkSync(path.join(repoPath, 'unapproved_new_file.txt'));
    }
    execFileSync('git', ['checkout', 'HEAD', '--', 'calculator.js'], { cwd: repoPath, stdio: 'ignore' });
  });

  test('11. DirectiveQueue live delivery on active awaitUserDecision (DELIVERED_LIVE)', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '지시서 실시간 전달 테스트', 'AssertionError: test');
    const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, '기본 수정안', [
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a / b;', replace: 'if (b === 0) return 0; return a / b;' }],
      },
    ]);

    // Agent starts awaiting user decision
    const awaitPromise = core.awaitUserDecision(repoPath, proposal.id, 10);

    // Dashboard user creates a REJECT_WITH_FEEDBACK directive
    const directive = core.createDirective(repoPath, {
      incidentId: inc.id,
      proposalId: proposal.id,
      patchHash: proposal.patchHash,
      kind: 'REJECT_WITH_FEEDBACK',
      feedbackText: '원래 함수 시그니처를 유지하고 0 나누기 예외 처리를 먼저 수행하세요.',
    });

    const result = await awaitPromise;

    // Must resolve immediately with DELIVERED_LIVE
    assert.strictEqual(result.status, 'DIRECTIVE_DELIVERED');
    assert.ok(result.directive);
    assert.strictEqual(result.directive.id, directive.id);
    assert.strictEqual(result.directive.deliveryStatus, 'DELIVERED_LIVE');
    assert.ok(result.directive.deliveredAt);
    assert.strictEqual(result.directive.kind, 'REJECT_WITH_FEEDBACK');

    // Proposal should be marked REJECTED
    const updatedProp = core.getDatabase().getRepairProposal(proposal.id);
    assert.strictEqual(updatedProp?.approvalStatus, 'REJECTED');
  });

  test('12. DirectiveQueue timeout safety and persistent queue delivery (DELIVERED_ON_NEXT_CALL & ACKNOWLEDGED)', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '타임아웃 및 큐 폴백 테스트', 'AssertionError: test');
    const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, '임시 제안', [
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a / b;', replace: 'if (b === 0) return 0; return a / b;' }],
      },
    ]);

    // 1. awaitUserDecision timeout test with minimum bounded window (5s)
    const timeoutResult = await core.awaitUserDecision(repoPath, proposal.id, 5);
    assert.strictEqual(timeoutResult.status, 'WAIT_TIMEOUT');
    assert.ok(timeoutResult.message?.includes('대기 시간'));

    // 2. User creates directive when agent is not actively waiting
    const directive = core.createDirective(repoPath, {
      incidentId: inc.id,
      proposalId: proposal.id,
      patchHash: proposal.patchHash,
      kind: 'REQUEST_DEEP_REVIEW',
      feedbackText: '고위험 결제 로직에 대해 서브에이전트 독립 검토를 요청합니다.',
    });
    assert.strictEqual(directive.deliveryStatus, 'WAITING_AGENT');
    assert.ok(directive.manualPromptSnippet?.includes('서브에이전트 심층 검토를 요청했습니다'));

    // 3. Agent polls pending directives on next call -> status becomes DELIVERED_ON_NEXT_CALL
    const pending = core.getPendingDirectives(repoPath, 'antigravity');
    const deliveredDir = pending.find((d) => d.id === directive.id);
    assert.ok(deliveredDir);
    assert.strictEqual(deliveredDir.deliveryStatus, 'DELIVERED_ON_NEXT_CALL');
    assert.ok(deliveredDir.deliveredAt);

    // 4. Agent acknowledges receipt of directive
    const acked = core.acknowledgeDirective(directive.id, 'antigravity');
    assert.strictEqual(acked.deliveryStatus, 'ACKNOWLEDGED');
    assert.ok(acked.acknowledgedAt);

    // DB state must be updated
    const dbDir = core.getDatabase().getDirective(directive.id);
    assert.strictEqual(dbDir?.deliveryStatus, 'ACKNOWLEDGED');
  });

  test('13. User 4-intent confirmation gate updates incident intent and userConfirmedIntent', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '의도 확정 테스트', 'AssertionError: intent mismatch');
    assert.strictEqual(inc.userConfirmedIntent, false);

    // Confirm 4 intents via createDirective
    const directive = core.createDirective(repoPath, {
      incidentId: inc.id,
      kind: 'CONFIRM_INTENT',
      confirmedIntent: {
        expectedBehavior: '30.4 달러 결제 영수증 반환 및 주문 상태 COMPLETED',
        observedBehavior: '30.8 달러로 계산되어 Assertion 실패',
        reproductionCondition: 'node test.js 실행 (할인 0.2, 세금 0.1)',
        verificationMethod: '테스트 실행 후 30.4 달러 단정 검사',
      },
    });

    assert.strictEqual(directive.kind, 'CONFIRM_INTENT');
    const updatedInc = core.getDatabase().getIncident(inc.id);
    assert.ok(updatedInc);
    assert.strictEqual(updatedInc.userConfirmedIntent, true);
    assert.strictEqual(updatedInc.expectedBehavior, '30.4 달러 결제 영수증 반환 및 주문 상태 COMPLETED');
    assert.strictEqual(updatedInc.observedBehavior, '30.8 달러로 계산되어 Assertion 실패');
    assert.strictEqual(updatedInc.reproductionCondition, 'node test.js 실행 (할인 0.2, 세금 0.1)');
    assert.strictEqual(updatedInc.verificationMethod, '테스트 실행 후 30.4 달러 단정 검사');
  });

  test('14. 3-Track Causal Analyzer discovers dependency candidates on clean Git state without diff', () => {
    const cleanRepoPath = path.join(testRoot, 'clean_sample_repo');
    fs.mkdirSync(path.join(cleanRepoPath, 'src', 'game'), { recursive: true });
    fs.mkdirSync(path.join(cleanRepoPath, 'src', 'shop'), { recursive: true });
    fs.mkdirSync(path.join(cleanRepoPath, 'test'), { recursive: true });

    fs.writeFileSync(
      path.join(cleanRepoPath, 'test', 'runner.test.js'),
      `import { AutoHunter } from '../src/game/auto-hunter.js';\nimport { Inventory } from '../src/shop/inventory.js';\n// test code`
    );
    fs.writeFileSync(
      path.join(cleanRepoPath, 'src', 'game', 'auto-hunter.js'),
      `import { Inventory } from '../shop/inventory.js';\nexport class AutoHunter { loot() { return Inventory.add(); } }`
    );
    fs.writeFileSync(
      path.join(cleanRepoPath, 'src', 'shop', 'inventory.js'),
      `export class Inventory { static add() { return 30.8; } }`
    );

    // Call analyzeIncident with empty diff (Clean repo state)
    const errOutput = `AssertionError: 30.8 !== 30.4\n    at TestContext.<anonymous> (${path.join(cleanRepoPath, 'test', 'runner.test.js')}:10:5)`;
    const result = analyzeIncident(errOutput, '', cleanRepoPath, 'clean_sample_repo');

    // 1. Must discover candidates despite empty diff
    assert.ok(result.candidates.length >= 2, 'Must discover candidates via static dependency crawling');
    const candPaths = result.candidates.map((c: any) => c.filePath.replace(/\\/g, '/'));
    assert.ok(candPaths.some((p: string) => p.includes('auto-hunter.js')), 'Must include auto-hunter.js');
    assert.ok(candPaths.some((p: string) => p.includes('inventory.js')), 'Must include inventory.js');

    // 2. File structure nodes must group into directories
    const fileNodes = result.flowData.fileNodes || [];
    const dirNodes = fileNodes.filter((n: any) => n.type === 'dir');
    const dirLabels = dirNodes.map((n: any) => n.label);
    assert.ok(dirLabels.some((d: string) => d.includes('src/game') || d.includes('game')), 'Must contain game directory');
    assert.ok(dirLabels.some((d: string) => d.includes('src/shop') || d.includes('shop')), 'Must contain shop directory');
  });

  test('15. Strict separation of OBSERVED (solid) vs INFERRED (dashed) evidence without fake CONFIRMED', () => {
    const cleanRepoPath = path.join(testRoot, 'clean_sample_repo');
    const errOutput = `AssertionError: 30.8 !== 30.4\n    at TestContext.<anonymous> (${path.join(cleanRepoPath, 'test', 'runner.test.js')}:10:5)`;
    const result = analyzeIncident(errOutput, '', cleanRepoPath, 'clean_sample_repo');

    // 1. Static inferred candidate must NOT fake CONFIRMED verdict
    for (const cand of result.candidates) {
      assert.notStrictEqual(cand.causeVerdict, 'CONFIRMED', 'Statically inferred candidate must not be labeled CONFIRMED');
      assert.ok(cand.evidenceStrength === 'MEDIUM' || cand.evidenceStrength === 'LOW', 'Strength must be MEDIUM or LOW');
    }

    // 2. Static dependency edges must be dashed with isObserved: false
    const fileEdges = result.flowData.fileEdges || [];
    const dashedEdges = fileEdges.filter((e: any) => e.style === 'dashed');
    assert.ok(dashedEdges.length > 0, 'Must have dashed edges for static inferences');
    for (const edge of dashedEdges) {
      assert.strictEqual(edge.isObserved, false, 'Dashed edge must have isObserved: false');
      assert.ok(edge.label?.includes('INFERRED') || edge.label?.includes('추정'), 'Label must indicate INFERRED');
    }

    // 3. Runtime observed failure edges must be solid with isObserved: true
    const solidFailureEdges = fileEdges.filter((e: any) => e.style === 'solid' && e.color === 'red');
    for (const edge of solidFailureEdges) {
      assert.strictEqual(edge.isObserved, true, 'Observed failure edge must have isObserved: true');
    }
  });

  test('16. Process-Tree Kill: timeout terminates infinite loop without lingering orphans', async () => {
    const runner = core.getWorktreeRunner();
    const startTime = Date.now();
    // Run an intentional infinite loop with short timeout (1500ms)
    const result = await runner.runCommand(repoPath, 'node -e "setInterval(()=>{}, 1000)"', 1500);
    const duration = Date.now() - startTime;

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.exitCode, 124);
    assert.ok(result.output.includes('시간이 초과되었습니다'));
    assert.ok(result.output.includes('하위 프로세스 트리를 강제 종료'));
    assert.ok(duration >= 1400 && duration < 6000, `Duration was ${duration}ms, expected ~1500ms`);
  });

  test('17. Secret Masking: sensitive tokens redacted while normal data preserved', async () => {
    const runner = core.getWorktreeRunner();
    const command = 'node -e "console.log([\'TOKEN_BEARER: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\', \'GITHUB_PAT: ghp_123456789012345678901234567890123456\', \'GOOGLE_API: AIzaSyD12345678901234567890123456789012\', \'CONFIG: password=super_secret_db_pass_1234\', \'COMMIT_SHA: 6d557febf482dd87307177cacef350dba9c1353c\'].join(\'\\n\'))"';
    const result = await runner.runCommand(repoPath, command, 10000);

    assert.strictEqual(result.success, true);
    // Secrets must be masked
    assert.ok(result.output.includes('TOKEN_BEARER: Bearer [REDACTED_SECRET]'));
    assert.ok(result.output.includes('GITHUB_PAT: [REDACTED_SECRET]'));
    assert.ok(result.output.includes('GOOGLE_API: [REDACTED_SECRET]'));
    assert.ok(result.output.includes('CONFIG: password=[REDACTED_SECRET]'));
    assert.ok(!result.output.includes('ghp_1234567890'));
    assert.ok(!result.output.includes('AIzaSyD1234'));
    assert.ok(!result.output.includes('super_secret_db_pass_1234'));

    // Non-secret commit SHA must NOT be redacted
    assert.ok(result.output.includes('6d557febf482dd87307177cacef350dba9c1353c'));
  });

  test('18. 3-Stage validation pipeline: Stage 1 Syntax abort, Stage 2 Target, Stage 3 Full Regression', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '3단계 파이프라인 테스트', 'AssertionError: test');

    // 1. Propose syntax error (should fail at Stage 1 CODE_CHECK and skip Stages 2 & 3)
    const syntaxFailResult = await core.proposeAndVerifyRepair(repoPath, inc.id, '문법 오류 수정안', [
      {
        filePath: 'calculator.js',
        newContent: 'function calculate() { return 1 + ; }', // invalid syntax
      },
    ]);

    assert.strictEqual(syntaxFailResult.proposal.verificationStatus, 'VERIFIED_FAIL');
    assert.ok(syntaxFailResult.executionResult.stages);
    assert.strictEqual(syntaxFailResult.executionResult.stages[0].stage, 'CODE_CHECK');
    assert.strictEqual(syntaxFailResult.executionResult.stages[0].status, 'FAIL');
    assert.strictEqual(syntaxFailResult.executionResult.stages[1].status, 'SKIPPED');
    assert.strictEqual(syntaxFailResult.executionResult.stages[2].status, 'SKIPPED');
    assert.strictEqual(syntaxFailResult.executionResult.threeLevelHealth.code, 'FAIL');
    assert.strictEqual(syntaxFailResult.executionResult.threeLevelHealth.functional, 'UNKNOWN');
    assert.strictEqual(syntaxFailResult.executionResult.threeLevelHealth.requirement, 'UNKNOWN');

    // 2. Propose correct fix (should pass all 3 stages)
    const validResult = await core.proposeAndVerifyRepair(repoPath, inc.id, '올바른 방어 로직', [
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  if (b === 0) return 0;\n  return a / b;',
          },
        ],
      },
    ]);

    assert.strictEqual(validResult.proposal.verificationStatus, 'VERIFIED_PASS');
    assert.strictEqual(validResult.executionResult.stages[0].status, 'PASS');
    assert.strictEqual(validResult.executionResult.stages[1].status, 'PASS');
    assert.strictEqual(validResult.executionResult.stages[2].status, 'PASS');
    assert.strictEqual(validResult.executionResult.threeLevelHealth.code, 'PASS');
    assert.strictEqual(validResult.executionResult.threeLevelHealth.functional, 'PASS');
    assert.strictEqual(validResult.executionResult.threeLevelHealth.requirement, 'PASS');
  });

  test('19. Safe test commands discovery detects project type and flags dangerous scripts', () => {
    // 1. Check clean repo
    const discovered = core.discoverSafeTestCommands(repoPath);
    assert.strictEqual(discovered.projectType, 'node');
    assert.strictEqual(discovered.isCommandSafe, true);
    assert.ok(discovered.fullRegressionCmd?.includes('test'));

    // 2. Check dangerous script detection
    const dangerousDir = path.join(testRoot, 'dangerous_sample_repo');
    fs.mkdirSync(dangerousDir, { recursive: true });
    fs.writeFileSync(
      path.join(dangerousDir, 'package.json'),
      JSON.stringify({
        name: 'dangerous-app',
        scripts: {
          test: 'node test.js',
          nuke: 'rm -rf / --no-preserve-root',
        },
      })
    );

    const dangerousDiscovered = core.discoverSafeTestCommands(dangerousDir);
    assert.strictEqual(dangerousDiscovered.isCommandSafe, false);
    assert.ok(dangerousDiscovered.warnings && dangerousDiscovered.warnings.length > 0);
    assert.ok(dangerousDiscovered.warnings[0].includes('nuke'));
  });

  test('20. Project Self-Diagnostics detects environment health, missing AGENTS.md and sandbox permissions', () => {
    const diag = core.diagnoseProject(repoPath);

    assert.strictEqual(diag.hasAgentsMd, false, 'AGENTS.md should initially be missing');
    assert.strictEqual(diag.hasAutopsyIgnore, false, '.gitignore should initially lack .autopsy');
    assert.ok(diag.items.some((i) => i.key === 'git_repo' && i.status === 'PASS'));
    assert.ok(diag.items.some((i) => i.key === 'agents_sop' && i.status === 'WARN'));
    assert.ok(diag.items.some((i) => i.key === 'sandbox_permissions' && i.status === 'PASS'));
    assert.ok(diag.items.some((i) => i.key === 'test_commands' && i.status === 'PASS'));
  });

  test('21. 1-Click Onboarding deploys standard AGENTS.md, updates .gitignore, and passes subsequent diagnosis', () => {
    // Run 1-click onboarding
    const onboardResult = core.onboardProject(repoPath);
    assert.strictEqual(onboardResult.success, true);
    assert.strictEqual(onboardResult.agentsMdCreated, true);
    assert.strictEqual(onboardResult.gitignoreUpdated, true);

    // Verify files on disk
    const agentsMd = fs.readFileSync(path.join(repoPath, 'AGENTS.md'), 'utf8');
    assert.ok(agentsMd.includes('Agent Autopsy: AI Coding Agent Operating Rules (SOP)'));
    assert.ok(agentsMd.includes('capture_checkpoint'));
    assert.ok(agentsMd.includes('propose_and_verify_repair'));

    const gitignore = fs.readFileSync(path.join(repoPath, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.autopsy'));

    // Re-run diagnostics: AGENTS.md and gitignore must now be PASS!
    const reDiag = core.diagnoseProject(repoPath);
    assert.strictEqual(reDiag.hasAgentsMd, true);
    assert.strictEqual(reDiag.hasAutopsyIgnore, true);
    assert.strictEqual(reDiag.healthy, true);
    assert.ok(reDiag.items.every((i) => i.status === 'PASS'));
  });

  test('22. Phase 1: resolveDataDir unification and dynamic port reading from runtime.json', () => {
    const dataDir = resolveDataDir();
    assert.ok(typeof dataDir === 'string' && dataDir.length > 0);
    assert.ok(dataDir.includes('AgentAutopsy') || Boolean(process.env.AUTOPSY_DATA_DIR));

    const cacheDir = resolveCacheDir();
    assert.ok(typeof cacheDir === 'string' && cacheDir.length > 0);
    assert.ok(cacheDir.includes('cache') || Boolean(process.env.AUTOPSY_CACHE_DIR));

    // Dynamic port reading test
    const customDataDir = path.join(testRoot, 'custom_runtime_test');
    fs.mkdirSync(customDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(customDataDir, 'runtime.json'),
      JSON.stringify({ port: 3899, service: 'agent-autopsy' })
    );

    const oldEnv = process.env.AUTOPSY_DATA_DIR;
    try {
      process.env.AUTOPSY_DATA_DIR = customDataDir;
      const testCore = new CoreManager({ customDbPath: path.join(customDataDir, 'test.db') });
      const dynamicPort = testCore.getActivePort();
      assert.strictEqual(dynamicPort, 3899, 'Must read dynamic port 3899 from runtime.json');
    } finally {
      if (oldEnv !== undefined) {
        process.env.AUTOPSY_DATA_DIR = oldEnv;
      } else {
        delete process.env.AUTOPSY_DATA_DIR;
      }
    }
  });

  test('23. Phase 2: Deterministic path-based Project ID and automatic legacy migration', () => {
    // 1. Same repoPath with different slashes / casing must produce the exact same project ID
    const pathA = repoPath;
    const pathB = repoPath.replace(/\\/g, '/');
    const idA = generateDeterministicProjectId(pathA);
    const idB = generateDeterministicProjectId(pathB);
    assert.strictEqual(idA, idB, 'Deterministic project ID must match regardless of slash formatting');
    assert.ok(idA.startsWith('prj_'));
    assert.strictEqual(idA.length, 16); // prj_ + 12 chars

    // 2. ensureProject must return this exact deterministic ID
    const project = core.ensureProject(repoPath);
    assert.strictEqual(project.id, idA, 'ensureProject must return deterministic Project ID');

    // 3. Legacy project migration verification:
    // Insert a dummy legacy project with a random ID for another path
    const legacyRepo = path.join(testRoot, 'legacy_migration_repo');
    fs.mkdirSync(legacyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: legacyRepo });

    const legacyId = 'prj_legacy_random_123';
    const canonicalId = generateDeterministicProjectId(legacyRepo);
    assert.notStrictEqual(legacyId, canonicalId);

    const db = core.getDatabase();
    // Insert legacy record
    db.runInImmediateTransaction(() => {
      (db as any).db.prepare(`
        INSERT INTO projects (id, name, root_path, created_at)
        VALUES (?, 'legacy', ?, datetime('now'))
      `).run(legacyId, legacyRepo);

      // Add a checkpoint referencing legacyId
      (db as any).db.prepare(`
        INSERT INTO checkpoints (id, project_id, agent_name, label, git_head_sha, changed_files_json, created_at)
        VALUES ('cp_legacy_1', ?, 'agent', 'legacy cp', 'dummy', '[]', datetime('now'))
      `).run(legacyId);
    });

    // Run migration
    db.migrateDeterministicProjectIds();

    // Verify project ID was migrated to canonicalId
    const migratedProject = db.getProject(canonicalId);
    assert.ok(migratedProject, 'Project must now be queryable by canonical deterministic ID');
    assert.strictEqual(migratedProject.id, canonicalId);

    // Verify foreign key in checkpoints was migrated
    const cp = db.getCheckpoint('cp_legacy_1');
    assert.ok(cp, 'Checkpoint must still exist');
    assert.strictEqual(cp.projectId, canonicalId, 'Checkpoint project_id must have migrated to canonicalId');

    // Verify ensureProject for legacyRepo resolves directly to canonicalId
    const ensuredLegacy = core.ensureProject(legacyRepo);
    assert.strictEqual(ensuredLegacy.id, canonicalId);
  });

  test('24. Phase 3: Hardened Approval Gate - Session Token Authentication & Signature Pinning', async () => {
    const apiServer = new ApiServer(core);
    const port = await apiServer.start(3870);
    const token = apiServer.getSessionToken();
    assert.ok(token && token.length >= 32, 'Session token must be non-empty and cryptographically secure');

    // Create an incident and proposal
    const inc = await core.collectIncidentBundle(repoPath, '승인 게이트 인증 테스트', 'AssertionError: gate');
    const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, 'fix division', [
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  if (b === 0) return 0;\n  return a / b;',
          },
        ],
      },
    ]);

    const makeRequest = (pathStr: string, method: string, headers: Record<string, string>, body?: any): Promise<{ status: number; body: any }> => {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: pathStr,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
              ...headers,
            },
          },
          (res) => {
            let resBody = '';
            res.on('data', (c) => (resBody += c));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode || 500, body: JSON.parse(resBody) });
              } catch {
                resolve({ status: res.statusCode || 500, body: resBody });
              }
            });
          }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    };

    // 1. Call approve WITHOUT token -> Must be 401 Unauthorized
    const unauthRes = await makeRequest(`/api/proposals/${proposal.id}/approve`, 'POST', {}, {});
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated approve must return HTTP 401');

    // 2. Call approve with invalid token -> Must be 401 Unauthorized
    const invalidRes = await makeRequest(`/api/proposals/${proposal.id}/approve`, 'POST', { 'X-Autopsy-Token': 'bogus-token' }, {});
    assert.strictEqual(invalidRes.status, 401, 'Approve with invalid token must return HTTP 401');

    // 3. Call approve with VALID token -> Must be 200 OK
    const validRes = await makeRequest(`/api/proposals/${proposal.id}/approve`, 'POST', { 'X-Autopsy-Token': token }, {});
    assert.strictEqual(validRes.status, 200, 'Approve with valid session token must succeed (200 OK)');
    assert.ok(validRes.body.fingerprint, 'Response must include approval fingerprint');
    assert.ok(validRes.body.fingerprint.signature, 'Approval fingerprint must contain cryptographic signature');

    // 4. Verify signature validity
    const fp = validRes.body.fingerprint;
    const isValid = verifyApprovalSignature(proposal.id, fp.patchHash, fp.baseHeadSha, fp.signature);
    assert.strictEqual(isValid, true, 'Fingerprint signature must be verifiable by installation secret');

    await apiServer.stop();
  });

  test('25. Phase 3: Tamper Detection - Direct DB Bypass is Rejected & Marked TAMPERED', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '변조 탐지 테스트', 'AssertionError: test');
    const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, 'fix division', [
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  if (b === 0) return 0;\n  return a / b;',
          },
        ],
      },
    ]);

    const db = core.getDatabase();
    // Direct SQLite manipulation by a rogue agent to bypass user approval
    (db as any).db.prepare(`
      UPDATE repair_proposals
      SET approval_status = 'APPROVED', approval_fingerprint_json = NULL
      WHERE id = ?
    `).run(proposal.id);

    // Attempt to apply repair - MUST fail and trigger tamper detection
    assert.throws(
      () => {
        core.applyApprovedRepair(repoPath, proposal.id);
      },
      (err: any) => {
        return err.message.includes('[SECURITY_TAMPER_DETECTED]');
      },
      'Applying repair with null fingerprint must throw SECURITY_TAMPER_DETECTED'
    );

    // Verify DB state set to TAMPERED
    const updated = db.getRepairProposal(proposal.id);
    assert.strictEqual(updated?.approvalStatus, 'TAMPERED', 'Proposal status must be marked as TAMPERED');

    // Verify tamper event logged in agent_events
    const events = db.listAgentEvents(core.ensureProject(repoPath).id);
    const tamperEv = events.find((e) => e.title.includes('승인 게이트 변조 감지'));
    assert.ok(tamperEv, 'Tamper incident must be recorded in agent events timeline');
  });

  test('26. Phase 3: Patch Drift Detection - fileChangesJson Modification is Blocked', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '패치 드리프트 테스트', 'AssertionError: drift');
    const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, 'fix division', [
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  if (b === 0) return 0;\n  return a / b;',
          },
        ],
      },
    ]);

    // Legally approve the proposal
    core.approveProposal(proposal.id);

    // Rogue attacker modifies the actual applied code in file_changes_json in DB after approval
    const db = core.getDatabase();
    const maliciousChanges = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  // BACKDOOR INJECTED\n  return 9999;',
          },
        ],
      },
    ]);
    (db as any).db.prepare(`
      UPDATE repair_proposals
      SET file_changes_json = ?
      WHERE id = ?
    `).run(maliciousChanges, proposal.id);

    // Attempt to apply repair - MUST detect drift and reject
    assert.throws(
      () => {
        core.applyApprovedRepair(repoPath, proposal.id);
      },
      (err: any) => {
        return err.message.includes('[SECURITY_TAMPER_DETECTED]');
      },
      'Applying repair after fileChangesJson drift must throw SECURITY_TAMPER_DETECTED'
    );

    const updated = db.getRepairProposal(proposal.id);
    assert.strictEqual(updated?.approvalStatus, 'TAMPERED', 'Proposal status must be marked as TAMPERED upon drift');
  });

  test('27. Phase 4: Multi-Process Real MCP & Server Integration Test', async () => {
    const monorepoRoot = fs.existsSync(path.resolve(process.cwd(), 'packages/mcp-server'))
      ? process.cwd()
      : path.resolve(process.cwd(), '../..');
    const mcpDistScript = path.resolve(monorepoRoot, 'packages/mcp-server/dist/index.js');
    const srvDistScript = path.resolve(monorepoRoot, 'packages/core/dist/src/bin/server-cli.js');

    // Helper: Execute tool call on actual MCP server subprocess over stdio
    const callMcp = (env: NodeJS.ProcessEnv, toolName: string, args: any): Promise<{ text: string; isError?: boolean }> => {
      return new Promise((resolve, reject) => {
        const cp = spawn('node', [mcpDistScript], {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let hasInitialized = false;

        cp.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1 && !hasInitialized) {
                hasInitialized = true;
                cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
                cp.stdin.write(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/call',
                    params: { name: toolName, arguments: args },
                  }) + '\n'
                );
              } else if (msg.id === 2) {
                const text = msg.result?.content?.[0]?.text || '';
                cp.kill();
                resolve({ text, isError: msg.result?.isError });
                return;
              }
            } catch {}
          }
        });

        cp.on('error', reject);
        cp.on('exit', (code) => {
          if (!hasInitialized && code !== 0 && code !== null) {
            reject(new Error(`MCP process exited with code ${code}`));
          }
        });

        cp.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-harness', version: '1.0' },
            },
          }) + '\n'
        );
      });
    };

    // Helper: Spawn server-cli subprocess and wait for AUTOPSY_PORT
    const startServerCli = (env: NodeJS.ProcessEnv, port: number): Promise<{ child: ChildProcess; actualPort: number }> => {
      return new Promise((resolve, reject) => {
        const cp = spawn('node', [srvDistScript], {
          env: { ...process.env, ...env, PORT: String(port) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let resolved = false;
        cp.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          const match = text.match(/AUTOPSY_PORT=(\d+)/);
          if (match && !resolved) {
            resolved = true;
            resolve({ child: cp, actualPort: Number(match[1]) });
          }
        });

        cp.on('error', reject);
        cp.on('exit', (code) => {
          if (!resolved) reject(new Error(`Server exited prematurely with code ${code}`));
        });

        setTimeout(() => {
          if (!resolved) {
            cp.kill();
            reject(new Error('Server-cli start timeout'));
          }
        }, 10000);
      });
    };

    // --- Part 1: Shared Data Directory via AUTOPSY_DATA_DIR ---
    const tempSharedDataDir = path.join(testRoot, 'shared_data_autopsy_env');
    fs.mkdirSync(tempSharedDataDir, { recursive: true });

    // 1. Invoke actual MCP server subprocess to create incident
    const mcpResA = await callMcp(
      { AUTOPSY_DATA_DIR: tempSharedDataDir },
      'collect_incident_bundle',
      {
        repoPath,
        title: '실제 MCP 서브프로세스 사건 A',
        userReportText: '실제 MCP 서브프로세스 사건 A - 사용자 신고 원문',
        errorOutput: 'TypeError: real mcp process test',
      }
    );
    assert.strictEqual(mcpResA.isError, undefined);
    const parsedA = JSON.parse(mcpResA.text);
    assert.strictEqual(parsedA.success, true);
    const mcpIncIdA = parsedA.incident.id;
    assert.ok(mcpIncIdA.startsWith('inc_'));

    // 2. Spawn actual backend server-cli with the exact same AUTOPSY_DATA_DIR
    const srvA = await startServerCli({ AUTOPSY_DATA_DIR: tempSharedDataDir }, 3882);

    try {
      // 3. Verify /api/health does NOT leak authToken
      const healthA = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${srvA.actualPort}/api/health`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode || 500, body: JSON.parse(b) }));
        }).on('error', reject);
      });
      assert.strictEqual(healthA.status, 200);
      assert.strictEqual(healthA.body.service, 'agent-autopsy');
      assert.strictEqual(healthA.body.authToken, undefined, 'Health endpoint MUST NOT leak authToken');

      // 4. Query incidents from HTTP server API to verify cross-process shared DB visibility
      const projectId = generateDeterministicProjectId(repoPath);
      const incResA = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${srvA.actualPort}/api/incidents?projectId=${projectId}`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode || 500, body: JSON.parse(b) }));
        }).on('error', reject);
      });
      assert.strictEqual(incResA.status, 200);
      const foundA = incResA.body.incidents.find((i: any) => i.id === mcpIncIdA);
      assert.ok(foundA, 'Incident created by real MCP server must be queryable via real server-cli HTTP API');
    } finally {
      srvA.child.kill();
    }

    // --- Part 2: Without AUTOPSY_DATA_DIR, verify default APPDATA fallback ---
    const tempAppDataDir = path.join(testRoot, 'fake_user_appdata');
    fs.mkdirSync(tempAppDataDir, { recursive: true });

    // 1. Invoke actual MCP server subprocess with APPDATA only
    const mcpResB = await callMcp(
      { APPDATA: tempAppDataDir, AUTOPSY_DATA_DIR: '' },
      'collect_incident_bundle',
      {
        repoPath,
        title: 'APPDATA 기본 경로 사건 B',
        userReportText: 'APPDATA 기본 경로 사건 B - 사용자 신고 원문',
        errorOutput: 'TypeError: appdata fallback test',
      }
    );
    assert.strictEqual(mcpResB.isError, undefined);
    const parsedB = JSON.parse(mcpResB.text);
    const mcpIncIdB = parsedB.incident.id;

    // Verify DB file was created under %APPDATA%/AgentAutopsy/autopsy.db
    const expectedDbFile = path.join(tempAppDataDir, 'AgentAutopsy', 'autopsy.db');
    assert.ok(fs.existsSync(expectedDbFile), 'DB must be created in %APPDATA%/AgentAutopsy/autopsy.db when AUTOPSY_DATA_DIR is unset');

    // 2. Spawn backend server-cli with APPDATA only
    const srvB = await startServerCli({ APPDATA: tempAppDataDir, AUTOPSY_DATA_DIR: '' }, 3883);
    try {
      const projectId = generateDeterministicProjectId(repoPath);
      const incResB = await new Promise<{ status: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${srvB.actualPort}/api/incidents?projectId=${projectId}`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode || 500, body: JSON.parse(b) }));
        }).on('error', reject);
      });
      assert.strictEqual(incResB.status, 200);
      const foundB = incResB.body.incidents.find((i: any) => i.id === mcpIncIdB);
      assert.ok(foundB, 'Incident must be shared across processes via default %APPDATA%/AgentAutopsy directory');
    } finally {
      srvB.child.kill();
    }
  });

  test('28. 0-D Check: Test Command Tamper Detection Blocks Verification & Does Not Auto-Sign', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '테스트 명령 변조 방어', 'AssertionError: cmd');
    const project = core.ensureProject(repoPath);
    const db = core.getDatabase();

    // 1. Rogue agent directly tampers test_command to 'exit 0' and wipes test_command_signature to NULL in DB
    (db as any).db.prepare(`
      UPDATE projects
      SET test_command = 'exit 0', test_command_signature = NULL
      WHERE id = ?
    `).run(project.id);

    // 2. Call ensureProject() - MUST NOT automatically re-issue signature!
    const reloaded = core.ensureProject(repoPath);
    assert.strictEqual(
      reloaded.testCommandSignature,
      undefined,
      'ensureProject MUST NOT automatically re-issue signature for unconfirmed or altered command'
    );

    const rowBefore = (db as any).db
      .prepare('SELECT test_command, test_command_signature FROM projects WHERE id = ?')
      .get(project.id);
    assert.strictEqual(rowBefore.test_command_signature, null, 'Signature in DB must remain NULL');

    // 3. Call proposeAndVerifyRepair() - MUST NOT execute verification and MUST throw error
    await assert.rejects(
      async () => {
        await core.proposeAndVerifyRepair(repoPath, inc.id, 'fake bypass fix', [
          {
            filePath: 'calculator.js',
            replacements: [{ search: 'return a / b;', replace: 'return 0;' }],
          },
        ]);
      },
      (err: any) => {
        return err.message.includes('[TEST_COMMAND_UNCONFIRMED]') || err.message.includes('[SECURITY_TAMPER_DETECTED]');
      },
      'Unsigned / tampered test command must be rejected without executing verification'
    );

    // 4. Verify signature in DB is STILL NULL (no stealth signing occurred)
    const rowAfter = (db as any).db
      .prepare('SELECT test_command, test_command_signature FROM projects WHERE id = ?')
      .get(project.id);
    assert.strictEqual(rowAfter.test_command_signature, null, 'Signature in DB must still be NULL');

    // 5. Restore legitimate test command with proper signature via user settings API
    core.updateProjectSettings(repoPath, { testCommand: 'node test.js' });
    const restored = db.getProject(project.id);
    assert.ok(restored?.testCommandSignature, 'User decision API must issue cryptographic signature');
  });

  test('29. 0-E Check: Connected Dependency Directory Mutation Fails Verification', async () => {
    const inc = await core.collectIncidentBundle(repoPath, '의존성 폴더 오염 감지 테스트', 'AssertionError: heavy');
    const project = core.ensureProject(repoPath);

    // Create a dummy node_modules directory with inner subfolder in repoPath
    const nodeModulesDir = path.join(repoPath, 'node_modules');
    const fakeDepDir = path.join(nodeModulesDir, 'sample_dep');
    fs.mkdirSync(fakeDepDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDepDir, 'index.js'), 'module.exports = {};\n');

    const validRepair = [
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: '  return a / b;',
            replace: '  if (b === 0) return 0;\n  return a / b;',
          },
        ],
      },
    ];

    // --- Case 1: 안쪽 폴더에 파일을 쓰는 경우 (node_modules/sample_dep/taint.txt) ---
    const innerPollutionCmd = `node -e "require('fs').writeFileSync('node_modules/sample_dep/taint.txt', 'inner polluted'); console.log('ALL TESTS PASSED');"`;
    core.updateProjectSettings(repoPath, { testCommand: innerPollutionCmd });

    const { executionResult: resInner } = await core.proposeAndVerifyRepair(
      repoPath,
      inc.id,
      'fix with inner pollution',
      validRepair
    );

    assert.strictEqual(resInner.success, false, 'Validation must fail when inner dependency folder is mutated');
    assert.ok(
      resInner.output.includes('원본 의존성 폴더 변경 감지'),
      'Output report must explicitly indicate 원본 의존성 폴더 변경 감지 for inner folder pollution'
    );
    assert.ok(
      resInner.output.includes('node_modules/sample_dep/taint.txt'),
      'Output report must specifically identify the polluted inner file path'
    );
    assert.ok(
      fs.existsSync(path.join(fakeDepDir, 'taint.txt')),
      'The inner file must have been physically written through junction to the host'
    );

    // Remove inner file before Case 2
    fs.unlinkSync(path.join(fakeDepDir, 'taint.txt'));

    // --- Case 2: 최상위 폴더에 파일을 쓰는 경우 (node_modules/top_taint.txt) ---
    const topPollutionCmd = `node -e "require('fs').writeFileSync('node_modules/top_taint.txt', 'top polluted'); console.log('ALL TESTS PASSED');"`;
    core.updateProjectSettings(repoPath, { testCommand: topPollutionCmd });

    const { executionResult: resTop } = await core.proposeAndVerifyRepair(
      repoPath,
      inc.id,
      'fix with top-level pollution',
      validRepair
    );

    assert.strictEqual(resTop.success, false, 'Validation must fail when top-level dependency folder is mutated');
    assert.ok(
      resTop.output.includes('원본 의존성 폴더 변경 감지'),
      'Output report must explicitly indicate 원본 의존성 폴더 변경 감지 for top-level folder pollution'
    );
    assert.ok(
      resTop.output.includes('node_modules/top_taint.txt'),
      'Output report must specifically identify the polluted top-level file path'
    );

    // Clean up top-level file before Case 3
    fs.unlinkSync(path.join(nodeModulesDir, 'top_taint.txt'));

    // --- Case 3: 5단계 이상 깊은 경로에 파일을 쓰는 경우 (node_modules/l1/l2/l3/l4/l5/deep_taint.txt) ---
    const deepDir = path.join(nodeModulesDir, 'l1', 'l2', 'l3', 'l4', 'l5');
    fs.mkdirSync(deepDir, { recursive: true });
    const deepPollutionCmd = `node -e "require('fs').writeFileSync('node_modules/l1/l2/l3/l4/l5/deep_taint.txt', 'deep polluted'); console.log('ALL TESTS PASSED');"`;
    core.updateProjectSettings(repoPath, { testCommand: deepPollutionCmd });

    const { executionResult: resDeep } = await core.proposeAndVerifyRepair(
      repoPath,
      inc.id,
      'fix with deep pollution',
      validRepair
    );

    assert.strictEqual(resDeep.success, false, 'Validation must fail when deep (>5 depth) dependency folder is mutated');
    assert.ok(
      resDeep.output.includes('원본 의존성 폴더 변경 감지'),
      'Output report must explicitly indicate 원본 의존성 폴더 변경 감지 for deep folder pollution'
    );
    assert.ok(
      resDeep.output.includes('deep_taint.txt'),
      'Output report must specifically identify the polluted deep file path'
    );
    assert.ok(
      fs.existsSync(path.join(deepDir, 'deep_taint.txt')),
      'The deep file must have been physically written through junction to the host'
    );

    // Clean up deep file before Case 4
    fs.unlinkSync(path.join(deepDir, 'deep_taint.txt'));

    // --- Case 4: 테스트 프로세스가 끝나기 직전에 쓰는 경우 (process.on('exit') 이벤트에서 쓰기) ---
    const exitPollutionCmd = `node -e "process.on('exit', () => { require('fs').writeFileSync('node_modules/exit_taint.txt', 'exit hook pollution'); }); console.log('ALL TESTS PASSED');"`;
    core.updateProjectSettings(repoPath, { testCommand: exitPollutionCmd });

    const { executionResult: resExit } = await core.proposeAndVerifyRepair(
      repoPath,
      inc.id,
      'fix with process exit pollution',
      validRepair
    );

    assert.strictEqual(resExit.success, false, 'Validation must fail when dependency folder is mutated right before process termination');
    assert.ok(
      resExit.output.includes('원본 의존성 폴더 변경 감지'),
      'Output report must explicitly indicate 원본 의존성 폴더 변경 감지 for process exit hook pollution'
    );
    assert.ok(
      resExit.output.includes('exit_taint.txt'),
      'Output report must specifically identify the polluted exit file path'
    );
    assert.ok(
      fs.existsSync(path.join(nodeModulesDir, 'exit_taint.txt')),
      'The exit-hook file must have been physically written to the host node_modules'
    );

    // Clean up
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
    core.updateProjectSettings(repoPath, { testCommand: 'node test.js' });
  });

  test('30. 0-B Check: User Decision APIs Require Valid Session Token', async () => {
    const apiServer = new ApiServer(core);
    const port = await apiServer.start(3881);
    const token = apiServer.getSessionToken();
    const projectId = core.ensureProject(repoPath).id;

    const makePost = (endpoint: string, headers: Record<string, string>, body: any) => {
      return new Promise<{ status: number; body: any }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: endpoint,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              ...headers,
            },
          },
          (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode || 500, body: JSON.parse(b) });
              } catch {
                resolve({ status: res.statusCode || 500, body: b });
              }
            });
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    };

    // 1. Settings without token -> 401
    const unauthSettings = await makePost(`/api/projects/${projectId}/settings`, {}, { verificationMode: 'MAIN_ONLY' });
    assert.strictEqual(unauthSettings.status, 401, 'Settings update without token must return 401');

    // 2. Settings with token -> 200
    const authSettings = await makePost(
      `/api/projects/${projectId}/settings`,
      { 'X-Autopsy-Token': token },
      { verificationMode: 'MAIN_ONLY' }
    );
    assert.strictEqual(authSettings.status, 200, 'Settings update with valid token must succeed (200 OK)');

    // 3. Rollback without token -> 401
    const unauthRollback = await makePost(`/api/checkpoints/cp_fake/rollback`, {}, { repoPath });
    assert.strictEqual(unauthRollback.status, 401, 'Rollback without token must return 401');

    // 4. Query APIs without token -> 200 OK
    const projectsRes = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/projects`, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode || 500, body: JSON.parse(b) }));
      }).on('error', reject);
    });
    assert.strictEqual(projectsRes.status, 200, 'Query API (/api/projects) must succeed without token');

    await apiServer.stop();
  });

  test('31. Step-0.5-Check: Repeated query API calls with identical unapproved changes create at most 1 quarantine backup', async () => {
    // 1. Create an active incident so activeIncidentsCount > 0
    const inc = await core.collectIncidentBundle(repoPath, '0.5단계 격리 백업 폭주 방지 테스트', 'AssertionError: test 31');

    // 2. Introduce unapproved direct modifications: both a tracked file edit and an untracked file
    fs.appendFileSync(path.join(repoPath, 'calculator.js'), '// unapproved line for 0.5 test\n');
    fs.writeFileSync(path.join(repoPath, 'unapproved_05.txt'), 'precious work');

    const countQuarantineRefs = () => {
      try {
        const out = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/autopsy/checkpoints/quarantine_*'], {
          cwd: repoPath,
          encoding: 'utf8',
        }).trim();
        return out ? out.split('\n').filter(Boolean).length : 0;
      } catch {
        return 0;
      }
    };

    const initialQuarantineCount = countQuarantineRefs();

    // 3. Start ApiServer to test the exact /api/overview query endpoint hit by Desktop UI polling & SSE
    const apiServer = new ApiServer(core);
    const port = await apiServer.start(3886);

    const callOverview = (): Promise<{ status: number; body: any }> => {
      return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ repoPath });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/overview',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => resolve({ status: res.statusCode || 500, body: JSON.parse(b) }));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    };

    try {
      // 4. Call /api/overview 100 times consecutively with identical unapproved changes
      let firstBackupRef = '';
      for (let i = 0; i < 100; i++) {
        const res = await callOverview();
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.health.unapprovedModificationsDetected, true);
        assert.ok(res.body.health.quarantineBackupRef);
        if (i === 0) {
          firstBackupRef = res.body.health.quarantineBackupRef;
        } else {
          assert.strictEqual(
            res.body.health.quarantineBackupRef,
            firstBackupRef,
            `Call #${i + 1} must reuse the existing quarantine backup ref without re-snapshotting`
          );
        }
      }

      // 5. CRITICAL VERIFICATION: Exactly 1 quarantine backup created across 100 queries!
      const countAfter100 = countQuarantineRefs();
      assert.strictEqual(
        countAfter100 - initialQuarantineCount,
        1,
        `Calling /api/overview 100 consecutive times must produce at most 1 quarantine backup! (actual new: ${countAfter100 - initialQuarantineCount})`
      );

      // 6. Introduce a new modification to working tree
      fs.appendFileSync(path.join(repoPath, 'calculator.js'), '// additional change triggering new fingerprint\n');
      fs.appendFileSync(path.join(repoPath, 'unapproved_05.txt'), '\nadditional untracked line');

      // 7. Call /api/overview again: must detect fingerprint change and create exactly 1 new quarantine backup
      const resAfterEdit = await callOverview();
      assert.strictEqual(resAfterEdit.status, 200);
      const secondBackupRef = resAfterEdit.body.health.quarantineBackupRef;
      assert.ok(secondBackupRef);
      assert.notStrictEqual(secondBackupRef, firstBackupRef, 'New modification must create a new quarantine backup ref');

      const countAfterEdit = countQuarantineRefs();
      assert.strictEqual(
        countAfterEdit - initialQuarantineCount,
        2,
        `Modifying the working tree must create exactly 1 new backup (total 2)`
      );

      // 8. Call /api/overview 20 more times without changes: ref count must remain 2
      for (let i = 0; i < 20; i++) {
        const res = await callOverview();
        assert.strictEqual(res.body.health.quarantineBackupRef, secondBackupRef);
      }
      assert.strictEqual(countQuarantineRefs() - initialQuarantineCount, 2);
    } finally {
      // 9. Clean up
      await apiServer.stop();
      try {
        execFileSync('git', ['checkout', 'HEAD', '--', 'calculator.js'], { cwd: repoPath, stdio: 'ignore' });
        if (fs.existsSync(path.join(repoPath, 'unapproved_05.txt'))) {
          fs.unlinkSync(path.join(repoPath, 'unapproved_05.txt'));
        }
      } catch {}
    }
  });

  test('32. Step-1-Check: Multi-language safe test command detection across Python unittest, pytest, CMake, Makefile, Go, Rust, Java, and Unknown', () => {
    // 1. Python unittest in tests/
    const pyTestsDir = path.join(testRoot, 'fixture_py_tests');
    fs.mkdirSync(path.join(pyTestsDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(pyTestsDir, 'tests', 'test_app.py'), '# test\n');
    const pyTestsDiscovered = core.discoverSafeTestCommands(pyTestsDir);
    assert.strictEqual(pyTestsDiscovered.projectType, 'python');
    assert.strictEqual(pyTestsDiscovered.fullRegressionCmd, 'python -m unittest discover -s tests');

    // 2. Python unittest in root
    const pyRootDir = path.join(testRoot, 'fixture_py_root');
    fs.mkdirSync(pyRootDir, { recursive: true });
    fs.writeFileSync(path.join(pyRootDir, 'test_calc.py'), '# test\n');
    const pyRootDiscovered = core.discoverSafeTestCommands(pyRootDir);
    assert.strictEqual(pyRootDiscovered.projectType, 'python');
    assert.strictEqual(pyRootDiscovered.fullRegressionCmd, 'python -m unittest discover -s .');

    // 3. Python pytest
    const pytestDir = path.join(testRoot, 'fixture_pytest');
    fs.mkdirSync(pytestDir, { recursive: true });
    fs.writeFileSync(path.join(pytestDir, 'pytest.ini'), '[pytest]\n');
    const pytestDiscovered = core.discoverSafeTestCommands(pytestDir);
    assert.strictEqual(pytestDiscovered.projectType, 'python');
    assert.strictEqual(pytestDiscovered.fullRegressionCmd, 'pytest');

    // 4. C/C++ CMake
    const cmakeDir = path.join(testRoot, 'fixture_cmake');
    fs.mkdirSync(cmakeDir, { recursive: true });
    fs.writeFileSync(path.join(cmakeDir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n');
    const cmakeDiscovered = core.discoverSafeTestCommands(cmakeDir);
    assert.strictEqual(cmakeDiscovered.projectType, 'c_cpp');
    assert.strictEqual(cmakeDiscovered.fullRegressionCmd, 'ctest');

    // 5. C/C++ Makefile with test target
    const makeDir = path.join(testRoot, 'fixture_make');
    fs.mkdirSync(makeDir, { recursive: true });
    fs.writeFileSync(path.join(makeDir, 'Makefile'), 'all:\n\tgcc main.c\ntest:\n\t./test\n');
    const makeDiscovered = core.discoverSafeTestCommands(makeDir);
    assert.strictEqual(makeDiscovered.projectType, 'c_cpp');
    assert.strictEqual(makeDiscovered.fullRegressionCmd, 'make test');

    // 6. Go
    const goDir = path.join(testRoot, 'fixture_go');
    fs.mkdirSync(goDir, { recursive: true });
    fs.writeFileSync(path.join(goDir, 'go.mod'), 'module example.com/m\n\ngo 1.21\n');
    const goDiscovered = core.discoverSafeTestCommands(goDir);
    assert.strictEqual(goDiscovered.projectType, 'go');
    assert.strictEqual(goDiscovered.fullRegressionCmd, 'go test ./...');

    // 7. Rust
    const rustDir = path.join(testRoot, 'fixture_rust');
    fs.mkdirSync(rustDir, { recursive: true });
    fs.writeFileSync(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "demo"\n');
    const rustDiscovered = core.discoverSafeTestCommands(rustDir);
    assert.strictEqual(rustDiscovered.projectType, 'rust');
    assert.strictEqual(rustDiscovered.fullRegressionCmd, 'cargo test');

    // 8. Java (Maven)
    const javaDir = path.join(testRoot, 'fixture_java');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(path.join(javaDir, 'pom.xml'), '<project></project>\n');
    const javaDiscovered = core.discoverSafeTestCommands(javaDir);
    assert.strictEqual(javaDiscovered.projectType, 'java');
    assert.strictEqual(javaDiscovered.fullRegressionCmd, 'mvn test');

    // 9. Unknown: MUST NOT fall back to npm test!
    const unknownDir = path.join(testRoot, 'fixture_unknown');
    fs.mkdirSync(unknownDir, { recursive: true });
    fs.writeFileSync(path.join(unknownDir, 'notes.txt'), 'just text notes\n');
    const unknownDiscovered = core.discoverSafeTestCommands(unknownDir);
    assert.strictEqual(unknownDiscovered.projectType, 'unknown');
    assert.strictEqual(unknownDiscovered.fullRegressionCmd, undefined);
    assert.strictEqual(core.detectTestCommand(unknownDir), '');
  });

  test('33. Step-1-Check: propose_test_command, BLOCKED_TEST_COMMAND_UNCONFIRMED status & confirm-test-command API', async () => {
    const unconfRepo = path.join(testRoot, 'unconfirmed_repo');
    fs.mkdirSync(unconfRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: unconfRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: unconfRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: unconfRepo });
    fs.writeFileSync(path.join(unconfRepo, 'app.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: unconfRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: unconfRepo });

    const project = core.ensureProject(unconfRepo);
    assert.strictEqual(project.testCommandSignature, undefined, 'Initial project test command must be unconfirmed');

    const inc = await core.collectIncidentBundle(unconfRepo, '미확정 테스트 명령 사고', 'Error: unconfirmed');

    // 1. proposeAndVerifyRepair MUST be blocked with BLOCKED_TEST_COMMAND_UNCONFIRMED and next_action
    let thrownError: any = null;
    try {
      await core.proposeAndVerifyRepair(unconfRepo, inc.id, 'fix attempt', [
        { filePath: 'app.js', newContent: 'module.exports = 2;\n' },
      ]);
    } catch (err: any) {
      thrownError = err;
    }
    assert.ok(thrownError, 'Verification must be blocked');
    assert.strictEqual(thrownError.code, 'BLOCKED_TEST_COMMAND_UNCONFIRMED');
    assert.ok(thrownError.message.includes('BLOCKED_TEST_COMMAND_UNCONFIRMED'));
    assert.ok(thrownError.next_action);
    assert.strictEqual(thrownError.next_action.actor, 'USER');
    assert.strictEqual(thrownError.next_action.action, 'CONFIRM_TEST_COMMAND_IN_APP');

    // 2. Agent proposes a test command via proposeTestCommand
    const proposeRes = core.proposeTestCommand(unconfRepo, 'node test.js', 'Node.js runner');
    assert.strictEqual(proposeRes.success, true);
    assert.strictEqual(proposeRes.project.proposedTestCommand, 'node test.js');
    assert.strictEqual(proposeRes.project.proposedTestCommandReason, 'Node.js runner');
    assert.strictEqual(proposeRes.project.testCommandSignature, undefined, 'Proposal must not auto-sign');

    // 3. User confirms test command via confirm-test-command API (with session token)
    const apiServer = new ApiServer(core);
    const port = await apiServer.start(3872);
    const token = apiServer.getSessionToken();

    try {
      const confirmRes = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/confirm-test-command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Autopsy-Token': token,
        },
        body: JSON.stringify({ testCommand: 'node test.js' }),
      });
      assert.strictEqual(confirmRes.status, 200);
      const confirmData = (await confirmRes.json()) as any;
      assert.strictEqual(confirmData.success, true);
      assert.strictEqual(confirmData.project.testCommand, 'node test.js');
      assert.ok(confirmData.project.testCommandSignature, 'Confirmed command must be signed');
      assert.strictEqual(confirmData.project.proposedTestCommand, undefined, 'Proposal must be cleared after confirmation');

      // 4. Now proposeAndVerifyRepair can proceed without being blocked
      fs.writeFileSync(path.join(unconfRepo, 'test.js'), 'process.exit(0);\n');
      execFileSync('git', ['add', 'test.js'], { cwd: unconfRepo });
      execFileSync('git', ['commit', '-m', 'add test runner'], { cwd: unconfRepo });

      const verifyRes = await core.proposeAndVerifyRepair(unconfRepo, inc.id, 'legit fix', [
        { filePath: 'app.js', newContent: 'module.exports = 2;\n' },
      ]);
      assert.strictEqual(verifyRes.proposal.verificationStatus, 'VERIFIED_PASS');
    } finally {
      await apiServer.stop();
    }
  });

  test('34. Step-1-Check: collectIncidentBundle does NOT execute unconfirmed test commands on host repository', async () => {
    const unconfRepo = path.join(testRoot, 'unconfirmed_bundle_repo');
    fs.mkdirSync(unconfRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: unconfRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: unconfRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: unconfRepo });
    fs.writeFileSync(path.join(unconfRepo, 'file.txt'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: unconfRepo });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: unconfRepo });

    // Set an unconfirmed test command (no signature) in DB
    const project = core.ensureProject(unconfRepo);
    const maliciousCmd = 'node -e "require(\'fs\').writeFileSync(\'polluted.txt\', \'taint\')"';
    (core.getDatabase() as any).db.prepare(`
      UPDATE projects SET test_command = ?, test_command_signature = NULL WHERE id = ?
    `).run(maliciousCmd, project.id);

    // Call collectIncidentBundle without error output
    const inc = await core.collectIncidentBundle(unconfRepo, '미확정 테스트 명령 실행 방어 테스트');
    assert.strictEqual(inc.testExecutionNote, '테스트 실행 불가: 확정된 테스트 명령 없음');
    assert.ok(inc.errorOutput.includes('테스트 실행 불가: 확정된 테스트 명령 없음'));

    // CRITICAL: Host repository MUST NOT have been polluted by the unconfirmed command!
    assert.strictEqual(fs.existsSync(path.join(unconfRepo, 'polluted.txt')), false, 'Unconfirmed test command must NEVER execute in host repository');
  });

  test('35. Step-1-Check: Heavy dependency folder entry truncation triggers [일부 확인 못 함] display', async () => {
    const truncRepo = path.join(testRoot, 'trunc_check_repo');
    fs.mkdirSync(truncRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: truncRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: truncRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: truncRepo });

    fs.writeFileSync(path.join(truncRepo, 'calculator.js'), 'module.exports = { add: (a, b) => a + b };\n');
    fs.writeFileSync(path.join(truncRepo, 'test.js'), 'const c = require("./calculator.js"); if (c.add(1, 2) !== 3) process.exit(1);\n');
    execFileSync('git', ['add', '.'], { cwd: truncRepo });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: truncRepo });

    // Confirm test command
    core.updateProjectSettings(truncRepo, { testCommand: 'node test.js' });

    // Create a node_modules with 10 files
    const nm = path.join(truncRepo, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(nm, `file_${i}.txt`), `content ${i}`);
    }

    const runner = new WorktreeRunner();
    const truncatedList: string[] = [];
    // Max entries 5 -> node_modules has 10, so it will hit the limit and be marked truncated
    runner.captureHeavyDirsSnapshot(truncRepo, 4, 5, truncatedList);
    assert.ok(truncatedList.includes('node_modules'), 'node_modules must be in truncated list when entry limit is reached');

    const inc = await core.collectIncidentBundle(truncRepo, '한도 감지 테스트', 'AssertionError: test');
    const { proposal, executionResult } = await core.proposeAndVerifyRepair(truncRepo, inc.id, 'fix', [
      { filePath: 'calculator.js', replacements: [{ search: 'a + b', replace: 'a + b + 0' }] },
    ]);

    // Verify verification passed and runner executes safely
    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
  });

  test('36. Step-2-Check: Severity defaults to UNASSESSED without guessing; explicit user severity applied with evidence', async () => {
    const sRepo = path.join(testRoot, 'sev_check_repo');
    fs.mkdirSync(sRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: sRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: sRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: sRepo });
    fs.writeFileSync(path.join(sRepo, 'app.js'), 'console.log("hello");\n');
    execFileSync('git', ['add', '.'], { cwd: sRepo });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: sRepo });

    // Case 1: No severity specified -> Default UNASSESSED
    const incDefault = await core.collectIncidentBundle(sRepo, '버그 신고 (심각도 미지정)');
    assert.strictEqual(incDefault.severity, 'UNASSESSED', 'Severity must default to UNASSESSED');
    assert.ok(incDefault.severityEvidence && incDefault.severityEvidence.length > 0, 'Must have severity evidence');
    assert.ok(incDefault.severityEvidence[0].includes('사용자 미지정: 기본 미판정'));

    // Case 2: Explicit severity specified by user -> applied with evidence
    const incExplicit = await core.collectIncidentBundle(sRepo, {
      title: '사용자 지정 심각도 버그',
      severity: 'HIGH',
      errorOutput: 'custom error',
    });
    assert.strictEqual(incExplicit.severity, 'HIGH', 'Explicit severity must be applied');
    assert.ok(incExplicit.severityEvidence && incExplicit.severityEvidence[0].includes('사용자 명시적 신고 등급: HIGH'));
  });

  test('37. Step-2-Check: SyntaxError/TypeError does NOT grant CONFIRMED cause; causeVerdict remains UNKNOWN with clear evidence', async () => {
    const cRepo = path.join(testRoot, 'cause_check_repo');
    fs.mkdirSync(cRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: cRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: cRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: cRepo });
    fs.writeFileSync(path.join(cRepo, 'app.js'), 'console.log("hello");\n');
    execFileSync('git', ['add', '.'], { cwd: cRepo });
    execFileSync('git', ['commit', '-m', 'Init'], { cwd: cRepo });

    // Incident with TypeError
    const incTypeErr = await core.collectIncidentBundle(
      cRepo,
      'TypeError 발생 사건',
      'TypeError: Cannot read properties of undefined (reading "execute")\n    at app.js:10:15'
    );
    assert.strictEqual(incTypeErr.causeVerdict, 'UNKNOWN', 'TypeError must NOT automatically grant CONFIRMED');
    assert.ok(incTypeErr.causeEvidence && incTypeErr.causeEvidence.length > 0);
    assert.ok(incTypeErr.causeEvidence.some((e) => e.includes('원인 추정 단계') || e.includes('미확정')));

    // Incident with SyntaxError
    const incSyntaxErr = await core.collectIncidentBundle(
      cRepo,
      'SyntaxError 발생 사건',
      'SyntaxError: Unexpected token "}"\n    at app.js:5:1'
    );
    assert.strictEqual(incSyntaxErr.causeVerdict, 'UNKNOWN', 'SyntaxError must NOT automatically grant CONFIRMED');
  });

  test('38. Step-2-Check: Completion Criteria 1 - Functional bug (no error msg), 7 files modified 1-2 lines each, no sensitive paths -> subagent review NOT required', async () => {
    const multiRepo = path.join(testRoot, 'multi_file_repo');
    fs.mkdirSync(multiRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: multiRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: multiRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: multiRepo });

    // Create 7 files
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(multiRepo, `file_${i}.js`), `function fn${i}() {\n  return ${i};\n}\nmodule.exports = { fn${i} };\n`);
    }
    fs.writeFileSync(path.join(multiRepo, 'test.js'), 'console.log("OK");\n');
    execFileSync('git', ['add', '.'], { cwd: multiRepo });
    execFileSync('git', ['commit', '-m', 'Init 7 files'], { cwd: multiRepo });

    core.updateProjectSettings(multiRepo, {
      testCommand: 'node test.js',
      sensitivePaths: [], // No sensitive paths
      riskThresholdLines: 200,
      verificationMode: 'AUTO',
    });

    // Functional bug report: no error message
    const inc = await core.collectIncidentBundle(multiRepo, '기능 버그 신고 (오류 메시지 없음)');

    // 7 files modified, 1-2 lines each (total changed lines: ~14 lines << 100)
    const fileChanges = [];
    for (let i = 1; i <= 7; i++) {
      fileChanges.push({
        filePath: `file_${i}.js`,
        replacements: [
          {
            search: `  return ${i};`,
            replace: `  const x = ${i};\n  return x;`,
          },
        ],
      });
    }

    const { proposal } = await core.proposeAndVerifyRepair(
      multiRepo,
      inc.id,
      '7개 파일 각 1~2줄 기능 로직 경량 수정',
      fileChanges
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    assert.strictEqual(proposal.riskLevel, 'LOW', '7 files with 1-2 lines each must be judged LOW risk');
    assert.strictEqual(proposal.approvalReadiness, 'READY_FOR_APPROVAL', 'Subagent review must NOT be required for LOW risk in AUTO mode');
    assert.strictEqual(proposal.approvalBlockReason, undefined);
    assert.ok(proposal.riskEvidence && proposal.riskEvidence.length > 0, 'Must record risk evidence list');
  });

  test('39. Step-2-Check: Completion Criteria 2 - Touching even 1 line of sensitive path makes risk HIGH & subagent review MANDATORY', async () => {
    const sensRepo = path.join(testRoot, 'sensitive_path_repo');
    fs.mkdirSync(sensRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: sensRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: sensRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: sensRepo });

    fs.mkdirSync(path.join(sensRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sensRepo, 'src', 'secret.js'), 'const SECRET_KEY = "old_secret";\nmodule.exports = { SECRET_KEY };\n');
    fs.writeFileSync(path.join(sensRepo, 'test.js'), 'console.log("OK");\n');
    execFileSync('git', ['add', '.'], { cwd: sensRepo });
    execFileSync('git', ['commit', '-m', 'Init sensitive repo'], { cwd: sensRepo });

    // User designates sensitive paths in project settings
    core.updateProjectSettings(sensRepo, {
      testCommand: 'node test.js',
      sensitivePaths: ['src/secret.js', 'config/**'],
      riskThresholdLines: 200,
      verificationMode: 'AUTO',
    });

    const inc = await core.collectIncidentBundle(sensRepo, '민감 키 변경 사건');

    // Modify just ONE line in the sensitive path
    const { proposal } = await core.proposeAndVerifyRepair(
      sensRepo,
      inc.id,
      '민감 키 1줄 수정',
      [
        {
          filePath: 'src/secret.js',
          replacements: [
            {
              search: 'const SECRET_KEY = "old_secret";',
              replace: 'const SECRET_KEY = "new_secret";',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    assert.strictEqual(proposal.riskLevel, 'HIGH', 'Touching sensitive path must evaluate to HIGH risk');
    assert.strictEqual(proposal.approvalReadiness, 'BLOCKED_AWAITING_REVIEW', 'Subagent review is MANDATORY before approval');
    assert.ok(proposal.approvalBlockReason && proposal.approvalBlockReason.includes('호스트 내장 서브에이전트의 독립 교차 검토가 필수'));
    assert.ok(proposal.riskEvidence && proposal.riskEvidence.some((e) => e.includes('민감 경로 수정 감지')));
  });

  test('40. Step-2-Check: Line threshold (200 HIGH, 100 MEDIUM) and isolated verification retry count escalations', async () => {
    const lineRepo = path.join(testRoot, 'line_thresh_repo');
    fs.mkdirSync(lineRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: lineRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: lineRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: lineRepo });

    fs.writeFileSync(path.join(lineRepo, 'big.js'), '// initial\n');
    fs.writeFileSync(path.join(lineRepo, 'test.js'), 'console.log("OK");\n');
    execFileSync('git', ['add', '.'], { cwd: lineRepo });
    execFileSync('git', ['commit', '-m', 'Init big repo'], { cwd: lineRepo });

    core.updateProjectSettings(lineRepo, {
      testCommand: 'node test.js',
      sensitivePaths: [],
      riskThresholdLines: 200,
      verificationMode: 'AUTO',
    });

    const inc = await core.collectIncidentBundle(lineRepo, '대규모 변경 사건');

    // Generate ~110 lines addition (>= 100 lines, < 200 lines) -> MEDIUM
    const medLines = Array.from({ length: 110 }, (_, i) => `const var_${i} = ${i};`).join('\n');
    const { proposal: propMed } = await core.proposeAndVerifyRepair(lineRepo, inc.id, '중규모 110줄 변경', [
      { filePath: 'big.js', replacements: [{ search: '// initial', replace: `// initial\n${medLines}` }] },
    ]);
    assert.strictEqual(propMed.riskLevel, 'MEDIUM', '110 lines must evaluate to MEDIUM risk');
    assert.strictEqual(propMed.approvalReadiness, 'READY_FOR_APPROVAL', 'MEDIUM risk does not require subagent in AUTO mode');

    // Generate ~220 lines addition (>= 200 lines) -> HIGH
    const highLines = Array.from({ length: 220 }, (_, i) => `const high_${i} = ${i};`).join('\n');
    const { proposal: propHigh } = await core.proposeAndVerifyRepair(lineRepo, inc.id, '대규모 220줄 변경', [
      { filePath: 'big.js', replacements: [{ search: '// initial', replace: `// initial\n${highLines}` }] },
    ]);
    assert.strictEqual(propHigh.riskLevel, 'HIGH', '220 lines must evaluate to HIGH risk');
    assert.strictEqual(propHigh.approvalReadiness, 'BLOCKED_AWAITING_REVIEW', 'HIGH risk requires subagent in AUTO mode');
  });

  test('41. Step-2-Check: MAIN_ONLY mode never calls subagents and produces selfReviewChecklist with risk warning', async () => {
    const moRepo = path.join(testRoot, 'main_only_repo');
    fs.mkdirSync(moRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: moRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: moRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: moRepo });

    fs.writeFileSync(path.join(moRepo, 'auth.js'), 'const token = "x";\n');
    fs.writeFileSync(path.join(moRepo, 'test.js'), 'console.log("OK");\n');
    execFileSync('git', ['add', '.'], { cwd: moRepo });
    execFileSync('git', ['commit', '-m', 'Init main only repo'], { cwd: moRepo });

    core.updateProjectSettings(moRepo, {
      testCommand: 'node test.js',
      sensitivePaths: ['auth.js'],
      verificationMode: 'MAIN_ONLY',
    });

    const inc = await core.collectIncidentBundle(moRepo, '메인 전용 모드 사건');
    const { proposal } = await core.proposeAndVerifyRepair(moRepo, inc.id, '민감 파일 수정', [
      { filePath: 'auth.js', replacements: [{ search: 'const token = "x";', replace: 'const token = "y";' }] },
    ]);

    assert.strictEqual(proposal.riskLevel, 'HIGH');
    assert.strictEqual(proposal.approvalReadiness, 'APPROVABLE_WITH_RISK_WARNING', 'MAIN_ONLY must NOT block approval awaiting subagent');
    assert.ok(proposal.approvalBlockReason && proposal.approvalBlockReason.includes('메인 AI 전용 모드'));
    assert.ok(proposal.selfReviewChecklist && proposal.selfReviewChecklist.length === 3, 'Must generate 3-part self review checklist');
    assert.ok(proposal.selfReviewChecklist[0].includes('민감 경로 점검'));
    assert.ok(proposal.selfReviewChecklist[1].includes('기존 동작 변경 부위'));
    assert.ok(proposal.selfReviewChecklist[2].includes('테스트 미커버 영역'));
  });

  test('42. Step-2-Check: Existing DB incidents and proposals migration fills UNASSESSED and evidence arrays', async () => {
    const rawDb = (core.getDatabase() as any).db;
    const legacyIncId = `inc_legacy_${Date.now()}`;
    const legacyProj = core.ensureProject(repoPath);

    // Insert legacy row with HIGH severity and NULL evidence
    rawDb.prepare(`
      INSERT INTO incidents (id, project_id, title, error_output, diff_summary, status, severity, created_at)
      VALUES (?, ?, 'Legacy Bug', 'err', 'diff', 'OPEN', 'HIGH', datetime('now'))
    `).run(legacyIncId, legacyProj.id);

    // Run migration
    core.getDatabase().migrateUnassessedFields();

    const migrated = core.getDatabase().getIncident(legacyIncId);
    assert.ok(migrated, 'Migrated incident must exist');
    assert.strictEqual(migrated.severity, 'UNASSESSED', 'Legacy incident severity without evidence must migrate to UNASSESSED');
    assert.ok(migrated.severityEvidence && migrated.severityEvidence.length > 0, 'Must have migrated evidence array');
  });

  test('43. Step-3-Check: Multi-language stack trace and file:line parser across Python, JS, C/C++, Java, Go, Rust', () => {
    // 1. Python traceback
    const pyError = `Traceback (most recent call last):
  File "tests/test_calculator.py", line 45, in test_divide
    result = divide(10, 0)
ZeroDivisionError: division by zero`;
    const pyFrames = parseStackFrames(pyError);
    assert.strictEqual(pyFrames.length, 1);
    assert.strictEqual(pyFrames[0].filePath, 'tests/test_calculator.py');
    assert.strictEqual(pyFrames[0].line, 45);

    // 2. JS / Node stack
    const jsError = `AssertionError [ERR_ASSERTION]: Expected 42 but got 0
    at Object.<anonymous> (test/calc.test.js:22:9)
    at Module._compile (node:internal/modules/cjs/loader:123:14)`;
    const jsFrames = parseStackFrames(jsError);
    assert.strictEqual(jsFrames.length, 1);
    assert.strictEqual(jsFrames[0].filePath, 'test/calc.test.js');
    assert.strictEqual(jsFrames[0].line, 22);

    // 3. C / C++ GCC error
    const gccError = `src/calculator.c:38:5: error: expected ';' before 'return'`;
    const gccFrames = parseStackFrames(gccError);
    assert.strictEqual(gccFrames.length, 1);
    assert.strictEqual(gccFrames[0].filePath, 'src/calculator.c');
    assert.strictEqual(gccFrames[0].line, 38);

    // 4. GoogleTest C++ failure
    const gtestError = `tests/calc_test.cpp:104: Failure
Expected equality of these values:
  calc.add(2, 2)
    Which is: 5
  4`;
    const gtestFrames = parseStackFrames(gtestError);
    assert.strictEqual(gtestFrames.length, 1);
    assert.strictEqual(gtestFrames[0].filePath, 'tests/calc_test.cpp');
    assert.strictEqual(gtestFrames[0].line, 104);

    // 5. C/C++ AddressSanitizer (ASan)
    const asanError = `=================================================================
==1234==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014
    #0 0x401234 in main src/matrix.c:29:10
=================================================================`;
    const asanFrames = parseStackFrames(asanError);
    assert.strictEqual(asanFrames.length, 1);
    assert.strictEqual(asanFrames[0].filePath, 'src/matrix.c');
    assert.strictEqual(asanFrames[0].line, 29);

    // 6. Java stack trace
    const javaError = `java.lang.AssertionError: balance mismatch
    at com.example.service.BillingServiceTest.testRefund(BillingServiceTest.java:78)`;
    const javaFrames = parseStackFrames(javaError);
    assert.strictEqual(javaFrames.length, 1);
    assert.strictEqual(javaFrames[0].filePath, 'BillingServiceTest.java');
    assert.strictEqual(javaFrames[0].line, 78);

    // 7. Go panic
    const goError = `panic: runtime error: integer divide by zero
goroutine 1 [running]:
main.divide(...)
\tsrc/math/calc_test.go:19 +0x40`;
    const goFrames = parseStackFrames(goError);
    assert.strictEqual(goFrames.length, 1);
    assert.strictEqual(goFrames[0].filePath, 'src/math/calc_test.go');
    assert.strictEqual(goFrames[0].line, 19);

    // 8. Rust panic/error
    const rustError = `error[E0308]: mismatched types
  --> src/parser.rs:52:9
   |
52 |         Ok(val)
   |         ^^^^^^^ expected struct String, found &str`;
    const rustFrames = parseStackFrames(rustError);
    assert.strictEqual(rustFrames.length, 1);
    assert.strictEqual(rustFrames[0].filePath, 'src/parser.rs');
    assert.strictEqual(rustFrames[0].line, 52);
  });

  test('44. Step-3-Check: User Requirement 1 - Static HIGH score without execution evidence yields at most LIKELY', () => {
    // Exact stack frame matching diff range (line 10) gives static score HIGH (85), but without execution evidence it is capped at LIKELY
    const errorOutputExact = `AssertionError: value mismatch
    at test (src/math.js:10:3)`;
    const diff = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -10,10 +10,10 @@
-    return a + b;
+    return a + b * 2;`;

    // Static analysis with exact stack frame matching diff range, NO reproductionResult or coverageLines
    const analysisExact = analyzeIncident(errorOutputExact, diff);
    assert.ok(analysisExact.candidates.length > 0);
    const topExact = analysisExact.candidates[0];
    assert.strictEqual(topExact.filePath, 'src/math.js');
    assert.strictEqual(topExact.evidenceStrength, 'HIGH', 'Exact stack frame + diff range should have HIGH static evidence strength');

    // Mandated by user requirement 1: Without execution evidence, causeVerdict MUST be LIKELY, NOT CONFIRMED!
    assert.strictEqual(analysisExact.causeVerdict, 'LIKELY', 'Static score alone must be capped at LIKELY without execution evidence');
    assert.strictEqual(topExact.causeVerdict, 'LIKELY');
    assert.strictEqual(topExact.hasExecutionEvidence, false);
    assert.ok(
      analysisExact.missingEvidenceChecklist?.some((item) => item.includes('run_reproduction')),
      'Must guide agent to run reproduction test'
    );

    // Frame in same file but different line (e.g. line 15), static score is MEDIUM (45), yields LIKELY
    const errorOutputFileMatch = `AssertionError: value mismatch
    at test (src/math.js:15:3)`;
    const analysisFileMatch = analyzeIncident(errorOutputFileMatch, diff);
    const topFileMatch = analysisFileMatch.candidates[0];
    assert.strictEqual(topFileMatch.evidenceStrength, 'MEDIUM');
    assert.strictEqual(analysisFileMatch.causeVerdict, 'LIKELY');
    assert.notStrictEqual(analysisFileMatch.causeVerdict, 'CONFIRMED');
  });

  test('45. Step-3-Check: run_reproduction executes in isolated worktree and records REPRODUCED execution evidence', async () => {
    // 1. Create a Python repo to test non-JS language execution
    const pyRepo = path.join(testRoot, 'python_repro_repo');
    fs.mkdirSync(path.join(pyRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'src', 'calc.py'), 'def add(a, b):\n    return a - b  # Bug!\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init python calc'], { cwd: pyRepo });

    // Confirm test runner in project settings
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m unittest' });

    // Collect an incident
    const inc = await core.collectIncidentBundle(pyRepo, '덧셈 버그 발생', 'AssertionError: 2 != 0');

    // Create a reproduction test in the host repo
    const reproFile = 'test_repro.py';
    fs.writeFileSync(
      path.join(pyRepo, reproFile),
      `import unittest
from src.calc import add

class TestRepro(unittest.TestCase):
    def test_add_repro(self):
        self.assertEqual(add(1, 1), 2)

if __name__ == '__main__':
    unittest.main()
`
    );

    // Call runReproduction with reproduction test file
    const reproResult = await core.runReproduction(pyRepo, inc.id, reproFile);

    assert.strictEqual(reproResult.status, 'REPRODUCED', 'Bug should be successfully reproduced by failing assertion');
    assert.ok(reproResult.output.includes('AssertionError') || reproResult.output.includes('FAIL'));

    // Check that incident in DB now contains reproductionResult and causeVerdict is updated
    const updatedInc = core.getDatabase().getIncident(inc.id)!;
    assert.ok(updatedInc.reproductionResult);
    assert.strictEqual(updatedInc.reproductionResult.status, 'REPRODUCED');
    assert.ok(updatedInc.causeEvidence?.some((e) => e.includes('[실행 증거]')));
  });

  test('46. Step-3-Check: Execution evidence elevates causeVerdict to CONFIRMED and tags reasons', () => {
    const errorOutput = `AssertionError: value mismatch
    at test (src/math.js:10:3)`;
    const diff = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -10,10 +10,10 @@
+    return a + b * 2;`;

    // Incident with reproduction test execution evidence matching src/math.js
    const incidentWithRepro = {
      reproductionResult: {
        status: 'REPRODUCED' as const,
        command: 'node repro.test.js',
        exitCode: 1,
        output: 'AssertionError: expected 4 got 2 at src/math.js:15',
        failedLocation: { filePath: 'src/math.js', line: 15 },
        executedAt: new Date().toISOString(),
      },
    };

    const analysis = analyzeIncident(errorOutput, diff, undefined, 'project', 'HEAD', incidentWithRepro);
    assert.strictEqual(analysis.causeVerdict, 'CONFIRMED', 'Execution evidence must elevate causeVerdict to CONFIRMED');
    const top = analysis.candidates[0];
    assert.strictEqual(top.causeVerdict, 'CONFIRMED');
    assert.strictEqual(top.hasExecutionEvidence, true);

    // Check tags: [스택], [변경], [재현]
    assert.ok(top.supportingEvidence.some((e) => e.startsWith('[스택]')), 'Must include [스택] tag');
    assert.ok(top.supportingEvidence.some((e) => e.startsWith('[변경]')), 'Must include [변경] tag');
    assert.ok(top.supportingEvidence.some((e) => e.startsWith('[재현]')), 'Must include [재현] tag');
  });

  test('47. Step-3-Check: Coverage execution evidence elevates causeVerdict and demotes unexecuted candidates (주입 데이터)', () => {
    const errorOutput = `FAIL test.js`;
    const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,3 @@
+const a = 1;
diff --git a/src/b.js b/src/b.js
--- a/src/b.js
+++ b/src/b.js
@@ -1,3 +1,3 @@
+const b = 2;`;

    // Incident with coverage lines: failing test executed src/a.js lines, but NEVER executed src/b.js
    const incidentWithCoverage = {
      enableCoverage: true,
      coverageLines: {
        'src/a.js': [1, 2, 3],
      },
    };

    const analysis = analyzeIncident(errorOutput, diff, undefined, 'project', 'HEAD', incidentWithCoverage);
    const candidateA = analysis.candidates.find((c) => c.filePath === 'src/a.js')!;
    const candidateB = analysis.candidates.find((c) => c.filePath === 'src/b.js')!;

    // src/a.js has coverage execution evidence
    assert.ok(candidateA.supportingEvidence.some((e) => e.startsWith('[커버리지]')));
    // src/b.js was never covered and has counterEvidence demoting it
    assert.ok(candidateB.counterEvidence.some((e) => e.includes('한 번도 실행하지 않음')));
    assert.ok(candidateA.score > candidateB.score, 'Covered file must rank higher than unexecuted file');
  });

  test('48. Step-3-Check: Non-reproduced (exit 0) yields NOT_REPRODUCED and non-runnable yields CANNOT_RUN', async () => {
    const jsRepo = path.join(testRoot, 'js_repro_status_repo');
    fs.mkdirSync(jsRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: jsRepo });

    fs.writeFileSync(path.join(jsRepo, 'app.js'), 'module.exports = 42;\n');
    fs.writeFileSync(path.join(jsRepo, 'pass_test.js'), 'process.exit(0);\n');
    execFileSync('git', ['add', '.'], { cwd: jsRepo });
    execFileSync('git', ['commit', '-m', 'Init app'], { cwd: jsRepo });

    const inc = await core.collectIncidentBundle(jsRepo, '상태 판정 사건');

    // 1. Without confirmed test runner -> CANNOT_RUN
    const noRunnerResult = await core.runReproduction(jsRepo, inc.id, 'pass_test.js');
    assert.strictEqual(noRunnerResult.status, 'CANNOT_RUN');
    assert.ok(noRunnerResult.output.includes('확정된 테스트 러너가 없습니다'));

    // 2. User confirms test runner (e.g. node)
    core.updateProjectSettings(jsRepo, { testCommand: 'node' });

    // 3. Passing test file -> NOT_REPRODUCED
    const passResult = await core.runReproduction(jsRepo, inc.id, 'pass_test.js');
    assert.strictEqual(passResult.status, 'NOT_REPRODUCED');

    // 4. Non-existent test file -> CANNOT_RUN
    const nonExistentResult = await core.runReproduction(jsRepo, inc.id, 'non_existent_file_xyz.js');
    assert.strictEqual(nonExistentResult.status, 'CANNOT_RUN');
    assert.ok(nonExistentResult.output.includes('존재하지 않습니다'));

    // 5. Shell command injection attempt -> CANNOT_RUN
    const injectionResult = await core.runReproduction(jsRepo, inc.id, 'pass_test.js; exit 1');
    assert.strictEqual(injectionResult.status, 'CANNOT_RUN');
    assert.ok(injectionResult.output.includes('유효하지 않은 테스트 파일 경로'));
  });

  test('49. Step-3-Fixture 1: Python project known bug localization and cause certainty check', async () => {
    const fixtureRepo = path.join(testRoot, 'fixture_python_known_bug');
    fs.mkdirSync(path.join(fixtureRepo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fixtureRepo, 'tests'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: fixtureRepo });

    // Known bug in src/calc.py: line 4 has the bug (calculates 2x tax instead of 1x)
    const code = [
      'def calculate_tax(amount, rate):',
      '    if rate < 0:',
      '        raise ValueError("Invalid rate")',
      '    return amount * rate * 2  # Known bug on line 4',
      'def is_valid_rate(rate):',
      '    return rate >= 0',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(fixtureRepo, 'src', 'calc.py'), code);

    execFileSync('git', ['add', '.'], { cwd: fixtureRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit with known Python bug'], { cwd: fixtureRepo });

    const diff = `diff --git a/src/calc.py b/src/calc.py
--- a/src/calc.py
+++ b/src/calc.py
@@ -4,1 +4,1 @@
-    return amount * rate
+    return amount * rate * 2  # Known bug on line 4
`;

    // Python traceback pointing directly to line 4
    const errorOutput = `Traceback (most recent call last):
  File "tests/test_calc.py", line 12, in test_tax
    self.assertEqual(calculate_tax(100, 0.1), 10.0)
  File "src/calc.py", line 4, in calculate_tax
    return amount * rate * 2
AssertionError: 20.0 != 10.0`;

    // Run analyzer WITHOUT execution evidence
    const analysis = analyzeIncident(errorOutput, diff, fixtureRepo, 'py-fixture', 'HEAD');

    // 1. Known bug line/file must be in top 5 candidates
    assert.ok(analysis.candidates.length > 0, 'Must produce candidates');
    const top5 = analysis.candidates.slice(0, 5);
    const foundBugCandidate = top5.find(
      (c) => c.filePath.includes('src/calc.py') && c.ranges.some((r) => 4 >= r.start && 4 <= r.end)
    );
    assert.ok(foundBugCandidate, 'Known bug at src/calc.py line 4 must be among top 5 candidates');

    // 2. Without execution evidence, causeVerdict must NOT be CONFIRMED (must be capped at LIKELY)
    assert.notStrictEqual(analysis.causeVerdict, 'CONFIRMED', 'Must not be CONFIRMED without execution evidence');
    assert.strictEqual(analysis.causeVerdict, 'LIKELY');
  });

  test('50. Step-3-Fixture 2: JavaScript project known bug localization and cause certainty check', async () => {
    const fixtureRepo = path.join(testRoot, 'fixture_js_known_bug');
    fs.mkdirSync(path.join(fixtureRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: fixtureRepo });

    // Known bug in src/formatter.js: line 4 has the bug
    const code = [
      'function formatPrice(amount, currency) {',
      '  if (amount < 0) return "Invalid";',
      '  // Known bug on line 4: multiplier bug',
      '  return currency + " " + (amount * 100);',
      '}',
      'module.exports = { formatPrice };',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(fixtureRepo, 'src', 'formatter.js'), code);

    execFileSync('git', ['add', '.'], { cwd: fixtureRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit with known JS bug'], { cwd: fixtureRepo });

    const diff = `diff --git a/src/formatter.js b/src/formatter.js
--- a/src/formatter.js
+++ b/src/formatter.js
@@ -4,1 +4,1 @@
-  return currency + " " + amount;
+  return currency + " " + (amount * 100);
`;

    const errorOutput = `AssertionError [ERR_ASSERTION]: Expected 'USD 10' but got 'USD 1000'
    at TestContext.<anonymous> (test/formatter.test.js:8:12)
    at Object.formatPrice (src/formatter.js:4:27)
    at runTest (node:internal/test_runner/test:42:10)`;

    // Run analyzer WITHOUT execution evidence
    const analysis = analyzeIncident(errorOutput, diff, fixtureRepo, 'js-fixture', 'HEAD');

    // 1. Known bug line/file must be in top 5 candidates
    assert.ok(analysis.candidates.length > 0, 'Must produce candidates');
    const top5 = analysis.candidates.slice(0, 5);
    const foundBugCandidate = top5.find(
      (c) => c.filePath.includes('src/formatter.js') && c.ranges.some((r) => 4 >= r.start && 4 <= r.end)
    );
    assert.ok(foundBugCandidate, 'Known bug at src/formatter.js line 4 must be among top 5 candidates');

    // 2. Without execution evidence, causeVerdict must NOT be CONFIRMED (must be capped at LIKELY)
    assert.notStrictEqual(analysis.causeVerdict, 'CONFIRMED', 'Must not be CONFIRMED without execution evidence');
    assert.strictEqual(analysis.causeVerdict, 'LIKELY');
  });

  test('51. Step-3-Fixture 3: C++(GoogleTest) error output parsing - localization and cause certainty check', async () => {
    const fixtureRepo = path.join(testRoot, 'fixture_cpp_known_bug');
    fs.mkdirSync(path.join(fixtureRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: fixtureRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: fixtureRepo });

    const code = [
      '#include <iostream>',
      'int calculate_area(int w, int h) {',
      '    return w + h; // Bug on line 3: should be w * h',
      '}',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(fixtureRepo, 'src', 'matrix.cpp'), code);
    execFileSync('git', ['add', '.'], { cwd: fixtureRepo });
    execFileSync('git', ['commit', '-m', 'Initial commit with known C++ bug'], { cwd: fixtureRepo });

    const diff = `diff --git a/src/matrix.cpp b/src/matrix.cpp
--- a/src/matrix.cpp
+++ b/src/matrix.cpp
@@ -3,1 +3,1 @@
-    return w * h;
+    return w + h; // Bug on line 3: should be w * h
`;

    const errorOutput = `src/matrix.cpp:3: Failure
Expected equality of these values:
  calculate_area(5, 4)
    Which is: 9
  20`;

    const analysis = analyzeIncident(errorOutput, diff, fixtureRepo, 'cpp-fixture', 'HEAD');
    const top5 = analysis.candidates.slice(0, 5);
    const foundBugCandidate = top5.find(
      (c) => c.filePath.includes('src/matrix.cpp') && c.ranges.some((r) => 3 >= r.start && 3 <= r.end)
    );
    assert.ok(foundBugCandidate, 'Known bug at src/matrix.cpp line 3 must be among top 5 candidates');
    assert.notStrictEqual(analysis.causeVerdict, 'CONFIRMED', 'Must not be CONFIRMED without execution evidence');
    assert.strictEqual(analysis.causeVerdict, 'LIKELY');
  });

  test('52. Step 4: search_history, get_incident_attempts, and get_changes_since_good_checkpoint return concise summaries under 2KB', async () => {
    const s4Repo = path.join(testRoot, 's4_history_repo');
    fs.mkdirSync(path.join(s4Repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: s4Repo });
    fs.writeFileSync(path.join(s4Repo, 'src', 'index.js'), 'console.log("v1");\n');
    execFileSync('git', ['add', '.'], { cwd: s4Repo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: s4Repo });

    // Capture clean baseline checkpoint
    const cp = core.captureCheckpoint(s4Repo, 'Initial clean checkpoint', 'tester');

    // Register 12 past incidents to test 10-item cap
    const project = core.ensureProject(s4Repo);
    for (let i = 1; i <= 12; i++) {
      await core.collectIncidentBundle(s4Repo, {
        title: `과거 결제 버그 #${i} - 쿠폰 할인 계산 오작동`,
        userReportText: `사용자가 VIP 쿠폰 결제 시 할인이 정상 적용되지 않는다고 신고함 #${i}`,
        expectedBehavior: '쿠폰 할인 적용',
        observedBehavior: '정가 결제됨',
        reproductionCondition: 'VIP 쿠폰 입력 시',
        verificationMethod: '할인율 확인',
      });
    }

    // 1. searchHistory test: max 10 items, < 2KB payload
    const history = core.searchHistory(s4Repo, ['src/index.js'], ['쿠폰', '할인']);
    assert.ok(history.length <= 10, 'History search must return at most 10 items');
    const historyJson = JSON.stringify(history);
    assert.ok(Buffer.byteLength(historyJson, 'utf8') < 2048, `History payload must be < 2KB (was ${Buffer.byteLength(historyJson, 'utf8')} bytes)`);

    // Register a rejected proposal with reason
    const incs = core.getDatabase().listIncidents(project.id);
    const targetInc = incs[0];
    const proposalId = `prop_s4_${Date.now()}`;
    core.getDatabase().insertRepairProposal({
      id: proposalId,
      incidentId: targetInc.id,
      rootCauseAnalysis: '잘못된 할인 계산식 수정안 (임시)',
      patchDiff: '--- a/src/index.js\n+++ b/src/index.js\n@@ -1,1 +1,1 @@\n-console.log("v1");\n+console.log("v2");',
      fileChangesJson: '[]',
      touchedFiles: ['src/index.js'],
      verificationStatus: 'VERIFIED_FAIL',
      verificationLog: 'AssertionError: 할인 금액 불일치',
      approvalStatus: 'REJECTED',
      rejectionReason: '요구사항과 맞지 않는 불필요한 파일 변경 포함',
      approvedAt: null,
      appliedAt: null,
      createdAt: new Date().toISOString(),
    });

    // 2. getIncidentAttempts test: returns rejected/failed attempts with failure reason under 2KB
    const attempts = core.getIncidentAttempts(targetInc.id);
    assert.ok(attempts.length >= 1, 'Must return rejected/failed attempts');
    assert.strictEqual(attempts[0].status, 'REJECTED');
    assert.ok(attempts[0].failureReason?.includes('불필요한 파일 변경'), 'Must capture rejection reason');
    const attemptsJson = JSON.stringify(attempts);
    assert.ok(Buffer.byteLength(attemptsJson, 'utf8') < 2048, `Attempts payload must be < 2KB (was ${Buffer.byteLength(attemptsJson, 'utf8')} bytes)`);

    // Make an uncommitted change and check changes since good checkpoint
    fs.appendFileSync(path.join(s4Repo, 'src', 'index.js'), 'console.log("dirty line 1");\nconsole.log("dirty line 2");\n');
    const changes = core.getChangesSinceGoodCheckpoint(s4Repo);
    assert.strictEqual(changes.checkpointId, cp.id);
    assert.ok(changes.totalAdded >= 2, 'Must count added lines');
    assert.ok(changes.summary.includes(cp.label), 'Summary must reference checkpoint label');
    const changesJson = JSON.stringify(changes);
    assert.ok(Buffer.byteLength(changesJson, 'utf8') < 2048, `Changes payload must be < 2KB (was ${Buffer.byteLength(changesJson, 'utf8')} bytes)`);
  });

  test('53. Step 4: collect_incident_bundle with all 4 intents registers without questions and proceeds directly', async () => {
    const s4Repo = path.join(testRoot, 's4_intent_complete_repo');
    fs.mkdirSync(path.join(s4Repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: s4Repo });
    fs.writeFileSync(path.join(s4Repo, 'src', 'calc.js'), 'module.exports = { add: (a, b) => a - b };\n');
    execFileSync('git', ['add', '.'], { cwd: s4Repo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: s4Repo });

    const userReportText = '더하기 함수 add(1, 2)를 호출했는데 3이 아니라 -1이 나옵니다. 테스트 코드로 결과를 확인해주세요.';
    const incident = await core.collectIncidentBundle(s4Repo, {
      title: 'add(1, 2) 호출 시 -1 반환 버그',
      userReportText,
      expectedBehavior: 'add(1, 2) 호출 시 3이 반환되어야 함',
      observedBehavior: '-1이 나옵니다', // directly in userReportText -> USER_QUOTE
      reproductionCondition: 'add(1, 2) 실행 시',
      verificationMethod: '테스트 코드로 결과를 확인', // directly in userReportText -> USER_QUOTE
    });

    // 1. All 4 intents are present: missingIntents must be empty
    assert.strictEqual(incident.missingIntents?.length, 0, 'missingIntents must be empty when all 4 are provided');
    assert.strictEqual(incident.userConfirmedIntent, true, 'userConfirmedIntent must be true');

    // 2. Provenance must identify USER_QUOTE vs AI_INFERRED
    assert.ok(incident.intents, 'Structured intents must exist');
    assert.strictEqual(incident.intents.observedBehavior.source, 'USER_QUOTE');
    assert.strictEqual(incident.intents.verificationMethod.source, 'USER_QUOTE');
    assert.strictEqual(incident.intents.reproductionCondition.source, 'AI_INFERRED');

    // 3. next_action must direct to proceed with reproduction or repair without asking questions
    const nextAction = core.getIncidentNextAction(incident);
    assert.strictEqual(nextAction.actor, 'AGENT');
    assert.strictEqual(nextAction.action, 'RUN_REPRODUCTION_OR_PROPOSE_REPAIR');
    assert.strictEqual(nextAction.missing_fields, undefined);

    // 4. Strict USER_QUOTE check: AI-synthesized sentence with scattered user words MUST be AI_INFERRED
    const userReportMixed = '장바구니 결제 시 오류가 발생합니다.';
    const incidentMixed = await core.collectIncidentBundle(s4Repo, {
      title: 'AI 합성 문장 테스트',
      userReportText: userReportMixed,
      expectedBehavior: '정상 결제',
      observedBehavior: '사용자가 장바구니에서 결제를 진행할 때 오류가 나는 상태',
      reproductionCondition: '결제 진행 시',
      verificationMethod: '결제 확인',
    });
    assert.strictEqual(
      incidentMixed.intents?.observedBehavior.source,
      'AI_INFERRED',
      'AI-synthesized sentence with scattered user words must be classified as AI_INFERRED'
    );
    assert.strictEqual(
      incidentMixed.intents?.observedBehavior.quote,
      undefined,
      'AI_INFERRED must not have quote'
    );

    // 5. Without userReportText: all intents must be AI_INFERRED, 0 USER_QUOTE, userReportText is '없음', and next_action.action is 'PROVIDE_USER_REPORT'
    const incidentNoReport = await core.collectIncidentBundle(s4Repo, {
      title: '더하기 함수 add(1, 2)를 호출했는데 3이 아니라 -1이 나옵니다. 테스트 코드로 결과를 확인해주세요.',
      expectedBehavior: '3이 반환되어야 함',
      observedBehavior: '-1이 나옵니다',
      reproductionCondition: 'add(1, 2) 실행 시',
      verificationMethod: '테스트 코드로 결과를 확인',
    });
    assert.strictEqual(incidentNoReport.userReportText, '없음');
    assert.ok(incidentNoReport.intents);
    const quotes = Object.values(incidentNoReport.intents).filter((i: any) => i.source === 'USER_QUOTE');
    assert.strictEqual(quotes.length, 0, '원문 없이 보내면 USER_QUOTE가 하나도 안 나와야 함 (title을 원문으로 쓰지 않음)');
    assert.strictEqual(incidentNoReport.intents.observedBehavior.source, 'AI_INFERRED');
    assert.strictEqual(incidentNoReport.intents.verificationMethod.source, 'AI_INFERRED');
    const nextActionNoReport = core.getIncidentNextAction(incidentNoReport);
    assert.strictEqual(nextActionNoReport.actor, 'USER');
    assert.strictEqual(nextActionNoReport.action, 'PROVIDE_USER_REPORT');
    assert.ok(nextActionNoReport.agent_should.includes('userReportText') || nextActionNoReport.agent_should.includes('원문'));
  });

  test('54. Step 4: collect_incident_bundle with missing intent(s) registers and outputs next_action.action: CLARIFY_INTENT with only missing fields', async () => {
    const s4Repo = path.join(testRoot, 's4_intent_missing_repo');
    fs.mkdirSync(path.join(s4Repo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: s4Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: s4Repo });
    fs.writeFileSync(path.join(s4Repo, 'src', 'calc.js'), 'module.exports = {};\n');
    execFileSync('git', ['add', '.'], { cwd: s4Repo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: s4Repo });

    const userReportText = '로그인이 안 돼요.';
    // Provide expected and observed behavior, but omit reproductionCondition and verificationMethod
    const incident = await core.collectIncidentBundle(s4Repo, {
      title: '로그인이 안 돼요.',
      userReportText,
      expectedBehavior: '로그인 성공 후 대시보드로 이동',
      observedBehavior: '로그인이 안 돼요.',
      reproductionCondition: '', // MISSING
      verificationMethod: undefined, // MISSING
    });

    // 1. Incident must be registered in DB (not thrown)
    assert.ok(incident.id, 'Incident must be registered successfully');
    assert.strictEqual(incident.missingIntents?.length, 2);
    assert.ok(incident.missingIntents?.includes('reproductionCondition'));
    assert.ok(incident.missingIntents?.includes('verificationMethod'));
    assert.strictEqual(incident.userConfirmedIntent, false);

    // 2. next_action must be CLARIFY_INTENT with only the missing fields
    const nextAction = core.getIncidentNextAction(incident);
    assert.strictEqual(nextAction.actor, 'USER');
    assert.strictEqual(nextAction.action, 'CLARIFY_INTENT');
    assert.deepStrictEqual(nextAction.missing_fields, ['reproductionCondition', 'verificationMethod']);
    assert.ok(nextAction.agent_should.includes('reproductionCondition'));
    assert.ok(nextAction.agent_should.includes('verificationMethod'));
    assert.ok(!nextAction.agent_should.includes('expectedBehavior'), 'Must NOT ask for expectedBehavior since it was provided');
  });

  test('55. Step 4: Multi-Process Real MCP server enforces next_action on all 17 tools and clarifies review completion is NOT user approval', async () => {
    const monorepoRoot = fs.existsSync(path.resolve(process.cwd(), 'packages/mcp-server'))
      ? process.cwd()
      : path.resolve(process.cwd(), '../..');
    const mcpDistScript = path.resolve(monorepoRoot, 'packages/mcp-server/dist/index.js');

    // Helper: start live MCP server session over stdio
    const startMcpSession = (env: NodeJS.ProcessEnv): Promise<{ callTool: (name: string, args: any) => Promise<{ text: string; isError?: boolean }>; close: () => void }> => {
      return new Promise((resolve, reject) => {
        const cp = spawn('node', [mcpDistScript], {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdoutBuf = '';
        let isInitialized = false;
        let nextId = 2;
        const pendingRequests = new Map<number, (res: { text: string; isError?: boolean }) => void>();

        cp.stdout.on('data', (chunk) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === 1 && !isInitialized) {
                isInitialized = true;
                cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
                resolve({
                  callTool: (toolName: string, args: any) => {
                    return new Promise<{ text: string; isError?: boolean }>((resTool) => {
                      const reqId = nextId++;
                      pendingRequests.set(reqId, resTool);
                      cp.stdin.write(
                        JSON.stringify({
                          jsonrpc: '2.0',
                          id: reqId,
                          method: 'tools/call',
                          params: { name: toolName, arguments: args },
                        }) + '\n'
                      );
                    });
                  },
                  close: () => cp.kill(),
                });
              } else if (msg.id && pendingRequests.has(msg.id)) {
                const resTool = pendingRequests.get(msg.id)!;
                pendingRequests.delete(msg.id);
                const text = msg.result?.content?.[0]?.text || '';
                resTool({ text, isError: msg.result?.isError });
              }
            } catch {}
          }
        });

        cp.on('error', reject);
        cp.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'test-harness', version: '1.0' },
            },
          }) + '\n'
        );
      });
    };

    const tempSharedDataDir = path.join(testRoot, 'mcp_17_tools_data');
    fs.mkdirSync(tempSharedDataDir, { recursive: true });
    const session = await startMcpSession({ AUTOPSY_DATA_DIR: tempSharedDataDir });

    const mcpRepo = path.join(testRoot, 'mcp_17_tools_repo');
    fs.mkdirSync(path.join(mcpRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: mcpRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: mcpRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: mcpRepo });
    fs.writeFileSync(path.join(mcpRepo, 'src', 'app.js'), 'console.log("hello");\n');
    execFileSync('git', ['add', '.'], { cwd: mcpRepo });
    execFileSync('git', ['commit', '-m', 'Init commit'], { cwd: mcpRepo });

    const toolCalls = [
      { name: 'capture_checkpoint', args: { repoPath: mcpRepo, label: 'test checkpoint' } },
      { name: 'inspect_project_state', args: { repoPath: mcpRepo } },
      { name: 'collect_incident_bundle', args: { repoPath: mcpRepo, title: 'MCP Inc', userReportText: '오류 발생', errorOutput: 'Err' } },
      { name: 'propose_test_command', args: { repoPath: mcpRepo, command: 'npm test', reason: 'unit' } },
      { name: 'propose_and_verify_repair', args: { incidentId: 'invalid_id', rootCauseAnalysis: 'r', fileChanges: [] } },
      { name: 'apply_approved_repair', args: { proposalId: 'invalid_prop', repoPath: mcpRepo } },
      { name: 'rollback_to_checkpoint', args: { checkpointId: 'invalid_cp', repoPath: mcpRepo } },
      { name: 'record_agent_event', args: { repoPath: mcpRepo, kind: 'NOTE', title: 'ev' } },
      { name: 'submit_orchestration_review', args: { proposalId: 'prop_dummy', repoPath: mcpRepo, reviewer: 'rev', findings: ['f'] } },
      { name: 'request_review_challenge', args: { proposalId: 'prop_dummy', repoPath: mcpRepo } },
      { name: 'await_user_decision', args: { proposalId: 'prop_dummy', repoPath: mcpRepo, timeoutSec: 1 } },
      { name: 'get_pending_directives', args: { repoPath: mcpRepo } },
      { name: 'acknowledge_directive', args: { directiveId: 'dir_dummy' } },
      { name: 'run_reproduction', args: { incidentId: 'inc_dummy', testFilePath: 'nonexistent/file.js', repoPath: mcpRepo } },
      { name: 'search_history', args: { repoPath: mcpRepo } },
      { name: 'get_incident_attempts', args: { incidentId: 'inc_dummy' } },
      { name: 'get_changes_since_good_checkpoint', args: { repoPath: mcpRepo } },
    ];

    assert.strictEqual(toolCalls.length, 17, 'Must test exactly all 17 MCP tools');

    for (const tc of toolCalls) {
      const res = await session.callTool(tc.name, tc.args);
      assert.ok(res.text && res.text.length > 0, `Tool ${tc.name} returned empty text`);
      const data = JSON.parse(res.text);
      assert.ok(data.next_action, `Tool ${tc.name} response must contain next_action: ${res.text}`);
      assert.ok(['USER', 'AGENT', 'SUBAGENT'].includes(data.next_action.actor), `Tool ${tc.name} next_action.actor invalid`);
      assert.ok(typeof data.next_action.action === 'string' && data.next_action.action.length > 0, `Tool ${tc.name} next_action.action missing`);
      assert.ok(typeof data.next_action.agent_should === 'string' && data.next_action.agent_should.length > 0, `Tool ${tc.name} next_action.agent_should missing`);
      assert.ok(Array.isArray(data.next_action.forbidden), `Tool ${tc.name} next_action.forbidden must be array`);
    }

    session.close();
  });

  test('56. Dashboard lastTestStatus excludes isolated worktree VERIFIED_PASS and requires actual resolution', async () => {
    const s56Repo = path.join(testRoot, 's56_overview_repo');
    fs.mkdirSync(s56Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: s56Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: s56Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: s56Repo });
    fs.writeFileSync(path.join(s56Repo, 'package.json'), JSON.stringify({ name: 's56', scripts: { test: 'node test.js' } }));
    fs.writeFileSync(path.join(s56Repo, 'calc.js'), 'function div(a, b) { return a / b; }\nmodule.exports = { div };\n');
    fs.writeFileSync(
      path.join(s56Repo, 'test.js'),
      'const { div } = require("./calc");\nif (div(4, 2) !== 2) process.exit(1);\nif (div(4, 0) !== 0) process.exit(1);\nconsole.log("PASS");\n'
    );
    execFileSync('git', ['add', '.'], { cwd: s56Repo });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: s56Repo });

    // Confirm test command so proposeAndVerifyRepair is allowed
    core.confirmTestCommand(s56Repo, 'node test.js');

    // 1. Collect incident bundle (div(4, 0) fails on workspace)
    const incident = await core.collectIncidentBundle(s56Repo, {
      title: 'Zero division error in div(4, 0)',
      userReportText: '0으로 나눌 때 에러가 발생합니다.',
      expectedBehavior: '0 반환',
      observedBehavior: 'Infinity 반환',
      reproductionCondition: 'div(4, 0) 호출 시',
      verificationMethod: 'node test.js 실행',
    });

    // Overview immediately after incident collection: open incident exists
    const overviewAfterIncident = core.getOverview(s56Repo);
    assert.strictEqual(overviewAfterIncident.stats.openIncidents, 1);
    assert.strictEqual(overviewAfterIncident.stats.lastTestStatus, 'FAIL');

    // 2. Propose and verify repair in isolated worktree -> VERIFIED_PASS
    const { proposal } = await core.proposeAndVerifyRepair(
      s56Repo,
      incident.id,
      'Fix division by zero to return 0',
      [
        {
          filePath: 'calc.js',
          replacements: [
            {
              search: 'return a / b;',
              replace: 'if (b === 0) return 0;\n  return a / b;',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    assert.strictEqual(proposal.approvalStatus, 'AWAITING_USER');

    // CRITICAL: Overview while patch is only VERIFIED_PASS in isolated worktree (unapproved, unapplied)
    // The workspace is still broken, and the incident is still open!
    // lastTestStatus MUST NOT be 'PASS'!
    const overviewAfterIsolatedPass = core.getOverview(s56Repo);
    assert.strictEqual(overviewAfterIsolatedPass.stats.openIncidents, 1);
    assert.notStrictEqual(
      overviewAfterIsolatedPass.stats.lastTestStatus,
      'PASS',
      'lastTestStatus must NOT be PASS when isolated repair passed but workspace is still unpatched and incident is open'
    );
    assert.strictEqual(
      overviewAfterIsolatedPass.stats.lastTestStatus,
      'FAIL',
      'lastTestStatus must reflect actual workspace incident status (FAIL)'
    );

    // 3. User approves and applies repair to workspace
    core.approveProposal(proposal.id);
    core.applyApprovedRepair(s56Repo, proposal.id);

    // Overview after approval and application: incident is RESOLVED and openIncidents is 0
    const overviewAfterApply = core.getOverview(s56Repo);
    assert.strictEqual(overviewAfterApply.stats.openIncidents, 0);
    assert.strictEqual(
      overviewAfterApply.stats.lastTestStatus,
      'PASS',
      'lastTestStatus must be PASS after patch is applied to workspace and incident is RESOLVED'
    );
  });

  test('57. Step-3-Check: PRAGMA data_version based db_sync emission on external write and MCP subprocess SSE notification', async () => {
    const s57DataDir = path.join(testRoot, 's57_test_data');
    const s57CacheDir = path.join(testRoot, 's57_test_cache');
    fs.mkdirSync(s57DataDir, { recursive: true });
    fs.mkdirSync(s57CacheDir, { recursive: true });
    const s57DbPath = path.join(s57DataDir, 'autopsy.db');

    const s57Core = new CoreManager({
      customDbPath: s57DbPath,
    });
    s57Core.ensureProject(repoPath);

    const prevDataDir = process.env.AUTOPSY_DATA_DIR;
    const prevCacheDir = process.env.AUTOPSY_CACHE_DIR;
    process.env.AUTOPSY_DATA_DIR = s57DataDir;
    process.env.AUTOPSY_CACHE_DIR = s57CacheDir;

    const apiServer = new ApiServer(s57Core);
    const port = await apiServer.start(3874);
    const token = apiServer.getSessionToken();

    let sseReq: http.ClientRequest | null = null;
    try {
      const allEvents: any[] = [];
      const syncEvents: any[] = [];
      sseReq = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/stream',
          method: 'GET',
          headers: {
            'X-Autopsy-Token': token,
          },
        },
        (res) => {
          res.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  allEvents.push(data);
                  if (data.type === 'db_sync') {
                    syncEvents.push(data);
                  }
                } catch {}
              }
            }
          });
        }
      );
      sseReq.end();

      // Wait 100ms for SSE connection to establish
      await new Promise((r) => setTimeout(r, 100));

      // 1. Idle check: over 2.2 seconds (longer than 1.5s interval), NO db_sync should be emitted if DB is unchanged
      await new Promise((r) => setTimeout(r, 2200));
      assert.strictEqual(
        syncEvents.length,
        0,
        `Expected 0 db_sync events during idle, but received ${syncEvents.length}`
      );

      // 2. External DB write check: an independent SQLite connection writes to the database
      const externalDb = new DatabaseSync(s57DbPath);
      externalDb.exec("INSERT INTO agent_sessions (agent_name, session_id, last_seen_at, status, last_action) VALUES ('ext-agent-57', 'ext-sess-57', '2026-10-27T00:00:00Z', 'ACTIVE', 'TEST');");
      externalDb.close();

      // Within 2.0s (server sync timer is 1.5s), the server should detect data_version change and emit db_sync
      await new Promise((r) => setTimeout(r, 2000));
      assert.ok(
        syncEvents.length >= 1,
        `Expected at least 1 db_sync event within 2.0s after external DB write, but got ${syncEvents.length}`
      );

      // 3. Subsequent idle check: no further writes, so no new db_sync should be emitted
      const countAfterWrite = syncEvents.length;
      await new Promise((r) => setTimeout(r, 2200));
      assert.strictEqual(
        syncEvents.length,
        countAfterWrite,
        `Expected no new db_sync events during subsequent idle, but count increased from ${countAfterWrite} to ${syncEvents.length}`
      );

      // 4. Real MCP Server subprocess check (Criterion 2):
      // When external MCP server subprocess registers an incident, it notifies the server and SSE delivers incident_created
      const monorepoRoot = fs.existsSync(path.resolve(process.cwd(), 'packages/mcp-server'))
        ? process.cwd()
        : path.resolve(process.cwd(), '../..');
      const mcpDistScript = path.resolve(monorepoRoot, 'packages/mcp-server/dist/index.js');
      if (!fs.existsSync(mcpDistScript)) {
        throw new Error(`mcp-server를 먼저 빌드하라: "${mcpDistScript}" 파일이 존재하지 않습니다.`);
      }

      let timeoutId: NodeJS.Timeout | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const cp = spawn(process.execPath, [mcpDistScript], {
            env: {
              ...process.env,
              AUTOPSY_DATA_DIR: s57DataDir,
              AUTOPSY_CACHE_DIR: s57CacheDir,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          timeoutId = setTimeout(() => {
            try {
              cp.kill();
            } catch {}
            reject(new Error('MCP 자식 프로세스 실행 시간 초과 (30초)'));
          }, 30000);

          let stdoutBuf = '';
          let hasInitialized = false;

          cp.stdout.on('data', (chunk) => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.id === 1 && !hasInitialized) {
                  hasInitialized = true;
                  cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
                  cp.stdin.write(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: 2,
                      method: 'tools/call',
                      params: {
                        name: 'collect_incident_bundle',
                        arguments: {
                          repoPath,
                          title: 'MCP 프로세스 실시간 SSE 알림 테스트 57',
                          userReportText: 'MCP 프로세스 실시간 SSE 알림 테스트 원문',
                          errorOutput: 'AssertionError: mcp sse test',
                        },
                      },
                    }) + '\n'
                  );
                } else if (msg.id === 2) {
                  if (timeoutId) clearTimeout(timeoutId);
                  setTimeout(() => {
                    try {
                      cp.kill();
                    } catch {}
                    resolve();
                  }, 200);
                  return;
                }
              } catch {}
            }
          });

          cp.on('error', (err) => {
            if (timeoutId) clearTimeout(timeoutId);
            reject(err);
          });
          cp.on('exit', (code) => {
            if (!hasInitialized && code !== 0 && code !== null) {
              if (timeoutId) clearTimeout(timeoutId);
              reject(new Error(`MCP process exited with code ${code}`));
            }
          });

          cp.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'test-harness', version: '1.0' },
              },
            }) + '\n'
          );
        });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      // Wait a short moment for cross-process SSE event propagation
      await new Promise((r) => setTimeout(r, 600));
      const incidentEvent = allEvents.find((e) => e.type === 'incident_created');
      assert.ok(incidentEvent, 'Real MCP server subprocess must notify ApiServer and deliver incident_created over SSE');
      assert.strictEqual(incidentEvent.data.title, 'MCP 프로세스 실시간 SSE 알림 테스트 57');
    } finally {
      process.env.AUTOPSY_DATA_DIR = prevDataDir;
      process.env.AUTOPSY_CACHE_DIR = prevCacheDir;
      if (sseReq) {
        sseReq.destroy();
      }
      await apiServer.stop();
    }
  });

  test('58. Step-4-T2: unapproved files list matches expected baseline before and after diff batching', async () => {
    const t2Repo = path.join(testRoot, 't2_unapproved_batch_repo');
    fs.mkdirSync(t2Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: t2Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: t2Repo });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: t2Repo });

    fs.writeFileSync(path.join(t2Repo, 'file_a.txt'), 'line a1\nline a2\n');
    fs.writeFileSync(path.join(t2Repo, 'file_b.txt'), 'line b1\nline b2\n');
    fs.writeFileSync(path.join(t2Repo, 'file_c.txt'), 'line c1\nline c2\n');
    fs.writeFileSync(path.join(t2Repo, 'file_d.txt'), 'line d1\nline d2\n');
    execFileSync('git', ['add', '.'], { cwd: t2Repo });
    execFileSync('git', ['commit', '-m', 'initial files'], { cwd: t2Repo });

    core.ensureProject(t2Repo);
    await core.captureCheckpoint(t2Repo, 't2 baseline checkpoint');

    // 1. Modify file_a (tracked, modified from checkpoint) -> MUST be unapproved
    fs.appendFileSync(path.join(t2Repo, 'file_a.txt'), 'modified line a3\n');

    // 2. Keep file_b untouched
    // 3. Keep file_c untouched

    // 4. Modify file_d and git add it -> MUST be unapproved
    fs.appendFileSync(path.join(t2Repo, 'file_d.txt'), 'modified line d3\n');
    execFileSync('git', ['add', 'file_d.txt'], { cwd: t2Repo });

    // 5. Create new tracked file (not in checkpoint) -> MUST be unapproved
    fs.writeFileSync(path.join(t2Repo, 'new_tracked.txt'), 'new tracked file\n');
    execFileSync('git', ['add', 'new_tracked.txt'], { cwd: t2Repo });

    // 6. Create new untracked files (not in checkpoint) -> MUST be unapproved
    fs.writeFileSync(path.join(t2Repo, 'untracked_1.txt'), 'untracked 1\n');
    fs.writeFileSync(path.join(t2Repo, 'untracked_2.txt'), 'untracked 2\n');

    const health = core.inspectProjectState(t2Repo);
    const unapproved = (health.unapprovedFiles || []).map((f) => f.replace(/\\/g, '/')).sort();

    const expected = [
      'file_a.txt',
      'file_d.txt',
      'new_tracked.txt',
      'untracked_1.txt',
      'untracked_2.txt',
    ].sort();

    assert.deepStrictEqual(
      unapproved,
      expected,
      'Unapproved files list must match the expected unbatched baseline'
    );
  });

  test('59. Step-4-T1: getOverviewAsync results match synchronous getOverview across clean and dirty states', async () => {
    // 1. Clean repository test
    const cleanRepo = path.join(testRoot, 't1_clean_repo');
    fs.mkdirSync(cleanRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: cleanRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: cleanRepo });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: cleanRepo });
    fs.writeFileSync(path.join(cleanRepo, 'clean.txt'), 'clean\n');
    execFileSync('git', ['add', '.'], { cwd: cleanRepo });
    execFileSync('git', ['commit', '-m', 'clean commit'], { cwd: cleanRepo });

    const cleanSync = core.getOverview(cleanRepo);
    const cleanAsync = await (core as any).getOverviewAsync(cleanRepo);

    // Normalize: exclude dynamic / volatile fields (quarantineBackupRef, timestamp, etc.)
    const normalize = (ov: any) => {
      const copy = JSON.parse(JSON.stringify(ov));
      if (copy.health) {
        delete copy.health.quarantineBackupRef;
      }
      return copy;
    };

    assert.deepStrictEqual(
      normalize(cleanAsync),
      normalize(cleanSync),
      'Clean repo: getOverviewAsync must match getOverview'
    );

    // 2. Dirty repository with checkpoint (3+ tracked changed, 2+ untracked)
    const dirtyRepo = path.join(testRoot, 't1_dirty_repo');
    fs.mkdirSync(dirtyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dirtyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dirtyRepo });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: dirtyRepo });
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dirtyRepo, `file_${i}.txt`), `initial ${i}\n`);
    }
    execFileSync('git', ['add', '.'], { cwd: dirtyRepo });
    execFileSync('git', ['commit', '-m', 'dirty initial commit'], { cwd: dirtyRepo });

    core.ensureProject(dirtyRepo);
    await core.captureCheckpoint(dirtyRepo, 'checkpoint before edits');

    // 3 tracked files modified
    fs.appendFileSync(path.join(dirtyRepo, 'file_1.txt'), 'edit 1\n');
    fs.appendFileSync(path.join(dirtyRepo, 'file_2.txt'), 'edit 2\n');
    fs.appendFileSync(path.join(dirtyRepo, 'file_3.txt'), 'edit 3\n');
    // 2 untracked files added
    fs.writeFileSync(path.join(dirtyRepo, 'untracked_a.txt'), 'untracked a\n');
    fs.writeFileSync(path.join(dirtyRepo, 'untracked_b.txt'), 'untracked b\n');

    const dirtySync = core.getOverview(dirtyRepo);
    const dirtyAsync = await (core as any).getOverviewAsync(dirtyRepo);

    assert.deepStrictEqual(
      normalize(dirtyAsync),
      normalize(dirtySync),
      'Dirty repo with checkpoint: getOverviewAsync must match getOverview'
    );

    // 3. Dirty repository without checkpoint (3+ tracked changed, 2+ untracked)
    const dirtyNoCpRepo = path.join(testRoot, 't1_dirty_nocp_repo');
    fs.mkdirSync(dirtyNoCpRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: dirtyNoCpRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: dirtyNoCpRepo });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: dirtyNoCpRepo });
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(path.join(dirtyNoCpRepo, `doc_${i}.txt`), `doc ${i}\n`);
    }
    execFileSync('git', ['add', '.'], { cwd: dirtyNoCpRepo });
    execFileSync('git', ['commit', '-m', 'nocp initial commit'], { cwd: dirtyNoCpRepo });

    fs.appendFileSync(path.join(dirtyNoCpRepo, 'doc_1.txt'), 'mod 1\n');
    fs.appendFileSync(path.join(dirtyNoCpRepo, 'doc_2.txt'), 'mod 2\n');
    fs.appendFileSync(path.join(dirtyNoCpRepo, 'doc_3.txt'), 'mod 3\n');
    fs.writeFileSync(path.join(dirtyNoCpRepo, 'new_1.txt'), 'new 1\n');
    fs.writeFileSync(path.join(dirtyNoCpRepo, 'new_2.txt'), 'new 2\n');

    const noCpSync = core.getOverview(dirtyNoCpRepo);
    const noCpAsync = await (core as any).getOverviewAsync(dirtyNoCpRepo);

    assert.deepStrictEqual(
      normalize(noCpAsync),
      normalize(noCpSync),
      'Dirty repo without checkpoint: getOverviewAsync must match getOverview'
    );
  });

  test('60. Step-4-T3: commit cache invalidates on new commit and status reflects working tree changes immediately', async () => {
    const t3Repo = path.join(testRoot, 't3_cache_invalidation_repo');
    fs.mkdirSync(t3Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: t3Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: t3Repo });
    execFileSync('git', ['config', 'user.email', 'tester@local'], { cwd: t3Repo });
    fs.writeFileSync(path.join(t3Repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: t3Repo });
    execFileSync('git', ['commit', '-m', 'commit #1 initial'], { cwd: t3Repo });

    const ov1 = await (core as any).getOverviewAsync(t3Repo);
    assert.strictEqual(ov1.health.recentCommits[0].message, 'commit #1 initial');

    // Make new commit -> HEAD changes -> commit cache must invalidate
    fs.writeFileSync(path.join(t3Repo, 'commit2.txt'), 'second\n');
    execFileSync('git', ['add', '.'], { cwd: t3Repo });
    execFileSync('git', ['commit', '-m', 'commit #2 new commit'], { cwd: t3Repo });

    const ov2 = await (core as any).getOverviewAsync(t3Repo);
    assert.strictEqual(
      ov2.health.recentCommits[0].message,
      'commit #2 new commit',
      'Recent commits cache must invalidate when HEAD sha changes'
    );

    // Modify file without committing -> git status must NOT be cached
    fs.writeFileSync(path.join(t3Repo, 'fresh_untracked.txt'), 'fresh untracked\n');

    const ov3 = await (core as any).getOverviewAsync(t3Repo);
    const untracked = (ov3.health.untrackedFiles || []).map((f: string) => f.replace(/\\/g, '/'));
    assert.ok(
      untracked.includes('fresh_untracked.txt'),
      'Working tree modifications must be reflected immediately in git status'
    );
  });

  test('61. Step-4-TA1: non-ASCII Korean file name in git status matches the actual filename without octal escapes', () => {
    const ta1Repo = path.join(testRoot, 'ta1_korean_status_repo');
    fs.mkdirSync(ta1Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: ta1Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ta1Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: ta1Repo });

    fs.writeFileSync(path.join(ta1Repo, 'init.txt'), 'init\n');
    execFileSync('git', ['add', '.'], { cwd: ta1Repo });
    execFileSync('git', ['commit', '-m', 'init commit'], { cwd: ta1Repo });

    const koreanFile = '한글파일.js';
    fs.writeFileSync(path.join(ta1Repo, koreanFile), 'console.log("hello");\n');

    const statusSync = core.inspectProjectState(ta1Repo);
    assert.deepStrictEqual(
      statusSync.untrackedFiles,
      [koreanFile],
      'Sync inspectProjectState must return exact Korean filename in untrackedFiles'
    );

    execFileSync('git', ['add', '.'], { cwd: ta1Repo });
    execFileSync('git', ['commit', '-m', 'add korean file'], { cwd: ta1Repo });
    fs.appendFileSync(path.join(ta1Repo, koreanFile), '// edit\n');

    const statusSyncDirty = core.inspectProjectState(ta1Repo);
    assert.deepStrictEqual(
      statusSyncDirty.changedFiles,
      [koreanFile],
      'Sync inspectProjectState must return exact Korean filename in changedFiles'
    );
  });

  test('62. Step-4-TA2: ascii.js and 한글파일.js are both detected as unapproved when checkpoint has both and diff occurs', async () => {
    const ta2Repo = path.join(testRoot, 'ta2_korean_unapproved_repo');
    fs.mkdirSync(ta2Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: ta2Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ta2Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: ta2Repo });

    const koreanFile = '한글파일.js';
    fs.writeFileSync(path.join(ta2Repo, 'ascii.js'), 'console.log("ascii 1");\n');
    fs.writeFileSync(path.join(ta2Repo, koreanFile), 'console.log("korean 1");\n');
    execFileSync('git', ['add', '.'], { cwd: ta2Repo });
    execFileSync('git', ['commit', '-m', 'initial commit with korean'], { cwd: ta2Repo });

    // Both files modified before checkpoint
    fs.appendFileSync(path.join(ta2Repo, 'ascii.js'), '// cp dirty\n');
    fs.appendFileSync(path.join(ta2Repo, koreanFile), '// cp dirty\n');

    core.ensureProject(ta2Repo);
    await core.captureCheckpoint(ta2Repo, 'checkpoint with both files');

    // Both files modified further after checkpoint -> both MUST be unapproved
    fs.appendFileSync(path.join(ta2Repo, 'ascii.js'), '// further dirty\n');
    fs.appendFileSync(path.join(ta2Repo, koreanFile), '// further dirty\n');

    const healthSync = core.inspectProjectState(ta2Repo);
    const unapprovedSync = (healthSync.unapprovedFiles || []).map((f) => f.replace(/\\/g, '/')).sort();

    const healthAsync = await (core as any).inspectProjectStateAsync(ta2Repo);
    const unapprovedAsync = (healthAsync.unapprovedFiles || []).map((f: string) => f.replace(/\\/g, '/')).sort();

    const expected = ['ascii.js', koreanFile].sort();
    assert.deepStrictEqual(
      unapprovedSync,
      expected,
      'Both ascii.js and 한글파일.js must be caught as unapproved changes in sync path'
    );
    assert.deepStrictEqual(
      unapprovedAsync,
      expected,
      'Both ascii.js and 한글파일.js must be caught as unapproved changes in async path'
    );
  });

  test('63. Step-4-TA3: batch diff fallback to file-by-file preserves detection of valid files when invalid path is mixed in batch', () => {
    const ta3Repo = path.join(testRoot, 'ta3_fallback_repo');
    fs.mkdirSync(ta3Repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: ta3Repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ta3Repo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: ta3Repo });

    fs.writeFileSync(path.join(ta3Repo, 'valid1.txt'), 'v1\n');
    fs.writeFileSync(path.join(ta3Repo, 'valid2.txt'), 'v2\n');
    execFileSync('git', ['add', '.'], { cwd: ta3Repo });
    execFileSync('git', ['commit', '-m', 'commit valid files'], { cwd: ta3Repo });

    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ta3Repo, encoding: 'utf8' }).trim();
    const fakeCheckpoint: any = {
      id: 'cp_fake',
      changedFiles: ['valid1.txt', 'valid2.txt', '/355/invalid.js'],
      untrackedFiles: [],
      worktreeCommitSha: headSha,
    };

    fs.appendFileSync(path.join(ta3Repo, 'valid1.txt'), 'dirty\n');
    fs.appendFileSync(path.join(ta3Repo, 'valid2.txt'), 'dirty\n');

    const gitStatus: any = {
      isClean: false,
      changedFiles: ['valid1.txt', 'valid2.txt', '/355/invalid.js'],
      untrackedFiles: [],
    };

    const result = detectUnapprovedFiles((core as any).gitEngine, ta3Repo, gitStatus, fakeCheckpoint, 50);

    assert.ok(
      result.unapprovedFiles.includes('valid1.txt'),
      'valid1.txt must be detected as unapproved despite invalid path in batch'
    );
    assert.ok(
      result.unapprovedFiles.includes('valid2.txt'),
      'valid2.txt must be detected as unapproved despite invalid path in batch'
    );
  });

  test('64. B-2 Step-1: Pytest structured failure diagnosis distinguishes assertion vs runtime vs import vs 0-test', async () => {
    const pyRepo = path.join(testRoot, 'b2_pytest_repo');
    fs.mkdirSync(path.join(pyRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init python calc'], { cwd: pyRepo });

    // Confirm runner with "python -m pytest"
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    // Verify buildReproductionCommand keeps "python -m pytest" intact
    const builtCmd = buildReproductionCommand('python -m pytest', 'tests/test_foo.py');
    assert.strictEqual(builtCmd, 'python -m pytest "tests/test_foo.py"');

    // Case 1: Assertion failure -> REPRODUCED, failureKind: ASSERTION
    const inc1 = await core.collectIncidentBundle(pyRepo, '사건1 - pytest 단언 실패', 'AssertionError: assert 1 == 2');
    fs.writeFileSync(path.join(pyRepo, 'test_assert.py'), 'def test_a():\n    assert 1 == 2\n');
    const repro1 = await core.runReproduction(pyRepo, inc1.id, 'test_assert.py');
    assert.strictEqual(repro1.status, 'REPRODUCED');
    assert.strictEqual(repro1.failureKind, 'ASSERTION');
    assert.strictEqual(repro1.testCount, 1);
    assert.ok(repro1.failedLocation, 'failedLocation should be populated');

    // Case 2: TypeError runtime error -> WRONG_FAILURE, failureKind: RUNTIME_ERROR, causeVerdict != CONFIRMED
    const inc2 = await core.collectIncidentBundle(pyRepo, '사건2 - pytest TypeError', 'TypeError: invalid type');
    fs.writeFileSync(path.join(pyRepo, 'test_type_error.py'), 'def test_b():\n    raise TypeError("invalid type")\n');
    const repro2 = await core.runReproduction(pyRepo, inc2.id, 'test_type_error.py');
    assert.strictEqual(repro2.status, 'WRONG_FAILURE');
    assert.strictEqual(repro2.failureKind, 'RUNTIME_ERROR');
    assert.strictEqual(repro2.testCount, 1);
    const updatedInc2 = core.getDatabase().getIncident(inc2.id)!;
    assert.notStrictEqual(updatedInc2.causeVerdict, 'CONFIRMED', 'causeVerdict must not elevate to CONFIRMED on WRONG_FAILURE');

    // Case 3: Import failure -> WRONG_FAILURE, failureKind: COLLECTION_ERROR
    const inc3 = await core.collectIncidentBundle(pyRepo, '사건3 - pytest 임포트 실패', 'ImportError: No module');
    fs.writeFileSync(path.join(pyRepo, 'test_import_err.py'), 'import non_existent_pkg_xyz_123\ndef test_c():\n    pass\n');
    const repro3 = await core.runReproduction(pyRepo, inc3.id, 'test_import_err.py');
    assert.strictEqual(repro3.status, 'WRONG_FAILURE');
    assert.strictEqual(repro3.failureKind, 'COLLECTION_ERROR');

    // Case 4: 0 tests -> WRONG_FAILURE, failureKind: NO_TESTS
    const inc4 = await core.collectIncidentBundle(pyRepo, '사건4 - pytest 0개 테스트', 'No tests');
    fs.writeFileSync(path.join(pyRepo, 'test_no_tests.py'), 'def helper_func():\n    pass\n');
    const repro4 = await core.runReproduction(pyRepo, inc4.id, 'test_no_tests.py');
    assert.strictEqual(repro4.status, 'WRONG_FAILURE');
    assert.strictEqual(repro4.failureKind, 'NO_TESTS');
    assert.strictEqual(repro4.testCount, 0);

    // Case 5: Passing test -> NOT_REPRODUCED
    const inc5 = await core.collectIncidentBundle(pyRepo, '사건5 - pytest 통과', 'All ok');
    fs.writeFileSync(path.join(pyRepo, 'test_pass.py'), 'def test_ok():\n    assert 1 == 1\n');
    const repro5 = await core.runReproduction(pyRepo, inc5.id, 'test_pass.py');
    assert.strictEqual(repro5.status, 'NOT_REPRODUCED');
    assert.strictEqual(repro5.testCount, 1);
  });

  test('65. B-2 Step-1: Unittest structured failure diagnosis distinguishes assertion vs runtime vs import vs 0-test', async () => {
    const pyRepo = path.join(testRoot, 'b2_unittest_repo');
    fs.mkdirSync(path.join(pyRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init python calc'], { cwd: pyRepo });

    // Confirm runner with "python -m unittest"
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m unittest' });

    // Case 1: NameError runtime error -> WRONG_FAILURE, failureKind: RUNTIME_ERROR, causeVerdict != CONFIRMED
    const inc1 = await core.collectIncidentBundle(pyRepo, '사건1 - unittest NameError', 'NameError: undefined');
    fs.writeFileSync(
      path.join(pyRepo, 'test_name_error.py'),
      'import unittest\nclass T(unittest.TestCase):\n    def test_err(self):\n        raise NameError("undefined_var")\n'
    );
    const repro1 = await core.runReproduction(pyRepo, inc1.id, 'test_name_error.py');
    assert.strictEqual(repro1.status, 'WRONG_FAILURE');
    assert.strictEqual(repro1.failureKind, 'RUNTIME_ERROR');
    const updatedInc1 = core.getDatabase().getIncident(inc1.id)!;
    assert.notStrictEqual(updatedInc1.causeVerdict, 'CONFIRMED', 'causeVerdict must not elevate to CONFIRMED on WRONG_FAILURE');

    // Case 2: Import failure -> WRONG_FAILURE, failureKind: COLLECTION_ERROR
    const inc2 = await core.collectIncidentBundle(pyRepo, '사건2 - unittest 임포트 실패', 'ImportError');
    fs.writeFileSync(
      path.join(pyRepo, 'test_import_err.py'),
      'import unittest\nimport non_existent_pkg_abc\nclass T(unittest.TestCase):\n    def test_x(self):\n        pass\n'
    );
    const repro2 = await core.runReproduction(pyRepo, inc2.id, 'test_import_err.py');
    assert.strictEqual(repro2.status, 'WRONG_FAILURE');
    assert.strictEqual(repro2.failureKind, 'COLLECTION_ERROR');

    // Case 3: 0 tests -> WRONG_FAILURE, failureKind: NO_TESTS
    const inc3 = await core.collectIncidentBundle(pyRepo, '사건3 - unittest 0개 테스트', 'No tests');
    fs.writeFileSync(path.join(pyRepo, 'test_no_tests.py'), 'class Helper:\n    pass\n');
    const repro3 = await core.runReproduction(pyRepo, inc3.id, 'test_no_tests.py');
    assert.strictEqual(repro3.status, 'WRONG_FAILURE');
    assert.strictEqual(repro3.failureKind, 'NO_TESTS');
    assert.strictEqual(repro3.testCount, 0);

    // Case 4: Passing test -> NOT_REPRODUCED
    const inc4 = await core.collectIncidentBundle(pyRepo, '사건4 - unittest 통과', 'Pass');
    fs.writeFileSync(
      path.join(pyRepo, 'test_pass.py'),
      'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n'
    );
    const repro4 = await core.runReproduction(pyRepo, inc4.id, 'test_pass.py');
    assert.strictEqual(repro4.status, 'NOT_REPRODUCED');
  });

  test('66. B-2 Step-1: Node:test structured failure diagnosis distinguishes assertion vs runtime vs timeout vs 0-test', async () => {
    const jsRepo = path.join(testRoot, 'b2_nodetest_repo');
    fs.mkdirSync(jsRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: jsRepo });

    fs.writeFileSync(path.join(jsRepo, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(jsRepo, 'index.js'), 'export function foo() { return 1; }\n');
    execFileSync('git', ['add', '.'], { cwd: jsRepo });
    execFileSync('git', ['commit', '-m', 'Init js repo'], { cwd: jsRepo });

    // Confirm runner with "node --test"
    core.updateProjectSettings(jsRepo, { testCommand: 'node --test' });

    // Case 1: Assertion failure -> REPRODUCED, failureKind: ASSERTION
    const inc1 = await core.collectIncidentBundle(jsRepo, '사건1 - node:test 단언 실패', 'ERR_ASSERTION');
    fs.writeFileSync(
      path.join(jsRepo, 'test_assert.mjs'),
      'import test from "node:test";\nimport assert from "node:assert";\ntest("assert fail", () => { assert.strictEqual(1, 2); });\n'
    );
    const repro1 = await core.runReproduction(jsRepo, inc1.id, 'test_assert.mjs');
    assert.strictEqual(repro1.status, 'REPRODUCED');
    assert.strictEqual(repro1.failureKind, 'ASSERTION');
    assert.strictEqual(repro1.testCount, 1);
    assert.ok(repro1.failedLocation, 'failedLocation should be populated');

    // Case 2: TypeError runtime error -> WRONG_FAILURE, failureKind: RUNTIME_ERROR, causeVerdict != CONFIRMED
    const inc2 = await core.collectIncidentBundle(jsRepo, '사건2 - node:test TypeError', 'TypeError');
    fs.writeFileSync(
      path.join(jsRepo, 'test_type_error.mjs'),
      'import test from "node:test";\ntest("type err", () => { const o = null; o.foo(); });\n'
    );
    const repro2 = await core.runReproduction(jsRepo, inc2.id, 'test_type_error.mjs');
    assert.strictEqual(repro2.status, 'WRONG_FAILURE');
    assert.strictEqual(repro2.failureKind, 'RUNTIME_ERROR');
    assert.strictEqual(repro2.testCount, 1);
    const updatedInc2 = core.getDatabase().getIncident(inc2.id)!;
    assert.notStrictEqual(updatedInc2.causeVerdict, 'CONFIRMED', 'causeVerdict must not elevate to CONFIRMED on WRONG_FAILURE');

    // Case 3: Import failure -> WRONG_FAILURE, failureKind: COLLECTION_ERROR
    const inc3 = await core.collectIncidentBundle(jsRepo, '사건3 - node:test 임포트 실패', 'ERR_MODULE_NOT_FOUND');
    fs.writeFileSync(
      path.join(jsRepo, 'test_import_err.mjs'),
      'import nonExistent from "./non_existent_pkg_xyz.mjs";\nimport test from "node:test";\ntest("import", () => {});\n'
    );
    const repro3 = await core.runReproduction(jsRepo, inc3.id, 'test_import_err.mjs');
    assert.strictEqual(repro3.status, 'WRONG_FAILURE');
    assert.strictEqual(repro3.failureKind, 'COLLECTION_ERROR');

    // Case 4: 0 tests -> WRONG_FAILURE, failureKind: NO_TESTS
    const inc4 = await core.collectIncidentBundle(jsRepo, '사건4 - node:test 0개 테스트', 'No tests');
    fs.writeFileSync(path.join(jsRepo, 'test_no_tests.mjs'), 'console.log("no test functions in this file");\n');
    const repro4 = await core.runReproduction(jsRepo, inc4.id, 'test_no_tests.mjs');
    assert.strictEqual(repro4.status, 'WRONG_FAILURE');
    assert.strictEqual(repro4.failureKind, 'NO_TESTS');
    assert.strictEqual(repro4.testCount, 0);

    // Case 5: Passing test -> NOT_REPRODUCED
    const inc5 = await core.collectIncidentBundle(jsRepo, '사건5 - node:test 통과', 'Pass');
    fs.writeFileSync(
      path.join(jsRepo, 'test_pass.mjs'),
      'import test from "node:test";\nimport assert from "node:assert";\ntest("ok", () => { assert.strictEqual(1, 1); });\n'
    );
    const repro5 = await core.runReproduction(jsRepo, inc5.id, 'test_pass.mjs');
    assert.strictEqual(repro5.status, 'NOT_REPRODUCED');
    assert.strictEqual(repro5.testCount, 1);
  });

  test('67. B-2 Step-1: Unsupported test runner failing test yields UNVERIFIED_FAILURE without fake CONFIRMED', async () => {
    const unsuppRepo = path.join(testRoot, 'b2_unsupported_repo');
    fs.mkdirSync(unsuppRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: unsuppRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: unsuppRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: unsuppRepo });

    fs.writeFileSync(path.join(unsuppRepo, 'dummy.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: unsuppRepo });
    execFileSync('git', ['commit', '-m', 'Init unsupp repo'], { cwd: unsuppRepo });

    // Confirm runner with "node" (standalone script runner, unsupported for assertion checking)
    core.updateProjectSettings(unsuppRepo, { testCommand: 'node' });

    const inc = await core.collectIncidentBundle(unsuppRepo, '지원 안 하는 러너 사건', 'Crash');
    fs.writeFileSync(path.join(unsuppRepo, 'fail_script.js'), 'console.error("something failed"); process.exit(1);\n');

    const repro = await core.runReproduction(unsuppRepo, inc.id, 'fail_script.js');
    assert.strictEqual(repro.status, 'UNVERIFIED_FAILURE');
    assert.strictEqual(repro.failureKind, 'UNKNOWN_RUNNER');

    const updatedInc = core.getDatabase().getIncident(inc.id)!;
    assert.notStrictEqual(updatedInc.causeVerdict, 'CONFIRMED', 'UNVERIFIED_FAILURE must not elevate to CONFIRMED');
  });

  test('68. B-2 Step-1 Fix: node:test describe/it and t.test subtests correctly distinguish assertion vs runtime errors', async () => {
    const jsRepo = path.join(testRoot, 'b2_subtest_repo');
    fs.mkdirSync(jsRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: jsRepo });

    fs.writeFileSync(path.join(jsRepo, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(jsRepo, 'calc.js'), 'export function add(a, b) { return a - b; }\n');
    execFileSync('git', ['add', '.'], { cwd: jsRepo });
    execFileSync('git', ['commit', '-m', 'Init js repo'], { cwd: jsRepo });

    core.updateProjectSettings(jsRepo, { testCommand: 'node --test' });

    // 1) describe/it inside assert.strictEqual failure -> REPRODUCED, ASSERTION
    const inc1 = await core.collectIncidentBundle(jsRepo, 'describe it 단언 실패', 'AssertionError');
    fs.writeFileSync(
      path.join(jsRepo, 'test_describe_assert.mjs'),
      `import { describe, it } from 'node:test';
import assert from 'node:assert';
import { add } from './calc.js';

describe('calc', () => {
  it('adds', () => {
    assert.strictEqual(add(1, 1), 2);
  });
});
`
    );
    const repro1 = await core.runReproduction(jsRepo, inc1.id, 'test_describe_assert.mjs');
    assert.strictEqual(repro1.status, 'REPRODUCED', 'describe/it assertion failure must yield REPRODUCED');
    assert.strictEqual(repro1.failureKind, 'ASSERTION', 'failureKind must be ASSERTION');
    assert.ok(repro1.failedLocation, 'failedLocation must be populated');

    // 2) describe/it inside TypeError -> WRONG_FAILURE, RUNTIME_ERROR
    const inc2 = await core.collectIncidentBundle(jsRepo, 'describe it TypeError', 'TypeError');
    fs.writeFileSync(
      path.join(jsRepo, 'test_describe_typeerr.mjs'),
      `import { describe, it } from 'node:test';

describe('calc', () => {
  it('adds', () => {
    const x = null;
    x.foo();
  });
});
`
    );
    const repro2 = await core.runReproduction(jsRepo, inc2.id, 'test_describe_typeerr.mjs');
    assert.strictEqual(repro2.status, 'WRONG_FAILURE', 'describe/it TypeError must yield WRONG_FAILURE');
    assert.strictEqual(repro2.failureKind, 'RUNTIME_ERROR', 'failureKind must be RUNTIME_ERROR');
    const updatedInc2 = core.getDatabase().getIncident(inc2.id)!;
    assert.notStrictEqual(updatedInc2.causeVerdict, 'CONFIRMED', 'causeVerdict must not elevate to CONFIRMED');

    // 3) test() with t.test() subtest assertion failure -> REPRODUCED, ASSERTION
    const inc3 = await core.collectIncidentBundle(jsRepo, 't.test subtest 단언 실패', 'AssertionError');
    fs.writeFileSync(
      path.join(jsRepo, 'test_ttest_assert.mjs'),
      `import test from 'node:test';
import assert from 'node:assert';
import { add } from './calc.js';

test('outer test', async (t) => {
  await t.test('inner subtest', () => {
    assert.strictEqual(add(1, 1), 2);
  });
});
`
    );
    const repro3 = await core.runReproduction(jsRepo, inc3.id, 'test_ttest_assert.mjs');
    assert.strictEqual(repro3.status, 'REPRODUCED', 't.test subtest assertion failure must yield REPRODUCED');
    assert.strictEqual(repro3.failureKind, 'ASSERTION', 'failureKind must be ASSERTION');
    assert.ok(repro3.failedLocation, 'failedLocation must be populated');
  });

  test('69. B-2 Step-1 Fix: pytest timeout yields failureKind TIMEOUT, and runReproduction preserves process.env immutability', async () => {
    const pyRepo = path.join(testRoot, 'b2_pytest_timeout_repo');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b): return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init py repo'], { cwd: pyRepo });

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });
    const inc = await core.collectIncidentBundle(pyRepo, 'pytest 타임아웃 사건', 'Timeout');

    fs.writeFileSync(
      path.join(pyRepo, 'test_sleep.py'),
      `import time
def test_long_running():
    time.sleep(10)
`
    );

    // Snapshot process.env keys and values before runReproduction
    const envBefore = { ...process.env };

    // Execute reproduction with a short timeout (1500ms)
    const repro = await core.runReproduction(pyRepo, inc.id, 'test_sleep.py', 1500);

    // 1) Verify timeout result
    assert.strictEqual(repro.status, 'WRONG_FAILURE');
    assert.strictEqual(repro.failureKind, 'TIMEOUT');
    assert.strictEqual(repro.exitCode, 124);
    assert.ok(repro.output.includes('시간이 초과되었습니다'));

    // 2) Verify process.env was not mutated
    const envAfter = { ...process.env };
    assert.deepStrictEqual(Object.keys(envAfter), Object.keys(envBefore), 'process.env keys must be unmodified');
    for (const key of Object.keys(envBefore)) {
      assert.strictEqual(envAfter[key], envBefore[key], `process.env[${key}] must be unmodified`);
    }
  });

  test('70. B-2 Step-2: Pytest regression comparison confirms REGRESSION_CONFIRMED with 3/3 repeated runs and cleans up transient ref', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_pytest_regress');
    fs.mkdirSync(path.join(pyRepo, 'src'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    // 1. Initial clean state
    fs.writeFileSync(path.join(pyRepo, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init normal code'], { cwd: pyRepo });

    // Capture baseline checkpoint CP1
    const cp1 = core.captureCheckpoint(pyRepo, 'Clean baseline checkpoint');
    assert.ok(cp1.id);

    // 2. Introduce bug commit
    fs.writeFileSync(path.join(pyRepo, 'src', 'calc.py'), 'def add(a, b):\n    return a + b + 1\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Introduce regression bug'], { cwd: pyRepo });

    // 3. Collect incident
    const inc = await core.collectIncidentBundle(pyRepo, '회귀 버그 발생', 'AssertionError: assert 4 == 3');
    assert.strictEqual(inc.baseCheckpointId, cp1.id);

    // 4. Create reproduction test file
    fs.writeFileSync(
      path.join(pyRepo, 'test_repro.py'),
      'from src.calc import add\ndef test_add():\n    assert add(1, 2) == 3\n'
    );

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_repro.py');

    // 5. Assertions
    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'REGRESSION_CONFIRMED');
    assert.strictEqual(repro.baselineComparison.baselineCheckpointId, cp1.id);
    assert.strictEqual(repro.baselineComparison.runs.current.length, 3);
    assert.ok(repro.baselineComparison.runs.baseline);
    assert.strictEqual(repro.baselineComparison.runs.baseline.length, 3);
    assert.ok(repro.baselineComparison.runs.current.every((r) => r.status === 'REPRODUCED'));
    assert.ok(repro.baselineComparison.runs.baseline.every((r) => r.status === 'NOT_REPRODUCED'));

    // Check evidence updated
    const updatedInc = core.getDatabase().getIncident(inc.id)!;
    assert.ok(updatedInc.causeEvidence?.some((e: string) => e.includes('[비교: REGRESSION_CONFIRMED]')));

    // Check DB checkpoints: transient snapshot must NOT be in DB checkpoints
    const project = core.ensureProject(pyRepo);
    const cps = core.getDatabase().listCheckpoints(project.id);
    assert.strictEqual(cps.length, 1);
    assert.strictEqual(cps[0].id, cp1.id);

    // Check git refs: transient ref must be deleted
    const gitRefs = execFileSync('git', ['show-ref'], { cwd: pyRepo, encoding: 'utf8' });
    assert.ok(!gitRefs.includes('repro-snap-'), 'Transient snapshot ref must be cleaned up from git refs');
  });

  test('71. B-2 Step-2: Node:test describe/it regression comparison confirms REGRESSION_CONFIRMED', async () => {
    const jsRepo = path.join(testRoot, 'b2_s2_node_regress');
    fs.mkdirSync(jsRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: jsRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: jsRepo });

    // 1. Initial clean state
    fs.writeFileSync(path.join(jsRepo, 'math.mjs'), 'export function mul(a, b) { return a * b; }\n');
    execFileSync('git', ['add', '.'], { cwd: jsRepo });
    execFileSync('git', ['commit', '-m', 'Init normal js math'], { cwd: jsRepo });

    const cp1 = core.captureCheckpoint(jsRepo, 'Clean baseline js');

    // 2. Introduce bug commit
    fs.writeFileSync(path.join(jsRepo, 'math.mjs'), 'export function mul(a, b) { return a * b + 99; }\n');
    execFileSync('git', ['add', '.'], { cwd: jsRepo });
    execFileSync('git', ['commit', '-m', 'Buggy mul'], { cwd: jsRepo });

    const inc = await core.collectIncidentBundle(jsRepo, 'JS 회귀 버그', 'AssertionError [ERR_ASSERTION]');

    // 3. Reproduction test using describe/it
    fs.writeFileSync(
      path.join(jsRepo, 'test_repro.mjs'),
      `import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mul } from './math.mjs';

describe('multiplication', () => {
  it('correctly multiplies', () => {
    assert.strictEqual(mul(2, 3), 6);
  });
});
`
    );

    core.updateProjectSettings(jsRepo, { testCommand: 'node --test' });

    const repro = await core.runReproduction(jsRepo, inc.id, 'test_repro.mjs');

    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'REGRESSION_CONFIRMED');
    assert.strictEqual(repro.baselineComparison.baselineCheckpointId, cp1.id);
    assert.strictEqual(repro.baselineComparison.runs.current.length, 3);
    assert.ok(repro.baselineComparison.runs.baseline);
    assert.strictEqual(repro.baselineComparison.runs.baseline.length, 3);
    assert.ok(repro.baselineComparison.runs.current.every((r) => r.status === 'REPRODUCED'));
    assert.ok(repro.baselineComparison.runs.baseline.every((r) => r.status === 'NOT_REPRODUCED'));
  });

  test('72. B-2 Step-2: Uncommitted bug after checkpoint reproduces in live current state and passes in baseline', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_uncommitted_bug');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def sub(a, b):\n    return a - b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init sub function'], { cwd: pyRepo });

    const cp1 = core.captureCheckpoint(pyRepo, 'Clean sub checkpoint');
    const inc = await core.collectIncidentBundle(pyRepo, '미커밋 버그 발생 사건', 'AssertionError');

    // Introduce UNCOMMITTED bug in working tree (do not git add, do not git commit)
    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def sub(a, b):\n    return a - b - 100\n');

    fs.writeFileSync(
      path.join(pyRepo, 'test_sub.py'),
      'from calc import sub\ndef test_sub():\n    assert sub(10, 5) == 5\n'
    );

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_sub.py');

    // Live uncommitted bug must be reproduced!
    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'REGRESSION_CONFIRMED');
    assert.strictEqual(repro.baselineComparison.baselineCheckpointId, cp1.id);
    assert.ok(repro.baselineComparison.runs.current.every((r) => r.status === 'REPRODUCED'));
    assert.ok(repro.baselineComparison.runs.baseline?.every((r) => r.status === 'NOT_REPRODUCED'));
  });

  test('73. B-2 Step-2: Pre-existing bug present from initial checkpoint records PRE_EXISTING', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_pre_existing');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    // Bug present from start: returns 0 instead of a // b
    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def divide(a, b):\n    return 0\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init with pre-existing bug'], { cwd: pyRepo });

    const cp1 = core.captureCheckpoint(pyRepo, 'Initial checkpoint with bug');

    // Make an unrelated commit so tree is not identical
    fs.writeFileSync(path.join(pyRepo, 'readme.txt'), 'Updated readme\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Docs update'], { cwd: pyRepo });

    const inc = await core.collectIncidentBundle(pyRepo, '나눗셈 버그', 'AssertionError: assert 0 == 2');

    fs.writeFileSync(
      path.join(pyRepo, 'test_div.py'),
      'from calc import divide\ndef test_div():\n    assert divide(4, 2) == 2\n'
    );

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_div.py', cp1.id);

    // Status stays REPRODUCED, comparison verdict is PRE_EXISTING
    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'PRE_EXISTING');
    assert.strictEqual(repro.baselineComparison.baselineCheckpointId, cp1.id);
    assert.ok(repro.baselineComparison.runs.current.every((r) => r.status === 'REPRODUCED'));
    assert.ok(repro.baselineComparison.runs.baseline?.every((r) => r.status === 'REPRODUCED'));
  });

  test('74. B-2 Step-2: Bug in newly added function missing in baseline records BASELINE_CANNOT_RUN', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_new_func_bug');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init basic add'], { cwd: pyRepo });

    const cp1 = core.captureCheckpoint(pyRepo, 'Checkpoint before power function was created');

    // Add new function with bug
    fs.writeFileSync(
      path.join(pyRepo, 'calc.py'),
      'def add(a, b):\n    return a + b\ndef power(a, b):\n    return a * b\n'
    );
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Add power function with bug'], { cwd: pyRepo });

    const inc = await core.collectIncidentBundle(pyRepo, '거듭제곱 함수 버그', 'AssertionError');

    fs.writeFileSync(
      path.join(pyRepo, 'test_power.py'),
      'from calc import power\ndef test_power():\n    assert power(2, 3) == 8\n'
    );

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_power.py');

    // Current fails assertion (power(2,3) == 6 != 8) -> REPRODUCED
    // Baseline fails import (power does not exist in CP1) -> BASELINE_CANNOT_RUN
    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'BASELINE_CANNOT_RUN');
    assert.strictEqual(repro.baselineComparison.baselineCheckpointId, cp1.id);
    assert.ok(repro.baselineComparison.runs.current.every((r) => r.status === 'REPRODUCED'));
    assert.ok(repro.baselineComparison.runs.baseline?.every((r) => r.status === 'WRONG_FAILURE'));
  });

  test('75. B-2 Step-2: Flaky test alternating pass and fail is rejected with WRONG_FAILURE and failureKind FLAKY', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_flaky_test');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'app.py'), 'def ok(): return True\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init app'], { cwd: pyRepo });

    core.captureCheckpoint(pyRepo, 'Clean baseline for flaky test');
    const inc = await core.collectIncidentBundle(pyRepo, '불안정한 테스트 사건', 'Flaky error');

    // External counter file to make test deterministically alternate
    const counterFile = path.join(testRoot, `flaky_counter_${Date.now()}.txt`);
    fs.writeFileSync(counterFile, '0', 'utf8');
    process.env.TEST_FLAKY_COUNTER_FILE = counterFile;

    try {
      const normalizedCounterFile = counterFile.replace(/\\/g, '/');
      fs.writeFileSync(
        path.join(pyRepo, 'test_flaky.py'),
        `import os

def test_flaky():
    c_path = "${normalizedCounterFile}"
    with open(c_path, 'r') as f:
        val = int(f.read().strip())
    with open(c_path, 'w') as f:
        f.write(str(val + 1))
    if val % 2 == 0:
        assert 1 == 2, "flaky failure on even"
    else:
        assert 1 == 1, "flaky pass on odd"
`
      );

      core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

      const repro = await core.runReproduction(pyRepo, inc.id, 'test_flaky.py');

      // Alternating results must result in WRONG_FAILURE + FLAKY
      assert.strictEqual(repro.status, 'WRONG_FAILURE');
      assert.strictEqual(repro.failureKind, 'FLAKY');
      assert.ok(repro.baselineComparison);
      assert.strictEqual(repro.baselineComparison.verdict, 'SKIPPED');
      assert.strictEqual(repro.baselineComparison.runs.current.length, 3);
      // Run 1: fail (val=0) -> REPRODUCED
      // Run 2: pass (val=1) -> NOT_REPRODUCED
      // Run 3: fail (val=2) -> REPRODUCED
      assert.strictEqual(repro.baselineComparison.runs.current[0].status, 'REPRODUCED');
      assert.strictEqual(repro.baselineComparison.runs.current[1].status, 'NOT_REPRODUCED');
      assert.strictEqual(repro.baselineComparison.runs.current[2].status, 'REPRODUCED');
    } finally {
      delete process.env.TEST_FLAKY_COUNTER_FILE;
      try {
        if (fs.existsSync(counterFile)) fs.unlinkSync(counterFile);
      } catch {}
    }
  });

  test('76. B-2 Step-2: Test exceeding 3 seconds executes only 1 time and records the reason in note', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_slow_test');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def f(): return 1\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init f'], { cwd: pyRepo });

    const cp1 = core.captureCheckpoint(pyRepo, 'Baseline for slow test');

    // Bug commit
    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def f(): return 2\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Bug f'], { cwd: pyRepo });

    const inc = await core.collectIncidentBundle(pyRepo, '느린 테스트 사건', 'AssertionError');

    // Test sleeps for 3.2 seconds then asserts
    fs.writeFileSync(
      path.join(pyRepo, 'test_slow.py'),
      `import time
from calc import f

def test_slow():
    time.sleep(3.2)
    assert f() == 1
`
    );

    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_slow.py', 15000);

    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.strictEqual(repro.failureKind, 'ASSERTION');
    assert.ok(repro.baselineComparison);
    // Over 3s: only 1 run in current!
    assert.strictEqual(repro.baselineComparison.runs.current.length, 1);
    assert.ok(repro.baselineComparison.runs.current[0].durationMs >= 3000);
    assert.ok(
      repro.baselineComparison.note?.includes('runCount: 1') ||
      repro.baselineComparison.note?.includes('3초를 초과')
    );
  });

  test('77. B-2 Step-2: Unsupported test runner does not run baseline and records SKIPPED', async () => {
    const unsuppRepo = path.join(testRoot, 'b2_s2_unsupported_runner');
    fs.mkdirSync(unsuppRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: unsuppRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: unsuppRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: unsuppRepo });

    fs.writeFileSync(path.join(unsuppRepo, 'script.sh'), '#!/bin/sh\nexit 1\n');
    execFileSync('git', ['add', '.'], { cwd: unsuppRepo });
    execFileSync('git', ['commit', '-m', 'Init script'], { cwd: unsuppRepo });

    core.captureCheckpoint(unsuppRepo, 'Baseline unsupp');
    const inc = await core.collectIncidentBundle(unsuppRepo, '미지원 러너 사건', 'script error');

    fs.writeFileSync(path.join(unsuppRepo, 'fail.sh'), '#!/bin/sh\nexit 1\n');
    core.updateProjectSettings(unsuppRepo, { testCommand: 'sh fail.sh' });

    const repro = await core.runReproduction(unsuppRepo, inc.id, 'fail.sh');

    assert.strictEqual(repro.status, 'UNVERIFIED_FAILURE');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'SKIPPED');
  });

  test('78. B-2 Step-2: Identical tree between current and baseline records NO_BASELINE', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_identical_tree');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b): return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init calc'], { cwd: pyRepo });

    const cp1 = core.captureCheckpoint(pyRepo, 'Only checkpoint');
    const inc = await core.collectIncidentBundle(pyRepo, '트리 동일 사건', 'AssertionError');

    // No code was changed between CP1 and now
    fs.writeFileSync(path.join(pyRepo, 'test_assert.py'), 'def test_a(): assert 1 == 2\n');
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    const repro = await core.runReproduction(pyRepo, inc.id, 'test_assert.py');

    assert.strictEqual(repro.status, 'REPRODUCED');
    assert.ok(repro.baselineComparison);
    assert.strictEqual(repro.baselineComparison.verdict, 'NO_BASELINE');
    assert.ok(repro.baselineComparison.note?.includes('트리') || repro.baselineComparison.note?.includes('비교 대상 없음'));
  });

  test('79. B-2 Step-2: Foreign baseline_checkpoint_id is rejected without leaving transient ref or worktrees', async () => {
    const repoA = path.join(testRoot, 'b2_s2_t79_repoA');
    const repoB = path.join(testRoot, 'b2_s2_t79_repoB');
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoA });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoA });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoA });
    fs.writeFileSync(path.join(repoA, 'calc.py'), 'def add(a, b): return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: repoA });
    execFileSync('git', ['commit', '-m', 'Init A'], { cwd: repoA });

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoB });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoB });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoB });
    fs.writeFileSync(path.join(repoB, 'calc.py'), 'def add(a, b): return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: repoB });
    execFileSync('git', ['commit', '-m', 'Init B'], { cwd: repoB });

    const cpA = core.captureCheckpoint(repoA, 'Checkpoint A');
    const cpB = core.captureCheckpoint(repoB, 'Checkpoint B');
    const incA = await core.collectIncidentBundle(repoA, 'Inc A', 'Error output');

    core.updateProjectSettings(repoA, { testCommand: 'python -m pytest' });
    fs.writeFileSync(path.join(repoA, 'test_repro.py'), 'def test_a(): assert 1 == 2\n');

    // Attempt reproduction with repoB's checkpoint -> must throw
    await assert.rejects(
      async () => {
        await core.runReproduction(repoA, incA.id, 'test_repro.py', cpB.id);
      },
      /체크포인트 .*는 이 사건\/프로젝트.*의 체크포인트가 아닙니다/
    );

    // Verify git for-each-ref has no repro-snap
    const gitRefs = execFileSync('git', ['for-each-ref', 'refs/autopsy/checkpoints/'], { cwd: repoA, encoding: 'utf8' });
    assert.ok(!gitRefs.includes('repro-snap-'), 'No repro-snap ref should remain');
    assert.ok(gitRefs.includes(cpA.id), 'Legitimate checkpoint ref must remain');

    // Verify git worktree list has no reproduction worktree
    const worktreeList = execFileSync('git', ['worktree', 'list'], { cwd: repoA, encoding: 'utf8' });
    assert.ok(!worktreeList.includes('repro-cur-'), 'No repro-cur worktree should remain');
    assert.ok(!worktreeList.includes('repro-base-'), 'No repro-base worktree should remain');
  });

  test('80. B-2 Step-2: Snapshot creation failure returns CANNOT_RUN without executing on HEAD', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_t80_snap_fail');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b): return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Init calc'], { cwd: pyRepo });

    core.captureCheckpoint(pyRepo, 'Baseline');
    const inc = await core.collectIncidentBundle(pyRepo, '스냅샷 실패 테스트 사건', 'Error');

    // Working directory has uncommitted bug
    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b): return a + b + 999\n');
    fs.writeFileSync(path.join(pyRepo, 'test_repro.py'), 'from calc import add\ndef test_add(): assert add(1, 1) == 2\n');
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });

    // Temporarily stub gitEngine.createSnapshot to throw an error
    const gitEngine = (core as any).ctx.gitEngine;
    const origCreateSnapshot = gitEngine.createSnapshot.bind(gitEngine);
    gitEngine.createSnapshot = () => {
      throw new Error('Simulated index lock error');
    };

    try {
      const repro = await core.runReproduction(pyRepo, inc.id, 'test_repro.py');

      assert.strictEqual(repro.status, 'CANNOT_RUN');
      assert.strictEqual(repro.exitCode, 1);
      assert.ok(repro.output.includes('현재 작업 폴더 스냅샷을 만들지 못해 재현하지 않음'));
      assert.ok(repro.output.includes('Simulated index lock error'));

      const updatedInc = core.getDatabase().getIncident(inc.id)!;
      assert.ok(
        updatedInc.causeEvidence?.some((e: string) =>
          e.includes('현재 작업 폴더 스냅샷을 만들지 못해 재현하지 않음: Simulated index lock error')
        )
      );

      // Verify it did NOT run on HEAD (which would have returned NOT_REPRODUCED since HEAD had clean add(a,b))
      assert.strictEqual(repro.status, 'CANNOT_RUN');
      assert.ok(!repro.baselineComparison?.runs?.current || repro.baselineComparison.runs.current.length === 0);
    } finally {
      gitEngine.createSnapshot = origCreateSnapshot;
    }
  });

  test('81. B-2 Step-2: get_change_scope and run_reproduction pick identical baselineSha and baselineRule across 3 cases', async () => {
    const pyRepo = path.join(testRoot, 'b2_s2_t81_rule_parity');
    fs.mkdirSync(pyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: pyRepo });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: pyRepo });

    // --- Case 1: 사건 기준 체크포인트를 쓰는 경우 (INCIDENT_BASE_CHECKPOINT) ---
    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Commit 1: clean add'], { cwd: pyRepo });
    const cp1 = core.captureCheckpoint(pyRepo, 'CP1 clean');

    fs.writeFileSync(path.join(pyRepo, 'calc.py'), 'def add(a, b):\n    return a + b + 1\n');
    execFileSync('git', ['add', '.'], { cwd: pyRepo });
    execFileSync('git', ['commit', '-m', 'Commit 2: bug in add'], { cwd: pyRepo });

    const inc1 = await core.collectIncidentBundle(pyRepo, 'Case 1 회귀 사건', 'AssertionError');
    core.updateProjectSettings(pyRepo, { testCommand: 'python -m pytest' });
    fs.writeFileSync(path.join(pyRepo, 'test_c1.py'), 'from calc import add\ndef test_add(): assert add(1, 1) == 2\n');

    const scope1 = await core.getChangeScope(inc1.id);
    const repro1 = await core.runReproduction(pyRepo, inc1.id, 'test_c1.py');

    assert.strictEqual(scope1.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
    assert.strictEqual(repro1.baselineComparison?.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
    assert.strictEqual(scope1.baselineSha, repro1.baselineComparison?.baselineSha);

    // --- Case 2: 더 이전 체크포인트로 넓히는 경우 (EXPANDED_TO_OLDER_CHECKPOINT) ---
    const repoC2 = path.join(testRoot, 'b2_s2_t81_c2');
    fs.mkdirSync(repoC2, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoC2 });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoC2 });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoC2 });

    fs.writeFileSync(path.join(repoC2, 'calc.py'), 'def mul(a, b):\n    return a * b\n');
    execFileSync('git', ['add', '.'], { cwd: repoC2 });
    execFileSync('git', ['commit', '-m', 'Commit A: clean mul'], { cwd: repoC2 });
    const cpA = core.captureCheckpoint(repoC2, 'CP A clean');

    fs.writeFileSync(path.join(repoC2, 'calc.py'), 'def mul(a, b):\n    return a * b + 10\n');
    execFileSync('git', ['add', '.'], { cwd: repoC2 });
    execFileSync('git', ['commit', '-m', 'Commit B: bug in mul'], { cwd: repoC2 });
    core.captureCheckpoint(repoC2, 'CP B after bug');

    // Incident registered at CP B: base checkpoint is CP B
    const inc2 = await core.collectIncidentBundle(repoC2, 'Case 2 자동 확장 사건', 'AssertionError');
    core.updateProjectSettings(repoC2, { testCommand: 'python -m pytest' });

    const scope2 = await core.getChangeScope(inc2.id);
    fs.writeFileSync(path.join(repoC2, 'test_c2.py'), 'from calc import mul\ndef test_mul(): assert mul(2, 3) == 6\n');
    const repro2 = await core.runReproduction(repoC2, inc2.id, 'test_c2.py');

    assert.strictEqual(scope2.baselineRule, 'EXPANDED_TO_OLDER_CHECKPOINT');
    assert.strictEqual(repro2.baselineComparison?.baselineRule, 'EXPANDED_TO_OLDER_CHECKPOINT');
    assert.strictEqual(scope2.baselineSha, repro2.baselineComparison?.baselineSha);
    assert.strictEqual(scope2.baselineSha, cpA.worktreeCommitSha || cpA.gitHeadSha);

    // --- Case 3: 넓혀도 찾지 못하는 경우 (INCIDENT_BASE_CHECKPOINT 유지) ---
    const repoC3 = path.join(testRoot, 'b2_s2_t81_c3');
    fs.mkdirSync(repoC3, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoC3 });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoC3 });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: repoC3 });

    fs.writeFileSync(path.join(repoC3, 'calc.py'), 'def sub(a, b):\n    return a - b\n');
    execFileSync('git', ['add', '.'], { cwd: repoC3 });
    execFileSync('git', ['commit', '-m', 'Initial only commit'], { cwd: repoC3 });
    core.captureCheckpoint(repoC3, 'Only initial checkpoint');

    const inc3 = await core.collectIncidentBundle(repoC3, 'Case 3 넓혀도 없는 사건', 'AssertionError');
    core.updateProjectSettings(repoC3, { testCommand: 'python -m pytest' });
    fs.writeFileSync(path.join(repoC3, 'test_c3.py'), 'def test_a(): assert 1 == 2\n');

    const scope3 = await core.getChangeScope(inc3.id);
    const repro3 = await core.runReproduction(repoC3, inc3.id, 'test_c3.py');

    assert.strictEqual(scope3.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
    assert.strictEqual(repro3.baselineComparison?.baselineRule, 'INCIDENT_BASE_CHECKPOINT');
    assert.strictEqual(scope3.baselineSha, repro3.baselineComparison?.baselineSha);
  });
});
