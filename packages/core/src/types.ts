import type {
  ScopeStats,
  ScopeExpansionInfo,
  CheckpointSummary,
} from './localization/change-localizer.js';

export type VerificationMode = 'AUTO' | 'MAIN_ONLY' | 'DEEP_PRIORITY';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type OrchestrationReviewStatus =
  | 'NOT_REQUIRED'
  | 'REQUESTED'
  | 'COMPLETED_VERIFIED'
  | 'COMPLETED_UNVERIFIED'
  | 'FAILED'
  | 'SKIPPED_BY_USER';
export type ApprovalReadiness =
  | 'READY_FOR_APPROVAL'
  | 'BLOCKED_AWAITING_REVIEW'
  | 'BLOCKED_TEST_FAILED'
  | 'APPROVABLE_WITH_RISK_WARNING';
export type HostEnvironment = 'antigravity' | 'claude-code' | 'codex' | 'generic-mcp';

export interface ReviewChallenge {
  challengeToken: string;
  proposalId: string;
  patchHash: string;
  expiresAt: string;
}

export interface OrchestrationReview {
  reviewId: string;
  proposalId: string;
  incidentId: string;
  status: OrchestrationReviewStatus;
  reviewer: string;
  submittedByRole: 'SUBAGENT_DIRECT' | 'MAIN_AGENT_PROXY';
  hostTranscriptVerified: boolean;
  subagentTaskId?: string;
  challengeToken?: string;
  verificationNotes?: string;
  patchHash: string;
  findings: string[];
  counterEvidence: string[];
  limitations: string[];
  createdAt: string;
}

export interface OrchestrationDecision {
  requiresOrchestration: boolean;
  reason?: string;
  riskLevel: RiskLevel;
  riskSignals: string[];
  verificationMode: VerificationMode;
  hostEnvironment: HostEnvironment;
  directive: 'DIRECT_SOLVE' | 'INVOKE_NATIVE_ORCHESTRATION' | 'SKIPPED_MAIN_ONLY';
  reviewRequirement: 'NONE' | 'CONDITIONAL' | 'MANDATORY_BEFORE_APPROVAL';
  hostDelegationGuide: string;
  skippedVerificationWarnings: string[];
  selfReviewChecklist?: string[];
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  testCommand?: string;
  testCommandSignature?: string;
  proposedTestCommand?: string;
  proposedTestCommandReason?: string;
  verificationMode?: VerificationMode;
  preferredHost?: HostEnvironment;
  sensitivePaths?: string[];
  riskThresholdLines?: number;
  enableCoverage?: boolean;
  lastQuarantineFingerprint?: string;
  lastQuarantineRef?: string;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  agentName: string;
  label: string;
  gitHeadSha: string;
  gitStashSha: string | null;
  gitIndexSha?: string;
  worktreeCommitSha?: string;
  gitRef?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  sessionId?: string;
  createdAt: string;
}

export type ReproductionStatus = 'REPRODUCED' | 'NOT_REPRODUCED' | 'CANNOT_RUN';

export interface ReproductionResult {
  status: ReproductionStatus;
  command: string;
  exitCode: number;
  output: string;
  failedLocation?: { filePath: string; line: number };
  executedAt: string;
}

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNASSESSED';
export type CauseVerdict = 'CONFIRMED' | 'LIKELY' | 'UNKNOWN';
export type VerificationType = 'LOGIC_TEST' | 'DATA_STATE' | 'UI_FLOW' | 'MANUAL_CHECK';

export type IntentSource = 'USER_QUOTE' | 'AI_INFERRED' | 'MISSING';

export interface IntentProvenance {
  value: string;
  source: IntentSource;
  quote?: string;
}

export interface StructuredIntents {
  expectedBehavior: IntentProvenance;
  observedBehavior: IntentProvenance;
  reproductionCondition: IntentProvenance;
  verificationMethod: IntentProvenance;
}

export interface NextAction {
  actor: 'USER' | 'AGENT' | 'SUBAGENT';
  action: string;
  agent_should: string;
  forbidden: string[];
  note?: string;
  missing_fields?: string[];
}

