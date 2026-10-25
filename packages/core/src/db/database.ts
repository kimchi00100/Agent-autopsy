import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Project,
  Checkpoint,
  Incident,
  RepairProposal,
  VerificationStatus,
  ApprovalStatus,
  AgentEvent,
  AgentEventKind,
  ApprovalFingerprint,
  AgentSession,
  VerificationMode,
  HostEnvironment,
  RiskLevel,
  ApprovalReadiness,
  OrchestrationReview,
  AgentDirective,
  DirectiveKind,
  DirectiveDeliveryStatus,
  ConfirmedIntentData,
  ReproductionResult,
  CauseVerdict,
  AuditLogEntry,
  AuditLogKind,
  AuditEntityType,
  AuditChainVerificationResult,
} from '../types.js';
import { generateDeterministicProjectId, normalizeRepoPath } from '../utils/paths.js';
import {
  GENESIS_PREV_HASH,
  computeAuditEntryHash,
  hashAuditPayload,
  getInstallationSecretKey,
} from '../utils/security.js';

export class AutopsyDatabase {
  private db: DatabaseSync;
  private inTransaction: boolean = false;
  public status: 'READY' | 'MIGRATED' | 'ERROR' = 'READY';
  public initError?: string;
  public recoveryGuide?: string;
  public readonly resolvedPath: string;

