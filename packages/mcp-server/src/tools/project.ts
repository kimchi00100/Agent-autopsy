import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerProjectTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
}
