import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { CoreContext } from './context.js';
import { getInstallationSecretKey } from '../utils/security.js';
import {
  Project,
  CauseVerdict,
  ThreeLevelHealth,
  OrchestrationDecision,
  VerificationMode,
  HostEnvironment,
  RiskLevel,
  ReviewChallenge,
  RepairProposal,
  OrchestrationReview,
  OrchestrationReviewStatus,
  ApprovalReadiness,
} from '../types.js';

export function matchesGlobPath(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

  if (normPattern === '*' || normPattern === '**' || normPattern === '**/*') return true;

  const regexStr = normPattern
    .replace(/[.+^$${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(normPath) || regex.test(path.basename(normPath));
}

export function countDiffLines(unifiedDiff: string): { addedLines: number; removedLines: number; totalChangedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  if (!unifiedDiff) return { addedLines: 0, removedLines: 0, totalChangedLines: 0 };
  const lines = unifiedDiff.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines++;
    else if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines, totalChangedLines: addedLines + removedLines };
}

function firstMeaningfulLine(text: string): string {
  const line = (text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? '').slice(0, 140);
}

  export function evaluateOrchestrationDecision(ctx: CoreContext, 
    project: Project,
    title: string,
    errorOutput: string,
    diffSummary: string,
    changedFiles: string[],
    causeVerdict?: CauseVerdict,
    threeLevelHealth?: ThreeLevelHealth,
    retryCount: number = 0
  ): OrchestrationDecision {
    const riskSignals: string[] = [];
    const mode: VerificationMode = project.verificationMode || 'AUTO';
    const host: HostEnvironment = project.preferredHost || 'antigravity';

    // 1. 민감 경로: 사용자가 프로젝트마다 직접 지정 (project.sensitivePaths)
    // 기존 키워드 정규식(auth|token|payment...) 완전 제거
    const sensitivePatterns = project.sensitivePaths || [];
    const matchedSensitiveFiles = changedFiles.filter((file) =>
      sensitivePatterns.some((pattern) => matchesGlobPath(file, pattern))
    );
    const touchesSensitivePath = matchedSensitiveFiles.length > 0;

    // 2. 바뀐 줄 수 계산 (diffSummary에서 추가/삭제 줄 수 합산)
    const { totalChangedLines } = countDiffLines(diffSummary);
    const thresholdLines = typeof project.riskThresholdLines === 'number' ? project.riskThresholdLines : 200;
    const halfThresholdLines = Math.floor(thresholdLines / 2); // 기본 100줄

    // 3. 위험도 등급 판정:
    // - 높음: 민감 경로를 건드림, 바뀐 줄 수가 기준 이상(기본 200줄), 같은 사건에서 격리 검증 2회 이상 실패
    // - 중간: 바뀐 줄 수가 높음 기준의 절반 이상(기본 100줄), 또는 같은 사건에서 격리 검증 1회 실패
    // - 낮음: 위 조건에 해당하지 않음
    let riskLevel: RiskLevel = 'LOW';

    if (touchesSensitivePath) {
      riskSignals.push(`사용자 지정 민감 경로 수정 감지 (${matchedSensitiveFiles.join(', ')})`);
    }
    if (totalChangedLines >= thresholdLines) {
      riskSignals.push(`대규모 코드 변경 (${totalChangedLines}줄 >= 설정 기준 ${thresholdLines}줄)`);
    }
    if (retryCount >= 2) {
      riskSignals.push(`동일 사건 격리 검증 ${retryCount}회 실패 이력 감지`);
    }

    if (touchesSensitivePath || totalChangedLines >= thresholdLines || retryCount >= 2) {
      riskLevel = 'HIGH';
    } else if (totalChangedLines >= halfThresholdLines || retryCount === 1) {
      riskLevel = 'MEDIUM';
      if (totalChangedLines >= halfThresholdLines) {
        riskSignals.push(`중규모 코드 변경 (${totalChangedLines}줄 >= 기준 ${halfThresholdLines}줄)`);
      }
      if (retryCount === 1) {
        riskSignals.push('동일 사건 이전 격리 검증 실패 1회 감지');
      }
    } else {
      riskLevel = 'LOW';
      riskSignals.push(`민감 경로 미포함, 소규모 변경 (${totalChangedLines}줄 < ${halfThresholdLines}줄), 격리 검증 실패 이력 없음`);
    }

    // 4. 모드별 서브에이전트 검토 조건:
    // - 자동 판단 모드(기본): 수정 위험도가 높음(HIGH)일 때만 서브에이전트 검토 필수
    // - 심층 검증 우선 모드: 수정 위험도가 중간(MEDIUM) 이상이면 서브에이전트 검토 필수
    // - 메인 AI 전용 모드: 서브에이전트를 부르지 않는다. 위험도가 중간 이상이면 자체 점검표 작성.
    let directive: OrchestrationDecision['directive'] = 'DIRECT_SOLVE';
    let reviewRequirement: OrchestrationDecision['reviewRequirement'] = 'NONE';
    const skippedWarnings: string[] = [];
    let selfReviewChecklist: string[] | undefined;

    if (mode === 'MAIN_ONLY') {
      directive = 'SKIPPED_MAIN_ONLY';
      reviewRequirement = 'NONE';
      if (riskLevel !== 'LOW') {
        skippedWarnings.push(
          `[메인 AI 전용 모드]: ${riskLevel} 위험도 작업이지만 사용자 설정에 의해 서브에이전트 독립 검토가 생략되었습니다.`
        );
        selfReviewChecklist = [
          `민감 경로 점검: ${touchesSensitivePath ? '사용자 지정 민감 경로 포함 (' + matchedSensitiveFiles.join(', ') + ')' : '민감 경로 미포함'}`,
          `기존 동작 변경 부위: ${changedFiles.join(', ')} 파일의 인터페이스 및 사이드이펙트 영향 점검`,
          `테스트 미커버 영역: 격리 검증 스위트 외 엣지케이스 및 추가 수동 점검 필요 사항`,
        ];
      }
    } else if (mode === 'DEEP_PRIORITY') {
      if (riskLevel === 'LOW') {
        directive = 'DIRECT_SOLVE';
        reviewRequirement = 'CONDITIONAL';
      } else {
        directive = 'INVOKE_NATIVE_ORCHESTRATION';
        reviewRequirement = 'MANDATORY_BEFORE_APPROVAL';
      }
    } else {
      // AUTO mode: ONLY HIGH triggers mandatory subagent review
      if (riskLevel === 'HIGH') {
        directive = 'INVOKE_NATIVE_ORCHESTRATION';
        reviewRequirement = 'MANDATORY_BEFORE_APPROVAL';
      } else {
        directive = 'DIRECT_SOLVE';
        reviewRequirement = 'NONE';
      }
    }

    // Host delegation guide using the same selected model
    let hostDelegationGuide = '';
    if (host === 'antigravity') {
      hostDelegationGuide = `Antigravity 내장 subagent를 호출하세요: invoke_subagent(TypeName='self', Role='Independent Reviewer', Model='inherit', Prompt='...'). 검토 완료 후 submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else if (host === 'claude-code') {
      hostDelegationGuide = `Claude Code 내장 Task 서브에이전트를 호출하여 동일 모델(Opus)로 독립 교차 검토를 수행하고, submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else if (host === 'codex') {
      hostDelegationGuide = `Codex 내장 에이전트 위임 기능을 사용하여 동일 모델로 독립 검토를 수행하고, submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else {
      hostDelegationGuide = `현재 실행 환경의 내장 서브에이전트를 호출하여 교차 검증을 수행하고, submit_orchestration_review 도구를 호출하세요.`;
    }

    const requiresOrchestration = directive === 'INVOKE_NATIVE_ORCHESTRATION';
    const reason = requiresOrchestration
      ? '사용자 지정 민감 경로 수정 또는 대규모 변경(설정 기준 초과)으로 독립 서브에이전트 검증이 필요합니다.'
      : directive === 'SKIPPED_MAIN_ONLY'
      ? '메인 AI 전용 모드로 설정되어 추가 AI 오케스트레이션이 생략되었습니다.'
      : '단순 저위험 작업(민감 경로 미포함 및 소규모 변경)으로 메인 AI 단독 처리가 가능합니다.';

    return {
      requiresOrchestration,
      reason,
      riskLevel,
      riskSignals,
      verificationMode: mode,
      hostEnvironment: host,
      directive,
      reviewRequirement,
      hostDelegationGuide,
      skippedVerificationWarnings: skippedWarnings,
      selfReviewChecklist,
    };
  }

  /**
   * 4. propose_and_verify_repair:
   * Validates patch, generates diff, executes tests in an isolated worktree replicating uncommitted baseline state.
   */

  export function createReviewChallenge(ctx: CoreContext, 
    repoPath: string,
    proposalId: string
  ): ReviewChallenge {
    const project = ctx.ensureProject(repoPath);
    const proposal = ctx.db.getRepairProposal(proposalId);
    if (!proposal) {
      throw new Error(`RepairProposal with ID "${proposalId}" not found.`);
    }
    const patchHash = crypto.createHash('sha256').update(proposal.patchDiff).digest('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const secretKey = getInstallationSecretKey();
    const challengeToken = crypto
      .createHmac('sha256', secretKey)
      .update(`${proposal.id}:${patchHash}:${nonce}`)
      .digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return { challengeToken, proposalId, patchHash, expiresAt };
  }

  /**
   * Submits an independent orchestration review from a native subagent or main AI proxy.
   * Checks host execution trace to honestly differentiate COMPLETED_VERIFIED vs COMPLETED_UNVERIFIED.
   */
  export function submitOrchestrationReview(ctx: CoreContext, 
    repoPath: string,
    params: {
      proposalId: string;
      reviewer: string;
      findings: string[];
      counterEvidence?: string[];
      limitations?: string[];
      subagentTaskId?: string;
      transcriptPath?: string;
      challengeToken?: string;
      submittedByRole?: 'SUBAGENT_DIRECT' | 'MAIN_AGENT_PROXY';
    }
  ): { review: OrchestrationReview; proposal: RepairProposal } {
    const project = ctx.ensureProject(repoPath);
    const proposal = ctx.db.getRepairProposal(params.proposalId);
    if (!proposal) {
      throw new Error(`RepairProposal with ID "${params.proposalId}" not found.`);
    }

    const currentPatchHash = crypto.createHash('sha256').update(proposal.patchDiff).digest('hex');

    // 1. Stale Review Check: Ensure review targets the EXACT current patch
    if (proposal.patchHash && proposal.patchHash !== currentPatchHash) {
      throw new Error(
        `[STALE_REVIEW_REJECTED]: 수정안 코드가 변경되어 기존 검토가 무효화되었습니다 (PatchHash 불일치). 재검토를 요청하세요.`
      );
    }

    // 2. Host Subagent Physical Execution Verification
    let hostTranscriptVerified = false;
    let verificationNotes = '';

    let candidateLogPath: string | null = null;
    if (params.transcriptPath && fs.existsSync(params.transcriptPath)) {
      candidateLogPath = params.transcriptPath;
    } else if (params.subagentTaskId) {
      const candidates = [
        path.resolve(process.env.APPDATA || '.', '.agent-autopsy', 'tasks', `${params.subagentTaskId}.log`),
        path.resolve(process.env.HOME || '.', '.codex', 'logs', `${params.subagentTaskId}.log`),
        path.resolve(process.env.HOME || '.', '.claude', 'sessions', `${params.subagentTaskId}.jsonl`),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          candidateLogPath = cand;
          break;
        }
      }
    }

    if (candidateLogPath && fs.existsSync(candidateLogPath)) {
      try {
        const stat = fs.statSync(candidateLogPath);
        const proposalTime = new Date(proposal.createdAt).getTime();
        // File must be non-empty and modified around or after proposal creation
        const isFresh = stat.size > 0 && stat.mtimeMs >= proposalTime - 15000;
        if (isFresh) {
          const content = fs.readFileSync(candidateLogPath, 'utf8');
          // Must contain subagent invocation, review, or proposal ID
          const hasEvidence =
            content.includes(proposal.id) ||
            content.includes(currentPatchHash.slice(0, 10)) ||
            content.includes('invoke_subagent') ||
            content.includes('subagent') ||
            content.includes('Reviewer') ||
            (params.challengeToken ? content.includes(params.challengeToken) : false);

          if (hasEvidence) {
            hostTranscriptVerified = true;
            verificationNotes = `호스트 실행 증거 파일 확인 완료 (${path.basename(candidateLogPath)})`;
          } else {
            verificationNotes = `로그 파일은 존재하나 서브에이전트 검토 실행 증거가 누락되었습니다.`;
          }
        } else {
          verificationNotes = `로그 파일이 수정안 생성 이전 시점이거나 빈 파일입니다.`;
        }
      } catch (err: any) {
        verificationNotes = `호스트 로그 검증 중 오류: ${err.message}`;
      }
    } else {
      verificationNotes = `호스트 서브에이전트 물리적 실행 로그 파일을 찾을 수 없습니다.`;
    }

    const status: OrchestrationReviewStatus = hostTranscriptVerified
      ? 'COMPLETED_VERIFIED'
      : 'COMPLETED_UNVERIFIED';

    const review: OrchestrationReview = {
      reviewId: `rev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      proposalId: proposal.id,
      incidentId: proposal.incidentId,
      status,
      reviewer: params.reviewer || 'subagent',
      submittedByRole: params.submittedByRole || (hostTranscriptVerified ? 'SUBAGENT_DIRECT' : 'MAIN_AGENT_PROXY'),
      hostTranscriptVerified,
      subagentTaskId: params.subagentTaskId,
      challengeToken: params.challengeToken,
      verificationNotes,
      patchHash: currentPatchHash,
      findings: params.findings || [],
      counterEvidence: params.counterEvidence || [],
      limitations: params.limitations || [],
      createdAt: new Date().toISOString(),
    };

    // Re-evaluate approval readiness
    let approvalReadiness: ApprovalReadiness = proposal.approvalReadiness || 'READY_FOR_APPROVAL';
    let blockReason: string | null = null;

    if (proposal.verificationStatus === 'VERIFIED_FAIL') {
      approvalReadiness = 'BLOCKED_TEST_FAILED';
      blockReason = '격리 워크트리 테스트 실패';
    } else {
      if (status === 'COMPLETED_VERIFIED') {
        approvalReadiness = 'READY_FOR_APPROVAL';
        blockReason = null;
      } else {
        approvalReadiness = 'APPROVABLE_WITH_RISK_WARNING';
        blockReason = `호스트 서브에이전트 실행 기록이 독립 검증되지 않은 미공인 검토 요약입니다 (${verificationNotes})`;
      }
    }

    ctx.db.updateProposalOrchestrationReview(proposal.id, review, approvalReadiness, blockReason);
    const updated = ctx.db.getRepairProposal(proposal.id)!;
    ctx.emitChange('proposal_reviewed', { proposal: updated, review });
    return { review, proposal: updated };
  }
