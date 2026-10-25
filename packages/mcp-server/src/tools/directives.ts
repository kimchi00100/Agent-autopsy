import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerDirectivesTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
}
