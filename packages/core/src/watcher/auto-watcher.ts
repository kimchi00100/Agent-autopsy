import * as chokidar from 'chokidar';
import * as path from 'node:path';
import { GitEngine } from '../git/git-engine.js';
import { AutopsyDatabase } from '../db/database.js';

export interface WatcherOptions {
  repoPath: string;
  projectId: string;
  debounceMs?: number;
  onAutoBaselineCaptured?: (checkpointId: string) => void;
}

export class AutoBaselineWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isCapturing = false;

  constructor(
    private options: WatcherOptions,
    private gitEngine: GitEngine,
    private db: AutopsyDatabase
  ) {}

  public start(): void {
    if (this.watcher) return;

    const ignored = [
      /(^|[\/\\])\../, // dotfiles/dotfolders
      '**/node_modules/**',
      '**/.git/**',
      '**/.autopsy/**',
      '**/dist/**',
      '**/build/**',
      '**/*.db*',
    ];

    this.watcher = chokidar.watch(this.options.repoPath, {
      ignored,
      ignoreInitial: true,
      persistent: false, // Don't block process exit if used in CLI
      ignorePermissionErrors: true,
    });

    this.watcher.on('error', (err) => {
      // Gracefully ignore filesystem watch permissions issues (e.g. OneDrive virtual files / EPERM)
    });

    const trigger = (event: string, filePath: string) => {
      this.handleFileChange(event, filePath);
    };

    this.watcher.on('add', (p) => trigger('add', p));
    this.watcher.on('change', (p) => trigger('change', p));
    this.watcher.on('unlink', (p) => trigger('unlink', p));
  }

  private handleFileChange(event: string, filePath: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const debounceMs = this.options.debounceMs ?? 1500;
    this.debounceTimer = setTimeout(() => {
      this.checkAndCaptureBaseline();
    }, debounceMs);
  }

  private checkAndCaptureBaseline(): void {
    if (this.isCapturing) return;

    try {
      this.isCapturing = true;

      // Check if we already have a recent checkpoint in the last 10 minutes
      const latest = this.db.getLatestCheckpoint(this.options.projectId);
      const now = Date.now();
      if (latest) {
        const lastTime = new Date(latest.createdAt).getTime();
        // If checkpoint taken in last 5 minutes, we already have a reasonably fresh baseline
        if (now - lastTime < 5 * 60 * 1000) {
          return;
        }
      }

      // Check if working directory actually has changes
      const status = this.gitEngine.getStatus(this.options.repoPath);
      if (status.isClean) {
        return;
      }

      const id = `cp_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

      // Capture automatic baseline
      const snapshot = this.gitEngine.createSnapshot(
        this.options.repoPath,
        id,
        'Auto-Baseline: Detected un-checkpointed file modifications'
      );

      this.db.insertCheckpoint({
        id,
        projectId: this.options.projectId,
        agentName: 'auto-watcher',
        label: 'Auto-Baseline (First Modification Detected)',
        gitHeadSha: snapshot.headSha,
        gitStashSha: snapshot.worktreeCommitSha,
        gitIndexSha: snapshot.indexTreeSha,
        worktreeCommitSha: snapshot.worktreeCommitSha,
        gitRef: snapshot.gitRef,
        changedFiles: snapshot.changedFiles,
        untrackedFiles: snapshot.untrackedFiles,
        createdAt: new Date().toISOString(),
      });

      if (this.options.onAutoBaselineCaptured) {
        this.options.onAutoBaselineCaptured(id);
      }
    } catch {
      // Ignore background auto-baseline errors silently
    } finally {
      this.isCapturing = false;
    }
  }

  public async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
