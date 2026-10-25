import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from './context.js';
import { sendWindowsToast } from '../notifications/toast.js';
import { verifyTestCommandSignature } from '../utils/security.js';
import {
  Incident,
  ConfirmedIntentData,
  Severity,
  NextAction,
  IntentProvenance,
  IntentSource,
  StructuredIntents,
  HostEnvironment,
  ThreeLevelHealth,
  HealthLevelStatus,
  CauseVerdict,
  ChangeScopeSummary,
  ChangeScopeSummaryFunction,
} from '../types.js';
import { locateChangeScope } from '../localization/change-localizer.js';
import { analyzeIncident, IncidentAnalysis } from '../analysis/analyzer.js';
import { parseUnifiedDiffFiles, firstMeaningfulLine } from './helpers.js';

export async function collectIncidentBundle(ctx: CoreContext, 
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
    const project = ctx.ensureProject(repoPath);
    const latestCheckpoint = ctx.db.getLatestCheckpoint(project.id);
    ctx.db.recordAgentHeartbeat(agentName, sessionId, '사건 번들 수집');

    // Calculate diff against latest checkpoint or HEAD
    let diffSummary = '';
    try {
      if (latestCheckpoint && latestCheckpoint.gitHeadSha) {
        diffSummary = ctx.gitEngine.getDiff(project.rootPath, latestCheckpoint.gitHeadSha);
      } else {
        diffSummary = ctx.gitEngine.getDiff(project.rootPath);
      }
    } catch {
      diffSummary = '';
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
          const wt = ctx.worktreeRunner.createWorktree(
            project.rootPath,
            sandboxId,
            'HEAD',
            [],
            project.testCommand!
          );
          sandboxDir = wt.sandboxDir;
          const testRes = await ctx.worktreeRunner.runCommand(
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
            ctx.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
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
    const decision = ctx.evaluateOrchestrationDecision(
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

    ctx.db.insertIncident(incident);

    let changeScopeSummary: ChangeScopeSummary | string;
    try {
      const scopeResult = await locateChangeScope(ctx, {
        incidentId: incident.id,
        repoPath: project.rootPath,
      });

      const hasFailureWarning =
        scopeResult.warnings &&
        scopeResult.warnings.some(
          (w) =>
            w.includes('실패') ||
            w.includes('Not a git repository') ||
            w.includes('not a git repository') ||
            w.includes('확인할 수 없습니다')
        );

      if (hasFailureWarning && scopeResult.changedFunctions.length === 0 && scopeResult.totalChangedFiles === 0) {
        changeScopeSummary = `경고: 변경 범위 계산 실패 (${scopeResult.warnings.join('; ')})`;
      } else {
        const maxLimit = 30;
        const totalCount = scopeResult.changedFunctions.length;
        const isTruncated = totalCount > maxLimit;
        const sliced = scopeResult.changedFunctions.slice(0, maxLimit);

        const changedFunctions: ChangeScopeSummaryFunction[] = sliced.map((fn) => ({
          filePath: fn.filePath,
          name: fn.name,
          startLine: fn.startLine,
          endLine: fn.endLine,
          kind: fn.kind,
        }));

        const warnings = [...scopeResult.warnings];
        let notice: string | undefined;
        if (isTruncated) {
          const remaining = totalCount - maxLimit;
          notice = `나머지 ${remaining}개는 get_change_scope로 확인`;
          warnings.push(notice);
        }

        changeScopeSummary = {
          baselineSha: scopeResult.baselineSha,
          baselineRule: scopeResult.baselineRule,
          changedFunctions,
          neighborFunctionCount: scopeResult.neighborFunctions.length,
          scopeStats: scopeResult.scopeStats,
          warnings,
          ...(notice ? { notice } : {}),
        };
      }
    } catch (err: any) {
      changeScopeSummary = `경고: 변경 범위 계산 실패 (${err?.message || String(err)})`;
    }

    incident.changeScopeSummary = changeScopeSummary;
    incident.change_scope_summary = changeScopeSummary;
    try {
      ctx.db.updateIncidentChangeScopeSummary(incident.id, changeScopeSummary);
    } catch {}
    ctx.emitChange('incident_created', incident);
    return incident;
  }

  /**
   * Risk-Adaptive Evidence Gate: Evaluates task difficulty & risk to issue an OrchestrationDecision
   * Judged strictly by what the patch changes: sensitivePaths glob, changed lines threshold, verification retries.
   * File count or UNKNOWN cause does NOT escalate risk.
   */

  export function analyzeIncidentCauses(ctx: CoreContext, incidentId: string): { incident: Incident; analysis: IncidentAnalysis } {
    const incident = ctx.db.getIncident(incidentId);
    if (!incident) throw new Error(`Incident with ID "${incidentId}" not found.`);
    const project = ctx.db.getProject(incident.projectId);
    const health = project ? ctx.inspectProjectState(project.rootPath) : null;

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

  export function getIncidentNextAction(incident: Incident): NextAction {
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
      agent_should:
        '네 가지 의도가 모두 확인되었습니다. 먼저 get_change_scope로 기준 시점 이후 바뀐 함수의 코드를 확인하고 사용자 원문과 비교하세요. 그 다음 run_reproduction으로 재현 테스트를 실행하거나 propose_and_verify_repair로 격리 검증을 진행하세요. 저장소 전체를 처음부터 읽지 마세요.',
      forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
    };
  }
