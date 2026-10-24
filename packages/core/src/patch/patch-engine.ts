import * as fs from 'node:fs';
import * as path from 'node:path';
import * as diff from 'diff';
import { FileChange, Replacement } from '../types.js';

export interface PreparedPatch {
  appliedFiles: Map<string, string>; // relativePath -> new full content
  unifiedDiff: string;
  touchedFiles: string[];
}

export class PatchEngine {
  /**
   * Applies replacements to original content.
   * If search text is not found, throws a descriptive error so the agent knows exactly what failed.
   */
  public applyReplacements(
    filePath: string,
    originalContent: string,
    replacements: Replacement[]
  ): string {
    let content = originalContent;

    for (let i = 0; i < replacements.length; i++) {
      const { search, replace } = replacements[i];
      if (!search) {
        throw new Error(`Empty search block provided for file "${filePath}" at replacement index ${i}`);
      }

      // Check if search exists
      if (!content.includes(search)) {
        // Try trimming leading/trailing newlines in case agent had subtle whitespace difference
        const trimmedSearch = search.trim();
        if (content.includes(trimmedSearch)) {
          content = content.replace(trimmedSearch, replace.trim());
          continue;
        }

        const previewLen = 200;
        const searchPreview = search.length > previewLen ? search.slice(0, previewLen) + '...' : search;
        throw new Error(
          `Target search block not found in file "${filePath}".\nSearch snippet:\n${searchPreview}`
        );
      }

      // Replace first occurrence
      content = content.replace(search, replace);
    }

    return content;
  }

  /**
   * Validates and prepares all file changes in memory, generating a clean Unified Diff.
   * Does NOT touch the disk.
   */
  public preparePatch(baseDirectory: string, fileChanges: FileChange[]): PreparedPatch {
    const appliedFiles = new Map<string, string>();
    const touchedFiles: string[] = [];
    let fullUnifiedDiff = '';

    for (const change of fileChanges) {
      const relPath = change.filePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const fullPath = path.join(baseDirectory, relPath);
      touchedFiles.push(relPath);

      let originalContent = '';
      const fileExists = fs.existsSync(fullPath);
      if (fileExists) {
        originalContent = fs.readFileSync(fullPath, 'utf8');
      }

      let newContent = '';
      if (change.newContent !== undefined) {
        newContent = change.newContent;
      } else if (change.replacements && change.replacements.length > 0) {
        if (!fileExists) {
          throw new Error(
            `Cannot apply search & replace to non-existent file "${relPath}". Use newContent instead to create a new file.`
          );
        }
        newContent = this.applyReplacements(relPath, originalContent, change.replacements);
      } else {
        throw new Error(`FileChange for "${relPath}" must provide either replacements or newContent.`);
      }

      appliedFiles.set(relPath, newContent);

      const filePatch = diff.createTwoFilesPatch(
        `a/${relPath}`,
        `b/${relPath}`,
        originalContent,
        newContent,
        fileExists ? 'current' : '/dev/null',
        'proposed'
      );

      fullUnifiedDiff += filePatch + '\n';
    }

    return {
      appliedFiles,
      unifiedDiff: fullUnifiedDiff.trim(),
      touchedFiles,
    };
  }

  /**
   * Writes prepared changes directly to target directory on disk.
   */
  public writePatchToDisk(targetDirectory: string, appliedFiles: Map<string, string>): void {
    for (const [relPath, newContent] of appliedFiles.entries()) {
      const fullPath = path.join(targetDirectory, relPath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, newContent, 'utf8');
    }
  }
}
