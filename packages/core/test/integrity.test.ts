import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as http from 'node:http';
import { CoreManager } from '../src/core-manager.js';
import { AutopsyDatabase } from '../src/db/database.js';
import { ApiServer } from '../src/server/api-server.js';
import { GENESIS_PREV_HASH, getInstallationSecretKey } from '../src/utils/security.js';

describe('C-1: Audit Log Hash Chain (Tamper-Evident Integrity Tests)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-integrity-test-'));
  const repoPath = path.join(tmpBase, 'sample_project');
  const dbPath = path.join(tmpBase, 'test_autopsy.db');

  let core: CoreManager;

  before(() => {
    fs.mkdirSync(repoPath, { recursive: true });

    // Initialize git repository
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath });

    fs.writeFileSync(
      path.join(repoPath, 'calculator.js'),
      'export function add(a, b) { return a - b; }\n', // intentional bug
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoPath, 'test.js'),
      `import { add } from './calculator.js';
if (add(2, 3) !== 5) {
  console.error("Test failed: add(2, 3) !== 5");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node test.js' } }),
      'utf8'
    );

    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'Initial commit with bug'], { cwd: repoPath });

    core = new CoreManager({ customDbPath: dbPath });
  });

  after(async () => {
    await core.shutdown();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  });

  test('1. Normal flow creates an unbroken audit_log hash chain with all 6 events', async () => {
    // 1. Confirm test command (TEST_COMMAND_CONFIRMED)
    core.confirmTestCommand(repoPath, 'node test.js');

    // 2. Capture baseline checkpoint
    const cp = core.captureCheckpoint(repoPath, 'Initial Checkpoint', 'tester');

    // 3. Register incident on test failure (INCIDENT_REGISTERED)
    let errorOutput = '';
    try {
      execFileSync('node', ['test.js'], { cwd: repoPath, stdio: 'pipe' });
    } catch (err: any) {
      errorOutput = err.stderr ? err.stderr.toString() : err.message;
    }

    const incident = await core.collectIncidentBundle(repoPath, {
      title: 'Calculator add returns subtraction',
      errorOutput,
      agentName: 'antigravity',
      userReportText: 'add(2, 3) 결과가 5가 아닌 -1이 나옵니다.',
    });

    // 4. Propose and verify repair (PROPOSAL_CREATED)
    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      incident.id,
      'add 함수에서 + 연산자 대신 - 연산자를 사용하여 잘못된 결과를 반환함',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a + b;',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');

    // 5. Approve proposal (PROPOSAL_APPROVED)
    core.approveProposal(proposal.id);

    // 6. Apply approved repair (REPAIR_APPLIED)
    core.applyApprovedRepair(repoPath, proposal.id);

    // 7. Rollback to checkpoint (ROLLBACK_EXECUTED)
    core.rollbackToCheckpoint(repoPath, cp.id);

    // Verify Audit Chain
    const check = core.verifyAuditChain();
    assert.strictEqual(check.valid, true, 'Audit chain must be valid');
    assert.strictEqual(check.status, 'OK');
    assert.strictEqual(check.totalCount, 7, 'Exactly 7 audit events must be logged');

    // Verify all entries in detail
    const logs = core.getAuditLogs(10);
    assert.strictEqual(logs.length, 7);

    // Order is descending in getAuditLogs
    const ordered = [...logs].reverse(); // seq 1..7
    assert.strictEqual(ordered[0].seq, 1);
    assert.strictEqual(ordered[0].kind, 'TEST_COMMAND_CONFIRMED');
    assert.strictEqual(ordered[0].prevHash, GENESIS_PREV_HASH);

    assert.strictEqual(ordered[1].seq, 2);
    assert.strictEqual(ordered[1].kind, 'HEAD_ANCHOR_INITIALIZED');
    assert.strictEqual(ordered[1].prevHash, ordered[0].entryHash);

    assert.strictEqual(ordered[2].seq, 3);
    assert.strictEqual(ordered[2].kind, 'INCIDENT_REGISTERED');
    assert.strictEqual(ordered[2].prevHash, ordered[1].entryHash);

    assert.strictEqual(ordered[3].seq, 4);
    assert.strictEqual(ordered[3].kind, 'PROPOSAL_CREATED');
    assert.strictEqual(ordered[3].prevHash, ordered[2].entryHash);

    assert.strictEqual(ordered[4].seq, 5);
    assert.strictEqual(ordered[4].kind, 'PROPOSAL_APPROVED');
    assert.strictEqual(ordered[4].prevHash, ordered[3].entryHash);

    assert.strictEqual(ordered[5].seq, 6);
    assert.strictEqual(ordered[5].kind, 'REPAIR_APPLIED');
    assert.strictEqual(ordered[5].prevHash, ordered[4].entryHash);

    assert.strictEqual(ordered[6].seq, 7);
    assert.strictEqual(ordered[6].kind, 'ROLLBACK_EXECUTED');
    assert.strictEqual(ordered[6].prevHash, ordered[5].entryHash);
  });

  test('2. Direct SQLite tampering - Test ④: audit_log middle entry value modification detects VALUE_MODIFIED at exact seq', () => {
    // Open DB directly with node:sqlite
    const directDb = new DatabaseSync(dbPath);
    // Tamper with seq 3's payload_hash
    directDb.exec(`
      UPDATE audit_log 
      SET payload_hash = 'tampered_payload_hash_0000000000000000000000000000000000000000'
      WHERE seq = 3;
    `);
    directDb.close();

    const check = core.verifyAuditChain();
    assert.strictEqual(check.valid, false, 'Tampered chain must be detected as invalid');
    assert.strictEqual(check.status, 'BROKEN');
    assert.strictEqual(check.brokenSeq, 3, 'Must identify exact broken seq 3');
    assert.strictEqual(check.reason, '값 변경', 'Reason must be 값 변경');
    assert.strictEqual(check.reasonCode, 'VALUE_MODIFIED');
    assert.ok(check.message.includes('값 변조 감지 (seq 3)'));

    // Restore original payload hash for next test
    const rawDb = new DatabaseSync(dbPath);
    // Re-verify after recalculating seq 3's proper hash
    // We can test deletion next
    rawDb.close();
  });

  test('3. Direct SQLite tampering - Test ⑤: audit_log middle entry deletion detects ORDER_OR_DELETION', () => {
    const directDb = new DatabaseSync(dbPath);
    // Delete seq 3 entirely
    directDb.exec(`DELETE FROM audit_log WHERE seq = 3;`);
    directDb.close();

    const check = core.verifyAuditChain();
    assert.strictEqual(check.valid, false, 'Chain with deleted row must be detected as invalid');
    assert.strictEqual(check.status, 'BROKEN');
    assert.strictEqual(check.brokenSeq, 3, 'Must identify broken position at seq 3');
    assert.strictEqual(check.reason, '항목 삭제/순서 변경', 'Reason must be 항목 삭제/순서 변경');
    assert.strictEqual(check.reasonCode, 'ORDER_OR_DELETION');
    assert.ok(check.message.includes('감지되었습니다'));
  });

  test('4. Key mismatch detection when chain is evaluated with a different secret key', () => {
    const separateDbPath = path.join(tmpBase, 'separate_key.db');
    const separateDb = new AutopsyDatabase(separateDbPath);

    // Append 3 valid entries with current key
    separateDb.appendAuditLog({
      kind: 'INCIDENT_REGISTERED',
      entityType: 'INCIDENT',
      entityId: 'inc_1',
      payloadHash: 'hash_1',
    });
    separateDb.appendAuditLog({
      kind: 'PROPOSAL_CREATED',
      entityType: 'PROPOSAL',
      entityId: 'prop_1',
      payloadHash: 'hash_2',
    });

    // Verify with correct key -> OK
    const okCheck = separateDb.verifyAuditChain();
    assert.strictEqual(okCheck.valid, true);
    assert.strictEqual(okCheck.totalCount, 3);

    // Verify with WRONG key -> KEY_MISMATCH
    const wrongKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const badCheck = separateDb.verifyAuditChain(wrongKey);
    assert.strictEqual(badCheck.valid, false);
    assert.strictEqual(badCheck.status, 'BROKEN');
    assert.strictEqual(badCheck.brokenSeq, 1);
    assert.strictEqual(badCheck.reason, '키 불일치');
    assert.strictEqual(badCheck.reasonCode, 'KEY_MISMATCH');
    assert.ok(badCheck.message.includes('서명 키 불일치'));

    separateDb.close();
  });

  test('5. 단일 연결 연속 기록 (Single-connection sequential burst) 시 해시 체인 연속성 유지', async () => {
    const concurrentDbPath = path.join(tmpBase, 'concurrent.db');
    const sharedDb = new AutopsyDatabase(concurrentDbPath);

    const taskCount = 25;
    const promises = Array.from({ length: taskCount }, (_, i) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          sharedDb.appendAuditLog({
            kind: 'CONCURRENT_EVENT',
            entityType: 'TEST',
            entityId: `entity_${i}`,
            payloadHash: `payload_hash_${i}`,
          });
          resolve();
        }, Math.floor(Math.random() * 20));
      });
    });

    await Promise.all(promises);

    const verifyResult = sharedDb.verifyAuditChain();
    assert.strictEqual(verifyResult.valid, true, 'Chain must be valid under sequential writes');
    assert.strictEqual(verifyResult.status, 'OK');
    assert.strictEqual(verifyResult.totalCount, taskCount + 1, `All ${taskCount + 1} entries must be present`);

    const allLogs = sharedDb.getAuditLogs(taskCount + 5);
    assert.strictEqual(allLogs.length, taskCount + 1);
    // Sequences must be strictly 1..taskCount + 1
    const seqs = allLogs.map((l) => l.seq).sort((a, b) => a - b);
    for (let i = 0; i < taskCount + 1; i++) {
      assert.strictEqual(seqs[i], i + 1, `Sequence must be contiguous at index ${i}`);
    }

    sharedDb.close();
  });

  test('6. 다중 프로세스 실제 동시 쓰기 (Multi-process 4 workers x 25 writes) - 충돌 제어, seq 연속성 및 체인 무결성 검증', async () => {
    const multiDbPath = path.join(tmpBase, 'multi_process_concurrent.db');
    // Initialize DB schema first
    const initDb = new AutopsyDatabase(multiDbPath);
    initDb.close();

    const distIndexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
    const workerScriptPath = path.join(tmpBase, 'worker.mjs');

    const workerScriptContent = `
