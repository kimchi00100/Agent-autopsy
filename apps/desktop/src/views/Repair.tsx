import { useEffect, useMemo, useState } from 'react';
import { api, Checkpoint, Incident, Proposal, Directive, AuditChainVerificationResult, ProposalIntegrityResult, IncidentReproductionStatusResponse } from '../api';
import { ReproductionEvidenceBadge, LOCK_STATUS_TEXTS } from '../components/ReproductionEvidence';
import { parseSideBySide, relativeTime } from '../diff';
import { Badge, Button, Card, CodeBlock, Empty, PageHeader } from '../ui';
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCcw,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  FileCheck,
  Copy,
  MessageSquare,
  Send,
  Check,
  GitCompare,
} from 'lucide-react';


function HighlightedReportText({ text, quotes }: { text: string; quotes: string[] }) {
  if (!text) return null;
  const validQuotes = Array.from(new Set(quotes.filter((q) => q && q.trim().length > 0)));
  if (validQuotes.length === 0) {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

  type Interval = { start: number; end: number };
  const intervals: Interval[] = [];
  const textLower = text.toLowerCase();

  for (const q of validQuotes) {
    const qLower = q.toLowerCase();
    let pos = 0;
    while ((pos = textLower.indexOf(qLower, pos)) !== -1) {
      intervals.push({ start: pos, end: pos + q.length });
      pos += q.length;
    }
  }

  if (intervals.length === 0) {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  let cur = { ...intervals[0] };
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start <= cur.end) {
      cur.end = Math.max(cur.end, intervals[i].end);
    } else {
      merged.push(cur);
      cur = { ...intervals[i] };
    }
  }
  merged.push(cur);

  const elements: React.ReactNode[] = [];
  let lastIdx = 0;
  merged.forEach((iv, i) => {
    if (iv.start > lastIdx) {
      elements.push(text.slice(lastIdx, iv.start));
    }
    elements.push(
      <mark
        key={i}
        className="bg-emerald-100 text-emerald-950 font-semibold px-1 py-0.5 rounded border border-emerald-300"
        title="사용자 원문 인용 구절 (USER_QUOTE)"
      >
        {text.slice(iv.start, iv.end)}
      </mark>
    );
    lastIdx = iv.end;
  });
  if (lastIdx < text.length) {
    elements.push(text.slice(lastIdx));
  }

  return <span className="whitespace-pre-wrap leading-relaxed">{elements}</span>;
}

