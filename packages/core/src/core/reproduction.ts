import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { CoreContext } from './context.js';
import { ReproductionResult, ReproductionStatus, ReproductionFailureKind, Incident } from '../types.js';
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

    const runnerType = detectRunnerType(effectiveCommand);
    let runCommand = effectiveCommand;
    let tempReportDir: string | undefined;
    let reportFilePath: string | undefined;

    if (runnerType === 'pytest' || runnerType === 'node:test') {
      tempReportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-autopsy-repro-'));
      if (runnerType === 'pytest') {
        reportFilePath = path.join(tempReportDir, 'report.xml');
        if (fs.existsSync(reportFilePath)) {
          fs.unlinkSync(reportFilePath);
        }
        const normalizedReport = reportFilePath.replace(/\\/g, '/');
        runCommand = `${effectiveCommand} --junitxml="${normalizedReport}"`;
      } else if (runnerType === 'node:test') {
        reportFilePath = path.join(tempReportDir, 'report.tap');
        if (fs.existsSync(reportFilePath)) {
          fs.unlinkSync(reportFilePath);
        }
        const normalizedReport = reportFilePath.replace(/\\/g, '/');
        runCommand = `node --test --test-reporter=tap --test-reporter-destination="${normalizedReport}" --test-reporter=spec --test-reporter-destination=stdout "${relTestPath}"`;
      }
    }

    try {
      // 6. Copy reproduction test file from host repository into sandbox
      const destFile = path.resolve(sandboxDir, relTestPath);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.copyFileSync(hostFile, destFile);

      // 7. Run reproduction test in sandbox
      // Prevent parent test runner environment variables from leaking into child node:test runner
      const prevTestContext = process.env.NODE_TEST_CONTEXT;
      const prevTestWorkerId = process.env.NODE_TEST_WORKER_ID;
      delete process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_WORKER_ID;

      let testResult;
      try {
        testResult = await ctx.worktreeRunner.runTest(sandboxDir, runCommand, 30000);
      } finally {
        if (prevTestContext !== undefined) {
          process.env.NODE_TEST_CONTEXT = prevTestContext;
        }
        if (prevTestWorkerId !== undefined) {
          process.env.NODE_TEST_WORKER_ID = prevTestWorkerId;
        }
      }

      // 8. Determine reproduction status using structured runner evaluation
      let evalOutput: EvaluationOutput;
      if (runnerType === 'pytest') {
        evalOutput = evaluatePytestReproduction(reportFilePath, testResult);
      } else if (runnerType === 'unittest') {
        evalOutput = evaluateUnittestReproduction(testResult);
      } else if (runnerType === 'node:test') {
        const hostContent = fs.readFileSync(hostFile, 'utf8');
        evalOutput = evaluateNodeTestReproduction(reportFilePath, testResult, hostContent);
      } else {
        evalOutput = evaluateUnsupportedReproduction(effectiveCommand, testResult);
      }

      const status: ReproductionStatus = evalOutput.status;
      const failedLocation = evalOutput.failedLocation;
      const failureKind = evalOutput.failureKind;
      const failureReason = evalOutput.failureReason;
      const testCount = evalOutput.testCount;

      const reproductionResult: ReproductionResult = {
        status,
        command: effectiveCommand,
        exitCode: testResult.exitCode,
        output: testResult.output,
        failedLocation,
        executedAt: new Date().toISOString(),
        failureKind,
        failureReason,
        testCount,
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
      } else if (status === 'WRONG_FAILURE') {
        const reason = failureReason ? `: ${failureReason}` : '';
        causeEvidence.push(`[실행 증거] 재현 테스트가 단언 실패가 아닌 다른 이유로 실패함${reason} - ${effectiveCommand}`);
      } else if (status === 'UNVERIFIED_FAILURE') {
        causeEvidence.push(`[실행 증거] 지원하지 않는 실행기로 실패 이유를 검증하지 못함 - ${effectiveCommand}`);
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
      if (tempReportDir) {
        try {
          fs.rmSync(tempReportDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
      }
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
    const pyMpytestMatch = trimmed.match(/^((?:python\d*|py)(?:\.exe)?\s+-m\s+pytest)\b/i);
    if (pyMpytestMatch) {
      return `${pyMpytestMatch[1]} "${relTestPath}"`;
    }
    const pyMunittestMatch = trimmed.match(/^((?:python\d*|py)(?:\.exe)?\s+-m\s+unittest)\b/i);
    if (pyMunittestMatch) {
      return `${pyMunittestMatch[1]} "${relTestPath}"`;
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

  type SupportedRunnerType = 'pytest' | 'unittest' | 'node:test' | 'unsupported';

  function detectRunnerType(command: string): SupportedRunnerType {
    const trimmed = command.trim();
    if (/^(?:pytest|(?:python\d*|py)(?:\.exe)?\s+-m\s+pytest)\b/i.test(trimmed)) {
      return 'pytest';
    }
    if (/^(?:python\d*|py)(?:\.exe)?\s+-m\s+unittest\b/i.test(trimmed)) {
      return 'unittest';
    }
    if (/^node(?:\.exe)?\s+--test\b/i.test(trimmed)) {
      return 'node:test';
    }
    return 'unsupported';
  }

  interface EvaluationOutput {
    status: ReproductionStatus;
    failureKind?: ReproductionFailureKind;
    failureReason?: string;
    testCount?: number;
    failedLocation?: { filePath: string; line: number };
  }

  function decodeXml(str: string): string {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#10;/g, '\n')
      .replace(/&#13;/g, '\r')
      .replace(/&amp;/g, '&');
  }

  function evaluatePytestReproduction(
    reportFilePath: string | undefined,
    testResult: { success: boolean; exitCode: number; output: string }
  ): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'pytest 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    if (testResult.success) {
      if (!reportFilePath || !fs.existsSync(reportFilePath)) {
        return {
          status: 'NOT_REPRODUCED',
          failureReason: '테스트가 성공했습니다',
        };
      }
      const xml = fs.readFileSync(reportFilePath, 'utf8');
      const testsMatch = /tests="(\d+)"/.exec(xml);
      const testCount = testsMatch ? parseInt(testsMatch[1], 10) : 0;
      if (testCount === 0) {
        return {
          status: 'WRONG_FAILURE',
          failureKind: 'NO_TESTS',
          failureReason: 'pytest가 실행한 테스트가 0개입니다',
          testCount: 0,
        };
      }
      return {
        status: 'NOT_REPRODUCED',
        testCount,
      };
    }

    // Unsuccessful run
    if (!reportFilePath || !fs.existsSync(reportFilePath)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_REPORT',
        failureReason: 'pytest JUnit XML 리포트 파일이 생성되지 않았습니다',
      };
    }

    const xml = fs.readFileSync(reportFilePath, 'utf8');
    const testsMatch = /tests="(\d+)"/.exec(xml);
    const errorsMatch = /errors="(\d+)"/.exec(xml);
    const failuresMatch = /failures="(\d+)"/.exec(xml);
    const testCount = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const errorCount = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;
    const failureCount = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;

    if (testCount === 0) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'pytest가 실행한 테스트가 0개입니다',
        testCount: 0,
      };
    }

    if (errorCount > 0) {
      const isCollectionError =
        /<error[^>]*message="collection failure"|<error[^>]*>[\s\S]*?(?:ImportError|ModuleNotFoundError|SyntaxError)/i.test(
          xml
        );
      return {
        status: 'WRONG_FAILURE',
        failureKind: isCollectionError ? 'COLLECTION_ERROR' : 'RUNTIME_ERROR',
        failureReason: isCollectionError
          ? 'pytest 테스트 수집 중 오류가 발생했습니다 (collection failure)'
          : `pytest 테스트 설정/수행 중 오류(${errorCount}건)가 발생했습니다`,
        testCount,
      };
    }

    const failureRegex = /<failure(?:\s+message="([^"]*)")?>([\s\S]*?)<\/failure>/g;
    let match: RegExpExecArray | null;
    let allAssertions = true;
    let nonAssertionReason = '';
    let parsedFailures = 0;
    let failedLocation: { filePath: string; line: number } | undefined;

    while ((match = failureRegex.exec(xml)) !== null) {
      parsedFailures++;
      const rawMessage = match[1] || '';
      const rawBody = match[2] || '';
      const decodedMessage = decodeXml(rawMessage);
      const decodedBody = decodeXml(rawBody);

      const runtimeErrPattern =
        /(?:^|\n)\s*(?:E\s+)?(TypeError|NameError|AttributeError|ValueError|IndexError|KeyError|ZeroDivisionError|ImportError|ModuleNotFoundError|SyntaxError|UnboundLocalError|FileNotFoundError|OSError):/m;
      const isRuntime = runtimeErrPattern.test(decodedMessage) || runtimeErrPattern.test(decodedBody);
      if (isRuntime) {
        allAssertions = false;
        const errMatch = runtimeErrPattern.exec(decodedMessage) || runtimeErrPattern.exec(decodedBody);
        nonAssertionReason = errMatch ? errMatch[1] : '런타임 예외';
        break;
      }

      const isAssertMsg = /^(?:AssertionError|Failed:|assert\b)/i.test(decodedMessage);
      const isAssertBody =
        /(?:^|\n)\s*(?:E\s+)?(?:AssertionError|Failed)(?::|\b)|\bAssertionError\s*$/m.test(decodedBody);
      if (!isAssertMsg && !isAssertBody) {
        allAssertions = false;
        nonAssertionReason = '단언 실패가 아닌 다른 오류';
        break;
      }

      if (!failedLocation) {
        const locMatch =
          /(?:^|\n)([^\n:]+\.py):(\d+): (?:AssertionError|Failed)/m.exec(decodedBody) ||
          /(?:^|\n)\s*File "([^"]+)", line (\d+)/m.exec(decodedBody);
        if (locMatch) {
          failedLocation = { filePath: locMatch[1].replace(/\\\\/g, '\\'), line: parseInt(locMatch[2], 10) };
        }
      }
    }

    if (allAssertions && (failureCount > 0 || parsedFailures > 0) && errorCount === 0 && testCount >= 1) {
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: '단언 실패가 확인되었습니다',
        testCount,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: `pytest 실행 중 오류가 발생했습니다 (${nonAssertionReason || '런타임 예외'})`,
      testCount,
    };
  }

  function evaluateUnittestReproduction(testResult: {
    success: boolean;
    exitCode: number;
    output: string;
  }): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'unittest 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    const ranMatch = /Ran (\d+) tests?/i.exec(output);
    const testCount = ranMatch ? parseInt(ranMatch[1], 10) : 0;

    if (testResult.exitCode === 5 || /NO TESTS RAN/i.test(output) || (ranMatch && testCount === 0)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'unittest가 실행한 테스트가 0개입니다 (NO TESTS RAN)',
        testCount: 0,
      };
    }

    if (testResult.success) {
      return {
        status: 'NOT_REPRODUCED',
        testCount,
      };
    }

    const failedSummaryMatch = /FAILED\s*\((.*?)\)/.exec(output);
    if (!failedSummaryMatch) {
      if (/ImportError|ModuleNotFoundError|SyntaxError/i.test(output)) {
        return {
          status: 'WRONG_FAILURE',
          failureKind: 'COLLECTION_ERROR',
          failureReason: 'unittest 테스트 임포트 또는 문법 오류가 발생했습니다',
          testCount,
        };
      }
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'RUNTIME_ERROR',
        failureReason: 'unittest 요약 줄을 찾을 수 없습니다',
        testCount,
      };
    }

    const summary = failedSummaryMatch[1];
    const failuresMatch = /failures=(\d+)/.exec(summary);
    const errorsMatch = /errors=(\d+)/.exec(summary);
    const failures = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;
    const errors = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;

    if (errors > 0) {
      const isCollectionError =
        /ImportError: Failed to import test module|ModuleNotFoundError|No module named/i.test(output);
      return {
        status: 'WRONG_FAILURE',
        failureKind: isCollectionError ? 'COLLECTION_ERROR' : 'RUNTIME_ERROR',
        failureReason: isCollectionError
          ? 'unittest 테스트 모듈 임포트 실패 (ImportError)'
          : `unittest 테스트 실행 중 오류(errors=${errors})가 발생했습니다`,
        testCount,
      };
    }

    if (failures > 0 && errors === 0 && testCount >= 1) {
      const frames = parseStackFrames(output);
      let failedLocation: { filePath: string; line: number } | undefined;
      if (frames.length > 0) {
        failedLocation = { filePath: frames[0].filePath, line: frames[0].line };
      }
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: `단언 실패가 확인되었습니다 (failures=${failures})`,
        testCount,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: 'unittest 실패 조건을 만족하지 않습니다',
      testCount,
    };
  }

  function evaluateNodeTestReproduction(
    reportFilePath: string | undefined,
    testResult: { success: boolean; exitCode: number; output: string },
    hostFileContent: string
  ): EvaluationOutput {
    const output = testResult.output;
    if (
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        output
      )
    ) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: 'node --test 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }

    const hasTestFuncs = /\b(?:test|it|describe)\s*\(/m.test(hostFileContent);
    if (!hasTestFuncs) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_TESTS',
        failureReason: 'node:test 테스트 파일에 테스트 함수(test, it, describe)가 정의되지 않았습니다',
        testCount: 0,
      };
    }

    if (!reportFilePath || !fs.existsSync(reportFilePath)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'NO_REPORT',
        failureReason: 'node:test TAP 리포트 파일이 생성되지 않았습니다',
      };
    }

    const tap = fs.readFileSync(reportFilePath, 'utf8');
    const testsMatch = /# tests\s+(\d+)/m.exec(tap);
    const passMatch = /# pass\s+(\d+)/m.exec(tap);
    const failMatch = /# fail\s+(\d+)/m.exec(tap);
    const cancelledMatch = /# cancelled\s+(\d+)/m.exec(tap);

    const totalTests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const passCount = passMatch ? parseInt(passMatch[1], 10) : 0;
    const failCount = failMatch ? parseInt(failMatch[1], 10) : 0;
    const cancelledCount = cancelledMatch ? parseInt(cancelledMatch[1], 10) : 0;

    if (testResult.success && failCount === 0 && cancelledCount === 0) {
      return {
        status: 'NOT_REPRODUCED',
        testCount: totalTests,
      };
    }

    if (cancelledCount > 0 || /failureType:\s*'testTimeoutFailure'/i.test(tap)) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'TIMEOUT',
        failureReason: 'node:test 실행 시간 초과 (testTimeoutFailure)',
        testCount: totalTests,
      };
    }

    if (
      /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(tap) ||
      /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/i.test(output)
    ) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'COLLECTION_ERROR',
        failureReason: 'node:test 모듈 임포트 실패 (ERR_MODULE_NOT_FOUND)',
        testCount: totalTests,
      };
    }

    const failureParts = tap.split(/(?:^|\n)not ok \d+ - /m).slice(1);
    if (failureParts.length === 0) {
      return {
        status: 'WRONG_FAILURE',
        failureKind: 'RUNTIME_ERROR',
        failureReason: 'node:test 실패 항목을 파싱할 수 없습니다',
        testCount: totalTests,
      };
    }

    let allAssertions = true;
    let nonAssertionReason = '';
    let failedLocation: { filePath: string; line: number } | undefined;

    for (const part of failureParts) {
      const isAssertion = /code:\s*'ERR_ASSERTION'/i.test(part) || /name:\s*'AssertionError'/i.test(part);
      if (!isAssertion) {
        allAssertions = false;
        const typeErrorMatch = /name:\s*'([^']+)'/.exec(part);
        nonAssertionReason = typeErrorMatch ? typeErrorMatch[1] : '런타임 오류';
        break;
      }
      if (!failedLocation) {
        const locMatch =
          /location:\s*'([^']+)[:/](\d+)[:/]\d+'/i.exec(part) ||
          /stack:[\s\S]*?\((?:file:\/\/\/)?([^:]+):(\d+):\d+\)/i.exec(part);
        if (locMatch) {
          failedLocation = { filePath: locMatch[1].replace(/\\\\/g, '\\'), line: parseInt(locMatch[2], 10) };
        }
      }
    }

    if (allAssertions && failCount > 0 && totalTests >= 1) {
      return {
        status: 'REPRODUCED',
        failureKind: 'ASSERTION',
        failureReason: '단언 실패가 확인되었습니다 (AssertionError)',
        testCount: totalTests,
        failedLocation,
      };
    }

    return {
      status: 'WRONG_FAILURE',
      failureKind: 'RUNTIME_ERROR',
      failureReason: `node:test 실행 중 런타임 오류가 발생했습니다 (${nonAssertionReason || '런타임 예외'})`,
      testCount: totalTests,
    };
  }

  function evaluateUnsupportedReproduction(
    effectiveCommand: string,
    testResult: { success: boolean; exitCode: number; output: string }
  ): EvaluationOutput {
    if (testResult.success) {
      return {
        status: 'NOT_REPRODUCED',
      };
    }
    const isCommandMissing =
      /is not recognized as an internal or external command|'[^']+' is not recognized|command not found|내부 또는 외부 명령/i.test(
        testResult.output
      );
    if (isCommandMissing) {
      return {
        status: 'CANNOT_RUN',
        failureKind: 'NO_REPORT',
        failureReason: '테스트 실행기 명령을 시스템에서 찾을 수 없습니다',
      };
    }
    const frames = parseStackFrames(testResult.output);
    let failedLocation: { filePath: string; line: number } | undefined;
    if (frames.length > 0) {
      failedLocation = { filePath: frames[0].filePath, line: frames[0].line };
    }
    return {
      status: 'UNVERIFIED_FAILURE',
      failureKind: 'UNKNOWN_RUNNER',
      failureReason: '지원하지 않는 실행기이므로 실패 이유를 판정할 수 없습니다',
      failedLocation,
    };
  }

  /**
   * Returns structured next_action for an incident based on missing intents.
   */