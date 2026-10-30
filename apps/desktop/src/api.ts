export type EvidenceStrength = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export type VerificationMode = 'AUTO' | 'MAIN_ONLY' | 'DEEP_PRIORITY';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ApprovalReadiness =
  | 'READY_FOR_APPROVAL'
  | 'BLOCKED_AWAITING_REVIEW'
  | 'APPROVABLE_WITH_RISK_WARNING'
  | 'BLOCKED_TEST_FAILED';
export type HostEnvironment = 'antigravity' | 'claude-code' | 'codex';
export type OrchestrationReviewStatus =
  | 'NOT_REQUESTED'
  | 'REQUESTED'
  | 'RUNNING'
  | 'COMPLETED_VERIFIED'
  | 'COMPLETED_UNVERIFIED'
  | 'FAILED'
  | 'SKIPPED';

export interface OrchestrationDecision {
  requiresOrchestration: boolean;
  recommendedSubagents: number;
  riskLevel: RiskLevel;
  riskSignals: string[];
  reason: string;
  verificationMode: VerificationMode;
  host: HostEnvironment;
  selfReviewChecklist?: string[];
  skippedVerificationWarnings?: string[];
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

export interface Directive {
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
}

export interface Checkpoint {
  id: string;
  label: string;
  agentName: string;
  createdAt: string;
  changedFiles: string[];
  untrackedFiles?: string[];
  worktreeCommitSha?: string;
  gitIndexSha?: string;
  gitRef?: string;
}

export type HealthLevelStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type CauseVerdict = 'CONFIRMED' | 'LIKELY' | 'UNKNOWN';
export type VerificationType = 'LOGIC_TEST' | 'DATA_STATE' | 'UI_FLOW' | 'MANUAL_CHECK';
export type ObservationScope = 'MCP_CALLS' | 'FILE_WATCH' | 'EXEC_EVENTS';

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
  timestamp: string;
}

export interface OnboardingResult {
  success: boolean;
  agentsMdCreated: boolean;
  gitignoreUpdated: boolean;
  message: string;
}

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

export type ReproductionStatus =
  | 'REPRODUCED'
  | 'NOT_REPRODUCED'
  | 'CANNOT_RUN'
  | 'WRONG_FAILURE'
  | 'UNVERIFIED_FAILURE';

export type ReproductionFailureKind =
  | 'ASSERTION'
  | 'RUNTIME_ERROR'
  | 'COLLECTION_ERROR'
  | 'TIMEOUT'
  | 'NO_TESTS'
  | 'NO_REPORT'
  | 'UNKNOWN_RUNNER'
  | 'FLAKY';

export type BaselineComparisonVerdict =
  | 'REGRESSION_CONFIRMED'
  | 'PRE_EXISTING'
  | 'BASELINE_CANNOT_RUN'
  | 'BASELINE_FLAKY'
  | 'NO_BASELINE'
  | 'SKIPPED';

export interface ReproductionRunRecord {
  runIndex: number;
  status: ReproductionStatus;
  failureKind?: ReproductionFailureKind;
  durationMs: number;
}

export interface BaselineComparison {
  baselineCheckpointId?: string;
  baselineSha?: string;
  baselineRule?: string;
  verdict: BaselineComparisonVerdict;
  runs: {
    current: ReproductionRunRecord[];
    baseline?: ReproductionRunRecord[];
  };
  note?: string;
}

export type AssertFlipVerdict =
  | 'FLIP_CONFIRMED'
  | 'PRE_FLIP_NOT_PASSING'
  | 'PRE_FLIP_FLAKY'
  | 'FLIP_CHANGED_NON_ASSERTION'
  | 'SKIPPED'
  | 'NOT_PROVIDED';

export interface AssertFlipNonAssertionLine {
  line: number;
  content: string;
}

export interface AssertFlipResult {
  preFlipTestFilePath?: string;
  verdict: AssertFlipVerdict;
  runs?: ReproductionRunRecord[];
  changedLineCount?: number;
  nonAssertionChangedLines?: AssertFlipNonAssertionLine[];
  note?: string;
}

export interface RunReproductionOptions {
  baselineCheckpointId?: string;
  preFlipTestFilePath?: string;
  timeoutMs?: number;
}

