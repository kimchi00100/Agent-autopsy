import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CoreManager } from '../src/core-manager.js';
import { AutopsyDatabase } from '../src/db/database.js';
import { GENESIS_PREV_HASH } from '../src/utils/security.js';

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
    assert.strictEqual(check.totalCount, 6, 'Exactly 6 audit events must be logged');

    // Verify all entries in detail
    const logs = core.getAuditLogs(10);
    assert.strictEqual(logs.length, 6);

    // Order is descending in getAuditLogs
    const ordered = [...logs].reverse(); // seq 1..6
    assert.strictEqual(ordered[0].seq, 1);
    assert.strictEqual(ordered[0].kind, 'TEST_COMMAND_CONFIRMED');
    assert.strictEqual(ordered[0].prevHash, GENESIS_PREV_HASH);

    assert.strictEqual(ordered[1].seq, 2);
    assert.strictEqual(ordered[1].kind, 'INCIDENT_REGISTERED');
    assert.strictEqual(ordered[1].prevHash, ordered[0].entryHash);

    assert.strictEqual(ordered[2].seq, 3);
    assert.strictEqual(ordered[2].kind, 'PROPOSAL_CREATED');
    assert.strictEqual(ordered[2].prevHash, ordered[1].entryHash);

    assert.strictEqual(ordered[3].seq, 4);
    assert.strictEqual(ordered[3].kind, 'PROPOSAL_APPROVED');
    assert.strictEqual(ordered[3].prevHash, ordered[2].entryHash);

    assert.strictEqual(ordered[4].seq, 5);
    assert.strictEqual(ordered[4].kind, 'REPAIR_APPLIED');
    assert.strictEqual(ordered[4].prevHash, ordered[3].entryHash);

    assert.strictEqual(ordered[5].seq, 6);
    assert.strictEqual(ordered[5].kind, 'ROLLBACK_EXECUTED');
    assert.strictEqual(ordered[5].prevHash, ordered[4].entryHash);
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
    assert.strictEqual(okCheck.totalCount, 2);

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

  test('5. Concurrent writes keep hash chain contiguous and valid without seq collision', async () => {
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
    assert.strictEqual(verifyResult.valid, true, 'Chain must be valid under concurrent writes');
    assert.strictEqual(verifyResult.status, 'OK');
    assert.strictEqual(verifyResult.totalCount, taskCount, `All ${taskCount} entries must be present`);

    const allLogs = sharedDb.getAuditLogs(taskCount + 5);
    assert.strictEqual(allLogs.length, taskCount);
    // Sequences must be strictly 1..taskCount
    const seqs = allLogs.map((l) => l.seq).sort((a, b) => a - b);
    for (let i = 0; i < taskCount; i++) {
      assert.strictEqual(seqs[i], i + 1, `Sequence must be contiguous at index ${i}`);
    }

    sharedDb.close();
  });

  test('6. Empty table or migration on existing DB returns OK with 0 entries', () => {
    const emptyDbPath = path.join(tmpBase, 'empty.db');
    const emptyDb = new AutopsyDatabase(emptyDbPath);

    const result = emptyDb.verifyAuditChain();
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.status, 'OK');
    assert.strictEqual(result.totalCount, 0);

    emptyDb.close();
  });
});
