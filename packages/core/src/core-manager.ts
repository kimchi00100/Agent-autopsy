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
    const project = this.ensureProject(repoPath);
    const incident = this.db.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident with ID "${incidentId}" not found.`);
    }

    // 1. Prepare patch in memory
    const prepared = this.patchEngine.preparePatch(project.rootPath, fileChanges);
    const proposalId = `prop_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    // 2. Base commit to checkout in sandbox (use checkpoint worktree commit if available)
    let baseCommitSha = 'HEAD';
    if (incident.baseCheckpointId) {
      const baseCp = this.db.getCheckpoint(incident.baseCheckpointId);
      if (baseCp?.worktreeCommitSha) {
        baseCommitSha = baseCp.worktreeCommitSha;
      }
    }

    // 3. Create isolated worktree with dependency safety check
    const testCmd = project.testCommand || this.detectTestCommand(project.rootPath);

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
      this.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `[보안 경고] 테스트 명령 변조 감지`,
        `프로젝트 "${project.name}"의 테스트 명령("${project.testCommand}")이 승인된 전자서명과 일치하지 않습니다. 검증 실행을 즉시 차단합니다.`,
        null,
        'security-gate'
      );
      this.emitChange('tamper_detected', {
        projectId: project.id,
        reason: `테스트 명령 위변조 감지: "${project.testCommand}"`,
      });
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 프로젝트의 테스트 명령("${project.testCommand}")이 위변조되었습니다. 승인 서명 검증에 실패하여 격리 검증 실행이 거부되었습니다.`
      );
    }
    const { sandboxDir } = this.worktreeRunner.createWorktree(
      project.rootPath,
      proposalId,
      baseCommitSha,
      prepared.touchedFiles,
      testCmd
    );

    let executionResult: ThreeStageExecutionResult;
    try {
      // 4. Write patch into the isolated worktree
      this.patchEngine.writePatchToDisk(sandboxDir, prepared.appliedFiles);

      // 5. Run 3-stage validation in isolated worktree
      executionResult = await this.worktreeRunner.runThreeStageValidation({
        worktreePath: sandboxDir,
        repoPath: project.rootPath,
        touchedFiles: prepared.touchedFiles,
        fullTestCommand: testCmd,
      });
    } finally {
      // 6. Always clean up isolated worktree
      this.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
    }

    // 7. Record proposal with verification status & Risk-Adaptive Evidence Gate
    const verificationStatus = executionResult.success ? 'VERIFIED_PASS' : 'VERIFIED_FAIL';
    const patchHash = crypto.createHash('sha256').update(prepared.unifiedDiff).digest('hex');

    // Previous retry count on this incident
    const previousProposals = this.db.listProposalsForIncident(incidentId);
    const retryCount = previousProposals.length;

    // Evaluate risk and orchestration decision on the proposed patch
    const decision = this.evaluateOrchestrationDecision(
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
      fileChangesJson: JSON.stringify(fileChanges),
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
      createdAt: new Date().toISOString(),
    };

    this.db.insertRepairProposal(proposal);
    this.emitChange('proposal_created', proposal);
    return { proposal, executionResult };
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
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    const incident = this.db.getIncident(proposal.incidentId);
    if (!incident) throw new Error(`Incident not found.`);
    const project = this.db.getProject(incident.projectId);
    if (!project) throw new Error(`Project not found.`);

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
      targetFileHashes[f] = this.gitEngine.getFileSha256(absPath);
    }

    // 0-C: Hash the exact fileChanges to be applied (filtered by approvedFiles)
    let effectiveChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
    if (selectedFiles && selectedFiles.length > 0) {
      const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
      effectiveChanges = effectiveChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
    }
    const patchHash = hashFileChanges(effectiveChanges);
    const baseHeadSha = this.gitEngine.getHeadSha(project.rootPath);
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

    this.db.updateProposalApproval(proposalId, 'APPROVED', fingerprint);
    this.emitChange('proposal_approved', { proposalId, fingerprint });
    return fingerprint;
  }

  public rejectProposal(proposalId: string, reason?: string): void {
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    this.db.updateProposalApproval(proposalId, 'REJECTED', reason);
    this.emitChange('proposal_rejected', { proposalId });
  }

  /**
   * Records a security tampering event, marks proposal as TAMPERED, and emits notifications.
   */
  public recordTamperIncident(repoPath: string, proposalId: string, reason: string): void {
    const project = this.ensureProject(repoPath);
    this.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `[보안 경고] 승인 게이트 변조 감지`,
      `수정안 ID: ${proposalId}\n사유: ${reason}\n무단 승인 조작 또는 서명 위조가 감지되어 상태를 TAMPERED로 변경하고 적용을 즉시 차단했습니다.`,
      null,
      'security-gate'
    );
    try {
      this.db.updateProposalApproval(proposalId, 'TAMPERED');
    } catch {}
    this.emitChange('tamper_detected', { proposalId, reason, projectId: project.id });
    try {
      sendWindowsToast('Agent Autopsy 보안 경고', `[변조 감지] 수정안 ${proposalId} 적용이 보안 정책에 의해 차단되었습니다.`);
    } catch {}
  }

  /**
   * 5. apply_approved_repair:
   * [HARD SECURITY GATE]: Re-verifies approval fingerprint, cryptographic signature & pre-image file hashes to block TOCTOU and tampering attacks.
   */
  public applyApprovedRepair(
    repoPath: string,
    proposalId: string,
    selectedFiles?: string[]
  ): { applied: boolean; touchedFiles: string[]; diff: string } {
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal with ID "${proposalId}" not found.`);
    }

    // HARD SECURITY GATE 1: Status must be APPROVED
    if (proposal.approvalStatus !== 'APPROVED') {
      throw new Error(
        `[SECURITY GATE VIOLATION]: Repair proposal "${proposalId}" cannot be applied because its status is "${proposal.approvalStatus}". It must be explicitly approved by the user in Agent Autopsy first.`
      );
    }

    // HARD SECURITY GATE 2: Cryptographic fingerprint presence and signature check (Bypass / Tamper Defense)
    if (!proposal.approvalFingerprintJson) {
      this.recordTamperIncident(
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
      this.recordTamperIncident(
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
      this.recordTamperIncident(
        project.rootPath,
        proposalId,
        `승인된 수정 내용(해시: ${fp.patchHash.slice(0, 8)})과 현재 적용 대상 내용(해시: ${currentFileChangesHash.slice(0, 8)})이 일치하지 않습니다 (fileChangesJson 사후 변조).`
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 이후 패치 코드 변조(Patch Drift)가 감지되었습니다. 승인 당시와 다른 코드가 적용되는 것을 차단했습니다.`
      );
    }

    // Verify current HEAD has not moved
    const currentHead = this.gitEngine.getHeadSha(project.rootPath);
    if (fp.baseHeadSha && currentHead !== fp.baseHeadSha) {
      throw new Error(
        `[STALE_APPROVAL_ERROR]: 저장소의 Git HEAD 커밋이 승인 시점(${fp.baseHeadSha.slice(0, 7)})과 달라졌습니다 (${currentHead.slice(0, 7)}). 코드 오염을 방지하기 위해 적용이 중단되었습니다. 재검토해 주세요.`
      );
    }

    // Verify none of the target files on disk have changed since approval
    for (const [relPath, approvedHash] of Object.entries(fp.targetFileHashes)) {
      const abs = path.resolve(project.rootPath, relPath);
      const currentHash = this.gitEngine.getFileSha256(abs);
      if (currentHash !== approvedHash) {
        throw new Error(
          `[STALE_APPROVAL_ERROR]: 대상 파일 "${relPath}" 이(가) 사용자 승인 이후 외부에서 수정되었습니다. 코드 충돌을 방지하기 위해 적용이 차단되었습니다. 수정안을 다시 검토해 주세요.`
        );
      }
    }

    // 1. Take safety checkpoint before applying
    this.captureCheckpoint(project.rootPath, `Before Applying Repair ${proposalId}`, 'core-gate');

    this.isApplyingApprovedPatch = true;
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
      const prepared = this.patchEngine.preparePatch(project.rootPath, fileChanges);
      this.patchEngine.writePatchToDisk(project.rootPath, prepared.appliedFiles);

      // 3. Update DB proposal status to APPLIED
      this.db.updateProposalApproval(proposalId, 'APPLIED');

      // 4. Mark incident as RESOLVED
      this.db.updateIncidentStatus(proposal.incidentId, 'RESOLVED');

      // 5. Take post-patch checkpoint
      this.captureCheckpoint(project.rootPath, `After Applying Repair: ${proposal.rootCauseAnalysis}`, 'core-gate');

      this.emitChange('proposal_applied', { proposalId, incidentId: proposal.incidentId });

      return {
        applied: true,
        touchedFiles: prepared.touchedFiles,
        diff: prepared.unifiedDiff,
      };
    } finally {
      this.isApplyingApprovedPatch = false;
    }
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