export interface ReproductionResult {
  status: ReproductionStatus;
  command: string;
  exitCode: number;
  output: string;
  failedLocation?: { filePath: string; line: number };
  executedAt: string;
  failureKind?: ReproductionFailureKind;
  failureReason?: string;
  testCount?: number;
  baselineComparison?: BaselineComparison;
  assertFlip?: AssertFlipResult;
}

export type ReproductionGateState =
  | 'NOT_ATTEMPTED'
  | 'IN_PROGRESS'
  | 'REPRODUCED'
  | 'ABANDONED'
  | 'WAIVED'
  | 'AUDIT_BROKEN'
  | 'NEEDS_USER_DECISION';

export interface ReproductionGateAttempt {
  attemptedAt: string;
  status: ReproductionStatus;
  failureKind?: ReproductionFailureKind | null;
  testFilePath: string;
}

export interface ReproductionGateInfo {
  state: ReproductionGateState;
  attemptsUsed: number;
  attemptsAllowed: number;
  history?: ReproductionGateAttempt[];
  discrepancyWarning?: string;
}

export type ReproductionLockAssessmentStatus =
  | 'OK'
  | 'MODIFIED_ON_DISK'
  | 'SIGNATURE_INVALID'
  | 'REMOVED'
  | 'NONE';

export type ReproductionEvidenceLevel =
  | 'STRONG'
  | 'PARTIAL'
  | 'REPRODUCED_ONLY'
  | 'NOT_REPRODUCED'
  | 'WAIVED'
  | 'NONE';

export interface IncidentReproductionLockStatus {
  present: boolean;
  testFilePath?: string;
  preFlipFilePath?: string;
  lockedAt?: string;
  status: ReproductionLockAssessmentStatus;
}

export interface IncidentReproductionEvidence {
  level: ReproductionEvidenceLevel;
  reproductionStatus?: string;
  baselineVerdict?: string;
  assertFlipVerdict?: string;
}

export interface BlockedIncidentSummary {
  id: string;
  title: string;
  state: string;
}

export interface DecisionRecord {
  auditSeq: number;
  kind: string;
  decidedAt: string;
  reason: string | null;
  recordStatus: 'OK' | 'MISMATCH' | 'NO_RECORD';
}

export interface IncidentReproductionStatusResponse {
  success: boolean;
  gate: ReproductionGateInfo;
  lock: IncidentReproductionLockStatus;
  evidence: IncidentReproductionEvidence;
  otherBlockedIncidents: BlockedIncidentSummary[];
  decisions?: DecisionRecord[];
}

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNASSESSED';

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

export interface Incident {
  id: string;
  projectId: string;
  baseCheckpointId?: string;
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
  expectedBehavior?: string;
  observedBehavior?: string;
  brokenStep?: string;
  reproductionCondition?: string;
  verificationMethod?: string;
  verificationType?: VerificationType;
  userConfirmedIntent?: boolean;
  userConfirmationSummary?: string;
  causeVerdict?: CauseVerdict;
  threeLevelHealth?: ThreeLevelHealth;
  riskLevel?: RiskLevel;
  riskSignals?: string[];
  orchestrationDecision?: OrchestrationDecision;
  rowSignature?: string | null;
  integrityStatus?: IncidentIntegrityStatus;
  integrityCode?: IncidentIntegrityCode;
  createdAt: string;
}

export type IncidentIntegrityStatus = '정상' | '서명 없음' | '변조 의심';
export type IncidentIntegrityCode = 'VALID' | 'UNSIGNED' | 'TAMPERED';

export type ProposalIntegrityStatus =
  | '정상'
  | '서명 없음 - 다시 검증 필요'
  | '변조 의심'
  | '프로젝트 불일치';

export type ProposalIntegrityCode =
  | 'VALID'
  | 'UNSIGNED'
  | 'TAMPERED'
  | 'PROJECT_MISMATCH';

export interface ProposalIntegrityResult {
  proposalId: string;
  integrityStatus: ProposalIntegrityStatus;
  integrityCode: ProposalIntegrityCode;
  valid: boolean;
  reason: string;
  status?: ProposalIntegrityStatus;
  code?: ProposalIntegrityCode;
}

export type AuditChainBrokenReasonCode =
  | 'VALUE_MODIFIED'
  | 'ORDER_OR_DELETION'
  | 'KEY_MISMATCH'
  | 'TRUNCATED'
  | 'HEAD_MISMATCH'
  | 'HEAD_ANCHOR_INVALID'
  | 'HEAD_ANCHOR_MISSING';

