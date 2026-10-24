import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AutopsyDatabase } from './db/database.js';
import { GitEngine } from './git/git-engine.js';
import { PatchEngine } from './patch/patch-engine.js';
import { WorktreeRunner, TestExecutionResult } from './runner/worktree-runner.js';
import { AutoBaselineWatcher } from './watcher/auto-watcher.js';
import { sendWindowsToast } from './notifications/toast.js';
import {
  resolveDataDir,
  resolveCacheDir,
  generateDeterministicProjectId,
  normalizeRepoPath,
} from './utils/paths.js';
import {
  getInstallationSecretKey,
  signApprovalPayload,
  verifyApprovalSignature,
  hashFileChanges,
  signTestCommand,
  verifyTestCommandSignature,
} from './utils/security.js';
import {
  Project,
  Checkpoint,
  Incident,
  RepairProposal,
  FileChange,
  ProjectHealth,
  AgentEvent,
  AgentEventKind,
  TimelineEvent,
  ProjectOverview,
  ApprovalFingerprint,
  VerificationMode,
  RiskLevel,
  OrchestrationReviewStatus,
  ApprovalReadiness,
  HostEnvironment,
  OrchestrationReview,
  OrchestrationDecision,
  CauseVerdict,
  ThreeLevelHealth,
  HealthLevelStatus,
  ReviewChallenge,
  AgentDirective,
  DirectiveKind,
  DirectiveDeliveryStatus,
  ConfirmedIntentData,
  DiscoveredCommands,
  ThreeStageExecutionResult,
  DiagnosticItem,
  ProjectDiagnostics,
  OnboardingResult,
  OnboardingPreview,
  RuntimeInfo,
  WorkspaceComparison,
} from './types.js';
import { analyzeIncident, IncidentAnalysis, parseUnifiedDiff } from './analysis/analyzer.js';

function parseUnifiedDiffFiles(diff: string): string[] {
  return parseUnifiedDiff(diff).map((f) => f.filePath);
}

function firstMeaningfulLine(text: string): string {
  const line = (text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? '').slice(0, 140);
}

export interface CoreManagerOptions {
  customDbPath?: string;
  defaultTestCommand?: string;
}

export class CoreManager {
  private db: AutopsyDatabase;
  private gitEngine: GitEngine;
  private patchEngine: PatchEngine;
  private worktreeRunner: WorktreeRunner;
  private watchers = new Map<string, AutoBaselineWatcher>();
  private changeListeners = new Set<(type: string, data: any) => void>();
  private isApplyingApprovedPatch = false;
  private quarantineCache = new Map<string, { fingerprint: string; backupRef: string }>();
  private activeWaiters = new Map<
    string,
    {
      resolve: (val: any) => void;
      timer: NodeJS.Timeout;
      proposalId: string;
      repoPath: string;
    }
  >();

  constructor(options: CoreManagerOptions = {}) {
    this.gitEngine = new GitEngine();
    this.patchEngine = new PatchEngine();
    this.worktreeRunner = new WorktreeRunner();

    const dataDir = resolveDataDir();
    const dbPath =
      options.customDbPath ||
      path.resolve(dataDir, 'autopsy.db');
    this.db = new AutopsyDatabase(dbPath);
  }

  public getDatabase(): AutopsyDatabase {
    return this.db;
  }

  public getWorktreeRunner(): WorktreeRunner {
    return this.worktreeRunner;
  }

  public getActivePort(): number {
    if (process.env.PORT) return Number(process.env.PORT);
    try {
      const dataDir = resolveDataDir();
      const runtimePath = path.join(dataDir, 'runtime.json');
      if (fs.existsSync(runtimePath)) {
        const info = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
        if (info.port) return Number(info.port);
      }
    } catch {}
    return 3847;
  }

