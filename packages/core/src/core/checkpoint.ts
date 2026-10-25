import { CoreContext } from './context.js';
import { Checkpoint } from '../types.js';

export function captureCheckpoint(
  ctx: CoreContext,
  repoPath: string,
  label: string = 'Manual Checkpoint',
  agentName: string = 'user',
  sessionId?: string
): Checkpoint {
  const project = ctx.ensureProject(repoPath);
  const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
  const snapshot = ctx.gitEngine.createSnapshot(project.rootPath, id, label);

  const cp: Checkpoint = {
    id,
    projectId: project.id,
    agentName,
    label,
    gitHeadSha: snapshot.headSha,
    gitStashSha:
      snapshot.headSha === snapshot.worktreeCommitSha &&
      snapshot.changedFiles.length === 0 &&
      snapshot.untrackedFiles.length === 0
        ? null
        : snapshot.worktreeCommitSha,
    gitIndexSha: snapshot.indexTreeSha,
    worktreeCommitSha: snapshot.worktreeCommitSha,
    gitRef: snapshot.gitRef,
    changedFiles: snapshot.changedFiles,
    untrackedFiles: snapshot.untrackedFiles,
    sessionId,
    createdAt: new Date().toISOString(),
  };

  ctx.db.recordAgentHeartbeat(agentName, sessionId, `체크포인트 생성: ${label}`);
  ctx.db.insertCheckpoint(cp);
  ctx.quarantineCache.delete(project.id);
  ctx.db.updateProjectQuarantine(project.id, null, null);
  ctx.emitChange('checkpoint_created', cp);
  return cp;
}

export function rollbackToCheckpoint(
  ctx: CoreContext,
  repoPath: string,
  checkpointId: string
): { restored: boolean; backupRef: string } {
  const project = ctx.ensureProject(repoPath);
  const cp = ctx.db.getCheckpoint(checkpointId);
  if (!cp) {
    throw new Error(`Checkpoint with ID "${checkpointId}" not found.`);
  }

  const { backupRef } = ctx.gitEngine.restoreSnapshot(
    project.rootPath,
    cp.gitHeadSha,
    cp.worktreeCommitSha,
    cp.gitIndexSha,
    cp.untrackedFiles || []
  );

  ctx.quarantineCache.delete(project.id);
  ctx.db.updateProjectQuarantine(project.id, null, null);
  ctx.emitChange('checkpoint_rolled_back', { checkpointId, backupRef });

  return {
    restored: true,
    backupRef,
  };
}
