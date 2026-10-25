import { CoreContext } from './context.js';
import { countDiffLines, firstMeaningfulLine } from './helpers.js';

import {
  HistorySearchItem,
  IncidentAttemptItem,
  CheckpointChangesSummary,
} from '../types.js';

export function searchHistory(ctx: CoreContext, 
    repoPath: string,
    files?: string[],
    keywords?: string[]
  ): HistorySearchItem[] {
    const project = ctx.ensureProject(repoPath);
    const incidents = ctx.db.listIncidents(project.id, 50);
    const proposals = ctx.db.listProposalsForProject(project.id, 100);

    const normFiles = (files || []).map((f) => f.toLowerCase().replace(/\\/g, '/'));
    const normKeywords = (keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);

    const matches = incidents.filter((inc) => {
      if (normFiles.length > 0) {
        const diffLower = (inc.diffSummary || '').toLowerCase();
        const hasFileMatch = normFiles.some((f) => diffLower.includes(f));
        if (!hasFileMatch) return false;
      }
      if (normKeywords.length > 0) {
        const textToSearch = [
          inc.title,
          inc.userReportText || '',
          inc.errorOutput,
          ...(inc.causeEvidence || []),
        ]
          .join(' ')
          .toLowerCase();
        const hasKwMatch = normKeywords.some((k) => textToSearch.includes(k));
        if (!hasKwMatch) return false;
      }
      return true;
    });

    return matches.slice(0, 10).map((inc) => {
      const applied = proposals.find(
        (p) => p.incidentId === inc.id && p.approvalStatus === 'APPLIED'
      );
      return {
        id: inc.id,
        title: inc.title.slice(0, 80),
        status: inc.status,
        causeVerdict: inc.causeVerdict || 'UNKNOWN',
        confirmedCause: inc.causeEvidence?.[0]?.slice(0, 100),
        appliedRepair: applied
          ? {
              id: applied.id,
              summary: applied.rootCauseAnalysis.slice(0, 100),
            }
          : undefined,
        createdAt: inc.createdAt,
      };
    });
  }

  /**
   * 4-B. getIncidentAttempts: Returns rejected or failed verification attempts for an incident.
   * Concise summary limited to at most 10 items (payload < 2KB).
   */
  export function getIncidentAttempts(ctx: CoreContext, incidentId: string): IncidentAttemptItem[] {
    const proposals = ctx.db.listProposalsForIncident(incidentId);
    const attempts = proposals.filter(
      (p) =>
        p.approvalStatus === 'REJECTED' ||
        p.approvalStatus === 'TAMPERED' ||
        p.verificationStatus === 'VERIFIED_FAIL'
    );

    return attempts.slice(0, 10).map((p) => {
      let status: 'REJECTED' | 'VERIFIED_FAIL' | 'TAMPERED' = 'VERIFIED_FAIL';
      let failureReason = '';
      if (p.approvalStatus === 'REJECTED') {
        status = 'REJECTED';
        failureReason = p.rejectionReason || '사용자가 수정안을 거절함';
      } else if (p.approvalStatus === 'TAMPERED') {
        status = 'TAMPERED';
        failureReason = '승인 지문 변조 또는 미승인 정책 우회 감지';
      } else {
        status = 'VERIFIED_FAIL';
        failureReason = p.verificationLog ? p.verificationLog.slice(-200) : '격리 검증 테스트 실패';
      }

      const failedStage = p.stages?.find((s) => s.status === 'FAIL')?.stage;

      return {
        proposalId: p.id,
        status,
        title: p.rootCauseAnalysis.slice(0, 80),
        failedStage,
        failureReason: failureReason.slice(0, 150),
        createdAt: p.createdAt,
      };
    });
  }

  /**
   * 4-C. getChangesSinceGoodCheckpoint: Returns summary of changes since last clean/good checkpoint.
   */
  export function getChangesSinceGoodCheckpoint(ctx: CoreContext, repoPath: string): CheckpointChangesSummary {
    const project = ctx.ensureProject(repoPath);
    const checkpoints = ctx.db.listCheckpoints(project.id);
    const goodCp =
      checkpoints.find((cp) => cp.gitStashSha === null && cp.changedFiles.length === 0) || checkpoints[0];

    if (!goodCp) {
      return {
        changedFiles: [],
        totalAdded: 0,
        totalRemoved: 0,
        summary: '기록된 체크포인트가 없습니다.',
      };
    }

    const baseSha = goodCp.worktreeCommitSha || goodCp.gitHeadSha || 'HEAD';
    const changedFiles: Array<{ filePath: string; addedLines: number; removedLines: number }> = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    try {
      const numstat = ctx.gitEngine.runGit(project.rootPath, [
        'diff',
        '--numstat',
        baseSha,
      ]);
      for (const line of numstat.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const added = parseInt(parts[0], 10) || 0;
          const removed = parseInt(parts[1], 10) || 0;
          const filePath = parts.slice(2).join(' ');
          changedFiles.push({ filePath, addedLines: added, removedLines: removed });
          totalAdded += added;
          totalRemoved += removed;
        }
      }
    } catch {}

    return {
      checkpointId: goodCp.id,
      checkpointLabel: goodCp.label,
      gitHeadSha: goodCp.gitHeadSha,
      createdAt: goodCp.createdAt,
      changedFiles: changedFiles.slice(0, 20),
      totalAdded,
      totalRemoved,
      summary: `체크포인트 "${goodCp.label}" 이후 ${changedFiles.length}개 파일 변경 (+${totalAdded}/-${totalRemoved})`,
    };
  }
