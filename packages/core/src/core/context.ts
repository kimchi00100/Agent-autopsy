import { AutopsyDatabase } from '../db/database.js';
import { GitEngine } from '../git/git-engine.js';
import { PatchEngine } from '../patch/patch-engine.js';
import { WorktreeRunner } from '../runner/worktree-runner.js';
import { AutoBaselineWatcher } from '../watcher/auto-watcher.js';
import {
  Project,
  Checkpoint,
  Incident,
  RepairProposal,
  ProjectHealth,
  AgentEvent,
  AgentEventKind,
  VerificationMode,
  HostEnvironment,
  OrchestrationDecision,
  CauseVerdict,
  ThreeLevelHealth,
} from '../types.js';

export interface CoreManagerOptions {
  customDbPath?: string;
  defaultTestCommand?: string;
}

export interface CoreContext {
  db: AutopsyDatabase;
  gitEngine: GitEngine;
  patchEngine: PatchEngine;
  worktreeRunner: WorktreeRunner;
  watchers: Map<string, AutoBaselineWatcher>;
  changeListeners: Set<(type: string, data: any) => void>;
  isApplyingApprovedPatch: boolean;
  quarantineCache: Map<string, { fingerprint: string; backupRef: string }>;
  activeWaiters: Map<
    string,
    {
      resolve: (val: any) => void;
      timer: NodeJS.Timeout;
      proposalId: string;
      repoPath: string;
    }
  >;
  options: CoreManagerOptions;
  emitChange: (type: string, data?: any) => void;
  getActivePort: () => number;

  // Inter-module delegations
  ensureProject: (repoPath: string, testCommand?: string) => Project;
  captureCheckpoint: (
    repoPath: string,
    label?: string,
    agentName?: string,
    sessionId?: string
  ) => Checkpoint;
  inspectProjectState: (repoPath: string) => ProjectHealth;
  recordAgentEvent: (
    repoPath: string,
    kind: AgentEventKind,
    title: string,
    detail?: string,
    filePath?: string | null,
    agentName?: string,
    sessionId?: string
  ) => AgentEvent;
  evaluateOrchestrationDecision: (
    project: Project,
    title: string,
    errorOutput: string,
    diffSummary: string,
    changedFiles: string[],
    causeVerdict?: CauseVerdict,
    threeLevelHealth?: ThreeLevelHealth,
    retryCount?: number
  ) => OrchestrationDecision;
  detectTestCommand: (repoPath: string) => string;
  rejectProposal: (proposalId: string, reason?: string) => void;
  recordTamperIncident: (repoPath: string, proposalId: string, reason: string) => void;
  listActiveAgents: () => any[];
  getAgentsMdTemplate: () => string;
}
