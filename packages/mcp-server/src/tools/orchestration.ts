import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerOrchestrationTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
}
