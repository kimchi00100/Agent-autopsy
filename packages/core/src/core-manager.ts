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
    let title: string;
    let finalSeverity: Severity = 'UNASSESSED';
    let severityEvidence: string[] = [];

    if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
      title = titleOrOptions.title;
      errorOutput = titleOrOptions.errorOutput;
      if (titleOrOptions.severity) {
        finalSeverity = titleOrOptions.severity;
        severityEvidence = [`사용자 명시적 신고 등급: ${finalSeverity}`];
      } else {
        finalSeverity = 'UNASSESSED';
        severityEvidence = ['사용자 미지정: 기본 미판정 (UNASSESSED)'];
      }
      agentName = titleOrOptions.agentName || 'agent';
      sessionId = titleOrOptions.sessionId;
      expectedBehavior = titleOrOptions.expectedBehavior;
      observedBehavior = titleOrOptions.observedBehavior;
      brokenStep = titleOrOptions.brokenStep;
      executionTrace = titleOrOptions.executionTrace;
      reproductionCondition = titleOrOptions.reproductionCondition;
      verificationMethod = titleOrOptions.verificationMethod;
      verificationType = titleOrOptions.verificationType;
      userConfirmedIntent = titleOrOptions.userConfirmedIntent;
      userConfirmationSummary = titleOrOptions.userConfirmationSummary;
    } else {
      title = titleOrOptions;
      if (severity && severity !== 'UNASSESSED') {
        finalSeverity = severity;
        severityEvidence = [`사용자 명시적 신고 등급: ${finalSeverity}`];
      } else {
        finalSeverity = 'UNASSESSED';
        severityEvidence = ['사용자 미지정: 기본 미판정 (UNASSESSED)'];
      }
    }

    let effectiveUserReportText: string | undefined;
    if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
      effectiveUserReportText = titleOrOptions.userReportText ? titleOrOptions.userReportText.trim() : undefined;
    } else {
      effectiveUserReportText = userReportText ? userReportText.trim() : undefined;
    }
    const userReportTextFinal = effectiveUserReportText || '없음';

    const findExactSubstringQuote = (sourceText: string, searchVal: string): string | null => {
      const cleanSource = (sourceText || '').trim();
      const cleanSearch = (searchVal || '').trim();
      if (!cleanSource || !cleanSearch || cleanSource === '없음') return null;

      // 1. Direct case-insensitive contiguous substring
      const lowerSource = cleanSource.toLowerCase();
      const lowerSearch = cleanSearch.toLowerCase();
      const directIdx = lowerSource.indexOf(lowerSearch);
      if (directIdx !== -1) {
        return cleanSource.slice(directIdx, directIdx + cleanSearch.length);
      }

      // 2. Whitespace-normalized contiguous substring (collapses newlines/multiple spaces)
      const normSource = cleanSource.replace(/\s+/g, ' ');
      const normSearch = cleanSearch.replace(/\s+/g, ' ');
      const normIdx = normSource.toLowerCase().indexOf(normSearch.toLowerCase());
      if (normIdx !== -1) {
        return normSource.slice(normIdx, normIdx + normSearch.length);
      }

      return null;
    };

    const evaluateIntent = (val?: string): IntentProvenance => {
      const cleanVal = (val || '').trim();
      if (!cleanVal) {
        return { value: '', source: 'MISSING' };
      }
      if (!effectiveUserReportText || effectiveUserReportText === '없음') {
        return { value: cleanVal, source: 'AI_INFERRED' };
      }
      const matchedQuote = findExactSubstringQuote(userReportTextFinal, cleanVal);
      if (matchedQuote) {
        return { value: cleanVal, source: 'USER_QUOTE', quote: matchedQuote };
      }
      return { value: cleanVal, source: 'AI_INFERRED' };
    };

    const intents: StructuredIntents = {
      expectedBehavior: evaluateIntent(expectedBehavior),
      observedBehavior: evaluateIntent(observedBehavior),
      reproductionCondition: evaluateIntent(reproductionCondition),
      verificationMethod: evaluateIntent(verificationMethod),
    };

    const missingIntents: Array<'expectedBehavior' | 'observedBehavior' | 'reproductionCondition' | 'verificationMethod'> = [];
    if (intents.expectedBehavior.source === 'MISSING') missingIntents.push('expectedBehavior');
    if (intents.observedBehavior.source === 'MISSING') missingIntents.push('observedBehavior');
    if (intents.reproductionCondition.source === 'MISSING') missingIntents.push('reproductionCondition');
    if (intents.verificationMethod.source === 'MISSING') missingIntents.push('verificationMethod');

    const effectiveConfirmedIntent = missingIntents.length === 0;
    const project = this.ensureProject(repoPath);
    const latestCheckpoint = this.db.getLatestCheckpoint(project.id);
    this.db.recordAgentHeartbeat(agentName, sessionId, '사건 번들 수집');

    // Calculate diff against latest checkpoint or HEAD
    let diffSummary = '';
    if (latestCheckpoint && latestCheckpoint.gitHeadSha) {
      diffSummary = this.gitEngine.getDiff(project.rootPath, latestCheckpoint.gitHeadSha);
    } else {
      diffSummary = this.gitEngine.getDiff(project.rootPath);
    }

    let finalErrorOutput = errorOutput || '';
    let testExecutionNote: string | undefined;

    if (!finalErrorOutput) {
      const isSigned =
        Boolean(project.testCommand) &&
        Boolean(project.testCommandSignature) &&
        verifyTestCommandSignature(project.id, project.testCommand!, project.testCommandSignature!);

      if (!isSigned) {
        testExecutionNote = '테스트 실행 불가: 확정된 테스트 명령 없음';
      } else {
        // Run test command in an isolated worktree asynchronously
        const sandboxId = `inc_bundle_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        let sandboxDir: string | undefined;
        try {
          const wt = this.worktreeRunner.createWorktree(
            project.rootPath,
            sandboxId,
            'HEAD',
            [],
            project.testCommand!
          );
          sandboxDir = wt.sandboxDir;
          const testRes = await this.worktreeRunner.runCommand(
            sandboxDir,
            project.testCommand!,
            30000
          );
          if (!testRes.success) {
            if (
              testRes.exitCode === 127 ||
              /is not recognized as an internal or external command|command not found/i.test(testRes.output)
            ) {
              testExecutionNote = '테스트 실행 불가: 명령 실행 실패';
            } else {
              finalErrorOutput = testRes.output;
            }
          }
        } catch (err: any) {
          testExecutionNote = `테스트 실행 불가: ${err.message}`;
        } finally {
          if (sandboxDir) {
            this.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
          }
        }
      }
    }

    const changedFiles = parseUnifiedDiffFiles(diffSummary);
    const hasErrorOutput = Boolean(finalErrorOutput && finalErrorOutput.trim());
    const codeHealth: HealthLevelStatus = hasErrorOutput ? 'FAIL' : 'PASS';
    const threeLevelHealth: ThreeLevelHealth = {
      code: codeHealth,
      functional: 'FAIL',
      requirement: 'FAIL',
      details: {
        codeSummary: codeHealth === 'PASS' ? '빌드 및 타입 검사 정상' : '오류 출력 감지됨 (원인 추정 단계)',
        functionalSummary: '사용자 의도와 실제 동작 불일치',
        requirementSummary: '최종 요구사항 미충족',
      },
    };

    // 2단계: 오류 출력에 SyntaxError/TypeError가 있다고 CONFIRMED로 올리지 않음.
    // 확신도는 3단계 실행 증거(재현 테스트, 실행 경로 등)로만 올림. 기본값은 UNKNOWN.
    const causeVerdict: CauseVerdict = 'UNKNOWN';
    const causeEvidence: string[] = [];
    if (hasErrorOutput) {
      causeEvidence.push('테스트/런타임 오류 출력 감지 (원인 추정 단계)');
      causeEvidence.push('실행 증거(재현 테스트, 실행 경로 등) 미확보로 원인 확신도 미확정(UNKNOWN) 유지');
    } else {
      causeEvidence.push('오류 출력 없음: 사용자 보고 증상 기반 분석 대기');
      causeEvidence.push('원인 불명은 위험 신호가 아니며, 재현 테스트 작성 및 증거 수집 필요');
    }

    // Risk-Adaptive Evidence Gate evaluation
    const decision = this.evaluateOrchestrationDecision(
      project,
      title,
      finalErrorOutput,
      diffSummary,
      changedFiles,
      causeVerdict,
      threeLevelHealth,
      0
    );

    const id = `inc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const incident: Incident = {
      id,
      projectId: project.id,
      baseCheckpointId: latestCheckpoint ? latestCheckpoint.id : null,
      title,
      userReportText: userReportTextFinal,
      intents,
      missingIntents,
      errorOutput: finalErrorOutput || testExecutionNote || '오류 출력이 기록되지 않았습니다.',
      diffSummary: diffSummary || '변경된 Git diff가 감지되지 않았습니다.',
      status: 'OPEN',
      severity: finalSeverity,
      severityEvidence,
      causeEvidence,
      agentName,
      sessionId,
      expectedBehavior,
      observedBehavior,
      brokenStep,
      executionTrace,
      reproductionCondition,
      verificationMethod,
      verificationType,
      userConfirmedIntent: Boolean(effectiveConfirmedIntent),
      userConfirmationSummary,
      causeVerdict,
      threeLevelHealth,
      riskLevel: decision.riskLevel,
      riskSignals: decision.riskSignals,
      orchestrationDecision: decision,
      testExecutionNote,
      createdAt: new Date().toISOString(),
    };

    this.db.insertIncident(incident);
    this.emitChange('incident_created', incident);
    return incident;
  }

  /**
   * Risk-Adaptive Evidence Gate: Evaluates task difficulty & risk to issue an OrchestrationDecision
   * Judged strictly by what the patch changes: sensitivePaths glob, changed lines threshold, verification retries.
   * File count or UNKNOWN cause does NOT escalate risk.
   */
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
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(proposalId);
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
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(params.proposalId);
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

    this.db.updateProposalOrchestrationReview(proposal.id, review, approvalReadiness, blockReason);
    const updated = this.db.getRepairProposal(proposal.id)!;
    this.emitChange('proposal_reviewed', { proposal: updated, review });
    return { review, proposal: updated };
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
    const project = this.ensureProject(repoPath);
    const ev: AgentEvent = {
      id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      projectId: project.id,
      agentName,
      sessionId,
      kind,
      title,
      detail,
      filePath,
      createdAt: new Date().toISOString(),
    };
    this.db.insertAgentEvent(ev);
    this.emitChange('event_recorded', ev);
    return ev;
  }

  /**
   * Project Dashboard Overview
   */
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
    const incident = this.db.getIncident(incidentId);
    if (!incident) throw new Error(`Incident with ID "${incidentId}" not found.`);
    const project = this.db.getProject(incident.projectId);
    const health = project ? this.inspectProjectState(project.rootPath) : null;

    const analysis = analyzeIncident(
      incident.errorOutput,
      incident.diffSummary,
      project?.rootPath,
      project?.name || 'project',
      health?.currentHeadSha || 'HEAD',
      incident
    );
    return { incident, analysis };
  }

  /**
   * Runs an agent-provided reproduction test file in an isolated worktree
   * using the user-confirmed test runner, and records execution evidence.
   *
   * Security & Integrity rules:
   * 1. Only test file paths are accepted (arbitrary shell commands are rejected).
   * 2. Execution only proceeds if the project has a cryptographically signed, user-confirmed test runner.
   *    If no confirmed runner exists, returns status: 'CANNOT_RUN'.
   * 3. The test file must exist in the host repository.
   */
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
    if (!incident.userReportText || !incident.userReportText.trim() || incident.userReportText === '없음') {
      return {
        actor: 'USER',
        action: 'PROVIDE_USER_REPORT',
        agent_should: '사용자가 직접 작성한 신고 원문(userReportText)이 누락되었습니다. 사용자에게 발생한 문제 상황을 직접 설명해 달라고 요청하여 원문을 확인한 뒤 userReportText와 함께 다시 보내세요.',
        forbidden: ['에이전트 임의 원문 날조', '원인 자의적 짐작', '미승인 코드 수정', 'DB 직접 조작'],
      };
    }

    if (incident.missingIntents && incident.missingIntents.length > 0) {
      const missingLabels = incident.missingIntents.map((k) => {
        if (k === 'expectedBehavior') return '기대 동작(expectedBehavior)';
        if (k === 'observedBehavior') return '실제 관찰 증상(observedBehavior)';
        if (k === 'reproductionCondition') return '재현 조건(reproductionCondition)';
        if (k === 'verificationMethod') return '검증 수단(verificationMethod)';
        return k;
      });
      return {
        actor: 'USER',
        action: 'CLARIFY_INTENT',
        agent_should: `사용자에게 누락된 필수 의도 항목(${missingLabels.join(', ')})에 대해 채팅창에서 구체적으로 되물어 확인하세요.`,
        missing_fields: incident.missingIntents,
        forbidden: ['원인 자의적 짐작', '미승인 코드 수정', 'DB 직접 조작'],
      };
    }
    return {
      actor: 'AGENT',
      action: 'RUN_REPRODUCTION_OR_PROPOSE_REPAIR',
      agent_should: '네 가지 의도가 모두 확인되었습니다. run_reproduction으로 재현 테스트를 실행하거나 propose_and_verify_repair로 격리 검증을 진행하세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
  }

  /**
   * 4-A. searchHistory: Searches past incidents, confirmed causes, and applied repairs.
   * Concise summary limited to at most 10 items (payload < 2KB).
   */
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
    return this.db.listAgentSessions();
  }

  /**
   * Creates a user directive from dashboard or workflow and attempts live delivery to waiting agent,
   * otherwise enqueues for next-call delivery or manual copy-prompt.
   */
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
    const project = this.ensureProject(repoPath);
    const directiveId = `dir_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    // Check if there is an active waiter waiting on this proposal or repoPath
    let activeWaiterKey: string | null = null;
    let waiterObj: { resolve: (val: any) => void; timer: NodeJS.Timeout; proposalId: string; repoPath: string } | null = null;

    if (params.proposalId) {
      const key = `${repoPath}:${params.proposalId}`;
      if (this.activeWaiters.has(key)) {
        activeWaiterKey = key;
        waiterObj = this.activeWaiters.get(key)!;
      }
    }
    if (!waiterObj) {
      for (const [k, v] of this.activeWaiters.entries()) {
        if (v.repoPath === repoPath) {
          activeWaiterKey = k;
          waiterObj = v;
          break;
        }
      }
    }

    let deliveryStatus: DirectiveDeliveryStatus = 'WAITING_AGENT';
    let deliveredAt: string | undefined = undefined;
    const resumeMethod: 'HOST_AUTO' | 'MANUAL_COPY_PROMPT' = 'MANUAL_COPY_PROMPT';

    // Clear, actionable Korean instruction snippet for user copy-paste if agent isn't live-waiting
    let manualPromptSnippet = '';
    switch (params.kind) {
      case 'REJECT_WITH_FEEDBACK':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}을 거절했습니다.\n피드백 사유: "${params.feedbackText || '추가 수정 필요'}"\n사유를 분석하여 격리 Worktree에서 3단계 검증을 통과하는 새로운 수정안을 제출하세요.`;
        break;
      case 'REQUEST_DEEP_REVIEW':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}에 대해 서브에이전트 심층 검토를 요청했습니다.\n네이티브 서브에이전트(Model='inherit')를 호출하여 독립 검증을 수행하고 submit_orchestration_review 도구로 증거를 제출하세요.`;
        break;
      case 'CONFIRM_INTENT':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 기능 의도를 확정했습니다.\n기대 동작: ${params.confirmedIntent?.expectedBehavior || '-'}\n실제 동작: ${params.confirmedIntent?.observedBehavior || '-'}\n재현 조건: ${params.confirmedIntent?.reproductionCondition || '-'}\n검증 수단: ${params.confirmedIntent?.verificationMethod || '-'}\n이 의도에 맞춰 사건을 분석하고 격리 검증을 수행하세요.`;
        break;
      case 'APPROVE_AND_APPLY':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 대시보드에서 수정안 #${params.proposalId?.slice(-6) || ''} 승인 및 적용을 확인했습니다.`;
        break;
    }

    if (waiterObj && activeWaiterKey) {
      deliveryStatus = 'DELIVERED_LIVE';
      deliveredAt = now;
      clearTimeout(waiterObj.timer);
      this.activeWaiters.delete(activeWaiterKey);
    }

    const directive: AgentDirective = {
      id: directiveId,
      projectId: project.id,
      incidentId: params.incidentId,
      proposalId: params.proposalId,
      patchHash: params.patchHash,
      kind: params.kind,
      feedbackText: params.feedbackText,
      confirmedIntent: params.confirmedIntent,
      deliveryStatus,
      resumeMethod,
      manualPromptSnippet,
      createdAt: now,
      deliveredAt,
    };

    this.db.insertDirective(directive);

    // If active waiter was waiting, resolve it immediately with the delivered directive
    if (waiterObj) {
      waiterObj.resolve({
        status: 'DIRECTIVE_DELIVERED',
        directive,
      });
    }

    // Side effects on incident / proposal
    if (params.kind === 'CONFIRM_INTENT' && params.incidentId && params.confirmedIntent) {
      const summary = `사용자 직접 확정: 기대="${params.confirmedIntent.expectedBehavior || ''}" / 실제="${params.confirmedIntent.observedBehavior || ''}"`;
      this.db.updateIncidentIntent(params.incidentId, params.confirmedIntent, true, summary);
    }
    if (params.kind === 'REJECT_WITH_FEEDBACK' && params.proposalId) {
      try {
        this.rejectProposal(params.proposalId);
      } catch {
        // Ignored if already rejected
      }
    }

    this.recordAgentEvent(
      repoPath,
      'COMMAND',
      `대시보드 지시 발행: ${params.kind}`,
      `전달 상태: ${deliveryStatus}${params.feedbackText ? ` | 피드백: ${params.feedbackText}` : ''}`,
      null,
      'dashboard'
    );

    this.emitChange('directive_created', { directive });
    if (deliveryStatus === 'DELIVERED_LIVE') {
      this.emitChange('directive_delivered', { directive });
    }

    return directive;
  }

  /**
   * Bounded long-poll for agent to await human decision on a repair proposal.
   * Max 120s timeout window ensures agent hosts (with 3-minute hard kill limits) never crash.
   */
  public async awaitUserDecision(
    repoPath: string,
    proposalId: string,
    timeoutSec: number = 90
  ): Promise<{
    status: 'DIRECTIVE_DELIVERED' | 'WAIT_TIMEOUT';
    directive?: AgentDirective;
    message?: string;
  }> {
    const project = this.ensureProject(repoPath);
    const boundedSec = Math.min(Math.max(timeoutSec || 90, 5), 120);

    // 1. Check if there is already a pending directive waiting for agent
    const pending = this.db.listPendingDirectives(project.id);
    const matching = pending.find((d) => d.proposalId === proposalId || d.deliveryStatus === 'WAITING_AGENT');
    if (matching) {
      const now = new Date().toISOString();
      this.db.updateDirectiveStatus(matching.id, 'DELIVERED_LIVE', { deliveredAt: now });
      matching.deliveryStatus = 'DELIVERED_LIVE';
      matching.deliveredAt = now;
      this.emitChange('directive_delivered', { directive: matching });
      return {
        status: 'DIRECTIVE_DELIVERED',
        directive: matching,
      };
    }

    // 2. Otherwise register bounded long-poll waiter
    return new Promise((resolve) => {
      const waiterKey = `${repoPath}:${proposalId}`;
      const timer = setTimeout(() => {
        this.activeWaiters.delete(waiterKey);
        resolve({
          status: 'WAIT_TIMEOUT',
          message: `대기 시간(${boundedSec}초)이 경과했습니다. 에이전트 호스트 타임아웃 방지를 위해 안전하게 대기를 종료합니다. 사용자가 대시보드에서 결정을 내리면 영속 Directive Queue에 보존되며 다음 도구 호출 시 전달되거나 수동 재개 프롬프트가 대시보드에 표시됩니다.`,
        });
      }, boundedSec * 1000);

      this.activeWaiters.set(waiterKey, {
        resolve,
        timer,
        proposalId,
        repoPath,
      });
    });
  }

  /**
   * Retrieve pending directives for an agent and mark WAITING_AGENT ones as DELIVERED_ON_NEXT_CALL.
   */
  public getPendingDirectives(repoPath: string, agentName: string = 'agent'): AgentDirective[] {
    const project = this.ensureProject(repoPath);
    const pending = this.db.listPendingDirectives(project.id);
    const now = new Date().toISOString();

    for (const d of pending) {
      if (d.deliveryStatus === 'WAITING_AGENT') {
        this.db.updateDirectiveStatus(d.id, 'DELIVERED_ON_NEXT_CALL', { deliveredAt: now });
        d.deliveryStatus = 'DELIVERED_ON_NEXT_CALL';
        d.deliveredAt = now;
        this.emitChange('directive_delivered', { directive: d });
      }
    }

    return pending;
  }

  /**
   * Agent acknowledges receipt of a directive and commits to taking action.
   */
  public acknowledgeDirective(directiveId: string, agentName: string = 'agent'): AgentDirective {
    const directive = this.db.getDirective(directiveId);
    if (!directive) {
      throw new Error(`Directive "${directiveId}" not found.`);
    }

    const now = new Date().toISOString();
    this.db.updateDirectiveStatus(directiveId, 'ACKNOWLEDGED', { acknowledgedAt: now });
    directive.deliveryStatus = 'ACKNOWLEDGED';
    directive.acknowledgedAt = now;

    const project = this.db.getProject(directive.projectId);
    if (project) {
      this.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `지시 수신 확인: ${directive.kind}`,
        `에이전트가 지시(ID: ${directive.id})를 확인하고 후속 작업을 착수했습니다.`,
        null,
        agentName
      );
    }

    this.emitChange('directive_acknowledged', { directive });
    return directive;
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
