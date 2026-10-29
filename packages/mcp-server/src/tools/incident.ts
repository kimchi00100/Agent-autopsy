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
                },
                change_scope_summary: incident.changeScopeSummary,
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
    pre_flip_test_file_path: z.string().optional().describe('뒤집기 전 테스트 파일의 저장소 기준 상대 경로'),
    testCommandOrFile: z.string().optional().describe('Deprecated fallback: please provide testFilePath instead'),
    repoPath: z.string().optional().describe('Root path of the git repository (defaults to current directory)'),
    baseline_checkpoint_id: z.string().optional().describe('Optional baseline checkpoint ID to compare against'),
    replace_lock: z.boolean().optional().describe('기존 잠금이 있을 때 새 잠금으로 교체할지 여부 (기본값: false)'),
    replace_reason: z.string().optional().describe('잠금을 교체하는 구체적인 사유 (replace_lock이 true일 때 필요)'),
  },
  async ({
    incidentId,
    testFilePath,
    pre_flip_test_file_path,
    testCommandOrFile,
    repoPath,
    baseline_checkpoint_id,
    replace_lock,
    replace_reason,
  }) => {
    try {
      const targetPath = resolvePath(repoPath);
      const filePath = testFilePath || testCommandOrFile || '';
      const result = await coreManager.runReproduction(targetPath, incidentId, filePath, {
        baselineCheckpointId: baseline_checkpoint_id,
        preFlipTestFilePath: pre_flip_test_file_path,
        replace_lock,
        replace_reason,
      });
      let message = `Reproduction test completed with status: ${result.status}`;
      let next_action: NextAction;

      const verdict = result.baselineComparison?.verdict;
      const flipVerdict = result.assertFlip?.verdict;

      if (result.failureKind === 'FLAKY') {
        message = `Reproduction test completed with status: WRONG_FAILURE (FLAKY)`;
        next_action = {
          actor: 'AGENT',
          action: 'RUN_REPRODUCTION',
          agent_should: '결과가 실행마다 달라졌다. 시간, 난수, 실행 순서에 의존하지 않게 테스트를 고쳐라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (result.status === 'WRONG_FAILURE') {
        message = `Reproduction test completed with status: WRONG_FAILURE (${result.failureReason || result.failureKind})`;
        next_action = {
          actor: 'AGENT',
          action: 'RUN_REPRODUCTION',
          agent_should: '표준 단언문(assert, self.assertEqual, assert.strictEqual 등)으로 테스트를 고쳐 다시 실행하라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (result.status === 'UNVERIFIED_FAILURE') {
        message = '이 실행기는 아직 실패 이유를 판정하지 못한다. 재현으로 인정되지 않는다';
        next_action = {
          actor: 'AGENT',
          action: 'PROPOSE_REPAIR',
          agent_should: '이 실행기는 아직 실패 이유를 판정하지 못한다. 재현으로 인정되지 않는다',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (flipVerdict === 'PRE_FLIP_NOT_PASSING') {
        message = `Reproduction test completed with status: ${result.status} (PRE_FLIP_NOT_PASSING)`;
        next_action = {
          actor: 'AGENT',
          action: 'RUN_REPRODUCTION',
          agent_should: '뒤집기 전 테스트는 지금의 잘못된 값을 단언해서 현재 코드에서 통과해야 한다. 지금 실제로 나오는 값을 단언하도록 고쳐라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (flipVerdict === 'PRE_FLIP_FLAKY') {
        message = `Reproduction test completed with status: ${result.status} (PRE_FLIP_FLAKY)`;
        next_action = {
          actor: 'AGENT',
          action: 'RUN_REPRODUCTION',
          agent_should: '뒤집기 전 테스트 결과가 실행마다 달라졌다. 시간, 난수, 실행 순서에 의존하지 않게 고쳐라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (flipVerdict === 'FLIP_CHANGED_NON_ASSERTION') {
        message = `Reproduction test completed with status: ${result.status} (FLIP_CHANGED_NON_ASSERTION)`;
        next_action = {
          actor: 'AGENT',
          action: 'RUN_REPRODUCTION',
          agent_should: '두 테스트는 단언 줄만 달라야 한다. 준비 코드와 호출은 그대로 두고 기대값만 바꿔라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (verdict === 'PRE_EXISTING') {
        message = `Reproduction test completed with status: ${result.status} (PRE_EXISTING)`;
        next_action = {
          actor: 'AGENT',
          action: 'PROPOSE_REPAIR',
          agent_should: '정상 시점에서도 같은 단언 실패가 난다. 원래부터 있던 버그이거나 기대값이 틀렸을 수 있다. 사용자에게 기대값을 확인하거나 더 이전 체크포인트를 baseline_checkpoint_id로 지정하라',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (verdict === 'BASELINE_CANNOT_RUN') {
        message = `Reproduction test completed with status: ${result.status} (BASELINE_CANNOT_RUN)`;
        next_action = {
          actor: 'AGENT',
          action: 'PROPOSE_REPAIR',
          agent_should: '정상 시점에는 테스트 대상이 없거나 실행할 수 없다. 새로 추가된 코드의 버그일 수 있다',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else if (verdict === 'NO_BASELINE') {
        message = `Reproduction test completed with status: ${result.status} (정상 시점 비교 없이 판정됨)`;
        next_action = {
          actor: 'AGENT',
          action: 'PROPOSE_REPAIR',
          agent_should: '정상 시점 비교 없이 판정됨. 재현 테스트 결과가 기록되었습니다. 원인을 분석하고 propose_and_verify_repair로 수정안을 제출하세요.',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      } else {
        next_action = {
          actor: 'AGENT',
          action: 'PROPOSE_REPAIR',
          agent_should: '재현 테스트 결과가 기록되었습니다. 원인을 분석하고 propose_and_verify_repair로 수정안을 제출하세요.',
          forbidden: ['원본 파일 직접 수정', 'DB 직접 수정'],
        };
      }

      if (flipVerdict === 'NOT_PROVIDED') {
        next_action.agent_should += '\npre_flip_test_file_path를 주면 재현 근거가 강해진다';
      }
      if (result.next_action) {
        next_action = result.next_action;
      }
      if (result.lockWarning) {
        message += ` (경고: ${result.lockWarning})`;
      }
      const gate = coreManager.getReproductionGateState(incidentId);
      if (gate.state === 'ABANDONED') {
        next_action = {
          actor: 'USER',
          action: 'ABSTAIN_REPRODUCTION',
          agent_should: "재현 시도를 멈추고, 시도한 테스트와 실패 이유를 사용자에게 짧게 요약한 뒤, Agent Autopsy 앱에서 '재현 없이 진행' 또는 '시도 더 허락'을 결정해 달라고 요청한다.",
          forbidden: ['재현 없이 수정안 제출', 'DB 직접 수정', '감사 기록 수정', '재현 테스트를 다른 이름으로 다시 시도'],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message,
                gate: {
                  state: gate.state,
                  attempts_used: gate.attemptsUsed,
                  attempts_allowed: gate.attemptsAllowed,
                },
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
      if (error.code === 'REPRODUCTION_ABANDONED') {
        const gate = coreManager.getReproductionGateState(incidentId);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error.message,
                  code: error.code,
                  gate: {
                    state: gate.state,
                    attempts_used: gate.attemptsUsed,
                    attempts_allowed: gate.attemptsAllowed,
                  },
                  next_action: error.next_action || {
                    actor: 'USER',
                    action: 'ABSTAIN_REPRODUCTION',
                    agent_should: "재현 시도를 멈추고, 시도한 테스트와 실패 이유를 사용자에게 짧게 요약한 뒤, Agent Autopsy 앱에서 '재현 없이 진행' 또는 '시도 더 허락'을 결정해 달라고 요청한다.",
                    forbidden: ['재현 없이 수정안 제출', 'DB 직접 수정', '감사 기록 수정', '재현 테스트를 다른 이름으로 다시 시도'],
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
