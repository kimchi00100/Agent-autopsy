import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerHistoryTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
}