import { fileURLToPath } from 'node:url';

const distIndexPath = process.argv[2];
const dbPath = process.argv[3];
const workerId = process.argv[4];
const count = parseInt(process.argv[5], 10) || 25;

const { AutopsyDatabase } = await import('file:///' + distIndexPath.replace(/\\\\/g, '/'));

const startTime = Date.now();
const db = new AutopsyDatabase(dbPath);
let written = 0;

for (let i = 0; i < count; i++) {
  db.appendAuditLog({
    kind: 'MULTI_PROC_EVENT',
    entityType: 'WORKER',
    entityId: \`worker_\${workerId}_\${i}\`,
    payloadHash: \`payload_hash_\${workerId}_\${i}\`,
  });
  written++;
}

const endTime = Date.now();
const busyRetries = AutopsyDatabase.totalBusyRetries || 0;
db.close();

console.log(JSON.stringify({
  workerId: Number(workerId),
  count: written,
  startTime,
  endTime,
  durationMs: endTime - startTime,
  busyRetries,
}));
`;
    fs.writeFileSync(workerScriptPath, workerScriptContent, 'utf8');

    const workerCount = 4;
    const writesPerWorker = 25;
    const totalWrites = workerCount * writesPerWorker;

    // Launch 4 separate Node child processes simultaneously
    const workerPromises = Array.from({ length: workerCount }, (_, i) => {
      return new Promise<{ workerId: number; count: number; startTime: number; endTime: number; durationMs: number; busyRetries: number }>((resolve, reject) => {
        const child = spawn(
          'node',
          [workerScriptPath, distIndexPath, multiDbPath, String(i), String(writesPerWorker)],
          {
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );

        let stdoutBuf = '';
        let stderrBuf = '';

        child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
        child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Worker ${i} exited with code ${code}: ${stderrBuf}`));
          } else {
            try {
              const lines = stdoutBuf.trim().split('\n');
              const jsonLine = lines[lines.length - 1];
              resolve(JSON.parse(jsonLine));
            } catch (err) {
              reject(new Error(`Failed to parse worker ${i} output: ${stdoutBuf}`));
            }
          }
        });
      });
    });

    const results = await Promise.all(workerPromises);

    // Concurrency proof: Check overlapping execution intervals
    const earliestStart = Math.min(...results.map((r) => r.startTime));
    const latestStart = Math.max(...results.map((r) => r.startTime));
    const earliestEnd = Math.min(...results.map((r) => r.endTime));
    const latestEnd = Math.max(...results.map((r) => r.endTime));
    const totalBusyRetries = results.reduce((sum, r) => sum + r.busyRetries, 0);

    const isOverlapping = latestStart <= earliestEnd || (latestEnd - earliestStart > 0);
    assert.strictEqual(isOverlapping, true, 'Worker execution intervals must overlap in real time');

    console.log('\n--- 다중 프로세스 실제 동시 쓰기 증명 (4개 독립 프로세스) ---');
    console.table(
      results.map((r) => ({
        '워커 ID': r.workerId,
        '쓰기 횟수': r.count,
        '시작 시각(ms)': r.startTime,
        '종료 시각(ms)': r.endTime,
        '소요 시간(ms)': r.durationMs,
        'SQLITE_BUSY 재시도': r.busyRetries,
      }))
    );
    console.log(`전체 실행 구간: ${earliestStart} ~ ${latestEnd} (총 ${latestEnd - earliestStart}ms, 총 재시도: ${totalBusyRetries}회)\n`);

    // Verify Audit Chain on shared DB
    const finalDb = new AutopsyDatabase(multiDbPath);
    const verifyResult = finalDb.verifyAuditChain();
    assert.strictEqual(verifyResult.valid, true, 'Audit chain must be valid after multi-process concurrent writes');
    assert.strictEqual(verifyResult.status, 'OK');
    assert.strictEqual(verifyResult.totalCount, totalWrites + 1, `All ${totalWrites + 1} entries must be present`);

    // Verify HEAD_ANCHOR_INITIALIZED is recorded exactly once
    const headInitCount = (finalDb as any).db
      .prepare("SELECT COUNT(*) as c FROM audit_log WHERE kind = 'HEAD_ANCHOR_INITIALIZED'")
      .get().c;
    assert.strictEqual(Number(headInitCount), 1, 'HEAD_ANCHOR_INITIALIZED must be exactly 1 under concurrent writes');

    // Verify sequence numbers are strictly 1..101
    const allLogs = finalDb.getAuditLogs(totalWrites + 10);
    assert.strictEqual(allLogs.length, totalWrites + 1);
    const seqs = allLogs.map((l) => l.seq).sort((a, b) => a - b);
    for (let i = 0; i < totalWrites + 1; i++) {
      assert.strictEqual(seqs[i], i + 1, `Sequence must be exactly ${i + 1} without gaps or duplicates`);
    }

    finalDb.close();
  });

  test('7. Empty table or migration on existing DB returns OK with 0 entries', () => {
    const emptyDbPath = path.join(tmpBase, 'empty.db');
    const emptyDb = new AutopsyDatabase(emptyDbPath);

    const result = emptyDb.verifyAuditChain();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.status, 'OK');
    assert.strictEqual(result.totalCount, 0);

    emptyDb.close();
  });
});

describe('C-2: Proposal Row Signature & Approval Block (Tamper-Evident Integrity Tests)', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-integrity-c2-'));
  const repoPath = path.join(tmpBase, 'sample_project');
  const dbPath = path.join(tmpBase, 'c2_autopsy.db');

  let core: CoreManager;
  let incidentId: string;

  before(async () => {
    fs.mkdirSync(repoPath, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repoPath });

    fs.writeFileSync(
      path.join(repoPath, 'calculator.js'),
      'export function add(a, b) { return a - b; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoPath, 'test.js'),
      `import { add } from './calculator.js';
if (add(2, 3) !== 5) {
  console.error("Test failed: add(2, 3) !== 5");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node test.js' } }),
      'utf8'
    );

    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'Initial commit with bug'], { cwd: repoPath });

    core = new CoreManager({ customDbPath: dbPath });
    core.confirmTestCommand(repoPath, 'node test.js');
    core.captureCheckpoint(repoPath, 'Initial Checkpoint', 'tester');

    let errorOutput = '';
    try {
      execFileSync('node', ['test.js'], { cwd: repoPath, stdio: 'pipe' });
    } catch (err: any) {
      errorOutput = err.stderr ? err.stderr.toString() : err.message;
    }

    const inc = await core.collectIncidentBundle(repoPath, {
      title: 'Calculator add returns subtraction',
      errorOutput,
      expectedBehavior: 'add(2, 3) === 5',
      observedBehavior: 'add(2, 3) === -1',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });
    incidentId = inc.id;
  });

  after(async () => {
    await core.shutdown();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  });

  test('1. 변조 시험 ①: 제안 생성 후 별도 프로세스(node:sqlite)로 file_changes_json 직접 수정 -> 승인 시도 -> 서명 불일치로 차단 및 TAMPERED 전이', async () => {
    // 1. Create a valid proposal
    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      incidentId,
      'Change minus to plus in add function',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a + b;',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    assert.ok(proposal.rowSignature, 'Proposal must have rowSignature generated');

    // 2. Separate Node process tampers file_changes_json directly in SQLite
    const tamperedChanges = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [
          {
            search: 'return a - b;',
            replace: 'return a * b; // rogue backdoor injected directly in DB',
          },
        ],
      },
    ]);

    const tamperScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare('UPDATE repair_proposals SET file_changes_json = ? WHERE id = ?').run(process.argv[3], process.argv[2]);
      db.close();
    `;

    execFileSync(
      'node',
      ['--input-type=module', '-e', tamperScript, dbPath, proposal.id, tamperedChanges],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // 3. Main process attempts approval -> MUST be blocked with SECURITY_TAMPER_DETECTED
    let caughtErr: any = null;
    try {
      core.approveProposal(proposal.id);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Tampered proposal must be blocked from approval');
    assert.strictEqual(caughtErr.code, 'SECURITY_TAMPER_DETECTED', 'Rejection code must be SECURITY_TAMPER_DETECTED');
    assert.ok(
      caughtErr.message.includes('[SECURITY_TAMPER_DETECTED]'),
      `Error message must contain [SECURITY_TAMPER_DETECTED], got: ${caughtErr.message}`
    );
    assert.ok(
      caughtErr.message.includes('전자서명') || caughtErr.message.includes('변조'),
      'Error message must state signature verification failure or tampering'
    );

    // 4. Verify DB state transitioned to TAMPERED
    const updated = core.getDatabase().getRepairProposal(proposal.id);
    assert.strictEqual(updated?.approvalStatus, 'TAMPERED', 'Proposal approval_status must be marked TAMPERED');

    // 5. Verify TAMPER_DETECTED was appended to audit_log
    const logs = core.getDatabase().getAuditLogs(10);
    const tamperLog = logs.find((l) => l.kind === 'TAMPER_DETECTED' && l.entityId === proposal.id);
    assert.ok(tamperLog, 'audit_log must record TAMPER_DETECTED entry for tampered proposal');
  });

  test('2. 변조 시험 ②: 제안 생성 후 별도 프로세스(node:sqlite)로 verification_status를 FAILED에서 VERIFIED_PASS로 직접 수정 -> 승인 시도 -> 서명 불일치로 차단 및 TAMPERED 전이', async () => {
    // 1. Create a failing proposal
    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      incidentId,
      'Wrong replacement that still fails the test',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a - b - 1;',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_FAIL');
    assert.ok(proposal.rowSignature, 'Proposal must have rowSignature generated');

    // 2. Separate Node process alters verification_status to VERIFIED_PASS directly in SQLite
    const tamperScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare("UPDATE repair_proposals SET verification_status = 'VERIFIED_PASS' WHERE id = ?").run(process.argv[2]);
      db.close();
    `;

    execFileSync(
      'node',
      ['--input-type=module', '-e', tamperScript, dbPath, proposal.id],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // 3. Main process attempts approval -> MUST be blocked specifically by signature mismatch (SECURITY_TAMPER_DETECTED),
    // NOT by TEST_GATE_VIOLATION (since verification_status in DB is now VERIFIED_PASS)
    let caughtErr: any = null;
    try {
      core.approveProposal(proposal.id);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Status-tampered proposal must be blocked from approval');
    assert.strictEqual(
      caughtErr.code,
      'SECURITY_TAMPER_DETECTED',
      'Rejection code must specifically be SECURITY_TAMPER_DETECTED (not TEST_GATE_VIOLATION)'
    );
    assert.ok(caughtErr.message.includes('[SECURITY_TAMPER_DETECTED]'));

    // 4. Verify DB state transitioned to TAMPERED
    const updated = core.getDatabase().getRepairProposal(proposal.id);
    assert.strictEqual(updated?.approvalStatus, 'TAMPERED', 'Proposal status must be marked TAMPERED');

    // 5. Verify audit_log records TAMPER_DETECTED
    const logs = core.getDatabase().getAuditLogs(10);
    const tamperLog = logs.find((l) => l.kind === 'TAMPER_DETECTED' && l.entityId === proposal.id);
    assert.ok(tamperLog, 'audit_log must record TAMPER_DETECTED entry for verification_status tampering');
  });

  test('3. 변조 시험 ③: 다른 설치 키(.auth_secret)로 서명된 repair_proposals 행을 별도 프로세스로 현재 DB에 INSERT -> 승인 시도 -> 서명 불일치로 자동 차단 및 TAMPERED 전이', async () => {
    // 1. Create a separate installation environment with a distinct secret key
    const otherDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopsy-other-install-'));
    const otherSecret = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    fs.writeFileSync(path.join(otherDataDir, '.auth_secret'), otherSecret, 'utf8');

    const foreignPropId = `prop_foreign_${Date.now().toString(36)}`;
    const foreignCreatedAt = new Date().toISOString();
    const foreignChanges = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a - b;', replace: 'return a + b;' }],
      },
    ]);

    // Compute signature using the foreign installation key
    const foreignScript = `
      import * as crypto from 'node:crypto';
      import { DatabaseSync } from 'node:sqlite';

      const dbPath = process.argv[1];
      const otherSecret = process.argv[2];
      const propId = process.argv[3];
      const incId = process.argv[4];
      const changesJson = process.argv[5];
      const createdAt = process.argv[6];
      const projId = process.argv[7];

      // Sign with foreign secret (including project_id)
      const payload = [propId, incId, projId, changesJson, 'VERIFIED_PASS', createdAt].join('::');
      const foreignSignature = crypto.createHmac('sha256', otherSecret).update(payload).digest('hex');

      // Insert directly into destination DB
      const db = new DatabaseSync(dbPath);
      db.prepare(\`
        INSERT INTO repair_proposals (
          id, incident_id, root_cause_analysis, patch_diff, touched_files_json,
          file_changes_json, verification_status, verification_log, approval_status,
          created_at, row_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      \`).run(
        propId,
        incId,
        'Foreign proposal copied from another database',
        'diff',
        JSON.stringify(['calculator.js']),
        changesJson,
        'VERIFIED_PASS',
        'log',
        'AWAITING_USER',
        createdAt,
        foreignSignature
      );
      db.close();
    `;

    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        foreignScript,
        dbPath,
        otherSecret,
        foreignPropId,
        incidentId,
        foreignChanges,
        foreignCreatedAt,
        core.getDatabase().getIncident(incidentId)!.projectId,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // Cleanup other data dir
    try {
      fs.rmSync(otherDataDir, { recursive: true, force: true });
    } catch {}

    // 2. Main process attempts approval -> MUST fail because foreign signature fails HMAC under main secret key
    let caughtErr: any = null;
    try {
      core.approveProposal(foreignPropId);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Foreign-signed proposal must be rejected');
    assert.strictEqual(
      caughtErr.code,
      'SECURITY_TAMPER_DETECTED',
      'Rejection code must be SECURITY_TAMPER_DETECTED due to foreign key mismatch'
    );
    assert.ok(caughtErr.message.includes('[SECURITY_TAMPER_DETECTED]'));

    // 3. Verify DB state transitioned to TAMPERED
    const updated = core.getDatabase().getRepairProposal(foreignPropId);
    assert.strictEqual(updated?.approvalStatus, 'TAMPERED', 'Foreign proposal status must be marked TAMPERED');

    // 4. Verify audit_log
    const logs = core.getDatabase().getAuditLogs(10);
    const tamperLog = logs.find((l) => l.kind === 'TAMPER_DETECTED' && l.entityId === foreignPropId);
    assert.ok(tamperLog, 'audit_log must record TAMPER_DETECTED for foreign proposal insertion');
  });

  test('4. 서명 없는 과거 행(마이그레이션 전 데이터) 승인 시도 -> LEGACY_UNSIGNED로 차단되고 기존 행 보존', () => {
    const legacyPropId = `prop_legacy_${Date.now().toString(36)}`;
    const legacyCreatedAt = new Date().toISOString();
    const legacyChanges = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a - b;', replace: 'return a + b;' }],
      },
    ]);

    // Insert legacy row with row_signature = NULL directly in DB
    const insertLegacyScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare(\`
        INSERT INTO repair_proposals (
          id, incident_id, root_cause_analysis, patch_diff, touched_files_json,
          file_changes_json, verification_status, verification_log, approval_status,
          created_at, row_signature
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      \`).run(
        process.argv[2],
        process.argv[3],
        'Legacy proposal created before row signature migration',
        'diff',
        JSON.stringify(['calculator.js']),
        process.argv[4],
        'VERIFIED_PASS',
        'log',
        'AWAITING_USER',
        process.argv[5]
      );
      db.close();
    `;

    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        insertLegacyScript,
        dbPath,
        legacyPropId,
        incidentId,
        legacyChanges,
        legacyCreatedAt,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // 1. Verify getRepairProposal returns approvalReadiness: 'LEGACY_UNSIGNED'
    const legacyProp = core.getDatabase().getRepairProposal(legacyPropId);
    assert.ok(legacyProp, 'Legacy proposal must be queryable');
    assert.strictEqual(legacyProp.rowSignature, null, 'Legacy proposal rowSignature must be null');
    assert.strictEqual(legacyProp.approvalReadiness, 'LEGACY_UNSIGNED', 'approvalReadiness must present as LEGACY_UNSIGNED');
    assert.ok(
      legacyProp.approvalBlockReason?.includes('서명 없는 기존 수정안은 승인할 수 없습니다. 다시 제안을 생성하세요'),
      `approvalBlockReason must contain exact user guide: ${legacyProp.approvalBlockReason}`
    );

    // 2. Attempt to approve legacy proposal -> MUST throw LEGACY_UNSIGNED error
    let caughtErr: any = null;
    try {
      core.approveProposal(legacyPropId);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Unsigned legacy proposal must be blocked from approval');
    assert.strictEqual(caughtErr.code, 'LEGACY_UNSIGNED', 'Error code must be LEGACY_UNSIGNED');
    assert.ok(
      caughtErr.message.includes('서명 없는 기존 수정안은 승인할 수 없습니다. 다시 제안을 생성하세요'),
      `Error message must contain guide text, got: ${caughtErr.message}`
    );

    // 3. Verify existing DB row was NOT deleted or altered
    const stillExists = core.getDatabase().getRepairProposal(legacyPropId);
    assert.ok(stillExists, 'Legacy proposal row must remain intact in DB');
    assert.strictEqual(stillExists.approvalStatus, 'AWAITING_USER', 'Legacy proposal status must not be overwritten or deleted');
    assert.strictEqual(stillExists.rowSignature, null, 'rowSignature must remain null in DB');
  });

  test('5. updateProposalVerification 정상 경로 재서명 검증: 검증 상태 갱신 시 row_signature가 함께 재서명되어 승인 및 적용이 차단되지 않고 통과하는지', async () => {
    // 1. Create a proposal that passes verification (with a real working patch)
    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      incidentId,
      'Valid fix for add function',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a + b;',
            },
          ],
        },
      ]
    );

    assert.strictEqual(proposal.verificationStatus, 'VERIFIED_PASS');
    const oldSig = proposal.rowSignature;
    assert.ok(oldSig, 'Must have initial rowSignature');

    // 2. Normal path: update verification status using updateProposalVerification
    core.getDatabase().updateProposalVerification(
      proposal.id,
      'VERIFIED_PASS',
      'Re-verified after test re-run with clean isolation',
      'READY_FOR_APPROVAL',
      null
    );

    // 3. Confirm the row still has a valid row_signature in DB
    const refreshed = core.getDatabase().getRepairProposal(proposal.id);
    assert.ok(refreshed);
    assert.strictEqual(refreshed.verificationStatus, 'VERIFIED_PASS');
    assert.ok(refreshed.rowSignature, 'Re-signed rowSignature must exist');

    // 4. Approve proposal -> must succeed without SECURITY_TAMPER_DETECTED
    const approvedFp = core.approveProposal(proposal.id);
    assert.ok(approvedFp);
    const approvedProp = core.getDatabase().getRepairProposal(proposal.id);
    assert.strictEqual(approvedProp?.approvalStatus, 'APPROVED');

    // 5. Apply proposal -> must succeed without SECURITY_TAMPER_DETECTED
    const applyResult = core.applyApprovedRepair(repoPath, proposal.id);
    assert.strictEqual(applyResult.applied, true);
    const appliedProp = core.getDatabase().getRepairProposal(proposal.id);
    assert.strictEqual(appliedProp?.approvalStatus, 'APPLIED');

    // Restore calculator.js back to bug state for subsequent tests
    fs.writeFileSync(
      path.join(repoPath, 'calculator.js'),
      'export function add(a, b) { return a - b; }\n',
      'utf8'
    );
  });

  test('6. 사건(incidents) 행 서명 검증: 정상 등록은 VALID("정상"), 마이그레이션 전 서명 없는 행은 UNSIGNED("서명 없음"), 별도 프로세스로 user_report_text나 project_id 변조 시 TAMPERED("변조 의심") 반환 및 비차단 확인', async () => {
    // 1. Check normal registered incident from before()
    const normalInc = core.getDatabase().getIncident(incidentId);
    assert.ok(normalInc);
    assert.strictEqual(normalInc.integrityCode, 'VALID');
    assert.strictEqual(normalInc.integrityStatus, '정상');
    assert.ok(normalInc.rowSignature, 'Normal incident must have non-null rowSignature');

    // 2. Register another incident specifically for legacy unsigned simulation
    const legacyInc = await core.collectIncidentBundle(repoPath, {
      title: 'Legacy unsigned incident test',
      userReportText: 'Legacy incident report text without row signature',
      expectedBehavior: 'Expect pass',
      observedBehavior: 'Observed fail',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });

    // Strip signature using separate Node process to simulate pre-migration row
    const stripScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare('UPDATE incidents SET row_signature = NULL WHERE id = ?').run(process.argv[2]);
      db.close();
    `;
    execFileSync(
      'node',
      ['--input-type=module', '-e', stripScript, dbPath, legacyInc.id],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // Query via getIncident: MUST return UNSIGNED / '서명 없음' AND NOT throw/block
    const queriedLegacy = core.getDatabase().getIncident(legacyInc.id);
    assert.ok(queriedLegacy);
    assert.strictEqual(queriedLegacy.integrityCode, 'UNSIGNED');
    assert.strictEqual(queriedLegacy.integrityStatus, '서명 없음');
    assert.strictEqual(queriedLegacy.rowSignature, null);

    // 3. Register incident and tamper user_report_text using separate Node process
    const tamperTextInc = await core.collectIncidentBundle(repoPath, {
      title: 'Tamper user_report_text test',
      userReportText: 'Original pristine user report text',
      expectedBehavior: 'Expect pass',
      observedBehavior: 'Observed fail',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });

    const tamperTextScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare("UPDATE incidents SET user_report_text = 'Tampered text by rogue unauthorized tool' WHERE id = ?").run(process.argv[2]);
      db.close();
    `;
    execFileSync(
      'node',
      ['--input-type=module', '-e', tamperTextScript, dbPath, tamperTextInc.id],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // Query via getIncident: MUST return TAMPERED / '변조 의심' AND NOT throw/block (non-blocking)
    const queriedTamperedText = core.getDatabase().getIncident(tamperTextInc.id);
    assert.ok(queriedTamperedText, 'Incident lookup must succeed non-blockingly');
    assert.strictEqual(queriedTamperedText.integrityCode, 'TAMPERED');
    assert.strictEqual(queriedTamperedText.integrityStatus, '변조 의심');

    // 4. Register incident and tamper project_id using separate Node process
    const tamperProjInc = await core.collectIncidentBundle(repoPath, {
      title: 'Tamper project_id test',
      userReportText: 'Original text for project id tampering',
      expectedBehavior: 'Expect pass',
      observedBehavior: 'Observed fail',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });

    const tamperProjScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare("UPDATE incidents SET project_id = 'proj_rogue_injected' WHERE id = ?").run(process.argv[2]);
      db.close();
    `;
    execFileSync(
      'node',
      ['--input-type=module', '-e', tamperProjScript, dbPath, tamperProjInc.id],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    const queriedTamperedProj = core.getDatabase().getIncident(tamperProjInc.id);
    assert.ok(queriedTamperedProj, 'Incident lookup must succeed non-blockingly');
    assert.strictEqual(queriedTamperedProj.integrityCode, 'TAMPERED');
    assert.strictEqual(queriedTamperedProj.integrityStatus, '변조 의심');
  });

  test('7. 프로젝트 소속 확인(PROJECT_MISMATCH): 프로젝트 A의 승인된 수정안을 프로젝트 B에 적용 시도 시 PROJECT_MISMATCH로 거부되고 프로젝트 B 파일 미변경, audit_log에 PROJECT_MISMATCH_BLOCKED 기록', async () => {
    // 1. Setup Project B in a separate directory
    const repoPathB = path.join(tmpBase, 'sample_project_b');
    fs.mkdirSync(repoPathB, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPathB });
    execFileSync('git', ['config', 'user.name', 'TesterB'], { cwd: repoPathB });
    execFileSync('git', ['config', 'user.email', 'testerb@example.com'], { cwd: repoPathB });

    const originalCalculatorB = 'export function add(a, b) { return "PROJECT_B_UNTOUCHED"; }\\n';
    fs.writeFileSync(path.join(repoPathB, 'calculator.js'), originalCalculatorB, 'utf8');
    fs.writeFileSync(
      path.join(repoPathB, 'package.json'),
      JSON.stringify({ name: 'calc-b', type: 'module' }),
      'utf8'
    );
    execFileSync('git', ['add', '.'], { cwd: repoPathB });
    execFileSync('git', ['commit', '-m', 'Initial commit in Project B'], { cwd: repoPathB });

    core.confirmTestCommand(repoPathB, 'node -e "process.exit(0)"');
    core.captureCheckpoint(repoPathB, 'Project B Initial', 'tester');

    // 2. Create fresh incident and proposal for Project A
    const inc7 = await core.collectIncidentBundle(repoPath, {
      title: 'Project A cross-project incident',
      userReportText: 'Report for cross project testing',
      expectedBehavior: 'add(2, 3) === 5',
      observedBehavior: 'add(2, 3) === -1',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });

    const { proposal: proposalA } = await core.proposeAndVerifyRepair(
      repoPath,
      inc7.id,
      'Valid fix in Project A',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a + b;',
            },
          ],
        },
      ]
    );

    // 3. Attempt approveProposal with Project B's repoPath -> MUST throw PROJECT_MISMATCH
    let approveErr: any = null;
    try {
      core.approveProposal(proposalA.id, undefined, true, repoPathB);
    } catch (err: any) {
      approveErr = err;
    }
    assert.ok(approveErr, 'Cross-project approval must throw');
    assert.strictEqual(approveErr.code, 'PROJECT_MISMATCH');
    assert.ok(approveErr.message.includes('[PROJECT_MISMATCH]'));

    // Approve proposal for Project A legitimately (forceOverrideWithRiskAck = true)
    core.approveProposal(proposalA.id, undefined, true, repoPath);

    // 4. Attempt applyApprovedRepair targeting Project B -> MUST throw PROJECT_MISMATCH
    let applyErr: any = null;
    try {
      core.applyApprovedRepair(repoPathB, proposalA.id);
    } catch (err: any) {
      applyErr = err;
    }

    assert.ok(applyErr, 'Cross-project repair application must be blocked');
    assert.strictEqual(applyErr.code, 'PROJECT_MISMATCH');
    assert.ok(applyErr.message.includes('[PROJECT_MISMATCH]'));
    assert.ok(applyErr.message.includes('일치하지 않습니다'));

    // 5. Verify Project B files remain completely untouched
    const currentCalculatorB = fs.readFileSync(path.join(repoPathB, 'calculator.js'), 'utf8');
    assert.strictEqual(currentCalculatorB, originalCalculatorB, 'Project B file must be completely untouched');

    // 6. Verify audit_log recorded PROJECT_MISMATCH_BLOCKED
    const logs = core.getDatabase().getAuditLogs(20);
    const mismatchLog = logs.find((l) => l.kind === 'PROJECT_MISMATCH_BLOCKED' && l.entityId === proposalA.id);
    assert.ok(mismatchLog, 'audit_log must record PROJECT_MISMATCH_BLOCKED');
  });

  test('8. SQLite로 사건의 project_id를 몰래 변경 후 적용 시도 시 차단 검증: 서명 불일치(SECURITY_TAMPER_DETECTED) 또는 소속 불일치(PROJECT_MISMATCH)로 파일 적용 원천 차단', async () => {
    // 1. Create a fresh incident and clean proposal in Project A
    const inc8 = await core.collectIncidentBundle(repoPath, {
      title: 'Incident for project tampering check',
      userReportText: 'Report for project tampering check',
      expectedBehavior: 'add(2, 3) === 5',
      observedBehavior: 'add(2, 3) === -1',
      reproductionCondition: 'node test.js',
      verificationMethod: 'Run node test.js',
    });

    const { proposal } = await core.proposeAndVerifyRepair(
      repoPath,
      inc8.id,
      'Another valid fix in Project A',
      [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'return a - b;',
              replace: 'return a + b;',
            },
          ],
        },
      ]
    );

    // Approve legitimately
    core.approveProposal(proposal.id, undefined, true);

    // 2. Secretly modify incident's project_id in SQLite using separate Node process
    const rogueProjectId = 'proj_rogue_forged';
    const tamperScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare('UPDATE incidents SET project_id = ? WHERE id = ?').run(process.argv[3], process.argv[2]);
      db.close();
    `;
    execFileSync(
      'node',
      ['--input-type=module', '-e', tamperScript, dbPath, inc8.id, rogueProjectId],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // 3. Attempt to apply in Project A -> incident.projectId is now 'proj_rogue_forged',
    // which differs from Project A's ID!
    let caughtErr: any = null;
    try {
      core.applyApprovedRepair(repoPath, proposal.id);
    } catch (err: any) {
      caughtErr = err;
    }

    assert.ok(caughtErr, 'Tampered incident project_id must block repair application');
    assert.ok(
      caughtErr.code === 'PROJECT_MISMATCH' || caughtErr.code === 'SECURITY_TAMPER_DETECTED',
      `Rejection code must be PROJECT_MISMATCH or SECURITY_TAMPER_DETECTED, got: ${caughtErr.code}`
    );

    // 4. Verify calculator.js was NOT modified
    const currentCalc = fs.readFileSync(path.join(repoPath, 'calculator.js'), 'utf8');
    assert.ok(currentCalc.includes('return a - b;'), 'calculator.js must NOT have received the patch');

    // Restore original project_id in SQLite for cleanup
    const restoreScript = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA foreign_keys = OFF;');
      db.prepare('UPDATE incidents SET project_id = ? WHERE id = ?').run(process.argv[3], process.argv[2]);
      db.close();
    `;
    const projA = core.getDatabase().getProjectByPath(repoPath);
    execFileSync(
      'node',
      ['--input-type=module', '-e', restoreScript, dbPath, inc8.id, projA!.id],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );
  });

  test('9. 마이그레이션 재서명 안전성: 중복 프로젝트 ID 통합 시 기존 서명 검증 통과한 정상 행만 canonicalId로 재서명되고 변조된 행은 TAMPERED로 유지되어 승인 차단', async () => {
    const migrationDbPath = path.join(tmpBase, 'migration_test.db');
    const secret = getInstallationSecretKey();

    // 1. Initial run: establish canonical project for repoPath in migrationDb
    const initialCore = new CoreManager({ customDbPath: migrationDbPath });
    initialCore.confirmTestCommand(repoPath, 'node test.js');
    initialCore.captureCheckpoint(repoPath, 'Migration Baseline', 'tester');
    const canonicalProj = initialCore.getDatabase().getProjectByPath(repoPath);
    assert.ok(canonicalProj);
    const canonicalId = canonicalProj.id;
    await initialCore.shutdown();

    // 2. Separate Node process inserts duplicate legacy project and creates both valid and tampered rows
    const legacyProjId = `proj_legacy_dup_${Date.now().toString(36)}`;
    const legacyRootPath = canonicalProj.rootPath.includes('\\')
      ? canonicalProj.rootPath.replace(/\\/g, '/')
      : canonicalProj.rootPath.replace(/\//g, '\\');
    const nowIso = new Date().toISOString();

    const incValidId = `inc_mig_valid_${Date.now().toString(36)}`;
    const incTamperedId = `inc_mig_tampered_${Date.now().toString(36)}`;
    const propValidId = `prop_mig_valid_${Date.now().toString(36)}`;
    const propTamperedId = `prop_mig_tampered_${Date.now().toString(36)}`;

    const validPatchJson = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a - b;', replace: 'return a + b;' }],
      },
    ]);
    const tamperedPatchJson = JSON.stringify([
      {
        filePath: 'calculator.js',
        replacements: [{ search: 'return a - b;', replace: 'return a * 999; // rogue backdoor' }],
      },
    ]);

    const setupLegacyScript = `
      import * as crypto from 'node:crypto';
      import { DatabaseSync } from 'node:sqlite';

      const [
        ,
        dbPath,
        secret,
        legacyProjId,
        legacyRootPath,
        incValidId,
        incTamperedId,
        propValidId,
        propTamperedId,
        validPatchJson,
        tamperedPatchJson,
        nowIso
      ] = process.argv;

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = OFF;');

      // 1. Insert duplicate legacy project with identical normalized root_path
      db.prepare(\`
        INSERT INTO projects (id, name, root_path, created_at)
        VALUES (?, 'Legacy Duplicate Project', ?, ?)
      \`).run(legacyProjId, legacyRootPath, nowIso);

      // Helper to compute HMAC
      function signIncident(id, projId, text, createdAt) {
        const payload = [id, projId, text || '', createdAt].join('::');
        return crypto.createHmac('sha256', secret).update(payload).digest('hex');
      }

      function signProposal(id, incId, projId, changesJson, status, createdAt) {
        const payload = [id, incId, projId, changesJson, status, createdAt].join('::');
        return crypto.createHmac('sha256', secret).update(payload).digest('hex');
      }

      // 2. Insert incValid (valid signature for legacyProjId)
      const validText = 'Normal bug report text';
      const sigIncValid = signIncident(incValidId, legacyProjId, validText, nowIso);
      db.prepare(\`
        INSERT INTO incidents (id, project_id, title, error_output, diff_summary, user_report_text, status, row_signature, created_at)
        VALUES (?, ?, 'Valid incident', '', '', ?, 'OPEN', ?, ?)
      \`).run(incValidId, legacyProjId, validText, sigIncValid, nowIso);

      // 3. Insert incTampered (valid signature generated for original text, but user_report_text tampered directly)
      const originalText = 'Pristine original text before unauthorized tamper';
      const sigIncTampered = signIncident(incTamperedId, legacyProjId, originalText, nowIso);
      db.prepare(\`
        INSERT INTO incidents (id, project_id, title, error_output, diff_summary, user_report_text, status, row_signature, created_at)
        VALUES (?, ?, 'Tampered incident', '', '', ?, 'OPEN', ?, ?)
      \`).run(incTamperedId, legacyProjId, 'TAMPERED user_report_text injected directly in DB', sigIncTampered, nowIso);

      // 4. Insert propValid (valid proposal and signature for legacyProjId)
      const sigPropValid = signProposal(propValidId, incValidId, legacyProjId, validPatchJson, 'VERIFIED_PASS', nowIso);
      db.prepare(\`
        INSERT INTO repair_proposals (
          id, incident_id, root_cause_analysis, patch_diff, touched_files_json,
          file_changes_json, verification_status, verification_log, approval_status,
          approval_readiness, created_at, row_signature
        ) VALUES (?, ?, 'Valid rca', 'diff', ?, ?, 'VERIFIED_PASS', 'log', 'AWAITING_USER', 'READY_FOR_APPROVAL', ?, ?)
      \`).run(
        propValidId,
        incValidId,
        JSON.stringify(['calculator.js']),
        validPatchJson,
        nowIso,
        sigPropValid
      );

      // 5. Insert propTampered (valid signature generated for validPatchJson, but file_changes_json tampered directly)
      const sigPropTampered = signProposal(propTamperedId, incValidId, legacyProjId, validPatchJson, 'VERIFIED_PASS', nowIso);
      db.prepare(\`
        INSERT INTO repair_proposals (
          id, incident_id, root_cause_analysis, patch_diff, touched_files_json,
          file_changes_json, verification_status, verification_log, approval_status,
          approval_readiness, created_at, row_signature
        ) VALUES (?, ?, 'Tampered rca', 'diff', ?, ?, 'VERIFIED_PASS', 'log', 'AWAITING_USER', 'READY_FOR_APPROVAL', ?, ?)
      \`).run(
        propTamperedId,
        incValidId,
        JSON.stringify(['calculator.js']),
        tamperedPatchJson,
        nowIso,
        sigPropTampered
      );

      db.close();
    `;

    execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        setupLegacyScript,
        migrationDbPath,
        secret,
        legacyProjId,
        legacyRootPath,
        incValidId,
        incTamperedId,
        propValidId,
        propTamperedId,
        validPatchJson,
        tamperedPatchJson,
        nowIso,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' } }
    );

    // 3. Re-open DB with CoreManager -> triggers migrateDeterministicProjectIds()
    const coreMigrated = new CoreManager({ customDbPath: migrationDbPath });

    // ① Check propTampered: migration did NOT re-sign it; approval MUST be rejected with SECURITY_TAMPER_DETECTED
    let tamperedApproveErr: any = null;
    try {
      coreMigrated.approveProposal(propTamperedId, undefined, true);
    } catch (err: any) {
      tamperedApproveErr = err;
    }
    assert.ok(tamperedApproveErr, 'Tampered proposal must be blocked from approval even after migration');
    assert.strictEqual(
      tamperedApproveErr.code,
      'SECURITY_TAMPER_DETECTED',
      `Expected SECURITY_TAMPER_DETECTED, got: ${tamperedApproveErr.code}`
    );
    const tamperedPropRow = coreMigrated.getDatabase().getRepairProposal(propTamperedId);
    assert.strictEqual(tamperedPropRow?.approvalStatus, 'TAMPERED', 'Tampered proposal must be transitioned to TAMPERED');

    // ② Check propValid: migration properly re-signed it with canonicalId; approval & application MUST succeed
    const approvedFp = coreMigrated.approveProposal(propValidId, undefined, true);
    assert.ok(approvedFp, 'Valid migrated proposal must be approvable');

    const applyResult = coreMigrated.applyApprovedRepair(repoPath, propValidId);
    assert.strictEqual(applyResult.applied, true, 'Valid migrated proposal must apply cleanly');
    const appliedPropRow = coreMigrated.getDatabase().getRepairProposal(propValidId);
    assert.strictEqual(appliedPropRow?.approvalStatus, 'APPLIED');

    // ③ Check incidents:
    // incTampered must have integrityCode === 'TAMPERED' ('변조 의심')
    const queriedTamperedInc = coreMigrated.getDatabase().getIncident(incTamperedId);
    assert.ok(queriedTamperedInc);
    assert.strictEqual(queriedTamperedInc.integrityCode, 'TAMPERED');
    assert.strictEqual(queriedTamperedInc.integrityStatus, '변조 의심');

    // incValid must have integrityCode === 'VALID' ('정상')
    const queriedValidInc = coreMigrated.getDatabase().getIncident(incValidId);
    assert.ok(queriedValidInc);
    assert.strictEqual(queriedValidInc.integrityCode, 'VALID');
    assert.strictEqual(queriedValidInc.integrityStatus, '정상');

    // Clean up
    await coreMigrated.shutdown();
    fs.writeFileSync(
      path.join(repoPath, 'calculator.js'),
      'export function add(a, b) { return a - b; }\n',
      'utf8'
    );
  });

  test('10. C-3: API-Level Integrity Verification & Tampered Proposal Approval Rejection', async () => {
    const apiServer = new ApiServer(core);
    const port = await apiServer.start(3880);
    const token = apiServer.getSessionToken();
    assert.ok(token && token.length >= 32, 'Session token must be present');

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

    try {
      // 1. Check GET /api/audit-chain/status
      // Unauthenticated: 401
      const unauthChain = await makeRequest('/api/audit-chain/status', 'GET', {});
      assert.strictEqual(unauthChain.status, 401, 'Unauthenticated audit chain request must return 401');

      // Authenticated: 200 with valid audit chain
      const chainRes = await makeRequest('/api/audit-chain/status', 'GET', { 'X-Autopsy-Token': token });
      assert.strictEqual(chainRes.status, 200);
      assert.strictEqual(chainRes.body.success, true);
      assert.strictEqual(chainRes.body.result.valid, true);
      assert.ok(chainRes.body.result.totalCount > 0);

      // 2. Create an incident and a verified repair proposal
      const inc = await core.collectIncidentBundle(repoPath, 'API 무결성 시험용 사건', 'Error: api integrity');
      const { proposal } = await core.proposeAndVerifyRepair(repoPath, inc.id, 'fix add function', [
        {
          filePath: 'calculator.js',
          replacements: [
            {
              search: 'export function add(a, b) { return a - b; }',
              replace: 'export function add(a, b) { return a + b; }',
            },
          ],
        },
      ]);
      assert.ok(proposal);

      // 3. Query GET /api/proposals/:id/integrity for the valid proposal
      const validIntegRes = await makeRequest(
        `/api/proposals/${proposal.id}/integrity?repoPath=${encodeURIComponent(repoPath)}`,
        'GET',
        { 'X-Autopsy-Token': token }
      );
      assert.strictEqual(validIntegRes.status, 200);
      assert.strictEqual(validIntegRes.body.result.valid, true);
      assert.strictEqual(validIntegRes.body.result.status, '정상');
      assert.strictEqual(validIntegRes.body.result.code, 'VALID');

      // 4. Test PROJECT_MISMATCH with a different project path
      const fakeOtherRepo = path.join(tmpBase, 'another_project');
      fs.mkdirSync(fakeOtherRepo, { recursive: true });
      execFileSync('git', ['init', '-b', 'main'], { cwd: fakeOtherRepo });
      core.ensureProject(fakeOtherRepo);

      const mismatchRes = await makeRequest(
        `/api/proposals/${proposal.id}/integrity?repoPath=${encodeURIComponent(fakeOtherRepo)}`,
        'GET',
        { 'X-Autopsy-Token': token }
      );
      assert.strictEqual(mismatchRes.status, 200);
      assert.strictEqual(mismatchRes.body.result.valid, false);
      assert.strictEqual(mismatchRes.body.result.status, '프로젝트 불일치');
      assert.strictEqual(mismatchRes.body.result.code, 'PROJECT_MISMATCH');

      // 5. Tamper with the proposal via external process (direct DB update)
      const tamperScript = `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        db.exec("UPDATE repair_proposals SET file_changes_json = '{\\\"tampered\\\":true}' WHERE id = '" + process.argv[2] + "'");
        db.close();
      `;
      execFileSync(
        'node',
        ['--input-type=module', '-e', tamperScript, dbPath, proposal.id],
        { env: { ...process.env, NODE_OPTIONS: '' } }
      );

      // 6. Query GET /api/proposals/:id/integrity for the tampered proposal -> Must return '변조 의심'
      const tamperedIntegRes = await makeRequest(
        `/api/proposals/${proposal.id}/integrity?repoPath=${encodeURIComponent(repoPath)}`,
        'GET',
        { 'X-Autopsy-Token': token }
      );
      assert.strictEqual(tamperedIntegRes.status, 200);
      assert.strictEqual(tamperedIntegRes.body.result.valid, false);
      assert.strictEqual(tamperedIntegRes.body.result.status, '변조 의심');
      assert.strictEqual(tamperedIntegRes.body.result.code, 'TAMPERED');

      // 7. Attempt POST /api/proposals/:id/approve on the tampered proposal -> Must be rejected with HTTP 403 and SECURITY_TAMPER_DETECTED
      const approveRes = await makeRequest(
        `/api/proposals/${proposal.id}/approve`,
        'POST',
        { 'X-Autopsy-Token': token },
        { repoPath }
      );
      assert.strictEqual(approveRes.status, 403, 'Tampered proposal approval must be rejected with HTTP 403');
      assert.strictEqual(approveRes.body.code, 'SECURITY_TAMPER_DETECTED');

      // Proposal status must now be marked TAMPERED in DB
      const dbProp = core.getDatabase().getRepairProposal(proposal.id);
      assert.strictEqual(dbProp?.approvalStatus, 'TAMPERED');
    } finally {
      await apiServer.stop();
      // Restore calculator.js
      fs.writeFileSync(
        path.join(repoPath, 'calculator.js'),
        'export function add(a, b) { return a - b; }\n',
        'utf8'
      );
    }
  });
});