export interface AuditChainVerificationResult {
  valid: boolean;
  status: 'OK' | 'BROKEN' | 'OK_AFTER_ACKNOWLEDGED_BREAK';
  totalCount: number;
  brokenSeq?: number;
  reason?: string;
  reasonCode?: AuditChainBrokenReasonCode;
  message: string;
  acknowledgedBreak?: {
    trustedFromSeq: number;
    acknowledgedAt: string;
  };
  acknowledgementRecord?: DecisionRecord | null;
}

export interface ApprovalFingerprint {
  patchHash: string;
  baseHeadSha: string;
  baseCheckpointId: string | null;
  targetFileHashes: Record<string, string>;
  approvedFiles: string[];
  createdAt: string;
}

export interface Proposal {
  id: string;
  incidentId: string;
  rootCauseAnalysis: string;
  patchDiff: string;
  patchHash?: string;
  riskLevel?: RiskLevel;
  riskEvidence?: string[];
  selfReviewChecklist?: string[];
  touchedFiles: string[];
  verificationStatus: 'PENDING' | 'VERIFIED_PASS' | 'VERIFIED_FAIL';
  verificationLog: string;
  approvalStatus: 'AWAITING_USER' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'TAMPERED';
  approvalReadiness?: ApprovalReadiness;
  approvalBlockReason?: string;
  orchestrationReview?: OrchestrationReview;
  approvalFingerprintJson?: string | null;
  createdAt: string;
  appliedAt: string | null;
  stages?: StageResult[];
  threeLevelHealth?: ThreeLevelHealth;
  verifiedWithCommand?: string;
  rowSignature?: string | null;
  integrityStatus?: ProposalIntegrityStatus;
  integrityCode?: ProposalIntegrityCode;
}

export interface Overview {
  project: Project;
  health: {
    isGitClean: boolean;
    currentHeadSha: string;
    changedFiles: string[];
    untrackedFiles: string[];
    unapprovedModificationsDetected?: boolean;
    unapprovedFiles?: string[];
    quarantineBackupRef?: string;
    recentCommits: Array<{ sha: string; message: string; author: string; date: string }>;
    latestCheckpoint: Checkpoint | null;
    activeIncidentsCount: number;
  };
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

export type TimelineKind =
  | 'READ' | 'EDIT' | 'COMMAND' | 'TEST_PASS' | 'TEST_FAIL' | 'CHECKPOINT' | 'INCIDENT' | 'PROPOSAL' | 'RECOVERY' | 'NOTE';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  title: string;
  summary: string;
  actor: string;
  createdAt: string;
  files: string[];
  diff?: string;
  log?: string;
  refs: { checkpointId?: string; incidentId?: string; proposalId?: string };
}