  constructor(dbPath: string) {
    this.resolvedPath = dbPath;
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Seamless migration: If target DB does not exist, check legacy ~/.agent-autopsy/autopsy.db
      if (!fs.existsSync(dbPath)) {
        const legacyCandidates = [
          path.resolve(process.env.APPDATA || process.env.HOME || '.', '.agent-autopsy', 'autopsy.db'),
          path.resolve(process.env.USERPROFILE || process.env.HOME || '.', '.agent-autopsy', 'autopsy.db'),
        ];
        for (const leg of legacyCandidates) {
          if (path.resolve(leg) !== path.resolve(dbPath) && fs.existsSync(leg)) {
            try {
              fs.copyFileSync(leg, dbPath);
              if (fs.existsSync(`${leg}-wal`)) fs.copyFileSync(`${leg}-wal`, `${dbPath}-wal`);
              if (fs.existsSync(`${leg}-shm`)) fs.copyFileSync(`${leg}-shm`, `${dbPath}-shm`);
              this.status = 'MIGRATED';
              break;
            } catch {}
          }
        }
      }

      this.db = new DatabaseSync(dbPath);
      this.initPragmas();
      this.createTables();
      this.migrateColumns();
      this.migrateDeterministicProjectIds();
      this.migrateUnassessedFields();
      if (this.status !== 'MIGRATED') {
        this.status = 'READY';
      }
    } catch (err: any) {
      this.status = 'ERROR';
      this.initError = err.message || '데이터베이스 초기화 실패';
      this.recoveryGuide = `SQLite 데이터베이스 접근에 실패했습니다. 폴더 권한("${path.dirname(dbPath)}")을 확인하거나 이전 데이터베이스 파일 손상 여부를 확인하세요.`;
      // Graceful fallback to in-memory DB so process does not crash
      this.db = new DatabaseSync(':memory:');
      this.initPragmas();
      this.createTables();
      this.migrateColumns();
    }
  }

  private initPragmas(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT UNIQUE NOT NULL,
        test_command TEXT,
        test_command_signature TEXT,
        proposed_test_command TEXT,
        proposed_test_command_reason TEXT,
        verification_mode TEXT DEFAULT 'AUTO',
        preferred_host TEXT DEFAULT 'antigravity',
        sensitive_paths_json TEXT DEFAULT '[]',
        risk_threshold_lines INTEGER DEFAULT 200,
        enable_coverage INTEGER DEFAULT 0,
        last_quarantine_fingerprint TEXT,
        last_quarantine_ref TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        label TEXT NOT NULL,
        git_head_sha TEXT NOT NULL,
        git_stash_sha TEXT,
        git_index_sha TEXT,
        worktree_commit_sha TEXT,
        git_ref TEXT,
        changed_files_json TEXT NOT NULL,
        untracked_files_json TEXT DEFAULT '[]',
        session_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        base_checkpoint_id TEXT,
        title TEXT NOT NULL,
        error_output TEXT NOT NULL,
        diff_summary TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT DEFAULT 'UNASSESSED',
        severity_evidence_json TEXT DEFAULT '[]',
        cause_evidence_json TEXT DEFAULT '[]',
        reproduction_result_json TEXT,
        coverage_lines_json TEXT,
        change_scope_summary_json TEXT,
        agent_name TEXT DEFAULT 'agent',
        session_id TEXT,
        test_execution_note TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (base_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS repair_proposals (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        root_cause_analysis TEXT NOT NULL,
        patch_diff TEXT NOT NULL,
        touched_files_json TEXT NOT NULL,
        file_changes_json TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        verification_log TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        approval_fingerprint_json TEXT,
        approved_at TEXT,
        applied_at TEXT,
        verified_with_command TEXT,
        risk_evidence_json TEXT DEFAULT '[]',
        self_review_checklist_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        file_path TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        agent_name TEXT PRIMARY KEY,
        session_id TEXT,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL,
        last_action TEXT NOT NULL,
        client_info TEXT
      );

      CREATE TABLE IF NOT EXISTS directives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        incident_id TEXT,
        proposal_id TEXT,
        patch_hash TEXT,
        kind TEXT NOT NULL,
        feedback_text TEXT,
        confirmed_intent_json TEXT,
        delivery_status TEXT NOT NULL,
        resume_method TEXT,
        manual_prompt_snippet TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_project ON agent_events(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incidents_project ON incidents(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_proposals_incident ON repair_proposals(incident_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_directives_project ON directives(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_directives_status ON directives(delivery_status);
      CREATE INDEX IF NOT EXISTS idx_audit_log_kind ON audit_log(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
    `);
  }

  private migrateColumns(): void {
    const migrations = [
      `CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_kind ON audit_log(kind, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);`,
      `CREATE TABLE IF NOT EXISTS directives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        incident_id TEXT,
        proposal_id TEXT,
        patch_hash TEXT,
        kind TEXT NOT NULL,
        feedback_text TEXT,
        confirmed_intent_json TEXT,
        delivery_status TEXT NOT NULL,
        resume_method TEXT,
        manual_prompt_snippet TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );`,
      `CREATE INDEX IF NOT EXISTS idx_directives_project ON directives(project_id, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_directives_status ON directives(delivery_status);`,
      `ALTER TABLE checkpoints ADD COLUMN git_index_sha TEXT;`,
      `ALTER TABLE checkpoints ADD COLUMN worktree_commit_sha TEXT;`,
      `ALTER TABLE checkpoints ADD COLUMN git_ref TEXT;`,
      `ALTER TABLE checkpoints ADD COLUMN untracked_files_json TEXT DEFAULT '[]';`,
      `ALTER TABLE checkpoints ADD COLUMN session_id TEXT;`,
      `ALTER TABLE incidents ADD COLUMN severity TEXT DEFAULT 'HIGH';`,
      `ALTER TABLE incidents ADD COLUMN agent_name TEXT DEFAULT 'agent';`,
      `ALTER TABLE incidents ADD COLUMN session_id TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN approval_fingerprint_json TEXT;`,
      `ALTER TABLE agent_events ADD COLUMN session_id TEXT;`,
      `ALTER TABLE incidents ADD COLUMN expected_behavior TEXT;`,
      `ALTER TABLE incidents ADD COLUMN observed_behavior TEXT;`,
      `ALTER TABLE incidents ADD COLUMN broken_step TEXT;`,
      `ALTER TABLE incidents ADD COLUMN execution_trace_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN three_level_health_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN reproduction_condition TEXT;`,
      `ALTER TABLE incidents ADD COLUMN verification_method TEXT;`,
      `ALTER TABLE incidents ADD COLUMN verification_type TEXT;`,
      `ALTER TABLE incidents ADD COLUMN user_confirmed_intent INTEGER DEFAULT 0;`,
      `ALTER TABLE incidents ADD COLUMN user_confirmation_summary TEXT;`,
      `ALTER TABLE incidents ADD COLUMN cause_verdict TEXT;`,
      `ALTER TABLE agent_sessions ADD COLUMN version TEXT;`,
      `ALTER TABLE agent_sessions ADD COLUMN observation_scope_json TEXT;`,
      `ALTER TABLE projects ADD COLUMN verification_mode TEXT DEFAULT 'AUTO';`,
      `ALTER TABLE projects ADD COLUMN preferred_host TEXT DEFAULT 'antigravity';`,
      `ALTER TABLE incidents ADD COLUMN risk_level TEXT;`,
      `ALTER TABLE incidents ADD COLUMN risk_signals_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN orchestration_decision_json TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN patch_hash TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN risk_level TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN orchestration_review_json TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN approval_readiness TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN approval_block_reason TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN stages_json TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN three_level_health_json TEXT;`,
      `ALTER TABLE projects ADD COLUMN test_command_signature TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN verified_with_command TEXT;`,
      `ALTER TABLE projects ADD COLUMN last_quarantine_fingerprint TEXT;`,
      `ALTER TABLE projects ADD COLUMN last_quarantine_ref TEXT;`,
      `ALTER TABLE projects ADD COLUMN proposed_test_command TEXT;`,
      `ALTER TABLE projects ADD COLUMN proposed_test_command_reason TEXT;`,
      `ALTER TABLE incidents ADD COLUMN test_execution_note TEXT;`,
      `ALTER TABLE projects ADD COLUMN sensitive_paths_json TEXT DEFAULT '[]';`,
      `ALTER TABLE projects ADD COLUMN risk_threshold_lines INTEGER DEFAULT 200;`,
      `ALTER TABLE incidents ADD COLUMN severity_evidence_json TEXT DEFAULT '[]';`,
      `ALTER TABLE incidents ADD COLUMN cause_evidence_json TEXT DEFAULT '[]';`,
      `ALTER TABLE repair_proposals ADD COLUMN risk_evidence_json TEXT DEFAULT '[]';`,
      `ALTER TABLE repair_proposals ADD COLUMN self_review_checklist_json TEXT DEFAULT '[]';`,
      `ALTER TABLE projects ADD COLUMN enable_coverage INTEGER DEFAULT 0;`,
      `ALTER TABLE incidents ADD COLUMN reproduction_result_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN coverage_lines_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN user_report_text TEXT;`,
      `ALTER TABLE incidents ADD COLUMN intents_json TEXT;`,
      `ALTER TABLE incidents ADD COLUMN missing_intents_json TEXT DEFAULT '[]';`,
      `ALTER TABLE incidents ADD COLUMN change_scope_summary_json TEXT;`,
      `ALTER TABLE repair_proposals ADD COLUMN rejection_reason TEXT;`,
    ];

    for (const sql of migrations) {
      try {
        this.db.exec(sql);
      } catch {
        // Column already exists
      }
    }
  }

  /**
   * Step 2 migration: Ensures existing incidents and proposals default to UNASSESSED
   * and have non-null evidence lists.
   */
  public migrateUnassessedFields(): void {
    try {
      this.db.exec(`
        UPDATE incidents
        SET severity = 'UNASSESSED'
        WHERE severity IS NULL OR severity = '' OR (severity = 'HIGH' AND (severity_evidence_json IS NULL OR severity_evidence_json = '[]' OR severity_evidence_json = ''));

        UPDATE incidents
        SET severity_evidence_json = '["기존 데이터 마이그레이션: 미판정"]'
        WHERE severity_evidence_json IS NULL OR severity_evidence_json = '' OR severity_evidence_json = '[]';

        UPDATE incidents
        SET cause_evidence_json = '["기존 데이터 마이그레이션: 미판정"]'
        WHERE cause_evidence_json IS NULL OR cause_evidence_json = '' OR cause_evidence_json = '[]';

        UPDATE repair_proposals
        SET risk_evidence_json = '["기존 데이터 마이그레이션: 미판정"]'
        WHERE risk_evidence_json IS NULL OR risk_evidence_json = '' OR risk_evidence_json = '[]';

        UPDATE repair_proposals
        SET self_review_checklist_json = '[]'
        WHERE self_review_checklist_json IS NULL;
      `);
    } catch {}
  }

  /**
   * Executes a write function inside BEGIN IMMEDIATE with exponential backoff on SQLITE_BUSY.
   */
  public runInImmediateTransaction<T>(fn: () => T, maxRetries: number = 5): T {
    if (this.inTransaction) {
      return fn();
    }
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        this.inTransaction = true;
        this.db.exec('BEGIN IMMEDIATE;');
        const result = fn();
        this.db.exec('COMMIT;');
        this.inTransaction = false;
        return result;
      } catch (err: any) {
        this.inTransaction = false;
        try {
          this.db.exec('ROLLBACK;');
        } catch {}

        if (err.message && err.message.includes('busy') && attempt < maxRetries - 1) {
          attempt++;
          const waitMs = Math.floor(Math.random() * 50) + Math.pow(2, attempt) * 20;
          const end = Date.now() + waitMs;
          while (Date.now() < end) {}
          continue;
        }
        throw err;
      }
    }
    throw new Error('Transaction failed after maximum retries due to database busy lock.');
  }

  /**
   * Migrates legacy random project IDs to deterministic path-based IDs.
   * Merges any duplicate project entries and remaps all foreign keys (checkpoints, incidents, agent_events).
   */
  public migrateDeterministicProjectIds(): void {
    let projects: any[] = [];
    try {
      projects = this.db.prepare(`SELECT * FROM projects`).all() as any[];
    } catch {
      return;
    }
    if (!projects || projects.length === 0) return;

    try {
      this.db.exec('PRAGMA foreign_keys = OFF;');
      this.runInImmediateTransaction(() => {
        for (const p of projects) {
          if (!p.root_path) continue;
          const canonicalId = generateDeterministicProjectId(p.root_path);
          if (p.id !== canonicalId) {
            const existing = this.db.prepare(`SELECT id FROM projects WHERE id = ?`).get(canonicalId) as any;
            if (!existing) {
              this.db.prepare(`UPDATE projects SET id = ? WHERE id = ?`).run(canonicalId, p.id);
            } else {
              this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(p.id);
            }
            this.db.prepare(`UPDATE checkpoints SET project_id = ? WHERE project_id = ?`).run(canonicalId, p.id);
            this.db.prepare(`UPDATE incidents SET project_id = ? WHERE project_id = ?`).run(canonicalId, p.id);
            try {
              this.db.prepare(`UPDATE agent_events SET project_id = ? WHERE project_id = ?`).run(canonicalId, p.id);
            } catch {}
            try {
              this.db.prepare(`UPDATE directives SET project_id = ? WHERE project_id = ?`).run(canonicalId, p.id);
            } catch {}
          }
        }
      });
    } finally {
      try {
        this.db.exec('PRAGMA foreign_keys = ON;');
      } catch {}
    }
  }

  // Projects
  public upsertProject(project: Project): void {
    this.runInImmediateTransaction(() => {
      const canonicalId = generateDeterministicProjectId(project.rootPath);
      const projectId = project.id || canonicalId;
      const stmt = this.db.prepare(`
        INSERT INTO projects (
          id, name, root_path, test_command, test_command_signature,
          proposed_test_command, proposed_test_command_reason,
          verification_mode, preferred_host, sensitive_paths_json, risk_threshold_lines, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_path) DO UPDATE SET
          id = excluded.id,
          name = excluded.name,
          test_command = COALESCE(excluded.test_command, projects.test_command),
          test_command_signature = COALESCE(excluded.test_command_signature, projects.test_command_signature),
          proposed_test_command = COALESCE(excluded.proposed_test_command, projects.proposed_test_command),
          proposed_test_command_reason = COALESCE(excluded.proposed_test_command_reason, projects.proposed_test_command_reason),
          verification_mode = COALESCE(excluded.verification_mode, projects.verification_mode),
          preferred_host = COALESCE(excluded.preferred_host, projects.preferred_host),
          sensitive_paths_json = COALESCE(excluded.sensitive_paths_json, projects.sensitive_paths_json),
          risk_threshold_lines = COALESCE(excluded.risk_threshold_lines, projects.risk_threshold_lines);
      `);
      stmt.run(
        projectId,
        project.name,
        project.rootPath,
        project.testCommand || null,
        project.testCommandSignature || null,
        project.proposedTestCommand || null,
        project.proposedTestCommandReason || null,
        project.verificationMode || 'AUTO',
        project.preferredHost || 'antigravity',
        JSON.stringify(project.sensitivePaths || []),
        project.riskThresholdLines ?? 200,
        project.createdAt
      );
    });
  }

  public updateProjectProposedTestCommand(
    id: string,
    command: string | null,
    reason: string | null
  ): void {
    this.runInImmediateTransaction(() => {
      this.db
        .prepare(`
          UPDATE projects
          SET proposed_test_command = ?, proposed_test_command_reason = ?
          WHERE id = ?
        `)
        .run(command, reason, id);
    });
  }

  public updateProjectConfirmedTestCommand(
    id: string,
    command: string,
    signature: string
  ): void {
    this.runInImmediateTransaction(() => {
      this.db
        .prepare(`
          UPDATE projects
          SET test_command = ?, test_command_signature = ?,
              proposed_test_command = NULL, proposed_test_command_reason = NULL
          WHERE id = ?
        `)
        .run(command, signature, id);

      this.appendAuditLog({
        kind: 'TEST_COMMAND_CONFIRMED',
        entityType: 'PROJECT',
        entityId: id,
        payloadHash: hashAuditPayload({
          projectId: id,
          testCommand: command,
          signature,
        }),
      });
    });
  }

  public listProjects(): Project[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as any[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      testCommand: row.test_command || undefined,
      testCommandSignature: row.test_command_signature || undefined,
      proposedTestCommand: row.proposed_test_command || undefined,
      proposedTestCommandReason: row.proposed_test_command_reason || undefined,
      verificationMode: (row.verification_mode || 'AUTO') as VerificationMode,
      preferredHost: (row.preferred_host || 'antigravity') as HostEnvironment,
      sensitivePaths: row.sensitive_paths_json ? JSON.parse(row.sensitive_paths_json) : [],
      riskThresholdLines: typeof row.risk_threshold_lines === 'number' ? row.risk_threshold_lines : 200,
      enableCoverage: Boolean(row.enable_coverage),
      lastQuarantineFingerprint: row.last_quarantine_fingerprint || undefined,
      lastQuarantineRef: row.last_quarantine_ref || undefined,
      createdAt: row.created_at,
    }));
  }

  public getProject(id: string): Project | null {
    const stmt = this.db.prepare(`SELECT * FROM projects WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      testCommand: row.test_command || undefined,
      testCommandSignature: row.test_command_signature || undefined,
      proposedTestCommand: row.proposed_test_command || undefined,
      proposedTestCommandReason: row.proposed_test_command_reason || undefined,
      verificationMode: (row.verification_mode || 'AUTO') as VerificationMode,
      preferredHost: (row.preferred_host || 'antigravity') as HostEnvironment,
      sensitivePaths: row.sensitive_paths_json ? JSON.parse(row.sensitive_paths_json) : [],
      riskThresholdLines: typeof row.risk_threshold_lines === 'number' ? row.risk_threshold_lines : 200,
      enableCoverage: Boolean(row.enable_coverage),
      lastQuarantineFingerprint: row.last_quarantine_fingerprint || undefined,
      lastQuarantineRef: row.last_quarantine_ref || undefined,
      createdAt: row.created_at,
    };
  }

  public getProjectByPath(rootPath: string): Project | null {
    const canonicalId = generateDeterministicProjectId(rootPath);
    let row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(canonicalId) as any;
    if (!row) {
      row = this.db.prepare(`SELECT * FROM projects WHERE root_path = ?`).get(rootPath) as any;
    }
    if (!row) {
      try {
        const all = this.db.prepare(`SELECT * FROM projects`).all() as any[];
        const norm = normalizeRepoPath(rootPath);
        row = all.find((p) => p.root_path && normalizeRepoPath(p.root_path) === norm);
      } catch {}
    }
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      testCommand: row.test_command || undefined,
      testCommandSignature: row.test_command_signature || undefined,
      proposedTestCommand: row.proposed_test_command || undefined,
      proposedTestCommandReason: row.proposed_test_command_reason || undefined,
      verificationMode: (row.verification_mode || 'AUTO') as VerificationMode,
      preferredHost: (row.preferred_host || 'antigravity') as HostEnvironment,
      sensitivePaths: row.sensitive_paths_json ? JSON.parse(row.sensitive_paths_json) : [],
      riskThresholdLines: typeof row.risk_threshold_lines === 'number' ? row.risk_threshold_lines : 200,
      enableCoverage: Boolean(row.enable_coverage),
      lastQuarantineFingerprint: row.last_quarantine_fingerprint || undefined,
      lastQuarantineRef: row.last_quarantine_ref || undefined,
      createdAt: row.created_at,
    };
  }

  public updateProjectQuarantine(
    id: string,
    fingerprint: string | null,
    backupRef: string | null
  ): void {
    this.runInImmediateTransaction(() => {
      this.db
        .prepare(`
          UPDATE projects
          SET last_quarantine_fingerprint = ?, last_quarantine_ref = ?
          WHERE id = ?
        `)
        .run(fingerprint, backupRef, id);
    });
  }

  public updateProjectSettings(
    id: string,
    settings: {
      verificationMode?: VerificationMode;
      preferredHost?: HostEnvironment;
      testCommand?: string;
      testCommandSignature?: string;
      sensitivePaths?: string[];
      riskThresholdLines?: number;
      enableCoverage?: boolean;
    }
  ): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE projects
        SET verification_mode = COALESCE(?, verification_mode),
            preferred_host = COALESCE(?, preferred_host),
            test_command = COALESCE(?, test_command),
            test_command_signature = COALESCE(?, test_command_signature),
            sensitive_paths_json = COALESCE(?, sensitive_paths_json),
            risk_threshold_lines = COALESCE(?, risk_threshold_lines),
            enable_coverage = COALESCE(?, enable_coverage),
            proposed_test_command = CASE WHEN ? IS NOT NULL THEN NULL ELSE proposed_test_command END,
            proposed_test_command_reason = CASE WHEN ? IS NOT NULL THEN NULL ELSE proposed_test_command_reason END
        WHERE id = ?
      `);
      stmt.run(
        settings.verificationMode || null,
        settings.preferredHost || null,
        settings.testCommand || null,
        settings.testCommandSignature || null,
        settings.sensitivePaths ? JSON.stringify(settings.sensitivePaths) : null,
        typeof settings.riskThresholdLines === 'number' ? settings.riskThresholdLines : null,
        settings.enableCoverage !== undefined ? (settings.enableCoverage ? 1 : 0) : null,
        settings.testCommand || null,
        settings.testCommand || null,
        id
      );
    });
  }

  // Checkpoints
  public insertCheckpoint(cp: Checkpoint): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO checkpoints (
          id, project_id, agent_name, label, git_head_sha, git_stash_sha,
          git_index_sha, worktree_commit_sha, git_ref, changed_files_json,
          untracked_files_json, session_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        cp.id,
        cp.projectId,
        cp.agentName,
        cp.label,
        cp.gitHeadSha,
        cp.gitStashSha,
        cp.gitIndexSha || null,
        cp.worktreeCommitSha || null,
        cp.gitRef || null,
        JSON.stringify(cp.changedFiles),
        JSON.stringify(cp.untrackedFiles || []),
        cp.sessionId || null,
        cp.createdAt
      );
    });
  }

  public getCheckpoint(id: string): Checkpoint | null {
    const stmt = this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      agentName: row.agent_name,
      label: row.label,
      gitHeadSha: row.git_head_sha,
      gitStashSha: row.git_stash_sha,
      gitIndexSha: row.git_index_sha || undefined,
      worktreeCommitSha: row.worktree_commit_sha || undefined,
      gitRef: row.git_ref || undefined,
      changedFiles: JSON.parse(row.changed_files_json),
      untrackedFiles: row.untracked_files_json ? JSON.parse(row.untracked_files_json) : [],
      sessionId: row.session_id || undefined,
      createdAt: row.created_at,
    };
  }

  public getLatestCheckpoint(projectId: string): Checkpoint | null {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints 
      WHERE project_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    const row = stmt.get(projectId) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      agentName: row.agent_name,
      label: row.label,
      gitHeadSha: row.git_head_sha,
      gitStashSha: row.git_stash_sha,
      gitIndexSha: row.git_index_sha || undefined,
      worktreeCommitSha: row.worktree_commit_sha || undefined,
      gitRef: row.git_ref || undefined,
      changedFiles: JSON.parse(row.changed_files_json),
      untrackedFiles: row.untracked_files_json ? JSON.parse(row.untracked_files_json) : [],
      sessionId: row.session_id || undefined,
      createdAt: row.created_at,
    };
  }

  public listCheckpoints(projectId: string, limit: number = 20): Checkpoint[] {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints 
      WHERE project_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentName: row.agent_name,
      label: row.label,
      gitHeadSha: row.git_head_sha,
      gitStashSha: row.git_stash_sha,
      gitIndexSha: row.git_index_sha || undefined,
      worktreeCommitSha: row.worktree_commit_sha || undefined,
      gitRef: row.git_ref || undefined,
      changedFiles: JSON.parse(row.changed_files_json),
      untrackedFiles: row.untracked_files_json ? JSON.parse(row.untracked_files_json) : [],
      sessionId: row.session_id || undefined,
      createdAt: row.created_at,
    }));
  }

  // Incidents
  public insertIncident(incident: Incident): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO incidents (
          id, project_id, base_checkpoint_id, title, error_output, diff_summary,
          status, severity, severity_evidence_json, cause_evidence_json, agent_name, session_id,
          expected_behavior, observed_behavior, broken_step, execution_trace_json, three_level_health_json,
          reproduction_condition, verification_method, verification_type, user_confirmed_intent, user_confirmation_summary, cause_verdict,
          risk_level, risk_signals_json, orchestration_decision_json, test_execution_note,
          reproduction_result_json, coverage_lines_json, user_report_text, intents_json, missing_intents_json,
          change_scope_summary_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const rawScope = incident.changeScopeSummary;
      const scopeSummaryJson = rawScope ? (typeof rawScope === 'string' ? JSON.stringify(rawScope) : JSON.stringify(rawScope)) : null;
      stmt.run(
        incident.id,
        incident.projectId,
        incident.baseCheckpointId || null,
        incident.title,
        incident.errorOutput || '',
        incident.diffSummary || '',
        incident.status,
        incident.severity || 'UNASSESSED',
        JSON.stringify(incident.severityEvidence || []),
        JSON.stringify(incident.causeEvidence || []),
        incident.agentName || 'agent',
        incident.sessionId || null,
        incident.expectedBehavior || null,
        incident.observedBehavior || null,
        incident.brokenStep || null,
        incident.executionTrace ? JSON.stringify(incident.executionTrace) : null,
        incident.threeLevelHealth ? JSON.stringify(incident.threeLevelHealth) : null,
        incident.reproductionCondition || null,
        incident.verificationMethod || null,
        incident.verificationType || null,
        incident.userConfirmedIntent ? 1 : 0,
        incident.userConfirmationSummary || null,
        incident.causeVerdict || null,
        incident.riskLevel || null,
        incident.riskSignals ? JSON.stringify(incident.riskSignals) : null,
        incident.orchestrationDecision ? JSON.stringify(incident.orchestrationDecision) : null,
        incident.testExecutionNote || null,
        incident.reproductionResult ? JSON.stringify(incident.reproductionResult) : null,
        incident.coverageLines ? JSON.stringify(incident.coverageLines) : null,
        incident.userReportText || null,
        incident.intents ? JSON.stringify(incident.intents) : null,
        JSON.stringify(incident.missingIntents || []),
        scopeSummaryJson,
        incident.createdAt
      );

      this.appendAuditLog({
        kind: 'INCIDENT_REGISTERED',
        entityType: 'INCIDENT',
        entityId: incident.id,
        payloadHash: hashAuditPayload({
          projectId: incident.projectId,
          title: incident.title,
          baseCheckpointId: incident.baseCheckpointId,
          diffSummary: incident.diffSummary,
          createdAt: incident.createdAt,
        }),
        createdAt: incident.createdAt,
      });
    });
  }

  public getIncident(id: string): Incident | null {
    const stmt = this.db.prepare(`SELECT * FROM incidents WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      baseCheckpointId: row.base_checkpoint_id,
      title: row.title,
      errorOutput: row.error_output,
      diffSummary: row.diff_summary,
      status: row.status as any,
      severity: (row.severity || 'UNASSESSED') as any,
      severityEvidence: row.severity_evidence_json ? JSON.parse(row.severity_evidence_json) : [],
      causeEvidence: row.cause_evidence_json ? JSON.parse(row.cause_evidence_json) : [],
      agentName: row.agent_name || 'agent',
      sessionId: row.session_id || undefined,
      expectedBehavior: row.expected_behavior || undefined,
      observedBehavior: row.observed_behavior || undefined,
      brokenStep: row.broken_step || undefined,
      reproductionCondition: row.reproduction_condition || undefined,
      verificationMethod: row.verification_method || undefined,
      verificationType: row.verification_type || undefined,
      userConfirmedIntent: Boolean(row.user_confirmed_intent),
      userConfirmationSummary: row.user_confirmation_summary || undefined,
      causeVerdict: row.cause_verdict || undefined,
      riskLevel: row.risk_level || undefined,
      riskSignals: row.risk_signals_json ? JSON.parse(row.risk_signals_json) : undefined,
      orchestrationDecision: row.orchestration_decision_json ? JSON.parse(row.orchestration_decision_json) : undefined,
      executionTrace: row.execution_trace_json ? JSON.parse(row.execution_trace_json) : undefined,
      threeLevelHealth: row.three_level_health_json ? JSON.parse(row.three_level_health_json) : undefined,
      testExecutionNote: row.test_execution_note || undefined,
      reproductionResult: row.reproduction_result_json ? JSON.parse(row.reproduction_result_json) : undefined,
      coverageLines: row.coverage_lines_json ? JSON.parse(row.coverage_lines_json) : undefined,
      userReportText: row.user_report_text || undefined,
      intents: row.intents_json ? JSON.parse(row.intents_json) : undefined,
      missingIntents: row.missing_intents_json ? JSON.parse(row.missing_intents_json) : [],
      changeScopeSummary: row.change_scope_summary_json
        ? (() => {
            try {
              return JSON.parse(row.change_scope_summary_json);
            } catch {
              return row.change_scope_summary_json;
            }
          })()
        : undefined,
      createdAt: row.created_at,
    };
  }

  public updateIncidentChangeScopeSummary(id: string, summary: any): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`UPDATE incidents SET change_scope_summary_json = ? WHERE id = ?`);
      stmt.run(JSON.stringify(summary), id);
    });
  }

  public updateIncidentStatus(id: string, status: Incident['status']): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`UPDATE incidents SET status = ? WHERE id = ?`);
      stmt.run(status, id);
    });
  }

  public updateIncidentIntent(
    id: string,
    intent: ConfirmedIntentData,
    confirmed: boolean = true,
    summary?: string
  ): void {
    this.runInImmediateTransaction(() => {
      const updates: string[] = ['user_confirmed_intent = ?'];
      const values: any[] = [confirmed ? 1 : 0];

      if (intent.expectedBehavior !== undefined) {
        updates.push('expected_behavior = ?');
        values.push(intent.expectedBehavior);
      }
      if (intent.observedBehavior !== undefined) {
        updates.push('observed_behavior = ?');
        values.push(intent.observedBehavior);
      }
      if (intent.reproductionCondition !== undefined) {
        updates.push('reproduction_condition = ?');
        values.push(intent.reproductionCondition);
      }
      if (intent.verificationMethod !== undefined) {
        updates.push('verification_method = ?');
        values.push(intent.verificationMethod);
      }
      if (summary !== undefined) {
        updates.push('user_confirmation_summary = ?');
        values.push(summary);
      }

      values.push(id);
      const stmt = this.db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...values);
    });
  }

  public updateIncidentReproduction(
    id: string,
    reproduction: ReproductionResult,
    causeVerdict?: CauseVerdict,
    causeEvidence?: string[]
  ): void {
    this.runInImmediateTransaction(() => {
      const updates = ['reproduction_result_json = ?'];
      const values: any[] = [JSON.stringify(reproduction)];

      if (causeVerdict !== undefined) {
        updates.push('cause_verdict = ?');
        values.push(causeVerdict);
      }
      if (causeEvidence !== undefined) {
        updates.push('cause_evidence_json = ?');
        values.push(JSON.stringify(causeEvidence));
      }

      values.push(id);
      const updateStmt = this.db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE id = ?`);
      updateStmt.run(...values);
    });
  }

  public listIncidents(projectId: string, limit: number = 20): Incident[] {
    const stmt = this.db.prepare(`
      SELECT * FROM incidents 
      WHERE project_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      baseCheckpointId: row.base_checkpoint_id,
      title: row.title,
      errorOutput: row.error_output,
      diffSummary: row.diff_summary,
      status: row.status as any,
      severity: (row.severity || 'UNASSESSED') as any,
      severityEvidence: row.severity_evidence_json ? JSON.parse(row.severity_evidence_json) : [],
      causeEvidence: row.cause_evidence_json ? JSON.parse(row.cause_evidence_json) : [],
      agentName: row.agent_name || 'agent',
      sessionId: row.session_id || undefined,
      expectedBehavior: row.expected_behavior || undefined,
      observedBehavior: row.observed_behavior || undefined,
      brokenStep: row.broken_step || undefined,
      reproductionCondition: row.reproduction_condition || undefined,
      verificationMethod: row.verification_method || undefined,
      verificationType: row.verification_type || undefined,
      userConfirmedIntent: Boolean(row.user_confirmed_intent),
      userConfirmationSummary: row.user_confirmation_summary || undefined,
      causeVerdict: row.cause_verdict || undefined,
      riskLevel: row.risk_level || undefined,
      riskSignals: row.risk_signals_json ? JSON.parse(row.risk_signals_json) : undefined,
      orchestrationDecision: row.orchestration_decision_json ? JSON.parse(row.orchestration_decision_json) : undefined,
      executionTrace: row.execution_trace_json ? JSON.parse(row.execution_trace_json) : undefined,
      threeLevelHealth: row.three_level_health_json ? JSON.parse(row.three_level_health_json) : undefined,
      testExecutionNote: row.test_execution_note || undefined,
      reproductionResult: row.reproduction_result_json ? JSON.parse(row.reproduction_result_json) : undefined,
      coverageLines: row.coverage_lines_json ? JSON.parse(row.coverage_lines_json) : undefined,
      userReportText: row.user_report_text || undefined,
      intents: row.intents_json ? JSON.parse(row.intents_json) : undefined,
      missingIntents: row.missing_intents_json ? JSON.parse(row.missing_intents_json) : [],
      changeScopeSummary: row.change_scope_summary_json
        ? (() => {
            try {
              return JSON.parse(row.change_scope_summary_json);
            } catch {
              return row.change_scope_summary_json;
            }
          })()
        : undefined,
      createdAt: row.created_at,
    }));
  }

  // Agent Sessions
  public recordAgentHeartbeat(agentName: string, sessionId?: string, lastAction: string = 'ACTIVE', clientInfo?: string, version?: string): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO agent_sessions (agent_name, session_id, last_seen_at, status, last_action, client_info, version, observation_scope_json)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
        ON CONFLICT(agent_name) DO UPDATE SET
          session_id = excluded.session_id,
          last_seen_at = excluded.last_seen_at,
          status = 'ACTIVE',
          last_action = excluded.last_action,
          client_info = COALESCE(excluded.client_info, agent_sessions.client_info),
          version = COALESCE(excluded.version, agent_sessions.version),
          observation_scope_json = excluded.observation_scope_json
      `);
      const scopes = ['MCP_CALLS', 'FILE_WATCH', 'EXEC_EVENTS'];
      stmt.run(agentName, sessionId || null, new Date().toISOString(), lastAction, clientInfo || null, version || 'v1.0.0', JSON.stringify(scopes));
    });
  }

  public listAgentSessions(): AgentSession[] {
    const stmt = this.db.prepare(`SELECT * FROM agent_sessions ORDER BY last_seen_at DESC`);
    const rows = stmt.all() as any[];
    const now = Date.now();
    return rows.map((r) => {
      const diffMs = now - new Date(r.last_seen_at).getTime();
      const status: 'ACTIVE' | 'IDLE' = diffMs < 1000 * 60 * 15 ? 'ACTIVE' : 'IDLE';
      return {
        agentName: r.agent_name,
        sessionId: r.session_id || undefined,
        version: r.version || 'v1.0.0',
        lastSeenAt: r.last_seen_at,
        status,
        lastAction: r.last_action,
        clientInfo: r.client_info || undefined,
        observationScope: r.observation_scope_json ? JSON.parse(r.observation_scope_json) : ['MCP_CALLS', 'FILE_WATCH'],
      };
    });
  }

  public getActiveIncidentsCount(projectId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM incidents 
      WHERE project_id = ? AND status != 'RESOLVED'
    `);
    const row = stmt.get(projectId) as any;
    return row ? Number(row.count) : 0;
  }

  // Repair Proposals
  public insertRepairProposal(proposal: RepairProposal): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO repair_proposals (
          id, incident_id, root_cause_analysis, patch_diff, touched_files_json,
          file_changes_json, verification_status, verification_log, approval_status,
          rejection_reason,
          approval_fingerprint_json, approved_at, applied_at,
          patch_hash, risk_level, risk_evidence_json, self_review_checklist_json,
          orchestration_review_json, approval_readiness, approval_block_reason,
          stages_json, three_level_health_json, verified_with_command,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        proposal.id,
        proposal.incidentId,
        proposal.rootCauseAnalysis,
        proposal.patchDiff,
        JSON.stringify(proposal.touchedFiles),
        proposal.fileChangesJson,
        proposal.verificationStatus,
        proposal.verificationLog,
        proposal.approvalStatus,
        proposal.rejectionReason || null,
        proposal.approvalFingerprintJson || null,
        proposal.approvedAt,
        proposal.appliedAt,
        proposal.patchHash || null,
        proposal.riskLevel || null,
        JSON.stringify(proposal.riskEvidence || []),
        JSON.stringify(proposal.selfReviewChecklist || []),
        proposal.orchestrationReview ? JSON.stringify(proposal.orchestrationReview) : null,
        proposal.approvalReadiness || 'READY_FOR_APPROVAL',
        proposal.approvalBlockReason || null,
        proposal.stages ? JSON.stringify(proposal.stages) : null,
        proposal.threeLevelHealth ? JSON.stringify(proposal.threeLevelHealth) : null,
        proposal.verifiedWithCommand || null,
        proposal.createdAt
      );

      this.appendAuditLog({
        kind: 'PROPOSAL_CREATED',
        entityType: 'PROPOSAL',
        entityId: proposal.id,
        payloadHash: hashAuditPayload({
          incidentId: proposal.incidentId,
          patchHash: proposal.patchHash,
          verificationStatus: proposal.verificationStatus,
          fileChangesJson: proposal.fileChangesJson,
          createdAt: proposal.createdAt,
        }),
        createdAt: proposal.createdAt,
      });
    });
  }

  public getRepairProposal(id: string): RepairProposal | null {
    const stmt = this.db.prepare(`SELECT * FROM repair_proposals WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      incidentId: row.incident_id,
      rootCauseAnalysis: row.root_cause_analysis,
      patchDiff: row.patch_diff,
      patchHash: row.patch_hash || undefined,
      riskLevel: (row.risk_level as RiskLevel) || undefined,
      riskEvidence: row.risk_evidence_json ? JSON.parse(row.risk_evidence_json) : [],
      selfReviewChecklist: row.self_review_checklist_json ? JSON.parse(row.self_review_checklist_json) : [],
      touchedFiles: JSON.parse(row.touched_files_json),
      fileChangesJson: row.file_changes_json,
      verificationStatus: row.verification_status as VerificationStatus,
      verificationLog: row.verification_log,
      approvalStatus: row.approval_status as ApprovalStatus,
      rejectionReason: row.rejection_reason || undefined,
      approvalReadiness: (row.approval_readiness as ApprovalReadiness) || undefined,
      approvalBlockReason: row.approval_block_reason || undefined,
      orchestrationReview: row.orchestration_review_json ? JSON.parse(row.orchestration_review_json) : undefined,
      approvalFingerprintJson: row.approval_fingerprint_json || null,
      approvedAt: row.approved_at,
      appliedAt: row.applied_at,
      stages: row.stages_json ? JSON.parse(row.stages_json) : undefined,
      threeLevelHealth: row.three_level_health_json ? JSON.parse(row.three_level_health_json) : undefined,
      verifiedWithCommand: row.verified_with_command || undefined,
      createdAt: row.created_at,
    };
  }

  public updateProposalOrchestrationReview(
    id: string,
    review: OrchestrationReview,
    approvalReadiness: ApprovalReadiness,
    approvalBlockReason?: string | null
  ): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE repair_proposals
        SET orchestration_review_json = ?,
            approval_readiness = ?,
            approval_block_reason = ?
        WHERE id = ?
      `);
      stmt.run(JSON.stringify(review), approvalReadiness, approvalBlockReason || null, id);
    });
  }

  public updateProposalVerification(
    id: string,
    status: VerificationStatus,
    log: string,
    approvalReadiness?: ApprovalReadiness,
    approvalBlockReason?: string | null
  ): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        UPDATE repair_proposals 
        SET verification_status = ?,
            verification_log = ?,
            approval_readiness = COALESCE(?, approval_readiness),
            approval_block_reason = COALESCE(?, approval_block_reason)
        WHERE id = ?
      `);
      stmt.run(status, log, approvalReadiness || null, approvalBlockReason || null, id);
    });
  }

  public updateProposalApproval(
    id: string,
    status: ApprovalStatus,
    fingerprintOrReason?: ApprovalFingerprint | string | null,
    timestamp: string = new Date().toISOString()
  ): void {
    this.runInImmediateTransaction(() => {
      let fpJson: string | null = null;
      let reason: string | null = null;
      if (typeof fingerprintOrReason === 'string') {
        reason = fingerprintOrReason;
      } else if (fingerprintOrReason) {
        fpJson = JSON.stringify(fingerprintOrReason);
      }
      if (status === 'APPROVED') {
        const stmt = this.db.prepare(`
          UPDATE repair_proposals 
          SET approval_status = ?, approved_at = ?, approval_fingerprint_json = COALESCE(?, approval_fingerprint_json)
          WHERE id = ?
        `);
        stmt.run(status, timestamp, fpJson, id);

        this.appendAuditLog({
          kind: 'PROPOSAL_APPROVED',
          entityType: 'PROPOSAL',
          entityId: id,
          payloadHash: hashAuditPayload({
            proposalId: id,
            approvalStatus: 'APPROVED',
            fingerprint: fpJson,
            approvedAt: timestamp,
          }),
          createdAt: timestamp,
        });
      } else if (status === 'APPLIED') {
        const stmt = this.db.prepare(`
          UPDATE repair_proposals 
          SET approval_status = ?, applied_at = ? 
          WHERE id = ?
        `);
        stmt.run(status, timestamp, id);

        this.appendAuditLog({
          kind: 'REPAIR_APPLIED',
          entityType: 'PROPOSAL',
          entityId: id,
          payloadHash: hashAuditPayload({
            proposalId: id,
            approvalStatus: 'APPLIED',
            appliedAt: timestamp,
          }),
          createdAt: timestamp,
        });
      } else if (status === 'REJECTED') {
        const stmt = this.db.prepare(`
          UPDATE repair_proposals 
          SET approval_status = ?, rejection_reason = ? 
          WHERE id = ?
        `);
        stmt.run(status, reason, id);

        this.appendAuditLog({
          kind: 'PROPOSAL_REJECTED',
          entityType: 'PROPOSAL',
          entityId: id,
          payloadHash: hashAuditPayload({
            proposalId: id,
            approvalStatus: 'REJECTED',
            rejectionReason: reason || '',
          }),
          createdAt: timestamp,
        });
      } else if (status === 'TAMPERED') {
        const stmt = this.db.prepare(`
          UPDATE repair_proposals 
          SET approval_status = ? 
          WHERE id = ?
        `);
        stmt.run(status, id);

        this.appendAuditLog({
          kind: 'TAMPERED_DETECTED',
          entityType: 'PROPOSAL',
          entityId: id,
          payloadHash: hashAuditPayload({
            proposalId: id,
            approvalStatus: 'TAMPERED',
            reason: reason || '',
          }),
          createdAt: timestamp,
        });
      } else {
        const stmt = this.db.prepare(`
          UPDATE repair_proposals 
          SET approval_status = ? 
          WHERE id = ?
        `);
        stmt.run(status, id);
      }
    });
  }

  public listProposalsForIncident(incidentId: string): RepairProposal[] {
    const stmt = this.db.prepare(`
      SELECT * FROM repair_proposals 
      WHERE incident_id = ? 
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(incidentId) as any[];
    return rows.map((row) => ({
      id: row.id,
      incidentId: row.incident_id,
      rootCauseAnalysis: row.root_cause_analysis,
      patchDiff: row.patch_diff,
      patchHash: row.patch_hash || undefined,
      riskLevel: (row.risk_level as RiskLevel) || undefined,
      riskEvidence: row.risk_evidence_json ? JSON.parse(row.risk_evidence_json) : [],
      selfReviewChecklist: row.self_review_checklist_json ? JSON.parse(row.self_review_checklist_json) : [],
      touchedFiles: JSON.parse(row.touched_files_json),
      fileChangesJson: row.file_changes_json,
      verificationStatus: row.verification_status as VerificationStatus,
      verificationLog: row.verification_log,
      approvalStatus: row.approval_status as ApprovalStatus,
      rejectionReason: row.rejection_reason || undefined,
      approvalReadiness: (row.approval_readiness as ApprovalReadiness) || undefined,
      approvalBlockReason: row.approval_block_reason || undefined,
      orchestrationReview: row.orchestration_review_json ? JSON.parse(row.orchestration_review_json) : undefined,
      approvalFingerprintJson: row.approval_fingerprint_json || null,
      approvedAt: row.approved_at,
      appliedAt: row.applied_at,
      stages: row.stages_json ? JSON.parse(row.stages_json) : undefined,
      threeLevelHealth: row.three_level_health_json ? JSON.parse(row.three_level_health_json) : undefined,
      verifiedWithCommand: row.verified_with_command || undefined,
      createdAt: row.created_at,
    }));
  }

  public listProposalsForProject(projectId: string, limit: number = 100): RepairProposal[] {
    const stmt = this.db.prepare(`
      SELECT p.* FROM repair_proposals p
      JOIN incidents i ON i.id = p.incident_id
      WHERE i.project_id = ?
      ORDER BY p.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      incidentId: row.incident_id,
      rootCauseAnalysis: row.root_cause_analysis,
      patchDiff: row.patch_diff,
      patchHash: row.patch_hash || undefined,
      riskLevel: (row.risk_level as RiskLevel) || undefined,
      riskEvidence: row.risk_evidence_json ? JSON.parse(row.risk_evidence_json) : [],
      selfReviewChecklist: row.self_review_checklist_json ? JSON.parse(row.self_review_checklist_json) : [],
      touchedFiles: JSON.parse(row.touched_files_json),
      fileChangesJson: row.file_changes_json,
      verificationStatus: row.verification_status as VerificationStatus,
      verificationLog: row.verification_log,
      approvalStatus: row.approval_status as ApprovalStatus,
      rejectionReason: row.rejection_reason || undefined,
      approvalReadiness: (row.approval_readiness as ApprovalReadiness) || undefined,
      approvalBlockReason: row.approval_block_reason || undefined,
      orchestrationReview: row.orchestration_review_json ? JSON.parse(row.orchestration_review_json) : undefined,
      approvalFingerprintJson: row.approval_fingerprint_json || null,
      approvedAt: row.approved_at,
      appliedAt: row.applied_at,
      stages: row.stages_json ? JSON.parse(row.stages_json) : undefined,
      threeLevelHealth: row.three_level_health_json ? JSON.parse(row.three_level_health_json) : undefined,
      verifiedWithCommand: row.verified_with_command || undefined,
      createdAt: row.created_at,
    }));
  }

  // Agent events
  public insertAgentEvent(ev: AgentEvent): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO agent_events (id, project_id, agent_name, session_id, kind, title, detail, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(ev.id, ev.projectId, ev.agentName, ev.sessionId || null, ev.kind, ev.title, ev.detail, ev.filePath, ev.createdAt);
    });
  }

  public listAgentEvents(projectId: string, limit: number = 200): AgentEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM agent_events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      agentName: row.agent_name,
      sessionId: row.session_id || undefined,
      kind: row.kind as AgentEventKind,
      title: row.title,
      detail: row.detail,
      filePath: row.file_path,
      createdAt: row.created_at,
    }));
  }

  // Directives
  private mapDirectiveRow(row: any): AgentDirective {
    return {
      id: row.id,
      projectId: row.project_id,
      incidentId: row.incident_id || undefined,
      proposalId: row.proposal_id || undefined,
      patchHash: row.patch_hash || undefined,
      kind: row.kind as DirectiveKind,
      feedbackText: row.feedback_text || undefined,
      confirmedIntent: row.confirmed_intent_json ? JSON.parse(row.confirmed_intent_json) : undefined,
      deliveryStatus: row.delivery_status as DirectiveDeliveryStatus,
      resumeMethod: row.resume_method || undefined,
      manualPromptSnippet: row.manual_prompt_snippet || undefined,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at || undefined,
      acknowledgedAt: row.acknowledged_at || undefined,
    };
  }

  public insertDirective(d: AgentDirective): void {
    this.runInImmediateTransaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO directives (
          id, project_id, incident_id, proposal_id, patch_hash, kind,
          feedback_text, confirmed_intent_json, delivery_status, resume_method,
          manual_prompt_snippet, created_at, delivered_at, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        d.id,
        d.projectId,
        d.incidentId || null,
        d.proposalId || null,
        d.patchHash || null,
        d.kind,
        d.feedbackText || null,
        d.confirmedIntent ? JSON.stringify(d.confirmedIntent) : null,
        d.deliveryStatus,
        d.resumeMethod || null,
        d.manualPromptSnippet || null,
        d.createdAt,
        d.deliveredAt || null,
        d.acknowledgedAt || null
      );
    });
  }

  public getDirective(id: string): AgentDirective | null {
    const stmt = this.db.prepare(`SELECT * FROM directives WHERE id = ?`);
    const row = stmt.get(id) as any;
    return row ? this.mapDirectiveRow(row) : null;
  }

  public listDirectivesByProject(projectId: string, limit: number = 100): AgentDirective[] {
    const stmt = this.db.prepare(`
      SELECT * FROM directives WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as any[];
    return rows.map((r) => this.mapDirectiveRow(r));
  }

  public listPendingDirectives(projectId: string): AgentDirective[] {
    const stmt = this.db.prepare(`
      SELECT * FROM directives
      WHERE project_id = ? AND delivery_status NOT IN ('ACKNOWLEDGED')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(projectId) as any[];
    return rows.map((r) => this.mapDirectiveRow(r));
  }

  public updateDirectiveStatus(
    id: string,
    status: DirectiveDeliveryStatus,
    extra?: {
      deliveredAt?: string;
      acknowledgedAt?: string;
      resumeMethod?: 'HOST_AUTO' | 'MANUAL_COPY_PROMPT';
      manualPromptSnippet?: string;
    }
  ): void {
    this.runInImmediateTransaction(() => {
      const updates: string[] = ['delivery_status = ?'];
      const values: any[] = [status];

      if (extra?.deliveredAt !== undefined) {
        updates.push('delivered_at = ?');
        values.push(extra.deliveredAt);
      }
      if (extra?.acknowledgedAt !== undefined) {
        updates.push('acknowledged_at = ?');
        values.push(extra.acknowledgedAt);
      }
      if (extra?.resumeMethod !== undefined) {
        updates.push('resume_method = ?');
        values.push(extra.resumeMethod);
      }
      if (extra?.manualPromptSnippet !== undefined) {
        updates.push('manual_prompt_snippet = ?');
        values.push(extra.manualPromptSnippet);
      }

      values.push(id);
      const stmt = this.db.prepare(`UPDATE directives SET ${updates.join(', ')} WHERE id = ?`);
      stmt.run(...values);
    });
  }

  // --- Audit Log Hash Chain (Tamper-Evident) ---

  /**
   * Appends a new audit log entry inside an immediate transaction, maintaining the cryptographic hash chain.
   */
  public appendAuditLog(entry: {
    kind: string;
    entityType: string;
    entityId: string;
    payloadHash: string;
    createdAt?: string;
  }): AuditLogEntry {
    return this.runInImmediateTransaction(() => {
      const createdAt = entry.createdAt || new Date().toISOString();
      const lastRow = this.db
        .prepare('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1')
        .get() as { seq: number; entry_hash: string } | undefined;

      const seq = lastRow ? Number(lastRow.seq) + 1 : 1;
      const prevHash = lastRow ? String(lastRow.entry_hash) : GENESIS_PREV_HASH;
      const secret = getInstallationSecretKey();
      const entryHash = computeAuditEntryHash(secret, {
        prev_hash: prevHash,
        seq,
        created_at: createdAt,
        kind: entry.kind,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        payload_hash: entry.payloadHash,
      });

      this.db
        .prepare(`
          INSERT INTO audit_log (seq, created_at, kind, entity_type, entity_id, payload_hash, prev_hash, entry_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(seq, createdAt, entry.kind, entry.entityType, entry.entityId, entry.payloadHash, prevHash, entryHash);

      return {
        seq,
        createdAt,
        kind: entry.kind,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payloadHash: entry.payloadHash,
        prevHash,
        entryHash,
      };
    });
  }

  /**
   * Retrieves recent audit log entries ordered by sequence descending.
   */
  public getAuditLogs(limit: number = 100): AuditLogEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit) as any[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      createdAt: String(r.created_at),
      kind: String(r.kind),
      entityType: String(r.entity_type),
      entityId: String(r.entity_id),
      payloadHash: String(r.payload_hash),
      prevHash: String(r.prev_hash),
      entryHash: String(r.entry_hash),
    }));
  }

  /**
   * Verifies the cryptographic integrity of the entire audit log chain.
   * Recalculates HMAC for every row from sequence 1 to N.
   * Returns OK and item count if valid, or the first broken seq and reason ('값 변경' | '항목 삭제/순서 변경' | '키 불일치').
   */
  public verifyAuditChain(overrideSecret?: string): AuditChainVerificationResult {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all() as any[];
    if (rows.length === 0) {
      return {
        valid: true,
        status: 'OK',
        totalCount: 0,
        message: '감사 기록이 비어 있습니다 (0개 항목).',
      };
    }

    const secret = overrideSecret || getInstallationSecretKey();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const seq = Number(row.seq);
      const expectedSeq = i + 1;

      // 1. Sequence number check
      if (seq !== expectedSeq) {
        return {
          valid: false,
          status: 'BROKEN',
          totalCount: rows.length,
          brokenSeq: expectedSeq,
          reason: '항목 삭제/순서 변경',
          reasonCode: 'ORDER_OR_DELETION',
          message: `감사 기록의 일련번호 불일치 (기대: seq ${expectedSeq}, 실제: seq ${seq}). 항목 삭제 또는 순서 변경이 감지되었습니다.`,
        };
      }

      // 2. prev_hash continuity check
      const expectedPrevHash = i === 0 ? GENESIS_PREV_HASH : String(rows[i - 1].entry_hash);
      if (String(row.prev_hash) !== expectedPrevHash) {
        return {
          valid: false,
          status: 'BROKEN',
          totalCount: rows.length,
          brokenSeq: seq,
          reason: '항목 삭제/순서 변경',
          reasonCode: 'ORDER_OR_DELETION',
          message: `감사 기록 해시 체인 단절 (seq ${seq}). 이전 항목의 해시값과 일치하지 않아 항목 삭제 또는 변조가 감지되었습니다.`,
        };
      }

      // 3. HMAC entry_hash check
      const expectedEntryHash = computeAuditEntryHash(secret, {
        prev_hash: String(row.prev_hash),
        seq,
        created_at: String(row.created_at),
        kind: String(row.kind),
        entity_type: String(row.entity_type),
        entity_id: String(row.entity_id),
        payload_hash: String(row.payload_hash),
      });

      if (String(row.entry_hash) !== expectedEntryHash) {
        // Distinguish KEY_MISMATCH vs VALUE_MODIFIED
        if (i === 0) {
          // If first row fails, check if ANY row in the chain matches this secret
          const anyMatches = rows.some((r) => {
            const h = computeAuditEntryHash(secret, {
              prev_hash: String(r.prev_hash),
              seq: Number(r.seq),
              created_at: String(r.created_at),
              kind: String(r.kind),
              entity_type: String(r.entity_type),
              entity_id: String(r.entity_id),
              payload_hash: String(r.payload_hash),
            });
            return h === String(r.entry_hash);
          });

          if (!anyMatches) {
            return {
              valid: false,
              status: 'BROKEN',
              totalCount: rows.length,
              brokenSeq: seq,
              reason: '키 불일치',
              reasonCode: 'KEY_MISMATCH',
              message: `감사 기록 서명 키 불일치 (seq ${seq}). 다른 설치 환경의 데이터이거나 서명 키(.auth_secret)가 일치하지 않습니다.`,
            };
          }
        }

        return {
          valid: false,
          status: 'BROKEN',
          totalCount: rows.length,
          brokenSeq: seq,
          reason: '값 변경',
          reasonCode: 'VALUE_MODIFIED',
          message: `감사 기록 값 변조 감지 (seq ${seq}). 데이터 필드 또는 해시값이 수정되었습니다.`,
        };
      }
    }

    return {
      valid: true,
      status: 'OK',
      totalCount: rows.length,
      message: `감사 기록 해시 체인 검증 통과 (총 ${rows.length}개 항목 무결성 확인).`,
    };
  }

  public close(): void {
    this.db.close();
  }
}
