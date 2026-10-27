import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from './context.js';
import { inspectProjectStateAsync } from './project.js';
import { resolveDataDir, resolveCacheDir } from '../utils/paths.js';
import {
  Project,
  ProjectHealth,
  ProjectOverview,
  TimelineEvent,
  RuntimeInfo,
  WorkspaceComparison,
} from '../types.js';
import { parseUnifiedDiffFiles, firstMeaningfulLine } from './helpers.js';

/**
 * Shared stats calculator & ProjectOverview assembler.
 * Used identically by both synchronous getOverview and asynchronous getOverviewAsync.
 */
export function buildOverviewFromHealth(
  ctx: CoreContext,
  project: Project,
  health: ProjectHealth
): ProjectOverview {
  const incidents = ctx.db.listIncidents(project.id, 200);
  const proposals = ctx.db.listProposalsForProject(project.id, 200);

  const applied = proposals.filter((p) => p.approvalStatus === 'APPLIED');
  const verifiedPass = proposals.filter((p) => p.verificationStatus === 'VERIFIED_PASS');
  const judged = proposals.filter((p) => p.verificationStatus !== 'PENDING');
  const openIncidents = incidents.filter((i) => i.status !== 'RESOLVED');

  let lastTestStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'UNKNOWN';
  const lastTestEvent = [...ctx.db.listAgentEvents(project.id, 50)].find(
    (e) => e.kind === 'TEST_PASS' || e.kind === 'TEST_FAIL'
  );
  const latestIncident = incidents[0];
  const candidates: Array<{ at: string; status: 'PASS' | 'FAIL' }> = [];
  if (lastTestEvent) candidates.push({ at: lastTestEvent.createdAt, status: lastTestEvent.kind === 'TEST_PASS' ? 'PASS' : 'FAIL' });
  if (latestIncident) candidates.push({ at: latestIncident.createdAt, status: latestIncident.status === 'RESOLVED' ? 'PASS' : 'FAIL' });
  candidates.sort((a, b) => b.at.localeCompare(a.at));
  if (candidates[0]) lastTestStatus = candidates[0].status;

  const incidentById = new Map(incidents.map((i) => [i.id, i]));
  const recentRecoveries = applied
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
    .slice(0, 5)
    .map((p) => ({
      proposalId: p.id,
      incidentTitle: incidentById.get(p.incidentId)?.title ?? '(알 수 없는 사고)',
      summary: p.rootCauseAnalysis,
      appliedAt: p.appliedAt ?? p.createdAt,
      files: p.touchedFiles,
    }));

  return {
    project,
    health,
    stats: {
      totalProposals: proposals.length,
      appliedProposals: applied.length,
      verifiedPassProposals: verifiedPass.length,
      successRate: judged.length > 0 ? Math.round((verifiedPass.length / judged.length) * 100) : null,
      openIncidents: openIncidents.length,
      resolvedIncidents: incidents.length - openIncidents.length,
      lastTestStatus,
    },
    openIncidents: openIncidents.slice(0, 8),
    recentRecoveries,
  };
}

export function getOverview(ctx: CoreContext, repoPath: string): ProjectOverview {
  const project = ctx.ensureProject(repoPath);
  const health = ctx.inspectProjectState(project);
  return buildOverviewFromHealth(ctx, project, health);
}

