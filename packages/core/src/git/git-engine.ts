import { execFileSync, execFile } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

export interface GitStatusResult {
  isClean: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
}

export interface GitCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface SnapshotResult {
  headSha: string;
  indexTreeSha: string;
  worktreeCommitSha: string;
  gitRef: string;
  changedFiles: string[];
  untrackedFiles: string[];
}

export class GitEngine {
  /**
   * Cache 1: Input path -> repository root (`git rev-parse --show-toplevel`).
   * Invalidation condition:
   * - A Git repository's top-level root does not change during application runtime
   *   for any resolved folder path within that repository.
   * - Keyed by normalized resolved input path.
   */
  private repoRootCache: Map<string, string> = new Map();

  /**
   * Cache 2: Recent commits log (`HEAD sha -> GitCommitInfo[]`).
   * Invalidation condition:
   * - Keyed by `${resolvedRepoPath}:${headSha}:${limit}`.
   * - When a new commit is made (or HEAD changes via rollback/checkout/rebase),
   *   the new HEAD SHA automatically produces a cache miss and fetches fresh commits from git.
   * - Entries remain valid as long as HEAD SHA and limit remain identical for that repository.
   * - STRICTLY FORBIDDEN: git status and git diff are NEVER cached.
   */
  private commitCache: Map<string, GitCommitInfo[]> = new Map();

  public clearCache(): void {
    this.repoRootCache.clear();
    this.commitCache.clear();
  }

  public runGit(repoPath: string, args: string[], env?: Record<string, string>): string {
    try {
      const output = execFileSync('git', args, {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env,
      });
      return output.trim();
    } catch (error: any) {
      const stderr = error.stderr ? error.stderr.toString() : '';
      throw new Error(`Git command failed [git ${args.join(' ')}]: ${stderr || error.message}`);
    }
  }