export interface HistorySearchItem {
  id: string;
  title: string;
  userReportText?: string;
  intents?: StructuredIntents;
  missingIntents?: string[];
  status: 'OPEN' | 'ANALYZING' | 'RESOLVED';
  causeVerdict: CauseVerdict;
  confirmedCause?: string;
  appliedRepair?: {
    id: string;
    summary: string;
  };
  createdAt: string;
}

export interface IncidentAttemptItem {
  proposalId: string;
  status: 'REJECTED' | 'VERIFIED_FAIL' | 'TAMPERED';
  title: string;
  failedStage?: string;
  failureReason?: string;
  createdAt: string;
}

export interface CheckpointChangesSummary {
  checkpointId?: string;
  checkpointLabel?: string;
  gitHeadSha?: string;
  createdAt?: string;
  changedFiles: Array<{ filePath: string; addedLines: number; removedLines: number }>;
  totalAdded: number;
  totalRemoved: number;
  summary: string;
}

export interface ChangeScopeSummaryFunction {
  filePath: string;
  name: string;
  startLine: number;
  endLine: number;
  kind?: string;
}

export interface ChangeScopeSummary {
  baselineSha: string;
  baselineRule: string;
  changedFunctions: ChangeScopeSummaryFunction[];
  neighborFunctionCount: number;
  scopeStats: ScopeStats;
  warnings: string[];
  notice?: string;
  olderCheckpoints?: CheckpointSummary[];
  expansion?: ScopeExpansionInfo;
}

export interface Incident {
  id: string;
  projectId: string;
  baseCheckpointId: string | null;
  title: string;
  userReportText?: string;
  intents?: StructuredIntents;
  missingIntents?: string[];
  errorOutput: string;
  diffSummary: string;
  status: 'OPEN' | 'ANALYZING' | 'RESOLVED';
  severity: Severity;
  severityEvidence?: string[];
  causeEvidence?: string[];
  reproductionResult?: ReproductionResult;
  coverageLines?: Record<string, number[]>;
  enableCoverage?: boolean;
  agentName: string;
  sessionId?: string;
  expectedBehavior?: string;
  observedBehavior?: string;
  brokenStep?: string;
  reproductionCondition?: string;
  verificationMethod?: string;
  verificationType?: VerificationType;
  userConfirmedIntent?: boolean;
  userConfirmationSummary?: string;
  causeVerdict?: CauseVerdict;
  riskLevel?: RiskLevel;
  riskSignals?: string[];
  orchestrationDecision?: OrchestrationDecision;
  executionTrace?: ExecutionTraceStep[];
  threeLevelHealth?: ThreeLevelHealth;
  testExecutionNote?: string;
  changeScopeSummary?: ChangeScopeSummary | string;
  createdAt: string;
}

export type HealthLevelStatus = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface ThreeLevelHealth {
  code: HealthLevelStatus;
  functional: HealthLevelStatus;
  requirement: HealthLevelStatus;
  details?: {
    codeSummary?: string;
    functionalSummary?: string;
    requirementSummary?: string;
  };
}

export type StageName = 'CODE_CHECK' | 'TARGET_FUNCTIONAL_CHECK' | 'FULL_REGRESSION_CHECK';
export type StageStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface StageResult {
  stage: StageName;
  command: string;
  status: StageStatus;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface ThreeStageExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  stages: StageResult[];
  threeLevelHealth: ThreeLevelHealth;
}

export interface DiscoveredCommands {
  projectType: 'node' | 'python' | 'rust' | 'c_cpp' | 'go' | 'java' | 'unknown';
  codeCheckCmd?: string;
  targetTestCmd?: string;
  fullRegressionCmd?: string;
  availableScripts: Record<string, string>;
  isCommandSafe: boolean;
  warnings?: string[];
}

export interface DiagnosticItem {
  key: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  details?: string;
  actionRequired?: string;
}

export interface OnboardingPreview {
  agentsMdAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING';
  gitignoreAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING';
  agentsMdDiffPreview: string;
  gitignoreDiffPreview: string;
  hasConflicts: boolean;
  conflictNotes?: string[];
}

