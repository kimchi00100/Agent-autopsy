import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle } from 'lucide-react';
import { Button } from '../ui';
import { api } from '../api';

export type DecisionModalType =
  | 'PROCEED_WITHOUT_REPRODUCTION'
  | 'ALLOW_MORE_ATTEMPTS'
  | 'AUDIT_CHAIN_ACKNOWLEDGE';

export interface DecisionModalProps {
  type: DecisionModalType;
  incidentId?: string;
  repoPath?: string;
  brokenInfo?: {
    brokenSeq?: number;
    reasonCode?: string;
  };
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
}

function getErrorMessage(err: any): string {
  const code = err?.code;
  switch (code) {
    case 'ACKNOWLEDGE_CHAIN_FIRST':
      return '감사 기록 깨짐을 먼저 확인해야 결정할 수 있습니다.';
    case 'NOT_ABANDONED':
      return '지금 상태에서는 결정할 수 없습니다. 이미 결정되었거나 상태가 바뀌었습니다.';
    case 'CHAIN_NOT_BROKEN':
      return '감사 기록이 이미 정상입니다.';
    case 'PROJECT_MISMATCH':
      return '다른 프로젝트의 사건입니다.';
    case 'REASON_REQUIRED':
      return '이유를 입력해야 합니다.';
    case 'REASON_TOO_LONG':
      return '이유는 500자까지 쓸 수 있습니다.';
    default:
      if (code) {
        return `요청에 실패했습니다 (${code})`;
      }
      return err?.message || '요청에 실패했습니다';
  }
}

export function DecisionModal({
  type,
  incidentId,
  repoPath,
  brokenInfo,
  onClose,
  onSuccess,
}: DecisionModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [submitting, onClose]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  let title = '';
  const descriptions: string[] = [];
  let confirmLabel = '';

  if (type === 'PROCEED_WITHOUT_REPRODUCTION') {
    title = '재현 테스트 없이 진행';
    descriptions.push(
      '이 사건은 재현 테스트 없이 수정안 단계로 넘어갑니다.',
      '수정안이 이 버그를 실제로 고쳤는지 재현 테스트로 확인할 수 없습니다.',
      '결정과 이유는 감사 기록에 남고, 재현 증거는 "재현 없이 진행"으로 표시됩니다.'
    );
    confirmLabel = '재현 없이 진행';
  } else if (type === 'ALLOW_MORE_ATTEMPTS') {
    title = '재현 시도 3번 더 허락';
    descriptions.push(
      '에이전트가 재현 테스트를 3번 더 시도할 수 있습니다.',
      '그 안에 재현하지 못하면 다시 멈추고 결정을 기다립니다.'
    );
    confirmLabel = '3번 더 허락';
  } else if (type === 'AUDIT_CHAIN_ACKNOWLEDGE') {
    title = '감사 기록 깨짐 확인';
    descriptions.push(
      '감사 기록이 바깥에서 바뀐 것을 확인했다고 기록합니다.',
      '바뀐 기록은 복구되지 않습니다. 이 시점 이후의 기록만 다시 검증합니다.',
      '확인 이전에 등록된 사건은 사건마다 재현 결정을 다시 해야 합니다.'
    );
    if (brokenInfo && (brokenInfo.brokenSeq !== undefined || brokenInfo.reasonCode)) {
      descriptions.push(
        `깨짐 정보: 이유 코드 ${brokenInfo.reasonCode || '알 수 없음'}, 처음 깨진 위치 seq #${brokenInfo.brokenSeq ?? '알 수 없음'}`
      );
    }
    confirmLabel = '깨짐 확인';
  }

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);

    try {
      if (type === 'PROCEED_WITHOUT_REPRODUCTION') {
        if (!incidentId || !repoPath) {
          throw new Error('사건 ID 또는 저장소 경로가 누락되었습니다.');
        }
        await api.decideReproduction(
          incidentId,
          'PROCEED_WITHOUT_REPRODUCTION',
          repoPath,
          trimmed
        );
      } else if (type === 'ALLOW_MORE_ATTEMPTS') {
        if (!incidentId || !repoPath) {
          throw new Error('사건 ID 또는 저장소 경로가 누락되었습니다.');
        }
        await api.decideReproduction(
          incidentId,
          'ALLOW_MORE_ATTEMPTS',
          repoPath,
          trimmed
        );
      } else if (type === 'AUDIT_CHAIN_ACKNOWLEDGE') {
        await api.acknowledgeAuditChain(trimmed);
      }

      await onSuccess();
      onClose();
    } catch (err: any) {
      setError(getErrorMessage(err));
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
      <div className="w-[500px] shrink-0 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl space-y-4">
        <div className="flex items-start justify-between border-b border-slate-100 pb-3">
          <div className="text-base font-bold text-slate-900">{title}</div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Description bullets */}
        <div className="space-y-1.5 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 border border-slate-100">
          {descriptions.map((desc, i) => (
            <div key={i} className="flex items-start gap-1.5 leading-relaxed">
              <span className="text-slate-400 select-none">·</span>
              <span>{desc}</span>
            </div>
          ))}
        </div>

        {/* Error message */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-700">
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
            <span>{error}</span>
          </div>
        )}

        {/* Textarea for reason */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <label className="font-semibold text-slate-700">결정 이유 입력</label>
            <span
              className={`font-mono text-[11px] ${
                reason.length > 500 ? 'font-bold text-rose-600' : 'text-slate-400'
              }`}
            >
              {reason.length}/500
            </span>
          </div>
          <textarea
            ref={textareaRef}
            rows={4}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            disabled={submitting}
            placeholder="결정 및 확인 이유를 구체적으로 입력하세요."
            className="w-full resize-none rounded-xl border border-slate-200 p-3 text-xs text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <Button
            variant="default"
            onClick={onClose}
            disabled={submitting}
          >
            취소
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canConfirm}
          >
            {submitting ? '처리 중...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
