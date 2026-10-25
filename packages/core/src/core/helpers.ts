import * as path from 'node:path';
import { parseUnifiedDiff } from '../analysis/analyzer.js';

export function parseUnifiedDiffFiles(diff: string): string[] {
  return parseUnifiedDiff(diff).map((f) => f.filePath);
}

export function matchesGlobPath(filePath: string, pattern: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

  if (normPattern === '*' || normPattern === '**' || normPattern === '**/*') return true;

  const regexStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(normPath) || regex.test(path.basename(normPath));
}

export function countDiffLines(unifiedDiff: string): { addedLines: number; removedLines: number; totalChangedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  if (!unifiedDiff) return { addedLines: 0, removedLines: 0, totalChangedLines: 0 };
  const lines = unifiedDiff.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines++;
    else if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines, totalChangedLines: addedLines + removedLines };
}

export function firstMeaningfulLine(text: string): string {
  const line = (text || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? '').slice(0, 140);
}
