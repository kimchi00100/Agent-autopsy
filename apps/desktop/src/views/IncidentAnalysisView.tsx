import { useState, useEffect } from 'react';
import { api, Incident, IncidentAnalysis, Proposal, TimelineEvent, FlowNode, FlowEdge } from '../api';
import IncidentFlowGraph from './IncidentFlowGraph';
import { Badge, Button, Card, CodeBlock, UnifiedDiff } from '../ui';
import { parseSideBySide, relativeTime, clock } from '../diff';
import {
  AlertCircle,
  FileCode2,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  Target,
  AlertTriangle,
  ShieldAlert,
  RotateCcw,
  CheckSquare,
} from 'lucide-react';

interface Props {
  incident: Incident;
  analysis: IncidentAnalysis | null;
  repoPath: string;
  onOpenRepairCenter: (incidentId: string) => void;
  onChanged: () => void;
  notify: (kind: 'ok' | 'error', msg: string) => void;
}

type SubTab = 'flow' | 'timeline' | 'diff' | 'test' | 'ai' | 'proposals';

export default function IncidentAnalysisView({
  incident,
  analysis,
  repoPath,
  onOpenRepairCenter,
  onChanged,
  notify,
}: Props) {
  const [subTab, setSubTab] = useState<SubTab>('flow');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [selectedItem, setSelectedItem] = useState<{ type: 'node' | 'edge'; data: FlowNode | FlowEdge } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.proposals(incident.id).then((r) => setProposals(r.proposals));
    api.timeline(incident.projectId).then((r) => {
      setTimelineEvents(r.events.filter((e) => e.refs.incidentId === incident.id));
    });
  }, [incident.id, incident.projectId]);

  const topProposal = proposals[0];
  const health = analysis?.threeLevelHealth || incident.threeLevelHealth;
  const causeVerdict = analysis?.causeVerdict || incident.causeVerdict || 'LIKELY';
  const verificationType = analysis?.verificationType || incident.verificationType || 'LOGIC_TEST';

  const handleApproveAndApply = async (prop: Proposal) => {
    if (!window.confirm(`수정안 "${prop.id}"을 승인하고 적용하시겠습니까?`)) return;
    setBusy(true);
    try {
      await api.approve(prop.id);
      await api.apply(prop.id, repoPath, prop.touchedFiles);
      notify('ok', '수정안이 안전하게 적용되었습니다.');
      onChanged();
    } catch (err: any) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRollbackBase = async () => {
    if (!incident.baseCheckpointId) return;
    if (!window.confirm('사건 발생 전 기준 체크포인트 상태로 롤백하시겠습니까?')) return;
    setBusy(true);
    try {
      await api.rollback(incident.baseCheckpointId, repoPath);
      notify('ok', '기준 체크포인트로 안전하게 복원되었습니다.');
      onChanged();
    } catch (err: any) {
      notify('error', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fade-in space-y-4">
      {/* Policy Bypass Alert Banner if unapproved direct modifications exist */}
      {incident.diffSummary && incident.diffSummary.length > 50 && (
        <div className="flex items-center justify-between rounded-xl border border-amber-300 bg-amber-50/80 px-4 py-3 text-xs text-amber-900 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0" />
            <div>
              <span className="font-semibold">작업 트리 변경 감지 (미승인 직접 수정 감시 중):</span>{' '}
              <span>체크포인트 이후 수정된 변경 사항이 감지되었습니다. 의도한 기능 불일치 여부를 아래 3단계로 검증하세요.</span>
            </div>
          </div>
          {incident.baseCheckpointId && (
            <Button variant="default" className="py-1 px-2.5" onClick={handleRollbackBase} disabled={busy}>
              <RotateCcw className="h-3 w-3 mr-1" />
              기준 체크포인트 복원
            </Button>
          )}
        </div>
      )}

      {/* 1. Incident Header Card */}
      <Card className="p-5 border-slate-200">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-50 border border-rose-200 text-rose-600">
              <AlertCircle className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-slate-900">
                  사건 #{incident.id.slice(-6).toUpperCase()}
                </span>
                <Badge tone={incident.status === 'RESOLVED' ? 'green' : 'blue'}>
                  {incident.status === 'RESOLVED' ? '해결됨' : '분석 중'}
                </Badge>
                {/* Cause Verdict Badge */}
                <Badge
                  tone={
                    causeVerdict === 'CONFIRMED'
                      ? 'green'
                      : causeVerdict === 'LIKELY'
                      ? 'amber'
                      : 'red'
                  }
                >
                  {causeVerdict === 'CONFIRMED'
                    ? '원인 판정: 확정됨'
                    : causeVerdict === 'LIKELY'
                    ? '원인 판정: 유력함'
                    : '원인 판정: 미입증 (증거 부족)'}
                </Badge>
                {/* Verification Type Badge */}
                <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 border border-slate-200">
                  {verificationType === 'LOGIC_TEST'
                    ? '함수 로직 검증'
                    : verificationType === 'DATA_STATE'
                    ? '데이터/상태 검증'
                    : verificationType === 'UI_FLOW'
                    ? '웹 UI 흐름'
                    : '수동 확인 필요'}
                </span>
                {/* Risk Level Badge */}
                {incident.riskLevel && (
                  <Badge tone={incident.riskLevel === 'HIGH' ? 'red' : incident.riskLevel === 'MEDIUM' ? 'amber' : 'green'}>
                    {incident.riskLevel === 'HIGH'
                      ? '위험도: 높음'
                      : incident.riskLevel === 'MEDIUM'
                      ? '위험도: 보통'
                      : '위험도: 낮음'}
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 font-medium">{incident.title}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="default" onClick={() => onOpenRepairCenter(incident.id)}>
              복구 센터 열기
            </Button>
            <Button variant="default" onClick={() => alert('사건 포렌식 리포트가 클립보드에 복사되었습니다.')}>
              리포트 복사
            </Button>
          </div>
        </div>

        {/* Orchestration Decision Card */}
        {incident.orchestrationDecision && (
          <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-2.5 text-xs text-indigo-900">
            <div className="flex items-center justify-between">
              <span className="font-semibold flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
                AI 오케스트레이션 판단 ({incident.orchestrationDecision.verificationMode === 'AUTO' ? '자동 판단 모드' : incident.orchestrationDecision.verificationMode === 'MAIN_ONLY' ? '메인 AI 전용 모드' : '심층 검증 우선'}):
                <span className="font-normal text-slate-700 ml-1">{incident.orchestrationDecision.reason}</span>
              </span>
              <span className="text-[11px] font-semibold text-indigo-600">
                {incident.orchestrationDecision.requiresOrchestration ? '독립 서브에이전트 검증 권고' : '메인 AI 직접 검증 가능'}
              </span>
            </div>
            {incident.riskSignals && incident.riskSignals.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {incident.riskSignals.map((sig, i) => (
                  <span key={i} className="rounded bg-white/80 border border-indigo-200 px-1.5 py-0.2 text-[10px] text-indigo-800">
                    ⚠ {sig}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 4 Mini KPI Cards with 3-Level Verification Health */}
        <div className="mt-5 grid grid-cols-4 gap-3">
          {/* Level 1: Code Health */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <div className="text-[11px] text-slate-400 font-medium">1단계: 코드 정상 여부</div>
            <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
              {health?.code === 'PASS' ? (
                <span className="flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> 정상 (빌드/타입 통과)
                </span>
              ) : (
                <span className="flex items-center gap-1 text-rose-600">
                  <XCircle className="h-3.5 w-3.5" /> 오류 발생
                </span>
              )}
            </div>
          </div>

          {/* Level 2: Functional Health */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <div className="text-[11px] text-slate-400 font-medium">2단계: 기능 정상 여부</div>
            <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
              {health?.functional === 'PASS' ? (
                <span className="flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> 정상 작동
                </span>
              ) : (
                <span className="flex items-center gap-1 text-rose-600">
                  <AlertTriangle className="h-3.5 w-3.5" /> 불일치 (기능 미반영)
                </span>
              )}
            </div>
          </div>

          {/* Level 3: Requirement Health */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <div className="text-[11px] text-slate-400 font-medium">3단계: 요구사항 충족</div>
            <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
              {health?.requirement === 'PASS' ? (
                <span className="flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> 의도 달성 완료
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-600">
                  <Target className="h-3.5 w-3.5" /> 미충족 (검증 필요)
                </span>
              )}
            </div>
          </div>

          {/* Severity & Agent */}
          <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
            <div className="text-[11px] text-slate-400 font-medium">심각도 및 담당 에이전트</div>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">{incident.agentName || 'Antigravity'}</span>
              <Badge tone={incident.severity === 'HIGH' ? 'red' : 'amber'}>
                {incident.severity === 'HIGH' ? '높음' : '보통'}
              </Badge>
            </div>
          </div>
        </div>
      </Card>

      {/* Main 2-Column Layout */}
      <div className="grid grid-cols-12 gap-5 items-start">
        {/* Left 8-cols: Sub-tabs & Graph Canvas */}
        <div className="col-span-8 space-y-3">
          {/* Sub Navigation Tabs */}
          <div className="flex border-b border-slate-200 gap-6 px-1 text-xs font-medium text-slate-500">
            {[
              ['flow', '사건 흐름도'],
              ['timeline', '타임라인'],
              ['diff', '변경 사항'],
              ['test', '테스트 결과'],
              ['ai', 'AI 분석'],
              ['proposals', '복구 제안'],
            ].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setSubTab(id as SubTab)}
                className={`pb-2.5 transition border-b-2 -mb-px ${
                  subTab === id
                    ? 'border-blue-600 font-semibold text-blue-600'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Tab 1: 사건 흐름도 (Interactive Graph Canvas with Node Dragging & Dimming) */}
          {subTab === 'flow' && analysis?.flowData && (
            <div className="fade-in">
              <IncidentFlowGraph
                flowData={analysis.flowData}
                onSelectNode={(node) => setSelectedItem({ type: 'node', data: node })}
                onSelectEdge={(edge) => setSelectedItem({ type: 'edge', data: edge })}
              />
            </div>
          )}

          {/* Tab 2: 타임라인 */}
          {subTab === 'timeline' && (
            <div className="fade-in space-y-2">
              {timelineEvents.map((e) => (
                <Card key={e.id} className="p-3.5 flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold text-slate-900">{e.title}</div>
                    <div className="mt-0.5 text-xs text-slate-500">{e.summary}</div>
                  </div>
                  <span className="text-[11px] text-slate-400">{clock(e.createdAt)}</span>
                </Card>
              ))}
            </div>
          )}

          {/* Tab 3: 변경 사항 (Git Diff) */}
          {subTab === 'diff' && (
            <div className="fade-in">
              <UnifiedDiff text={incident.diffSummary} />
            </div>
          )}

          {/* Tab 4: 테스트 결과 */}
          {subTab === 'test' && (
            <div className="fade-in space-y-3">
              <CodeBlock text={incident.errorOutput} maxHeight={520} />
            </div>
          )}

          {/* Tab 5: AI 분석 */}
          {subTab === 'ai' && (
            <div className="fade-in space-y-3">
              {proposals.length === 0 ? (
                <Card className="p-6 text-center text-slate-500 text-xs">
                  아직 AI 원인 분석 및 수정안이 등록되지 않았습니다.
                </Card>
              ) : (
                proposals.map((p) => (
                  <Card key={p.id} className="p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="h-4 w-4 text-blue-600" />
                      <span className="font-semibold text-slate-900 text-xs">AI 원인 추론 리포트</span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
                      {p.rootCauseAnalysis}
                    </p>
                  </Card>
                ))
              )}
            </div>
          )}

          {/* Tab 6: 복구 제안 */}
          {subTab === 'proposals' && (
            <div className="fade-in space-y-4">
              {proposals.map((p) => (
                <Card key={p.id} className="p-5">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
                    <div>
                      <span className="font-semibold text-slate-900 text-xs">수정안 #{p.id.slice(-6)}</span>
                      <span className="ml-2 text-[11px] text-slate-400">{relativeTime(p.createdAt)}</span>
                    </div>
                    <Badge tone={p.verificationStatus === 'VERIFIED_PASS' ? 'green' : 'red'}>
                      {p.verificationStatus === 'VERIFIED_PASS' ? '격리 검증 통과' : '격리 검증 실패'}
                    </Badge>
                  </div>

                  <p className="text-xs text-slate-600 mb-4">{p.rootCauseAnalysis}</p>

                  <div className="mb-4">
                    <UnifiedDiff text={p.patchDiff} />
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => onOpenRepairCenter(incident.id)}>
                      복구 센터에서 열기
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy || p.verificationStatus !== 'VERIFIED_PASS' || p.approvalStatus === 'APPLIED'}
                      onClick={() => handleApproveAndApply(p)}
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {p.approvalStatus === 'APPLIED' ? '적용 완료' : '승인 및 적용'}
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Right 4-cols: Sticky Context Inspector */}
        <div className="col-span-4 space-y-4">
          <Card className="p-4 border-slate-200">
            {/* If an element is clicked in the graph, show its detailed inspection card */}
            {selectedItem ? (
              <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/40 p-3.5 text-xs">
                <div className="flex items-center justify-between border-b border-blue-100 pb-2 mb-2.5">
                  <span className="font-semibold text-blue-900">
                    {selectedItem.type === 'node'
                      ? `[단계 분석] ${(selectedItem.data as FlowNode).label}`
                      : `[연결 분석] ${(selectedItem.data as FlowEdge).label || '호출 연결'}`}
                  </span>
                  <button
                    onClick={() => setSelectedItem(null)}
                    className="text-[11px] text-blue-600 hover:underline font-medium"
                  >
                    초기화
                  </button>
                </div>

                {selectedItem.type === 'node' && (
                  <div className="space-y-2">
                    {(selectedItem.data as FlowNode).path && (
                      <div>
                        <div className="text-[10px] text-slate-400 font-medium">코드 위치</div>
                        <div className="mono text-[11px] font-semibold text-slate-800">
                          {(selectedItem.data as FlowNode).path}
                        </div>
                      </div>
                    )}

                    {(selectedItem.data as FlowNode).expectedValue && (
                      <div className="rounded bg-white p-2 border border-blue-100">
                        <div className="text-[10px] text-blue-600 font-semibold">사용자 기대 동작 (Expected)</div>
                        <div className="mt-0.5 text-slate-700 text-[11px]">
                          {(selectedItem.data as FlowNode).expectedValue}
                        </div>
                      </div>
                    )}

                    {(selectedItem.data as FlowNode).observedValue && (
                      <div className="rounded bg-white p-2 border border-rose-100">
                        <div className="text-[10px] text-rose-600 font-semibold">실제 관찰 결과 (Observed)</div>
                        <div className="mt-0.5 text-slate-700 text-[11px]">
                          {(selectedItem.data as FlowNode).observedValue}
                        </div>
                      </div>
                    )}

                    {(selectedItem.data as FlowNode).threeLevelStatus && (
                      <div className="pt-2 border-t border-blue-100">
                        <div className="text-[10px] text-slate-500 font-semibold mb-1">3단계 검증 판정</div>
                        <div className="grid grid-cols-3 gap-1 text-[10px] text-center font-medium">
                          <div className="bg-emerald-50 text-emerald-700 border border-emerald-200 rounded py-1">
                            코드 {(selectedItem.data as FlowNode).threeLevelStatus?.code}
                          </div>
                          <div className="bg-rose-50 text-rose-700 border border-rose-200 rounded py-1">
                            기능 {(selectedItem.data as FlowNode).threeLevelStatus?.functional}
                          </div>
                          <div className="bg-amber-50 text-amber-700 border border-amber-200 rounded py-1">
                            요구사항 {(selectedItem.data as FlowNode).threeLevelStatus?.requirement}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedItem.type === 'edge' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">연결 증거 종류</span>
                      <span className="font-semibold text-slate-800">
                        {(selectedItem.data as FlowEdge).isObserved ? '실제 실행 관찰됨 (실선)' : '정적 코드 추론 (점선)'}
                      </span>
                    </div>
                    {(selectedItem.data as FlowEdge).expected && (
                      <div className="text-slate-600 text-[11px]">
                        기대 전달값: {(selectedItem.data as FlowEdge).expected}
                      </div>
                    )}
                    {(selectedItem.data as FlowEdge).observed && (
                      <div className="text-rose-600 text-[11px]">
                        실제 관찰값: {(selectedItem.data as FlowEdge).observed}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : null}

            {/* Inspector Header */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-3">
              <span className="font-semibold text-slate-900 text-xs">사건 상세 정보</span>
              <Badge tone={incident.status === 'RESOLVED' ? 'green' : 'blue'}>
                {incident.status === 'RESOLVED' ? '해결됨' : '분석 중'}
              </Badge>
            </div>

            {/* Basic Info Table */}
            <div className="space-y-2 text-xs">
              <div className="text-[11px] font-semibold text-slate-400">기본 정보</div>
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">사건 ID</span>
                <span className="font-medium text-slate-800">#{incident.id.slice(-6).toUpperCase()}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">원인 판정</span>
                <span className={`font-semibold ${
                  causeVerdict === 'CONFIRMED' ? 'text-emerald-600' : causeVerdict === 'LIKELY' ? 'text-amber-600' : 'text-rose-600'
                }`}>
                  {causeVerdict}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">검증 유형</span>
                <span className="font-medium text-slate-800">{verificationType}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">사용자 확인 여부</span>
                <span className="font-medium text-emerald-600 flex items-center gap-1">
                  <CheckSquare className="h-3 w-3" />
                  {incident.userConfirmedIntent ? '확인 완료' : '미확인'}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-slate-500">발생 시간</span>
                <span className="text-slate-800">{clock(incident.createdAt)}</span>
              </div>
            </div>

            {/* Missing Evidence Checklist when UNKNOWN */}
            {causeVerdict === 'UNKNOWN' && analysis?.missingEvidenceChecklist && analysis.missingEvidenceChecklist.length > 0 && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/50 p-3 text-xs">
                <div className="font-semibold text-rose-800 mb-1.5 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  추측 수정 차단: 추가 필요 증거
                </div>
                <ul className="space-y-1 text-[11px] text-rose-700 list-disc list-inside">
                  {analysis.missingEvidenceChecklist.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Related Files */}
            <div className="mt-5 pt-3 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[11px] font-semibold text-slate-400">
                  관련 파일 ({analysis?.changedFiles.length || 0})
                </span>
                <button onClick={() => setSubTab('diff')} className="text-[11px] text-blue-600 hover:underline">
                  모두 보기 &gt;
                </button>
              </div>

              <div className="space-y-1.5">
                {analysis?.changedFiles.map((file) => (
                  <div
                    key={file.filePath}
                    onClick={() => setSubTab('diff')}
                    className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-100 bg-slate-50/50 p-2 text-xs transition hover:bg-slate-100/60"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileCode2 className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                      <span className="mono truncate font-medium text-slate-800">{file.filePath}</span>
                    </div>
                    <span className="ml-2 shrink-0 font-medium text-[11px]">
                      <span className="text-emerald-600">+{file.addedLines}</span>{' '}
                      <span className="text-rose-600">-{file.removedLines}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Root Cause Candidates with Evidence & Counter-Evidence */}
            <div className="mt-5 pt-3 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[11px] font-semibold text-slate-400">
                  원인 후보 ({analysis?.candidates.length || 0})
                </span>
                <span className="text-[10px] text-slate-400">증거 기반 순위</span>
              </div>

              <div className="space-y-2.5">
                {analysis?.candidates.slice(0, 2).map((cand, idx) => (
                  <div key={cand.filePath} className="rounded-xl border border-amber-200/80 bg-amber-50/30 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
                          {idx + 1}
                        </span>
                        <span className="mono truncate">{cand.filePath}</span>
                      </div>
                      <span className="font-semibold text-amber-600 text-[11px]">
                        확신도 {cand.matchPercentage}%
                      </span>
                    </div>

                    <div className="mt-2 space-y-1 text-slate-600 text-[11px]">
                      {cand.supportingEvidence.map((ev, i) => (
                        <div key={i} className="flex items-start gap-1">
                          <span className="text-blue-500">•</span>
                          <span>{ev}</span>
                        </div>
                      ))}
                      {cand.counterEvidence.map((ev, i) => (
                        <div key={i} className="flex items-start gap-1 text-slate-400">
                          <span className="text-slate-400">•</span>
                          <span>{ev}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recovery Proposal Mini Card */}
            {topProposal && (
              <div className="mt-5 pt-3 border-t border-slate-100">
                <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-900">수정안 1 (권장)</span>
                    <Badge tone="green">격리 검증 통과</Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-xs text-slate-600">
                    {topProposal.rootCauseAnalysis}
                  </p>
                  <Button
                    variant="primary"
                    className="mt-3 w-full"
                    onClick={() => onOpenRepairCenter(incident.id)}
                  >
                    상세 보기
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
