import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { CoreContext } from './context.js';
import { sendWindowsToast } from '../notifications/toast.js';
import {
  signApprovalPayload,
  verifyApprovalSignature,
  hashFileChanges,
  verifyTestCommandSignature,
  getInstallationSecretKey,
  computeProposalRowSignature,
  verifyProposalRowSignature,
  hashAuditPayload,
} from '../utils/security.js';
import {
  ApprovalReadiness,
  Project,
  Incident,
  ThreeStageExecutionResult,
  FileChange,
  ApprovalFingerprint,
  RepairProposal,
} from '../types.js';

  export async function proposeAndVerifyRepair(ctx: CoreContext, 
    repoPath: string,
    incidentId: string,
    rootCauseAnalysis: string,
    fileChanges: FileChange[]
  ): Promise<{ proposal: RepairProposal; executionResult: ThreeStageExecutionResult }> {
    const project = ctx.ensureProject(repoPath);
    const incident = ctx.db.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident with ID "${incidentId}" not found.`);
    }

    // 1. Prepare patch in memory
    const prepared = ctx.patchEngine.preparePatch(project.rootPath, fileChanges);
    const proposalId = `prop_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    // 2. Base commit to checkout in sandbox (use checkpoint worktree commit if available)
    let baseCommitSha = 'HEAD';
    if (incident.baseCheckpointId) {
      const baseCp = ctx.db.getCheckpoint(incident.baseCheckpointId);
      if (baseCp?.worktreeCommitSha) {
        baseCommitSha = baseCp.worktreeCommitSha;
      }
    }

    // 3. Create isolated worktree with dependency safety check
    const testCmd = project.testCommand || ctx.detectTestCommand(project.rootPath);

    // 0-D Check: Verify cryptographic signature of project testCommand against tampering and unconfirmed commands
    if (!project.testCommandSignature) {
      const err: any = new Error(
        `[BLOCKED_TEST_COMMAND_UNCONFIRMED] [TEST_COMMAND_UNCONFIRMED]: 테스트 명령("${testCmd || '미정'}")이 사용자에 의해 확정(서명)되지 않았습니다. 앱 대시보드에서 테스트 명령을 먼저 확정해 주세요.`
      );
      err.code = 'BLOCKED_TEST_COMMAND_UNCONFIRMED';
      err.next_action = {
        actor: 'USER',
        action: 'CONFIRM_TEST_COMMAND_IN_APP',
        agent_should: '사용자에게 앱 대시보드(프로젝트 설정)에서 테스트 명령을 확인(확정)해 달라고 요청하거나 propose_test_command 도구로 적절한 명령을 제안하세요.',
        forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '검증 생략'],
      };
      throw err;
    }
    const isCmdValid = verifyTestCommandSignature(
      project.id,
      project.testCommand || testCmd,
      project.testCommandSignature
    );
    if (!isCmdValid) {
      ctx.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `[보안 경고] 테스트 명령 변조 감지`,
        `프로젝트 "${project.name}"의 테스트 명령("${project.testCommand}")이 승인된 전자서명과 일치하지 않습니다. 검증 실행을 즉시 차단합니다.`,
        null,
        'security-gate'
      );
      ctx.emitChange('tamper_detected', {
        projectId: project.id,
        reason: `테스트 명령 위변조 감지: "${project.testCommand}"`,
      });
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 프로젝트의 테스트 명령("${project.testCommand}")이 위변조되었습니다. 승인 서명 검증에 실패하여 격리 검증 실행이 거부되었습니다.`
      );
    }
    const { sandboxDir } = ctx.worktreeRunner.createWorktree(
      project.rootPath,
      proposalId,
      baseCommitSha,
      prepared.touchedFiles,
      testCmd
    );

    let executionResult: ThreeStageExecutionResult;
    try {
      // 4. Write patch into the isolated worktree
      ctx.patchEngine.writePatchToDisk(sandboxDir, prepared.appliedFiles);

      // 5. Run 3-stage validation in isolated worktree
      executionResult = await ctx.worktreeRunner.runThreeStageValidation({
        worktreePath: sandboxDir,
        repoPath: project.rootPath,
        touchedFiles: prepared.touchedFiles,
        fullTestCommand: testCmd,
      });
    } finally {
      // 6. Always clean up isolated worktree
      ctx.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
    }

    // 7. Record proposal with verification status & Risk-Adaptive Evidence Gate
    const verificationStatus = executionResult.success ? 'VERIFIED_PASS' : 'VERIFIED_FAIL';
    const patchHash = crypto.createHash('sha256').update(prepared.unifiedDiff).digest('hex');

    // Previous retry count on this incident
    const previousProposals = ctx.db.listProposalsForIncident(incidentId);
    const retryCount = previousProposals.length;

    // Evaluate risk and orchestration decision on the proposed patch
    const decision = ctx.evaluateOrchestrationDecision(
      project,
      incident.title,
      incident.errorOutput,
      prepared.unifiedDiff,
      prepared.touchedFiles,
      incident.causeVerdict,
      incident.threeLevelHealth,
      retryCount
    );

    // Initial Approval Readiness (Decoupled: isolated test runs immediately, gate evaluated at approval level)
    let approvalReadiness: ApprovalReadiness = 'READY_FOR_APPROVAL';
    let approvalBlockReason: string | null = null;

    if (verificationStatus === 'VERIFIED_FAIL') {
      approvalReadiness = 'BLOCKED_TEST_FAILED';
      approvalBlockReason = '격리 워크트리 3단계 검증 실패: 실행 리포트를 분석하고 수정안을 다시 제출하세요.';
    } else {
      // Test passed! Now apply Risk-Adaptive Evidence Gate at approval readiness level
      if (decision.reviewRequirement === 'MANDATORY_BEFORE_APPROVAL') {
        approvalReadiness = 'BLOCKED_AWAITING_REVIEW';
        approvalBlockReason = `[고위험 변경]: ${decision.riskSignals.join(', ')} 등의 이유로 호스트 내장 서브에이전트의 독립 교차 검토가 필수입니다. submit_orchestration_review 도구로 검토 증거를 제출해야 정규 승인이 가능합니다.`;
      } else if (decision.verificationMode === 'MAIN_ONLY' && decision.riskLevel !== 'LOW') {
        approvalReadiness = 'APPROVABLE_WITH_RISK_WARNING';
        approvalBlockReason = `[메인 AI 전용 모드]: ${decision.riskLevel} 위험도 독립 검토가 생략되었습니다. 승인 전 자체 점검표를 확인하세요.`;
      } else {
        approvalReadiness = 'READY_FOR_APPROVAL';
        approvalBlockReason = null;
      }
    }

    if (verificationStatus === 'VERIFIED_PASS') {
      sendWindowsToast(
        '🔬 Agent Autopsy: 3단계 격리 검증 통과',
        `사고 "${incident.title}" 수정안이 3단계 격리 검증을 통과했습니다. 대시보드(http://localhost:3847)에서 승인해 주세요.`
      );
    }

    const createdAt = new Date().toISOString();
    const fileChangesJson = JSON.stringify(fileChanges);
    const secretKey = getInstallationSecretKey();
    const rowSignature = computeProposalRowSignature(secretKey, {
      id: proposalId,
      incident_id: incidentId,
      project_id: project.id,
      file_changes_json: fileChangesJson,
      verification_status: verificationStatus,
      created_at: createdAt,
    });

    const proposal: RepairProposal = {
      id: proposalId,
      incidentId,
      rootCauseAnalysis,
      patchDiff: prepared.unifiedDiff,
      patchHash,
      riskLevel: decision.riskLevel,
      riskEvidence: decision.riskSignals,
      selfReviewChecklist: decision.selfReviewChecklist,
      touchedFiles: prepared.touchedFiles,
      fileChangesJson,
      verificationStatus,
      verificationLog: executionResult.output,
      approvalStatus: 'AWAITING_USER',
      approvalReadiness,
      approvalBlockReason: approvalBlockReason || undefined,
      stages: executionResult.stages,
      threeLevelHealth: executionResult.threeLevelHealth,
      verifiedWithCommand: testCmd,
      approvalFingerprintJson: null,
      approvedAt: null,
      appliedAt: null,
      rowSignature,
      createdAt,
    };

    ctx.db.insertRepairProposal(proposal);
    ctx.emitChange('proposal_created', proposal);
    return { proposal, executionResult };
  }


  export function approveProposal(ctx: CoreContext, 
    proposalId: string,
    selectedFiles?: string[],
    forceOverrideWithRiskAck: boolean = false,
    repoPath?: string
  ): ApprovalFingerprint {
    const proposal = ctx.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    const incident = ctx.db.getIncident(proposal.incidentId);
    if (!incident) throw new Error(`Incident not found.`);
    const project = ctx.db.getProject(incident.projectId);
    if (!project) throw new Error(`Project not found.`);

    // HARD GATE 0: Project Affiliation Check (if repoPath provided)
    if (repoPath) {
      const callingProject = ctx.ensureProject(repoPath);
      if (callingProject.id !== project.id) {
        ctx.db.appendAuditLog({
          kind: 'PROJECT_MISMATCH_BLOCKED',
          entityType: 'PROPOSAL',
          entityId: proposalId,
          payloadHash: hashAuditPayload({
            proposalId,
            callingProjectId: callingProject.id,
            expectedProjectId: project.id,
            repoPath,
          }),
        });
        const err: any = new Error(
          `[PROJECT_MISMATCH]: 수정안 "${proposalId}"의 소속 프로젝트("${project.id}")와 승인 대상 저장소("${callingProject.id}", ${repoPath})가 일치하지 않습니다.`
        );
        err.code = 'PROJECT_MISMATCH';
        throw err;
      }
    }

    // HARD GATE: Tampered proposal can never be approved
    if (proposal.approvalStatus === 'TAMPERED') {
      const err: any = new Error(`[SECURITY_TAMPER_DETECTED]: 변조가 감지된 수정안은 승인할 수 없습니다.`);
      err.code = 'SECURITY_TAMPER_DETECTED';
      throw err;
    }

    // HARD GATE: Legacy unsigned proposals cannot be approved
    if (!proposal.rowSignature || proposal.rowSignature.trim() === '') {
      const err: any = new Error(
        `[LEGACY_UNSIGNED]: 서명 없는 기존 수정안은 승인할 수 없습니다. 다시 제안을 생성하세요.`
      );
      err.code = 'LEGACY_UNSIGNED';
      throw err;
    }

    // HARD GATE: Row HMAC signature verification (detects DB modification of code, status, or cross-DB copy)
    const secretKey = getInstallationSecretKey();
    const isRowSigValid = verifyProposalRowSignature(
      secretKey,
      {
        id: proposal.id,
        incident_id: proposal.incidentId,
        project_id: project.id,
        file_changes_json: proposal.fileChangesJson,
        verification_status: proposal.verificationStatus,
        created_at: proposal.createdAt,
      },
      proposal.rowSignature
    );

    if (!isRowSigValid) {
      ctx.recordTamperIncident(
        project.rootPath,
        proposalId,
        '수정안 행 전자서명(row_signature) 불일치 감지. SQLite 직접 수정(file_changes_json 또는 verification_status 변조) 또는 다른 DB에서 복사된 행입니다.'
      );
      const err: any = new Error(
        `[SECURITY_TAMPER_DETECTED]: 수정안 행 전자서명 검증 실패. 데이터베이스 직접 변조 또는 유효하지 않은 서명이 감지되어 승인이 차단되고 보안 사건이 기록되었습니다.`
      );
      err.code = 'SECURITY_TAMPER_DETECTED';
      throw err;
    }

    // Risk-Adaptive Gate Check: Block unreviewed high risk proposals unless explicitly force-approved with acknowledgment
    if (proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && !forceOverrideWithRiskAck) {
      throw new Error(
        `[RISK_GATE_VIOLATION]: ${proposal.approvalBlockReason || '고위험 변경으로 독립 검토가 필수입니다.'} ` +
        `검토 없이 강제 승인하려면 대시보드에서 위험 감수 승인(forceOverride)을 확인하세요.`
      );
    }
    if (proposal.approvalReadiness === 'BLOCKED_TEST_FAILED') {
      throw new Error(`[TEST_GATE_VIOLATION]: 격리 워크트리 테스트가 실패한 수정안은 승인할 수 없습니다.`);
    }

    // Pin cryptographic hashes of target files right now
    const targetFileHashes: Record<string, string> = {};
    const approvedFiles = selectedFiles && selectedFiles.length > 0 ? selectedFiles : proposal.touchedFiles;

    for (const f of approvedFiles) {
      const absPath = path.resolve(project.rootPath, f);
      targetFileHashes[f] = ctx.gitEngine.getFileSha256(absPath);
    }

    // 0-C: Hash the exact fileChanges to be applied (filtered by approvedFiles)
    let effectiveChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
    if (selectedFiles && selectedFiles.length > 0) {
      const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
      effectiveChanges = effectiveChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
    }
    const patchHash = hashFileChanges(effectiveChanges);
    const baseHeadSha = ctx.gitEngine.getHeadSha(project.rootPath);
    const signature = signApprovalPayload(proposalId, patchHash, baseHeadSha);

    const fingerprint: ApprovalFingerprint = {
      patchHash,
      baseHeadSha,
      baseCheckpointId: incident.baseCheckpointId,
      targetFileHashes,
      approvedFiles,
      createdAt: new Date().toISOString(),
      signature,
    };

    ctx.db.updateProposalApproval(proposalId, 'APPROVED', fingerprint);
    ctx.emitChange('proposal_approved', { proposalId, fingerprint });
    return fingerprint;
  }

  export function rejectProposal(ctx: CoreContext, proposalId: string, reason?: string): void {
    const proposal = ctx.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    ctx.db.updateProposalApproval(proposalId, 'REJECTED', reason);
    ctx.emitChange('proposal_rejected', { proposalId });
  }

  /**
   * Records a security tampering event, marks proposal as TAMPERED, and emits notifications.
   */
  export function recordTamperIncident(ctx: CoreContext, repoPath: string, proposalId: string, reason: string): void {
    const project = ctx.ensureProject(repoPath);
    ctx.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `[보안 경고] 승인 게이트 변조 감지`,
      `수정안 ID: ${proposalId}\n사유: ${reason}\n무단 승인 조작 또는 서명 위조가 감지되어 상태를 TAMPERED로 변경하고 적용을 즉시 차단했습니다.`,
      null,
      'security-gate'
    );
    try {
      ctx.db.updateProposalApproval(proposalId, 'TAMPERED');
    } catch {}
    ctx.emitChange('tamper_detected', { proposalId, reason, projectId: project.id });
    try {
      sendWindowsToast('Agent Autopsy 보안 경고', `[변조 감지] 수정안 ${proposalId} 적용이 보안 정책에 의해 차단되었습니다.`);
    } catch {}
  }

  /**
   * 5. apply_approved_repair:
   * [HARD SECURITY GATE]: Re-verifies approval fingerprint, cryptographic signature & pre-image file hashes to block TOCTOU and tampering attacks.
   */
  export function applyApprovedRepair(ctx: CoreContext, 
    repoPath: string,
    proposalId: string,
    selectedFiles?: string[]
  ): { applied: boolean; touchedFiles: string[]; diff: string } {
    const project = ctx.ensureProject(repoPath);
    const proposal = ctx.db.getRepairProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal with ID "${proposalId}" not found.`);
    }
    const incident = ctx.db.getIncident(proposal.incidentId);
    if (!incident) {
      throw new Error(`Incident with ID "${proposal.incidentId}" not found.`);
    }

    // HARD SECURITY GATE 0: Project Affiliation Check (blocks applying Project A's patch to Project B)
    if (incident.projectId !== project.id) {
      ctx.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `[보안 경고] 프로젝트 불일치(PROJECT_MISMATCH) 감지`,
        `수정안 "${proposalId}"(소속: ${incident.projectId})을 다른 프로젝트 "${project.id}"(${repoPath})에 적용하려는 시도가 차단되었습니다.`,
        null,
        'security-gate'
      );
      ctx.db.appendAuditLog({
        kind: 'PROJECT_MISMATCH_BLOCKED',
        entityType: 'PROPOSAL',
        entityId: proposalId,
        payloadHash: hashAuditPayload({
          proposalId,
          targetProjectId: project.id,
          expectedProjectId: incident.projectId,
          targetRepoPath: repoPath,
        }),
      });
      const err: any = new Error(
        `[PROJECT_MISMATCH]: 수정안 "${proposalId}"의 소속 프로젝트("${incident.projectId}")와 적용 대상 저장소("${project.id}", ${repoPath})가 일치하지 않습니다. 타 프로젝트 수정안 무단 적용이 차단되었습니다.`
      );
      err.code = 'PROJECT_MISMATCH';
      throw err;
    }

    // HARD SECURITY GATE 1: Status must be APPROVED
    if (proposal.approvalStatus !== 'APPROVED') {
      throw new Error(
        `[SECURITY GATE VIOLATION]: Repair proposal "${proposalId}" cannot be applied because its status is "${proposal.approvalStatus}". It must be explicitly approved by the user in Agent Autopsy first.`
      );
    }

    // HARD SECURITY GATE 1.5: Proposal row HMAC signature check
    if (proposal.rowSignature) {
      const secretKey = getInstallationSecretKey();
      const isRowSigValid = verifyProposalRowSignature(
        secretKey,
        {
          id: proposal.id,
          incident_id: proposal.incidentId,
          project_id: incident.projectId,
          file_changes_json: proposal.fileChangesJson,
          verification_status: proposal.verificationStatus,
          created_at: proposal.createdAt,
        },
        proposal.rowSignature
      );
      if (!isRowSigValid) {
        ctx.recordTamperIncident(
          project.rootPath,
          proposalId,
          '수정안 행 전자서명(row_signature) 불일치 감지 (적용 단계)'
        );
        throw new Error(
          `[SECURITY_TAMPER_DETECTED]: 수정안 행 전자서명 검증 실패. 적용이 거부되었습니다.`
        );
      }
    }

    // HARD SECURITY GATE 2: Cryptographic fingerprint presence and signature check (Bypass / Tamper Defense)
    if (!proposal.approvalFingerprintJson) {
      ctx.recordTamperIncident(
        project.rootPath,
        proposalId,
        '승인 지문(Approval Fingerprint)이 누락되었습니다. 데이터베이스를 직접 수정하여 승인 상태를 우회 조작한 정황이 감지되었습니다.'
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 지문(Fingerprint)이 누락된 비정상적인 승인 상태입니다. 데이터베이스 직접 변조가 감지되어 적용이 차단되고 보안 사건이 기록되었습니다.`
      );
    }

    const fp: ApprovalFingerprint = JSON.parse(proposal.approvalFingerprintJson);

    // Verify HMAC signature of approval
    const isValidSignature = verifyApprovalSignature(proposalId, fp.patchHash, fp.baseHeadSha, fp.signature);
    if (!isValidSignature) {
      ctx.recordTamperIncident(
        project.rootPath,
        proposalId,
        '승인 지문의 전자서명이 유효하지 않습니다. 승인 데이터 위조가 감지되었습니다.'
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 지문 전자서명 검증 실패. 승인 위조 시도가 감지되어 적용이 거부되었습니다.`
      );
    }

    // 0-C Check: Compute hash of actual fileChanges to be applied right now
    let fileChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
    if (selectedFiles && selectedFiles.length > 0) {
      const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
      fileChanges = fileChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
      if (fileChanges.length === 0) {
        throw new Error('선택한 파일이 수정안에 포함되어 있지 않습니다.');
      }
    }

    const currentFileChangesHash = hashFileChanges(fileChanges);
    if (currentFileChangesHash !== fp.patchHash) {
      ctx.recordTamperIncident(
        project.rootPath,
        proposalId,
        `승인된 수정 내용(해시: ${fp.patchHash.slice(0, 8)})과 현재 적용 대상 내용(해시: ${currentFileChangesHash.slice(0, 8)})이 일치하지 않습니다 (fileChangesJson 사후 변조).`
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 이후 패치 코드 변조(Patch Drift)가 감지되었습니다. 승인 당시와 다른 코드가 적용되는 것을 차단했습니다.`
      );
    }

    // Verify current HEAD has not moved
    const currentHead = ctx.gitEngine.getHeadSha(project.rootPath);
    if (fp.baseHeadSha && currentHead !== fp.baseHeadSha) {
      throw new Error(
        `[STALE_APPROVAL_ERROR]: 저장소의 Git HEAD 커밋이 승인 시점(${fp.baseHeadSha.slice(0, 7)})과 달라졌습니다 (${currentHead.slice(0, 7)}). 코드 오염을 방지하기 위해 적용이 중단되었습니다. 재검토해 주세요.`
      );
    }

    // Verify none of the target files on disk have changed since approval
    for (const [relPath, approvedHash] of Object.entries(fp.targetFileHashes)) {
      const abs = path.resolve(project.rootPath, relPath);
      const currentHash = ctx.gitEngine.getFileSha256(abs);
      if (currentHash !== approvedHash) {
        throw new Error(
          `[STALE_APPROVAL_ERROR]: 대상 파일 "${relPath}" 이(가) 사용자 승인 이후 외부에서 수정되었습니다. 코드 충돌을 방지하기 위해 적용이 차단되었습니다. 수정안을 다시 검토해 주세요.`
        );
      }
    }

    // 1. Take safety checkpoint before applying
    ctx.captureCheckpoint(project.rootPath, `Before Applying Repair ${proposalId}`, 'core-gate');

    ctx.isApplyingApprovedPatch = true;
    try {
      // 2. Prepare and write patch to real workspace
      let fileChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
      if (selectedFiles && selectedFiles.length > 0) {
        const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
        fileChanges = fileChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
        if (fileChanges.length === 0) {
          throw new Error('선택한 파일이 수정안에 포함되어 있지 않습니다.');
        }
      }
      const prepared = ctx.patchEngine.preparePatch(project.rootPath, fileChanges);
      ctx.patchEngine.writePatchToDisk(project.rootPath, prepared.appliedFiles);

      // 3. Update DB proposal status to APPLIED
      ctx.db.updateProposalApproval(proposalId, 'APPLIED');

      // 4. Mark incident as RESOLVED
      ctx.db.updateIncidentStatus(proposal.incidentId, 'RESOLVED');

      // 5. Take post-patch checkpoint
      ctx.captureCheckpoint(project.rootPath, `After Applying Repair: ${proposal.rootCauseAnalysis}`, 'core-gate');

      ctx.emitChange('proposal_applied', { proposalId, incidentId: proposal.incidentId });

      return {
        applied: true,
        touchedFiles: prepared.touchedFiles,
        diff: prepared.unifiedDiff,
      };
    } finally {
      ctx.isApplyingApprovedPatch = false;
    }
  }
