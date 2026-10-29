import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, FileChange, NextAction } from '@agent-autopsy/core';

export function registerRepairTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
      const knownRejectionCodes = [
        'BLOCKED_TEST_COMMAND_UNCONFIRMED',
        'REPAIR_MODIFIES_LOCKED_TEST',
        'LOCKED_TEST_MODIFIED',
        'LOCK_SIGNATURE_INVALID',
        'LOCK_REMOVED',
      ];
      const matchedCode = knownRejectionCodes.find(
        (c) => error.code === c || (error.message && error.message.includes(c))
      );
      if (matchedCode) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  status: matchedCode,
                  code: matchedCode,
                  message: error.message,
                  next_action: error.next_action || {
                    actor: 'AGENT',
                    action: 'FIX_REPAIR',
                    agent_should: `수정안 제출 거부 (${matchedCode}): ${error.message}`,
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
}
