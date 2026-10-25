import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerIncidentTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
                  changeScopeSummary: incident.changeScopeSummary,
                  change_scope_summary: incident.change_scope_summary || incident.changeScopeSummary,
                },
                change_scope_summary: incident.change_scope_summary || incident.changeScopeSummary,
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
}
