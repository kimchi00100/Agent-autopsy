#!/usr/bin/env node
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CoreManager, FileChange } from '@agent-autopsy/core';

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
        content: [{ type: 'text', text: `Failed to capture checkpoint: ${error.message}` }],
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
        content: [{ type: 'text', text: `Failed to inspect project state: ${error.message}` }],
      };
    }
  }
);

/**
 * Tool 3: collect_incident_bundle
 * Gathers error logs, git diff against checkpoint, and creates an incident record.
 */
server.tool(
  'collect_incident_bundle',
  'Gathers error logs, git diff since the last checkpoint, expected vs observed behavior, and creates a formal incident record for forensic analysis.',
  {
    title: z.string().describe('Short title of the incident (e.g. "VIP20 쿠폰 입력 시 ReferenceError 발생" or "저장 버튼 눌러도 목록에 즉시 미반영")'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    errorOutput: z.string().optional().describe('Error message, stack trace, or test failure output'),
    expectedBehavior: z.string().optional().describe('사용자가 원래 기대했던 정상 동작 / 요구사항 설명'),
    observedBehavior: z.string().optional().describe('실제로 관찰된 오작동 증상 (빌드·타입은 정상이지만 기능이 의도와 다르게 작동하는 현상)'),
    brokenStep: z.string().optional().describe('실행 체인 중 의도와 달라진 구체적인 지점 (예: handleSave() 후 목록 상태 미갱신)'),
    reproductionCondition: z.string().optional().describe('재현 조건 (어떤 입력 및 환경에서 문제가 발생하는지)'),
    verificationMethod: z.string().optional().describe('기대 결과를 확인할 검증 수단이나 테스트'),
    verificationType: z.enum(['LOGIC_TEST', 'DATA_STATE', 'UI_FLOW', 'MANUAL_CHECK']).optional().describe('검증 유형'),
    userConfirmedIntent: z.boolean().optional().describe('사용자에게 4가지(기대동작, 관찰증상, 재현조건, 검증방법)를 되물어 명시적 확인을 받았는지 여부'),
    userConfirmationSummary: z.string().optional().describe('사용자가 확인해 준 내용 요약'),
    agentName: z.string().optional().describe('호출하는 에이전트 이름 (antigravity, claude-code, codex 등)'),
  },
  async ({
    title,
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
      // Intent Confirmation Gate:
      // 1) Automatic build/compile/syntax errors (errorOutput exists & no functional mismatch claims) -> proceed automatically!
      // 2) Functional/runtime bugs reported by user (expectedBehavior/observedBehavior present or no errorOutput) -> require chat confirmation!
      const isFunctionalRuntimeBug = Boolean(expectedBehavior || observedBehavior || !errorOutput);
      if (isFunctionalRuntimeBug && !userConfirmedIntent) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `[USER_INTENT_CONFIRMATION_REQUIRED]:
빌드/컴파일 에러가 아닌 '사용자 실행 중 기능 오작동(런타임 논리 버그)'입니다.
코드를 임의로 추측해서 고치지 말고, 현재 채팅창(Codex / Antigravity / Claude Code)에서 사용자에게 다음 4가지를 먼저 되물어 확인받으세요:
  1. 기대 정상 동작 (expectedBehavior): 원래 어떻게 동작해야 하는지 (예: 자동사냥 시 주변 몹을 탐색해 공격해야 함)
  2. 실제 오작동 증상 (observedBehavior): 실제로 어떤 현상이 나타나는지 (예: 자동사냥을 켜도 몹을 때리지 않고 가만히 있음)
  3. 재현 조건 (reproductionCondition): 어떤 상황/입력에서 발생하는지
  4. 검증 방법 (verificationMethod): 수정 후 어떻게 정상 작동을 확인할지
사용자가 채팅에서 확인해주면 userConfirmedIntent: true와 함께 collect_incident_bundle을 다시 호출하세요.`,
            },
          ],
        };
      }

      const targetPath = resolvePath(repoPath);
      const effectiveAgent = agentName || 'mcp-agent';
      const incident = coreManager.collectIncidentBundle(
        targetPath,
        title,
        errorOutput,
        'HIGH',
        effectiveAgent,
        undefined,
        expectedBehavior,
        observedBehavior,
        brokenStep,
        undefined,
        reproductionCondition,
        verificationMethod,
        verificationType,
        userConfirmedIntent,
        userConfirmationSummary
      );
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
                  status: incident.status,
                  baseCheckpointId: incident.baseCheckpointId,
                  expectedBehavior: incident.expectedBehavior,
                  observedBehavior: incident.observedBehavior,
                  brokenStep: incident.brokenStep,
                  verificationType: incident.verificationType,
                  userConfirmedIntent: incident.userConfirmedIntent,
                  riskLevel: incident.riskLevel,
                  riskSignals: incident.riskSignals,
                  orchestrationDecision: incident.orchestrationDecision,
                  diffSummaryLength: incident.diffSummary.length,
                  diffSummary: incident.diffSummary.slice(0, 3000), // Preview
                  errorOutput: incident.errorOutput,
                  createdAt: incident.createdAt,
                },
                nextStep:
                  'Analyze the execution path, run verification in isolated worktree, and call propose_and_verify_repair with your fix.',
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
        content: [{ type: 'text', text: `Failed to collect incident bundle: ${error.message}` }],
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
        content: [{ type: 'text', text: `Failed to propose and verify repair: ${error.message}` }],
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
        content: [{ type: 'text', text: error.message }],
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
        content: [{ type: 'text', text: `Failed to rollback to checkpoint: ${error.message}` }],
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
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, eventId: ev.id }) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Failed to record event: ${error.message}` }] };
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
        content: [{ type: 'text', text: `Failed to submit orchestration review: ${error.message}` }],
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, challenge }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to request review challenge: ${error.message}` }],
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to await user decision: ${error.message}` }],
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, count: directives.length, directives }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to get pending directives: ${error.message}` }],
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
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: `Directive ${directiveId} acknowledged`, directive }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Failed to acknowledge directive: ${error.message}` }],
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
