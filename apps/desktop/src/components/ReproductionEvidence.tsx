import React from 'react';
import {
  ReproductionEvidenceLevel,
  ReproductionLockAssessmentStatus,
  ReproductionGateState,
  BaselineComparisonVerdict,
  AssertFlipVerdict,
  ReproductionFailureKind,
  IncidentReproductionStatusResponse,
  ReproductionResult,
} from '../api';
import { Badge } from '../ui';
import { clock } from '../diff';
import {
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Lock,
  GitBranch,
  HelpCircle,
  Clock,
  AlertCircle,
} from 'lucide-react';

export const BASELINE_VERDICT_TEXTS: Record<BaselineComparisonVerdict, string> = {
  REGRESSION_CONFIRMED: '정상 시점에서는 통과, 지금은 실패 → 이번 변경 이후 생긴 버그',
  PRE_EXISTING: '정상 시점에서도 실패 → 원래부터 있던 버그일 수 있음',
  BASELINE_CANNOT_RUN: '정상 시점 실행 불가 (BASELINE_CANNOT_RUN)',
  BASELINE_FLAKY: '정상 시점 결과가 불안정함 (BASELINE_FLAKY)',
  NO_BASELINE: '비교 대상 정상 시점 없음 (NO_BASELINE)',
  SKIPPED: '정상 시점 비교 건너뜀 (SKIPPED)',
};

export const ASSERT_FLIP_VERDICT_TEXTS: Record<AssertFlipVerdict, string> = {
  FLIP_CONFIRMED: '단언 뒤집기 확인 (기대값만 바꾼 테스트로 실패 뒤집힘)',
  PRE_FLIP_NOT_PASSING: '기존 기대값 테스트 미통과 (PRE_FLIP_NOT_PASSING)',
  PRE_FLIP_FLAKY: '기존 기대값 테스트 불안정 (PRE_FLIP_FLAKY)',
  FLIP_CHANGED_NON_ASSERTION: '단언 외 코드가 변경됨 (FLIP_CHANGED_NON_ASSERTION)',
  SKIPPED: '단언 뒤집기 건너뜀 (SKIPPED)',
  NOT_PROVIDED: '단언 뒤집기 테스트 미제공 (NOT_PROVIDED)',
};

export const FAILURE_KIND_TEXTS: Record<ReproductionFailureKind, string> = {
  ASSERTION: '단언 실패 (ASSERTION)',
  RUNTIME_ERROR: '실행 오류 (RUNTIME_ERROR)',
  COLLECTION_ERROR: '테스트 수집 오류 (COLLECTION_ERROR)',
  TIMEOUT: '시간 초과 (TIMEOUT)',
  FLAKY: '실행할 때마다 결과가 달라 믿기 어려움 (FLAKY)',
  NO_TESTS: '테스트 없음 (NO_TESTS)',
  NO_REPORT: '보고서 없음 (NO_REPORT)',
  UNKNOWN_RUNNER: '알 수 없는 실행기 (UNKNOWN_RUNNER)',
};

export const LOCK_STATUS_TEXTS: Record<ReproductionLockAssessmentStatus, string> = {
  OK: '정상 (OK)',
  MODIFIED_ON_DISK: '디스크에서 파일 내용이 변경됨 (MODIFIED_ON_DISK)',
  SIGNATURE_INVALID: '잠금 서명이 일치하지 않음 (SIGNATURE_INVALID)',
  REMOVED: '잠금 기록이 삭제됨 (REMOVED)',
  NONE: '잠금 없음 (NONE)',
};

export const GATE_STATE_TEXTS: Record<ReproductionGateState, string> = {
  IN_PROGRESS: '재현 시도 진행 중 (IN_PROGRESS)',
  ABANDONED: '재현 기권 (ABANDONED)',
  NEEDS_USER_DECISION: '사용자 결정 필요 (NEEDS_USER_DECISION)',
  AUDIT_BROKEN: '감사 기록 손상 (AUDIT_BROKEN)',
  WAIVED: '재현 없이 진행 (WAIVED)',
  REPRODUCED: '재현 성공 (REPRODUCED)',
  NOT_ATTEMPTED: '재현 시도 전 (NOT_ATTEMPTED)',
};

