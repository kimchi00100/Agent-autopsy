#!/usr/bin/env node
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoreManager, FileChange, NextAction } from '@agent-autopsy/core';

const coreManager = new CoreManager();

// Cross-process Real-Time Sync: Ping local running Agent Autopsy dashboard (dynamic port from runtime.json)
function notifyLocalServer(type: string, data?: any) {
  try {
    const targetPort = coreManager.getActivePort();
    const payload = JSON.stringify({ type, data });
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
        timeout: 600,
      },
      () => {}
    );
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

coreManager.subscribe((type, data) => {
  notifyLocalServer(type, data);
});

const server = new McpServer({
  name: 'agent-autopsy',
  version: '0.1.0',
});

// Helper: resolve default path
function resolvePath(p?: string): string {
  if (p && p.trim()) return p;
  try {
    const projects = coreManager.getDatabase().listProjects();
    if (projects.length > 0) {
      return projects[0].rootPath;
    }
  } catch {}
  return process.cwd();
}

/**
 * Tool 1: capture_checkpoint
 * Saves a non-destructive snapshot of the repository baseline.
 */
server.tool(
  'capture_checkpoint',
  'Captures a non-destructive baseline snapshot of the current workspace state (including uncommitted/dirty changes). Call this before starting non-trivial code modifications.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    label: z.string().optional().describe('Label or description for this checkpoint (e.g., "before auth refactor")'),
    agentName: z.string().optional().describe('에이전트 이름 (antigravity, claude-code, codex 등)'),
  },
  async ({ repoPath, label, agentName }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const cp = coreManager.captureCheckpoint(targetPath, label || 'Agent Baseline Checkpoint', agentName || 'mcp-agent');
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'PROCEED_TASK',
        agent_should: '체크포인트가 안전하게 저장되었습니다. 작업 또는 버그 조사를 계속 진행하세요.',
        forbidden: ['승인 없는 원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Checkpoint captured successfully: "${cp.label}"`,
                checkpoint: {
                  id: cp.id,
                  label: cp.label,
                  gitHeadSha: cp.gitHeadSha,
                  hasUncommittedChanges: cp.gitStashSha !== null,
                  changedFilesCount: cp.changedFiles.length,
                  changedFiles: cp.changedFiles,
                  createdAt: cp.createdAt,
                },
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'FIX_CHECKPOINT_ERROR',
                  agent_should: `체크포인트 캡처 오류(${error.message})를 확인하고 재시도하세요.`,
                  forbidden: ['승인 없는 원본 파일 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 2: inspect_project_state
 * Queries Git status, recent commits, latest checkpoint, and active incidents.
 */
server.tool(
  'inspect_project_state',
  'Inspects current project health: Git status, uncommitted changes, recent commits, latest checkpoint, and active incidents.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const health = coreManager.inspectProjectState(targetPath);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'CHECK_HEALTH',
        agent_should: '프로젝트 상태를 확인했습니다. 작업 전 체크포인트 생성 또는 사건 수집을 진행하세요.',
        forbidden: ['승인 없는 원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                projectName: health.projectName,
                rootPath: health.rootPath,
                isGitClean: health.isGitClean,
                currentHeadSha: health.currentHeadSha,
                uncommittedFilesCount: health.changedFiles.length,
                uncommittedFiles: health.changedFiles,
                latestCheckpoint: health.latestCheckpoint
                  ? {
                      id: health.latestCheckpoint.id,
                      label: health.latestCheckpoint.label,
                      createdAt: health.latestCheckpoint.createdAt,
                    }
                  : null,
                activeIncidentsCount: health.activeIncidentsCount,
                recentCommits: health.recentCommits,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'RETRY_INSPECT',
                  agent_should: '프로젝트 경로를 확인하고 다시 시도하세요.',
                  forbidden: ['승인 없는 원본 파일 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 3: collect_incident_bundle
 * Gathers error logs, git diff against checkpoint, expected vs observed behavior, and creates an incident record.
 */
server.tool(
  'collect_incident_bundle',
  'Gathers error logs, git diff since the last checkpoint, expected vs observed behavior, and creates a formal incident record for forensic analysis.',
  {
    title: z.string().describe('Short title of the incident (e.g. "VIP20 쿠폰 입력 시 ReferenceError 발생" or "저장 버튼 눌러도 목록에 즉시 미반영")'),
    userReportText: z.string().optional().describe('사용자가 쓴 신고 원문 그대로'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    errorOutput: z.string().optional().describe('Error message, stack trace, or test failure output'),
    expectedBehavior: z.string().optional().describe('사용자가 원래 기대했던 정상 동작 / 요구사항 설명'),
    observedBehavior: z.string().optional().describe('실제로 관찰된 오작동 증상 (빌드·타입은 정상이지만 기능이 의도와 다르게 작동하는 현상)'),
    brokenStep: z.string().optional().describe('실행 체인 중 의도와 달라진 구체적인 지점 (예: handleSave() 후 목록 상태 미갱신)'),
    reproductionCondition: z.string().optional().describe('재현 조건 (어떤 입력 및 환경에서 문제가 발생하는지)'),
    verificationMethod: z.string().optional().describe('기대 결과를 확인할 검증 수단이나 테스트'),
    verificationType: z.enum(['LOGIC_TEST', 'DATA_STATE', 'UI_FLOW', 'MANUAL_CHECK']).optional().describe('검증 유형'),
    userConfirmedIntent: z.boolean().optional().describe('사용자에게 4가지(기대동작, 관찰증상, 재현조건, 검증방법)를 되물어 명시적 확인을 받았는지 여부 (참고용)'),
    userConfirmationSummary: z.string().optional().describe('사용자가 확인해 준 내용 요약'),
    agentName: z.string().optional().describe('호출하는 에이전트 이름 (antigravity, claude-code, codex 등)'),
  },
  async ({
    title,
    userReportText,
    repoPath,
    errorOutput,
    expectedBehavior,
    observedBehavior,
    brokenStep,
    reproductionCondition,
    verificationMethod,
    verificationType,
    userConfirmedIntent,
    userConfirmationSummary,
    agentName,
  }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const effectiveAgent = agentName || 'mcp-agent';
      const incident = await coreManager.collectIncidentBundle(targetPath, {
        title,
        userReportText,
        errorOutput,
        severity: 'UNASSESSED',
        agentName: effectiveAgent,
        expectedBehavior,
        observedBehavior,
        brokenStep,
        reproductionCondition,
        verificationMethod,
        verificationType,
        userConfirmedIntent,
        userConfirmationSummary,
      });

      const next_action = coreManager.getIncidentNextAction(incident);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Incident created: "${incident.title}"`,
                incident: {
                  id: incident.id,
                  title: incident.title,
                  userReportText: incident.userReportText,
                  intents: incident.intents,
                  missingIntents: incident.missingIntents,
                  status: incident.status,
                  baseCheckpointId: incident.baseCheckpointId,
                  expectedBehavior: incident.expectedBehavior,
                  observedBehavior: incident.observedBehavior,
                  brokenStep: incident.brokenStep,
                  reproductionCondition: incident.reproductionCondition,
                  verificationMethod: incident.verificationMethod,
                  verificationType: incident.verificationType,
                  userConfirmedIntent: incident.userConfirmedIntent,
                  riskLevel: incident.riskLevel,
                  riskSignals: incident.riskSignals,
                  orchestrationDecision: incident.orchestrationDecision,
                  testExecutionNote: incident.testExecutionNote,
                  diffSummaryLength: incident.diffSummary.length,
                  diffSummary: incident.diffSummary.slice(0, 3000),
                  errorOutput: incident.errorOutput,
                  createdAt: incident.createdAt,
                },
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'HANDLE_INCIDENT_ERROR',
                  agent_should: `사건 번들 수집 오류(${error.message})를 확인하고 인자를 검토하세요.`,
                  forbidden: ['원인 자의적 짐작', '미승인 코드 수정', 'DB 직접 조작'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 3.5: propose_test_command
 * Proposes a project test command with reason for user confirmation in Agent Autopsy Desktop.
 */
server.tool(
  'propose_test_command',
  'AI 에이전트가 프로젝트에 적합한 테스트 명령을 제안합니다. 제안된 명령은 앱 대시보드에 확인 대기 상태로 등록되며, 사용자가 앱에서 확인해야 확정 및 서명됩니다.',
  {
    command: z.string().describe('제안할 테스트 실행 명령 (예: "pytest tests/", "python -m unittest discover -s tests", "npm test" 등)'),
    reason: z.string().describe('이 테스트 명령을 제안하는 사유'),
    repoPath: z.string().optional().describe('프로젝트 루트 경로 (기본값: 현재 디렉터리)'),
  },
  async ({ command, reason, repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const res = coreManager.proposeTestCommand(targetPath, command, reason);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `테스트 명령 "${command}"이(가) 제안되었습니다. 사용자가 앱 대시보드에서 확정할 때까지 대기합니다.`,
                project: {
                  id: res.project.id,
                  name: res.project.name,
                  proposedTestCommand: res.project.proposedTestCommand,
                  proposedTestCommandReason: res.project.proposedTestCommandReason,
                },
                next_action: res.next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: err.message,
                next_action: {
                  actor: 'USER',
                  action: 'CONFIRM_TEST_COMMAND_IN_APP',
                  agent_should: '사용자에게 앱 대시보드에서 테스트 명령을 직접 확인 및 설정해 달라고 요청하세요.',
                  forbidden: ['미승인 명령 임의 실행', '원본 파일 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 4: propose_and_verify_repair
 * Submits search & replace fixes, generates Unified Diff, tests in an isolated worktree, and records status.
 */
server.tool(
  'propose_and_verify_repair',
  'Submits a root cause analysis and a list of Search & Replace modifications. Agent Autopsy automatically tests the repair in an isolated Git worktree without touching real files, and returns the verification verdict.',
  {
    incidentId: z.string().describe('ID of the incident being repaired (from collect_incident_bundle)'),
    rootCauseAnalysis: z.string().describe('오류의 근본 원인과 해결 방안에 대한 상세한 한국어 분석 설명 (대시보드 사용자 승인 검토용)'),
    fileChanges: z
      .array(
        z.object({
          filePath: z.string().describe('Relative path to the file to modify'),
          replacements: z
            .array(
              z.object({
                search: z.string().describe('Exact code block to be replaced (including whitespace)'),
                replace: z.string().describe('Replacement code block'),
              })
            )
            .optional()
            .describe('Search & Replace blocks to apply to this file'),
          newContent: z.string().optional().describe('Full new content (if creating a new file or replacing completely)'),
        })
      )
      .describe('List of file modifications'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    agentName: z.string().optional().describe('에이전트 이름 (antigravity, claude-code, codex 등)'),
  },
  async ({ incidentId, rootCauseAnalysis, fileChanges, repoPath, agentName }) => {
    try {
      const targetPath = resolvePath(repoPath);
      coreManager.getDatabase().recordAgentHeartbeat(agentName || 'mcp-agent', undefined, `수정안 격리 검증: ${incidentId}`);
      const { proposal, executionResult } = await coreManager.proposeAndVerifyRepair(
        targetPath,
        incidentId,
        rootCauseAnalysis,
        fileChanges as FileChange[]
      );

      const isPass = proposal.verificationStatus === 'VERIFIED_PASS';

      let next_action: NextAction;
      if (!isPass) {
        next_action = {
          actor: 'AGENT',
          action: 'REVISE_REPAIR',
          agent_should: '격리 검증이 실패했습니다. testExecutionOutput을 분석하여 수정안을 개선한 뒤 propose_and_verify_repair를 재호출하세요 (최대 3회).',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '검증 생략'],
        };
      } else if (proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW') {
        next_action = {
          actor: 'SUBAGENT',
          action: 'REQUEST_ORCHESTRATION_REVIEW',
          agent_should: '격리 검증을 통과했으나 고위험 수정입니다. 독립 서브에이전트 검토를 실행한 후 submit_orchestration_review를 호출하세요.',
          note: '주의: 서브에이전트 검토 완료는 사용자 승인이 아니며, 최종 승인은 사용자만이 앱 대시보드에서 수행할 수 있습니다.',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '승인 API 호출'],
        };
      } else {
        next_action = {
          actor: 'USER',
          action: 'APPROVE_IN_APP',
          agent_should: '격리 검증을 통과했습니다. await_user_decision을 호출하거나 사용자에게 앱 대시보드(http://localhost:3847)에서 수정안을 승인해 달라고 안내하세요.',
          note: '주의: 사용자가 앱 대시보드에서 직접 승인 버튼을 누르기 전에는 원본 파일에 패치를 적용할 수 없습니다.',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '승인 API 호출'],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                proposalId: proposal.id,
                incidentId: proposal.incidentId,
                verificationStatus: proposal.verificationStatus,
                isolatedTestPassed: isPass,
                riskLevel: proposal.riskLevel,
                approvalReadiness: proposal.approvalReadiness,
                approvalBlockReason: proposal.approvalBlockReason,
                testExecutionOutput: executionResult.output,
                stages: executionResult.stages,
                threeLevelHealth: executionResult.threeLevelHealth,
                durationMs: executionResult.durationMs,
                touchedFiles: proposal.touchedFiles,
                patchDiff: proposal.patchDiff,
                guidance: !isPass
                  ? 'VERIFICATION FAILED in isolated worktree. The test failed. Please review testExecutionOutput, adjust your fix, and submit a revised propose_and_verify_repair call.'
                  : proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW'
                  ? 'VERIFICATION PASSED in isolated worktree, but HIGH RISK detected! In accordance with the Risk-Adaptive Evidence Gate, an independent subagent review is required before approval. Please run your subagent (or review task) and call submit_orchestration_review.'
                  : 'VERIFICATION PASSED in isolated worktree! The proposal is now registered and awaiting user approval in Agent Autopsy Desktop. The patch cannot be applied to the real workspace until approved by the user.',
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      if (error.code === 'BLOCKED_TEST_COMMAND_UNCONFIRMED' || error.message?.includes('BLOCKED_TEST_COMMAND_UNCONFIRMED')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  status: 'BLOCKED_TEST_COMMAND_UNCONFIRMED',
                  message: error.message,
                  next_action: error.next_action || {
                    actor: 'USER',
                    action: 'CONFIRM_TEST_COMMAND_IN_APP',
                    agent_should: '사용자에게 앱 대시보드에서 테스트 명령을 확인(확정)해 달라고 요청하거나 propose_test_command 도구로 명령을 제안하세요.',
                    forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '검증 생략'],
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'FIX_REPAIR_INPUT',
                  agent_should: `수정안 제출 오류(${error.message})를 확인하고 Search & Replace 블록을 점검하세요.`,
                  forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 5: apply_approved_repair
 * [HARD SECURITY GATE]: Applies an approved repair to the real workspace.
 */
server.tool(
  'apply_approved_repair',
  '[HARD SECURITY GATE] Applies an approved repair proposal to the actual workspace. Fails with a security violation if the proposal has not been explicitly approved by the user in Agent Autopsy Desktop.',
  {
    proposalId: z.string().describe('ID of the repair proposal to apply (must have been approved by user)'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ proposalId, repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const result = coreManager.applyApprovedRepair(targetPath, proposalId);
      const next_action: NextAction = {
        actor: 'USER',
        action: 'REVIEW_AND_COMMIT',
        agent_should: '승인된 수정안이 작업 트리에 안전하게 적용되었습니다. 변경 사항을 확인한 후 원하는 커밋 메시지로 직접 Git 커밋하세요.',
        forbidden: ['사용자 동의 없는 임의 원격 푸시', 'DB 직접 조작'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Approved repair applied successfully to the workspace.',
                touchedFiles: result.touchedFiles,
                diff: result.diff,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'USER',
                  action: 'APPROVE_IN_APP_FIRST',
                  agent_should: '사용자가 앱 대시보드에서 수정안을 먼저 승인해야 합니다. 사용자에게 승인을 요청하세요.',
                  forbidden: ['승인 우회 시도', '원본 파일 임의 수정', 'DB 직접 조작'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 6: rollback_to_checkpoint
 * Restores the workspace to an exact checkpoint state with zero data loss.
 */
server.tool(
  'rollback_to_checkpoint',
  'Restores the workspace to an exact checkpoint state. Takes an automatic safety backup of current dirty changes before restoring, guaranteeing zero data loss.',
  {
    checkpointId: z.string().describe('ID of the checkpoint to restore'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ checkpointId, repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const result = coreManager.rollbackToCheckpoint(targetPath, checkpointId);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'RESUME_AFTER_ROLLBACK',
        agent_should: '작업 트리가 이전 체크포인트 상태로 안전하게 롤백되었습니다. 새로운 작업 계획을 수립하세요.',
        forbidden: ['승인 없는 원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Workspace restored to checkpoint "${checkpointId}".`,
                backupRef: result.backupRef,
                backupStashSha: result.backupRef,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CHECK_CHECKPOINT_ID',
                  agent_should: `체크포인트 롤백 실패: ${error.message}. 체크포인트 ID를 확인하세요.`,
                  forbidden: ['강제 git reset --hard'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 7: record_agent_event
 * 에이전트가 수행한 활동(파일 읽기·수정·명령 실행·테스트 결과)을 AI 작업 타임라인에 기록한다.
 */
server.tool(
  'record_agent_event',
  'Records an action you performed (file read, edit, command run, test result) so it appears in the Agent Autopsy AI action timeline.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    kind: z.enum(['READ', 'EDIT', 'COMMAND', 'TEST_PASS', 'TEST_FAIL', 'NOTE']).describe('Type of action'),
    title: z.string().describe('Short description, e.g. "npm test 실행"'),
    detail: z.string().optional().describe('Command output or extra detail'),
    filePath: z.string().optional().describe('Related file path, if any'),
  },
  async ({ repoPath, kind, title, detail, filePath }) => {
    try {
      const ev = coreManager.recordAgentEvent(resolvePath(repoPath), kind, title, detail || '', filePath || null, 'mcp-agent');
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'CONTINUE_TASK',
        agent_should: '에이전트 이벤트가 타임라인에 기록되었습니다. 작업을 계속 진행하세요.',
        forbidden: ['승인 없는 원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, eventId: ev.id, next_action }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CONTINUE_TASK',
                  agent_should: '이벤트 기록 실패를 무시하고 작업을 계속하세요.',
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 8: submit_orchestration_review
 * Submits an independent review from a native host subagent or main agent proxy.
 */
server.tool(
  'submit_orchestration_review',
  'Submits an independent code review and counter-evidence analysis for a repair proposal. Agent Autopsy checks host execution artifacts (e.g. subagent task/transcript logs) to verify genuine subagent execution and unlock approval for high-risk patches.',
  {
    proposalId: z.string().describe('ID of the repair proposal being reviewed'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    reviewer: z.string().describe('Name or role of the reviewer (e.g., "Gemini 2.5 Pro subagent", "Opus security auditor")'),
    findings: z.array(z.string()).describe('List of key findings, edge case validations, or risk analyses'),
    counterEvidence: z.array(z.string()).optional().describe('Potential risks, edge case concerns, or counter-evidence found'),
    limitations: z.array(z.string()).optional().describe('Scope limitations of this review'),
    subagentTaskId: z.string().optional().describe('Subagent task ID or conversation ID from host environment'),
    transcriptPath: z.string().optional().describe('Path to host transcript or execution log file'),
    challengeToken: z.string().optional().describe('Cryptographic review challenge token issued for this proposal'),
    submittedByRole: z.enum(['SUBAGENT_DIRECT', 'MAIN_AGENT_PROXY']).optional().describe('Whether submitted directly by a subagent or proxied by main AI'),
  },
  async ({ proposalId, repoPath, reviewer, findings, counterEvidence, limitations, subagentTaskId, transcriptPath, challengeToken, submittedByRole }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const result = coreManager.submitOrchestrationReview(targetPath, {
        proposalId,
        reviewer,
        findings,
        counterEvidence,
        limitations,
        subagentTaskId,
        transcriptPath,
        challengeToken,
        submittedByRole,
      });

      const next_action: NextAction = {
        actor: 'USER',
        action: 'AWAIT_USER_APPROVAL',
        agent_should: '서브에이전트 독립 검토가 제출되었습니다. await_user_decision을 호출하거나 대시보드에서 사용자의 승인/피드백 결정을 기다리세요.',
        note: '중요: 서브에이전트 검토 완료는 사용자의 최종 승인이 아닙니다. 사용자가 앱 대시보드에서 승인해야만 패치를 적용할 수 있습니다.',
        forbidden: ['승인 간주 후 임의 패치 적용', '원본 파일 직접 수정', 'DB 직접 조작'],
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Orchestration review recorded with status: ${result.review.status}`,
                review: {
                  reviewId: result.review.reviewId,
                  status: result.review.status,
                  reviewer: result.review.reviewer,
                  hostTranscriptVerified: result.review.hostTranscriptVerified,
                  verificationNotes: result.review.verificationNotes,
                  findings: result.review.findings,
                  counterEvidence: result.review.counterEvidence,
                },
                proposal: {
                  id: result.proposal.id,
                  approvalReadiness: result.proposal.approvalReadiness,
                  approvalBlockReason: result.proposal.approvalBlockReason,
                },
                guidance:
                  result.proposal.approvalReadiness === 'READY_FOR_APPROVAL'
                    ? 'Proposal is now unlocked and ready for user approval in the Agent Autopsy Desktop UI.'
                    : `Proposal status is ${result.proposal.approvalReadiness}: ${result.proposal.approvalBlockReason}`,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'FIX_REVIEW_SUBMISSION',
                  agent_should: `검토 제출 실패(${error.message}). 제안 ID 및 챌린지 토큰을 확인하세요.`,
                  forbidden: ['승인 간주', '원본 파일 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 9: request_review_challenge
 * Generates an HMAC-SHA256 challenge token tying the review request to the specific proposal and patchHash.
 */
server.tool(
  'request_review_challenge',
  'Issues a single-use review challenge token bound to a specific proposal ID and patch hash to prevent replay and tie the subagent review to the exact proposal.',
  {
    proposalId: z.string().describe('ID of the repair proposal to request challenge for'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ proposalId, repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const challenge = coreManager.createReviewChallenge(targetPath, proposalId);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'RUN_SUBAGENT_REVIEW',
        agent_should: '발급된 챌린지 토큰을 포함하여 독립 서브에이전트에게 검토를 요청하세요.',
        forbidden: ['가짜 검토 제출', '승인 간주'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, challenge, next_action }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'RETRY_CHALLENGE',
                  agent_should: '제안 ID를 확인하고 다시 시도하세요.',
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 10: await_user_decision
 * Bounded long-poll for agent to await human decision (approval, rejection with feedback, or deep review) from dashboard.
 */
server.tool(
  'await_user_decision',
  'Blocks with a safe bounded timeout (default 90s, max 120s) awaiting human review from the Agent Autopsy dashboard. If the user decides within the timeout, returns the directive immediately. If timeout occurs, safely returns WAIT_TIMEOUT while directives remain queued.',
  {
    proposalId: z.string().describe('ID of the repair proposal awaiting user decision'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    timeoutSec: z.number().optional().describe('Timeout in seconds (default: 90, max: 120)'),
    agentName: z.string().optional().describe('에이전트 이름 (antigravity, claude-code 등)'),
  },
  async ({ proposalId, repoPath, timeoutSec, agentName }) => {
    try {
      const targetPath = resolvePath(repoPath);
      coreManager.getDatabase().recordAgentHeartbeat(agentName || 'agent', undefined, `사용자 승인 대기 중: ${proposalId}`);
      const result = await coreManager.awaitUserDecision(targetPath, proposalId, timeoutSec);

      let next_action: NextAction;
      if (result.status === 'DIRECTIVE_DELIVERED') {
        const isApprove = result.directive?.kind === 'APPROVE_AND_APPLY';
        next_action = {
          actor: 'AGENT',
          action: isApprove ? 'APPLY_REPAIR' : 'HANDLE_FEEDBACK',
          agent_should: isApprove
            ? '사용자가 수정을 승인했습니다. apply_approved_repair를 호출하여 패치를 적용하세요.'
            : '사용자 피드백을 반영하여 수정안을 개선하세요.',
          forbidden: ['승인되지 않은 파일 수정', 'DB 직접 조작'],
        };
      } else {
        next_action = {
          actor: 'USER',
          action: 'AWAIT_USER_DECISION',
          agent_should: '대시보드에서 사용자 결정을 대기 중입니다. 필요시 재대기하거나 사용자에게 안내하세요.',
          forbidden: ['승인 간주', '원본 파일 직접 수정'],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...result, next_action }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CHECK_PROPOSAL_STATE',
                  agent_should: `사용자 결정 대기 중 오류: ${error.message}`,
                  forbidden: ['승인 간주', '원본 파일 직접 수정'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 11: get_pending_directives
 * Retrieves queued directives from user/dashboard that haven't been acknowledged yet.
 */
server.tool(
  'get_pending_directives',
  'Retrieves pending user directives (such as feedback on rejected proposals, deep review requests, or intent confirmations) from the persistent queue.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    agentName: z.string().optional().describe('에이전트 이름 (antigravity, claude-code 등)'),
  },
  async ({ repoPath, agentName }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const directives = coreManager.getPendingDirectives(targetPath, agentName);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: directives.length > 0 ? 'ACKNOWLEDGE_DIRECTIVES' : 'PROCEED_TASK',
        agent_should:
          directives.length > 0
            ? '대기 중인 지침을 확인하고 acknowledge_directive로 확인한 뒤 작업을 진행하세요.'
            : '대기 중인 지침이 없습니다. 현재 작업을 계속하세요.',
        forbidden: ['사용자 지침 무시'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, count: directives.length, directives, next_action }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'RETRY_GET_DIRECTIVES',
                  agent_should: '지침 조회 오류를 확인하고 다시 시도하세요.',
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 12: acknowledge_directive
 * Confirms receipt of a directive and commits to taking action.
 */
server.tool(
  'acknowledge_directive',
  'Marks a directive as ACKNOWLEDGED, indicating the agent has received the user feedback/instruction and is actively working on it.',
  {
    directiveId: z.string().describe('ID of the directive to acknowledge'),
    agentName: z.string().optional().describe('에이전트 이름 (antigravity, claude-code 등)'),
  },
  async ({ directiveId, agentName }) => {
    try {
      const directive = coreManager.acknowledgeDirective(directiveId, agentName);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'EXECUTE_DIRECTIVE',
        agent_should: '지침 수신이 확인되었습니다. 요청된 수정 또는 분석 작업을 진행하세요.',
        forbidden: ['원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: `Directive ${directiveId} acknowledged`, directive, next_action }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CHECK_DIRECTIVE_ID',
                  agent_should: `지침 확인 실패: ${error.message}. 지침 ID를 확인하세요.`,
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 13: run_reproduction
 * Runs an agent-provided reproduction test file in an isolated worktree using the user-confirmed test runner
 * and records the execution evidence for an incident.
 */
server.tool(
  'run_reproduction',
  'Runs a reproduction test file created by the agent in an isolated worktree using the user-confirmed test runner to verify whether the incident is reproduced. Records the execution evidence ("REPRODUCED", "NOT_REPRODUCED", or "CANNOT_RUN") on the incident. Only relative file paths are accepted (arbitrary shell commands are rejected).',
  {
    incidentId: z.string().describe('ID of the incident to run reproduction for'),
    testFilePath: z.string().describe('Relative path to the reproduction test file in the repository (e.g. "tests/test_repro.py" or "test/repro.test.js"). Only file paths are allowed; tests are executed using the user-confirmed test runner.'),
    testCommandOrFile: z.string().optional().describe('Deprecated fallback: please provide testFilePath instead'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ incidentId, testFilePath, testCommandOrFile, repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const filePath = testFilePath || testCommandOrFile || '';
      const result = await coreManager.runReproduction(targetPath, incidentId, filePath);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'PROPOSE_REPAIR',
        agent_should: '재현 테스트 결과가 기록되었습니다. 원인을 분석하고 propose_and_verify_repair로 수정안을 제출하세요.',
        forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Reproduction test completed with status: ${result.status}`,
                reproduction: result,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'FIX_REPRODUCTION_INPUT',
                  agent_should: `재현 테스트 실행 오류: ${error.message}. 상대 파일 경로가 올바른지 확인하세요.`,
                  forbidden: ['원본 파일 직접 수정', '임의의 셸 명령 실행'],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 14: search_history
 * Searches past incidents, confirmed causes, and applied repairs.
 */
server.tool(
  'search_history',
  '과거 유사 사건, 확정된 원인, 적용된 수정 요약을 조회합니다. 결과는 컨텍스트 낭비를 방지하기 위해 최대 10개, 약 2KB 이내로 반환됩니다.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    files: z.array(z.string()).optional().describe('관련 파일 경로 목록으로 필터링'),
    keywords: z.array(z.string()).optional().describe('사건 제목 또는 오류 텍스트에 포함된 키워드 목록으로 필터링'),
  },
  async ({ repoPath, files, keywords }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const history = coreManager.searchHistory(targetPath, files, keywords);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'ANALYZE_HISTORY',
        agent_should: '과거 유사 사건 및 해결 기록을 참고하여 현재 버그 분석 및 수정안을 계획하세요.',
        forbidden: ['과거 수정 무단 덮어쓰기', '원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                count: history.length,
                history,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'RETRY_SEARCH_HISTORY',
                  agent_should: `과거 기록 검색 오류: ${error.message}`,
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 15: get_incident_attempts
 * Returns rejected or failed verification attempts for an incident.
 */
server.tool(
  'get_incident_attempts',
  '해당 사건에서 거절되거나 검증에 실패한 이전 수정안과 그 이유를 조회합니다 (최대 10개).',
  {
    incidentId: z.string().describe('조회할 사건(Incident) ID'),
  },
  async ({ incidentId }) => {
    try {
      const attempts = coreManager.getIncidentAttempts(incidentId);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'AVOID_REPEATED_MISTAKES',
        agent_should: '과거 실패/거절 사유를 분석하여 동일한 실수를 피하고 수정안을 다시 설계하세요.',
        forbidden: ['동일한 실패 수정안 반복 제출', '원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                incidentId,
                count: attempts.length,
                attempts,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CHECK_INCIDENT_ID',
                  agent_should: `실패/거절 시도 기록 조회 오류: ${error.message}`,
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

/**
 * Tool 16: get_changes_since_good_checkpoint
 * Returns summary of changes since last clean/good checkpoint.
 */
server.tool(
  'get_changes_since_good_checkpoint',
  '마지막 정상 시점(깨끗한 체크포인트) 이후 변경된 파일과 라인 수 요약을 반환합니다.',
  {
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
  },
  async ({ repoPath }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const changes = coreManager.getChangesSinceGoodCheckpoint(targetPath);
      const next_action: NextAction = {
        actor: 'AGENT',
        action: 'INSPECT_DIFF',
        agent_should: '마지막 정상 체크포인트 이후 변경된 파일과 줄 수를 분석하여 버그 유입 지점을 추적하세요.',
        forbidden: ['원본 파일 직접 수정'],
      };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                changes,
                next_action,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                next_action: {
                  actor: 'AGENT',
                  action: 'CHECK_REPO_PATH',
                  agent_should: `정상 시점 이후 변경 요약 조회 오류: ${error.message}`,
                  forbidden: [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }
);

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Agent Autopsy MCP server running on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`Fatal error running Agent Autopsy MCP server: ${error}\n`);
  process.exit(1);
});
