import * as path from 'node:path';
import { CoreManager } from '../packages/core/dist/src/core-manager.js';

const core = new CoreManager();
const repoPath = process.cwd();
const project = core.ensureProject(repoPath);

console.log(`Setting up realistic incident simulation for project: ${project.name} (${project.id})...`);

// 1. Capture a clean baseline checkpoint
const cp = core.captureCheckpoint(repoPath, 'Checkpoint: Before Holiday Discount Refactor', 'antigravity');
console.log(`✔ Step 1: Baseline Checkpoint created: "${cp.label}" (${cp.id})`);

// 2. Insert a realistic forensic incident
const db = core.getDatabase();
const incidentId = `inc_sim_${Date.now().toString(36)}`;

const incident = {
  id: incidentId,
  projectId: project.id,
  baseCheckpointId: cp.id,
  title: "TypeError: Cannot read properties of undefined (reading 'rate') in DiscountCalculator",
  errorOutput: `TypeError: Cannot read properties of undefined (reading 'rate')
    at calculateFinalPrice (src/billing/discount.ts:42:28)
    at Context.<anonymous> (test/billing/discount.test.ts:18:14)
    at processImmediate (node:internal/timers:483:21)
AssertionError: Expected 8000 but received NaN when coupon is undefined`,
  diffSummary: `diff --git a/src/billing/discount.ts b/src/billing/discount.ts
--- a/src/billing/discount.ts
+++ b/src/billing/discount.ts
@@ -39,4 +39,4 @@
 export function calculateFinalPrice(price: number, coupon?: Coupon): number {
-  return price;
+  return price - (price * (coupon.rate / 100));
 }`,
  status: 'OPEN',
  createdAt: new Date().toISOString(),
};

db.insertIncident(incident);
console.log(`✔ Step 2: Forensic Incident logged: "${incident.title}" (${incident.id})`);

// 3. Insert a verified repair proposal (with VERIFIED_PASS in isolated worktree and Unified Diff)
const proposalId = `prop_sim_${Date.now().toString(36)}`;
const patchDiff = `Index: src/billing/discount.ts
===================================================================
--- a/src/billing/discount.ts	current
+++ b/src/billing/discount.ts	proposed
@@ -39,3 +39,3 @@
 export function calculateFinalPrice(price: number, coupon?: Coupon): number {
-  return price - (price * (coupon.rate / 100));
+  return coupon ? price - (price * (coupon.rate / 100)) : price;
 }
`;

const proposal = {
  id: proposalId,
  incidentId: incident.id,
  rootCauseAnalysis: `calculateFinalPrice 함수가 선택적 매개변수인 coupon 객체가 항상 전달된다고 잘못 가정하고 작성되었습니다. 사용자가 쿠폰을 적용하지 않고 결제를 진행하면 coupon 매개변수가 undefined 상태가 되어, coupon.rate 프로퍼티 접근 시 런타임 TypeError가 발생하고 최종 금액이 NaN으로 계산되는 치명적 결함이 발생했습니다.

[해결 조치]: 쿠폰 유무를 먼저 검사하는 방어 코드(coupon ? ... : price)를 적용하여, 쿠폰이 없는 일반 결제 시 원래 기본 가격이 안전하게 유지되도록 예외 처리를 추가했습니다.`,
  patchDiff,
  touchedFiles: ['src/billing/discount.ts'],
  fileChangesJson: JSON.stringify([
    {
      filePath: 'src/billing/discount.ts',
      replacements: [
        {
          search: 'return price - (price * (coupon.rate / 100));',
          replace: 'return coupon ? price - (price * (coupon.rate / 100)) : price;',
        },
      ],
    },
  ]),
  verificationStatus: 'VERIFIED_PASS',
  verificationLog: `[Agent Autopsy Worktree Sandbox: ${proposalId}]
Running test command in isolated environment: npm test -- discount.test.ts
✓ calculateFinalPrice applies valid percentage coupon discount (8ms)
✓ calculateFinalPrice handles undefined coupon without throwing (2ms)
✓ calculateFinalPrice clamps negative discounts to zero (3ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Duration:    0.412s
Result:      VERIFIED_PASS (Tests passed cleanly in isolated worktree)`,
  approvalStatus: 'AWAITING_USER',
  approvedAt: null,
  appliedAt: null,
  createdAt: new Date().toISOString(),
};

db.insertRepairProposal(proposal);
console.log(`✔ Step 3: Repair Proposal registered: ${proposal.id} (Status: AWAITING_USER, Verification: VERIFIED_PASS)`);
console.log('\nSimulation complete! Check your browser dashboard at http://localhost:3847');

await core.shutdown();