export function ReproductionEvidenceBadge({ level }: { level: ReproductionEvidenceLevel }) {
  switch (level) {
    case 'STRONG':
      return <Badge tone="green">강한 증거 (STRONG)</Badge>;
    case 'PARTIAL':
      return <Badge tone="amber">부분 증거 (PARTIAL)</Badge>;
    case 'REPRODUCED_ONLY':
      return <Badge tone="amber">재현됨 (추가 증거 없음) (REPRODUCED_ONLY)</Badge>;
    case 'NOT_REPRODUCED':
      return <Badge tone="gray">재현 안 됨 (NOT_REPRODUCED)</Badge>;
    case 'WAIVED':
      return <Badge tone="blue">재현 없이 진행 (사용자 허락) (WAIVED)</Badge>;
    case 'NONE':
    default:
      return <Badge tone="gray">재현 시도 없음 (NONE)</Badge>;
  }
}

export function ReproductionEvidenceCard({
  reproductionResult,
  evidenceLevel,
}: {
  reproductionResult?: ReproductionResult | null;
  evidenceLevel?: ReproductionEvidenceLevel;
}) {
  const level = evidenceLevel || (reproductionResult ? (reproductionResult.status === 'REPRODUCED' ? 'REPRODUCED_ONLY' : 'NOT_REPRODUCED') : 'NONE');

  const baseline = reproductionResult?.baselineComparison;
  const assertFlip = reproductionResult?.assertFlip;

  let baselinePass = 0;
  let baselineFail = 0;
  if (baseline?.runs?.baseline) {
    for (const r of baseline.runs.baseline) {
      if (r.status === 'NOT_REPRODUCED') baselinePass++;
      else baselineFail++;
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-indigo-200 bg-white p-3.5 text-xs shadow-sm space-y-3">
      <div className="flex items-center justify-between border-b border-indigo-100 pb-2">
        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-indigo-600" />
          재현 증거 (Reproduction Evidence)
        </span>
        <ReproductionEvidenceBadge level={level} />
      </div>

      <div className="text-[11px] text-slate-500 bg-indigo-50/50 p-2 rounded border border-indigo-100">
        강한 증거는 정상 시점에서는 통과하고 지금은 실패하며(회귀 확인), 기대값만 바꾼 테스트로 실패가 뒤집힌 경우(단언 뒤집기 확인)에만 표시됩니다.
      </div>

      {/* Normal baseline comparison */}
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-slate-700 flex items-center gap-1">
          <GitBranch className="h-3.5 w-3.5 text-slate-500" />
          정상 시점 비교 (Baseline Comparison)
        </div>
        {baseline ? (
          <div className="rounded bg-slate-50 p-2 border border-slate-200/80 space-y-1 text-[11px]">
            <div className="font-medium text-slate-800">
              {BASELINE_VERDICT_TEXTS[baseline.verdict] || baseline.verdict}
            </div>
            {baseline.baselineCheckpointId && (
              <div className="text-slate-500">
                정상 시점 체크포인트: <span className="font-mono text-slate-700">#{baseline.baselineCheckpointId.slice(-6).toUpperCase()}</span>
                {baseline.baselineSha && <span className="ml-1 text-[10px]">({baseline.baselineSha.slice(0, 7)})</span>}
              </div>
            )}
            {baseline.runs?.baseline && baseline.runs.baseline.length > 0 && (
              <div className="text-slate-500">
                실행 결과: 통과 {baselinePass}회 / 실패 {baselineFail}회 (총 {baseline.runs.baseline.length}회)
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-slate-400 italic bg-slate-50 p-1.5 rounded">
            정상 시점 비교 데이터 없음
          </div>
        )}
      </div>

      {/* Assert Flip */}
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-slate-700 flex items-center gap-1">
          <AlertCircle className="h-3.5 w-3.5 text-slate-500" />
          단언 뒤집기 (Assert Flip)
        </div>
        {assertFlip ? (
          <div className="rounded bg-slate-50 p-2 border border-slate-200/80 space-y-1 text-[11px]">
            <div className="font-medium text-slate-800">
              {ASSERT_FLIP_VERDICT_TEXTS[assertFlip.verdict] || assertFlip.verdict}
            </div>
            {assertFlip.preFlipTestFilePath && (
              <div className="text-slate-500 truncate">
                뒤집기 전 파일: <span className="font-mono text-slate-700">{assertFlip.preFlipTestFilePath}</span>
              </div>
            )}
            {assertFlip.verdict === 'FLIP_CHANGED_NON_ASSERTION' && assertFlip.nonAssertionChangedLines && assertFlip.nonAssertionChangedLines.length > 0 && (
              <div className="mt-1 pt-1 border-t border-slate-200">
                <div className="text-rose-600 font-semibold mb-1">단언 외 변경된 줄 (최대 5줄):</div>
                <div className="space-y-0.5 font-mono text-[10px] bg-white p-1 rounded border border-rose-200">
                  {assertFlip.nonAssertionChangedLines.slice(0, 5).map((line, idx) => (
                    <div key={idx} className="truncate text-slate-700">
                      <span className="text-rose-500 mr-1">{line.line}줄:</span>
                      {line.content}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-slate-400 italic bg-slate-50 p-1.5 rounded">
            단언 뒤집기 데이터 없음
          </div>
        )}
      </div>

      {/* Failure kind and reason if WRONG_FAILURE or UNVERIFIED_FAILURE */}
      {reproductionResult && (reproductionResult.status === 'WRONG_FAILURE' || reproductionResult.status === 'UNVERIFIED_FAILURE') && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2 text-[11px] space-y-1 text-amber-900">
          <div className="font-semibold flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            실패 형태 및 원인
          </div>
          {reproductionResult.failureKind && (
            <div>
              실패 유형: <span className="font-medium">{FAILURE_KIND_TEXTS[reproductionResult.failureKind] || reproductionResult.failureKind}</span>
            </div>
          )}
          {reproductionResult.failureReason && (
            <div>
              실패 상세: <span className="font-mono text-[10px] text-amber-800">{reproductionResult.failureReason}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReproductionProgressCard({
  statusResponse,
  onSelectIncident,
}: {
  statusResponse?: IncidentReproductionStatusResponse | null;
  onSelectIncident?: (incidentId: string) => void;
}) {
  if (!statusResponse) return null;

  const { gate, lock, otherBlockedIncidents } = statusResponse;

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3.5 text-xs shadow-sm space-y-3">
      {/* Q4 Warning: Other blocked incidents in same project */}
      {otherBlockedIncidents && otherBlockedIncidents.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-amber-900 space-y-1.5">
          <div className="flex items-center gap-1.5 font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
            같은 프로젝트에 재현이 멈춘 사건이 {otherBlockedIncidents.length}개 있습니다. 같은 버그를 새 사건으로 다시 등록한 것일 수 있습니다.
          </div>
          <div className="space-y-1 pl-5">
            {otherBlockedIncidents.map((inc) => (
              <div key={inc.id} className="text-[11px] flex items-center gap-1.5">
                <span>·</span>
                <button
                  type="button"
                  onClick={() => onSelectIncident?.(inc.id)}
                  className="font-medium text-amber-800 underline hover:text-amber-950 text-left cursor-pointer"
                >
                  #{inc.id.slice(-6).toUpperCase()}: {inc.title}
                </button>
                <span className="text-[10px] text-amber-700">({GATE_STATE_TEXTS[inc.state as ReproductionGateState] || inc.state})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
          <Clock className="h-4 w-4 text-slate-600" />
          재현 진행 상태 (Reproduction Gate & Lock)
        </span>
        <Badge tone={
          gate.state === 'REPRODUCED' ? 'green' :
          gate.state === 'WAIVED' ? 'blue' :
          gate.state === 'ABANDONED' || gate.state === 'AUDIT_BROKEN' ? 'red' :
          gate.state === 'NEEDS_USER_DECISION' ? 'amber' : 'gray'
        }>
          {GATE_STATE_TEXTS[gate.state] || gate.state}
        </Badge>
      </div>

      {/* Lock status */}
      <div className="space-y-1 text-[11px]">
        <div className="font-semibold text-slate-700 flex items-center gap-1">
          <Lock className="h-3.5 w-3.5 text-slate-500" />
          재현 테스트 잠금 (Reproduction Lock)
        </div>
        {lock.status === 'NONE' ? (
          <div className="text-slate-400 italic bg-slate-50 p-1.5 rounded">
            재현 테스트 잠금 없음
          </div>
        ) : (
          <div className="rounded bg-slate-50 p-2 border border-slate-200/80 space-y-1">
            {lock.testFilePath && (
              <div className="text-slate-800">
                <span className="font-medium">재현 테스트 잠김:</span>{' '}
                <span className="font-mono text-[10px]">{lock.testFilePath}</span>{' '}
                {lock.lockedAt && <span className="text-slate-500">({clock(lock.lockedAt)})</span>}
              </div>
            )}
            {lock.preFlipFilePath && (
              <div className="text-slate-600">
                <span className="font-medium">단언 뒤집기 전 파일:</span>{' '}
                <span className="font-mono text-[10px]">{lock.preFlipFilePath}</span>
              </div>
            )}
            {lock.testFilePath && (
              <div className="text-slate-500 text-[10px]">
                수정안은 이 파일을 바꿀 수 없습니다.
              </div>
            )}
            {lock.status !== 'OK' && (
              <div className="mt-1 flex items-center gap-1 rounded bg-rose-50 p-1.5 text-rose-700 border border-rose-200 font-medium">
                <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                {lock.status === 'REMOVED' ? (
                  <span>재현 테스트 잠금이 바깥에서 삭제되었습니다. 감사 기록에는 잠금이 남아 있습니다.</span>
                ) : (
                  <span>잠금 이상 경고: {LOCK_STATUS_TEXTS[lock.status]}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Gate state explanation */}
      <div className="space-y-1 text-[11px]">
        <div className="font-semibold text-slate-700">재현 게이트 상태 (Gate State)</div>
        <div className="rounded bg-slate-50 p-2 border border-slate-200/80 space-y-1">
          {gate.state === 'IN_PROGRESS' && (
            <div className="text-slate-700">
              재현 시도 {gate.attemptsUsed}/{gate.attemptsAllowed}회 사용
            </div>
          )}
          {gate.state === 'ABANDONED' && (
            <div className="text-rose-700 font-medium flex items-start gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                에이전트가 {gate.attemptsUsed}번 시도했지만 재현하지 못해 멈췄습니다. 사용자 결정이 필요합니다.{' '}
                <span className="text-rose-600 font-bold">[사용자 결정 필요]</span>
              </div>
            </div>
          )}
          {gate.state === 'NEEDS_USER_DECISION' && (
            <div className="text-amber-800 font-medium flex items-start gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                감사 기록 깨짐을 확인하기 전에 등록된 사건이라 사용자 결정이 필요합니다.{' '}
                <span className="text-amber-700 font-bold">[사용자 결정 필요]</span>
              </div>
            </div>
          )}
          {gate.state === 'AUDIT_BROKEN' && (
            <div className="text-rose-700 font-medium flex items-start gap-1">
              <ShieldAlert className="h-3.5 w-3.5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                감사 기록이 바깥에서 변경되어 작업이 멈춰 있습니다.{' '}
                <span className="text-rose-600 font-bold">[사용자 결정 필요]</span>
              </div>
            </div>
          )}
          {gate.state === 'WAIVED' && (
            <div className="text-blue-700 font-medium">
              사용자가 재현 없이 진행을 허락했습니다.
            </div>
          )}
          {gate.state === 'REPRODUCED' && (
            <div className="text-emerald-700 font-medium">
              재현 성공 (실패 확인됨)
            </div>
          )}
          {gate.state === 'NOT_ATTEMPTED' && (
            <div className="text-slate-500">
              재현 시도 전
            </div>
          )}

          {gate.discrepancyWarning && (
            <div className="mt-1 text-[10px] text-amber-700 flex items-center gap-1 font-medium bg-amber-50 p-1 rounded border border-amber-200">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>{gate.discrepancyWarning}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
