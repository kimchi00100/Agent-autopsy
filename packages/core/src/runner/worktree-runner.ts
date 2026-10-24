import { execFileSync, spawn, spawnSync, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import {
  StageName,
  StageResult,
  StageStatus,
  ThreeLevelHealth,
  ThreeStageExecutionResult,
} from '../types.js';

export interface TestExecutionResult {
  success: boolean;
  output: string;
  exitCode: number;
  durationMs: number;
  stages?: StageResult[];
  threeLevelHealth?: ThreeLevelHealth;
}

export interface ThreeStageValidationOptions {
  worktreePath: string;
  repoPath: string;
  touchedFiles: string[];
  fullTestCommand: string;
  targetTestCommand?: string;
  timeoutMs?: number;
}

export interface HeavyDirsWatcher {
  detectedChanges: string[];
  isWatching: boolean;
  stop: () => void;
}

const HEAVY_DIR_NAMES = ['node_modules', '.venv', 'venv', 'target'];
const MANIFEST_NAMES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'requirements.txt', 'Cargo.toml', 'Cargo.lock'];

/**
 * Safely kills a process and all its child/descendant processes (Process Tree Kill).
 * Prevents orphaned lingering child processes across Windows and POSIX.
 */
export function killProcessTree(pid: number): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', pid.toString(), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      // Process might have already terminated
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }
  }
}

export class WorktreeRunner {
  /**
   * Masks secrets, tokens, private keys, and passwords from execution output.
   */
  public static maskSecrets(text: string): string {
    if (!text) return text;
    let masked = text;

    // 1. Private keys
    masked = masked.replace(
      /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]'
    );

    // 2. Bearer tokens: Bearer <token>
    masked = masked.replace(
      /\b(Bearer\s+)[A-Za-z0-9_\-\.]{16,}\b/g,
      '$1[REDACTED_SECRET]'
    );

    // 3. GitHub tokens: ghp_..., gho_..., github_pat_...
    masked = masked.replace(
      /\b(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
      '[REDACTED_SECRET]'
    );

    // 4. Google API keys: AIzaSy...
    masked = masked.replace(
      /\bAIzaSy[A-Za-z0-9_\-]{33}\b/g,
      '[REDACTED_SECRET]'
    );

    // 5. OpenAI / Slack / generic sk- tokens
    masked = masked.replace(
      /\b(sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9\-]{20,})\b/g,
      '[REDACTED_SECRET]'
    );

    // 6. AWS Access Key IDs: AKIA...
    masked = masked.replace(
      /\bAKIA[0-9A-Z]{16}\b/g,
      '[REDACTED_SECRET]'
    );

    // 7. Key-value patterns: password=..., api_key="...", secret: '...'
    masked = masked.replace(
      /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|password|access[_-]?token|auth[_-]?token)\s*([:=])\s*(['"]?)([A-Za-z0-9_\-.~+/=]{12,})\3/gi,
      (match, key, sep, quote) => `${key}${sep}${quote}[REDACTED_SECRET]${quote}`
    );

    return masked;
  }

  /**
   * Executes a command asynchronously in the worktree directory with process-tree cancellation,
   * timeout enforcement, and secret masking.
   */
  public runCommand(
    worktreePath: string,
    command: string,
    timeoutMs: number = 60000
  ): Promise<TestExecutionResult> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const isWindows = process.platform === 'win32';

      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      let child: ChildProcess;