export interface ProjectDiagnostics {
  projectId: string;
  repoPath: string;
  healthy: boolean;
  items: DiagnosticItem[];
  discoveredCommands: DiscoveredCommands;
  hasAgentsMd: boolean;
  hasAutopsyIgnore: boolean;
  gitStatus: 'CLEAN' | 'DIRTY' | 'NOT_A_GIT_REPO';
  mcpHeartbeatActive: boolean;
  onboardingPreview?: OnboardingPreview;
  timestamp: string;
}

export interface OnboardingResult {
  success: boolean;
  agentsMdCreated: boolean;
  gitignoreUpdated: boolean;
  message: string;
  preview?: OnboardingPreview;
}

export interface RuntimeInfo {
  service: string;
  version: string;
  pid: number;
  port: number;
  host: string;
  dataDir: string;
  cacheDir: string;
  dbPath: string;
  dbStatus: 'READY' | 'MIGRATED' | 'ERROR';
  dbInitError?: string;
  recoveryGuide?: string;
  startedAt: string;
  authToken?: string;
}

export interface ExecutionTraceStep {
  id: string;
  stepNumber: number;
  name: string;
  codeLocation?: string;
  expected?: string;
  observed?: string;
  status: HealthLevelStatus;
  isObserved: boolean;
}

export interface Replacement {
  search: string;
  replace: string;
}

export interface FileChange {
  filePath: string;
  replacements?: Replacement[];
  newContent?: string;
}

export type VerificationStatus = 'PENDING' | 'VERIFIED_PASS' | 'VERIFIED_FAIL';
export type ApprovalStatus = 'AWAITING_USER' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'TAMPERED';

export interface ApprovalFingerprint {
  patchHash: string;
  baseHeadSha: string;
  baseCheckpointId: string | null;
  targetFileHashes: Record<string, string>;
  approvedFiles: string[];
  createdAt: string;
  signature?: string;
}

export interface RepairProposal {
  id: string;
  incidentId: string;
  rootCauseAnalysis: string;
  patchDiff: string;
  patchHash?: string;
  riskLevel?: RiskLevel;
  riskEvidence?: string[];
  selfReviewChecklist?: string[];
  touchedFiles: string[];
  fileChangesJson: string;
  verificationStatus: VerificationStatus;
  verificationLog: string;
  approvalStatus: ApprovalStatus;
  rejectionReason?: string;
  approvalReadiness?: ApprovalReadiness;
  approvalBlockReason?: string;
  orchestrationReview?: OrchestrationReview;
  approvalFingerprintJson?: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  stages?: StageResult[];
  threeLevelHealth?: ThreeLevelHealth;
  verifiedWithCommand?: string;
}

export type EvidenceStrength = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface CauseCandidate {
  filePath: string;
  evidenceStrength: EvidenceStrength;
  confidence: EvidenceStrength; // backward compatibility
  matchPercentage: number; // 0 ~ 100%
  score: number;
  reasons: string[]; // backward compatibility
  supportingEvidence: string[];
  counterEvidence: string[];
  causeVerdict?: CauseVerdict;
  missingEvidence?: string[];
  addedLines: number;
  removedLines: number;
  ranges: Array<{ start: number; end: number }>;
  temporalOnly: boolean;
  executionEvidence?: string[];
  hasExecutionEvidence?: boolean;
}

export interface FlowNode {
  id: string;
  type:
    | 'root'
    | 'dir'
    | 'file'
    | 'test_file'
    | 'test_run'
    | 'test_failure'
    | 'cause_candidate'
    | 'requirement'
    | 'call_step'
    | 'broken_point'
    | 'verification';
  label: string;
  sublabel?: string;
  path?: string;
  status?: 'modified' | 'failure' | 'candidate' | 'related' | 'neutral' | 'success' | 'broken';
  diffBadge?: { added: number; removed: number };
  x: number;
  y: number;
  codeSnippet?: string;
  expectedValue?: string;
  observedValue?: string;
  isObserved?: boolean;
  threeLevelStatus?: ThreeLevelHealth;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  style: 'solid' | 'dashed';
  color: 'blue' | 'red' | 'orange' | 'gray' | 'green';
  label?: string;
  isObserved?: boolean;
  expected?: string;
  observed?: string;
}

