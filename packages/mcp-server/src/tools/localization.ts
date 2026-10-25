import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerLocalizationTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
  server.tool(
    'get_change_scope',
    '기준 시점 이후 변경된 함수 전체와 1단계 호출/피호출 이웃 함수 범위를 조회하고, 변경 줄 표시가 포함된 AI 전달 패키지를 생성합니다. 순위나 원인 확정이 아니며 조사 범위를 좁히는 용도입니다.',
    {
      incident_id: z.string().describe('사건 ID (필수)'),
      baseline_checkpoint_id: z.string().optional().describe('직접 지정할 기준 체크포인트 ID (선택, 자동 확장 미적용)'),
    },
    async ({ incident_id, baseline_checkpoint_id }) => {
      try {
        const pkg = await coreManager.getChangeScope(incident_id, {
          baselineCheckpointId: baseline_checkpoint_id,
        });
        const next_action: NextAction = {
          actor: 'AGENT',
          action: 'INVESTIGATE_CHANGE_SCOPE',
          agent_should:
            '범위 안의 함수를 사용자 원문과 비교한 뒤, run_reproduction으로 재현 테스트를 실행하라. 바뀐 함수가 신고 내용과 무관해 보이면, 기준 시점이 버그가 생긴 뒤일 수 있다. baseline_checkpoint_id로 더 이전 체크포인트를 지정해 범위를 넓히거나, 범위에 갇히지 말고 재현 테스트로 확인하라.',
          forbidden: ['원인 확정 단정 금지', '원본 파일 직접 수정', '재현 테스트 없는 짐작 수정'],
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  package_text: pkg.packageText,
                  scope_result: pkg.scopeResult,
                  baseline_sha: pkg.baselineSha,
                  baseline_rule: pkg.baselineRule,
                  warnings: pkg.warnings,
                  truncation_step: pkg.truncationStep,
                  truncation_reason: pkg.truncationReason,
                  character_count: pkg.characterCount,
                  older_checkpoints: pkg.olderCheckpoints || [],
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
                    action: 'RETRY_GET_CHANGE_SCOPE',
                    agent_should: `변경 범위 조회 오류: ${error.message}`,
                    forbidden: ['원인 자의적 단정'],
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
}