export interface CauseCandidate {
  filePath: string;
  evidenceStrength: EvidenceStrength;
  confidence: EvidenceStrength;
  matchPercentage: number;
  score: number;
  reasons: string[];
  supportingEvidence: string[];
  counterEvidence: string[];
  causeVerdict?: CauseVerdict;
  missingEvidence?: string[];
  addedLines: number;
  removedLines: number;
  ranges: Array<{ start: number; end: number }>;
  temporalOnly: boolean;
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

export interface IncidentAnalysis {
  failedStage: { kind: 'RUNTIME' | 'BUILD' | 'TEST' | 'UNKNOWN'; summary: string };
  stackFrames: Array<{ filePath: string; line: number }>;
  failedTests: string[];
  changedFiles: Array<{ filePath: string; addedLines: number; removedLines: number }>;
  candidates: CauseCandidate[];
  flowData: IncidentFlowData;
  threeLevelHealth?: ThreeLevelHealth;
  causeVerdict?: CauseVerdict;
  missingEvidenceChecklist?: string[];
  verificationType?: VerificationType;
}

export interface McpInfo {
  command: string;
  args: string[];
  env: Record<string, string>;
  packaged: boolean;
}

export interface OnboardingPreview {
  agentsMdAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING';
  gitignoreAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING';
  agentsMdDiffPreview: string;
  gitignoreDiffPreview: string;
  hasConflicts: boolean;
  conflictNotes?: string[];
}

export interface DiagnosticItem {
  key: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  message: string;
  details?: string;
  actionRequired?: string;
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

export interface OnboardingResult {
  success: boolean;
  result: {
    success: boolean;
    agentsMdCreated: boolean;
    gitignoreUpdated: boolean;
    message: string;
  };
}

export interface BackendStatus {
  state: 'STARTING' | 'READY' | 'ERROR';
  port: number;
  host: string;
  error: string | null;
  recoveryGuide: string | null;
}

declare global {
  interface Window {
    autopsy?: {
      selectFolder: () => Promise<string | null>;
      getMcpInfo: () => Promise<McpInfo>;
      getBackendConfig?: () => Promise<{ url: string; port: number; host: string }>;
      getBackendStatus?: () => Promise<BackendStatus>;
      getAuthToken?: () => Promise<string>;
      onBackendStatusChange?: (cb: (status: BackendStatus) => void) => () => void;
    };
  }
}

let cachedBackendBaseUrl = 'http://127.0.0.1:3847';
let cachedAuthToken: string | null = null;

export async function getAuthToken(): Promise<string | null> {
  if (cachedAuthToken) return cachedAuthToken;
  if (typeof window !== 'undefined' && window.autopsy?.getAuthToken) {
    try {
      cachedAuthToken = await window.autopsy.getAuthToken();
      return cachedAuthToken;
    } catch {}
  }
  return null;
}

export async function getBackendBaseUrl(): Promise<string> {
  if (window.autopsy?.getBackendConfig) {
    try {
      const cfg = await window.autopsy.getBackendConfig();
      if (cfg && cfg.url) {
        cachedBackendBaseUrl = cfg.url;
        return cfg.url;
      }
    } catch {}
  }
  return cachedBackendBaseUrl;
}

export function resolveFullUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const isFileProto = typeof window !== 'undefined' && window.location.protocol === 'file:';
  if (isFileProto) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${cachedBackendBaseUrl}${cleanPath}`;
  }
  return path;
}

// Initial async fetch of backend config
if (typeof window !== 'undefined') {
  getBackendBaseUrl().catch(() => {});
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const isFileProto = typeof window !== 'undefined' && window.location.protocol === 'file:';
  if (isFileProto && cachedBackendBaseUrl === 'http://127.0.0.1:3847') {
    await getBackendBaseUrl();
  }
  const token = await getAuthToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has('X-Autopsy-Token')) {
    headers.set('X-Autopsy-Token', token);
  }
  const fullUrl = resolveFullUrl(url);
  const res = await fetch(fullUrl, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as any).error || `요청 실패 (${res.status})`;
    const err: any = new Error(message);
    if ((data as any).code) err.code = (data as any).code;
    err.status = res.status;
    err.statusCode = res.status;
    throw err;
  }
  return data as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  agents: () => request<{ agents: AgentSession[] }>('/api/agents'),
  overview: (repoPath: string) => request<Overview>('/api/overview', post({ repoPath })),
  workspaceDiff: (repoPath: string, options?: { checkpointId?: string; commitSha?: string }) =>
    request<WorkspaceComparison>('/api/workspace-diff', post({ repoPath, ...options })),
  timeline: (projectId: string) => request<{ events: TimelineEvent[] }>(`/api/projects/${projectId}/timeline`),
  incidents: (projectId: string) => request<{ incidents: Incident[] }>(`/api/projects/${projectId}/incidents`),
  analysis: (incidentId: string) =>
    request<{ incident: Incident; analysis: IncidentAnalysis }>(`/api/incidents/${incidentId}/analysis`),
  proposals: (incidentId: string) => request<{ proposals: Proposal[] }>(`/api/incidents/${incidentId}/proposals`),
  approve: (id: string, selectedFiles?: string[], forceOverrideWithRiskAck?: boolean, repoPath?: string) =>
    request<{ success: boolean; proposal: Proposal; fingerprint: ApprovalFingerprint }>(
      `/api/proposals/${id}/approve`,
      post({ selectedFiles, forceOverrideWithRiskAck, repoPath })
    ),
  reject: (id: string) => request(`/api/proposals/${id}/reject`, post({})),
  apply: (id: string, repoPath: string, selectedFiles: string[]) =>
    request(`/api/proposals/${id}/apply`, post({ repoPath, selectedFiles })),
  rollback: (checkpointId: string, repoPath: string) =>
    request(`/api/checkpoints/${checkpointId}/rollback`, post({ repoPath })),
  checkpoints: (projectId: string) => request<{ checkpoints: Checkpoint[] }>(`/api/projects/${projectId}/checkpoints`),
  updateSettings: (
    projectId: string,
    settings: {
      verificationMode?: VerificationMode;
      preferredHost?: HostEnvironment;
      testCommand?: string;
      sensitivePaths?: string[];
      riskThresholdLines?: number;
  enableCoverage?: boolean;
    }
  ) => request<{ success: boolean; project: Project }>(`/api/projects/${projectId}/settings`, post(settings)),
  submitReview: (
    proposalId: string,
    review: {
      reviewer: string;
      findings: string[];
      counterEvidence?: string[];
      limitations?: string[];
      subagentTaskId?: string;
      transcriptPath?: string;
      submittedByRole?: 'SUBAGENT_DIRECT' | 'MAIN_AGENT_PROXY';
    }
  ) =>
    request<{ success: boolean; review: OrchestrationReview; proposal: Proposal }>(
      `/api/proposals/${proposalId}/review`,
      post(review)
    ),
  directives: (projectId: string) => request<{ directives: Directive[] }>(`/api/projects/${projectId}/directives`),
  createDirective: (data: {
    repoPath?: string;
    projectId?: string;
    incidentId?: string;
    proposalId?: string;
    patchHash?: string;
    kind: DirectiveKind;
    feedbackText?: string;
    confirmedIntent?: ConfirmedIntentData;
  }) => request<{ success: boolean; directive: Directive }>('/api/directives', post(data)),
  confirmIntent: (incidentId: string, intent: ConfirmedIntentData) =>
    request<{ success: boolean; incident: Incident; directive: Directive }>(
      `/api/incidents/${incidentId}/confirm-intent`,
      post(intent)
    ),
  acknowledgeDirective: (directiveId: string, agentName?: string) =>
    request<{ success: boolean; directive: Directive }>(
      `/api/directives/${directiveId}/acknowledge`,
      post({ agentName })
    ),
  diagnoseProject: (projectId: string) =>
    request<{ success: boolean; diagnostics: ProjectDiagnostics }>(`/api/projects/${projectId}/diagnose`, post({})),
  onboardProject: (projectId: string) =>
    request<{ success: boolean; result: OnboardingResult }>(`/api/projects/${projectId}/onboard`, post({})),
  confirmTestCommand: (projectId: string, testCommand?: string) =>
    request<{ success: boolean; project: Project }>(
      `/api/projects/${projectId}/confirm-test-command`,
      post({ testCommand })
    ),
  discoverCommands: (projectId: string) =>
    request<{ success: boolean; commands: DiscoveredCommands }>(`/api/projects/${projectId}/commands`),
  runReproduction: (incidentId: string, testCommandOrFile: string) =>
    request<{ success: boolean; reproduction: ReproductionResult }>(
      `/api/incidents/${incidentId}/reproduce`,
      post({ testCommandOrFile })
    ),
  auditChainStatus: () =>
    request<{ success: boolean; result: AuditChainVerificationResult }>('/api/audit-chain/status'),
  proposalIntegrity: (proposalId: string, repoPath?: string) =>
    request<{ success: boolean; result: ProposalIntegrityResult }>(
      `/api/proposals/${proposalId}/integrity`,
      post({ repoPath })
    ),
  reproductionStatus: (incidentId: string, repoPath?: string) =>
    request<IncidentReproductionStatusResponse>(
      `/api/incidents/${incidentId}/reproduction-status${repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : ''}`
    ),
  decideReproduction: (
    incidentId: string,
    decision: 'PROCEED_WITHOUT_REPRODUCTION' | 'ALLOW_MORE_ATTEMPTS',
    repoPath: string,
    reason: string
  ) =>
    request<{ success: boolean; result: any }>(
      `/api/incidents/${incidentId}/reproduction-decision`,
      post({ decision, repoPath, reason })
    ),
  acknowledgeAuditChain: (reason: string) =>
    request<{ success: boolean; result: AuditChainVerificationResult }>(
      '/api/audit-chain/acknowledge',
      post({ reason })
    ),
  subscribeStream: (onEvent: (event: any) => void): (() => void) => {
    try {
      const fullUrl = resolveFullUrl('/api/stream');
      const source = new EventSource(fullUrl);
      source.onmessage = (e) => {
        try {
          const parsed = JSON.parse(e.data);
          onEvent(parsed);
        } catch {}
      };
      return () => source.close();
    } catch {
      return () => {};
    }
  },
};
