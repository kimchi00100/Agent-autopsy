import {
  proposeAndVerifyRepair,
  approveProposal,
  rejectProposal,
  recordTamperIncident,
  applyApprovedRepair,
} from './core/repair.js';
import {
  collectIncidentBundle,
  analyzeIncidentCauses,
  getIncidentNextAction,
} from './core/incident.js';
import {
  recordAgentEvent,
  listActiveAgents,
  createDirective,
  awaitUserDecision,
  getPendingDirectives,
  acknowledgeDirective,
} from './core/directives.js';
import { evaluateOrchestrationDecision, createReviewChallenge, submitOrchestrationReview } from './core/orchestration.js';
import { runReproduction, buildReproductionCommand } from './core/reproduction.js';
import { searchHistory, getIncidentAttempts, getChangesSinceGoodCheckpoint } from './core/history.js';
import { captureCheckpoint, rollbackToCheckpoint } from './core/checkpoint.js';
import { CoreContext } from './core/context.js';
import {
  discoverSafeTestCommands,
  detectTestCommand,
  ensureProject,
  computePathFingerprint,
  computeUnapprovedChangesFingerprint,
  inspectProjectState,
  diagnoseProject,
  getAgentsMdTemplate,
  onboardProject,
  updateProjectSettings,
  proposeTestCommand,
  confirmTestCommand,
} from './core/project.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AutopsyDatabase } from './db/database.js';
import { GitEngine } from './git/git-engine.js';
import { PatchEngine } from './patch/patch-engine.js';
import { WorktreeRunner, TestExecutionResult } from './runner/worktree-runner.js';
import { AutoBaselineWatcher } from './watcher/auto-watcher.js';
import { sendWindowsToast } from './notifications/toast.js';
import {
  resolveDataDir,
  resolveCacheDir,
  generateDeterministicProjectId,
  normalizeRepoPath,
} from './utils/paths.js';
import {
  getInstallationSecretKey,
  signApprovalPayload,
  verifyApprovalSignature,
  hashFileChanges,
  signTestCommand,
  verifyTestCommandSignature,
} from './utils/security.js';
import {
  Project,
  Checkpoint,
  Incident,
  RepairProposal,
  FileChange,
  ProjectHealth,
  AgentEvent,
  AgentEventKind,
  TimelineEvent,
  ProjectOverview,
  ApprovalFingerprint,
  VerificationMode,
  Severity,
  RiskLevel,
  OrchestrationReviewStatus,
  ApprovalReadiness,
  HostEnvironment,
  OrchestrationReview,
  OrchestrationDecision,
  CauseVerdict,
  ThreeLevelHealth,
  HealthLevelStatus,
  ReviewChallenge,
  AgentDirective,
  DirectiveKind,
  DirectiveDeliveryStatus,
  ConfirmedIntentData,
  DiscoveredCommands,
  ThreeStageExecutionResult,
  DiagnosticItem,
  ProjectDiagnostics,
  OnboardingResult,
  OnboardingPreview,
  RuntimeInfo,
  WorkspaceComparison,
  ReproductionResult,
  ReproductionStatus,
  IntentSource,
  IntentProvenance,
  StructuredIntents,
  NextAction,
  HistorySearchItem,
  IncidentAttemptItem,
  CheckpointChangesSummary,
} from './types.js';
import { analyzeIncident, IncidentAnalysis, parseUnifiedDiff, parseStackFrames } from './analysis/analyzer.js';

function parseUnifiedDiffFiles(diff: string): string[] {
  return parseUnifiedDiff(diff).map((f) => f.filePath);
}

