import {
  getOverview,
  getOverviewAsync,
  getTimeline,
  getRuntimeInfo,
  getWorkspaceComparison,
} from './core/overview.js';
import {
  proposeAndVerifyRepair,
  approveProposal,
  rejectProposal,
  recordTamperIncident,
  applyApprovedRepair,
  getProposalIntegrity,
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
import { runReproduction } from './core/reproduction.js';
import { searchHistory, getIncidentAttempts, getChangesSinceGoodCheckpoint } from './core/history.js';
import { captureCheckpoint, rollbackToCheckpoint } from './core/checkpoint.js';
import { packChangeScope, PackagedChangeScope, PackChangeScopeOptions } from './localization/context-packer.js';
import { CoreContext } from './core/context.js';
import {
  discoverSafeTestCommands,
  detectTestCommand,
  ensureProject,
  inspectProjectState,
  inspectProjectStateAsync,
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
  ReproductionFailureKind,
  IntentSource,
  IntentProvenance,
  StructuredIntents,
  NextAction,
  HistorySearchItem,
  IncidentAttemptItem,
  CheckpointChangesSummary,
  AuditLogEntry,
  AuditChainVerificationResult,
  ProposalIntegrityResult,
} from './types.js';
import { analyzeIncident, IncidentAnalysis, parseUnifiedDiff, parseStackFrames } from './analysis/analyzer.js';

export {
  matchesGlobPath,
  countDiffLines,
  parseUnifiedDiffFiles,
  firstMeaningfulLine,
} from './core/helpers.js';

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
      inspectProjectStateAsync: (r) => this.inspectProjectStateAsync(r),
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


  public inspectProjectState(repoPathOrProject: string | Project): ProjectHealth {
    return inspectProjectState(this.ctx, repoPathOrProject);
  }

  public async inspectProjectStateAsync(repoPathOrProject: string | Project): Promise<ProjectHealth> {
    return inspectProjectStateAsync(this.ctx, repoPathOrProject);
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
    forceOverrideWithRiskAck: boolean = false,
    repoPath?: string
  ): ApprovalFingerprint {
    return approveProposal(this.ctx, proposalId, selectedFiles, forceOverrideWithRiskAck, repoPath);
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

  public getProposalIntegrity(proposalId: string, repoPath?: string): ProposalIntegrityResult {
    return getProposalIntegrity(this.ctx, proposalId, repoPath);
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
    return getOverview(this.ctx, repoPath);
  }

  public async getOverviewAsync(repoPath: string): Promise<ProjectOverview> {
    return getOverviewAsync(this.ctx, repoPath);
  }

  public getTimeline(projectId: string, limit: number = 150): TimelineEvent[] {
    return getTimeline(this.ctx, projectId, limit);
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
    return getRuntimeInfo(this.ctx, port);
  }

  public getWorkspaceComparison(
    repoPath: string,
    options?: { checkpointId?: string; commitSha?: string }
  ): WorkspaceComparison {
    return getWorkspaceComparison(this.ctx, repoPath, options);
  }
  public async getChangeScope(
    incidentId: string,
    options?: PackChangeScopeOptions
  ): Promise<PackagedChangeScope> {
    return packChangeScope(this.ctx, incidentId, options);
  }

  public verifyAuditChain(overrideSecret?: string): AuditChainVerificationResult {
    return this.db.verifyAuditChain(overrideSecret);
  }

  public getAuditLogs(limit?: number): AuditLogEntry[] {
    return this.db.getAuditLogs(limit);
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
