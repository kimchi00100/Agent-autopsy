import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CoreManager, NextAction } from '@agent-autopsy/core';

export function registerCheckpointTools(
  server: McpServer,
  coreManager: CoreManager,
  resolvePath: (p?: string) => string
) {
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
}