  public runGitAsync(repoPath: string, args: string[], env?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: repoPath,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          env: env ? { ...process.env, ...env } : process.env,
        },
        (error, stdout, stderr) => {
          if (error) {
            const errOutput = stderr ? stderr.toString() : '';
            reject(new Error(`Git command failed [git ${args.join(' ')}]: ${errOutput || error.message}`));
          } else {
            resolve((stdout || '').trim());
          }
        }
      );
    });
  }

  public getRepoRoot(targetPath: string): string {
    const normalized = path.resolve(targetPath);
    const cached = this.repoRootCache.get(normalized);
    if (cached) {
      return cached;
    }
    const root = this.runGit(targetPath, ['rev-parse', '--show-toplevel']);
    const resolved = path.resolve(root);
    this.repoRootCache.set(normalized, resolved);
    this.repoRootCache.set(resolved, resolved);
    return resolved;
  }

  public async getRepoRootAsync(targetPath: string): Promise<string> {
    const normalized = path.resolve(targetPath);
    const cached = this.repoRootCache.get(normalized);
    if (cached) {
      return cached;
    }
    const root = await this.runGitAsync(targetPath, ['rev-parse', '--show-toplevel']);
    const resolved = path.resolve(root);
    this.repoRootCache.set(normalized, resolved);
    this.repoRootCache.set(resolved, resolved);
    return resolved;
  }

  public getHeadSha(repoPath: string): string {
    return this.runGit(repoPath, ['rev-parse', 'HEAD']);
  }

  public async getHeadShaAsync(repoPath: string): Promise<string> {
    return this.runGitAsync(repoPath, ['rev-parse', 'HEAD']);
  }

  private parseStatusOutput(output: string): GitStatusResult {
    if (!output) {
      return { isClean: true, changedFiles: [], untrackedFiles: [] };
    }

    const lines = output.split('\n');
    const changedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const line of lines) {
      if (!line) continue;
      const status = line.substring(0, 2);
      const rawFile = line.substring(2).trim();
      const file = rawFile.replace(/^"|"$/g, '').replace(/\\/g, '/');
      if (status.includes('?')) {
        untrackedFiles.push(file);
      } else {
        changedFiles.push(file);
      }
    }

    return {
      isClean: changedFiles.length === 0 && untrackedFiles.length === 0,
      changedFiles,
      untrackedFiles,
    };
  }

  public getStatus(repoPath: string): GitStatusResult {
    const output = this.runGit(repoPath, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1']);
    return this.parseStatusOutput(output);
  }

  public async getStatusAsync(repoPath: string): Promise<GitStatusResult> {
    const output = await this.runGitAsync(repoPath, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1']);
    return this.parseStatusOutput(output);
  }

  /**
   * Computes SHA-256 hash of a file on disk. Returns empty string if file does not exist.
   */
  public getFileSha256(absFilePath: string): string {
    if (!fs.existsSync(absFilePath) || !fs.statSync(absFilePath).isFile()) {
      return '';
    }
    const content = fs.readFileSync(absFilePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Creates a non-destructive, permanent snapshot using a temporary Git index.
   * - Leaves the user's real staging area (.git/index) 100% untouched.
   * - Records HEAD, real Index tree, and dirty/untracked worktree commit.
   * - Anchors to `refs/autopsy/checkpoints/<id>` so `git gc` cannot prune it.
   * - Verifies integrity via `git rev-parse --verify`.
   */
  public createSnapshot(
    repoPath: string,
    checkpointId: string,
    message: string = 'Agent Autopsy Checkpoint'
  ): SnapshotResult {
    const headSha = this.getHeadSha(repoPath);
    const status = this.getStatus(repoPath);
    const gitRef = `refs/autopsy/checkpoints/${checkpointId}`;

    if (status.isClean) {
      let cleanIndexTree = headSha;
      try {
        cleanIndexTree = this.runGit(repoPath, ['write-tree']);
      } catch {}
      this.runGit(repoPath, ['update-ref', gitRef, headSha]);
      return {
        headSha,
        indexTreeSha: cleanIndexTree,
        worktreeCommitSha: headSha,
        gitRef,
        changedFiles: [],
        untrackedFiles: [],
      };
    }

    // 1. Capture user's actual staging area without mutating it
    let indexTreeSha = '';
    try {
      indexTreeSha = this.runGit(repoPath, ['write-tree']);
    } catch {
      // In empty repository before initial commit
      indexTreeSha = '';
    }

    // 2. Build isolated worktree commit using temporary index file
    const gitDir = path.resolve(repoPath, '.git');
    const tmpIndexFile = path.resolve(gitDir, `autopsy-tmp-idx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);

    let worktreeCommitSha = headSha;
    const allChanged = [...status.changedFiles, ...status.untrackedFiles];

    try {
      // Initialize temporary index from HEAD
      if (headSha) {
        this.runGit(repoPath, ['read-tree', headSha], { GIT_INDEX_FILE: tmpIndexFile });
      }

      // Add all changes (dirty tracked + untracked) into temporary index ONLY
      this.runGit(repoPath, ['add', '-A'], { GIT_INDEX_FILE: tmpIndexFile });

      // Write tree of temporary index
      const worktreeTreeSha = this.runGit(repoPath, ['write-tree'], { GIT_INDEX_FILE: tmpIndexFile });

      // Create commit object for worktree
      const commitArgs = ['commit-tree', worktreeTreeSha, '-m', message];
      if (headSha) {
        commitArgs.push('-p', headSha);
      }
      worktreeCommitSha = this.runGit(repoPath, commitArgs);
    } finally {
      // Always remove temporary index file
      try {
        if (fs.existsSync(tmpIndexFile)) {
          fs.unlinkSync(tmpIndexFile);
        }
      } catch {
        // Ignored
      }
    }

    // 3. Anchor commit to permanent custom ref: refs/autopsy/checkpoints/<checkpointId>
    this.runGit(repoPath, ['update-ref', gitRef, worktreeCommitSha]);

    // 4. Verify ref cryptographic integrity
    const verifiedSha = this.runGit(repoPath, ['rev-parse', '--verify', gitRef]);
    if (verifiedSha !== worktreeCommitSha) {
      throw new Error(`Integrity check failed: ref ${gitRef} (${verifiedSha}) does not match expected SHA ${worktreeCommitSha}`);
    }

    return {
      headSha,
      indexTreeSha: indexTreeSha || headSha,
      worktreeCommitSha,
      gitRef,
      changedFiles: status.changedFiles,
      untrackedFiles: status.untrackedFiles,
    };
  }

  /**
   * Restores repository to exact checkpoint state.
   * - Takes automatic safety backup of current state.
   * - Restores working directory and user's staging area.
   */
  public restoreSnapshot(
    repoPath: string,
    targetHeadSha: string,
    targetWorktreeCommitSha?: string,
    targetIndexTreeSha?: string,
    expectedUntracked: string[] = []
  ): { backupRef: string } {
    // 1. Take safety backup of current dirty state before touching anything
    const backupId = `bk_${Date.now()}`;
    const backup = this.createSnapshot(repoPath, backupId, 'Auto-backup before rollback');

    // 2. Checkout target HEAD
    this.runGit(repoPath, ['checkout', '-f', targetHeadSha]);

    // 3. If target had uncommitted worktree changes, restore them from commit
    if (targetWorktreeCommitSha && targetWorktreeCommitSha !== targetHeadSha) {
      this.runGit(repoPath, ['restore', '--source=' + targetWorktreeCommitSha, '--worktree', '.']);
    }

    // 4. Restore user's staging area if index tree is provided
    if (targetIndexTreeSha) {
      try {
        this.runGit(repoPath, ['read-tree', targetIndexTreeSha]);
      } catch {
        // Fallback: reset staging area to HEAD
        this.runGit(repoPath, ['reset']);
      }
    } else {
      this.runGit(repoPath, ['reset']);
    }

    // 5. Clean untracked files that were NOT part of the target checkpoint
    const currentStatus = this.getStatus(repoPath);
    const allowed = new Set(expectedUntracked.map((f) => f.replace(/\\/g, '/')));
    for (const u of currentStatus.untrackedFiles) {
      if (!allowed.has(u)) {
        const fullPath = path.resolve(repoPath, u);
        try {
          if (fs.existsSync(fullPath)) {
            if (fs.statSync(fullPath).isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
          }
        } catch {
          // Ignored
        }
      }
    }

    return { backupRef: backup.gitRef };
  }

  public getDiff(repoPath: string, fromRef?: string, toRef?: string): string {
    if (fromRef && toRef) {
      return this.runGit(repoPath, ['-c', 'core.quotepath=false', 'diff', `${fromRef}..${toRef}`]);
    }
    if (fromRef) {
      return this.runGit(repoPath, ['-c', 'core.quotepath=false', 'diff', fromRef]);
    }
    return this.runGit(repoPath, ['-c', 'core.quotepath=false', 'diff']);
  }

  public getRecentCommits(repoPath: string, limit: number = 10, headSha?: string): GitCommitInfo[] {
    let currentHead = headSha;
    if (!currentHead) {
      try {
        currentHead = this.getHeadSha(repoPath);
      } catch {
        currentHead = '';
      }
    }
    const cacheKey = `${path.resolve(repoPath)}:${currentHead}:${limit}`;
    if (currentHead && this.commitCache.has(cacheKey)) {
      return this.commitCache.get(cacheKey)!;
    }

    let output = '';
    try {
      output = this.runGit(repoPath, [
        'log',
        `-n`,
        limit.toString(),
        '--pretty=format:%H|%an|%ad|%s',
        '--date=iso',
      ]);
    } catch {
      output = '';
    }
    if (!output) {
      if (currentHead) {
        this.commitCache.set(cacheKey, []);
      }
      return [];
    }

    const commits = output.split('\n').map((line) => {
      const [sha, author, date, ...rest] = line.split('|');
      return {
        sha,
        author,
        date,
        message: rest.join('|'),
      };
    });
    if (currentHead) {
      this.commitCache.set(cacheKey, commits);
    }
    return commits;
  }

  public async getRecentCommitsAsync(
    repoPath: string,
    limit: number = 10,
    headSha?: string
  ): Promise<GitCommitInfo[]> {
    let currentHead = headSha;
    if (!currentHead) {
      try {
        currentHead = await this.getHeadShaAsync(repoPath);
      } catch {
        currentHead = '';
      }
    }
    const cacheKey = `${path.resolve(repoPath)}:${currentHead}:${limit}`;
    if (currentHead && this.commitCache.has(cacheKey)) {
      return this.commitCache.get(cacheKey)!;
    }

    let output = '';
    try {
      output = await this.runGitAsync(repoPath, [
        'log',
        `-n`,
        limit.toString(),
        '--pretty=format:%H|%an|%ad|%s',
        '--date=iso',
      ]);
    } catch {
      output = '';
    }
    if (!output) {
      if (currentHead) {
        this.commitCache.set(cacheKey, []);
      }
      return [];
    }

    const commits = output.split('\n').map((line) => {
      const [sha, author, date, ...rest] = line.split('|');
      return {
        sha,
        author,
        date,
        message: rest.join('|'),
      };
    });
    if (currentHead) {
      this.commitCache.set(cacheKey, commits);
    }
    return commits;
  }
}