  public subscribe(fn: (type: string, data: any) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  private emitChange(type: string, data: any = {}) {
    for (const listener of this.changeListeners) {
      try {
        listener(type, data);
      } catch {
        // Ignored
      }
    }

    // Cross-process ping to Agent Autopsy local server so Electron UI updates instantly
    try {
      const payload = JSON.stringify({ type, data });
      const targetPort = this.getActivePort();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: '/api/internal/notify',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 400,
        },
        () => {}
      );
      req.on('error', () => {}); // Server may not be running yet
      req.write(payload);
      req.end();
    } catch {}
  }

  /**
   * Safely discovers available build/test commands and scripts in a project,
   * flagging dangerous commands and recommending safe defaults.
   */
  public discoverSafeTestCommands(repoPath: string): DiscoveredCommands {
    let rootPath = repoPath;
    const knownManifests = [
      'package.json',
      'Cargo.toml',
      'pyproject.toml',
      'pytest.ini',
      'requirements.txt',
      'setup.py',
      'setup.cfg',
      'conftest.py',
      'CMakeLists.txt',
      'Makefile',
      'makefile',
      'GNUmakefile',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
    ];
    const hasLocalIndicators = () => {
      if (knownManifests.some((m) => fs.existsSync(path.join(repoPath, m)))) return true;
      if (fs.existsSync(path.join(repoPath, 'tests')) || fs.existsSync(path.join(repoPath, 'test'))) return true;
      try {
        const files = fs.readdirSync(repoPath);
        if (files.some((f) => /\.(py|js|ts|go|rs|java|c|cpp|h|hpp|txt|md)$/i.test(f))) return true;
      } catch {}
      return false;
    };

    if (!hasLocalIndicators()) {
      try {
        rootPath = this.gitEngine.getRepoRoot(repoPath);
      } catch {
        rootPath = repoPath;
      }
    }
    const warnings: string[] = [];
    const availableScripts: Record<string, string> = {};
    let isCommandSafe = true;
    let projectType: 'node' | 'python' | 'rust' | 'c_cpp' | 'go' | 'java' | 'unknown' = 'unknown';
    let fullRegressionCmd: string | undefined;
    let codeCheckCmd: string | undefined;
    let targetTestCmd: string | undefined;

    const isWindows = process.platform === 'win32';
    const dangerousPattern = /(\brm\s+-rf\b|\brmdir\s+\/s\b|\bdel\s+\/f\b|\bformat\b|\bcurl\b.*\|\s*\bsh\b|\bwget\b.*\|\s*\bsh\b)/i;

    // 1. Node.js detection
    const pkgPath = path.join(rootPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      projectType = 'node';
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts && typeof pkg.scripts === 'object') {
          for (const [name, script] of Object.entries(pkg.scripts)) {
            const scriptStr = String(script);
            availableScripts[name] = scriptStr;
            if (dangerousPattern.test(scriptStr)) {
              isCommandSafe = false;
              warnings.push(`스크립트 "${name}"에 위험한 시스템 삭제 또는 셸 다운로드 명령이 포함되어 있습니다: ${scriptStr}`);
            }
          }
        }
      } catch {
        warnings.push('package.json 파싱 중 오류가 발생했습니다.');
      }

      if (availableScripts.test && !availableScripts.test.includes('no test specified')) {
        fullRegressionCmd = isWindows ? 'npm.cmd test' : 'npm test';
      }

      if (availableScripts.typecheck) {
        codeCheckCmd = isWindows ? 'npm.cmd run typecheck' : 'npm run typecheck';
      } else if (availableScripts.check) {
        codeCheckCmd = isWindows ? 'npm.cmd run check' : 'npm run check';
      } else if (availableScripts.lint) {
        codeCheckCmd = isWindows ? 'npm.cmd run lint' : 'npm run lint';
      }

      // Check for candidate test files
      const testDirs = ['test', 'tests', '__tests__'];
      for (const tDir of testDirs) {
        const fullTDir = path.join(rootPath, tDir);
        if (fs.existsSync(fullTDir)) {
          try {
            const files = fs.readdirSync(fullTDir);
            const testFile = files.find((f) => /\.(test|spec)\.(js|mjs|cjs|ts)$/i.test(f) || /test.*\.js$/i.test(f));
            if (testFile) {
              targetTestCmd = `node "${path.join(tDir, testFile)}"`;
              break;
            }
          } catch {}
        }
      }
    } else {
      // Check Python detection
      const pyprojectPath = path.join(rootPath, 'pyproject.toml');
      const pytestIniPath = path.join(rootPath, 'pytest.ini');
      const setupCfgPath = path.join(rootPath, 'setup.cfg');
      const conftestPath = path.join(rootPath, 'conftest.py');
      const requirementsPath = path.join(rootPath, 'requirements.txt');
      const setupPyPath = path.join(rootPath, 'setup.py');

      let hasPyprojectPytest = false;
      if (fs.existsSync(pyprojectPath)) {
        try {
          const content = fs.readFileSync(pyprojectPath, 'utf8');
          if (content.includes('[tool.pytest')) {
            hasPyprojectPytest = true;
          }
        } catch {}
      }

      let hasSetupCfgPytest = false;
      if (fs.existsSync(setupCfgPath)) {
        try {
          const content = fs.readFileSync(setupCfgPath, 'utf8');
          if (content.includes('[tool:pytest')) {
            hasSetupCfgPytest = true;
          }
        } catch {}
      }

      const hasExplicitPytestConfig =
        fs.existsSync(pytestIniPath) ||
        fs.existsSync(conftestPath) ||
        hasPyprojectPytest ||
        hasSetupCfgPytest;

      // Check for python test files in tests/ or root
      let hasTestsFolder = false;
      let hasTestFilesInTests = false;
      for (const tDir of ['tests', 'test']) {
        const p = path.join(rootPath, tDir);
        if (fs.existsSync(p)) {
          try {
            const files = fs.readdirSync(p);
            if (files.some((f) => /^test.*\.py$/i.test(f) || /.*_test\.py$/i.test(f))) {
              hasTestsFolder = true;
              hasTestFilesInTests = true;
              targetTestCmd = `python -m unittest ${tDir}/${files.find((f) => /^test.*\.py$/i.test(f) || /.*_test\.py$/i.test(f))}`;
              break;
            }
          } catch {}
        }
      }

      let hasRootTestFiles = false;
      try {
        const rootFiles = fs.readdirSync(rootPath);
        const rootPyTest = rootFiles.find((f) => /^test.*\.py$/i.test(f) || /.*_test\.py$/i.test(f));
        if (rootPyTest) {
          hasRootTestFiles = true;
          if (!targetTestCmd) {
            targetTestCmd = `python -m unittest ${rootPyTest}`;
          }
        }
      } catch {}

      const isPythonProject =
        hasExplicitPytestConfig ||
        hasTestFilesInTests ||
        hasRootTestFiles ||
        fs.existsSync(pyprojectPath) ||
        fs.existsSync(requirementsPath) ||
        fs.existsSync(setupPyPath);

      if (isPythonProject) {
        projectType = 'python';
        codeCheckCmd = 'python -m py_compile';

        if (hasExplicitPytestConfig) {
          fullRegressionCmd = 'pytest';
        } else if (hasTestFilesInTests) {
          fullRegressionCmd = 'python -m unittest discover -s tests';
        } else if (hasRootTestFiles) {
          fullRegressionCmd = 'python -m unittest discover -s .';
        } else {
          fullRegressionCmd = 'python -m unittest discover -s .';
        }
      } else if (fs.existsSync(path.join(rootPath, 'CMakeLists.txt'))) {
        // C/C++ (CMake)
        projectType = 'c_cpp';
        fullRegressionCmd = 'ctest';
        codeCheckCmd = 'cmake --build .';
      } else {
        // C/C++ (Makefile with test target)
        const makefileCandidates = ['Makefile', 'makefile', 'GNUmakefile'];
        let foundMakeWithTest = false;
        for (const m of makefileCandidates) {
          const mPath = path.join(rootPath, m);
          if (fs.existsSync(mPath)) {
            try {
              const content = fs.readFileSync(mPath, 'utf8');
              if (/^(test|check)\s*:/m.test(content)) {
                projectType = 'c_cpp';
                fullRegressionCmd = 'make test';
                foundMakeWithTest = true;
                break;
              }
            } catch {}
          }
        }

        if (!foundMakeWithTest) {
          if (fs.existsSync(path.join(rootPath, 'go.mod'))) {
            // Go
            projectType = 'go';
            fullRegressionCmd = 'go test ./...';
            codeCheckCmd = 'go vet ./...';
          } else if (fs.existsSync(path.join(rootPath, 'Cargo.toml'))) {
            // Rust
            projectType = 'rust';
            fullRegressionCmd = 'cargo test';
            codeCheckCmd = 'cargo check';
          } else if (fs.existsSync(path.join(rootPath, 'pom.xml'))) {
            // Java (Maven)
            projectType = 'java';
            fullRegressionCmd = 'mvn test';
            codeCheckCmd = 'mvn test-compile';
          } else if (
            fs.existsSync(path.join(rootPath, 'build.gradle')) ||
            fs.existsSync(path.join(rootPath, 'build.gradle.kts'))
          ) {
            // Java (Gradle)
            projectType = 'java';
            fullRegressionCmd = 'gradle test';
            codeCheckCmd = 'gradle compileJava';
          }
        }
      }
    }

    return {
      projectType,
      codeCheckCmd,
      targetTestCmd,
      fullRegressionCmd,
      availableScripts,
      isCommandSafe,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Automatically detects the test command if not configured in DB.
   * If undetected, returns an empty string (NEVER falls back to npm test).
   */
  public detectTestCommand(repoPath: string): string {
    const discovered = this.discoverSafeTestCommands(repoPath);
    return discovered.fullRegressionCmd || '';
  }

  /**
   * Ensures project is registered in DB and returns it.
   */
  public ensureProject(repoPath: string, testCommand?: string): Project {
    const rootPath = this.gitEngine.getRepoRoot(repoPath);
    const deterministicId = generateDeterministicProjectId(rootPath);
    let project = this.db.getProjectByPath(rootPath);

    if (!project) {
      const name = path.basename(rootPath);
      const detectedTest = testCommand || this.detectTestCommand(rootPath) || undefined;

      // Correction 1: Do NOT auto-sign detected commands. Keep unconfirmed until explicit user confirmation via API.
      project = {
        id: deterministicId,
        name,
        rootPath,
        testCommand: detectedTest,
        testCommandSignature: undefined,
        createdAt: new Date().toISOString(),
      };
      this.db.upsertProject(project);
      this.emitChange('project_created', project);
    } else {
      if (project.id !== deterministicId) {
        this.db.migrateDeterministicProjectIds();
        project = this.db.getProjectByPath(rootPath) || { ...project, id: deterministicId };
      }
      // Correction 1: Do NOT auto-sign if changed here, and do NOT auto-sign if signature is missing.
      // Signatures must ONLY be issued via updateProjectSettings (which is protected by X-Autopsy-Token).
      if (testCommand && project.testCommand !== testCommand) {
        project.testCommand = testCommand;
        project.testCommandSignature = undefined;
        this.db.upsertProject(project);
        this.emitChange('project_updated', project);
      }
    }

    // Start auto-baseline watcher for this project if not already watching
    if (!this.watchers.has(project.id)) {
      const watcher = new AutoBaselineWatcher(
        {
          repoPath: rootPath,
          projectId: project.id,
        },
        this.gitEngine,
        this.db
      );
      watcher.start();
      this.watchers.set(project.id, watcher);
    }

    return project;
  }

  /**
   * 1. capture_checkpoint: Non-destructive snapshot preserving staging area & untracked files.
   */
  public captureCheckpoint(
    repoPath: string,
    label: string = 'Manual Checkpoint',
    agentName: string = 'user',
    sessionId?: string
  ): Checkpoint {
    const project = this.ensureProject(repoPath);
    const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const snapshot = this.gitEngine.createSnapshot(project.rootPath, id, label);

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

    this.db.recordAgentHeartbeat(agentName, sessionId, `체크포인트 생성: ${label}`);
    this.db.insertCheckpoint(cp);
    this.quarantineCache.delete(project.id);
    this.db.updateProjectQuarantine(project.id, null, null);
    this.emitChange('checkpoint_created', cp);
    return cp;
  }

  /**
   * Computes deterministic fingerprint for an unapproved relative file or folder path.
   */
  private computePathFingerprint(fullPath: string): string {
    try {
      if (!fs.existsSync(fullPath)) {
        return '<DELETED>';
      }
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        return `${stat.size}:${this.gitEngine.getFileSha256(fullPath)}`;
      }
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const parts: string[] = [];
        for (const entry of entries) {
          parts.push(`${entry.name}:${this.computePathFingerprint(path.join(fullPath, entry.name))}`);
        }
        return crypto.createHash('sha256').update(parts.sort().join(';')).digest('hex');
      }
      return '<SPECIAL>';
    } catch {
      return '<ERROR>';
    }
  }

  /**
   * Computes a combined cryptographic fingerprint of all unapproved files (tracked + untracked)
   * and their exact content hashes.
   */
  private computeUnapprovedChangesFingerprint(
    repoPath: string,
    unapprovedTracked: string[],
    unapprovedUntracked: string[]
  ): string {
    const hasher = crypto.createHash('sha256');
    const sortedTracked = [...unapprovedTracked].sort();
    const sortedUntracked = [...unapprovedUntracked].sort();

    hasher.update(`tracked:${sortedTracked.join(',')}\n`);
    for (const rel of sortedTracked) {
      const full = path.resolve(repoPath, rel);
      hasher.update(`${rel}:${this.computePathFingerprint(full)}\n`);
    }

    hasher.update(`untracked:${sortedUntracked.join(',')}\n`);
    for (const rel of sortedUntracked) {
      const full = path.resolve(repoPath, rel);
      hasher.update(`${rel}:${this.computePathFingerprint(full)}\n`);
    }

    return hasher.digest('hex');
  }

  /**
   * 2. inspect_project_state: Health, git status, recent commits, latest checkpoint.
   */
  public inspectProjectState(repoPath: string): ProjectHealth {
    const project = this.ensureProject(repoPath);
    const gitStatus = this.gitEngine.getStatus(project.rootPath);
    const headSha = this.gitEngine.getHeadSha(project.rootPath);
    const recentCommits = this.gitEngine.getRecentCommits(project.rootPath, 5);
    const latestCheckpoint = this.db.getLatestCheckpoint(project.id);
    const activeIncidentsCount = this.db.getActiveIncidentsCount(project.id);

    // Policy bypass check: Detect unapproved direct modifications outside checkpoint baseline
    const unapprovedTracked = gitStatus.changedFiles.filter((f) => {
      if (!latestCheckpoint) return true;
      if (!latestCheckpoint.changedFiles.includes(f)) return true;
      if (latestCheckpoint.worktreeCommitSha) {
        try {
          const diff = this.gitEngine.runGit(project.rootPath, [
            'diff',
            '--name-only',
            latestCheckpoint.worktreeCommitSha,
            '--',
            f,
          ]).trim();
          return Boolean(diff);
        } catch {
          return false;
        }
      }
      return false;
    });

    const unapprovedUntracked = gitStatus.untrackedFiles.filter((f) => {
      if (!latestCheckpoint) return true;
      if (!(latestCheckpoint.untrackedFiles || []).includes(f)) return true;
      if (latestCheckpoint.worktreeCommitSha) {
        try {
          const diff = this.gitEngine.runGit(project.rootPath, [
            'diff',
            '--name-only',
            latestCheckpoint.worktreeCommitSha,
            '--',
            f,
          ]).trim();
          return Boolean(diff);
        } catch {
          return false;
        }
      }
      return false;
    });

    const unapprovedFiles = [...unapprovedTracked, ...unapprovedUntracked];
    const unapprovedModificationsDetected =
      unapprovedFiles.length > 0 && activeIncidentsCount > 0 && !this.isApplyingApprovedPatch;

    let quarantineBackupRef: string | undefined = undefined;
    if (unapprovedModificationsDetected) {
      // 0.5 Check: Compute exact fingerprint of unapproved changes (files list + content hashes)
      const fingerprint = this.computeUnapprovedChangesFingerprint(
        project.rootPath,
        unapprovedTracked,
        unapprovedUntracked
      );

      const cached = this.quarantineCache.get(project.id);
      if (cached && cached.fingerprint === fingerprint) {
        // Reuse previous backup ref without spawning any git commands
        quarantineBackupRef = cached.backupRef;
      } else if (project.lastQuarantineFingerprint === fingerprint && project.lastQuarantineRef) {
        quarantineBackupRef = project.lastQuarantineRef;
        this.quarantineCache.set(project.id, { fingerprint, backupRef: quarantineBackupRef });
      } else {
        // Non-destructive safety backup preserving untracked files without destroying user work.
        // Created ONLY when unapproved changes differ from previous quarantine backup!
        try {
          const qId = `quarantine_${Date.now().toString(36)}`;
          const qSnap = this.gitEngine.createSnapshot(
            project.rootPath,
            qId,
            'Quarantine safety backup of unapproved working tree modifications'
          );
          quarantineBackupRef = qSnap.gitRef;
          this.quarantineCache.set(project.id, { fingerprint, backupRef: quarantineBackupRef });
          this.db.updateProjectQuarantine(project.id, fingerprint, quarantineBackupRef);
        } catch {}
      }
    } else {
      // No unapproved modifications: clear quarantine cache if previously set
      if (this.quarantineCache.has(project.id) || project.lastQuarantineFingerprint) {
        this.quarantineCache.delete(project.id);
        this.db.updateProjectQuarantine(project.id, null, null);
      }
    }

    return {
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath,
      isGitClean: gitStatus.isClean,
      currentHeadSha: headSha,
      changedFiles: gitStatus.changedFiles,
      untrackedFiles: gitStatus.untrackedFiles,
      unapprovedModificationsDetected,
      unapprovedFiles,
      quarantineBackupRef,
      recentCommits,
      latestCheckpoint,
      activeIncidentsCount,
    };
  }

  /**
   * Performs automated project self-diagnostics inspecting Git health, AGENTS.md,
   * sandbox directory permissions, test commands, and agent heartbeats.
   */
  public diagnoseProject(repoPath: string): ProjectDiagnostics {
    const project = this.ensureProject(repoPath);
    const rootPath = project.rootPath;
    const items: DiagnosticItem[] = [];

    // 1. Git Repository Check
    let isGit = false;
    let gitStatus: 'CLEAN' | 'DIRTY' | 'NOT_A_GIT_REPO' = 'NOT_A_GIT_REPO';
    try {
      const gitRoot = this.gitEngine.getRepoRoot(rootPath);
      if (gitRoot) {
        isGit = true;
        const gitStatusInfo = this.gitEngine.getStatus(rootPath);
        const changedCount = gitStatusInfo.changedFiles.length;
        const untrackedCount = gitStatusInfo.untrackedFiles.length;
        gitStatus = gitStatusInfo.isClean ? 'CLEAN' : 'DIRTY';

        let desc = '클린 워킹트리';
        if (!gitStatusInfo.isClean) {
          const parts: string[] = [];
          if (changedCount > 0) parts.push(`수정 ${changedCount}개`);
          if (untrackedCount > 0) parts.push(`미추적 ${untrackedCount}개`);
          desc = `${parts.join(', ')} 파일 발견`;
        }

        items.push({
          key: 'git_repo',
          label: 'Git 저장소 및 버전 관리',
          status: 'PASS',
          message: `정상 Git 저장소 (${desc})`,
        });
      }
    } catch {
      items.push({
        key: 'git_repo',
        label: 'Git 저장소 및 버전 관리',
        status: 'FAIL',
        message: 'Git 저장소가 아닙니다. 버전 관리를 위해 초기화가 필요합니다.',
        actionRequired: 'git init을 실행하세요.',
      });
    }

    // 2. AGENTS.md Operating Rules Check
    const agentsMdPath = path.join(rootPath, 'AGENTS.md');
    const hasAgentsMd = fs.existsSync(agentsMdPath);
    if (hasAgentsMd) {
      const content = fs.readFileSync(agentsMdPath, 'utf8');
      const hasRules = content.includes('Agent Autopsy') || content.includes('capture_checkpoint');
      items.push({
        key: 'agents_sop',
        label: '에이전트 거버넌스 규칙 (AGENTS.md)',
        status: hasRules ? 'PASS' : 'WARN',
        message: hasRules ? '표준 AGENTS.md 지침서가 배포되어 있습니다.' : 'AGENTS.md에 Agent Autopsy 필수 수칙이 누락되어 있습니다.',
      });
    } else {
      items.push({
        key: 'agents_sop',
        label: '에이전트 거버넌스 규칙 (AGENTS.md)',
        status: 'WARN',
        message: 'AGENTS.md가 없습니다. AI 에이전트가 격리 검증 규칙을 준수하도록 온보딩이 필요합니다.',
        actionRequired: '원클릭 AGENTS.md 온보딩 배포를 실행하세요.',
      });
    }

    // 3. .gitignore Check (.autopsy/ safety quarantine)
    const gitignorePath = path.join(rootPath, '.gitignore');
    let hasAutopsyIgnore = false;
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      hasAutopsyIgnore = gitignoreContent.includes('.autopsy');
    }
    if (hasAutopsyIgnore) {
      items.push({
        key: 'gitignore_autopsy',
        label: '격리 샌드박스 무시 (.gitignore)',
        status: 'PASS',
        message: '.autopsy/ 임시 샌드박스가 Git 추적에서 제외되어 있습니다.',
      });
    } else {
      items.push({
        key: 'gitignore_autopsy',
        label: '격리 샌드박스 무시 (.gitignore)',
        status: 'WARN',
        message: '.autopsy/ 격리 폴더가 .gitignore에 등록되지 않았습니다.',
        actionRequired: '원클릭 온보딩으로 .gitignore를 갱신하세요.',
      });
    }

    // 4. Test Commands & Build Discovery
    const discoveredCommands = this.discoverSafeTestCommands(rootPath);
    if (!discoveredCommands.isCommandSafe) {
      items.push({
        key: 'test_commands',
        label: '테스트 및 검증 명령 안전성',
        status: 'WARN',
        message: `위험 키워드가 감지되었습니다: ${discoveredCommands.warnings?.join(', ')}`,
      });
    } else {
      items.push({
        key: 'test_commands',
        label: '테스트 및 검증 명령 안전성',
        status: 'PASS',
        message: `프로젝트 타입: ${discoveredCommands.projectType.toUpperCase()} | 기본 검증: ${project.testCommand || discoveredCommands.fullRegressionCmd || '없음'}`,
      });
    }

    // 5. Worktree Sandbox Permissions (Non-destructive check without creating polluting folders in project)
    try {
      fs.accessSync(rootPath, fs.constants.R_OK | fs.constants.W_OK);
      const cacheRoot =
        process.env.AUTOPSY_CACHE_DIR ||
        path.resolve(process.env.LOCALAPPDATA || process.env.APPDATA || '.', 'AgentAutopsy', 'cache');
      fs.mkdirSync(path.join(cacheRoot, 'sandboxes'), { recursive: true });
      items.push({
        key: 'sandbox_permissions',
        label: '저장소 및 격리 샌드박스 권한',
        status: 'PASS',
        message: '저장소 읽기/쓰기 및 독립 격리 캐시 권한이 정상입니다.',
      });
    } catch {
      items.push({
        key: 'sandbox_permissions',
        label: '저장소 및 격리 샌드박스 권한',
        status: 'FAIL',
        message: '저장소 또는 격리 캐시 디렉터리에 쓸 수 없습니다. 폴더 권한을 확인하세요.',
      });
    }

    // 6. MCP Heartbeat & Agent Status
    const allSessions = this.listActiveAgents();
    const activeAgents = allSessions.filter((a) => a.status === 'ACTIVE');
    const mcpHeartbeatActive = activeAgents.length > 0;
    items.push({
      key: 'mcp_heartbeat',
      label: 'AI 코딩 에이전트 연결 상태',
      status: 'PASS',
      message: mcpHeartbeatActive
        ? `${activeAgents.length}개의 AI 코딩 에이전트 활성 통신 중 (${activeAgents.map((a) => a.agentName).join(', ')})`
        : '대기 중 (에이전트가 MCP 도구를 호출하면 실시간 연동됩니다)',
    });

    const healthy = !items.some((i) => i.status === 'FAIL');

    // 7. Onboarding Preview: Inspect existing files and generate non-destructive preview
    let agentsMdAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING' = 'CREATE';
    let agentsMdDiffPreview = '';
    const conflictNotes: string[] = [];
    if (hasAgentsMd) {
      const existingAgents = fs.readFileSync(agentsMdPath, 'utf8');
      if (existingAgents.includes('Agent Autopsy') || existingAgents.includes('capture_checkpoint')) {
        agentsMdAction = 'KEEP_EXISTING';
        agentsMdDiffPreview = '(기존 파일에 이미 Agent Autopsy 거버넌스 규칙이 포함되어 있어 원본 유지)';
      } else {
        agentsMdAction = 'APPEND';
        agentsMdDiffPreview = '+ \n\n# --- Agent Autopsy SOP Rules (하단 안전 추가) ---\n' + this.getAgentsMdTemplate();
        conflictNotes.push('기존 커스텀 AGENTS.md 규칙을 100% 보존하며 하단에 필수 수칙이 안전 병합됩니다.');
      }
    } else {
      agentsMdAction = 'CREATE';
      agentsMdDiffPreview = '+ ' + this.getAgentsMdTemplate();
    }

    let gitignoreAction: 'CREATE' | 'APPEND' | 'KEEP_EXISTING' = 'CREATE';
    let gitignoreDiffPreview = '';
    if (fs.existsSync(gitignorePath)) {
      const existingGitignore = fs.readFileSync(gitignorePath, 'utf8');
      if (existingGitignore.includes('.autopsy')) {
        gitignoreAction = 'KEEP_EXISTING';
        gitignoreDiffPreview = '(이미 .autopsy/ 가 등록되어 있습니다)';
      } else {
        gitignoreAction = 'APPEND';
        gitignoreDiffPreview = '+ \n# Agent Autopsy isolated worktrees\n.autopsy/\n';
      }
    } else {
      gitignoreAction = 'CREATE';
      gitignoreDiffPreview = '+ # Agent Autopsy isolated worktrees\n.autopsy/\nnode_modules/\n';
    }

    return {
      projectId: project.id,
      repoPath: rootPath,
      healthy,
      items,
      discoveredCommands,
      hasAgentsMd,
      hasAutopsyIgnore,
      gitStatus,
      mcpHeartbeatActive,
      onboardingPreview: {
        agentsMdAction,
        gitignoreAction,
        agentsMdDiffPreview,
        gitignoreDiffPreview,
        hasConflicts: conflictNotes.length > 0,
        conflictNotes: conflictNotes.length > 0 ? conflictNotes : undefined,
      },
      timestamp: new Date().toISOString(),
    };
  }

  public getAgentsMdTemplate(): string {
    return `# 🤖 Agent Autopsy: AI Coding Agent Operating Rules (SOP)

이 파일은 Antigravity, Codex CLI, Claude Code 등 AI 코딩 에이전트가 본 프로젝트에서 자율적으로 안전 검증 및 복구 워크플로우를 수행하도록 지시하는 표준 운영 지침서(Standard Operating Procedure)입니다.

---

## 📌 핵심 원칙 (Core Directives)

1. **사전 체크포인트 의무 (Pre-modification Checkpoint)**
   * 새로운 기능 개발, 대규모 리팩토링, 또는 버그 수정을 시작하기 전에 반드시 \`capture_checkpoint\` 도구를 먼저 호출하여 현재 작업 기준점을 기록하세요.
   * 이미 최근 체크포인트가 있더라도 작업 주제가 바뀔 때는 새 라벨(\`label\`)로 체크포인트를 남기세요.

2. **오류 및 기능 오작동 발생 시 포렌식 수집 (Incident Forensics)**
   * 빌드/테스트 에러(\`AssertionError\`, \`TypeError\` 등)가 발생하거나, **코드는 정상인데 사용자가 의도한 기능이 작동하지 않는 경우(기능 불일치)** 즉시 \`collect_incident_bundle\` 도구를 호출하세요.
   * **⚠️ 중요 (과대해석 금지 및 사용자 사전 확인 의무)**:
     * 사용자의 말을 자의적으로 짐작해 코드를 바로 고쳐서는 안 됩니다.
     * 기능 오작동 시 반드시 채팅으로 사용자에게 다음 4가지를 되물어 확인을 받고 \`userConfirmedIntent: true\`를 넘기세요:
       1. \`expectedBehavior\`: 사용자가 원래 의도한 정상 동작
       2. \`observedBehavior\`: 실제 발생한 오작동 증상
       3. \`reproductionCondition\`: 어떤 입력과 상황에서 문제가 발생하는지
       4. \`verificationMethod\`: 기대 결과를 검증할 테스트/관찰 수단
   * \`title\`: 핵심 요약
   * \`agentName\`: 본인 에이전트 식별자 (\`antigravity\`, \`claude-code\`, \`codex\` 등)

3. **위험 적응형 AI 오케스트레이션 및 독립 검증 게이트 (Risk-Adaptive Evidence Gate)**
   * **검증 실행 방식 (3대 모드)**:
     * \`자동 판단 모드 (AUTO)\`: 메인 AI가 작업 난이도·위험 신호(보안/결제/할인 경로, 다중 모듈 영향도, 원인 불확실성)를 평가하여 필요한 경우에만 AI 오케스트레이션을 가동합니다.
     * \`메인 AI 전용 모드 (MAIN_ONLY)\`: 추가 AI 오케스트레이션을 호출하지 않고 메인 AI 단독으로 빠르게 처리합니다. 고위험 검증 생략 시 대시보드에 경고가 안내됩니다.
     * \`심층 검증 우선 모드 (DEEP_PRIORITY)\`: 가능한 모든 작업에 대해 독립 서브에이전트 교차 검증을 강력하게 요구합니다.
   * **단일 메인 모델 기반 호스트 네이티브 서브에이전트 활용**:
     * 별도의 다중 LLM이나 추가 API 키 설정 없이, 선택된 메인 환경의 네이티브 서브에이전트(\`Model='inherit'\`)를 호출하여 독립 검토를 수행하세요.
     * 검토 완료 후 \`submit_orchestration_review\` 도구로 분석 결과(\`findings\`), 반증(\`counterEvidence\`), 한계점(\`limitations\`), 호스트 서브에이전트 작업 식별자(\`subagentTaskId\` 또는 \`transcriptPath\`)를 제출하세요.
   * **가짜 검증 방지**:
     * 메인 AI가 자체적으로 작성한 대리 요약은 \`COMPLETED_UNVERIFIED\`로 기록되어 대시보드에 주의 경고가 표시됩니다.
     * 호스트 서브에이전트의 실제 실행이 확인된 경우에만 \`COMPLETED_VERIFIED\`로 승인 준비 완료됩니다.

4. **자가 치유 격리 검증 루프 (Self-Healing Loop: Max 3 Retries - 단 한 번의 검증된 수정 원칙)**
   * 코드를 실제 프로젝트 파일에 짐작으로 바로 수정해서는 절대 안 됩니다. (직접 수정 시 Agent Autopsy 감시기에 의해 미승인 정책 우회 경고가 발생합니다)
   * 원인 판정이 \`UNKNOWN\`(증거 부족)인 경우, 맹목적인 코드 패치 제출을 중단하고 필요한 추가 증거(로그, 프로브)를 먼저 확보하세요.
   * 반드시 \`propose_and_verify_repair\` 도구에 **Search & Replace 블록**을 넘겨 **격리 Worktree에서 먼저 3단계 검증(코드 정상, 기능 정상, 요구사항 충족)을 수행**하도록 하세요.
   * **원인 분석 리포트(\`rootCauseAnalysis\`) 작성 원칙**:
     * 무엇 때문에 의도와 실제 동작 사이에 괴리가 발생했고 어떻게 수정했는지를 **명확하고 논리적인 한국어**로 작성하세요. (대시보드에서 사용자가 읽고 승인 여부를 판단하는 핵심 근거가 됩니다)
   * **격리 검증이 실패(\`VERIFIED_FAIL\`)했을 경우**:
     * 실패 로그(\`testExecutionOutput\`)를 정밀 분석하여 최대 **3회까지** 자율적으로 수정안을 다시 제출하세요.
     * 3회 연속 실패 시에는 맹목적인 코드 수정을 중단하고 사용자에게 현재까지의 원인 분석과 실패 로그를 보고하세요.
   * **격리 검증이 통과(\`VERIFIED_PASS\`)했을 경우**:
     * 고위험(\`HIGH\`) 작업인 경우 서브에이전트 독립 검토(\`submit_orchestration_review\`)를 완료한 후, 사용자에게 *"격리 Worktree 검증을 통과했습니다. 대시보드(http://localhost:3847)에서 사건 흐름도와 수정안을 검토하고 승인해 주세요."*라고 안내하세요.

5. **하드 승인 게이트 준수 (Respect Human Gate)**
   * 사용자가 대시보드에서 수정안을 승인하기 전에는 \`apply_approved_repair\` 도구를 호출하지 마세요. (서버에서 거부됩니다)
   * 사용자가 승인을 완료했거나, 대시보드에서 직접 패치를 적용할 때까지 대기하세요.
   * 패치 적용 후에는 워킹 트리에 수정된 상태로 남겨두어 사용자가 최종 확인 후 원하는 메시지로 직접 Git 커밋할 수 있도록 하세요.
`;
  }

  /**
   * 1-Click Onboarding: Deploys AGENTS.md Operating Rules and updates .gitignore
   * preserving all existing user rules without destroying user customization.
   */
  public onboardProject(repoPath: string): OnboardingResult {
    const project = this.ensureProject(repoPath);
    const rootPath = project.rootPath;

    // 1. Write or Append AGENTS.md preserving existing user rules
    const agentsMdPath = path.join(rootPath, 'AGENTS.md');
    const template = this.getAgentsMdTemplate();
    let agentsMdCreated = false;

    if (fs.existsSync(agentsMdPath)) {
      const existing = fs.readFileSync(agentsMdPath, 'utf8');
      if (!existing.includes('Agent Autopsy') && !existing.includes('capture_checkpoint')) {
        fs.appendFileSync(agentsMdPath, `\n\n# --- Agent Autopsy SOP Rules (안전 병합) ---\n${template}`, 'utf8');
        agentsMdCreated = true;
      }
    } else {
      fs.writeFileSync(agentsMdPath, template, 'utf8');
      agentsMdCreated = true;
    }

    // 2. Update .gitignore preserving existing rules
    const gitignorePath = path.join(rootPath, '.gitignore');
    let gitignoreUpdated = false;
    if (fs.existsSync(gitignorePath)) {
      const existing = fs.readFileSync(gitignorePath, 'utf8');
      if (!existing.includes('.autopsy')) {
        fs.appendFileSync(gitignorePath, '\n# Agent Autopsy isolated worktrees and sandboxes\n.autopsy/\n', 'utf8');
        gitignoreUpdated = true;
      }
    } else {
      fs.writeFileSync(gitignorePath, '# Agent Autopsy isolated worktrees and sandboxes\n.autopsy/\nnode_modules/\n', 'utf8');
      gitignoreUpdated = true;
    }

    this.recordAgentEvent(
      rootPath,
      'COMMAND',
      '원클릭 AGENTS.md 온보딩 완료',
      'AGENTS.md 표준 운영 지침서가 프로젝트에 안전 배포/병합되었고 .gitignore가 갱신되었습니다.',
      'AGENTS.md',
      'dashboard'
    );

    this.emitChange('project_onboarded', { projectId: project.id, repoPath: rootPath });

    return {
      success: true,
      agentsMdCreated,
      gitignoreUpdated,
      message: '성공적으로 기존 설정을 보존하면서 AGENTS.md 지침서와 .gitignore 설정이 안전하게 반영되었습니다.',
    };
  }

  /**
   * 3. collect_incident_bundle: Package error logs, diff, and context into an incident bundle.
   */
  public async collectIncidentBundle(
    repoPath: string,
    titleOrOptions:
      | string
      | {
          title: string;
          errorOutput?: string;
          severity?: 'HIGH' | 'MEDIUM' | 'LOW';
          agentName?: string;
          sessionId?: string;
          expectedBehavior?: string;
          observedBehavior?: string;
          brokenStep?: string;
          executionTrace?: any[];
          reproductionCondition?: string;
          verificationMethod?: string;
          verificationType?: any;
          userConfirmedIntent?: boolean;
          userConfirmationSummary?: string;
        },
    errorOutput?: string,
    severity: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH',
    agentName: string = 'agent',
    sessionId?: string,
    expectedBehavior?: string,
    observedBehavior?: string,
    brokenStep?: string,
    executionTrace?: any[],
    reproductionCondition?: string,
    verificationMethod?: string,
    verificationType?: any,
    userConfirmedIntent?: boolean,
    userConfirmationSummary?: string
  ): Promise<Incident> {
    let title: string;
    if (typeof titleOrOptions === 'object' && titleOrOptions !== null) {
      title = titleOrOptions.title;
      errorOutput = titleOrOptions.errorOutput;
      severity = titleOrOptions.severity || 'HIGH';
      agentName = titleOrOptions.agentName || 'agent';
      sessionId = titleOrOptions.sessionId;
      expectedBehavior = titleOrOptions.expectedBehavior;
      observedBehavior = titleOrOptions.observedBehavior;
      brokenStep = titleOrOptions.brokenStep;
      executionTrace = titleOrOptions.executionTrace;
      reproductionCondition = titleOrOptions.reproductionCondition;
      verificationMethod = titleOrOptions.verificationMethod;
      verificationType = titleOrOptions.verificationType;
      userConfirmedIntent = titleOrOptions.userConfirmedIntent;
      userConfirmationSummary = titleOrOptions.userConfirmationSummary;
    } else {
      title = titleOrOptions;
    }

    if ((expectedBehavior || observedBehavior) && !userConfirmedIntent) {
      throw new Error(
        '[USER_INTENT_CONFIRMATION_REQUIRED]: Agent Autopsy는 AI의 자의적인 요구사항 과대해석을 차단합니다. ' +
        '사용자에게 4가지(기대결과, 관찰결과, 재현조건, 검증방법)를 되물어 확인한 뒤 userConfirmedIntent: true로 다시 호출하세요.'
      );
    }
    const project = this.ensureProject(repoPath);
    const latestCheckpoint = this.db.getLatestCheckpoint(project.id);
    this.db.recordAgentHeartbeat(agentName, sessionId, '사건 번들 수집');

    // Calculate diff against latest checkpoint or HEAD
    let diffSummary = '';
    if (latestCheckpoint && latestCheckpoint.gitHeadSha) {
      diffSummary = this.gitEngine.getDiff(project.rootPath, latestCheckpoint.gitHeadSha);
    } else {
      diffSummary = this.gitEngine.getDiff(project.rootPath);
    }

    let finalErrorOutput = errorOutput || '';
    let testExecutionNote: string | undefined;

    if (!finalErrorOutput) {
      const isSigned =
        Boolean(project.testCommand) &&
        Boolean(project.testCommandSignature) &&
        verifyTestCommandSignature(project.id, project.testCommand!, project.testCommandSignature!);

      if (!isSigned) {
        testExecutionNote = '테스트 실행 불가: 확정된 테스트 명령 없음';
      } else {
        // Run test command in an isolated worktree asynchronously
        const sandboxId = `inc_bundle_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
        let sandboxDir: string | undefined;
        try {
          const wt = this.worktreeRunner.createWorktree(
            project.rootPath,
            sandboxId,
            'HEAD',
            [],
            project.testCommand!
          );
          sandboxDir = wt.sandboxDir;
          const testRes = await this.worktreeRunner.runCommand(
            sandboxDir,
            project.testCommand!,
            30000
          );
          if (!testRes.success) {
            if (
              testRes.exitCode === 127 ||
              /is not recognized as an internal or external command|command not found/i.test(testRes.output)
            ) {
              testExecutionNote = '테스트 실행 불가: 명령 실행 실패';
            } else {
              finalErrorOutput = testRes.output;
            }
          }
        } catch (err: any) {
          testExecutionNote = `테스트 실행 불가: ${err.message}`;
        } finally {
          if (sandboxDir) {
            this.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
          }
        }
      }
    }

    const changedFiles = parseUnifiedDiffFiles(diffSummary);
    const codeHealth: HealthLevelStatus =
      finalErrorOutput.includes('SyntaxError') || finalErrorOutput.includes('ReferenceError') || finalErrorOutput.includes('TypeError')
        ? 'FAIL'
        : 'PASS';
    const threeLevelHealth: ThreeLevelHealth = {
      code: codeHealth,
      functional: 'FAIL',
      requirement: 'FAIL',
      details: {
        codeSummary: codeHealth === 'PASS' ? '빌드 및 타입 검사 정상' : '런타임/구문 예외 감지됨',
        functionalSummary: '사용자 의도와 실제 동작 불일치',
        requirementSummary: '최종 요구사항 미충족',
      },
    };
    const causeVerdict: CauseVerdict = codeHealth === 'FAIL' ? 'CONFIRMED' : 'UNKNOWN';

    // Risk-Adaptive Evidence Gate evaluation
    const decision = this.evaluateOrchestrationDecision(
      project,
      title,
      finalErrorOutput,
      diffSummary,
      changedFiles,
      causeVerdict,
      threeLevelHealth,
      0
    );

    const id = `inc_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const incident: Incident = {
      id,
      projectId: project.id,
      baseCheckpointId: latestCheckpoint ? latestCheckpoint.id : null,
      title,
      errorOutput: finalErrorOutput || testExecutionNote || '오류 출력이 기록되지 않았습니다.',
      diffSummary: diffSummary || '변경된 Git diff가 감지되지 않았습니다.',
      status: 'OPEN',
      severity,
      agentName,
      sessionId,
      expectedBehavior,
      observedBehavior,
      brokenStep,
      executionTrace,
      reproductionCondition,
      verificationMethod,
      verificationType,
      userConfirmedIntent: Boolean(userConfirmedIntent),
      userConfirmationSummary,
      causeVerdict,
      threeLevelHealth,
      riskLevel: decision.riskLevel,
      riskSignals: decision.riskSignals,
      orchestrationDecision: decision,
      testExecutionNote,
      createdAt: new Date().toISOString(),
    };

    this.db.insertIncident(incident);
    this.emitChange('incident_created', incident);
    return incident;
  }

  /**
   * Risk-Adaptive Evidence Gate: Evaluates task difficulty & risk to issue an OrchestrationDecision
   */
  public evaluateOrchestrationDecision(
    project: Project,
    title: string,
    errorOutput: string,
    diffSummary: string,
    changedFiles: string[],
    causeVerdict?: CauseVerdict,
    threeLevelHealth?: ThreeLevelHealth,
    retryCount: number = 0
  ): OrchestrationDecision {
    const riskSignals: string[] = [];
    const mode: VerificationMode = project.verificationMode || 'AUTO';
    const host: HostEnvironment = project.preferredHost || 'antigravity';

    // 1. Security-sensitive domain detection
    const securityPattern = /auth|token|jwt|crypto|password|secret|permission|role|payment|checkout|discount|coupon|billing|migration|schema|drop\s+table/i;
    const isSecuritySensitive =
      securityPattern.test(title) ||
      securityPattern.test(errorOutput) ||
      changedFiles.some((f) => securityPattern.test(f));

    if (isSecuritySensitive) {
      riskSignals.push('보안·인증·결제 관련 민감 로직 감지');
    }

    // 2. Blast radius (multi-file / multi-module)
    if (changedFiles.length >= 3) {
      riskSignals.push(`광범위한 변경 영향도 (${changedFiles.length}개 파일 수정)`);
    } else if (changedFiles.length >= 2) {
      riskSignals.push(`다중 모듈 연계 변경 (${changedFiles.length}개 파일 수정)`);
    }

    // 3. Functional mismatch or uncertainty signal
    if (causeVerdict === 'UNKNOWN') {
      riskSignals.push('원인 증거 불충분 (UNKNOWN 판정)');
    } else if (causeVerdict === 'LIKELY') {
      riskSignals.push('원인 간접 추론 (LIKELY 판정)');
    }

    if (threeLevelHealth && threeLevelHealth.code === 'PASS' && threeLevelHealth.functional === 'FAIL') {
      riskSignals.push('코드는 정상이나 기능이 의도와 불일치하는 상태');
    }

    // 4. Repeated retry failures
    if (retryCount >= 2) {
      riskSignals.push(`격리 검증 연속 ${retryCount}회 실패`);
    } else if (retryCount >= 1) {
      riskSignals.push('이전 수정안 격리 검증 실패 이력 감지');
    }

    // Determine Risk Level
    let riskLevel: RiskLevel = 'LOW';
    if (isSecuritySensitive || changedFiles.length >= 3 || retryCount >= 2) {
      riskLevel = 'HIGH';
    } else if (changedFiles.length >= 2 || causeVerdict !== 'CONFIRMED' || retryCount === 1) {
      riskLevel = 'MEDIUM';
    }

    // Generate Directive & Review Requirement based on mode & risk
    let directive: OrchestrationDecision['directive'] = 'DIRECT_SOLVE';
    let reviewRequirement: OrchestrationDecision['reviewRequirement'] = 'NONE';
    const skippedWarnings: string[] = [];

    if (mode === 'MAIN_ONLY') {
      directive = 'SKIPPED_MAIN_ONLY';
      reviewRequirement = 'NONE';
      if (riskLevel !== 'LOW') {
        skippedWarnings.push(
          `[메인 AI 전용 모드]: ${riskLevel} 위험도 작업이지만 사용자 설정에 의해 서브에이전트 오케스트레이션이 생략되었습니다. (위험 신호: ${riskSignals.join(', ')})`
        );
      }
    } else if (mode === 'DEEP_PRIORITY') {
      if (riskLevel === 'LOW') {
        directive = 'DIRECT_SOLVE';
        reviewRequirement = 'CONDITIONAL';
      } else {
        directive = 'INVOKE_NATIVE_ORCHESTRATION';
        reviewRequirement = 'MANDATORY_BEFORE_APPROVAL';
      }
    } else {
      // AUTO mode
      if (riskLevel === 'LOW') {
        directive = 'DIRECT_SOLVE';
        reviewRequirement = 'NONE';
      } else if (riskLevel === 'MEDIUM') {
        directive = 'INVOKE_NATIVE_ORCHESTRATION';
        reviewRequirement = 'CONDITIONAL';
      } else {
        directive = 'INVOKE_NATIVE_ORCHESTRATION';
        reviewRequirement = 'MANDATORY_BEFORE_APPROVAL';
      }
    }

    // Host delegation guide using the same selected model
    let hostDelegationGuide = '';
    if (host === 'antigravity') {
      hostDelegationGuide = `Antigravity 내장 subagent를 호출하세요: invoke_subagent(TypeName='self', Role='Independent Reviewer', Model='inherit', Prompt='...'). 검토 완료 후 submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else if (host === 'claude-code') {
      hostDelegationGuide = `Claude Code 내장 Task 서브에이전트를 호출하여 동일 모델(Opus)로 독립 교차 검토를 수행하고, submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else if (host === 'codex') {
      hostDelegationGuide = `Codex 내장 에이전트 위임 기능을 사용하여 동일 모델로 독립 검토를 수행하고, submit_orchestration_review 도구로 증거를 제출하세요.`;
    } else {
      hostDelegationGuide = `현재 실행 환경의 내장 서브에이전트를 호출하여 교차 검증을 수행하고, submit_orchestration_review 도구를 호출하세요.`;
    }

    const requiresOrchestration = directive === 'INVOKE_NATIVE_ORCHESTRATION';
    const reason = requiresOrchestration
      ? '고위험 경로 또는 다중 모듈 변경으로 독립 서브에이전트 검증이 필요합니다.'
      : directive === 'SKIPPED_MAIN_ONLY'
      ? '메인 AI 전용 모드로 설정되어 추가 AI 오케스트레이션이 생략되었습니다.'
      : '단순 저위험 작업으로 메인 AI 단독 처리가 가능합니다.';

    return {
      requiresOrchestration,
      reason,
      riskLevel,
      riskSignals,
      verificationMode: mode,
      hostEnvironment: host,
      directive,
      reviewRequirement,
      hostDelegationGuide,
      skippedVerificationWarnings: skippedWarnings,
    };
  }

  /**
   * 4. propose_and_verify_repair:
   * Validates patch, generates diff, executes tests in an isolated worktree replicating uncommitted baseline state.
   */
  public async proposeAndVerifyRepair(
    repoPath: string,
    incidentId: string,
    rootCauseAnalysis: string,
    fileChanges: FileChange[]
  ): Promise<{ proposal: RepairProposal; executionResult: ThreeStageExecutionResult }> {
    const project = this.ensureProject(repoPath);
    const incident = this.db.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident with ID "${incidentId}" not found.`);
    }

    // 1. Prepare patch in memory
    const prepared = this.patchEngine.preparePatch(project.rootPath, fileChanges);
    const proposalId = `prop_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

    // 2. Base commit to checkout in sandbox (use checkpoint worktree commit if available)
    let baseCommitSha = 'HEAD';
    if (incident.baseCheckpointId) {
      const baseCp = this.db.getCheckpoint(incident.baseCheckpointId);
      if (baseCp?.worktreeCommitSha) {
        baseCommitSha = baseCp.worktreeCommitSha;
      }
    }

    // 3. Create isolated worktree with dependency safety check
    const testCmd = project.testCommand || this.detectTestCommand(project.rootPath);

    // 0-D Check: Verify cryptographic signature of project testCommand against tampering and unconfirmed commands
    if (!project.testCommandSignature) {
      const err: any = new Error(
        `[BLOCKED_TEST_COMMAND_UNCONFIRMED] [TEST_COMMAND_UNCONFIRMED]: 테스트 명령("${testCmd || '미정'}")이 사용자에 의해 확정(서명)되지 않았습니다. 앱 대시보드에서 테스트 명령을 먼저 확정해 주세요.`
      );
      err.code = 'BLOCKED_TEST_COMMAND_UNCONFIRMED';
      err.next_action = {
        actor: 'USER',
        action: 'CONFIRM_TEST_COMMAND_IN_APP',
        agent_should: '사용자에게 앱 대시보드(프로젝트 설정)에서 테스트 명령을 확인(확정)해 달라고 요청하거나 propose_test_command 도구로 적절한 명령을 제안하세요.',
        forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '검증 생략'],
      };
      throw err;
    }
    const isCmdValid = verifyTestCommandSignature(
      project.id,
      project.testCommand || testCmd,
      project.testCommandSignature
    );
    if (!isCmdValid) {
      this.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `[보안 경고] 테스트 명령 변조 감지`,
        `프로젝트 "${project.name}"의 테스트 명령("${project.testCommand}")이 승인된 전자서명과 일치하지 않습니다. 검증 실행을 즉시 차단합니다.`,
        null,
        'security-gate'
      );
      this.emitChange('tamper_detected', {
        projectId: project.id,
        reason: `테스트 명령 위변조 감지: "${project.testCommand}"`,
      });
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 프로젝트의 테스트 명령("${project.testCommand}")이 위변조되었습니다. 승인 서명 검증에 실패하여 격리 검증 실행이 거부되었습니다.`
      );
    }
    const { sandboxDir } = this.worktreeRunner.createWorktree(
      project.rootPath,
      proposalId,
      baseCommitSha,
      prepared.touchedFiles,
      testCmd
    );

    let executionResult: ThreeStageExecutionResult;
    try {
      // 4. Write patch into the isolated worktree
      this.patchEngine.writePatchToDisk(sandboxDir, prepared.appliedFiles);

      // 5. Run 3-stage validation in isolated worktree
      executionResult = await this.worktreeRunner.runThreeStageValidation({
        worktreePath: sandboxDir,
        repoPath: project.rootPath,
        touchedFiles: prepared.touchedFiles,
        fullTestCommand: testCmd,
      });
    } finally {
      // 6. Always clean up isolated worktree
      this.worktreeRunner.cleanupWorktree(project.rootPath, sandboxDir);
    }

    // 7. Record proposal with verification status & Risk-Adaptive Evidence Gate
    const verificationStatus = executionResult.success ? 'VERIFIED_PASS' : 'VERIFIED_FAIL';
    const patchHash = crypto.createHash('sha256').update(prepared.unifiedDiff).digest('hex');

    // Previous retry count on this incident
    const previousProposals = this.db.listProposalsForIncident(incidentId);
    const retryCount = previousProposals.length;

    // Evaluate risk and orchestration decision on the proposed patch
    const decision = this.evaluateOrchestrationDecision(
      project,
      incident.title,
      incident.errorOutput,
      prepared.unifiedDiff,
      prepared.touchedFiles,
      incident.causeVerdict,
      incident.threeLevelHealth,
      retryCount
    );

    // Initial Approval Readiness (Decoupled: isolated test runs immediately, gate evaluated at approval level)
    let approvalReadiness: ApprovalReadiness = 'READY_FOR_APPROVAL';
    let approvalBlockReason: string | null = null;

    if (verificationStatus === 'VERIFIED_FAIL') {
      approvalReadiness = 'BLOCKED_TEST_FAILED';
      approvalBlockReason = '격리 워크트리 3단계 검증 실패: 실행 리포트를 분석하고 수정안을 다시 제출하세요.';
    } else {
      // Test passed! Now apply Risk-Adaptive Evidence Gate at approval readiness level
      if (decision.reviewRequirement === 'MANDATORY_BEFORE_APPROVAL') {
        approvalReadiness = 'BLOCKED_AWAITING_REVIEW';
        approvalBlockReason = `[고위험 변경]: ${decision.riskSignals.join(', ')} 등의 이유로 호스트 내장 서브에이전트의 독립 교차 검토가 필수입니다. submit_orchestration_review 도구로 검토 증거를 제출해야 정규 승인이 가능합니다.`;
      } else if (decision.verificationMode === 'MAIN_ONLY' && decision.riskLevel !== 'LOW') {
        approvalReadiness = 'APPROVABLE_WITH_RISK_WARNING';
        approvalBlockReason = `[메인 AI 전용 모드]: ${decision.riskLevel} 위험도 검증이 생략되었습니다.`;
      } else {
        approvalReadiness = 'READY_FOR_APPROVAL';
        approvalBlockReason = null;
      }
    }

    if (verificationStatus === 'VERIFIED_PASS') {
      sendWindowsToast(
        '🔬 Agent Autopsy: 3단계 격리 검증 통과',
        `사고 "${incident.title}" 수정안이 3단계 격리 검증을 통과했습니다. 대시보드(http://localhost:3847)에서 승인해 주세요.`
      );
    }

    const proposal: RepairProposal = {
      id: proposalId,
      incidentId,
      rootCauseAnalysis,
      patchDiff: prepared.unifiedDiff,
      patchHash,
      riskLevel: decision.riskLevel,
      touchedFiles: prepared.touchedFiles,
      fileChangesJson: JSON.stringify(fileChanges),
      verificationStatus,
      verificationLog: executionResult.output,
      approvalStatus: 'AWAITING_USER',
      approvalReadiness,
      approvalBlockReason: approvalBlockReason || undefined,
      stages: executionResult.stages,
      threeLevelHealth: executionResult.threeLevelHealth,
      verifiedWithCommand: testCmd,
      approvalFingerprintJson: null,
      approvedAt: null,
      appliedAt: null,
      createdAt: new Date().toISOString(),
    };

    this.db.insertRepairProposal(proposal);
    this.emitChange('proposal_created', proposal);
    return { proposal, executionResult };
  }

  /**
   * Generates a cryptographic review challenge token binding proposalId and patchHash.
   */
  public createReviewChallenge(
    repoPath: string,
    proposalId: string
  ): ReviewChallenge {
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) {
      throw new Error(`RepairProposal with ID "${proposalId}" not found.`);
    }
    const patchHash = crypto.createHash('sha256').update(proposal.patchDiff).digest('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    const secretKey = getInstallationSecretKey();
    const challengeToken = crypto
      .createHmac('sha256', secretKey)
      .update(`${proposal.id}:${patchHash}:${nonce}`)
      .digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return { challengeToken, proposalId, patchHash, expiresAt };
  }

  /**
   * Submits an independent orchestration review from a native subagent or main AI proxy.
   * Checks host execution trace to honestly differentiate COMPLETED_VERIFIED vs COMPLETED_UNVERIFIED.
   */
  public submitOrchestrationReview(
    repoPath: string,
    params: {
      proposalId: string;
      reviewer: string;
      findings: string[];
      counterEvidence?: string[];
      limitations?: string[];
      subagentTaskId?: string;
      transcriptPath?: string;
      challengeToken?: string;
      submittedByRole?: 'SUBAGENT_DIRECT' | 'MAIN_AGENT_PROXY';
    }
  ): { review: OrchestrationReview; proposal: RepairProposal } {
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(params.proposalId);
    if (!proposal) {
      throw new Error(`RepairProposal with ID "${params.proposalId}" not found.`);
    }

    const currentPatchHash = crypto.createHash('sha256').update(proposal.patchDiff).digest('hex');

    // 1. Stale Review Check: Ensure review targets the EXACT current patch
    if (proposal.patchHash && proposal.patchHash !== currentPatchHash) {
      throw new Error(
        `[STALE_REVIEW_REJECTED]: 수정안 코드가 변경되어 기존 검토가 무효화되었습니다 (PatchHash 불일치). 재검토를 요청하세요.`
      );
    }

    // 2. Host Subagent Physical Execution Verification
    let hostTranscriptVerified = false;
    let verificationNotes = '';

    let candidateLogPath: string | null = null;
    if (params.transcriptPath && fs.existsSync(params.transcriptPath)) {
      candidateLogPath = params.transcriptPath;
    } else if (params.subagentTaskId) {
      const candidates = [
        path.resolve(process.env.APPDATA || '.', '.agent-autopsy', 'tasks', `${params.subagentTaskId}.log`),
        path.resolve(process.env.HOME || '.', '.codex', 'logs', `${params.subagentTaskId}.log`),
        path.resolve(process.env.HOME || '.', '.claude', 'sessions', `${params.subagentTaskId}.jsonl`),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          candidateLogPath = cand;
          break;
        }
      }
    }

    if (candidateLogPath && fs.existsSync(candidateLogPath)) {
      try {
        const stat = fs.statSync(candidateLogPath);
        const proposalTime = new Date(proposal.createdAt).getTime();
        // File must be non-empty and modified around or after proposal creation
        const isFresh = stat.size > 0 && stat.mtimeMs >= proposalTime - 15000;
        if (isFresh) {
          const content = fs.readFileSync(candidateLogPath, 'utf8');
          // Must contain subagent invocation, review, or proposal ID
          const hasEvidence =
            content.includes(proposal.id) ||
            content.includes(currentPatchHash.slice(0, 10)) ||
            content.includes('invoke_subagent') ||
            content.includes('subagent') ||
            content.includes('Reviewer') ||
            (params.challengeToken ? content.includes(params.challengeToken) : false);

          if (hasEvidence) {
            hostTranscriptVerified = true;
            verificationNotes = `호스트 실행 증거 파일 확인 완료 (${path.basename(candidateLogPath)})`;
          } else {
            verificationNotes = `로그 파일은 존재하나 서브에이전트 검토 실행 증거가 누락되었습니다.`;
          }
        } else {
          verificationNotes = `로그 파일이 수정안 생성 이전 시점이거나 빈 파일입니다.`;
        }
      } catch (err: any) {
        verificationNotes = `호스트 로그 검증 중 오류: ${err.message}`;
      }
    } else {
      verificationNotes = `호스트 서브에이전트 물리적 실행 로그 파일을 찾을 수 없습니다.`;
    }

    const status: OrchestrationReviewStatus = hostTranscriptVerified
      ? 'COMPLETED_VERIFIED'
      : 'COMPLETED_UNVERIFIED';

    const review: OrchestrationReview = {
      reviewId: `rev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      proposalId: proposal.id,
      incidentId: proposal.incidentId,
      status,
      reviewer: params.reviewer || 'subagent',
      submittedByRole: params.submittedByRole || (hostTranscriptVerified ? 'SUBAGENT_DIRECT' : 'MAIN_AGENT_PROXY'),
      hostTranscriptVerified,
      subagentTaskId: params.subagentTaskId,
      challengeToken: params.challengeToken,
      verificationNotes,
      patchHash: currentPatchHash,
      findings: params.findings || [],
      counterEvidence: params.counterEvidence || [],
      limitations: params.limitations || [],
      createdAt: new Date().toISOString(),
    };

    // Re-evaluate approval readiness
    let approvalReadiness: ApprovalReadiness = proposal.approvalReadiness || 'READY_FOR_APPROVAL';
    let blockReason: string | null = null;

    if (proposal.verificationStatus === 'VERIFIED_FAIL') {
      approvalReadiness = 'BLOCKED_TEST_FAILED';
      blockReason = '격리 워크트리 테스트 실패';
    } else {
      if (status === 'COMPLETED_VERIFIED') {
        approvalReadiness = 'READY_FOR_APPROVAL';
        blockReason = null;
      } else {
        approvalReadiness = 'APPROVABLE_WITH_RISK_WARNING';
        blockReason = `호스트 서브에이전트 실행 기록이 독립 검증되지 않은 미공인 검토 요약입니다 (${verificationNotes})`;
      }
    }

    this.db.updateProposalOrchestrationReview(proposal.id, review, approvalReadiness, blockReason);
    const updated = this.db.getRepairProposal(proposal.id)!;
    this.emitChange('proposal_reviewed', { proposal: updated, review });
    return { review, proposal: updated };
  }

  public updateProjectSettings(
    repoPath: string,
    settings: { verificationMode?: VerificationMode; preferredHost?: HostEnvironment; testCommand?: string }
  ): Project {
    const project = this.ensureProject(repoPath);
    const testCommandSignature = settings.testCommand
      ? signTestCommand(project.id, settings.testCommand)
      : undefined;
    this.db.updateProjectSettings(project.id, {
      ...settings,
      testCommandSignature,
    });
    const updated = this.db.getProject(project.id)!;
    this.emitChange('project_settings_updated', updated);
    return updated;
  }

  /**
   * Agent proposes a test command with rationale.
   * Registered in DB as pending user confirmation in Desktop App.
   */
  public proposeTestCommand(
    repoPath: string,
    command: string,
    reason: string
  ): {
    success: boolean;
    project: Project;
    next_action: {
      actor: string;
      action: string;
      agent_should: string;
      forbidden: string[];
    };
  } {
    const project = this.ensureProject(repoPath);
    this.db.updateProjectProposedTestCommand(project.id, command, reason);
    this.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `테스트 명령 제안: ${command}`,
      `에이전트가 검증용 테스트 명령을 제안했습니다. (사유: ${reason}). 사용자가 앱 대시보드에서 확정할 때까지 대기합니다.`,
      null,
      'agent'
    );
    const updated = this.db.getProject(project.id)!;
    this.emitChange('project_updated', updated);
    return {
      success: true,
      project: updated,
      next_action: {
        actor: 'USER',
        action: 'CONFIRM_TEST_COMMAND_IN_APP',
        agent_should: '사용자에게 앱 대시보드(프로젝트 설정)에서 제안된 테스트 명령을 확인(확정)해 달라고 요청하세요.',
        forbidden: ['원본 파일 직접 수정', 'DB 직접 수정', '검증 생략'],
      },
    };
  }

  /**
   * User confirms (and cryptographically signs) a test command.
   * Invoked via API protected by session token.
   */
  public confirmTestCommand(repoPath: string, command: string): Project {
    const project = this.ensureProject(repoPath);
    const signature = signTestCommand(project.id, command);
    this.db.updateProjectConfirmedTestCommand(project.id, command, signature);
    this.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `테스트 명령 확정: ${command}`,
      `사용자가 테스트 명령을 공식 확정하고 HMAC 전자서명을 발급했습니다.`,
      null,
      'user'
    );
    const updated = this.db.getProject(project.id)!;
    this.emitChange('project_settings_updated', updated);
    return updated;
  }

  /**
   * User approval: Computes ApprovalFingerprint and pins file pre-image hashes.
   */
  public approveProposal(
    proposalId: string,
    selectedFiles?: string[],
    forceOverrideWithRiskAck: boolean = false
  ): ApprovalFingerprint {
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    const incident = this.db.getIncident(proposal.incidentId);
    if (!incident) throw new Error(`Incident not found.`);
    const project = this.db.getProject(incident.projectId);
    if (!project) throw new Error(`Project not found.`);

    // Risk-Adaptive Gate Check: Block unreviewed high risk proposals unless explicitly force-approved with acknowledgment
    if (proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && !forceOverrideWithRiskAck) {
      throw new Error(
        `[RISK_GATE_VIOLATION]: ${proposal.approvalBlockReason || '고위험 변경으로 독립 검토가 필수입니다.'} ` +
        `검토 없이 강제 승인하려면 대시보드에서 위험 감수 승인(forceOverride)을 확인하세요.`
      );
    }
    if (proposal.approvalReadiness === 'BLOCKED_TEST_FAILED') {
      throw new Error(`[TEST_GATE_VIOLATION]: 격리 워크트리 테스트가 실패한 수정안은 승인할 수 없습니다.`);
    }

    // Pin cryptographic hashes of target files right now
    const targetFileHashes: Record<string, string> = {};
    const approvedFiles = selectedFiles && selectedFiles.length > 0 ? selectedFiles : proposal.touchedFiles;

    for (const f of approvedFiles) {
      const absPath = path.resolve(project.rootPath, f);
      targetFileHashes[f] = this.gitEngine.getFileSha256(absPath);
    }

    // 0-C: Hash the exact fileChanges to be applied (filtered by approvedFiles)
    let effectiveChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
    if (selectedFiles && selectedFiles.length > 0) {
      const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
      effectiveChanges = effectiveChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
    }
    const patchHash = hashFileChanges(effectiveChanges);
    const baseHeadSha = this.gitEngine.getHeadSha(project.rootPath);
    const signature = signApprovalPayload(proposalId, patchHash, baseHeadSha);

    const fingerprint: ApprovalFingerprint = {
      patchHash,
      baseHeadSha,
      baseCheckpointId: incident.baseCheckpointId,
      targetFileHashes,
      approvedFiles,
      createdAt: new Date().toISOString(),
      signature,
    };

    this.db.updateProposalApproval(proposalId, 'APPROVED', fingerprint);
    this.emitChange('proposal_approved', { proposalId, fingerprint });
    return fingerprint;
  }

  public rejectProposal(proposalId: string): void {
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) throw new Error(`Proposal "${proposalId}" not found.`);
    this.db.updateProposalApproval(proposalId, 'REJECTED');
    this.emitChange('proposal_rejected', { proposalId });
  }

  /**
   * Records a security tampering event, marks proposal as TAMPERED, and emits notifications.
   */
  public recordTamperIncident(repoPath: string, proposalId: string, reason: string): void {
    const project = this.ensureProject(repoPath);
    this.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `[보안 경고] 승인 게이트 변조 감지`,
      `수정안 ID: ${proposalId}\n사유: ${reason}\n무단 승인 조작 또는 서명 위조가 감지되어 상태를 TAMPERED로 변경하고 적용을 즉시 차단했습니다.`,
      null,
      'security-gate'
    );
    try {
      this.db.updateProposalApproval(proposalId, 'TAMPERED');
    } catch {}
    this.emitChange('tamper_detected', { proposalId, reason, projectId: project.id });
    try {
      sendWindowsToast('Agent Autopsy 보안 경고', `[변조 감지] 수정안 ${proposalId} 적용이 보안 정책에 의해 차단되었습니다.`);
    } catch {}
  }

  /**
   * 5. apply_approved_repair:
   * [HARD SECURITY GATE]: Re-verifies approval fingerprint, cryptographic signature & pre-image file hashes to block TOCTOU and tampering attacks.
   */
  public applyApprovedRepair(
    repoPath: string,
    proposalId: string,
    selectedFiles?: string[]
  ): { applied: boolean; touchedFiles: string[]; diff: string } {
    const project = this.ensureProject(repoPath);
    const proposal = this.db.getRepairProposal(proposalId);
    if (!proposal) {
      throw new Error(`Proposal with ID "${proposalId}" not found.`);
    }

    // HARD SECURITY GATE 1: Status must be APPROVED
    if (proposal.approvalStatus !== 'APPROVED') {
      throw new Error(
        `[SECURITY GATE VIOLATION]: Repair proposal "${proposalId}" cannot be applied because its status is "${proposal.approvalStatus}". It must be explicitly approved by the user in Agent Autopsy first.`
      );
    }

    // HARD SECURITY GATE 2: Cryptographic fingerprint presence and signature check (Bypass / Tamper Defense)
    if (!proposal.approvalFingerprintJson) {
      this.recordTamperIncident(
        project.rootPath,
        proposalId,
        '승인 지문(Approval Fingerprint)이 누락되었습니다. 데이터베이스를 직접 수정하여 승인 상태를 우회 조작한 정황이 감지되었습니다.'
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 지문(Fingerprint)이 누락된 비정상적인 승인 상태입니다. 데이터베이스 직접 변조가 감지되어 적용이 차단되고 보안 사건이 기록되었습니다.`
      );
    }

    const fp: ApprovalFingerprint = JSON.parse(proposal.approvalFingerprintJson);

    // Verify HMAC signature of approval
    const isValidSignature = verifyApprovalSignature(proposalId, fp.patchHash, fp.baseHeadSha, fp.signature);
    if (!isValidSignature) {
      this.recordTamperIncident(
        project.rootPath,
        proposalId,
        '승인 지문의 전자서명이 유효하지 않습니다. 승인 데이터 위조가 감지되었습니다.'
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 지문 전자서명 검증 실패. 승인 위조 시도가 감지되어 적용이 거부되었습니다.`
      );
    }

    // 0-C Check: Compute hash of actual fileChanges to be applied right now
    let fileChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
    if (selectedFiles && selectedFiles.length > 0) {
      const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
      fileChanges = fileChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
      if (fileChanges.length === 0) {
        throw new Error('선택한 파일이 수정안에 포함되어 있지 않습니다.');
      }
    }

    const currentFileChangesHash = hashFileChanges(fileChanges);
    if (currentFileChangesHash !== fp.patchHash) {
      this.recordTamperIncident(
        project.rootPath,
        proposalId,
        `승인된 수정 내용(해시: ${fp.patchHash.slice(0, 8)})과 현재 적용 대상 내용(해시: ${currentFileChangesHash.slice(0, 8)})이 일치하지 않습니다 (fileChangesJson 사후 변조).`
      );
      throw new Error(
        `[SECURITY_TAMPER_DETECTED]: 승인 이후 패치 코드 변조(Patch Drift)가 감지되었습니다. 승인 당시와 다른 코드가 적용되는 것을 차단했습니다.`
      );
    }

    // Verify current HEAD has not moved
    const currentHead = this.gitEngine.getHeadSha(project.rootPath);
    if (fp.baseHeadSha && currentHead !== fp.baseHeadSha) {
      throw new Error(
        `[STALE_APPROVAL_ERROR]: 저장소의 Git HEAD 커밋이 승인 시점(${fp.baseHeadSha.slice(0, 7)})과 달라졌습니다 (${currentHead.slice(0, 7)}). 코드 오염을 방지하기 위해 적용이 중단되었습니다. 재검토해 주세요.`
      );
    }

    // Verify none of the target files on disk have changed since approval
    for (const [relPath, approvedHash] of Object.entries(fp.targetFileHashes)) {
      const abs = path.resolve(project.rootPath, relPath);
      const currentHash = this.gitEngine.getFileSha256(abs);
      if (currentHash !== approvedHash) {
        throw new Error(
          `[STALE_APPROVAL_ERROR]: 대상 파일 "${relPath}" 이(가) 사용자 승인 이후 외부에서 수정되었습니다. 코드 충돌을 방지하기 위해 적용이 차단되었습니다. 수정안을 다시 검토해 주세요.`
        );
      }
    }

    // 1. Take safety checkpoint before applying
    this.captureCheckpoint(project.rootPath, `Before Applying Repair ${proposalId}`, 'core-gate');

    this.isApplyingApprovedPatch = true;
    try {
      // 2. Prepare and write patch to real workspace
      let fileChanges: FileChange[] = JSON.parse(proposal.fileChangesJson);
      if (selectedFiles && selectedFiles.length > 0) {
        const wanted = new Set(selectedFiles.map((f) => f.replace(/\\/g, '/')));
        fileChanges = fileChanges.filter((c) => wanted.has(c.filePath.replace(/\\/g, '/')));
        if (fileChanges.length === 0) {
          throw new Error('선택한 파일이 수정안에 포함되어 있지 않습니다.');
        }
      }
      const prepared = this.patchEngine.preparePatch(project.rootPath, fileChanges);
      this.patchEngine.writePatchToDisk(project.rootPath, prepared.appliedFiles);

      // 3. Update DB proposal status to APPLIED
      this.db.updateProposalApproval(proposalId, 'APPLIED');

      // 4. Mark incident as RESOLVED
      this.db.updateIncidentStatus(proposal.incidentId, 'RESOLVED');

      // 5. Take post-patch checkpoint
      this.captureCheckpoint(project.rootPath, `After Applying Repair: ${proposal.rootCauseAnalysis}`, 'core-gate');

      this.emitChange('proposal_applied', { proposalId, incidentId: proposal.incidentId });

      return {
        applied: true,
        touchedFiles: prepared.touchedFiles,
        diff: prepared.unifiedDiff,
      };
    } finally {
      this.isApplyingApprovedPatch = false;
    }
  }

  /**
   * 6. rollback_to_checkpoint: Restores repository to exact checkpoint.
   */
  public rollbackToCheckpoint(
    repoPath: string,
    checkpointId: string
  ): { restored: boolean; backupRef: string } {
    const project = this.ensureProject(repoPath);
    const cp = this.db.getCheckpoint(checkpointId);
    if (!cp) {
      throw new Error(`Checkpoint with ID "${checkpointId}" not found.`);
    }

    const { backupRef } = this.gitEngine.restoreSnapshot(
      project.rootPath,
      cp.gitHeadSha,
      cp.worktreeCommitSha,
      cp.gitIndexSha,
      cp.untrackedFiles || []
    );

    this.quarantineCache.delete(project.id);
    this.db.updateProjectQuarantine(project.id, null, null);
    this.emitChange('checkpoint_rolled_back', { checkpointId, backupRef });

    return {
      restored: true,
      backupRef,
    };
  }

  /**
   * Records agent activity (file read, edit, command run, test result).
   */
  public recordAgentEvent(
    repoPath: string,
    kind: AgentEventKind,
    title: string,
    detail: string = '',
    filePath: string | null = null,
    agentName: string = 'mcp-agent',
    sessionId?: string
  ): AgentEvent {
    const project = this.ensureProject(repoPath);
    const ev: AgentEvent = {
      id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
      projectId: project.id,
      agentName,
      sessionId,
      kind,
      title,
      detail,
      filePath,
      createdAt: new Date().toISOString(),
    };
    this.db.insertAgentEvent(ev);
    this.emitChange('event_recorded', ev);
    return ev;
  }

  /**
   * Project Dashboard Overview
   */
  public getOverview(repoPath: string): ProjectOverview {
    const project = this.ensureProject(repoPath);
    const health = this.inspectProjectState(project.rootPath);
    const incidents = this.db.listIncidents(project.id, 200);
    const proposals = this.db.listProposalsForProject(project.id, 200);

    const applied = proposals.filter((p) => p.approvalStatus === 'APPLIED');
    const verifiedPass = proposals.filter((p) => p.verificationStatus === 'VERIFIED_PASS');
    const judged = proposals.filter((p) => p.verificationStatus !== 'PENDING');
    const openIncidents = incidents.filter((i) => i.status !== 'RESOLVED');

    let lastTestStatus: 'PASS' | 'FAIL' | 'UNKNOWN' = 'UNKNOWN';
    const lastTestEvent = [...this.db.listAgentEvents(project.id, 50)].find(
      (e) => e.kind === 'TEST_PASS' || e.kind === 'TEST_FAIL'
    );
    const latestProposal = proposals[0];
    const latestIncident = incidents[0];
    const candidates: Array<{ at: string; status: 'PASS' | 'FAIL' }> = [];
    if (lastTestEvent) candidates.push({ at: lastTestEvent.createdAt, status: lastTestEvent.kind === 'TEST_PASS' ? 'PASS' : 'FAIL' });
    if (latestProposal && latestProposal.verificationStatus !== 'PENDING') {
      candidates.push({ at: latestProposal.createdAt, status: latestProposal.verificationStatus === 'VERIFIED_PASS' ? 'PASS' : 'FAIL' });
    }
    if (latestIncident) candidates.push({ at: latestIncident.createdAt, status: latestIncident.status === 'RESOLVED' ? 'PASS' : 'FAIL' });
    candidates.sort((a, b) => b.at.localeCompare(a.at));
    if (candidates[0]) lastTestStatus = candidates[0].status;

    const incidentById = new Map(incidents.map((i) => [i.id, i]));
    const recentRecoveries = applied
      .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
      .slice(0, 5)
      .map((p) => ({
        proposalId: p.id,
        incidentTitle: incidentById.get(p.incidentId)?.title ?? '(알 수 없는 사고)',
        summary: p.rootCauseAnalysis,
        appliedAt: p.appliedAt ?? p.createdAt,
        files: p.touchedFiles,
      }));

    return {
      project,
      health,
      stats: {
        totalProposals: proposals.length,
        appliedProposals: applied.length,
        verifiedPassProposals: verifiedPass.length,
        successRate: judged.length > 0 ? Math.round((verifiedPass.length / judged.length) * 100) : null,
        openIncidents: openIncidents.length,
        resolvedIncidents: incidents.length - openIncidents.length,
        lastTestStatus,
      },
      openIncidents: openIncidents.slice(0, 8),
      recentRecoveries,
    };
  }

  /**
   * AI Action Timeline
   */
  public getTimeline(projectId: string, limit: number = 150): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    for (const cp of this.db.listCheckpoints(projectId, limit)) {
      const isRecovery = cp.agentName === 'core-gate';
      events.push({
        id: `tl_${cp.id}`,
        kind: isRecovery ? 'RECOVERY' : 'CHECKPOINT',
        title: cp.label,
        summary: cp.changedFiles.length > 0 ? `변경된 파일 ${cp.changedFiles.length}개 포함` : '변경 사항 없는 깨끗한 상태',
        actor: cp.agentName,
        sessionId: cp.sessionId,
        createdAt: cp.createdAt,
        files: cp.changedFiles,
        refs: { checkpointId: cp.id },
      });
    }

    for (const inc of this.db.listIncidents(projectId, limit)) {
      events.push({
        id: `tl_${inc.id}`,
        kind: 'INCIDENT',
        title: inc.title,
        summary: inc.status === 'RESOLVED' ? '해결됨' : '아직 해결되지 않은 Incident',
        actor: inc.agentName || 'incident',
        sessionId: inc.sessionId,
        createdAt: inc.createdAt,
        files: parseUnifiedDiffFiles(inc.diffSummary),
        diff: inc.diffSummary,
        log: inc.errorOutput,
        refs: { incidentId: inc.id },
      });
      events.push({
        id: `tl_${inc.id}_fail`,
        kind: 'TEST_FAIL',
        title: '테스트/빌드 실패 감지',
        summary: firstMeaningfulLine(inc.errorOutput),
        actor: 'test',
        createdAt: inc.createdAt,
        files: [],
        log: inc.errorOutput,
        refs: { incidentId: inc.id },
      });
    }

    for (const p of this.db.listProposalsForProject(projectId, limit)) {
      events.push({
        id: `tl_${p.id}`,
        kind: 'PROPOSAL',
        title: '수정안 제안',
        summary: p.rootCauseAnalysis.split(/\r?\n/)[0].slice(0, 140),
        actor: 'agent',
        createdAt: p.createdAt,
        files: p.touchedFiles,
        diff: p.patchDiff,
        refs: { proposalId: p.id, incidentId: p.incidentId },
      });
      if (p.verificationStatus !== 'PENDING') {
        events.push({
          id: `tl_${p.id}_verify`,
          kind: p.verificationStatus === 'VERIFIED_PASS' ? 'TEST_PASS' : 'TEST_FAIL',
          title: p.verificationStatus === 'VERIFIED_PASS' ? '격리 Worktree 검증 통과' : '격리 Worktree 검증 실패',
          summary: firstMeaningfulLine(p.verificationLog),
          actor: 'worktree',
          createdAt: p.createdAt,
          files: p.touchedFiles,
          log: p.verificationLog,
          refs: { proposalId: p.id, incidentId: p.incidentId },
        });
      }
      if (p.appliedAt) {
        events.push({
          id: `tl_${p.id}_applied`,
          kind: 'RECOVERY',
          title: '승인된 수정안 적용',
          summary: `${p.touchedFiles.length}개 파일에 적용됨`,
          actor: 'user',
          createdAt: p.appliedAt,
          files: p.touchedFiles,
          diff: p.patchDiff,
          refs: { proposalId: p.id, incidentId: p.incidentId },
        });
      }
    }

    for (const e of this.db.listAgentEvents(projectId, limit)) {
      events.push({
        id: `tl_${e.id}`,
        kind: e.kind,
        title: e.title,
        summary: e.detail.split(/\r?\n/)[0].slice(0, 140),
        actor: e.agentName,
        sessionId: e.sessionId,
        createdAt: e.createdAt,
        files: e.filePath ? [e.filePath] : [],
        log: e.detail || undefined,
        refs: {},
      });
    }

    return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  /**
   * Incident cause analysis with full interactive IncidentFlowData.
   */
  public analyzeIncidentCauses(incidentId: string): { incident: Incident; analysis: IncidentAnalysis } {
    const incident = this.db.getIncident(incidentId);
    if (!incident) throw new Error(`Incident with ID "${incidentId}" not found.`);
    const project = this.db.getProject(incident.projectId);
    const health = project ? this.inspectProjectState(project.rootPath) : null;

    const analysis = analyzeIncident(
      incident.errorOutput,
      incident.diffSummary,
      project?.rootPath,
      project?.name || 'project',
      health?.currentHeadSha || 'HEAD',
      incident
    );
    return { incident, analysis };
  }

  public listActiveAgents() {
    return this.db.listAgentSessions();
  }

  /**
   * Creates a user directive from dashboard or workflow and attempts live delivery to waiting agent,
   * otherwise enqueues for next-call delivery or manual copy-prompt.
   */
  public createDirective(
    repoPath: string,
    params: {
      incidentId?: string;
      proposalId?: string;
      patchHash?: string;
      kind: DirectiveKind;
      feedbackText?: string;
      confirmedIntent?: ConfirmedIntentData;
    }
  ): AgentDirective {
    const project = this.ensureProject(repoPath);
    const directiveId = `dir_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();

    // Check if there is an active waiter waiting on this proposal or repoPath
    let activeWaiterKey: string | null = null;
    let waiterObj: { resolve: (val: any) => void; timer: NodeJS.Timeout; proposalId: string; repoPath: string } | null = null;

    if (params.proposalId) {
      const key = `${repoPath}:${params.proposalId}`;
      if (this.activeWaiters.has(key)) {
        activeWaiterKey = key;
        waiterObj = this.activeWaiters.get(key)!;
      }
    }
    if (!waiterObj) {
      for (const [k, v] of this.activeWaiters.entries()) {
        if (v.repoPath === repoPath) {
          activeWaiterKey = k;
          waiterObj = v;
          break;
        }
      }
    }

    let deliveryStatus: DirectiveDeliveryStatus = 'WAITING_AGENT';
    let deliveredAt: string | undefined = undefined;
    const resumeMethod: 'HOST_AUTO' | 'MANUAL_COPY_PROMPT' = 'MANUAL_COPY_PROMPT';

    // Clear, actionable Korean instruction snippet for user copy-paste if agent isn't live-waiting
    let manualPromptSnippet = '';
    switch (params.kind) {
      case 'REJECT_WITH_FEEDBACK':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}을 거절했습니다.\n피드백 사유: "${params.feedbackText || '추가 수정 필요'}"\n사유를 분석하여 격리 Worktree에서 3단계 검증을 통과하는 새로운 수정안을 제출하세요.`;
        break;
      case 'REQUEST_DEEP_REVIEW':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 수정안 #${params.proposalId?.slice(-6) || ''}에 대해 서브에이전트 심층 검토를 요청했습니다.\n네이티브 서브에이전트(Model='inherit')를 호출하여 독립 검증을 수행하고 submit_orchestration_review 도구로 증거를 제출하세요.`;
        break;
      case 'CONFIRM_INTENT':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 기능 의도를 확정했습니다.\n기대 동작: ${params.confirmedIntent?.expectedBehavior || '-'}\n실제 동작: ${params.confirmedIntent?.observedBehavior || '-'}\n재현 조건: ${params.confirmedIntent?.reproductionCondition || '-'}\n검증 수단: ${params.confirmedIntent?.verificationMethod || '-'}\n이 의도에 맞춰 사건을 분석하고 격리 검증을 수행하세요.`;
        break;
      case 'APPROVE_AND_APPLY':
        manualPromptSnippet = `[Agent Autopsy 지시] 사용자가 대시보드에서 수정안 #${params.proposalId?.slice(-6) || ''} 승인 및 적용을 확인했습니다.`;
        break;
    }

    if (waiterObj && activeWaiterKey) {
      deliveryStatus = 'DELIVERED_LIVE';
      deliveredAt = now;
      clearTimeout(waiterObj.timer);
      this.activeWaiters.delete(activeWaiterKey);
    }

    const directive: AgentDirective = {
      id: directiveId,
      projectId: project.id,
      incidentId: params.incidentId,
      proposalId: params.proposalId,
      patchHash: params.patchHash,
      kind: params.kind,
      feedbackText: params.feedbackText,
      confirmedIntent: params.confirmedIntent,
      deliveryStatus,
      resumeMethod,
      manualPromptSnippet,
      createdAt: now,
      deliveredAt,
    };

    this.db.insertDirective(directive);

    // If active waiter was waiting, resolve it immediately with the delivered directive
    if (waiterObj) {
      waiterObj.resolve({
        status: 'DIRECTIVE_DELIVERED',
        directive,
      });
    }

    // Side effects on incident / proposal
    if (params.kind === 'CONFIRM_INTENT' && params.incidentId && params.confirmedIntent) {
      const summary = `사용자 직접 확정: 기대="${params.confirmedIntent.expectedBehavior || ''}" / 실제="${params.confirmedIntent.observedBehavior || ''}"`;
      this.db.updateIncidentIntent(params.incidentId, params.confirmedIntent, true, summary);
    }
    if (params.kind === 'REJECT_WITH_FEEDBACK' && params.proposalId) {
      try {
        this.rejectProposal(params.proposalId);
      } catch {
        // Ignored if already rejected
      }
    }

    this.recordAgentEvent(
      repoPath,
      'COMMAND',
      `대시보드 지시 발행: ${params.kind}`,
      `전달 상태: ${deliveryStatus}${params.feedbackText ? ` | 피드백: ${params.feedbackText}` : ''}`,
      null,
      'dashboard'
    );

    this.emitChange('directive_created', { directive });
    if (deliveryStatus === 'DELIVERED_LIVE') {
      this.emitChange('directive_delivered', { directive });
    }

    return directive;
  }

  /**
   * Bounded long-poll for agent to await human decision on a repair proposal.
   * Max 120s timeout window ensures agent hosts (with 3-minute hard kill limits) never crash.
   */
  public async awaitUserDecision(
    repoPath: string,
    proposalId: string,
    timeoutSec: number = 90
  ): Promise<{
    status: 'DIRECTIVE_DELIVERED' | 'WAIT_TIMEOUT';
    directive?: AgentDirective;
    message?: string;
  }> {
    const project = this.ensureProject(repoPath);
    const boundedSec = Math.min(Math.max(timeoutSec || 90, 5), 120);

    // 1. Check if there is already a pending directive waiting for agent
    const pending = this.db.listPendingDirectives(project.id);
    const matching = pending.find((d) => d.proposalId === proposalId || d.deliveryStatus === 'WAITING_AGENT');
    if (matching) {
      const now = new Date().toISOString();
      this.db.updateDirectiveStatus(matching.id, 'DELIVERED_LIVE', { deliveredAt: now });
      matching.deliveryStatus = 'DELIVERED_LIVE';
      matching.deliveredAt = now;
      this.emitChange('directive_delivered', { directive: matching });
      return {
        status: 'DIRECTIVE_DELIVERED',
        directive: matching,
      };
    }

    // 2. Otherwise register bounded long-poll waiter
    return new Promise((resolve) => {
      const waiterKey = `${repoPath}:${proposalId}`;
      const timer = setTimeout(() => {
        this.activeWaiters.delete(waiterKey);
        resolve({
          status: 'WAIT_TIMEOUT',
          message: `대기 시간(${boundedSec}초)이 경과했습니다. 에이전트 호스트 타임아웃 방지를 위해 안전하게 대기를 종료합니다. 사용자가 대시보드에서 결정을 내리면 영속 Directive Queue에 보존되며 다음 도구 호출 시 전달되거나 수동 재개 프롬프트가 대시보드에 표시됩니다.`,
        });
      }, boundedSec * 1000);

      this.activeWaiters.set(waiterKey, {
        resolve,
        timer,
        proposalId,
        repoPath,
      });
    });
  }

  /**
   * Retrieve pending directives for an agent and mark WAITING_AGENT ones as DELIVERED_ON_NEXT_CALL.
   */
  public getPendingDirectives(repoPath: string, agentName: string = 'agent'): AgentDirective[] {
    const project = this.ensureProject(repoPath);
    const pending = this.db.listPendingDirectives(project.id);
    const now = new Date().toISOString();

    for (const d of pending) {
      if (d.deliveryStatus === 'WAITING_AGENT') {
        this.db.updateDirectiveStatus(d.id, 'DELIVERED_ON_NEXT_CALL', { deliveredAt: now });
        d.deliveryStatus = 'DELIVERED_ON_NEXT_CALL';
        d.deliveredAt = now;
        this.emitChange('directive_delivered', { directive: d });
      }
    }

    return pending;
  }

  /**
   * Agent acknowledges receipt of a directive and commits to taking action.
   */
  public acknowledgeDirective(directiveId: string, agentName: string = 'agent'): AgentDirective {
    const directive = this.db.getDirective(directiveId);
    if (!directive) {
      throw new Error(`Directive "${directiveId}" not found.`);
    }

    const now = new Date().toISOString();
    this.db.updateDirectiveStatus(directiveId, 'ACKNOWLEDGED', { acknowledgedAt: now });
    directive.deliveryStatus = 'ACKNOWLEDGED';
    directive.acknowledgedAt = now;

    const project = this.db.getProject(directive.projectId);
    if (project) {
      this.recordAgentEvent(
        project.rootPath,
        'NOTE',
        `지시 수신 확인: ${directive.kind}`,
        `에이전트가 지시(ID: ${directive.id})를 확인하고 후속 작업을 착수했습니다.`,
        null,
        agentName
      );
    }

    this.emitChange('directive_acknowledged', { directive });
    return directive;
  }

  public getRuntimeInfo(port: number = 3847): RuntimeInfo {
    const dataDir = resolveDataDir();
    const cacheDir = resolveCacheDir();

    return {
      service: 'agent-autopsy',
      version: '0.1.0',
      pid: process.pid,
      port,
      host: '127.0.0.1',
      dataDir,
      cacheDir,
      dbPath: this.db.resolvedPath,
      dbStatus: this.db.status,
      dbInitError: this.db.initError,
      recoveryGuide: this.db.recoveryGuide,
      startedAt: new Date().toISOString(),
    };
  }

  public getWorkspaceComparison(
    repoPath: string,
    options?: { checkpointId?: string; commitSha?: string }
  ): WorkspaceComparison {
    const project = this.ensureProject(repoPath);
    const rootPath = project.rootPath;
    const status = this.gitEngine.getStatus(rootPath);
    let workingDiff = this.gitEngine.getDiff(rootPath);

    // If workingDiff is empty but untracked files exist, generate pseudo-diff preview
    if (!workingDiff && status.untrackedFiles.length > 0) {
      const previews: string[] = [];
      for (const u of status.untrackedFiles.slice(0, 5)) {
        try {
          const p = path.resolve(rootPath, u);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            previews.push(`--- /dev/null\n+++ b/${u}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`);
          }
        } catch {}
      }
      if (previews.length > 0) workingDiff = previews.join('\n\n');
    }

    let checkpointDiff: string | undefined;
    if (options?.checkpointId) {
      const cp = this.db.getCheckpoint(options.checkpointId);
      if (cp) {
        try {
          checkpointDiff = this.gitEngine.getDiff(rootPath, cp.worktreeCommitSha || cp.gitHeadSha);
        } catch {}
      }
    }

    const recentCommits = this.gitEngine.getRecentCommits(rootPath, 15);
    let commitDiff: string | undefined;
    if (options?.commitSha) {
      try {
        commitDiff = this.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', options.commitSha]);
      } catch {}
    } else if (recentCommits.length > 0) {
      try {
        commitDiff = this.gitEngine.runGit(rootPath, ['show', '--stat=80', '-p', recentCommits[0].sha]);
      } catch {}
    }

    return {
      workingDiff,
      changedFiles: status.changedFiles,
      untrackedFiles: status.untrackedFiles,
      checkpointDiff,
      selectedCheckpointId: options?.checkpointId,
      recentCommits,
      commitDiff,
      selectedCommitSha: options?.commitSha || recentCommits[0]?.sha,
    };
  }

  public async shutdown(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.stop();
    }
    this.watchers.clear();

    for (const waiter of this.activeWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        status: 'WAIT_TIMEOUT',
        message: 'CoreManager is shutting down',
      });
    }
    this.activeWaiters.clear();

    this.db.close();
  }
}
