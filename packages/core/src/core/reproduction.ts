import * as path from 'node:path';
import * as fs from 'node:fs';
import { CoreContext } from './context.js';
import { ReproductionResult, ReproductionStatus, Incident } from '../types.js';
import { parseStackFrames, analyzeIncident } from '../analysis/analyzer.js';
import { verifyTestCommandSignature } from '../utils/security.js';

  export async function runReproduction(ctx: CoreContext, 
    repoPath: string,
    incidentId: string,
    testFilePath: string
  ): Promise<ReproductionResult> {
    const targetPath = path.resolve(repoPath);
    const incident = ctx.db.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident with ID "${incidentId}" not found.`);
    }

    const project = ctx.ensureProject(targetPath);

    // 1. Validate that input is strictly a file path and contains no shell metacharacters
    const rawPath = String(testFilePath || '').trim().replace(/^["']|["']$/g, '');
    if (!rawPath || /[\r\n;&|`$><]/.test(rawPath)) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        exitCode: 1,
        output: '유효하지 않은 테스트 파일 경로입니다. 재현 테스트에는 임의의 셸 명령이나 제어 문자를 전달할 수 없으며 오직 단일 파일 경로만 허용됩니다.',
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 파일 경로 유효성 검증 실패`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      return reproductionResult;
    }

    // 2. Check if host test file exists
    const hostFile = path.resolve(targetPath, rawPath);
    if (!fs.existsSync(hostFile) || !fs.statSync(hostFile).isFile()) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        exitCode: 1,
        output: `재현 테스트 파일이 존재하지 않습니다: ${rawPath}`,
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 파일 없음: ${rawPath}`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      return reproductionResult;
    }

    // 3. Check for confirmed test runner with valid signature
    const isRunnerConfirmed = Boolean(
      project.testCommand &&
      project.testCommandSignature &&
      verifyTestCommandSignature(project.id, project.testCommand, project.testCommandSignature)
    );

    if (!isRunnerConfirmed) {
      const reproductionResult: ReproductionResult = {
        status: 'CANNOT_RUN',
        command: '',
        exitCode: 1,
        output: '확정된 테스트 러너가 없습니다. 앱 프로젝트 설정에서 테스트 명령을 먼저 확정한 후 재현 테스트를 실행할 수 있습니다.',
        executedAt: new Date().toISOString(),
      };
      const causeEvidence = [...(incident.causeEvidence || []), `[실행 증거] 재현 테스트 실행 불가 - 확정된 테스트 러너 없음`];
      ctx.db.updateIncidentReproduction(incidentId, reproductionResult, incident.causeVerdict, causeEvidence);
      return reproductionResult;
    }

    // 4. Construct execution command using confirmed runner and relative file path
    const relTestPath = path.relative(targetPath, hostFile).replace(/\\/g, '/');
    const effectiveCommand = buildReproductionCommand(project.testCommand!, relTestPath);

    // 5. Create isolated worktree for reproduction
    const sandboxId = `repro-${incidentId.slice(0, 8)}-${Date.now()}`;
    const baseCommit = incident.baseCheckpointId
      ? ctx.db.getCheckpoint(incident.baseCheckpointId)?.worktreeCommitSha || 'HEAD'
      : 'HEAD';

    const { sandboxDir } = ctx.worktreeRunner.createWorktree(targetPath, sandboxId, baseCommit, [], effectiveCommand);

    try {
      // 6. Copy reproduction test file from host repository into sandbox
      const destFile = path.resolve(sandboxDir, relTestPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(hostFile, destFile);

      // 7. Run reproduction test in sandbox
      const testResult = await ctx.worktreeRunner.runTest(sandboxDir, effectiveCommand, 30000);

      // 8. Determine reproduction status
      let status: ReproductionStatus = 'NOT_REPRODUCED';
      let failedLocation: { filePath: string; line: number } | undefined;

      if (!testResult.success) {
        const frames = parseStackFrames(testResult.output);
        const hasTestFailureSignature =
          /AssertionError|not ok|FAIL|assert|Failure|panic|Traceback|expected|received/i.test(testResult.output) ||
          frames.length > 0;
        const hasCommandExecutionError =
          /command not found|is not recognized|Cannot find module|No such file|내부 또는 외부 명령|배치 파일/i.test(testResult.output);

        if (!hasTestFailureSignature || hasCommandExecutionError) {
          status = 'CANNOT_RUN';
        } else {
          status = 'REPRODUCED';
          if (frames.length > 0) {
            failedLocation = { filePath: frames[0].filePath, line: frames[0].line };
          }
        }
      } else {
        status = 'NOT_REPRODUCED';
      }

      const reproductionResult: ReproductionResult = {
        status,
        command: effectiveCommand,
        exitCode: testResult.exitCode,
        output: testResult.output,
        failedLocation,
        executedAt: new Date().toISOString(),
      };

      // 9. Update incident in DB with execution evidence & re-evaluate causeVerdict
      const updatedIncident: Incident = {
        ...incident,
        reproductionResult,
      };

      const analysis = analyzeIncident(
        incident.errorOutput,
        incident.diffSummary,
        targetPath,
        project.name,
        'HEAD',
        updatedIncident
      );

      const causeEvidence = [...(incident.causeEvidence || [])];
      if (status === 'REPRODUCED') {
        const locNote = failedLocation ? ` (${failedLocation.filePath}:${failedLocation.line})` : '';
        causeEvidence.push(`[실행 증거] 재현 테스트 실행으로 실패 재현 확인${locNote} - ${effectiveCommand}`);
      } else if (status === 'NOT_REPRODUCED') {
        causeEvidence.push(`[실행 증거] 재현 테스트에서 실패가 재현되지 않음 - ${effectiveCommand}`);
      } else {
        causeEvidence.push(`[실행 증거] 재현 테스트 실행 불가 - ${effectiveCommand}`);
      }

      ctx.db.updateIncidentReproduction(
        incidentId,
        reproductionResult,
        analysis.causeVerdict,
        causeEvidence
      );

      ctx.emitChange('incident_updated', {
        incidentId,
        reproductionResult,
        causeVerdict: analysis.causeVerdict,
      });

      return reproductionResult;
    } finally {
      ctx.worktreeRunner.cleanupWorktree(targetPath, sandboxDir);
    }
  }

  /**
   * Helper to construct a single test execution command from confirmed test runner and relative test file path.
   */
  export function buildReproductionCommand(confirmedRunner: string, relTestPath: string): string {
    const trimmed = confirmedRunner.trim();
    if (trimmed.includes('{file}')) {
      return trimmed.replace(/\{file\}/g, `"${relTestPath}"`);
    }
    if (/\bpython\b.*-m\s+unittest/i.test(trimmed)) {
      return `python -m unittest "${relTestPath}"`;
    }
    if (/\bpytest\b/i.test(trimmed)) {
      return `pytest "${relTestPath}"`;
    }
    if (/\bnode\s+--test\b/i.test(trimmed)) {
      return `node --test "${relTestPath}"`;
    }
    if (/^(npm|pnpm|yarn)(\.cmd)?\s+test/i.test(trimmed)) {
      return `${trimmed} -- "${relTestPath}"`;
    }
    if (/^go\s+test/i.test(trimmed)) {
      return `go test "${relTestPath}"`;
    }
    if (/^cargo\s+test/i.test(trimmed)) {
      return `cargo test -- "${relTestPath}"`;
    }
    if (trimmed === 'node' || trimmed === 'node.exe') {
      return `node "${relTestPath}"`;
    }
    return `${trimmed} "${relTestPath}"`;
  }

  /**
   * Returns structured next_action for an incident based on missing intents.
   */