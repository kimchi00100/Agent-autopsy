import { useState } from 'react';
import { CauseCandidate, Incident, IncidentAnalysis } from '../api';
import { relativeTime } from '../diff';
import { Badge, Card, ConfidenceBadge, Empty, PageHeader } from '../ui';
import { ArrowRight, Info } from 'lucide-react';

const STAGE_LABEL = { BUILD: '빌드 에러', RUNTIME: '런타임 에러', TEST: '테스트 단언 실패', UNKNOWN: '오류' } as const;

const RING: Record<CauseCandidate['confidence'], string> = {
  HIGH: 'border-rose-500/60 bg-rose-500/5',
  MEDIUM: 'border-amber-500/50 bg-amber-500/5',
  LOW: 'border-zinc-800 bg-zinc-900/60',
  UNKNOWN: 'border-zinc-800 bg-zinc-900/60',
};

export default function Graph({
  incidents,
  incidentId,
  onPick,
  data,
  onOpenRepair,
}: {
  incidents: Incident[];
  incidentId: string | null;
  onPick: (id: string) => void;
  data: { incident: Incident; analysis: IncidentAnalysis } | null;
  onOpenRepair: (incidentId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="fade-in">
      <PageHeader
        title="사고 분석 그래프"
        desc="코드 변경이 어떤 경로로 실패까지 이어졌는지 보여줍니다. 먼저 일어났다는 사실만으로 원인으로 단정하지 않습니다."
        right={
          incidents.length > 0 ? (
            <select
              value={incidentId ?? ''}
              onChange={(e) => onPick(e.target.value)}
              className="max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
            >
              {incidents.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title} · {relativeTime(i.createdAt)}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      {incidents.length === 0 && <Empty title="분석할 Incident가 없습니다" desc="에이전트가 collect_incident_bundle 도구로 오류를 기록하면 분석할 수 있습니다." />}

      {data && (
        <>
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm text-sky-200/90">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              확신 수준은 <b>스택트레이스 위치 일치 → 높음</b>, <b>수정된 심볼·import 관계 → 중간</b>, <b>직접 증거 없음 → 낮음</b> 기준으로
              계산합니다. 이 결과는 참고용 후보이며 최종 판단은 사용자 몫입니다.
            </div>
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-3">
            {/* 1단계: 코드 변경 후보 */}
            <div>
              <div className="mb-3 text-sm font-medium text-zinc-300">① 코드 변경 후보</div>
              <div className="space-y-3">
                {data.analysis.candidates.length === 0 && (
                  <Card className="p-4 text-sm text-zinc-500">변경된 파일이 감지되지 않았습니다.</Card>
                )}
                {data.analysis.candidates.map((c) => (
                  <div
                    key={c.filePath}
                    onClick={() => setExpanded(expanded === c.filePath ? null : c.filePath)}
                    className={`cursor-pointer rounded-xl border p-4 transition hover:brightness-125 ${RING[c.confidence]}`}
                  >
                    <div className="mono truncate text-sm font-medium">{c.filePath}</div>
                    <div className="mt-2 flex items-center gap-2">
                      <ConfidenceBadge level={c.confidence} />
                      <span className="text-xs text-emerald-400">+{c.addedLines}</span>
                      <span className="text-xs text-rose-400">-{c.removedLines}</span>
                    </div>
                    <div className="mt-3 border-t border-white/5 pt-3">
                      <div className="mb-1 text-xs font-medium text-zinc-400">근거</div>
                      <ul className="space-y-1.5 text-sm text-zinc-300">
                        {(expanded === c.filePath ? c.reasons : c.reasons.slice(0, 1)).map((r, i) => (
                          <li key={i} className="leading-snug">• {r}</li>
                        ))}
                      </ul>
                      {c.reasons.length > 1 && expanded !== c.filePath && (
                        <div className="mt-1 text-xs text-zinc-500">근거 {c.reasons.length - 1}개 더 보기</div>
                      )}
                      {c.temporalOnly && <div className="mt-2"><Badge tone="gray">시간상 선행만 확인됨</Badge></div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Arrow />

            {/* 2단계: 에러 */}
            <div>
              <div className="mb-3 text-sm font-medium text-zinc-300">② 빌드·런타임 에러</div>
              <Card className="p-4">
                <Badge tone="red">{STAGE_LABEL[data.analysis.failedStage.kind]}</Badge>
                <div className="mono mt-3 break-words text-sm text-zinc-200">{data.analysis.failedStage.summary}</div>
                {data.analysis.stackFrames.length > 0 && (
                  <div className="mt-4 border-t border-zinc-800 pt-3">
                    <div className="mb-1.5 text-xs font-medium text-zinc-400">스택트레이스 위치</div>
                    <ul className="mono space-y-1 text-xs text-zinc-400">
                      {data.analysis.stackFrames.slice(0, 5).map((f, i) => (
                        <li key={i} className="truncate">{f.filePath}:{f.line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            </div>

            <Arrow />

            {/* 3단계: 테스트 실패 */}
            <div>
              <div className="mb-3 text-sm font-medium text-zinc-300">③ 테스트 실패</div>
              <Card className="p-4">
                {data.analysis.failedTests.length > 0 ? (
                  <ul className="space-y-2">
                    {data.analysis.failedTests.map((t) => (
                      <li key={t} className="flex gap-2 text-sm">
                        <Badge tone="red">실패</Badge>
                        <span className="break-words text-zinc-200">{t}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-sm text-zinc-500">로그에서 개별 테스트 이름을 찾지 못했습니다.</div>
                )}
                <div className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                  Incident 상태: {data.incident.status === 'RESOLVED' ? '해결됨' : '미해결'}
                </div>
              </Card>
              <button
                onClick={() => onOpenRepair(data.incident.id)}
                className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 text-sm font-medium transition hover:bg-zinc-700"
              >
                수정 및 복구 센터에서 수정안 보기
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex h-full items-start pt-10 text-zinc-600">
      <ArrowRight className="h-5 w-5" />
    </div>
  );
}
