import { Overview, AuditChainVerificationResult } from '../api';
import { relativeTime } from '../diff';
import { Badge, Card, Empty, PageHeader } from '../ui';
import { CheckCircle2, XCircle, HelpCircle, GitBranch, AlertTriangle, History, ShieldCheck, ShieldAlert } from 'lucide-react';

export default function Dashboard({
  overview,
  auditChain,
  onOpenIncident,
}: {
  overview: Overview;
  auditChain?: AuditChainVerificationResult | null;
  onOpenIncident: (incidentId: string) => void;
}) {
  const { stats, health } = overview;

  const test =
    stats.openIncidents > 0
      ? {
          icon: <AlertTriangle className="h-5 w-5 text-amber-600" />,
          label: '미해결 오류 있음',
          tone: 'text-amber-700',
          sub: `미해결 사건 ${stats.openIncidents}건 · 격리 검증 통과는 원본 반영 전입니다`,
        }
      : stats.lastTestStatus === 'PASS'
        ? { icon: <CheckCircle2 className="h-5 w-5 text-emerald-600" />, label: '정상', tone: 'text-emerald-700', sub: '최근 테스트가 통과했습니다' }
        : stats.lastTestStatus === 'FAIL'
          ? { icon: <XCircle className="h-5 w-5 text-rose-600" />, label: '실패', tone: 'text-rose-700', sub: '해결되지 않은 오류가 있습니다' }
          : { icon: <HelpCircle className="h-5 w-5 text-slate-400" />, label: '기록 없음', tone: 'text-slate-500', sub: '아직 테스트 결과가 없습니다' };

  return (
    <div className="fade-in space-y-5">
      <PageHeader title="프로젝트 대시보드" desc="프로젝트의 현재 상태와 최근 AI 작업 결과를 한눈에 확인합니다." />

      <div className="grid grid-cols-4 gap-4">
        <Card className="p-5">
          <div className="text-xs font-medium text-slate-500">빌드·테스트 상태</div>
          <div className="mt-2.5 flex items-center gap-2">
            {test.icon}
            <span className={`text-xl font-bold ${test.tone}`}>{test.label}</span>
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">{test.sub}</div>
        </Card>

        <Card className="p-5">
          <div className="text-xs font-medium text-slate-500">AI 수정 성공률</div>
          <div className="mt-2.5 text-xl font-bold text-slate-900">
            {stats.successRate === null ? '-' : `${stats.successRate}%`}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">
            검증한 수정안 중 통과 {stats.verifiedPassProposals}건 / 전체 {stats.totalProposals}건
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-xs font-medium text-slate-500">미해결 오류</div>
          <div className={`mt-2.5 text-xl font-bold ${stats.openIncidents > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
            {stats.openIncidents}건
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">해결 완료 {stats.resolvedIncidents}건</div>
        </Card>

        <Card className="p-5">
          <div className="text-xs font-medium text-slate-500">복구 완료</div>
          <div className="mt-2.5 text-xl font-bold text-slate-900">{stats.appliedProposals}건</div>
          <div className="mt-1.5 text-[11px] text-slate-400">승인 후 적용된 수정안</div>
        </Card>
      </div>

      <div className="grid grid-cols-5 gap-5">
        <div className="col-span-3 space-y-4">
          <Card className="p-5">
            <div className="mb-3.5 flex items-center gap-2 text-xs font-semibold text-slate-900">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              아직 해결하지 못한 오류
            </div>
            {overview.openIncidents.length === 0 ? (
              <Empty title="미해결 오류가 없습니다" desc="테스트 실패가 감지되면 여기에 표시됩니다." />
            ) : (
              <div className="space-y-2">
                {overview.openIncidents.map((inc) => (
                  <button
                    key={inc.id}
                    onClick={() => onOpenIncident(inc.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50/50 px-4 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/30"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-slate-900 text-xs">{inc.title}</div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">
                        {inc.errorOutput.split(/\r?\n/).find((l) => l.trim()) ?? ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="text-[11px] text-slate-400">{relativeTime(inc.createdAt)}</span>
                      <Badge tone="blue">사건 분석 보기</Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3.5 flex items-center gap-2 text-xs font-semibold text-slate-900">
              <History className="h-4 w-4 text-emerald-600" />
              최근 정상 상태로 복구한 기록
            </div>
            {overview.recentRecoveries.length === 0 ? (
              <Empty title="복구 기록이 없습니다" desc="수정안을 승인하고 적용하면 기록이 쌓입니다." />
            ) : (
              <div className="space-y-2">
                {overview.recentRecoveries.map((r) => (
                  <div key={r.proposalId} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate font-semibold text-slate-900 text-xs">{r.incidentTitle}</div>
                      <span className="shrink-0 text-[11px] text-slate-400">{relativeTime(r.appliedAt)}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-slate-600">{r.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.files.map((f) => (
                        <Badge key={f}>{f}</Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="col-span-2 space-y-4">
          <Card className="p-5">
            <div className="mb-3.5 flex items-center gap-2 text-xs font-semibold text-slate-900">
              <GitBranch className="h-4 w-4 text-blue-600" />
              Git 상태
            </div>
            <div className="flex items-center justify-between text-xs py-1">
              <span className="text-slate-500">작업 트리</span>
              {health.isGitClean ? <Badge tone="green">깨끗함</Badge> : <Badge tone="amber">변경 {health.changedFiles.length}개</Badge>}
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs py-1">
              <span className="text-slate-500">HEAD</span>
              <span className="mono text-[11px] font-semibold text-slate-700">{health.currentHeadSha.slice(0, 8)}</span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs py-1">
              <span className="text-slate-500">마지막 Checkpoint</span>
              <span className="text-xs text-slate-700">
                {health.latestCheckpoint ? relativeTime(health.latestCheckpoint.createdAt) : '없음'}
              </span>
            </div>

            <div className="mt-5 border-t border-slate-100 pt-3.5 text-xs font-semibold text-slate-900">최근 Commit</div>
            <div className="mt-2.5 space-y-2.5">
              {health.recentCommits.map((c) => (
                <div key={c.sha} className="flex gap-2.5 text-xs">
                  <span className="mono mt-0.5 text-[11px] text-slate-400">{c.sha.slice(0, 7)}</span>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-800">{c.message}</div>
                    <div className="text-[11px] text-slate-400">{c.author}</div>
                  </div>
                </div>
              ))}
              {health.recentCommits.length === 0 && <div className="text-xs text-slate-400">Commit 기록이 없습니다.</div>}
            </div>
          </Card>

          {/* Audit Log Hash Chain Status Card */}
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {auditChain ? (
                  auditChain.valid ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-rose-600" />
                  )
                ) : (
                  <ShieldCheck className="h-4 w-4 text-slate-400" />
                )}
                <span className="text-xs font-semibold text-slate-900">감사 기록 해시 체인</span>
              </div>
              {auditChain ? (
                auditChain.valid ? (
                  <Badge tone="green">정상 확인됨</Badge>
                ) : (
                  <Badge tone="red">손상 의심</Badge>
                )
              ) : (
                <Badge tone="gray">확인 대기</Badge>
              )}
            </div>
            <div className="mt-2 text-[11px] text-slate-500">
              {auditChain ? (
                auditChain.valid ? (
                  <span>기록 {auditChain.totalCount}개 항목 무결성 확인됨</span>
                ) : (
                  <span className="text-rose-600 font-medium">
                    처음 깨진 위치 seq #{auditChain.brokenSeq} ({auditChain.reason || auditChain.message || '체인 불일치'})
                  </span>
                )
              ) : (
                <span>감사 기록 체인 상태를 확인하고 있습니다...</span>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