export async function getOverviewAsync(ctx: CoreContext, repoPath: string): Promise<ProjectOverview> {
  const project = ctx.ensureProject(repoPath);
  const health = ctx.inspectProjectStateAsync
    ? await ctx.inspectProjectStateAsync(project)
    : await inspectProjectStateAsync(ctx, project);
  return buildOverviewFromHealth(ctx, project, health);
}

  /**
   * AI Action Timeline
   */
  export function getTimeline(ctx: CoreContext, projectId: string, limit: number = 150): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const cp of ctx.db.listCheckpoints(projectId, limit)) {
      const isRecovery = cp.agentName === 'core-gate';
      events.push({
        id: `tl_${cp.id}`,
        kind: isRecovery ? 'RECOVERY' : 'CHECKPOINT',
        title: cp.label,
        summary: cp.changedFiles.length > 0 ? `변경된 파일 ${cp.changedFiles.length}개 포함` : '변경 사항 없는 깨끗한 상태',
        actor: cp.agentName,
        sessionId: cp.sessionId,
        createdAt: cp.createdAt,
        files: cp.changedFiles,
        refs: { checkpointId: cp.id },
      });
    }

    for (const inc of ctx.db.listIncidents(projectId, limit)) {
      events.push({
        id: `tl_${inc.id}`,
        kind: 'INCIDENT',
        title: inc.title,
        summary: inc.status === 'RESOLVED' ? '해결됨' : '아직 해결되지 않은 Incident',
        actor: inc.agentName || 'incident',
        sessionId: inc.sessionId,
        createdAt: inc.createdAt,
        files: parseUnifiedDiffFiles(inc.diffSummary),
        diff: inc.diffSummary,
        log: inc.errorOutput,
        refs: { incidentId: inc.id },
      });
      events.push({
        id: `tl_${inc.id}_fail`,
        kind: 'TEST_FAIL',
        title: '테스트/빌드 실패 감지',
        summary: firstMeaningfulLine(inc.errorOutput),
        actor: 'test',
        createdAt: inc.createdAt,
        files: [],
        log: inc.errorOutput,
        refs: { incidentId: inc.id },
      });
    }

    for (const p of ctx.db.listProposalsForProject(projectId, limit)) {
      events.push({
        id: `tl_${p.id}`,
        kind: 'PROPOSAL',
        title: '수정안 제안',
        summary: p.rootCauseAnalysis.split(/\r?\n/)[0].slice(0, 140),
        actor: 'agent',
        createdAt: p.createdAt,
        files: p.touchedFiles,
        diff: p.patchDiff,
        refs: { proposalId: p.id, incidentId: p.incidentId },
      });
      if (p.verificationStatus !== 'PENDING') {
        events.push({
          id: `tl_${p.id}_verify`,
          kind: p.verificationStatus === 'VERIFIED_PASS' ? 'TEST_PASS' : 'TEST_FAIL',
          title: p.verificationStatus === 'VERIFIED_PASS' ? '격리 Worktree 검증 통과' : '격리 Worktree 검증 실패',
          summary: firstMeaningfulLine(p.verificationLog),
          actor: 'worktree',
          createdAt: p.createdAt,
          files: p.touchedFiles,
          log: p.verificationLog,
          refs: { proposalId: p.id, incidentId: p.incidentId },
        });
      }
      if (p.appliedAt) {
        events.push({
          id: `tl_${p.id}_applied`,
          kind: 'RECOVERY',
          title: '승인된 수정안 적용',
          summary: `${p.touchedFiles.length}개 파일에 적용됨`,
          actor: 'user',
          createdAt: p.appliedAt,
          files: p.touchedFiles,
          diff: p.patchDiff,
          refs: { proposalId: p.id, incidentId: p.incidentId },
        });
      }
    }

    for (const e of ctx.db.listAgentEvents(projectId, limit)) {
      events.push({
        id: `tl_${e.id}`,
        kind: e.kind,
        title: e.title,
        summary: e.detail.split(/\r?\n/)[0].slice(0, 140),
        actor: e.agentName,
        sessionId: e.sessionId,
        createdAt: e.createdAt,
        files: e.filePath ? [e.filePath] : [],
        log: e.detail || undefined,
        refs: {},
      });
    }

    return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }


  export function getRuntimeInfo(ctx: CoreContext, port: number = 3847): RuntimeInfo {
    const dataDir = resolveDataDir();
    const cacheDir = resolveCacheDir();

    return {
      service: 'agent-autopsy',
      version: '0.1.0',
      pid: process.pid,
      port,
      host: '127.0.0.1',
      dataDir,
      cacheDir,
      dbPath: ctx.db.resolvedPath,
      dbStatus: ctx.db.status,
      dbInitError: ctx.db.initError,
      recoveryGuide: ctx.db.recoveryGuide,
      startedAt: new Date().toISOString(),
    };
  }

  export function getWorkspaceComparison(ctx: CoreContext, 
    repoPath: string,
    options?: { checkpointId?: string; commitSha?: string }
  ): WorkspaceComparison {
    const project = ctx.ensureProject(repoPath);
    const rootPath = project.rootPath;
    const status = ctx.gitEngine.getStatus(rootPath);
    let workingDiff = ctx.gitEngine.getDiff(rootPath);

    // If workingDiff is empty but untracked files exist, generate pseudo-diff preview
    if (!workingDiff && status.untrackedFiles.length > 0) {
      const previews: string[] = [];
      for (const u of status.untrackedFiles.slice(0, 5)) {
        try {
          const p = path.resolve(rootPath, u);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            previews.push(`--- /dev/null\n+++ b/${u}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`);
          }
        } catch {}
      }
      if (previews.length > 0) workingDiff = previews.join('\n\n');
    }

    let checkpointDiff: string | undefined;
    if (options?.checkpointId) {
      const cp = ctx.db.getCheckpoint(options.checkpointId);
      if (cp) {
        try {
          checkpointDiff = ctx.gitEngine.getDiff(rootPath, cp.worktreeCommitSha || cp.gitHeadSha);
        } catch {}
      }
    }

    const recentCommits = ctx.gitEngine.getRecentCommits(rootPath, 15);
    let commitDiff: string | undefined;
    if (options?.commitSha) {
      try {
        commitDiff = ctx.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', options.commitSha]);
      } catch {}
    } else if (recentCommits.length > 0) {
      try {
        commitDiff = ctx.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', recentCommits[0].sha]);
      } catch {}
    }

    return {
      workingDiff,
      changedFiles: status.changedFiles,
      untrackedFiles: status.untrackedFiles,
      checkpointDiff,
      selectedCheckpointId: options?.checkpointId,
      recentCommits,
      commitDiff,
      selectedCommitSha: options?.commitSha || recentCommits[0]?.sha,
    };
  }