export function matchesGlobPath(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

  if (normPattern === '*' || normPattern === '**' || normPattern === '**/*') return true;

  const regexStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
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

export interface CoreManagerOptions {
  customDbPath?: string;
  defaultTestCommand?: string;
}

export class CoreManager {
  private ctx!: CoreContext;
  private db: AutopsyDatabase;
  private gitEngine: GitEngine;
  private patchEngine: PatchEngine;
  private worktreeRunner: WorktreeRunner;
  private watchers = new Map<string, AutoBaselineWatcher>();
  private changeListeners = new Set<(type: string, data: any) => void>();
  private isApplyingApprovedPatch = false;
  private quarantineCache = new Map<string, { fingerprint: string; backupRef: string }>();
  private activeWaiters = new Map<
    string,
    {
      resolve: (val: any) => void;
      timer: NodeJS.Timeout;
      proposalId: string;
      repoPath: string;
    }
  >();

  constructor(options: CoreManagerOptions = {}) {
    this.gitEngine = new GitEngine();
    this.patchEngine = new PatchEngine();
    this.worktreeRunner = new WorktreeRunner();

    const dataDir = resolveDataDir();
    const dbPath =
      options.customDbPath ||
      path.resolve(dataDir, 'autopsy.db');
    this.db = new AutopsyDatabase(dbPath);

    const self = this;
    this.ctx = {
      db: this.db,
      gitEngine: this.gitEngine,
      patchEngine: this.patchEngine,
      worktreeRunner: this.worktreeRunner,
      watchers: this.watchers,
      changeListeners: this.changeListeners,
      get isApplyingApprovedPatch() { return self.isApplyingApprovedPatch; },
      set isApplyingApprovedPatch(val: boolean) { self.isApplyingApprovedPatch = val; },
      quarantineCache: this.quarantineCache,
      activeWaiters: this.activeWaiters,
      options,
      emitChange: (t, d) => this.emitChange(t, d),
      getActivePort: () => this.getActivePort(),
      ensureProject: (r, c) => this.ensureProject(r, c),
      captureCheckpoint: (r, l, a, s) => this.captureCheckpoint(r, l, a, s),
      inspectProjectState: (r) => this.inspectProjectState(r),
      recordAgentEvent: (r, k, t, d, f, a, s) => this.recordAgentEvent(r, k, t, d, f, a, s),
      evaluateOrchestrationDecision: (p, t, e, d, c, v, h, r) => this.evaluateOrchestrationDecision(p, t, e, d, c, v, h, r),
      detectTestCommand: (r) => this.detectTestCommand(r),
      rejectProposal: (p, r) => this.rejectProposal(p, r),
      recordTamperIncident: (r, p, re) => this.recordTamperIncident(r, p, re),
      listActiveAgents: () => this.listActiveAgents(),
      getAgentsMdTemplate: () => this.getAgentsMdTemplate(),
    };
  }

  public getDatabase(): AutopsyDatabase {
    return this.db;
  }

  public getWorktreeRunner(): WorktreeRunner {
    return this.worktreeRunner;
  }

  public getActivePort(): number {
    if (process.env.PORT) return Number(process.env.PORT);
    try {
      const dataDir = resolveDataDir();
      const runtimePath = path.join(dataDir, 'runtime.json');
      if (fs.existsSync(runtimePath)) {
        const info = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
        if (info.port) return Number(info.port);
      }
    } catch {}
    return 3847;
  }

  public subscribe(fn: (type: string, data: any) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private emitChange(type: string, data: any = {}) {
    for (const listener of this.changeListeners) {
      try {
        listener(type, data);
      } catch {
        // Ignored
      }
    }

    // Cross-process ping to Agent Autopsy local server so Electron UI updates instantly
    try {
      const payload = JSON.stringify({ type, data });
      const targetPort = this.getActivePort();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: '/api/internal/notify',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 400,
        },
        () => {}
      );
      req.on('error', () => {}); // Server may not be running yet
      req.write(payload);
      req.end();
    } catch {}
  }

  /**
   * Safely discovers available build/test commands and scripts in a project,
   * flagging dangerous commands and recommending safe defaults.
   */
  public discoverSafeTestCommands(repoPath: string): DiscoveredCommands {
    return discoverSafeTestCommands(this.ctx, repoPath);
  }

  public detectTestCommand(repoPath: string): string {
    return detectTestCommand(this.ctx, repoPath);
  }

  public ensureProject(repoPath: string, testCommand?: string): Project {
    return ensureProject(this.ctx, repoPath, testCommand);
  }

  public captureCheckpoint(
    repoPath: string,
    label: string = 'Manual Checkpoint',
    agentName: string = 'user',
    sessionId?: string
  ): Checkpoint {
    return captureCheckpoint(this.ctx, repoPath, label, agentName, sessionId);
  }

  private computePathFingerprint(fullPath: string): string {
    return computePathFingerprint(this.ctx, fullPath);
  }

  private computeUnapprovedChangesFingerprint(
    repoPath: string,
    unapprovedTracked: string[],
    unapprovedUntracked: string[]
  ): string {
    return computeUnapprovedChangesFingerprint(this.ctx, repoPath, unapprovedTracked, unapprovedUntracked);
  }

  public inspectProjectState(repoPath: string): ProjectHealth {
    return inspectProjectState(this.ctx, repoPath);
  }

  public diagnoseProject(repoPath: string): ProjectDiagnostics {
    return diagnoseProject(this.ctx, repoPath);
  }

  public getAgentsMdTemplate(): string {
    return getAgentsMdTemplate();
  }

  public onboardProject(repoPath: string): OnboardingResult {
    return onboardProject(this.ctx, repoPath);
  }

  public async collectIncidentBundle(
    repoPath: string,
    titleOrOptions:
      | string
      | {
          title: string;
          userReportText?: string;
          errorOutput?: string;
          severity?: Severity;
          agentName?: string;
          sessionId?: string;
          expectedBehavior?: string;
          observedBehavior?: string;
          brokenStep?: string;
          executionTrace?: any[];
          reproductionCondition?: string;
          verificationMethod?: string;
          verificationType?: any;
          userConfirmedIntent?: boolean;
          userConfirmationSummary?: string;
        },
    errorOutput?: string,
    severity: Severity = 'UNASSESSED',
    agentName: string = 'agent',
    sessionId?: string,
    expectedBehavior?: string,
    observedBehavior?: string,
    brokenStep?: string,
    executionTrace?: any[],
    reproductionCondition?: string,
    verificationMethod?: string,
    verificationType?: any,
    userConfirmedIntent?: boolean,
    userConfirmationSummary?: string,
    userReportText?: string
  ): Promise<Incident> {
    return collectIncidentBundle(
      this.ctx,
      repoPath,
      titleOrOptions,
      errorOutput,
      severity,
      agentName,
      sessionId,
      expectedBehavior,
      observedBehavior,
      brokenStep,
      executionTrace,
      reproductionCondition,
      verificationMethod,
      verificationType,
      userConfirmedIntent,
      userConfirmationSummary,
      userReportText
    );
  }

  public evaluateOrchestrationDecision(
    project: Project,
    title: string,
    errorOutput: string,
    diffSummary: string,
    changedFiles: string[],
    causeVerdict?: CauseVerdict,
    threeLevelHealth?: ThreeLevelHealth,
    retryCount: number = 0
  ): OrchestrationDecision {
    return evaluateOrchestrationDecision(this.ctx, project, title, errorOutput, diffSummary, changedFiles, causeVerdict, threeLevelHealth, retryCount);
  }

  public async proposeAndVerifyRepair(
    repoPath: string,
    incidentId: string,
    rootCauseAnalysis: string,
    fileChanges: FileChange[]
  ): Promise<{ proposal: RepairProposal; executionResult: ThreeStageExecutionResult }> {
    return proposeAndVerifyRepair(this.ctx, repoPath, incidentId, rootCauseAnalysis, fileChanges);
  }
  /**
   * Generates a cryptographic review challenge token binding proposalId and patchHash.
   */
  public createReviewChallenge(
    repoPath: string,
    proposalId: string
  ): ReviewChallenge {
    return createReviewChallenge(this.ctx, repoPath, proposalId);
  }

  public submitOrchestrationReview(
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
    return submitOrchestrationReview(this.ctx, repoPath, params);
  }

  public updateProjectSettings(
    repoPath: string,
    settings: {
      verificationMode?: VerificationMode;
      preferredHost?: HostEnvironment;
      testCommand?: string;
      sensitivePaths?: string[];
      riskThresholdLines?: number;
      enableCoverage?: boolean;
    }
  ): Project {
    return updateProjectSettings(this.ctx, repoPath, settings);
  }

  public proposeTestCommand(
    repoPath: string,
    command: string,
    reason: string
  ): {
    success: boolean;
    project: Project;
    next_action: {
      actor: string;
      action: string;
      agent_should: string;
      forbidden: string[];
    };
  } {
    return proposeTestCommand(this.ctx, repoPath, command, reason);
  }

  public confirmTestCommand(repoPath: string, command: string): Project {
    return confirmTestCommand(this.ctx, repoPath, command);
  }

  public approveProposal(
    proposalId: string,
    selectedFiles?: string[],
    forceOverrideWithRiskAck: boolean = false
  ): ApprovalFingerprint {
    return approveProposal(this.ctx, proposalId, selectedFiles, forceOverrideWithRiskAck);
  }

  public rejectProposal(proposalId: string, reason?: string): void {
    return rejectProposal(this.ctx, proposalId, reason);
  }

  public recordTamperIncident(repoPath: string, proposalId: string, reason: string): void {
    return recordTamperIncident(this.ctx, repoPath, proposalId, reason);
  }

  public applyApprovedRepair(
    repoPath: string,
    proposalId: string,
    selectedFiles?: string[]
  ): { applied: boolean; touchedFiles: string[]; diff: string } {
    return applyApprovedRepair(this.ctx, repoPath, proposalId, selectedFiles);
  }

  /**
   * 6. rollback_to_checkpoint: Restores repository to exact checkpoint.
   */
  public rollbackToCheckpoint(
    repoPath: string,
    checkpointId: string
  ): { restored: boolean; backupRef: string } {
    return rollbackToCheckpoint(this.ctx, repoPath, checkpointId);
  }

  public recordAgentEvent(
    repoPath: string,
    kind: AgentEventKind,
    title: string,
    detail: string = '',
    filePath: string | null = null,
    agentName: string = 'mcp-agent',
    sessionId?: string
  ): AgentEvent {
    return recordAgentEvent(this.ctx, repoPath, kind, title, detail, filePath, agentName, sessionId);
  }

  public getOverview(repoPath: string): ProjectOverview {
    const project = this.ensureProject(repoPath);
    const health = this.inspectProjectState(project.rootPath);
    const incidents = this.db.listIncidents(project.id, 200);
    const proposals = this.db.listProposalsForProject(project.id, 200);

    const applied = proposals.filter((p) => p.approvalStatus === 'APPLIED');
    const verifiedPass = proposals.filter((p) => p.verificationStatus === 'VERIFIED_PASS');
    const judged = proposals.filter((p) => p.verificationStatus !== 'PENDING');
    const openIncidents = incidents.filter((i) => i.status !== 'RESOLVED');

    let lastTestStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'UNKNOWN';
    const lastTestEvent = [...this.db.listAgentEvents(project.id, 50)].find(
      (e) => e.kind === 'TEST_PASS' || e.kind === 'TEST_FAIL'
    );
    const latestProposal = proposals[0];
    const latestIncident = incidents[0];
    const candidates: Array<{ at: string; status: 'PASS' | 'FAIL' }> = [];
    if (lastTestEvent) candidates.push({ at: lastTestEvent.createdAt, status: lastTestEvent.kind === 'TEST_PASS' ? 'PASS' : 'FAIL' });
    if (latestProposal && latestProposal.verificationStatus !== 'PENDING') {
      candidates.push({ at: latestProposal.createdAt, status: latestProposal.verificationStatus === 'VERIFIED_PASS' ? 'PASS' : 'FAIL' });
    }
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

  /**
   * AI Action Timeline
   */
  public getTimeline(projectId: string, limit: number = 150): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const cp of this.db.listCheckpoints(projectId, limit)) {
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

    for (const inc of this.db.listIncidents(projectId, limit)) {
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

    for (const p of this.db.listProposalsForProject(projectId, limit)) {
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

    for (const e of this.db.listAgentEvents(projectId, limit)) {
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

  /**
   * Incident cause analysis with full interactive IncidentFlowData.
   */
  public analyzeIncidentCauses(incidentId: string): { incident: Incident; analysis: IncidentAnalysis } {
    return analyzeIncidentCauses(this.ctx, incidentId);
  }

  public async runReproduction(
    repoPath: string,
    incidentId: string,
    testFilePath: string
  ): Promise<ReproductionResult> {
    return runReproduction(this.ctx, repoPath, incidentId, testFilePath);
  }


  private buildReproductionCommand(confirmedRunner: string, relTestPath: string): string {
    return buildReproductionCommand(confirmedRunner, relTestPath);
  }

  public getIncidentNextAction(incident: Incident): NextAction {
    return getIncidentNextAction(incident);
  }

  public searchHistory(
    repoPath: string,
    files?: string[],
    keywords?: string[]
  ): HistorySearchItem[] {
    return searchHistory(this.ctx, repoPath, files, keywords);
  }

  public getIncidentAttempts(incidentId: string): IncidentAttemptItem[] {
    return getIncidentAttempts(this.ctx, incidentId);
  }

  public getChangesSinceGoodCheckpoint(repoPath: string): CheckpointChangesSummary {
    return getChangesSinceGoodCheckpoint(this.ctx, repoPath);
  }

  public listActiveAgents() {
    return listActiveAgents(this.ctx);
  }

  public createDirective(
    repoPath: string,
    params: {
      incidentId?: string;
      proposalId?: string;
      patchHash?: string;
      kind: DirectiveKind;
      feedbackText?: string;
      confirmedIntent?: ConfirmedIntentData;
    }
  ): AgentDirective {
    return createDirective(this.ctx, repoPath, params);
  }

  public async awaitUserDecision(
    repoPath: string,
    proposalId: string,
    timeoutSec: number = 90
  ): Promise<{
    status: 'DIRECTIVE_DELIVERED' | 'WAIT_TIMEOUT';
    directive?: AgentDirective;
    message?: string;
  }> {
    return awaitUserDecision(this.ctx, repoPath, proposalId, timeoutSec);
  }

  public getPendingDirectives(repoPath: string, agentName: string = 'agent'): AgentDirective[] {
    return getPendingDirectives(this.ctx, repoPath, agentName);
  }

  public acknowledgeDirective(directiveId: string, agentName: string = 'agent'): AgentDirective {
    return acknowledgeDirective(this.ctx, directiveId, agentName);
  }

  public getRuntimeInfo(port: number = 3847): RuntimeInfo {
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
      dbPath: this.db.resolvedPath,
      dbStatus: this.db.status,
      dbInitError: this.db.initError,
      recoveryGuide: this.db.recoveryGuide,
      startedAt: new Date().toISOString(),
    };
  }

  public getWorkspaceComparison(
    repoPath: string,
    options?: { checkpointId?: string; commitSha?: string }
  ): WorkspaceComparison {
    const project = this.ensureProject(repoPath);
    const rootPath = project.rootPath;
    const status = this.gitEngine.getStatus(rootPath);
    let workingDiff = this.gitEngine.getDiff(rootPath);

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
      const cp = this.db.getCheckpoint(options.checkpointId);
      if (cp) {
        try {
          checkpointDiff = this.gitEngine.getDiff(rootPath, cp.worktreeCommitSha || cp.gitHeadSha);
        } catch {}
      }
    }

    const recentCommits = this.gitEngine.getRecentCommits(rootPath, 15);
    let commitDiff: string | undefined;
    if (options?.commitSha) {
      try {
        commitDiff = this.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', options.commitSha]);
      } catch {}
    } else if (recentCommits.length > 0) {
      try {
        commitDiff = this.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', recentCommits[0].sha]);
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

  public async shutdown(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();

    for (const waiter of this.activeWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        status: 'WAIT_TIMEOUT',
        message: 'CoreManager is shutting down',
      });
    }
    this.activeWaiters.clear();

    this.db.close();
  }
}