export interface IncidentFlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  behaviorNodes?: FlowNode[];
  behaviorEdges?: FlowEdge[];
  fileNodes?: FlowNode[];
  fileEdges?: FlowEdge[];
}

export type ObservationScope = 'MCP_CALLS' | 'FILE_WATCH' | 'EXEC_EVENTS';

export interface AgentSession {
  agentName: string;
  sessionId?: string;
  version?: string;
  lastSeenAt: string;
  status: 'ACTIVE' | 'IDLE';
  lastAction: string;
  clientInfo?: string;
  observationScope?: ObservationScope[];
}

export type AgentEventKind = 'READ' | 'EDIT' | 'COMMAND' | 'TEST_PASS' | 'TEST_FAIL' | 'NOTE';

export interface AgentEvent {
  id: string;
  projectId: string;
  agentName: string;
  sessionId?: string;
  kind: AgentEventKind;
  title: string;
  detail: string;
  filePath: string | null;
  createdAt: string;
}

export type TimelineKind =
  | 'READ'
  | 'EDIT'
  | 'COMMAND'
  | 'TEST_PASS'
  | 'TEST_FAIL'
  | 'CHECKPOINT'
  | 'INCIDENT'
  | 'PROPOSAL'
  | 'RECOVERY'
  | 'NOTE';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  title: string;
  summary: string;
  actor: string;
  sessionId?: string;
  createdAt: string;
  files: string[];
  diff?: string;
  log?: string;
  refs: { checkpointId?: string; incidentId?: string; proposalId?: string };
}

export interface ProjectOverview {
  project: Project;
  health: ProjectHealth;
  stats: {
    totalProposals: number;
    appliedProposals: number;
    verifiedPassProposals: number;
    successRate: number | null;
    openIncidents: number;
    resolvedIncidents: number;
    lastTestStatus: 'PASS' | 'FAIL' | 'UNKNOWN';
  };
  openIncidents: Incident[];
  recentRecoveries: Array<{ proposalId: string; incidentTitle: string; summary: string; appliedAt: string; files: string[] }>;
}

export interface ProjectHealth {
  projectId: string;
  projectName: string;
  rootPath: string;
  isGitClean: boolean;
  currentHeadSha: string;
  changedFiles: string[];
  untrackedFiles: string[];
  unapprovedModificationsDetected?: boolean;
  unapprovedFiles?: string[];
  quarantineBackupRef?: string;
  recentCommits: Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
  }>;
  latestCheckpoint: Checkpoint | null;
  activeIncidentsCount: number;
}

export type DirectiveKind =
  | 'APPROVE_AND_APPLY'
  | 'REJECT_WITH_FEEDBACK'
  | 'REQUEST_DEEP_REVIEW'
  | 'CONFIRM_INTENT';

export type DirectiveDeliveryStatus =
  | 'WAITING_AGENT'
  | 'DELIVERED_LIVE'
  | 'DELIVERED_ON_NEXT_CALL'
  | 'RESUME_TRIGGERED'
  | 'MANUAL_RESUME_REQUIRED'
  | 'ACKNOWLEDGED';

export interface ConfirmedIntentData {
  expectedBehavior?: string;
  observedBehavior?: string;
  reproductionCondition?: string;
  verificationMethod?: string;
}

export interface AgentDirective {
  id: string;
  projectId: string;
  incidentId?: string;
  proposalId?: string;
  patchHash?: string;
  kind: DirectiveKind;
  feedbackText?: string;
  confirmedIntent?: ConfirmedIntentData;
  deliveryStatus: DirectiveDeliveryStatus;
  resumeMethod?: 'HOST_AUTO' | 'MANUAL_COPY_PROMPT';
  manualPromptSnippet?: string;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export interface WorkspaceComparison {
  workingDiff: string;
  changedFiles: string[];
  untrackedFiles: string[];
  checkpointDiff?: string;
  selectedCheckpointId?: string;
  recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
  commitDiff?: string;
  selectedCommitSha?: string;
}

