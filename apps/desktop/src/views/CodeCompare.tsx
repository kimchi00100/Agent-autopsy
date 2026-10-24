import { useState, useEffect, useMemo } from 'react';
import { api, Checkpoint, Incident, Proposal, WorkspaceComparison } from '../api';
import { parseSideBySide, FileDiff } from '../diff';
import { Badge, Button, Card, Empty, PageHeader, UnifiedDiff } from '../ui';
import {
  GitCompare,
  FileCode2,
  Columns,
  AlignJustify,
  Flag,
  Lightbulb,
  GitCommit,
  RefreshCw,
  FolderGit2,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';

interface Props {
  repoPath: string;
  checkpoints: Checkpoint[];
  incidents: Incident[];
  initialMode?: 'working' | 'checkpoint' | 'proposal' | 'commit';
  initialFile?: string | null;
  initialCommitSha?: string | null;
  onOpenRepair?: () => void;
  lang?: 'ko' | 'en';
}

type CompareMode = 'working' | 'checkpoint' | 'proposal' | 'commit';
type DiffLayout = 'side-by-side' | 'unified';

export default function CodeCompare({
  repoPath,
  checkpoints,
  incidents,
  initialMode = 'working',
  initialFile = null,
  initialCommitSha = null,
  onOpenRepair,
  lang = 'ko',
}: Props) {
  const [mode, setMode] = useState<CompareMode>(initialMode);
  const [diffLayout, setDiffLayout] = useState<DiffLayout>('side-by-side');
  const [comparison, setComparison] = useState<WorkspaceComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>(checkpoints[0]?.id || '');
  const [selectedCommitSha, setSelectedCommitSha] = useState<string>(initialCommitSha || '');
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile);

  // Proposals from open incidents
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);

  // Load proposals from active incidents
  useEffect(() => {
    let cancel = false;
    const fetchProposals = async () => {
      const all: Proposal[] = [];
      for (const inc of incidents.slice(0, 5)) {
        try {
          const res = await api.proposals(inc.id);
          all.push(...res.proposals);
        } catch {}
      }
      if (!cancel) {
        setProposals(all);
        if (all.length > 0 && !selectedProposalId) {
          setSelectedProposalId(all[0].id);
        }
      }
    };
    fetchProposals();
    return () => {
      cancel = true;
    };
  }, [incidents]);

  // Load workspace diff data
  const loadComparison = async (chkId?: string, commitSha?: string) => {
    if (!repoPath) return;
    setLoading(true);
    try {
      const res = await api.workspaceDiff(repoPath, {
        checkpointId: chkId || selectedCheckpointId || undefined,
        commitSha: commitSha || selectedCommitSha || undefined,
      });
      setComparison(res);
      if (res.selectedCommitSha && !selectedCommitSha) {
        setSelectedCommitSha(res.selectedCommitSha);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    loadComparison();
  }, [repoPath, selectedCheckpointId, selectedCommitSha]);

  // Active raw diff based on mode
  const activeDiffString = useMemo(() => {
    if (mode === 'working') {
      return comparison?.workingDiff || '';
    }
    if (mode === 'checkpoint') {
      return comparison?.checkpointDiff || '';
    }
    if (mode === 'proposal') {
      const prop = proposals.find((p) => p.id === selectedProposalId);
      return prop?.patchDiff || '';
    }
    if (mode === 'commit') {
      return comparison?.commitDiff || '';
    }
    return '';
  }, [mode, comparison, proposals, selectedProposalId]);

  // Parsed side-by-side files
  const fileDiffs: FileDiff[] = useMemo(() => {
    if (!activeDiffString) return [];
    return parseSideBySide(activeDiffString);
  }, [activeDiffString]);

  // Available files in current diff
  const availableFiles = useMemo(() => {
    const list = fileDiffs.map((f) => f.filePath);
    if (mode === 'working' && comparison?.untrackedFiles) {
      for (const u of comparison.untrackedFiles) {
        if (!list.includes(u)) list.push(u);
      }
    }
    return list;
  }, [fileDiffs, mode, comparison]);

  // Set initial selected file if available
  useEffect(() => {
    if (availableFiles.length > 0 && (!selectedFile || !availableFiles.includes(selectedFile))) {
      setSelectedFile(availableFiles[0]);
    }
  }, [availableFiles]);

  // Filtered files for display
  const displayedFileDiffs = useMemo(() => {
    if (!selectedFile) return fileDiffs;
    return fileDiffs.filter((f) => f.filePath === selectedFile);
  }, [fileDiffs, selectedFile]);

  return (
    <div className="fade-in space-y-4">
      {/* 1. Header Bar */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <GitCompare className="h-5 w-5 text-blue-600" />
            <h1 className="text-lg font-bold text-slate-900">
              {lang === 'en' ? 'Code Comparison & Diff Viewer' : '코드 비교 & Diff 분석 센터'}
            </h1>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {lang === 'en'
              ? 'Inspect real-time working tree modifications, checkpoint baselines, and AI proposal patches.'
              : '현재 작업 트리의 실시간 변경 사항, 기준 체크포인트 대비 차이, AI 수정안 패치를 한눈에 비교합니다.'}
          </p>
        </div>

        {/* Right Layout & Refresh Controls */}
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-xs">
            <button
              onClick={() => setDiffLayout('side-by-side')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                diffLayout === 'side-by-side'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="좌우 나란히 비교"
            >
              <Columns className="h-3.5 w-3.5" />
              {lang === 'en' ? 'Side by Side' : '좌우 나란히'}
            </button>
            <button
              onClick={() => setDiffLayout('unified')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                diffLayout === 'unified'
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
              title="통합 줄 비교"
            >
              <AlignJustify className="h-3.5 w-3.5" />
              {lang === 'en' ? 'Unified' : '통합 줄'}
            </button>
          </div>

          <Button variant="default" onClick={() => loadComparison()}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {lang === 'en' ? 'Refresh' : '새로고침'}
          </Button>

          {onOpenRepair && (
            <Button variant="primary" onClick={onOpenRepair}>
              <ExternalLink className="h-3.5 w-3.5 mr-1" />
              {lang === 'en' ? 'Repair Center' : '복구 센터 이동'}
            </Button>
          )}
        </div>
      </div>

      {/* 2. Mode Selector Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-2.5 shadow-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => {
              setMode('working');
              setSelectedFile(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === 'working'
                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            {lang === 'en' ? 'Working Tree vs HEAD' : '현재 작업 트리 (vs HEAD)'}
            {comparison?.changedFiles && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] text-blue-800">
                {comparison.changedFiles.length + comparison.untrackedFiles.length}
              </span>
            )}
          </button>

          <button
            onClick={() => {
              setMode('checkpoint');
              setSelectedFile(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === 'checkpoint'
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Flag className="h-3.5 w-3.5" />
            {lang === 'en' ? 'vs Checkpoint' : '기준 체크포인트 대비'}
          </button>

          <button
            onClick={() => {
              setMode('proposal');
              setSelectedFile(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === 'proposal'
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Lightbulb className="h-3.5 w-3.5" />
            {lang === 'en' ? 'AI Proposal Patch' : 'AI 제안 수정안 패치'}
            {proposals.length > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 py-0.2 text-[10px] text-amber-800">
                {proposals.length}
              </span>
            )}
          </button>

          <button
            onClick={() => {
              setMode('commit');
              setSelectedFile(null);
            }}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              mode === 'commit'
                ? 'bg-purple-50 text-purple-700 border border-purple-200'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <GitCommit className="h-3.5 w-3.5" />
            {lang === 'en' ? 'Recent Commits' : '최근 커밋 변경 내역'}
          </button>
        </div>

        {/* Context-Specific Dropdowns */}
        <div className="flex items-center gap-2">
          {mode === 'checkpoint' && (
            <select
              value={selectedCheckpointId}
              onChange={(e) => setSelectedCheckpointId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white py-1 px-2.5 text-xs text-slate-800 font-medium focus:outline-none focus:border-blue-500"
            >
              {checkpoints.length === 0 && <option value="">(체크포인트 없음)</option>}
              {checkpoints.map((cp) => (
                <option key={cp.id} value={cp.id}>
                  {cp.label} ({cp.id.slice(-6)})
                </option>
              ))}
            </select>
          )}

          {mode === 'proposal' && (
            <select
              value={selectedProposalId || ''}
              onChange={(e) => setSelectedProposalId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white py-1 px-2.5 text-xs text-slate-800 font-medium focus:outline-none focus:border-blue-500"
            >
              {proposals.length === 0 && <option value="">(등록된 수정안 없음)</option>}
              {proposals.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id.slice(-6)}: {p.rootCauseAnalysis.slice(0, 30)}...
                </option>
              ))}
            </select>
          )}

          {mode === 'commit' && comparison?.recentCommits && (
            <select
              value={selectedCommitSha}
              onChange={(e) => setSelectedCommitSha(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white py-1 px-2.5 text-xs text-slate-800 font-medium focus:outline-none focus:border-blue-500 max-w-[280px]"
            >
              {comparison.recentCommits.map((c) => (
                <option key={c.sha} value={c.sha}>
                  {c.sha.slice(0, 7)}: {c.message}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* 3. Main Diff Workspace: Left File Selector + Right Code Diff */}
      <div className="grid grid-cols-12 gap-4 items-start">
        {/* Left Column: File Selector List */}
        <div className="col-span-3 space-y-2">
          <Card className="p-3">
            <div className="flex items-center justify-between text-xs font-bold text-slate-700 mb-2">
              <span>{lang === 'en' ? 'Changed Files' : '변경 파일 목록'}</span>
              <span className="text-[10px] text-slate-400 font-normal">
                {availableFiles.length} {lang === 'en' ? 'files' : '개 파일'}
              </span>
            </div>

            {availableFiles.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-400">
                {lang === 'en' ? 'No changed files.' : '변경된 파일이 없습니다.'}
              </div>
            ) : (
              <div className="space-y-1 max-h-[580px] overflow-y-auto pr-1">
                <button
                  onClick={() => setSelectedFile(null)}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                    selectedFile === null
                      ? 'bg-blue-50 font-semibold text-blue-700 border border-blue-200'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <span className="truncate">{lang === 'en' ? 'View All Files' : '전체 파일 통합 보기'}</span>
                  <span className="text-[10px] font-mono text-slate-400">전체</span>
                </button>

                {availableFiles.map((file) => {
                  const fd = fileDiffs.find((f) => f.filePath === file);
                  const isUntracked = comparison?.untrackedFiles?.includes(file);
                  const isSelected = selectedFile === file;

                  return (
                    <button
                      key={file}
                      onClick={() => setSelectedFile(file)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition ${
                        isSelected
                          ? 'bg-blue-50 font-semibold text-blue-700 border border-blue-200'
                          : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <FileCode2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        <span className="mono truncate text-[11px]" title={file}>
                          {file}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-1">
                        {isUntracked && (
                          <span className="rounded bg-slate-100 px-1 py-0.2 text-[9px] text-slate-500 font-medium">
                            미추적
                          </span>
                        )}
                        {fd && fd.added > 0 && (
                          <span className="font-mono text-[10px] text-emerald-600 font-semibold">
                            +{fd.added}
                          </span>
                        )}
                        {fd && fd.removed > 0 && (
                          <span className="font-mono text-[10px] text-rose-600 font-semibold">
                            -{fd.removed}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Right Column: Code Diff Viewer (Side-by-Side or Unified) */}
        <div className="col-span-9 space-y-4">
          {!activeDiffString ? (
            <Card className="py-20 text-center">
              <Empty
                title={lang === 'en' ? 'No Modifications Detected' : '선택한 기준과 일치합니다 (변경 사항 없음)'}
                desc={
                  lang === 'en'
                    ? 'The working directory has no diff against this baseline.'
                    : '현재 작업 트리가 해당 기준 스냅샷과 완벽하게 일치합니다.'
                }
              />
            </Card>
          ) : diffLayout === 'unified' ? (
            /* Unified Diff View */
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-xs font-semibold text-slate-700">
                  {selectedFile || (lang === 'en' ? 'All Files' : '전체 파일 Diff')}
                </span>
                <span className="text-[11px] text-slate-400 font-mono">Unified Diff</span>
              </div>
              <UnifiedDiff text={activeDiffString} />
            </Card>
          ) : (
            /* Side-by-Side Diff View */
            <div className="space-y-4">
              {displayedFileDiffs.map((fd) => (
                <Card key={fd.filePath} className="overflow-hidden border-slate-200">
                  {/* File Header */}
                  <div className="flex items-center justify-between border-b border-slate-200/90 bg-slate-50/80 px-4 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <FileCode2 className="h-4 w-4 text-slate-500" />
                      <span className="mono font-semibold text-slate-800">{fd.filePath}</span>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                        +{fd.added}
                      </span>
                      <span className="text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">
                        -{fd.removed}
                      </span>
                    </div>
                  </div>

                  {/* Side-by-Side Column Headers */}
                  <div className="grid grid-cols-2 border-b border-slate-100 bg-slate-100/70 text-[11px] font-semibold text-slate-500">
                    <div className="border-r border-slate-200 px-3 py-1">
                      {mode === 'checkpoint'
                        ? '기준 체크포인트 (Before)'
                        : mode === 'commit'
                        ? '이전 커밋 상태 (Before)'
                        : '원본 상태 (HEAD / Before)'}
                    </div>
                    <div className="px-3 py-1 text-emerald-800">
                      {mode === 'proposal'
                        ? 'AI 제안 패치 적용 후 (After)'
                        : '현재 작업 트리 (Working Tree / After)'}
                    </div>
                  </div>

                  {/* Side-by-Side Rows Table */}
                  <div className="mono max-h-[500px] overflow-auto text-[11.5px] leading-relaxed">
                    <table className="w-full border-collapse">
                      <tbody>
                        {fd.rows.map((row, rIdx) => {
                          if (row.type === 'hunk') {
                            return (
                              <tr key={rIdx} className="bg-blue-50/60 text-blue-700">
                                <td colSpan={2} className="px-3 py-0.5 text-center text-[10px] font-semibold border-y border-blue-100">
                                  ...
                                </td>
                              </tr>
                            );
                          }

                          const leftChange = row.left && !row.right;
                          const rightChange = row.right && !row.left;
                          const bothMod = row.left && row.right && row.type === 'change';

                          return (
                            <tr key={rIdx} className="hover:bg-slate-50/80">
                              {/* Left Cell */}
                              <td
                                className={`w-1/2 border-r border-slate-200 align-top px-2 py-0.5 select-text ${
                                  leftChange || bothMod
                                    ? 'bg-rose-50 text-rose-900'
                                    : 'text-slate-600'
                                }`}
                              >
                                <div className="flex">
                                  <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] text-slate-400 mr-2">
                                    {row.left?.no ?? ''}
                                  </span>
                                  <span className="whitespace-pre-wrap break-all flex-1">
                                    {row.left?.text ?? ''}
                                  </span>
                                </div>
                              </td>

                              {/* Right Cell */}
                              <td
                                className={`w-1/2 align-top px-2 py-0.5 select-text ${
                                  rightChange || bothMod
                                    ? 'bg-emerald-50 text-emerald-900'
                                    : 'text-slate-600'
                                }`}
                              >
                                <div className="flex">
                                  <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] text-slate-400 mr-2">
                                    {row.right?.no ?? ''}
                                  </span>
                                  <span className="whitespace-pre-wrap break-all flex-1">
                                    {row.right?.text ?? ''}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