      try {
        child = spawn(command, {
          cwd: worktreePath,
          shell: true,
          windowsHide: true,
          detached: !isWindows,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        return resolve({
          success: false,
          output: WorktreeRunner.maskSecrets(`프로세스 실행 실패: ${err.message}`),
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 5 * 1024 * 1024) {
          stdout = stdout.slice(-5 * 1024 * 1024);
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 5 * 1024 * 1024) {
          stderr = stderr.slice(-5 * 1024 * 1024);
        }
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            killProcessTree(child.pid);
          }
        }, timeoutMs);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          success: false,
          output: WorktreeRunner.maskSecrets(`프로세스 오류 발생: ${err.message}`),
          exitCode: 1,
          durationMs,
        });
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;

        if (timedOut) {
          return resolve({
            success: false,
            output: `테스트 실행 시간이 초과되었습니다 (${timeoutMs}ms). 무한 루프 가능성이 있어 하위 프로세스 트리를 강제 종료했습니다.`,
            exitCode: 124,
            durationMs,
          });
        }

        const raw = (stdout + (stderr ? '\n' + stderr : '')).trim();
        const masked = WorktreeRunner.maskSecrets(raw);

        resolve({
          success: code === 0,
          output: masked || (code === 0 ? '명령이 성공적으로 완료되었습니다.' : '명령 실행이 실패했습니다.'),
          exitCode: code ?? (code === 0 ? 0 : 1),
          durationMs,
        });
      });
    });
  }

  /**
   * Executes the test command in the isolated worktree directory (async with process-tree kill).
   */
  public async runTest(
    worktreePath: string,
    testCommand: string,
    timeoutMs: number = 60000
  ): Promise<TestExecutionResult> {
    return this.runCommand(worktreePath, testCommand, timeoutMs);
  }

  /**
   * Executes a command synchronously with secret masking (for synchronous discovery/bundle collection).
   */
  public runTestSync(
    worktreePath: string,
    testCommand: string,
    timeoutMs: number = 30000
  ): TestExecutionResult {
    const startTime = Date.now();
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const result = spawnSync(shell, [shellFlag, testCommand], {
      cwd: worktreePath,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });

    const durationMs = Date.now() - startTime;
    if (result.error) {
      if ((result.error as any).code === 'ETIMEDOUT') {
        return {
          success: false,
          output: `테스트 실행 시간이 초과되었습니다 (${timeoutMs}ms).`,
          exitCode: 124,
          durationMs,
        };
      }
      return {
        success: false,
        output: WorktreeRunner.maskSecrets(`테스트 명령 "${testCommand}" 실행 실패: ${result.error.message}`),
        exitCode: 1,
        durationMs,
      };
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const rawOutput = (stdout + (stderr ? '\n' + stderr : '')).trim();
    const maskedOutput = WorktreeRunner.maskSecrets(rawOutput);

    return {
      success: result.status === 0,
      output: maskedOutput || (result.status === 0 ? '테스트가 성공적으로 통과했습니다.' : '테스트가 실패했습니다.'),
      exitCode: result.status ?? 1,
      durationMs,
    };
  }

  /**
   * Executes the 3-stage validation pipeline:
   * 1. CODE_CHECK (syntax/type check)
   * 2. TARGET_FUNCTIONAL_CHECK (isolated reproduction test)
   * 3. FULL_REGRESSION_CHECK (entire project test suite)
   */
  public async runThreeStageValidation(
    options: ThreeStageValidationOptions
  ): Promise<ThreeStageExecutionResult> {
    const {
      worktreePath,
      touchedFiles = [],
      fullTestCommand,
      targetTestCommand,
      timeoutMs = 60000,
    } = options;

    const stages: StageResult[] = [];
    const overallStartTime = Date.now();

    // 0-E Checkpoint: Start recursive real-time file system watchers on host heavy dependency folders (node_modules, .venv, etc.)
    const heavyWatch = this.startHeavyDirsWatch(options.repoPath);
    let beforeHeavySnapshot: Record<string, Record<string, { mtimeMs: number; size: number }>> | null = null;
    if (!heavyWatch.isWatching) {
      // Fallback: If platform/filesystem does not support recursive watch, take snapshot as fallback
      beforeHeavySnapshot = this.captureHeavyDirsSnapshot(options.repoPath);
    }

    const checkDependencyMutations = async (): Promise<{ dirChanges: string[]; truncationNote: string }> => {
      // 의존성 폴더 감시를 끄기 전에 300ms 정도 기다려서, 테스트 마지막 순간(프로세스 종료 직전)의 쓰기 이벤트가 늦게 도착해도 놓치지 않게 함
      await new Promise((r) => setTimeout(r, 300));
      const isWatching = heavyWatch.isWatching;
      const detectedChanges = [...heavyWatch.detectedChanges];
      heavyWatch.stop();

      if (isWatching) {
        return {
          dirChanges: detectedChanges,
          truncationNote: '',
        };
      }

      if (beforeHeavySnapshot) {
        const truncatedDirs: string[] = [];
        const changes = this.detectHeavyDirsChange(
          options.repoPath,
          beforeHeavySnapshot,
          4,
          2000,
          truncatedDirs
        );
        const note = truncatedDirs.length > 0
          ? `⚠️ [일부 확인 못 함]: 의존성 폴더(${truncatedDirs.join(', ')}) 파일 수가 한도(2,000개)에 도달하여 일부 깊은 경로를 확인하지 못했습니다.`
          : '';
        return { dirChanges: changes, truncationNote: note };
      }

      return { dirChanges: [], truncationNote: '' };
    };

    // --- STAGE 1: CODE_CHECK (문법/정적 구문 검사) ---
    let codeCheckCmd = '';
    const jsFiles = touchedFiles.filter((f) => /\.(js|cjs|mjs)$/i.test(f) && fs.existsSync(path.resolve(worktreePath, f)));
    const pyFiles = touchedFiles.filter((f) => /\.py$/i.test(f) && fs.existsSync(path.resolve(worktreePath, f)));
    const rsFiles = touchedFiles.filter((f) => /\.rs$/i.test(f));

    if (jsFiles.length > 0) {
      codeCheckCmd = jsFiles.map((f) => `node --check "${f}"`).join(' && ');
    } else if (pyFiles.length > 0) {
      codeCheckCmd = `python -m py_compile ${pyFiles.map((f) => `"${f}"`).join(' ')}`;
    } else if (rsFiles.length > 0 && fs.existsSync(path.join(worktreePath, 'Cargo.toml'))) {
      codeCheckCmd = 'cargo check';
    }

    let stage1: StageResult;
    if (codeCheckCmd) {
      const res1 = await this.runCommand(worktreePath, codeCheckCmd, Math.min(timeoutMs, 20000));
      stage1 = {
        stage: 'CODE_CHECK',
        command: codeCheckCmd,
        status: res1.success ? 'PASS' : 'FAIL',
        output: res1.output,
        exitCode: res1.exitCode,
        durationMs: res1.durationMs,
      };
    } else {
      stage1 = {
        stage: 'CODE_CHECK',
        command: 'none',
        status: 'SKIPPED',
        output: '해당 파일 형식에 대한 독립 구문 검사 도구가 없으므로 건너뜁니다.',
        exitCode: 0,
        durationMs: 0,
      };
    }
    stages.push(stage1);

    // If syntax check failed, immediately abort stages 2 & 3
    if (stage1.status === 'FAIL') {
      heavyWatch.stop();
      const stage2Skipped: StageResult = {
        stage: 'TARGET_FUNCTIONAL_CHECK',
        command: targetTestCommand || 'skipped',
        status: 'SKIPPED',
        output: '1단계 구문 검사(CODE_CHECK) 실패로 인해 타깃 테스트가 중단되었습니다.',
        exitCode: 0,
        durationMs: 0,
      };
      const stage3Skipped: StageResult = {
        stage: 'FULL_REGRESSION_CHECK',
        command: fullTestCommand || 'skipped',
        status: 'SKIPPED',
        output: '1단계 구문 검사(CODE_CHECK) 실패로 인해 전체 회귀 테스트가 중단되었습니다.',
        exitCode: 0,
        durationMs: 0,
      };
      stages.push(stage2Skipped, stage3Skipped);

      const threeLevelHealth: ThreeLevelHealth = {
        code: 'FAIL',
        functional: 'UNKNOWN',
        requirement: 'UNKNOWN',
        details: {
          codeSummary: `문법 오류 발생: ${stage1.output.slice(0, 300)}`,
          functionalSummary: '1단계 실패로 검증 건너뜀',
          requirementSummary: '1단계 실패로 검증 건너뜀',
        },
      };

      return {
        success: false,
        output: this.formatPipelineReport(stages),
        exitCode: stage1.exitCode,
        durationMs: Date.now() - overallStartTime,
        stages,
        threeLevelHealth,
      };
    }

    // --- STAGE 2: TARGET_FUNCTIONAL_CHECK (타깃 기능 검사) ---
    let effectiveTargetCmd = targetTestCommand;
    if (!effectiveTargetCmd) {
      // Auto-detect matching test file
      for (const touched of touchedFiles) {
        const base = path.basename(touched, path.extname(touched));
        const candidateTestFiles = [
          path.join('test', `${base}.test.js`),
          path.join('test', `${base}.spec.js`),
          path.join('tests', `${base}.test.js`),
          path.join('__tests__', `${base}.test.js`),
          'test.js',
          'test.ts',
        ];
        for (const cand of candidateTestFiles) {
          if (fs.existsSync(path.resolve(worktreePath, cand))) {
            effectiveTargetCmd = `node "${cand}"`;
            break;
          }
        }
        if (effectiveTargetCmd) break;
      }
      if (!effectiveTargetCmd) {
        // Fallback: use full test command as target test
        effectiveTargetCmd = fullTestCommand;
      }
    }

    const res2 = await this.runCommand(worktreePath, effectiveTargetCmd, timeoutMs);
    const stage2: StageResult = {
      stage: 'TARGET_FUNCTIONAL_CHECK',
      command: effectiveTargetCmd,
      status: res2.success ? 'PASS' : 'FAIL',
      output: res2.output,
      exitCode: res2.exitCode,
      durationMs: res2.durationMs,
    };
    stages.push(stage2);

    if (stage2.status === 'FAIL') {
      const stage3Skipped: StageResult = {
        stage: 'FULL_REGRESSION_CHECK',
        command: fullTestCommand || 'skipped',
        status: 'SKIPPED',
        output: '2단계 타깃 기능 검사(TARGET_FUNCTIONAL_CHECK) 실패로 인해 전체 회귀 테스트가 중단되었습니다.',
        exitCode: 0,
        durationMs: 0,
      };
      stages.push(stage3Skipped);

      const threeLevelHealth: ThreeLevelHealth = {
        code: 'PASS',
        functional: 'FAIL',
        requirement: 'FAIL',
        details: {
          codeSummary: '구문 검사 통과',
          functionalSummary: `타깃 기능 테스트 실패: ${stage2.output.slice(0, 300)}`,
          requirementSummary: '2단계 실패로 전체 검증 중단',
        },
      };

      const { dirChanges, truncationNote } = await checkDependencyMutations();

      if (dirChanges.length > 0) {
        const taintWarning = `[원본 의존성 폴더 변경 감지]: 격리 검증 중 원본 의존성 폴더(${dirChanges.slice(0, 5).join(', ')}${dirChanges.length > 5 ? ` 외 ${dirChanges.length - 5}건` : ''})가 변경되었습니다. 호스트 환경 오염 방지를 위해 검증이 실패로 처리됩니다.`;
        if (threeLevelHealth.details) {
          threeLevelHealth.details.functionalSummary = '원본 의존성 폴더 변경 감지';
          threeLevelHealth.details.requirementSummary = taintWarning;
        }
        return {
          success: false,
          output:
            this.formatPipelineReport(stages) +
            `\n\n❌ ${taintWarning}` +
            (truncationNote ? `\n\n${truncationNote}` : ''),
          exitCode: 1,
          durationMs: Date.now() - overallStartTime,
          stages,
          threeLevelHealth,
        };
      }

      return {
        success: false,
        output:
          this.formatPipelineReport(stages) +
          (truncationNote ? `\n\n${truncationNote}` : ''),
        exitCode: stage2.exitCode,
        durationMs: Date.now() - overallStartTime,
        stages,
        threeLevelHealth,
      };
    }

    // --- STAGE 3: FULL_REGRESSION_CHECK (전체 회귀 검사) ---
    let stage3: StageResult;
    if (effectiveTargetCmd === fullTestCommand) {
      // Already ran full suite in Stage 2
      stage3 = {
        stage: 'FULL_REGRESSION_CHECK',
        command: fullTestCommand,
        status: 'PASS',
        output: '2단계 타깃 기능 검사에서 전체 프로젝트 테스트 스위트를 이미 수행하여 정상 통과를 확인했습니다.',
        exitCode: 0,
        durationMs: 0,
      };
    } else {
      const res3 = await this.runCommand(worktreePath, fullTestCommand, timeoutMs);
      stage3 = {
        stage: 'FULL_REGRESSION_CHECK',
        command: fullTestCommand,
        status: res3.success ? 'PASS' : 'FAIL',
        output: res3.output,
        exitCode: res3.exitCode,
        durationMs: res3.durationMs,
      };
    }
    stages.push(stage3);

    const isRegressionFail = stage3.status === 'FAIL';
    const threeLevelHealth: ThreeLevelHealth = {
      code: 'PASS',
      functional: 'PASS',
      requirement: isRegressionFail ? 'FAIL' : 'PASS',
      details: {
        codeSummary: '문법 및 정적 검사 정상 통과',
        functionalSummary: '타깃 기능 및 오류 재현 검증 정상 통과',
        requirementSummary: isRegressionFail
          ? `기존 기능 회귀 발생: ${stage3.output.slice(0, 300)}`
          : '전체 프로젝트 요구사항 및 회귀 테스트 정상 통과',
      },
    };

    // 0-E Check: Ensure connected host heavy dependency directories (node_modules, etc.) were not mutated during test execution
    const { dirChanges, truncationNote } = await checkDependencyMutations();

    if (dirChanges.length > 0) {
      const taintWarning = `[원본 의존성 폴더 변경 감지]: 격리 검증 중 원본 의존성 폴더(${dirChanges.slice(0, 5).join(', ')}${dirChanges.length > 5 ? ` 외 ${dirChanges.length - 5}건` : ''})가 변경되었습니다. 호스트 환경 오염 방지를 위해 검증이 실패로 처리됩니다.`;
      stages.push({
        stage: 'FULL_REGRESSION_CHECK',
        command: options.fullTestCommand,
        status: 'FAIL',
        output: taintWarning,
        exitCode: 1,
        durationMs: 0,
      });

      threeLevelHealth.functional = 'FAIL';
      threeLevelHealth.requirement = 'FAIL';
      if (threeLevelHealth.details) {
        threeLevelHealth.details.functionalSummary = '원본 의존성 폴더 변경 감지';
        threeLevelHealth.details.requirementSummary = taintWarning;
      }

      return {
        success: false,
        output:
          this.formatPipelineReport(stages) +
          `\n\n❌ ${taintWarning}` +
          (truncationNote ? `\n\n${truncationNote}` : ''),
        exitCode: 1,
        durationMs: Date.now() - overallStartTime,
        stages,
        threeLevelHealth,
      };
    }

    if (truncationNote && threeLevelHealth.details && threeLevelHealth.details.requirementSummary) {
      threeLevelHealth.details.requirementSummary += ` (※ 의존성 폴더 일부 확인 못 함)`;
    }

    return {
      success: !isRegressionFail,
      output:
        this.formatPipelineReport(stages) +
        (truncationNote ? `\n\n${truncationNote}` : ''),
      exitCode: stage3.exitCode,
      durationMs: Date.now() - overallStartTime,
      stages,
      threeLevelHealth,
    };
  }

  /**
   * Starts non-blocking recursive file system watcher on heavy dependency folders (node_modules, .venv, etc.).
   * Captures any real-time write/delete/create mutations at any depth without up-front directory tree traversal.
   */
  public startHeavyDirsWatch(repoPath: string): HeavyDirsWatcher {
    const detectedChanges: string[] = [];
    const watchers: fs.FSWatcher[] = [];
    let isWatching = false;

    for (const heavyDir of HEAVY_DIR_NAMES) {
      const srcPath = path.join(repoPath, heavyDir);
      if (fs.existsSync(srcPath)) {
        try {
          const watcher = fs.watch(srcPath, { recursive: true }, (eventType, filename) => {
            const normalized = filename ? filename.replace(/\\/g, '/') : '';
            const relPath = normalized ? `${heavyDir}/${normalized}` : `${heavyDir} (${eventType})`;
            if (!detectedChanges.includes(relPath)) {
              detectedChanges.push(relPath);
            }
          });
          watcher.on('error', () => {});
          watchers.push(watcher);
          isWatching = true;
        } catch {
          // Recursive watch not supported on this platform/filesystem; fallback to snapshot
        }
      }
    }

    return {
      detectedChanges,
      isWatching,
      stop: () => {
        for (const w of watchers) {
          try {
            w.close();
          } catch {}
        }
      },
    };
  }

  /**
   * Recursively walks a heavy dependency directory up to maxDepth and maxEntries,
   * recording relative paths and their mtimeMs and size.
   */
  private walkHeavyDir(
    baseDir: string,
    currentRel: string,
    depth: number,
    maxDepth: number,
    result: Record<string, { mtimeMs: number; size: number }>,
    counter: { count: number; max: number; truncated?: boolean }
  ): void {
    if (depth > maxDepth || counter.count >= counter.max) {
      if (counter.count >= counter.max) {
        counter.truncated = true;
      }
      return;
    }

    const fullPath = currentRel ? path.join(baseDir, currentRel) : baseDir;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (counter.count >= counter.max) {
        counter.truncated = true;
        break;
      }
      const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const entryFullPath = path.join(baseDir, rel);

      try {
        const stat = fs.statSync(entryFullPath);
        result[rel] = { mtimeMs: stat.mtimeMs, size: stat.size };
        counter.count++;

        if (entry.isDirectory() && depth < maxDepth) {
          this.walkHeavyDir(baseDir, rel, depth + 1, maxDepth, result, counter);
        }
      } catch {}
    }
  }

  /**
   * Captures the top-level and nested entries (up to depth 4) of heavy dependency directories in the host repo.
   */
  public captureHeavyDirsSnapshot(
    repoPath: string,
    maxDepth: number = 4,
    maxEntriesPerDir: number = 2000,
    outTruncatedDirs?: string[]
  ): Record<string, Record<string, { mtimeMs: number; size: number }>> {
    const snapshot: Record<string, Record<string, { mtimeMs: number; size: number }>> = {};
    for (const heavyDir of HEAVY_DIR_NAMES) {
      const src = path.join(repoPath, heavyDir);
      if (fs.existsSync(src)) {
        snapshot[heavyDir] = {};
        const counter = { count: 0, max: maxEntriesPerDir, truncated: false };
        this.walkHeavyDir(src, '', 1, maxDepth, snapshot[heavyDir], counter);
        if (counter.truncated && outTruncatedDirs && !outTruncatedDirs.includes(heavyDir)) {
          outTruncatedDirs.push(heavyDir);
        }
      }
    }
    return snapshot;
  }

  /**
   * Detects if any heavy dependency directories in the host repo (top-level or inner subfolders)
   * were modified during validation.
   */
  public detectHeavyDirsChange(
    repoPath: string,
    before: Record<string, Record<string, { mtimeMs: number; size: number }>>,
    maxDepth: number = 4,
    maxEntriesPerDir: number = 2000,
    outTruncatedDirs?: string[]
  ): string[] {
    const changes: string[] = [];
    const after = this.captureHeavyDirsSnapshot(repoPath, maxDepth, maxEntriesPerDir, outTruncatedDirs);

    for (const heavyDir of HEAVY_DIR_NAMES) {
      const src = path.join(repoPath, heavyDir);
      const beforeDir = before[heavyDir];
      const existsNow = fs.existsSync(src);

      if (!beforeDir && existsNow) {
        changes.push(`${heavyDir} 폴더 생성`);
        continue;
      }
      if (beforeDir && !existsNow) {
        changes.push(`${heavyDir} 폴더 삭제`);
        continue;
      }
      if (!beforeDir && !existsNow) continue;

      const afterDir = after[heavyDir] || {};
      const currentKeys = new Set(Object.keys(afterDir));
      const beforeKeys = new Set(Object.keys(beforeDir!));

      for (const rel of currentKeys) {
        if (!beforeKeys.has(rel)) {
          changes.push(`${heavyDir}/${rel} 파일 추가`);
        } else {
          const b = beforeDir![rel];
          const a = afterDir[rel];
          if (b && a && (b.size !== a.size || Math.abs(b.mtimeMs - a.mtimeMs) > 50)) {
            changes.push(`${heavyDir}/${rel} 내용 수정`);
          }
        }
      }

      for (const rel of beforeKeys) {
        if (!currentKeys.has(rel)) {
          changes.push(`${heavyDir}/${rel} 파일 삭제`);
        }
      }
    }

    return changes;
  }

  private formatPipelineReport(stages: StageResult[]): string {
    const lines = ['🔬 [Agent Autopsy 3단계 격리 검증 리포트]'];
    for (const s of stages) {
      const icon = s.status === 'PASS' ? '✅' : s.status === 'FAIL' ? '❌' : '⏭️';
      lines.push(`${icon} [${s.stage}] 상태: ${s.status} (${s.durationMs}ms)`);
      if (s.command && s.command !== 'none' && s.command !== 'skipped') {
        lines.push(`   명령: ${s.command}`);
      }
      if (s.output) {
        const preview = s.output.length > 500 ? s.output.slice(0, 500) + '... (생략)' : s.output;
        lines.push(`   결과: ${preview.split('\n').join('\n   ')}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Creates an isolated git worktree for safe test verification.
   * If baseCommitOrTree is provided (e.g. worktreeCommitSha), the sandbox checked out
   * will contain the uncommitted working-tree state matching the incident baseline.
   *
   * @param repoPath Root repository path
   * @param sandboxId Unique ID
   * @param baseCommitSha Commit or Ref to checkout (defaults to HEAD)
   * @param touchedFiles List of files proposed to be modified
   * @param testCommand Test command string
   */
  public createWorktree(
    repoPath: string,
    sandboxId: string,
    baseCommitSha: string = 'HEAD',
    touchedFiles: string[] = [],
    testCommand: string = ''
  ): { sandboxDir: string; linkedJunctions: string[]; isPureIsolated: boolean } {
    // Use dedicated cache root to completely protect target project from working-tree pollution
    const cacheRoot =
      process.env.AUTOPSY_CACHE_DIR ||
      path.resolve(process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(), 'AgentAutopsy', 'cache');
    const sandboxDir = path.resolve(cacheRoot, 'sandboxes', sandboxId);
    
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(sandboxDir), { recursive: true });

    // Clean up if prior run left it
    if (fs.existsSync(sandboxDir)) {
      this.cleanupWorktree(repoPath, sandboxDir);
    }

    try {
      execFileSync('git', ['worktree', 'add', '--detach', sandboxDir, baseCommitSha], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      // Fallback to HEAD if baseCommitSha fails
      try {
        execFileSync('git', ['worktree', 'add', '--detach', sandboxDir, 'HEAD'], {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (inner: any) {
        throw new Error(`Failed to create git worktree at ${sandboxDir}: ${inner.message}`);
      }
    }

    // Safety check: is it safe to link dependencies via Junction?
    // If touched files touch manifests or testCommand runs 'install', Junction is UNSAFE.
    const touchesManifest = touchedFiles.some((f) => {
      const base = path.basename(f);
      return MANIFEST_NAMES.includes(base);
    });
    const hasDangerousKeyword = /\b(npm\s+i|npm\s+install|pnpm\s+add|pnpm\s+install|pip\s+install|cargo\s+install|rm\s+-rf)\b/i.test(testCommand);

    const isPureIsolated = touchesManifest || hasDangerousKeyword;
    const linkedJunctions: string[] = [];

    if (!isPureIsolated) {
      const isWindows = process.platform === 'win32';
      for (const heavyDir of HEAVY_DIR_NAMES) {
        const srcPath = path.join(repoPath, heavyDir);
        const destPath = path.join(sandboxDir, heavyDir);

        if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
          try {
            fs.symlinkSync(srcPath, destPath, isWindows ? 'junction' : 'dir');
            linkedJunctions.push(destPath);
          } catch {
            // Ignore junction failure; tests might run without it
          }
        }
      }
    }

    return { sandboxDir, linkedJunctions, isPureIsolated };
  }

  /**
   * Safely unlinks junctions and removes the isolated worktree.
   */
  public cleanupWorktree(repoPath: string, worktreePath: string): void {
    if (!fs.existsSync(worktreePath)) return;

    // 1. Remove symlinks/junctions first so git worktree remove doesn't delete files in target!
    for (const heavyDir of HEAVY_DIR_NAMES) {
      const destPath = path.join(worktreePath, heavyDir);
      try {
        const stat = fs.lstatSync(destPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(destPath);
        }
      } catch {
        // Ignored
      }
    }

    // 2. Remove git worktree
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Fallback: manual folder delete
    }

    // 3. Ensure folder is gone
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  }
}