export default function Repair({
  incidents,
  incidentId,
  onPick,
  repoPath,
  checkpoints,
  onChanged,
  notify,
  checkAuditChain,
  onOpenCompare,
}: {
  incidents: Incident[];
  incidentId: string | null;
  onPick: (id: string) => void;
  repoPath: string;
  checkpoints: Checkpoint[];
  onChanged: () => void;
  notify: (kind: 'ok' | 'error', msg: string) => void;
  checkAuditChain?: () => Promise<AuditChainVerificationResult | null>;
  onOpenCompare?: (proposalId?: string) => void;
}) {
  const incident = incidents.find((i) => i.id === incidentId) ?? null;
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState<'before' | 'after' | null>(null);
  const [forceAck, setForceAck] = useState(false);
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [integrityResult, setIntegrityResult] = useState<ProposalIntegrityResult | null>(null);
  const [reproStatus, setReproStatus] = useState<IncidentReproductionStatusResponse | null>(null);

  useEffect(() => {
    if (!incidentId) {
      setReproStatus(null);
      return;
    }
    api.reproductionStatus(incidentId, repoPath)
      .then(setReproStatus)
      .catch(() => setReproStatus(null));

    const unsub = api.subscribeStream((event) => {
      if (event?.type === 'db_sync' || event?.incidentId === incidentId || event?.refs?.incidentId === incidentId) {
        api.reproductionStatus(incidentId, repoPath)
          .then(setReproStatus)
          .catch(() => {});
      }
    });
    return unsub;
  }, [incidentId, repoPath]);

  useEffect(() => {
    if (!proposalId) {
      setIntegrityResult(null);
      return;
    }
    const current = proposals.find((p) => p.id === proposalId);
    if (current) {
      setIntegrityResult({
        proposalId: current.id,
        valid: (current.integrityStatus ?? '정상') === '정상',
        integrityStatus: current.integrityStatus ?? '정상',
        integrityCode: current.integrityCode ?? 'VALID',
        reason: '',
      });
    }
    api.proposalIntegrity(proposalId, repoPath)
      .then((res) => setIntegrityResult(res.result))
      .catch(() => {});
  }, [proposalId, repoPath, proposals]);

  const loadDirectives = () => {
    if (incident?.projectId) {
      api.directives(incident.projectId).then((r) => setDirectives(r.directives || []));
    }
  };

  useEffect(() => {
    if (!incidentId) {
      setProposals([]);
      return;
    }
    api.proposals(incidentId).then((r) => {
      setProposals(r.proposals);
      setProposalId(r.proposals[0]?.id ?? null);
    });
    loadDirectives();
  }, [incidentId]);

  useEffect(() => {
    loadDirectives();
  }, [incident?.projectId, proposalId]);

  const proposal = proposals.find((p) => p.id === proposalId) ?? null;
  const currentIntegrityStatus = integrityResult?.integrityStatus ?? proposal?.integrityStatus ?? '정상';
  const isIntegrityNormal = currentIntegrityStatus === '정상';
  const files = useMemo(() => (proposal ? parseSideBySide(proposal.patchDiff) : []), [proposal]);
  const userQuotes = useMemo(() => {
    if (!incident?.intents) return [];
    const qList: string[] = [];
    if (incident.intents.expectedBehavior.source === 'USER_QUOTE' && incident.intents.expectedBehavior.quote) {
      qList.push(incident.intents.expectedBehavior.quote);
    }
    if (incident.intents.observedBehavior.source === 'USER_QUOTE' && incident.intents.observedBehavior.quote) {
      qList.push(incident.intents.observedBehavior.quote);
    }
    if (incident.intents.reproductionCondition.source === 'USER_QUOTE' && incident.intents.reproductionCondition.quote) {
      qList.push(incident.intents.reproductionCondition.quote);
    }
    if (incident.intents.verificationMethod.source === 'USER_QUOTE' && incident.intents.verificationMethod.quote) {
      qList.push(incident.intents.verificationMethod.quote);
    }
    return qList;
  }, [incident?.intents]);


  useEffect(() => {
    const next: Record<string, boolean> = {};
    files.forEach((f) => (next[f.filePath] = true));
    setChecked(next);
  }, [proposalId, files.length]);

  const selected = files.filter((f) => checked[f.filePath]).map((f) => f.filePath);
  const partial = selected.length !== files.length;

  async function refresh() {
    if (incidentId) {
      const r = await api.proposals(incidentId);
      setProposals(r.proposals);
    }
    loadDirectives();
    onChanged();
  }

  async function approveAndApply() {
    if (!proposal) return;

    // Immediately before approval: refresh audit chain and verify proposal integrity
    setBusy(true);
    try {
      if (checkAuditChain) {
        await checkAuditChain();
      }
      const integrityRes = await api.proposalIntegrity(proposal.id, repoPath);
      const integrityCheck = integrityRes.result;
      setIntegrityResult(integrityCheck);
      if (!integrityCheck.valid || integrityCheck.integrityStatus !== '정상') {
        notify('error', `수정안 무결성 확인 실패 (${integrityCheck.integrityStatus}): ${integrityCheck.reason || '승인할 수 없습니다.'}`);
        return;
      }
    } catch (e: any) {
      notify('error', `무결성 확인 중 오류 발생: ${e.message}`);
      return;
    } finally {
      setBusy(false);
    }

    if (proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && !forceAck) {
      alert('고위험 변경사항으로 독립 서브에이전트 검토가 필요합니다. 강제 승인하려면 "위험 감수 강제 승인"에 체크해 주세요.');
      return;
    }

    const msg =
      `다음 ${selected.length}개 파일에 수정안을 적용합니다.\n\n${selected.join('\n')}\n\n` +
      (partial ? '※ 일부 파일만 선택했습니다. 이 조합은 격리 검증을 거치지 않았습니다.\n\n' : '') +
      '적용 전 안전한 Checkpoint가 자동으로 저장되며, 적용 후 변경 사항은 Commit 되지 않은 상태로 남습니다. 진행할까요?';
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      if (proposal.approvalStatus !== 'APPROVED') {
        await api.approve(proposal.id, selected, forceAck, repoPath);
      }
      await api.apply(proposal.id, repoPath, partial ? selected : []);
      notify('ok', '수정안을 적용했습니다. 변경 사항을 확인한 뒤 직접 Commit 해 주세요.');
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRejectWithFeedback() {
    if (!proposal || !incident) return;
    setBusy(true);
    try {
      await api.createDirective({
        repoPath,
        incidentId: incident.id,
        proposalId: proposal.id,
        patchHash: proposal.patchHash,
        kind: 'REJECT_WITH_FEEDBACK',
        feedbackText: rejectFeedback.trim() || '수정안이 요구사항과 일치하지 않습니다. 추가 검토 후 재수정하세요.',
      });
      notify('ok', '거절 피드백 지시서를 에이전트 큐에 전달했습니다.');
      setRejectModalOpen(false);
      setRejectFeedback('');
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestDeepReview() {
    if (!proposal || !incident) return;
    setBusy(true);
    try {
      await api.createDirective({
        repoPath,
        incidentId: incident.id,
        proposalId: proposal.id,
        patchHash: proposal.patchHash,
        kind: 'REQUEST_DEEP_REVIEW',
        feedbackText: '고위험 경로에 대한 독립 서브에이전트 교차 검증 및 반증 증거 수집 요청',
      });
      notify('ok', '서브에이전트 심층 검토 지시서를 발행했습니다.');
      await refresh();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  function copyPromptSnippet(id: string, snippet: string) {
    navigator.clipboard.writeText(snippet);
    setCopiedId(id);
    notify('ok', '지시 프롬프트가 클립보드에 복사되었습니다.');
    setTimeout(() => setCopiedId(null), 2500);
  }

  async function rollback(cp: Checkpoint) {
    if (!window.confirm(`"${cp.label}" 시점으로 되돌립니다.\n현재 작업 상태는 별도 영구 백업으로 보존됩니다. 진행할까요?`)) return;
    setBusy(true);
    try {
      await api.rollback(cp.id, repoPath);
      notify('ok', 'Checkpoint 시점으로 되돌렸습니다.');
      onChanged();
    } catch (e: any) {
      notify('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  const verified = proposal?.verificationStatus === 'VERIFIED_PASS';
  const verifyFailed = proposal?.verificationStatus === 'VERIFIED_FAIL';
  const finished = proposal?.approvalStatus === 'APPLIED' || proposal?.approvalStatus === 'REJECTED' || proposal?.approvalStatus === 'TAMPERED';
  const firstErrLine = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? '';

  return (
    <div className="fade-in pb-24 space-y-5">
      <PageHeader
        title="수정 및 복구 센터"
        desc="AI가 제안한 수정안을 현재 코드와 비교하고, 검증 결과를 확인한 뒤 직접 승인해서 적용합니다."
        right={
          incidents.length > 0 ? (
            <select
              value={incidentId ?? ''}
              onChange={(e) => onPick(e.target.value)}
              className="max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 shadow-sm"
            >
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {!incident && <Empty title="선택된 Incident가 없습니다" />}
      {incident && proposals.length === 0 && (
        <Empty title="아직 제안된 수정안이 없습니다" desc="에이전트가 propose_and_verify_repair 도구로 수정안을 제출하면 이곳에서 검토할 수 있습니다." />
      )}

      {incident && proposal && (
        <div className="space-y-4">
          {/* Step 4: 사용자 신고 원문 vs AI 해석 나란히 비교 */}
          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 mb-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-indigo-600" />
                <span className="text-xs font-bold text-slate-800">요구사항 및 의도 검증 (사용자 원문 vs AI 해석)</span>
              </div>
              <span className="text-[11px] text-slate-400">
                {incident.userConfirmedIntent ? (
                  <span className="text-emerald-600 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> 4대 의도 확인 완료
                  </span>
                ) : (
                  <span className="text-amber-600 font-semibold flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> 의도 확인 진행 중
                  </span>
                )}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* 왼쪽: 사용자 신고 원문 */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-2">
                <div className="text-[11px] font-bold text-slate-600 flex items-center justify-between">
                  <span>사용자 신고 원문</span>
                  <Badge tone="gray">User Report</Badge>
                </div>
                <div className="text-xs leading-relaxed text-slate-800 bg-white p-3 rounded-lg border border-slate-100 whitespace-pre-wrap font-mono min-h-[140px]">
                  {incident.userReportText && incident.userReportText.trim() && incident.userReportText !== '없음' ? (
                    <HighlightedReportText text={incident.userReportText} quotes={userQuotes} />
                  ) : (
                    <span className="text-slate-400 italic">사용자 원문이 제공되지 않았습니다.</span>
                  )}
                </div>
              </div>

              {/* 오른쪽: AI 해석 및 출처 검증 */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-2.5">
                <div className="text-[11px] font-bold text-slate-600 flex items-center justify-between">
                  <span>AI 의도 해석 및 출처 검증</span>
                  <Badge tone="blue">AI Provenance</Badge>
                </div>

                <div className="space-y-2 text-xs">
                  {/* 기대 정상 동작 */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-700">1. 기대 정상 동작 (Expected)</span>
                      {incident.intents?.expectedBehavior.source === 'USER_QUOTE' ? (
                        <Badge tone="green">원문 인용 (USER_QUOTE)</Badge>
                      ) : incident.intents?.expectedBehavior.source === 'AI_INFERRED' ? (
                        <Badge tone="amber">AI 추론 (AI_INFERRED)</Badge>
                      ) : (
                        <Badge tone="red">누락됨 (MISSING)</Badge>
                      )}
                    </div>
                    <div className="text-slate-800 text-[11.5px]">
                      {incident.intents?.expectedBehavior.value || incident.expectedBehavior || '(미지정)'}
                    </div>
                  </div>

                  {/* 실제 오작동 증상 */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-700">2. 실제 오작동 증상 (Observed)</span>
                      {incident.intents?.observedBehavior.source === 'USER_QUOTE' ? (
                        <Badge tone="green">원문 인용 (USER_QUOTE)</Badge>
                      ) : incident.intents?.observedBehavior.source === 'AI_INFERRED' ? (
                        <Badge tone="amber">AI 추론 (AI_INFERRED)</Badge>
                      ) : (
                        <Badge tone="red">누락됨 (MISSING)</Badge>
                      )}
                    </div>
                    <div className="text-slate-800 text-[11.5px]">
                      {incident.intents?.observedBehavior.value || incident.observedBehavior || '(미지정)'}
                    </div>
                  </div>

                  {/* 재현 조건 */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-700">3. 재현 조건 (Reproduction)</span>
                      {incident.intents?.reproductionCondition.source === 'USER_QUOTE' ? (
                        <Badge tone="green">원문 인용 (USER_QUOTE)</Badge>
                      ) : incident.intents?.reproductionCondition.source === 'AI_INFERRED' ? (
                        <Badge tone="amber">AI 추론 (AI_INFERRED)</Badge>
                      ) : (
                        <Badge tone="red">누락됨 (MISSING)</Badge>
                      )}
                    </div>
                    <div className="text-slate-800 text-[11.5px]">
                      {incident.intents?.reproductionCondition.value || incident.reproductionCondition || '(미지정)'}
                    </div>
                  </div>

                  {/* 검증 방법 */}
                  <div className="bg-white p-2.5 rounded-lg border border-slate-100 space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-semibold text-slate-700">4. 검증 방법 (Verification)</span>
                      {incident.intents?.verificationMethod.source === 'USER_QUOTE' ? (
                        <Badge tone="green">원문 인용 (USER_QUOTE)</Badge>
                      ) : incident.intents?.verificationMethod.source === 'AI_INFERRED' ? (
                        <Badge tone="amber">AI 추론 (AI_INFERRED)</Badge>
                      ) : (
                        <Badge tone="red">누락됨 (MISSING)</Badge>
                      )}
                    </div>
                    <div className="text-slate-800 text-[11.5px]">
                      {incident.intents?.verificationMethod.value || incident.verificationMethod || '(미지정)'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          {proposals.length > 1 && (
            <div className="flex gap-2">
              {proposals.map((p, i) => (
                <button
                  key={p.id}
                  onClick={() => setProposalId(p.id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    p.id === proposalId
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  수정안 {proposals.length - i} · {relativeTime(p.createdAt)}
                </button>
              ))}
            </div>
          )}

          {/* Top: Cause summary, Risk Gate & Orchestration Review */}
          <Card className="p-5">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-800">위험도 평가 및 승인 게이트</span>
                {proposal.riskLevel === 'HIGH' && (
                  <Badge tone="red"><ShieldAlert className="h-3 w-3 mr-1" />고위험 (HIGH RISK)</Badge>
                )}
                {proposal.riskLevel === 'MEDIUM' && (
                  <Badge tone="amber"><AlertTriangle className="h-3 w-3 mr-1" />보통 위험 (MEDIUM)</Badge>
                )}
                {(!proposal.riskLevel || proposal.riskLevel === 'LOW') && (
                  <Badge tone="green"><ShieldCheck className="h-3 w-3 mr-1" />낮은 위험 (LOW)</Badge>
                )}

                {proposal.approvalReadiness === 'READY_FOR_APPROVAL' && (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 border border-emerald-200">
                    승인 준비 완료
                  </span>
                )}
                {proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && (
                  <span className="rounded bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 border border-rose-200">
                    독립 검토 대기 중 (승인 차단)
                  </span>
                )}
                {proposal.approvalReadiness === 'APPROVABLE_WITH_RISK_WARNING' && (
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 border border-amber-200">
                    신뢰도 주의 (위험 경고)
                  </span>
                )}
                {/* Proposal Integrity Badge */}
                <span className={`rounded px-2 py-0.5 text-[10px] font-semibold border flex items-center gap-1 ${
                  isIntegrityNormal
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : currentIntegrityStatus === '서명 없음 - 다시 검증 필요'
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}>
                  {isIntegrityNormal ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                  무결성: {currentIntegrityStatus}
                </span>
              </div>
              <span className="mono text-[11px] text-slate-400">
                Patch Hash: {proposal.patchHash ? proposal.patchHash.slice(0, 10) : 'none'}
              </span>
            </div>

            {/* 0-D: Verified With Command display */}
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-1.5 text-xs text-slate-700">
              <span className="font-semibold text-slate-600">검증 명령:</span>
              <span>이 수정안은 <code className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px] font-bold text-indigo-700">{proposal.verifiedWithCommand || 'npm test'}</code> (으)로 검증됨</span>
            </div>

            {/* Risk Evidence List */}
            {proposal.riskEvidence && proposal.riskEvidence.length > 0 && (
              <div className="mb-3 rounded-lg border border-slate-100 bg-slate-50/70 p-2.5 text-xs text-slate-700">
                <span className="font-semibold text-slate-500">위험도 판정 근거:</span>
                <ul className="mt-1 space-y-0.5 list-disc pl-4 text-[11px] text-slate-600">
                  {proposal.riskEvidence.map((ev, i) => (
                    <li key={i}>{ev}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Main AI Self-Review Checklist (when MAIN_ONLY mode has MEDIUM/HIGH risk) */}
            {proposal.selfReviewChecklist && proposal.selfReviewChecklist.length > 0 && (
              <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50/60 p-4 text-xs text-amber-950">
                <div className="flex items-center gap-1.5 font-bold text-amber-900 mb-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <span>메인 AI 자체 점검표 (독립 검토 생략 안내)</span>
                </div>
                <div className="text-[11px] text-amber-800 mb-2">
                  메인 AI 전용 모드 설정에 따라 외부 서브에이전트 오케스트레이션이 생략되었습니다. 승인 전 아래 점검표를 확인하세요:
                </div>
                <ul className="space-y-1 text-slate-800 font-medium">
                  {proposal.selfReviewChecklist.map((item, i) => (
                    <li key={i} className="flex items-start gap-1.5 bg-white/80 p-2 rounded-lg border border-amber-200 text-[11px]">
                      <span className="text-amber-600 font-bold shrink-0">✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 0-C: Tampered alert banner */}
            {proposal.approvalStatus === 'TAMPERED' && (
              <div className="mb-3 rounded-lg border border-red-300 bg-red-50 p-4 text-xs text-red-900 shadow-sm">
                <div className="flex items-start gap-2.5">
                  <ShieldAlert className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-bold text-sm text-red-800">🚨 [보안 경고: 변조 감지] 수정안 적용이 차단되었습니다</div>
                    <div className="mt-1 leading-relaxed text-red-700">
                      데이터베이스 직접 조작, 승인 서명 불일치, 또는 승인 사후 코드 변경(Patch Drift)이 감지되었습니다.
                      저장소 무단 오염을 방지하기 위해 이 수정안은 적용이 영구 차단되었습니다.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Block reason alert banner */}
            {proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50/70 p-3 text-xs text-rose-900">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">독립 검토 미완료로 승인 차단: </span>
                    {proposal.approvalBlockReason || '고위험 변경으로 네이티브 서브에이전트의 독립 검토가 필요합니다.'}
                    <div className="mt-2 flex items-center gap-2">
                      <label className="flex items-center gap-1.5 cursor-pointer text-slate-800 font-medium">
                        <input
                          type="checkbox"
                          checked={forceAck}
                          onChange={(e) => setForceAck(e.target.checked)}
                          className="h-3.5 w-3.5 rounded text-rose-600 focus:ring-0"
                        />
                        위험을 감수하고 승인 강제 허용 (Force Override with Risk Acknowledgment)
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {proposal.approvalReadiness === 'APPROVABLE_WITH_RISK_WARNING' && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold">검증 신뢰도 주의: </span>
                    {proposal.approvalBlockReason || '호스트 서브에이전트 독립 검증 로그가 누락된 대리 검토 요약입니다.'}
                  </div>
                </div>
              </div>
            )}

            <div className="mb-2 text-xs font-semibold text-slate-500">AI 원인 분석 요약</div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-800 font-medium">
              {proposal.rootCauseAnalysis}
            </p>

            {/* Independent Orchestration Review Card */}
            {proposal.orchestrationReview && (
              <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/30 p-4 text-xs">
                <div className="flex items-center justify-between border-b border-blue-100 pb-2.5 mb-2.5">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-blue-600" />
                    <span className="font-semibold text-slate-900">독립 AI 서브에이전트 검토 리포트</span>
                    <span className="mono rounded bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-600">
                      {proposal.orchestrationReview.reviewer}
                    </span>
                  </div>
                  {proposal.orchestrationReview.status === 'COMPLETED_VERIFIED' ? (
                    <Badge tone="green">
                      <ShieldCheck className="h-3 w-3 mr-1" />
                      호스트 서브에이전트 직접 검증 통과 (Verified)
                    </Badge>
                  ) : (
                    <Badge tone="amber">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      메인 AI 대리 요약 (Unverified Proxy)
                    </Badge>
                  )}
                </div>

                {proposal.orchestrationReview.findings && proposal.orchestrationReview.findings.length > 0 && (
                  <div className="space-y-1 mb-2">
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">주요 검증 결과</div>
                    <ul className="list-disc pl-4 text-slate-700 space-y-0.5">
                      {proposal.orchestrationReview.findings.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {proposal.orchestrationReview.counterEvidence && proposal.orchestrationReview.counterEvidence.length > 0 && (
                  <div className="space-y-1 mt-2">
                    <div className="text-[10px] font-semibold text-rose-500 uppercase tracking-wider">주의 및 반증 (Counter-evidence)</div>
                    <ul className="list-disc pl-4 text-rose-700 space-y-0.5">
                      {proposal.orchestrationReview.counterEvidence.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* 3-Stage Isolation Validation Pipeline */}
          {proposal.stages && proposal.stages.length > 0 && (
            <Card className="p-4 space-y-3 bg-slate-50/60 border border-slate-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-indigo-600" />
                  <span className="text-xs font-bold text-slate-900">3단계 격리 검증 파이프라인 (Security & Isolation Pipeline)</span>
                </div>
                {proposal.threeLevelHealth && (
                  <div className="flex items-center gap-1.5 text-[10px]">
                    <span className={`px-2 py-0.5 rounded font-semibold ${proposal.threeLevelHealth.code === 'PASS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                      구문: {proposal.threeLevelHealth.code}
                    </span>
                    <span className={`px-2 py-0.5 rounded font-semibold ${proposal.threeLevelHealth.functional === 'PASS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                      기능: {proposal.threeLevelHealth.functional}
                    </span>
                    <span className={`px-2 py-0.5 rounded font-semibold ${proposal.threeLevelHealth.requirement === 'PASS' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                      회귀: {proposal.threeLevelHealth.requirement}
                    </span>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {proposal.stages.map((st) => (
                  <div key={st.stage} className="rounded-lg border border-slate-200 bg-white p-3 space-y-1.5 shadow-2xs">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-slate-800">
                        {st.stage === 'CODE_CHECK' ? '1. 구문 검사' : st.stage === 'TARGET_FUNCTIONAL_CHECK' ? '2. 타깃 검증' : '3. 전체 회귀'}
                      </span>
                      <Badge tone={st.status === 'PASS' ? 'green' : st.status === 'FAIL' ? 'red' : 'gray'}>
                        {st.status}
                      </Badge>
                    </div>
                    <div className="mono text-[10px] text-slate-500 truncate" title={st.command}>
                      {st.command}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      소요 시간: {st.durationMs}ms
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-500">수정 전</div>
                <Badge tone="red"><XCircle className="h-3.5 w-3.5" />실패</Badge>
              </div>
              <div className="mono mt-2.5 truncate text-xs text-slate-800">{firstErrLine(incident.errorOutput)}</div>
              <button onClick={() => setShowLog(showLog === 'before' ? null : 'before')} className="mt-2 text-xs text-blue-600 hover:underline">
                {showLog === 'before' ? '로그 닫기' : '전체 로그 보기'}
              </button>
              {showLog === 'before' && <div className="mt-2"><CodeBlock text={incident.errorOutput} maxHeight={240} /></div>}
            </Card>

            <Card className="p-5">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-500">수정 후 (격리 Worktree)</div>
                {verified && <Badge tone="green"><CheckCircle2 className="h-3.5 w-3.5" />통과</Badge>}
                {verifyFailed && <Badge tone="red"><XCircle className="h-3.5 w-3.5" />실패</Badge>}
                {proposal.verificationStatus === 'PENDING' && <Badge tone="gray"><Loader2 className="h-3.5 w-3.5" />검증 대기</Badge>}
              </div>
              <div className="mono mt-2.5 truncate text-xs text-slate-800">{firstErrLine(proposal.verificationLog) || '-'}</div>
              <button onClick={() => setShowLog(showLog === 'after' ? null : 'after')} className="mt-2 text-xs text-blue-600 hover:underline">
                {showLog === 'after' ? '로그 닫기' : '전체 로그 보기'}
              </button>
              {showLog === 'after' && <div className="mt-2"><CodeBlock text={proposal.verificationLog} maxHeight={240} /></div>}
            </Card>
          </div>

          {/* Center: File by file Side-by-Side Comparison */}
          <div>
            <div className="mb-2.5 flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-800 flex items-center gap-2">
                <span>변경 대상 파일 ({files.length}개)</span>
                {onOpenCompare && (
                  <button
                    onClick={() => onOpenCompare(proposal.id)}
                    className="flex items-center gap-1 rounded bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200 hover:bg-blue-100 transition"
                  >
                    <GitCompare className="h-3 w-3" />
                    '코드 비교' 탭에서 전체 화면으로 보기
                  </button>
                )}
              </div>
              <div className="flex items-center gap-4 text-[11px] text-slate-400">
                <span>왼쪽: 현재 코드</span>
                <span>오른쪽: 수정안</span>
              </div>
            </div>
            <div className="space-y-3">
              {files.map((f) => (
                <Card key={f.filePath} className="overflow-hidden">
                  <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={!!checked[f.filePath]}
                      disabled={finished}
                      onChange={(e) => setChecked((c) => ({ ...c, [f.filePath]: e.target.checked }))}
                      className="h-3.5 w-3.5 rounded text-blue-600 focus:ring-0"
                    />
                    <span className="mono text-xs font-semibold text-slate-800">{f.filePath}</span>
                    <span className="text-[11px] text-emerald-600 font-medium">+{f.added}</span>
                    <span className="text-[11px] text-rose-600 font-medium">-{f.removed}</span>
                  </label>
                  <div className="mono max-h-[360px] overflow-auto text-[11.5px] leading-[1.6]">
                    {f.rows.map((r, i) =>
                      r.type === 'hunk' ? (
                        <div key={i} className="bg-blue-50/60 px-4 py-0.5 text-[11px] text-blue-600 border-y border-blue-100 font-semibold">···</div>
                      ) : (
                        <div key={i} className="grid grid-cols-2 border-b border-slate-100/60">
                          <Side cell={r.left} tone={r.type === 'change' && r.left ? 'del' : 'same'} />
                          <Side cell={r.right} tone={r.type === 'change' && r.right ? 'add' : 'same'} border />
                        </div>
                      )
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {/* Directive Queue Section */}
          {directives.length > 0 && (
            <Card className="p-4 border-slate-200">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2 mb-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-4 w-4 text-blue-600" />
                  <span className="text-xs font-semibold text-slate-900">
                    에이전트 양방향 지시서 큐 (Directives)
                  </span>
                  <span className="text-[11px] text-slate-400">({directives.length}건)</span>
                </div>
              </div>
              <div className="space-y-2">
                {directives.slice(0, 5).map((d) => (
                  <div key={d.id} className="rounded-lg border border-slate-100 bg-slate-50/70 p-3 text-xs space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800">
                          {d.kind === 'REJECT_WITH_FEEDBACK' && '수정안 거절 및 재수정 지시'}
                          {d.kind === 'REQUEST_DEEP_REVIEW' && '서브에이전트 심층 검토 요청'}
                          {d.kind === 'CONFIRM_INTENT' && '4대 기능 의도 확정'}
                          {d.kind === 'APPROVE_AND_APPLY' && '승인 및 적용'}
                        </span>
                        <span className="text-[10px] text-slate-400">{relativeTime(d.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {d.deliveryStatus === 'DELIVERED_LIVE' && (
                          <span className="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 border border-emerald-200">
                            실시간 전달됨 (Live)
                          </span>
                        )}
                        {d.deliveryStatus === 'DELIVERED_ON_NEXT_CALL' && (
                          <span className="rounded bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 border border-blue-200">
                            도구 호출 시 전달됨 (Next Call)
                          </span>
                        )}
                        {d.deliveryStatus === 'WAITING_AGENT' && (
                          <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 border border-amber-200">
                            에이전트 수신 대기 중
                          </span>
                        )}
                        {d.deliveryStatus === 'MANUAL_RESUME_REQUIRED' && (
                          <span className="rounded bg-orange-50 px-2 py-0.5 text-[10px] font-semibold text-orange-700 border border-orange-200">
                            수동 재개 필요
                          </span>
                        )}
                        {d.deliveryStatus === 'ACKNOWLEDGED' && (
                          <span className="rounded bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-700 border border-purple-200">
                            에이전트 착수 확인됨
                          </span>
                        )}
                      </div>
                    </div>
                    {d.feedbackText && (
                      <p className="text-slate-700 font-medium bg-white/80 p-2 rounded border border-slate-100 text-[11px]">
                        "{d.feedbackText}"
                      </p>
                    )}
                    {d.manualPromptSnippet && (
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[10px] text-slate-400">
                          호스트 자동 재개가 지원되지 않는 경우 프롬프트를 복사하여 채팅에 입력하세요.
                        </span>
                        <button
                          onClick={() => copyPromptSnippet(d.id, d.manualPromptSnippet!)}
                          className="flex items-center gap-1 rounded bg-white px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-200 hover:bg-slate-50 transition"
                        >
                          {copiedId === d.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-slate-500" />}
                          {copiedId === d.id ? '복사됨' : '프롬프트 복사'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {checkpoints.length > 0 && (
            <details className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <summary className="cursor-pointer text-xs font-semibold text-slate-800">
                Checkpoint 시점으로 되돌리기 (안전 복원)
              </summary>
              <div className="mt-3 space-y-2">
                {checkpoints.slice(0, 6).map((cp) => (
                  <div key={cp.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-slate-800">{cp.label}</div>
                      <div className="text-[11px] text-slate-400">{relativeTime(cp.createdAt)} · 파일 {cp.changedFiles.length}개</div>
                    </div>
                    <Button variant="ghost" disabled={busy} onClick={() => rollback(cp)}>
                      <RotateCcw className="h-3.5 w-3.5" />되돌리기
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* Bottom Approval Bar */}
      {incident && proposal && (
        <div className="fixed bottom-0 left-60 right-0 z-10 border-t border-slate-200 bg-white/95 px-8 py-3.5 shadow-lg backdrop-blur">
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-slate-600">
              {proposal.approvalStatus === 'APPLIED' && '이미 적용된 수정안입니다.'}
              {proposal.approvalStatus === 'REJECTED' && '거절된 수정안입니다.'}
              {proposal.approvalStatus === 'TAMPERED' && (
                <span className="font-semibold text-red-600">
                  🚨 변조가 감지되어 적용이 영구 차단된 수정안입니다.
                </span>
              )}
              {!finished && !isIntegrityNormal && (
                <span className="font-semibold text-rose-600 flex items-center gap-1">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  {currentIntegrityStatus === '서명 없음 - 다시 검증 필요' && '무결성 서명 없음: 이전 버전 수정안이므로 격리 환경에서 다시 검증해야 승인할 수 있습니다.'}
                  {currentIntegrityStatus === '변조 의심' && '무결성 변조 의심: 수정안 내용 또는 서명이 변조되어 승인할 수 없습니다.'}
                  {currentIntegrityStatus === '프로젝트 불일치' && '무결성 프로젝트 불일치: 현재 열린 저장소의 프로젝트와 일치하지 않아 승인할 수 없습니다.'}
                </span>
              )}
              {!finished && isIntegrityNormal && verifyFailed && '격리 검증에 실패한 수정안은 적용할 수 없습니다.'}
              {!finished && isIntegrityNormal && !verifyFailed && proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && !forceAck && (
                <span className="text-rose-600 font-medium">
                  ⚠️ 고위험 변경: 독립 서브에이전트 검토가 필요합니다 (위험 감수 강제 승인 체크 시 승인 가능).
                </span>
              )}
              {!finished && isIntegrityNormal && !verifyFailed && (proposal.approvalReadiness !== 'BLOCKED_AWAITING_REVIEW' || forceAck) && (
                <span className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    무결성 정상 확인됨
                  </span>
                  <span>·</span>
                  <span>{`선택한 파일 ${selected.length}/${files.length}개${partial ? ' · 일부만 선택됨(미검증 조합)' : ''}`}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {reproStatus && (
                <div className="flex items-center gap-2">
                  <ReproductionEvidenceBadge level={reproStatus.evidence.level} />
                  {reproStatus.lock.present && reproStatus.lock.status !== 'OK' && (
                    <span className="font-semibold text-rose-600 flex items-center gap-1 text-xs">
                      <ShieldAlert className="h-4 w-4 shrink-0" />
                      재현 테스트 잠금 이상: {LOCK_STATUS_TEXTS[reproStatus.lock.status]}
                    </span>
                  )}
                </div>
              )}
              <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={busy || finished}
                onClick={requestDeepReview}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1 text-indigo-600" />
                서브에이전트 심층 검토 요청
              </Button>
              <Button
                variant="ghost"
                disabled={busy || finished}
                onClick={() => setRejectModalOpen(true)}
              >
                거절 및 피드백 지시
              </Button>
              <Button
                variant="primary"
                disabled={
                  busy ||
                  finished ||
                  verifyFailed ||
                  selected.length === 0 ||
                  !isIntegrityNormal ||
                  (proposal.approvalReadiness === 'BLOCKED_AWAITING_REVIEW' && !forceAck)
                }
                onClick={approveAndApply}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}승인 및 복구 실행
              </Button>
            </div>
          </div>
        </div>
      </div>
    )}

      {/* Reject with Feedback Modal */}
      {rejectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-rose-600" />
                수정안 거절 사유 및 에이전트 수정 지시
              </h3>
              <button
                onClick={() => setRejectModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-600">
              거절 사유와 에이전트가 반영해야 할 추가 요구사항을 입력하세요. 이 내용은 Directive Queue를 통해 에이전트에게 즉시 전달되며, 에이전트는 격리 환경에서 재수정을 수행합니다.
            </p>
            <textarea
              value={rejectFeedback}
              onChange={(e) => setRejectFeedback(e.target.value)}
              rows={4}
              placeholder="예: 원래 함수 시그니처를 유지하면서 divisor가 0인 경우에 대한 방어 코드를 추가해 주세요."
              className="w-full rounded-lg border border-slate-300 p-2.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setRejectModalOpen(false)}>
                취소
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={submitRejectWithFeedback}
                className="bg-rose-600 hover:bg-rose-700 text-white"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                거절 지시서 전달
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Side({ cell, tone, border }: { cell: { no: number | null; text: string } | null; tone: 'del' | 'add' | 'same'; border?: boolean }) {
  const bg = tone === 'del' ? 'bg-rose-50/80' : tone === 'add' ? 'bg-emerald-50/80' : 'bg-white';
  return (
    <div className={`flex min-w-0 ${bg} ${border ? 'border-l border-slate-200' : ''}`}>
      <span className="w-9 shrink-0 select-none px-2 text-right text-[10px] text-slate-400 border-r border-slate-100">{cell?.no ?? ''}</span>
      <span className={`whitespace-pre-wrap break-words px-2.5 ${tone === 'del' ? 'text-rose-900 font-medium' : tone === 'add' ? 'text-emerald-900 font-medium' : 'text-slate-700'}`}>
        {cell ? cell.text || ' ' : ' '}
      </span>
    </div>
  );
}
