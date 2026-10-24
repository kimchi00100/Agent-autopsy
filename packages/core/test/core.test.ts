import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as url from 'node:url';
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import { CoreManager } from '../src/core-manager.js';
import { ApiServer } from '../src/server/api-server.js';
import { analyzeIncident } from '../src/analysis/analyzer.js';
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

  test('3. Incident collection on test failure', () => {
    // The current test.js fails on divide(10, 0) because calculator.js does not handle 0 division!
    const incident = core.collectIncidentBundle(
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

    // 1. Simple low-risk check
    const lowDecision = core.evaluateOrchestrationDecision(
      project,
      '오타 수정',
      '',
      'diff',
      ['calculator.js'],
      'CONFIRMED'
    );
    assert.strictEqual(lowDecision.riskLevel, 'LOW');
    assert.strictEqual(lowDecision.requiresOrchestration, false);

    // 2. High-risk security / payment / discount domain
    const highDecision = core.evaluateOrchestrationDecision(
      project,
      'VIP 할인 쿠폰 결제 검증 로직 수정',
      'AssertionError: discount overflow',
      'diff',
      ['src/shop/discount.js', 'src/shop/payment.js'],
      'UNKNOWN'
    );
    assert.strictEqual(highDecision.riskLevel, 'HIGH');
    assert.strictEqual(highDecision.requiresOrchestration, true);
    assert.ok(highDecision.riskSignals.some((s) => s.includes('보안')));

    // 3. MAIN_ONLY mode honors user preference while preserving risk warnings
    core.updateProjectSettings(repoPath, { verificationMode: 'MAIN_ONLY' });
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
    // Reset back to AUTO mode
    core.updateProjectSettings(repoPath, { verificationMode: 'AUTO' });

    // Create an incident in discount/payment domain
    const highRiskIncident = core.collectIncidentBundle(
      repoPath,
      '결제 및 할인 쿠폰 취소 롤백 실패',
      'AssertionError: discount balance mismatch'
    );
    assert.strictEqual(highRiskIncident.riskLevel, 'HIGH');

    // Propose a repair
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

    // High risk proposal should be BLOCKED_AWAITING_REVIEW
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
  });

  test('10. Non-destructive safety quarantine on unexpected working tree changes', () => {
    // 1. Create an active incident
    const inc = core.collectIncidentBundle(
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
  });

  test('11. DirectiveQueue live delivery on active awaitUserDecision (DELIVERED_LIVE)', async () => {
    const inc = core.collectIncidentBundle(repoPath, '지시서 실시간 전달 테스트', 'AssertionError: test');
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
    const inc = core.collectIncidentBundle(repoPath, '타임아웃 및 큐 폴백 테스트', 'AssertionError: test');
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

  test('13. User 4-intent confirmation gate updates incident intent and userConfirmedIntent', () => {
    const inc = core.collectIncidentBundle(repoPath, '의도 확정 테스트', 'AssertionError: intent mismatch');
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
    const inc = core.collectIncidentBundle(repoPath, '3단계 파이프라인 테스트', 'AssertionError: test');

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
    const inc = core.collectIncidentBundle(repoPath, '승인 게이트 인증 테스트', 'AssertionError: gate');
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
    const inc = core.collectIncidentBundle(repoPath, '변조 탐지 테스트', 'AssertionError: test');
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
    const inc = core.collectIncidentBundle(repoPath, '패치 드리프트 테스트', 'AssertionError: drift');
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
    const inc = core.collectIncidentBundle(repoPath, '테스트 명령 변조 방어', 'AssertionError: cmd');
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
    const inc = core.collectIncidentBundle(repoPath, '의존성 폴더 오염 감지 테스트', 'AssertionError: heavy');
    const project = core.ensureProject(repoPath);

    // Create a dummy node_modules directory in repoPath
    const nodeModulesDir = path.join(repoPath, 'node_modules');
    const fakeDepDir = path.join(nodeModulesDir, 'sample_dep');
    fs.mkdirSync(fakeDepDir, { recursive: true });
    fs.writeFileSync(path.join(fakeDepDir, 'index.js'), 'module.exports = {};\n');

    // Introduce a malicious test script that pollutes node_modules during execution
    const maliciousTestScript = path.join(repoPath, 'pollute_test.js');
    fs.writeFileSync(
      maliciousTestScript,
      `const fs = require('fs');\nconst path = require('path');\nfs.writeFileSync(path.join(__dirname, 'node_modules', 'sample_dep', 'taint.txt'), 'polluted!');\nconsole.log('POLLUTION_DONE');\n`
    );

    core.updateProjectSettings(repoPath, { testCommand: 'node pollute_test.js' });

    const { executionResult } = await core.proposeAndVerifyRepair(repoPath, inc.id, 'fix with pollution', [
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a / b;', replace: 'return 1;' }],
      },
    ]);

    // MUST NOT pass validation because connected heavy directory was mutated
    assert.strictEqual(executionResult.success, false, 'Validation must fail when host dependency directory is mutated');
    assert.ok(
      executionResult.output.includes('원본 의존성 폴더 변경 감지'),
      'Output report must explicitly indicate 원본 의존성 폴더 변경 감지'
    );

    // Clean up
    fs.rmSync(nodeModulesDir, { recursive: true, force: true });
    if (fs.existsSync(maliciousTestScript)) fs.unlinkSync(maliciousTestScript);
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
});
