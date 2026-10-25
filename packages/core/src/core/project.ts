import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { CoreContext } from './context.js';
import { AutoBaselineWatcher } from '../watcher/auto-watcher.js';
import {
  resolveDataDir,
  generateDeterministicProjectId,
  normalizeRepoPath,
} from '../utils/paths.js';
import {
  signTestCommand,
  verifyTestCommandSignature,
} from '../utils/security.js';
import {
  Project,
  ProjectHealth,
  ProjectDiagnostics,
  DiagnosticItem,
  OnboardingResult,
  OnboardingPreview,
  DiscoveredCommands,
  AgentEventKind,
  VerificationMode,
  HostEnvironment,
} from '../types.js';

  export function discoverSafeTestCommands(ctx: CoreContext, repoPath: string): DiscoveredCommands {
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
        rootPath = ctx.gitEngine.getRepoRoot(repoPath);
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
  export function detectTestCommand(ctx: CoreContext, repoPath: string): string {
    const discovered = discoverSafeTestCommands(ctx, repoPath);
    return discovered.fullRegressionCmd || '';
  }

  /**
   * Ensures project is registered in DB and returns it.
   */
  export function ensureProject(ctx: CoreContext, repoPath: string, testCommand?: string): Project {
    const rootPath = ctx.gitEngine.getRepoRoot(repoPath);
    const deterministicId = generateDeterministicProjectId(rootPath);
    let project = ctx.db.getProjectByPath(rootPath);

    if (!project) {
      const name = path.basename(rootPath);
      const detectedTest = testCommand || ctx.detectTestCommand(rootPath) || undefined;

      // Correction 1: Do NOT auto-sign detected commands. Keep unconfirmed until explicit user confirmation via API.
      project = {
        id: deterministicId,
        name,
        rootPath,
        testCommand: detectedTest,
        testCommandSignature: undefined,
        createdAt: new Date().toISOString(),
      };
      ctx.db.upsertProject(project);
      ctx.emitChange('project_created', project);
    } else {
      if (project.id !== deterministicId) {
        ctx.db.migrateDeterministicProjectIds();
        project = ctx.db.getProjectByPath(rootPath) || { ...project, id: deterministicId };
      }
      // Correction 1: Do NOT auto-sign if changed here, and do NOT auto-sign if signature is missing.
      // Signatures must ONLY be issued via updateProjectSettings (which is protected by X-Autopsy-Token).
      if (testCommand && project.testCommand !== testCommand) {
        project.testCommand = testCommand;
        project.testCommandSignature = undefined;
        ctx.db.upsertProject(project);
        ctx.emitChange('project_updated', project);
      }
    }

    // Start auto-baseline watcher for this project if not already watching
    if (!ctx.watchers.has(project.id)) {
      const watcher = new AutoBaselineWatcher(
        {
          repoPath: rootPath,
          projectId: project.id,
        },
        ctx.gitEngine,
        ctx.db
      );
      watcher.start();
      ctx.watchers.set(project.id, watcher);
    }

    return project;
  }

  /**
   * 1. capture_checkpoint: Non-destructive snapshot preserving staging area & untracked files.
   */

  export function computePathFingerprint(ctx: CoreContext, fullPath: string): string {
    try {
      if (!fs.existsSync(fullPath)) {
        return '<DELETED>';
      }
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        return `${stat.size}:${ctx.gitEngine.getFileSha256(fullPath)}`;
      }
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });
        const parts: string[] = [];
        for (const entry of entries) {
          parts.push(`${entry.name}:${computePathFingerprint(ctx, path.join(fullPath, entry.name))}`);
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
  export function computeUnapprovedChangesFingerprint(ctx: CoreContext,
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
      hasher.update(`${rel}:${computePathFingerprint(ctx, full)}\n`);
    }

    hasher.update(`untracked:${sortedUntracked.join(',')}\n`);
    for (const rel of sortedUntracked) {
      const full = path.resolve(repoPath, rel);
      hasher.update(`${rel}:${computePathFingerprint(ctx, full)}\n`);
    }

    return hasher.digest('hex');
  }

  /**
   * 2. inspect_project_state: Health, git status, recent commits, latest checkpoint.
   */
  export function inspectProjectState(ctx: CoreContext, repoPath: string): ProjectHealth {
    const project = ctx.ensureProject(repoPath);
    const gitStatus = ctx.gitEngine.getStatus(project.rootPath);
    const headSha = ctx.gitEngine.getHeadSha(project.rootPath);
    const recentCommits = ctx.gitEngine.getRecentCommits(project.rootPath, 5);
    const latestCheckpoint = ctx.db.getLatestCheckpoint(project.id);
    const activeIncidentsCount = ctx.db.getActiveIncidentsCount(project.id);

    // Policy bypass check: Detect unapproved direct modifications outside checkpoint baseline
    const unapprovedTracked = gitStatus.changedFiles.filter((f) => {
      if (!latestCheckpoint) return true;
      if (!latestCheckpoint.changedFiles.includes(f)) return true;
      if (latestCheckpoint.worktreeCommitSha) {
        try {
          const diff = ctx.gitEngine.runGit(project.rootPath, [
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
          const diff = ctx.gitEngine.runGit(project.rootPath, [
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
      unapprovedFiles.length > 0 && activeIncidentsCount > 0 && !ctx.isApplyingApprovedPatch;

    let quarantineBackupRef: string | undefined = undefined;
    if (unapprovedModificationsDetected) {
      // 0.5 Check: Compute exact fingerprint of unapproved changes (files list + content hashes)
      const fingerprint = computeUnapprovedChangesFingerprint(ctx,
        project.rootPath,
        unapprovedTracked,
        unapprovedUntracked
      );

      const cached = ctx.quarantineCache.get(project.id);
      if (cached && cached.fingerprint === fingerprint) {
        // Reuse previous backup ref without spawning any git commands
        quarantineBackupRef = cached.backupRef;
      } else if (project.lastQuarantineFingerprint === fingerprint && project.lastQuarantineRef) {
        quarantineBackupRef = project.lastQuarantineRef;
        ctx.quarantineCache.set(project.id, { fingerprint, backupRef: quarantineBackupRef });
      } else {
        // Non-destructive safety backup preserving untracked files without destroying user work.
        // Created ONLY when unapproved changes differ from previous quarantine backup!
        try {
          const qId = `quarantine_${Date.now().toString(36)}`;
          const qSnap = ctx.gitEngine.createSnapshot(
            project.rootPath,
            qId,
            'Quarantine safety backup of unapproved working tree modifications'
          );
          quarantineBackupRef = qSnap.gitRef;
          ctx.quarantineCache.set(project.id, { fingerprint, backupRef: quarantineBackupRef });
          ctx.db.updateProjectQuarantine(project.id, fingerprint, quarantineBackupRef);
        } catch {}
      }
    } else {
      // No unapproved modifications: clear quarantine cache if previously set
      if (ctx.quarantineCache.has(project.id) || project.lastQuarantineFingerprint) {
        ctx.quarantineCache.delete(project.id);
        ctx.db.updateProjectQuarantine(project.id, null, null);
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
  export function diagnoseProject(ctx: CoreContext, repoPath: string): ProjectDiagnostics {
    const project = ctx.ensureProject(repoPath);
    const rootPath = project.rootPath;
    const items: DiagnosticItem[] = [];

    // 1. Git Repository Check
    let isGit = false;
    let gitStatus: 'CLEAN' | 'DIRTY' | 'NOT_A_GIT_REPO' = 'NOT_A_GIT_REPO';
    try {
      const gitRoot = ctx.gitEngine.getRepoRoot(rootPath);
      if (gitRoot) {
        isGit = true;
        const gitStatusInfo = ctx.gitEngine.getStatus(rootPath);
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
    const discoveredCommands = discoverSafeTestCommands(ctx, rootPath);
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
    const allSessions = ctx.listActiveAgents();
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
        agentsMdDiffPreview = '+ \n\n# --- Agent Autopsy SOP Rules (하단 안전 추가) ---\n' + getAgentsMdTemplate();
        conflictNotes.push('기존 커스텀 AGENTS.md 규칙을 100% 보존하며 하단에 필수 수칙이 안전 병합됩니다.');
      }
    } else {
      agentsMdAction = 'CREATE';
      agentsMdDiffPreview = '+ ' + getAgentsMdTemplate();
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

  export function getAgentsMdTemplate(): string {
    return `# 🤖 Agent Autopsy: AI Coding Agent Operating Rules (SOP)

이 파일은 Antigravity, Codex CLI, Claude Code 등 AI 코딩 에이전트가 본 프로젝트에서 자율적으로 안전 검증 및 복구 워크플로우를 수행하도록 지시하는 표준 운영 지침서(Standard Operating Procedure)입니다.

---

## 📌 핵심 원칙 (Core Directives)

1. **사전 체크포인트 및 과거 기록 조회 의무 (Pre-modification Checkpoint & History Search)**
   * 새로운 기능 개발, 대규모 리팩토링, 또는 버그 수정을 시작하기 전에 반드시 \`capture_checkpoint\` 도구를 먼저 호출하여 현재 작업 기준점을 기록하세요.
   * 이미 최근 체크포인트가 있더라도 작업 주제가 바뀔 때는 새 라벨(\`label\`)로 체크포인트를 남기세요.
   * 작업 시작 전 \`search_history\`, \`get_incident_attempts\`, \`get_changes_since_good_checkpoint\` 도구를 활용하여 과거 유사 버그 해결 기록, 이전 실패 원인, 최근 변경 사항을 확인하세요.

2. **오류 및 기능 오작동 발생 시 포렌식 수집 및 되묻기 흐름 (Incident Forensics & Intent Clarification)**
   * 빌드/테스트 에러(\`AssertionError\`, \`TypeError\` 등)가 발생하거나, **코드는 정상인데 사용자가 의도한 기능이 작동하지 않는 경우(기능 불일치)** 즉시 \`collect_incident_bundle\` 도구를 호출하세요.
   * **사용자 신고 원문 및 구조화된 의도 전달**:
     * 사용자의 말을 자의적으로 짐작해 코드를 바로 고쳐서는 안 됩니다.
     * \`userReportText\`: 사용자가 채팅이나 지시서에 작성한 원문을 그대로 넘기세요. 원문이 누락되면 출처 판정이 불가능하므로 \`action: 'PROVIDE_USER_REPORT'\`가 안내됩니다.
     * 4가지 의도 필드(\`expectedBehavior\`, \`observedBehavior\`, \`reproductionCondition\`, \`verificationMethod\`)를 함께 전달하면 출처(\`USER_QUOTE\`, \`AI_INFERRED\`, \`MISSING\`)가 자동 판별됩니다.
   * **누락 항목 되묻기 (\`next_action.action: 'CLARIFY_INTENT'\` 또는 \`'PROVIDE_USER_REPORT'\`)**:
     * \`userReportText\`가 없으면 \`next_action.action\`이 \`PROVIDE_USER_REPORT\`로 안내되며, 사용자에게 원문을 요청하여 확인한 후 다시 등록해야 합니다.
     * 원문이 있고 네 가지 의도가 모두 채워져 있으면 질문 없이 사건이 즉시 등록되고 다음 단계로 진행됩니다.
     * 빈 의도 항목이 있으면 \`next_action.action\`이 \`CLARIFY_INTENT\`로 안내되며, \`missing_fields\`에 명시된 누락 항목만 채팅창에서 사용자에게 질문하여 구체적인 답변을 확인하세요.
   * \`title\`: 핵심 요약
   * \`agentName\`: 본인 에이전트 식별자 (\`antigravity\`, \`claude-code\`, \`codex\` 등)
   * **사건 등록 후 변경 범위 확인 (\`get_change_scope\`)**:
     * 사건 등록 후 바뀐 함수 범위를 \`get_change_scope\`로 먼저 확인하라. 이 범위는 순위가 아니고 원인 확정도 아니다.

3. **구조화된 next_action 지침 준수 및 승인 착각 방지 (Respect Structured next_action)**
   * 모든 Agent Autopsy 도구의 응답에는 \`{ "actor", "action", "agent_should", "forbidden", "note?" }\` 형식의 \`next_action\`이 포함되어 있습니다. 에이전트는 반드시 \`next_action\`의 지시를 따라야 합니다.
   * **⚠️ 중요 (서브에이전트 검토 완료 ≠ 사용자 승인)**:
     * 독립 서브에이전트 검토(\`submit_orchestration_review\`)가 통과된 것은 고위험 패치의 '승인 잠금 해제'일 뿐, 사용자의 최종 승인이 아닙니다.
     * 사용자가 앱 대시보드(http://localhost:3847)에서 직접 승인 버튼을 누르기 전에는 절대로 패치를 워크스페이스에 적용할 수 없으며, 에이전트가 이를 승인으로 간주해서는 안 됩니다.

4. **위험 적응형 AI 오케스트레이션 및 독립 검증 게이트 (Risk-Adaptive Evidence Gate)**
   * **검증 실행 방식 (3대 모드)**:
     * \`자동 판단 모드 (AUTO)\`: 메인 AI가 작업 난이도·위험 신호(민감 경로, 바뀐 줄 수 등)를 평가하여 필요한 경우(고위험)에만 AI 오케스트레이션을 가동합니다.
     * \`메인 AI 전용 모드 (MAIN_ONLY)\`: 추가 AI 오케스트레이션을 호출하지 않고 메인 AI 단독으로 빠르게 처리합니다. 고위험 검증 생략 시 대시보드에 자체 점검표와 경고가 안내됩니다.
     * \`심층 검증 우선 모드 (DEEP_PRIORITY)\`: 중간 위험 이상의 모든 작업에 대해 독립 서브에이전트 교차 검증을 강력하게 요구합니다.
   * **단일 메인 모델 기반 호스트 네이티브 서브에이전트 활용**:
     * 별도의 다중 LLM이나 추가 API 키 설정 없이, 선택된 메인 환경의 네이티브 서브에이전트(\`Model='inherit'\`)를 호출하여 독립 검토를 수행하세요.
     * 검토 완료 후 \`submit_orchestration_review\` 도구로 분석 결과(\`findings\`), 반증(\`counterEvidence\`), 한계점(\`limitations\`), 호스트 서브에이전트 작업 식별자(\`subagentTaskId\` 또는 \`transcriptPath\`)를 제출하세요.
   * **가짜 검증 방지**:
     * 메인 AI가 자체적으로 작성한 대리 요약은 \`COMPLETED_UNVERIFIED\`로 기록되어 대시보드에 주의 경고가 표시됩니다.
     * 호스트 서브에이전트의 실제 실행이 확인된 경우에만 \`COMPLETED_VERIFIED\`로 승인 준비 완료됩니다.

5. **자가 치유 격리 검증 루프 (Self-Healing Loop: Max 3 Retries - 단 한 번의 검증된 수정 원칙)**
   * 코드를 실제 프로젝트 파일에 짐작으로 바로 수정해서는 절대 안 됩니다. (직접 수정 시 Agent Autopsy 감시기에 의해 미승인 정책 우회 경고가 발생합니다)
   * 원인 판정이 \`UNKNOWN\`(증거 부족)인 경우, 맹목적인 코드 패치 제출을 중단하고 \`run_reproduction\`을 통해 재현 테스트를 실행하여 실행 증거를 먼저 확보하세요.
   * 반드시 \`propose_and_verify_repair\` 도구에 **Search & Replace 블록**을 넘겨 **격리 Worktree에서 먼저 3단계 검증(구문, 타깃 검증, 전체 회귀)을 수행**하도록 하세요.
   * **원인 분석 리포트(\`rootCauseAnalysis\`) 작성 원칙**:
     * 무엇 때문에 의도와 실제 동작 사이에 괴리가 발생했고 어떻게 수정했는지를 **명확하고 논리적인 한국어**로 작성하세요. (대시보드에서 사용자가 읽고 승인 여부를 판단하는 핵심 근거가 됩니다)
   * **격리 검증이 실패(\`VERIFIED_FAIL\`)했을 경우**:
     * 실패 로그(\`testExecutionOutput\`)를 정밀 분석하여 최대 **3회까지** 자율적으로 수정안을 다시 제출하세요.
     * 3회 연속 실패 시에는 맹목적인 코드 수정을 중단하고 사용자에게 현재까지의 원인 분석과 실패 로그를 보고하세요.
   * **격리 검증이 통과(\`VERIFIED_PASS\`)했을 경우**:
     * 고위험(\`HIGH\`) 작업인 경우 서브에이전트 독립 검토(\`submit_orchestration_review\`)를 완료한 후, \`await_user_decision\`을 호출하여 사용자 승인을 기다리거나 사용자에게 대시보드(http://localhost:3847)에서 승인을 요청하세요.

6. **하드 승인 게이트 준수 (Respect Human Gate)**
   * 사용자가 대시보드에서 수정안을 승인하기 전에는 \`apply_approved_repair\` 도구를 호출하지 마세요. (서버에서 거부됩니다)
   * 사용자가 승인을 완료했거나, 대시보드에서 직접 패치를 적용할 때까지 대기하세요.
   * 패치 적용 후에는 워킹 트리에 수정된 상태로 남겨두어 사용자가 최종 확인 후 원하는 메시지로 직접 Git 커밋할 수 있도록 하세요.

`;
  }

  /**
   * 1-Click Onboarding: Deploys AGENTS.md Operating Rules and updates .gitignore
   * preserving all existing user rules without destroying user customization.
   */
  export function onboardProject(ctx: CoreContext, repoPath: string): OnboardingResult {
    const project = ctx.ensureProject(repoPath);
    const rootPath = project.rootPath;

    // 1. Write or Append AGENTS.md preserving existing user rules
    const agentsMdPath = path.join(rootPath, 'AGENTS.md');
    const template = getAgentsMdTemplate();
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

    ctx.recordAgentEvent(
      rootPath,
      'COMMAND',
      '원클릭 AGENTS.md 온보딩 완료',
      'AGENTS.md 표준 운영 지침서가 프로젝트에 안전 배포/병합되었고 .gitignore가 갱신되었습니다.',
      'AGENTS.md',
      'dashboard'
    );

    ctx.emitChange('project_onboarded', { projectId: project.id, repoPath: rootPath });

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

  export function updateProjectSettings(ctx: CoreContext,
    repoPath: string,
    settings: {
      verificationMode?: VerificationMode;
      preferredHost?: HostEnvironment;
      testCommand?: string;
      sensitivePaths?: string[];
      riskThresholdLines?: number;
      enableCoverage?: boolean;
    }
  ): Project {
    const project = ctx.ensureProject(repoPath);
    const testCommandSignature = settings.testCommand
      ? signTestCommand(project.id, settings.testCommand)
      : undefined;
    ctx.db.updateProjectSettings(project.id, {
      ...settings,
      testCommandSignature,
    });
    const updated = ctx.db.getProject(project.id)!;
    ctx.emitChange('project_settings_updated', updated);
    return updated;
  }

  /**
   * Agent proposes a test command with rationale.
   * Registered in DB as pending user confirmation in Desktop App.
   */
  export function proposeTestCommand(ctx: CoreContext,
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
    const project = ctx.ensureProject(repoPath);
    ctx.db.updateProjectProposedTestCommand(project.id, command, reason);
    ctx.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `테스트 명령 제안: ${command}`,
      `에이전트가 검증용 테스트 명령을 제안했습니다. (사유: ${reason}). 사용자가 앱 대시보드에서 확정할 때까지 대기합니다.`,
      null,
      'agent'
    );
    const updated = ctx.db.getProject(project.id)!;
    ctx.emitChange('project_updated', updated);
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
  export function confirmTestCommand(ctx: CoreContext, repoPath: string, command: string): Project {
    const project = ctx.ensureProject(repoPath);
    const signature = signTestCommand(project.id, command);
    ctx.db.updateProjectConfirmedTestCommand(project.id, command, signature);
    ctx.recordAgentEvent(
      project.rootPath,
      'NOTE',
      `테스트 명령 확정: ${command}`,
      `사용자가 테스트 명령을 공식 확정하고 HMAC 전자서명을 발급했습니다.`,
      null,
      'user'
    );
    const updated = ctx.db.getProject(project.id)!;
    ctx.emitChange('project_settings_updated', updated);
    return updated;
  }

  /**
   * User approval: Computes ApprovalFingerprint and pins file pre-image hashes.
   */