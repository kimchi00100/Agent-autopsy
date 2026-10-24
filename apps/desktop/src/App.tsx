import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LayoutDashboard,
  GitFork,
  History,
  GitCompare,
  Wrench,
  Settings,
  Search,
  Bell,
  FolderOpen,
  X,
  Copy,
  Check,
  FileCode2,
  Terminal,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  Cpu,
  ShieldAlert,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  FileText,
} from 'lucide-react';
import {
  api,
  Checkpoint,
  Incident,
  IncidentAnalysis,
  McpInfo,
  Overview,
  TimelineEvent,
  AgentSession,
  VerificationMode,
  HostEnvironment,
  ProjectDiagnostics,
  BackendStatus,
} from './api';
import Dashboard from './views/Dashboard';
import Timeline from './views/Timeline';
import IncidentAnalysisView from './views/IncidentAnalysisView';
import Repair from './views/Repair';
import CodeCompare from './views/CodeCompare';
import { Badge, Button, Card, CodeBlock, Empty, UnifiedDiff } from './ui';

type View = 'dashboard' | 'analysis' | 'timeline' | 'compare' | 'repair' | 'settings';

const NAV: Array<{ id: View; label: string; labelEn: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: '대시보드', labelEn: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'analysis', label: '사건 분석', labelEn: 'Incident Analysis', icon: <GitFork className="h-4 w-4" /> },
  { id: 'timeline', label: '작업 타임라인', labelEn: 'Timeline', icon: <History className="h-4 w-4" /> },
  { id: 'compare', label: '코드 비교', labelEn: 'Code Compare', icon: <GitCompare className="h-4 w-4" /> },
  { id: 'repair', label: '복구 센터', labelEn: 'Repair Center', icon: <Wrench className="h-4 w-4" /> },
  { id: 'settings', label: '프로젝트 설정', labelEn: 'Project Settings', icon: <Settings className="h-4 w-4" /> },
];

const STORAGE_KEY = 'agent-autopsy:repoPath';
export type AppTheme = 'light' | 'dark' | 'system';
export type AppLang = 'ko' | 'en';

export default function App() {
  const [view, setView] = useState<View>('analysis');
  const [repoPath, setRepoPath] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{ incident: Incident; analysis: IncidentAnalysis } | null>(null);
  const [drawer, setDrawer] = useState<TimelineEvent | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => (localStorage.getItem('agent-autopsy:theme') as AppTheme) || 'light');
  const [lang, setLang] = useState<AppLang>(() => (localStorage.getItem('agent-autopsy:lang') as AppLang) || 'ko');
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => localStorage.getItem('agent-autopsy:notifications') !== 'false'
  );
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [compareFile, setCompareFile] = useState<string | null>(null);
  const [compareCommitSha, setCompareCommitSha] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState<'working' | 'checkpoint' | 'proposal' | 'commit'>('working');
  const [verificationMode, setVerificationMode] = useState<VerificationMode>('AUTO');
  const [preferredHost, setPreferredHost] = useState<HostEnvironment>('antigravity');
  const [sensitivePaths, setSensitivePaths] = useState<string[]>([]);
  const [riskThresholdLines, setRiskThresholdLines] = useState<number>(200);
  const [newSensitivePathInput, setNewSensitivePathInput] = useState('');
  const [diagnostics, setDiagnostics] = useState<ProjectDiagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [testCommandInput, setTestCommandInput] = useState('');

  useEffect(() => {
    localStorage.setItem('agent-autopsy:theme', theme);
    const isDark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('agent-autopsy:lang', lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem('agent-autopsy:notifications', String(notificationsEnabled));
  }, [notificationsEnabled]);

  const notify = useCallback((kind: 'ok' | 'error', msg: string) => {
    if (!notificationsEnabled && kind === 'ok') return;
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 5000);
  }, [notificationsEnabled]);

  const runDiagnostics = useCallback(async (projId?: string) => {
    const id = projId || overview?.project?.id;
    if (!id) return;
    setDiagnosing(true);
    try {
      const res = await api.diagnoseProject(id);
      setDiagnostics(res.diagnostics);
      notify('ok', '프로젝트 자체 진단을 완료했습니다.');
    } catch (e: any) {
      notify('error', `진단 실패: ${e.message}`);
    } finally {
      setDiagnosing(false);
    }
  }, [overview, notify]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await api.agents();
      setAgents(res.agents || []);
    } catch {}
  }, []);

  const load = useCallback(async () => {
    loadAgents();
    if (!repoPath) return;
    try {
      const ov = await api.overview(repoPath);
      setOverview(ov);
      if (ov.project.verificationMode) {
        setVerificationMode(ov.project.verificationMode);
      }
      if (ov.project.preferredHost) {
        setPreferredHost(ov.project.preferredHost);
      }
      setSensitivePaths(ov.project.sensitivePaths || []);
      setRiskThresholdLines(ov.project.riskThresholdLines ?? 200);
      setTestCommandInput(ov.project.proposedTestCommand || ov.project.testCommand || '');
      setError(null);
      const [tl, inc, cps] = await Promise.all([
        api.timeline(ov.project.id),
        api.incidents(ov.project.id),
        api.checkpoints(ov.project.id),
      ]);
      setEvents(tl.events);
      setIncidents(inc.incidents);
      setCheckpoints(cps.checkpoints);
      setIncidentId((cur) => cur ?? inc.incidents.find((i) => i.status !== 'RESOLVED')?.id ?? inc.incidents[0]?.id ?? null);

      // Silent real-time update of project diagnostics
      if (ov.project.id) {
        api.diagnoseProject(ov.project.id).then((r) => setDiagnostics(r.diagnostics)).catch(() => {});
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, [repoPath, loadAgents]);

  // Real-time Global Search Index
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase().trim();

    const matchedIncidents = incidents.filter(
      (i) => i.title.toLowerCase().includes(q) || i.id.toLowerCase().includes(q) || (i.errorOutput && i.errorOutput.toLowerCase().includes(q))
    ).slice(0, 4);

    const allFiles = new Set<string>();
    if (overview?.health?.changedFiles) overview.health.changedFiles.forEach((f) => allFiles.add(f));
    if (overview?.health?.untrackedFiles) overview.health.untrackedFiles.forEach((f) => allFiles.add(f));
    events.forEach((e) => e.files.forEach((f) => allFiles.add(f)));
    const matchedFiles = Array.from(allFiles).filter((f) => f.toLowerCase().includes(q)).slice(0, 5);

    const matchedTimeline = events.filter(
      (e) => e.title.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q) || (e.log && e.log.toLowerCase().includes(q))
    ).slice(0, 4);

    const matchedCommits = (overview?.health?.recentCommits || []).filter(
      (c) => c.message.toLowerCase().includes(q) || c.sha.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)
    ).slice(0, 4);

    const totalCount = matchedIncidents.length + matchedFiles.length + matchedTimeline.length + matchedCommits.length;
    return {
      incidents: matchedIncidents,
      files: matchedFiles,
      timeline: matchedTimeline,
      commits: matchedCommits,
      totalCount,
    };
  }, [searchQuery, incidents, overview, events]);

  const runOnboarding = useCallback(async () => {
    if (!overview) return;
    setOnboarding(true);
    try {
      const res = await api.onboardProject(overview.project.id);
      notify('ok', res.result.message);
      await runDiagnostics(overview.project.id);
      load();
    } catch (e: any) {
      notify('error', `온보딩 실패: ${e.message}`);
    } finally {
      setOnboarding(false);
    }
  }, [overview, notify, runDiagnostics, load]);

  useEffect(() => {
    if (view === 'settings' && overview && !diagnostics) {
      runDiagnostics(overview.project.id);
    }
  }, [view, overview, diagnostics, runDiagnostics]);

  const handleUpdateSettings = async (mode: VerificationMode, host: HostEnvironment) => {
    if (!overview) return;
    try {
      setVerificationMode(mode);
      setPreferredHost(host);
      await api.updateSettings(overview.project.id, {
        verificationMode: mode,
        preferredHost: host,
      });
      const modeKorean = mode === 'AUTO' ? '자동 판단 모드' : mode === 'MAIN_ONLY' ? '메인 AI 전용 모드' : '심층 검증 우선 모드';
      notify('ok', `설정이 저장되었습니다: [${modeKorean}]`);
      load();
    } catch (err: any) {
      notify('error', err.message);
    }
  };

  const handleSaveRiskSettings = async () => {
    if (!overview) return;
    try {
      await api.updateSettings(overview.project.id, {
        sensitivePaths,
        riskThresholdLines,
      });
      notify('ok', '민감 경로 및 위험도 임계값이 저장되었습니다.');
      load();
    } catch (err: any) {
      notify('error', err.message);
    }
  };

  // Electron backend status listener
  useEffect(() => {
    if (window.autopsy?.getBackendStatus) {
      window.autopsy.getBackendStatus().then(setBackendStatus).catch(() => {});
    }
    if (window.autopsy?.onBackendStatusChange) {
      const unsub = window.autopsy.onBackendStatusChange((status) => {
        setBackendStatus(status);
        if (status.state === 'READY') {
          load();
        }
      });
      return unsub;
    }
  }, [load]);

  // Real-time SSE stream listener + periodic fallback polling (every 2.5s)
  useEffect(() => {
    load();
    const unsub = api.subscribeStream(() => {
      load();
    });
    const pollInterval = setInterval(() => {
      load();
    }, 2500);
    return () => {
      unsub();
      clearInterval(pollInterval);
    };
  }, [load]);

  useEffect(() => {
    if (!incidentId) {
      setAnalysis(null);
      return;
    }
    api.analysis(incidentId).then(setAnalysis).catch(() => setAnalysis(null));
  }, [incidentId, incidents.length]);

  async function chooseFolder() {
    let picked: string | null = null;
    if (window.autopsy) picked = await window.autopsy.selectFolder();
    else picked = window.prompt('Git 저장소 폴더 경로를 입력하세요');
    if (picked) {
      localStorage.setItem(STORAGE_KEY, picked);
      setOverview(null);
      setIncidentId(null);
      setRepoPath(picked);
    }
  }

  const activeIncident = incidents.find((i) => i.id === incidentId) || incidents[0] || null;
  const pendingCount = incidents.filter((i) => i.status !== 'RESOLVED').length;

  return (
    <div className="flex h-full bg-[#f8fafc] text-slate-800">
      {/* 1. Left Sidebar matching reference */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200/90 bg-white px-3 py-4 select-none">
        {/* App Logo */}
        <div className="mb-6 flex items-center gap-2.5 px-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white font-bold text-sm shadow-sm">
            A
          </div>
          <span className="text-sm font-bold tracking-tight text-slate-900">Agent Autopsy</span>
        </div>

        {/* Main Navigation (6 items) */}
        <nav className="space-y-1">
          {NAV.map((n) => {
            const active = view === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs font-medium transition ${
                  active
                    ? 'bg-blue-50/80 font-semibold text-blue-600'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className={active ? 'text-blue-600' : 'text-slate-400'}>{n.icon}</span>
                {lang === 'en' ? n.labelEn : n.label}
                {n.id === 'analysis' && pendingCount > 0 && (
                  <span className="ml-auto rounded-full bg-rose-50 border border-rose-200 px-1.5 text-[10px] font-semibold text-rose-600">
                    {pendingCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Connected Agents Section (4-Dimension Display) */}
        <div className="mt-6 border-t border-slate-100 pt-3 px-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {lang === 'en' ? 'Connected Agents' : '연결된 에이전트'}
            </span>
            {agents.length > 0 && (
              <span className="rounded-full bg-emerald-50 px-1.5 py-0.2 text-[9px] font-medium text-emerald-600 border border-emerald-200">
                {agents.filter((a) => a.status === 'ACTIVE').length} {lang === 'en' ? 'Active' : '활성'}
              </span>
            )}
          </div>
          {agents.length === 0 ? (
            <div className="rounded-lg border border-slate-200/60 bg-slate-50/50 p-2 text-center">
              <div className="text-[11px] text-slate-500 font-medium">
                {lang === 'en' ? 'No Agent Connected' : '연결된 에이전트 없음'}
              </div>
              <div className="text-[10px] text-slate-400 mt-0.5">
                {lang === 'en' ? 'Waiting for MCP calls' : 'MCP 호출 대기 중'}
              </div>
              <button
                onClick={() => setShowConnect(true)}
                className="mt-1.5 text-[10px] text-blue-600 hover:underline font-medium block w-full"
              >
                {lang === 'en' ? 'View MCP Guide' : '연동 가이드 보기'}
              </button>
            </div>
          ) : (
            <div className="space-y-2 text-xs">
              {agents.map((ag) => {
                const scopes = ag.observationScope && ag.observationScope.length > 0
                  ? ag.observationScope
                  : (['MCP_CALLS', 'FILE_WATCH'] as const);
                const timeStr = (() => {
                  try {
                    return new Date(ag.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  } catch {
                    return '';
                  }
                })();

                return (
                  <div
                    key={ag.agentName}
                    className="rounded-lg border border-slate-200/80 bg-white p-2 shadow-xs transition hover:border-slate-300"
                  >
                    {/* Dimension 1: Agent Name & Version / Client */}
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-semibold text-slate-800 text-[11px] truncate">{ag.agentName}</span>
                        <span className="rounded bg-slate-100 px-1 py-0.2 text-[9px] font-mono text-slate-500 shrink-0">
                          {ag.version || 'v1.0'}
                        </span>
                      </div>

                      {/* Dimension 2: Status */}
                      <span
                        className={`flex items-center gap-1 text-[10px] font-semibold shrink-0 ${
                          ag.status === 'ACTIVE' ? 'text-emerald-600' : 'text-slate-400'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            ag.status === 'ACTIVE' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'
                          }`}
                        />
                        {ag.status === 'ACTIVE' ? (lang === 'en' ? 'Active' : '활성') : (lang === 'en' ? 'Idle' : '유휴')}
                      </span>
                    </div>

                    {/* Dimension 3: Last Action & Timestamp */}
                    <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-500">
                      <span className="truncate max-w-[110px]" title={ag.lastAction}>
                        {ag.lastAction}
                      </span>
                      {timeStr && <span className="font-mono text-[9px] text-slate-400 shrink-0">{timeStr}</span>}
                    </div>

                    {/* Dimension 4: Observation Scope Badges */}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {scopes.map((sc) => {
                        let label = lang === 'en' ? 'MCP Calls' : 'MCP 호출';
                        let style = 'bg-blue-50 text-blue-600 border-blue-200';
                        if (sc === 'FILE_WATCH') {
                          label = lang === 'en' ? 'File Watch' : '파일 감시';
                          style = 'bg-indigo-50 text-indigo-600 border-indigo-200';
                        } else if (sc === 'EXEC_EVENTS') {
                          label = lang === 'en' ? 'Exec Events' : '실행 이벤트';
                          style = 'bg-emerald-50 text-emerald-600 border-emerald-200';
                        }
                        return (
                          <span
                            key={sc}
                            className={`rounded border px-1 py-0.2 text-[8px] font-medium leading-none ${style}`}
                          >
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* MCP Server Status Card at Bottom */}
        <div className="mt-auto border-t border-slate-100 pt-3 px-1">
          <div
            onClick={() => setShowConnect(true)}
            className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50/60 p-2.5 transition hover:bg-slate-100/60 shadow-sm"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-800">{lang === 'en' ? 'Local MCP' : '로컬 MCP'}</span>
              <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {lang === 'en' ? 'Running' : '실행 중'}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
              <span>v0.1.0</span>
              <span className="text-blue-600 hover:underline">{lang === 'en' ? 'Configure >' : '설정 보기 >'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* 2. Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top Header Bar matching reference */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/90 bg-white px-6">
          {/* Breadcrumb Navigation */}
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
            <span className="text-slate-800 font-semibold">
              {overview?.project.name || (lang === 'en' ? 'Project' : '프로젝트')}
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            <span>incidents</span>
            {activeIncident && (
              <>
                <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-blue-600 font-semibold">#{activeIncident.id.slice(-6).toUpperCase()}</span>
              </>
            )}
          </div>

          {/* Center Search Input with Real-time Category Popover */}
          <div className="relative w-80">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={lang === 'en' ? 'Search files, functions, errors, commits...' : '파일, 함수, 에러, 커밋 검색...'}
              value={searchQuery}
              onFocus={() => setSearchFocused(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchFocused(true);
              }}
              className="w-full rounded-lg border border-slate-200 bg-slate-50/70 py-1.5 pl-8 pr-7 text-xs text-slate-800 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSearchFocused(false);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 rounded"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}

            {/* Dropdown Popover */}
            {searchFocused && searchResults && (
              <div
                className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-xl border border-slate-200 bg-white p-2.5 shadow-2xl fade-in max-h-[380px] overflow-y-auto"
                onMouseDown={(e) => e.preventDefault()}
              >
                {searchResults.totalCount === 0 ? (
                  <div className="py-4 text-center text-xs text-slate-400">
                    '{searchQuery}' {lang === 'en' ? 'no matches found.' : '검색 결과가 없습니다.'}
                  </div>
                ) : (
                  <div className="space-y-2 text-xs">
                    {/* 1. Incidents */}
                    {searchResults.incidents.length > 0 && (
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 mb-1">
                          {lang === 'en' ? 'Incidents' : '사건 (Incidents)'}
                        </div>
                        {searchResults.incidents.map((inc: Incident) => (
                          <div
                            key={inc.id}
                            onClick={() => {
                              setIncidentId(inc.id);
                              setView('analysis');
                              setSearchFocused(false);
                            }}
                            className="cursor-pointer rounded-lg px-2 py-1.5 hover:bg-slate-50 flex items-center justify-between transition"
                          >
                            <span className="font-semibold text-slate-800 truncate mr-2">
                              #{inc.id.slice(-6)}: {inc.title}
                            </span>
                            <Badge tone={inc.status === 'RESOLVED' ? 'green' : 'blue'}>
                              {inc.status === 'RESOLVED' ? '해결됨' : '분석 중'}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 2. Files */}
                    {searchResults.files.length > 0 && (
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 mb-1">
                          {lang === 'en' ? 'Files' : '파일 (Files)'}
                        </div>
                        {searchResults.files.map((file: string) => (
                          <div
                            key={file}
                            onClick={() => {
                              setCompareFile(file);
                              setCompareMode('working');
                              setView('compare');
                              setSearchFocused(false);
                            }}
                            className="cursor-pointer rounded-lg px-2 py-1.5 hover:bg-slate-50 flex items-center gap-1.5 transition text-blue-600 font-mono text-[11px]"
                          >
                            <FileCode2 className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                            <span className="truncate">{file}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 3. Commits */}
                    {searchResults.commits.length > 0 && (
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 mb-1">
                          {lang === 'en' ? 'Commits' : '최근 커밋 (Commits)'}
                        </div>
                        {searchResults.commits.map((c: { sha: string; message: string; author: string; date: string }) => (
                          <div
                            key={c.sha}
                            onClick={() => {
                              setCompareCommitSha(c.sha);
                              setCompareMode('commit');
                              setView('compare');
                              setSearchFocused(false);
                            }}
                            className="cursor-pointer rounded-lg px-2 py-1.5 hover:bg-slate-50 flex items-center justify-between transition text-slate-700"
                          >
                            <span className="truncate mr-2 text-[11px]">{c.message}</span>
                            <span className="font-mono text-[10px] text-slate-400 shrink-0">{c.sha.slice(0, 7)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 4. Timeline */}
                    {searchResults.timeline.length > 0 && (
                      <div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1 mb-1">
                          {lang === 'en' ? 'Timeline Events' : '타임라인 기록'}
                        </div>
                        {searchResults.timeline.map((ev: TimelineEvent) => (
                          <div
                            key={ev.id}
                            onClick={() => {
                              setDrawer(ev);
                              setSearchFocused(false);
                            }}
                            className="cursor-pointer rounded-lg px-2 py-1.5 hover:bg-slate-50 flex items-center justify-between transition"
                          >
                            <span className="truncate text-slate-800 mr-2 text-[11px]">{ev.title}</span>
                            <Badge tone="blue">{ev.actor}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right Action Icons */}
          <div className="flex items-center gap-2.5">
            {overview && (
              <button
                onClick={() => setView('settings')}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold border transition ${
                  verificationMode === 'AUTO'
                    ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                    : verificationMode === 'MAIN_ONLY'
                    ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                    : 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100'
                }`}
                title={lang === 'en' ? 'Change AI Verification Mode' : '클릭하여 AI 검증 모드 설정 변경'}
              >
                <Sparkles className="h-3 w-3" />
                {verificationMode === 'AUTO'
                  ? lang === 'en'
                    ? 'Auto Mode'
                    : '자동 판단 모드'
                  : verificationMode === 'MAIN_ONLY'
                  ? lang === 'en'
                    ? 'Main AI Only'
                    : '메인 AI 전용 모드'
                  : lang === 'en'
                  ? 'Deep Review Priority'
                  : '심층 검증 우선'}
              </button>
            )}
            <Button variant="default" onClick={chooseFolder}>
              <FolderOpen className="h-3.5 w-3.5" />
              {lang === 'en' ? 'Select Folder' : '폴더 선택'}
            </Button>
            <button
              onClick={() => setShowAppSettings(true)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition"
              title={lang === 'en' ? 'App Settings' : '환경 설정'}
            >
              <Settings className="h-4 w-4" />
            </button>
            <div className="h-6 w-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center">
              U
            </div>
          </div>
        </header>

        {/* Backend Process Status Banner */}
        {backendStatus?.state === 'ERROR' && (
          <div className="bg-rose-50 border-b border-rose-200 px-7 py-3 text-xs text-rose-800 flex items-start justify-between">
            <div>
              <div className="font-semibold flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4 text-rose-600" />
                백엔드 프로세스 오류: {backendStatus.error}
              </div>
              {backendStatus.recoveryGuide && (
                <div className="text-slate-600 mt-1 pl-5.5 text-[11px]">{backendStatus.recoveryGuide}</div>
              )}
            </div>
            <Button className="px-2.5 py-1 text-xs" onClick={() => window.location.reload()}>새로고침</Button>
          </div>
        )}

        {overview && !overview.project.testCommandSignature && view !== 'settings' && (
          <div className="bg-amber-50 border-b border-amber-200 px-7 py-2.5 text-xs text-amber-900 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <span>
                <strong>테스트 명령 미확정:</strong> 프로젝트 검증 테스트 명령이 서명되지 않았습니다. 격리 검증을 위해 사용자의 확인이 필요합니다.
                {overview.project.proposedTestCommand && (
                  <span className="ml-2 text-indigo-700 font-medium">
                    (AI 제안: <code>{overview.project.proposedTestCommand}</code>)
                  </span>
                )}
              </span>
            </div>
            <Button
              className="px-2.5 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white border-none"
              onClick={() => setView('settings')}
            >
              설정에서 확인하기
            </Button>
          </div>
        )}

        {/* View Workspace */}
        <main className="flex-1 overflow-y-auto px-7 py-5">
          {!repoPath && (
            <div className="mx-auto mt-20 max-w-md text-center">
              <div className="text-base font-semibold text-slate-900">시작하려면 프로젝트 폴더를 선택하세요</div>
              <p className="mt-1 text-xs text-slate-500">
                Git 저장소 폴더를 선택하면 사고 분석과 격리 검증을 시작할 수 있습니다.
              </p>
              <div className="mt-5 flex justify-center">
                <Button variant="primary" onClick={chooseFolder}>
                  <FolderOpen className="h-4 w-4" />
                  프로젝트 폴더 선택
                </Button>
              </div>
            </div>
          )}

          {repoPath && error && !overview && (
            <div className="mx-auto mt-20 max-w-lg rounded-xl border border-rose-200 bg-rose-50/60 p-5 text-xs">
              <div className="font-semibold text-rose-800">프로젝트를 불러오지 못했습니다</div>
              <p className="mt-1 text-slate-600">{error}</p>
              <div className="mt-3">
                <Button onClick={chooseFolder}>다른 폴더 선택</Button>
              </div>
            </div>
          )}

          {overview && view === 'analysis' && activeIncident && (
            <IncidentAnalysisView
              incident={activeIncident}
              analysis={analysis?.analysis || null}
              repoPath={repoPath}
              onOpenRepairCenter={() => setView('repair')}
              onChanged={load}
              notify={notify}
            />
          )}

          {overview && view === 'analysis' && !activeIncident && (
            <Card className="p-12 text-center">
              <Empty
                title={lang === 'en' ? 'No Active Incidents' : '등록된 사건이 없습니다'}
                desc={
                  lang === 'en'
                    ? 'Incidents will automatically appear here when errors are captured or reported by agents.'
                    : '에이전트에 의해 오류나 오작동 사건이 수집되면 이곳에 원인 분석 트리와 함께 표시됩니다.'
                }
              />
            </Card>
          )}

          {overview && view === 'dashboard' && (
            <Dashboard overview={overview} onOpenIncident={(id) => { setIncidentId(id); setView('analysis'); }} />
          )}

          {overview && view === 'timeline' && (
            <Timeline events={events} selectedId={drawer?.id ?? null} onSelect={setDrawer} searchQuery={searchQuery} />
          )}

          {overview && view === 'compare' && (
            <CodeCompare
              repoPath={repoPath}
              checkpoints={checkpoints}
              incidents={incidents}
              initialMode={compareMode}
              initialFile={compareFile}
              initialCommitSha={compareCommitSha}
              onOpenRepair={() => setView('repair')}
              lang={lang}
            />
          )}

          {overview && view === 'repair' && (
            <Repair
              incidents={incidents}
              incidentId={incidentId}
              onPick={setIncidentId}
              repoPath={repoPath}
              checkpoints={checkpoints}
              onChanged={load}
              notify={notify}
              onOpenCompare={(pId) => {
                setCompareMode('proposal');
                setView('compare');
              }}
            />
          )}

          {overview && view === 'settings' && (
            <div className="fade-in max-w-3xl space-y-6">
              <div>
                <div className="text-lg font-bold text-slate-900">시스템 제어 및 AI 오케스트레이션 설정</div>
                <p className="mt-1 text-xs text-slate-500">
                  Agent Autopsy는 메인 코딩 AI가 개발을 주도하고, 작업 난이도 및 위험도에 따라 AI 오케스트레이션 검증을 지능적으로 가동합니다.
                </p>
              </div>

              {/* 1. AI 검증 실행 방식 (3가지 모드) */}
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-blue-600" />
                    <span className="text-sm font-bold text-slate-900">AI 검증 실행 방식</span>
                  </div>
                  <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700 border border-blue-200">
                    현재 모드: {verificationMode === 'AUTO' ? '자동 판단 모드' : verificationMode === 'MAIN_ONLY' ? '메인 AI 전용 모드' : '심층 검증 우선 모드'}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {/* Mode 1: AUTO */}
                  <div
                    onClick={() => handleUpdateSettings('AUTO', preferredHost)}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      verificationMode === 'AUTO'
                        ? 'border-blue-600 bg-blue-50/40 shadow-sm ring-1 ring-blue-600'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-900">자동 판단 모드</span>
                      {verificationMode === 'AUTO' && <Check className="h-4 w-4 text-blue-600" />}
                    </div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      메인 AI가 작업별 난이도·위험도를 객관적 신호(보안 경로, 변경 범위, 원인 불확실성 등)로 분석해 <strong>필요한 경우에만 AI 오케스트레이션을 가동</strong>합니다.
                    </p>
                    <div className="mt-3 rounded bg-blue-100/60 px-2 py-1 text-[10px] text-blue-800 font-medium">
                      추천: 불필요한 모델 호출을 줄이고 안전성 확보
                    </div>
                  </div>

                  {/* Mode 2: MAIN_ONLY */}
                  <div
                    onClick={() => handleUpdateSettings('MAIN_ONLY', preferredHost)}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      verificationMode === 'MAIN_ONLY'
                        ? 'border-amber-600 bg-amber-50/40 shadow-sm ring-1 ring-amber-600'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-900">메인 AI 전용 모드</span>
                      {verificationMode === 'MAIN_ONLY' && <Check className="h-4 w-4 text-amber-600" />}
                    </div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      추가 AI 오케스트레이션은 일절 호출하지 않고 <strong>메인 AI 단독으로 빠르게 처리</strong>합니다. 기본 격리 테스트만 수행하며, 중요한 검증 생략 시 경고를 안내합니다.
                    </p>
                    <div className="mt-3 rounded bg-amber-100/60 px-2 py-1 text-[10px] text-amber-800 font-medium">
                      단독 실행: 토큰 비용 절약 및 빠른 반복
                    </div>
                  </div>

                  {/* Mode 3: DEEP_PRIORITY */}
                  <div
                    onClick={() => handleUpdateSettings('DEEP_PRIORITY', preferredHost)}
                    className={`cursor-pointer rounded-xl border p-4 transition ${
                      verificationMode === 'DEEP_PRIORITY'
                        ? 'border-purple-600 bg-purple-50/40 shadow-sm ring-1 ring-purple-600'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-900">심층 검증 우선 모드</span>
                      {verificationMode === 'DEEP_PRIORITY' && <Check className="h-4 w-4 text-purple-600" />}
                    </div>
                    <p className="text-[11px] text-slate-600 leading-relaxed">
                      작업마다 가능한 범위에서 <strong>독립 서브에이전트 교차 검증을 강력하게 요구</strong>합니다. 고난도 리팩토링이나 프로덕션 배포 전 필수 모드입니다.
                    </p>
                    <div className="mt-3 rounded bg-purple-100/60 px-2 py-1 text-[10px] text-purple-800 font-medium">
                      최고 보안: 모든 수정안에 독립 서브에이전트 검토
                    </div>
                  </div>
                </div>
              </Card>

              {/* 2. 메인 AI 환경 및 모델 선택 (Single Host Environment) */}
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-indigo-600" />
                    <span className="text-sm font-bold text-slate-900">메인 AI 호스트 환경 및 모델 선택</span>
                  </div>
                  <span className="text-xs text-slate-400">단일 환경 선택 (서브에이전트 네이티브 상속)</span>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  {[
                    { id: 'antigravity', name: 'Google Antigravity', model: 'Gemini 2.5 / 3.8', note: 'Deepmind 네이티브 서브에이전트 상속 (추가 키 불필요)' },
                    { id: 'claude-code', name: 'Claude Code', model: 'Claude 3.7 / Opus', note: 'Anthropic 호스트 네이티브 환경' },
                    { id: 'codex', name: 'Codex CLI', model: 'GPT-5 / 6.1 Sol', note: 'OpenAI 호스트 네이티브 환경' },
                  ].map((env) => (
                    <div
                      key={env.id}
                      onClick={() => handleUpdateSettings(verificationMode, env.id as HostEnvironment)}
                      className={`cursor-pointer rounded-xl border p-4 transition ${
                        preferredHost === env.id
                          ? 'border-indigo-600 bg-indigo-50/40 shadow-sm ring-1 ring-indigo-600'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-slate-900">{env.name}</span>
                        {preferredHost === env.id && <Check className="h-4 w-4 text-indigo-600" />}
                      </div>
                      <div className="mono text-xs font-semibold text-indigo-600 mb-1">{env.model}</div>
                      <p className="text-[10.5px] text-slate-500 leading-normal">{env.note}</p>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-3 text-[11px] text-slate-600 leading-relaxed">
                  💡 <strong>단일 메인 모델 아키텍처:</strong> 사용자가 선택한 호스트 환경의 메인 AI가 문제를 개발하고, 내부 오케스트레이션 검증 시에도 동일 호스트의 네이티브 서브에이전트(<code>Model=&apos;inherit&apos;</code>)를 활용하여 별도의 추가 API 키 설정 없이도 완벽한 독립 검증을 수행합니다.
                </div>
              </Card>

              {/* 3. 프로젝트 환경 자체 진단 및 원클릭 온보딩 */}
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-900">프로젝트 환경 자체 진단 및 거버넌스 온보딩</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {diagnostics && (
                      <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold border ${
                        diagnostics.healthy
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-rose-50 text-rose-700 border-rose-200'
                      }`}>
                        {diagnostics.healthy ? '진단 상태: 정상' : '진단 상태: 조치 필요'}
                      </span>
                    )}
                    <Button variant="default" className="text-xs px-2.5 py-1" onClick={() => runDiagnostics(overview.project.id)} disabled={diagnosing}>
                      <RefreshCw className={`h-3.5 w-3.5 mr-1 ${diagnosing ? 'animate-spin' : ''}`} />
                      {diagnosing ? '진단 중...' : '자체 진단 실행'}
                    </Button>
                  </div>
                </div>

                {diagnostics ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {diagnostics.items.map((item) => (
                        <div
                          key={item.key}
                          className={`rounded-lg border p-3 text-xs space-y-1 ${
                            item.status === 'PASS'
                              ? 'border-emerald-200/80 bg-emerald-50/30 text-emerald-900'
                              : item.status === 'WARN'
                              ? 'border-amber-200 bg-amber-50/40 text-amber-900'
                              : 'border-rose-200 bg-rose-50/40 text-rose-900'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold flex items-center gap-1.5">
                              {item.status === 'PASS' ? (
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                              ) : item.status === 'WARN' ? (
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5 text-rose-600" />
                              )}
                              {item.label}
                            </span>
                            <span className="font-semibold text-[10px] uppercase">{item.status}</span>
                          </div>
                          <p className="text-[11px] leading-relaxed opacity-90">{item.message}</p>
                          {item.actionRequired && (
                            <div className="text-[10px] font-semibold text-rose-600 mt-1">
                              필요 조치: {item.actionRequired}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* 1-Click Onboarding Highlight Banner if AGENTS.md or .gitignore missing */}
                    {(!diagnostics.hasAgentsMd || !diagnostics.hasAutopsyIgnore) && (
                      <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <div className="text-xs font-bold text-emerald-950 flex items-center gap-1.5">
                              <FileText className="h-4 w-4 text-emerald-600" />
                              표준 AI 거버넌스 규칙(AGENTS.md) 온보딩 안내
                            </div>
                            <p className="text-[11px] text-emerald-800">
                              기존 프로젝트 설정을 덮어쓰지 않고, 필요한 Agent Autopsy 수칙만 안전하게 병합합니다.
                            </p>
                          </div>
                          <Button
                            variant="primary"
                            onClick={runOnboarding}
                            disabled={onboarding}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white shrink-0 ml-4"
                          >
                            {onboarding ? '온보딩 배포 중...' : '온보딩 승인 및 적용'}
                          </Button>
                        </div>

                        {/* Onboarding Preview Diff & Action Notes */}
                        {diagnostics.onboardingPreview && (
                          <div className="rounded-lg border border-emerald-200 bg-white/90 p-2.5 text-xs space-y-2">
                            <div className="font-semibold text-slate-800 text-[11px] flex items-center gap-1.5">
                              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                              변경 미리보기 (기존 커스텀 규칙 무손실 보존)
                            </div>
                            {diagnostics.onboardingPreview.conflictNotes && (
                              <div className="text-[11px] text-amber-700 bg-amber-50 rounded px-2 py-1 border border-amber-200">
                                ℹ️ {diagnostics.onboardingPreview.conflictNotes.join(' ')}
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-2 text-[11px]">
                              <div className="p-2 bg-slate-50 rounded border border-slate-200">
                                <div className="font-semibold text-slate-700 mb-1">
                                  AGENTS.md: <span className="text-blue-600 font-mono">[{diagnostics.onboardingPreview.agentsMdAction}]</span>
                                </div>
                                <pre className="text-[10px] text-slate-600 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono">
                                  {diagnostics.onboardingPreview.agentsMdDiffPreview.slice(0, 300)}...
                                </pre>
                              </div>
                              <div className="p-2 bg-slate-50 rounded border border-slate-200">
                                <div className="font-semibold text-slate-700 mb-1">
                                  .gitignore: <span className="text-blue-600 font-mono">[{diagnostics.onboardingPreview.gitignoreAction}]</span>
                                </div>
                                <pre className="text-[10px] text-slate-600 max-h-24 overflow-y-auto whitespace-pre-wrap font-mono">
                                  {diagnostics.onboardingPreview.gitignoreDiffPreview}
                                </pre>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Discovered Safe Commands */}
                    {diagnostics.discoveredCommands && (
                      <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-3 text-xs space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-800">
                            탐색된 프로젝트 명령 ({diagnostics.discoveredCommands.projectType.toUpperCase()})
                          </span>
                          <span className={`text-[10px] font-bold ${diagnostics.discoveredCommands.isCommandSafe ? 'text-emerald-600' : 'text-rose-600'}`}>
                            {diagnostics.discoveredCommands.isCommandSafe ? '안전 검증 완료' : '위험 명령 주의'}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div>기본 회귀 테스트: <code className="mono bg-white px-1.5 py-0.5 rounded border border-slate-200">{diagnostics.discoveredCommands.fullRegressionCmd || '-'}</code></div>
                          <div>구문 검사 도구: <code className="mono bg-white px-1.5 py-0.5 rounded border border-slate-200">{diagnostics.discoveredCommands.codeCheckCmd || '기본 인터프리터'}</code></div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-6 text-slate-400 text-xs">
                    프로젝트 자체 진단을 실행하여 Git 상태, AGENTS.md 지침서, 샌드박스 권한을 확인하세요.
                  </div>
                )}
              </Card>

              {/* 3.5 테스트 명령 확정 및 전자서명 게이트 */}
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4 text-emerald-600" />
                    <span className="text-sm font-bold text-slate-900">검증 테스트 명령 관리 및 전자서명</span>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold border ${
                      overview.project.testCommandSignature
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}
                  >
                    {overview.project.testCommandSignature ? '확정됨 (서명 완료)' : '미확정 (확인 필요)'}
                  </span>
                </div>

                {/* AI 제안 대기 배너 */}
                {overview.project.proposedTestCommand && (
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-indigo-600" />
                        <span className="text-xs font-bold text-indigo-950">AI 에이전트의 테스트 명령 제안</span>
                      </div>
                      <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-200">
                        확인 대기 중
                      </span>
                    </div>
                    <div className="text-xs text-indigo-900">
                      제안 명령: <code className="mono bg-white px-2 py-0.5 rounded border border-indigo-200 font-semibold">{overview.project.proposedTestCommand}</code>
                    </div>
                    {overview.project.proposedTestCommandReason && (
                      <div className="text-[11px] text-indigo-700">
                        제안 사유: {overview.project.proposedTestCommandReason}
                      </div>
                    )}
                    <div className="pt-2 flex gap-2">
                      <Button
                        variant="primary"
                        className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white"
                        onClick={async () => {
                          await api.confirmTestCommand(overview.project.id, overview.project.proposedTestCommand);
                          notify('ok', `AI가 제안한 테스트 명령 "${overview.project.proposedTestCommand}"이(가) 확정되었습니다.`);
                          load();
                        }}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" />
                        이 제안으로 확정 및 서명
                      </Button>
                    </div>
                  </div>
                )}

                {/* 현재 테스트 명령 확인 및 수정 */}
                <div className="space-y-3">
                  <div className="text-xs text-slate-600 leading-relaxed">
                    Agent Autopsy는 AI 에이전트의 임의 명령 조작을 방지하기 위해 사용자가 확인하고 서명한 테스트 명령으로만 격리 검증을 수행합니다.
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      className="mono flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs bg-slate-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      value={testCommandInput}
                      onChange={(e) => setTestCommandInput(e.target.value)}
                      placeholder="테스트 명령을 입력하세요 (예: npm test, pytest, go test ./...)"
                    />
                    <Button
                      variant="primary"
                      className="text-xs shrink-0"
                      onClick={async () => {
                        await api.confirmTestCommand(overview.project.id, testCommandInput);
                        notify('ok', `테스트 명령 "${testCommandInput}"이(가) 확정 및 서명되었습니다.`);
                        load();
                      }}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" />
                      확인 및 서명
                    </Button>
                  </div>

                  {overview.project.testCommandSignature ? (
                    <div className="text-[11px] text-emerald-700 flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      <span>현재 명령: <code>{overview.project.testCommand}</code> (HMAC 전자서명 유효)</span>
                    </div>
                  ) : (
                    <div className="text-[11px] text-amber-700 flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                      <span>테스트 명령이 아직 확정되지 않았습니다. [확인 및 서명] 버튼을 눌러 승인하세요.</span>
                    </div>
                  )}
                </div>
              </Card>

              {/* 4. 민감 경로 및 위험도 임계값 설정 */}
              <Card className="p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-bold text-slate-900">민감 경로 및 위험도 임계값 설정</span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    패치가 실제로 변경하는 파일과 줄 수로 위험도를 정밀 판정합니다.
                  </span>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-700">사용자 지정 민감 경로 (Glob 패턴 목록)</label>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      이 경로에 해당하는 파일이 단 1줄이라도 수정되면 수정 위험도가 즉시 '고위험(HIGH)'으로 승격되어 독립 교차 검토가 요구됩니다.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5 min-h-[32px] p-2 rounded-lg border border-slate-200 bg-slate-50/50">
                      {sensitivePaths.length === 0 && (
                        <span className="text-xs text-slate-400 italic">등록된 민감 경로가 없습니다. (기본값: 빈 목록)</span>
                      )}
                      {sensitivePaths.map((p, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-mono text-amber-800 border border-amber-200"
                        >
                          {p}
                          <button
                            type="button"
                            onClick={() => setSensitivePaths((cur) => cur.filter((_, i) => i !== idx))}
                            className="text-amber-600 hover:text-rose-600 ml-1 font-bold"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={newSensitivePathInput}
                        onChange={(e) => setNewSensitivePathInput(e.target.value)}
                        placeholder="예: src/auth/**, *.env, config/*"
                        className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:border-blue-500"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newSensitivePathInput.trim()) {
                            e.preventDefault();
                            if (!sensitivePaths.includes(newSensitivePathInput.trim())) {
                              setSensitivePaths((cur) => [...cur, newSensitivePathInput.trim()]);
                            }
                            setNewSensitivePathInput('');
                          }
                        }}
                      />
                      <Button
                        variant="default"
                        onClick={() => {
                          if (newSensitivePathInput.trim() && !sensitivePaths.includes(newSensitivePathInput.trim())) {
                            setSensitivePaths((cur) => [...cur, newSensitivePathInput.trim()]);
                            setNewSensitivePathInput('');
                          }
                        }}
                      >
                        경로 추가
                      </Button>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                    <div>
                      <label className="text-xs font-semibold text-slate-700">고위험 변경 줄 수 임계값</label>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        수정안의 총 변경 줄 수(추가+삭제)가 이 기준 이상이면 '높음', 절반 이상이면 '중간' 위험도로 판정됩니다.
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="10"
                        max="5000"
                        step="10"
                        value={riskThresholdLines}
                        onChange={(e) => setRiskThresholdLines(Number(e.target.value) || 200)}
                        className="w-24 text-right rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 font-mono"
                      />
                      <span className="text-xs text-slate-500 font-medium">줄</span>
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <Button variant="primary" onClick={handleSaveRiskSettings}>
                      민감 경로 및 임계값 저장
                    </Button>
                  </div>
                </div>
              </Card>

              {/* 5. 현재 프로젝트 정보 및 MCP 연결 */}
              <Card className="p-5 space-y-3">
                <div className="text-xs font-semibold text-slate-500">현재 프로젝트 저장소 정보</div>
                <div className="text-xs">
                  <span className="font-semibold text-slate-900">{overview.project.name}</span>
                  <div className="mono text-[11px] text-slate-400 mt-0.5">{overview.project.rootPath}</div>
                </div>
                <div className="pt-3 border-t border-slate-100 flex gap-2">
                  <Button variant="default" onClick={chooseFolder}>다른 프로젝트 선택</Button>
                  <Button variant="primary" onClick={() => setShowConnect(true)}>MCP 연결 설정 열기</Button>
                </div>
              </Card>
            </div>
          )}
        </main>
      </div>

      {drawer && <Drawer event={drawer} onClose={() => setDrawer(null)} />}
      {showConnect && <ConnectDialog onClose={() => setShowConnect(false)} lang={lang} />}
      {showAppSettings && (
        <AppSettingsDialog
          onClose={() => setShowAppSettings(false)}
          theme={theme}
          setTheme={setTheme}
          lang={lang}
          setLang={setLang}
          notificationsEnabled={notificationsEnabled}
          setNotificationsEnabled={setNotificationsEnabled}
          notify={notify}
        />
      )}

      {/* Floating Notification Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border px-4 py-2.5 text-xs font-medium shadow-xl fade-in ${
            toast.kind === 'ok'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-rose-200 bg-rose-50 text-rose-900'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Drawer({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
  const tabs = [
    event.diff ? { id: 'diff', label: 'Git Diff', icon: <GitCompare className="h-3.5 w-3.5" /> } : null,
    event.log ? { id: 'log', label: '터미널/오류 로그', icon: <Terminal className="h-3.5 w-3.5" /> } : null,
    { id: 'files', label: '관련 파일', icon: <FileCode2 className="h-3.5 w-3.5" /> },
  ].filter(Boolean) as Array<{ id: string; label: string; icon: React.ReactNode }>;
  const [tab, setTab] = useState(tabs[0].id);

  useEffect(() => {
    setTab(tabs[0].id);
  }, [event.id]);

  return (
    <>
      <div className="fixed inset-0 z-20 bg-slate-900/20 backdrop-blur-xs" onClick={onClose} />
      <aside className="fixed bottom-0 right-0 top-0 z-30 flex w-[540px] max-w-[90vw] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-6 py-4">
          <div className="min-w-0">
            <Badge tone="blue">{event.actor}</Badge>
            <div className="mt-1.5 text-sm font-semibold text-slate-900">{event.title}</div>
            {event.summary && <div className="mt-0.5 text-xs text-slate-500">{event.summary}</div>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-4 border-b border-slate-100 px-6 text-xs font-medium text-slate-500">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 py-2.5 transition -mb-px ${
                tab === t.id ? 'border-blue-600 font-semibold text-blue-600' : 'border-transparent hover:text-slate-900'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'diff' && event.diff && <UnifiedDiff text={event.diff} />}
          {tab === 'log' && event.log && <CodeBlock text={event.log} maxHeight={600} />}
          {tab === 'files' && (
            <div className="space-y-2">
              {event.files.length === 0 && <div className="text-xs text-slate-400">연관된 파일이 없습니다.</div>}
              {event.files.map((f) => (
                <div key={f} className="mono rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs font-medium text-slate-700">
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function ConnectDialog({ onClose, lang = 'ko' }: { onClose: () => void; lang?: AppLang }) {
  const [info, setInfo] = useState<McpInfo>({
    command: 'node',
    args: ['<저장소 경로>\\packages\\mcp-server\\dist\\index.js'],
    env: {},
    packaged: false,
  });
  const [agent, setAgent] = useState<'antigravity' | 'codex' | 'claude'>('antigravity');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (window.autopsy) {
      window.autopsy.getMcpInfo().then((res) => {
        if (res) setInfo(res);
      });
    }
  }, []);

  const snippets = {
    antigravity: {
      where:
        lang === 'en'
          ? 'Add to Antigravity Settings → MCP Servers → "Raw Config" (mcp_config.json):'
          : 'Antigravity 설정 → MCP 서버 → "Raw 설정 보기"(mcp_config.json)에 추가하세요.',
      text: JSON.stringify(
        { mcpServers: { 'agent-autopsy': { command: info.command, args: info.args, ...(Object.keys(info.env).length ? { env: info.env } : {}) } } },
        null,
        2
      ),
    },
    codex: {
      where:
        lang === 'en'
          ? 'Add to %USERPROFILE%\\.codex\\config.toml:'
          : '%USERPROFILE%\\.codex\\config.toml 에 추가하세요.',
      text:
        `[mcp_servers.agent-autopsy]\ncommand = '${info.command}'\nargs = [${info.args.map((a) => `'${a}'`).join(', ')}]` +
        (Object.keys(info.env).length
          ? `\n\n[mcp_servers.agent-autopsy.env]\n${Object.entries(info.env).map(([k, v]) => `${k} = '${v}'`).join('\n')}`
          : ''),
    },
    claude: {
      where:
        lang === 'en'
          ? 'Run the following command once in your terminal:'
          : '터미널에서 아래 명령을 한 번 실행하세요.',
      text: `claude mcp add agent-autopsy ${Object.entries(info.env).map(([k, v]) => `-e ${k}=${v} `).join('')}-- "${info.command}" ${info.args.map((a) => `"${a}"`).join(' ')}`,
    },
  }[agent];

  async function copy() {
    await navigator.clipboard.writeText(snippets.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-xs fade-in"
      onClick={onClose}
    >
      {/* Fixed 600px x 412px modal size locked to Antigravity baseline so switching tabs never changes dimensions */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[412px] w-[600px] shrink-0 flex-col justify-between rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-base font-bold text-slate-900">
                {lang === 'en' ? 'Connect Coding Agent (MCP)' : '코딩 에이전트 연결 (MCP)'}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {lang === 'en'
                  ? 'Select your coding agent and copy the configuration snippet below.'
                  : '사용 중인 에이전트를 선택하고 설정을 복사해 붙여 넣으면 연결됩니다.'}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            {([['antigravity', 'Antigravity'], ['codex', 'Codex'], ['claude', 'Claude Code']] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setAgent(id)}
                className={`rounded-full px-3.5 py-1 text-xs font-medium transition ${
                  agent === id ? 'bg-blue-600 text-white shadow-sm' : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 h-5 truncate text-xs font-medium text-slate-600">{snippets.where}</div>
          <div className="mt-2">
            <CodeBlock text={snippets.text} fixedHeight={195} />
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">
          <span className="text-[11px] text-slate-400">
            {lang === 'en'
              ? 'Restart your coding agent after applying the configuration.'
              : '설정을 적용한 뒤 에이전트를 재시작하면 도구가 활성화됩니다.'}
          </span>
          <Button variant="primary" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? (lang === 'en' ? 'Copied' : '복사됨') : lang === 'en' ? 'Copy Config' : '설정 복사'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppSettingsDialog({
  onClose,
  theme,
  setTheme,
  lang,
  setLang,
  notificationsEnabled,
  setNotificationsEnabled,
  notify,
}: {
  onClose: () => void;
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
  lang: AppLang;
  setLang: (l: AppLang) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  notify: (kind: 'ok' | 'error', msg: string) => void;
}) {
  const handleResetCache = () => {
    const msg =
      lang === 'en'
        ? 'Reset local UI cache and preferences? (Project files and incident history in SQLite will remain safe.)'
        : '로컬 UI 캐시 및 환경 설정을 초기화할까요? (원본 프로젝트 파일과 사건 기록 DB는 안전하게 유지됩니다.)';
    if (!window.confirm(msg)) return;
    localStorage.clear();
    window.location.reload();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-xs fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[520px] shrink-0 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-slate-100 pb-4">
          <div>
            <div className="text-base font-bold text-slate-900">
              {lang === 'en' ? 'Application Settings' : '앱 환경 설정'}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {lang === 'en'
                ? 'Customize theme appearance, display language, and notification preferences.'
                : '테마 외관, 표시 언어, 알림 토스트 및 로컬 캐시를 관리합니다.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-5 text-xs">
          {/* 1. Theme Selection */}
          <div>
            <div className="font-semibold text-slate-800 mb-2">
              {lang === 'en' ? 'Theme Appearance' : '화면 테마 설정'}
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {(
                [
                  ['light', lang === 'en' ? 'Light Mode' : '라이트 모드', lang === 'en' ? 'Clean bright UI' : '밝고 선명한 기본 화면'],
                  ['dark', lang === 'en' ? 'Dark Mode' : '다크 모드', lang === 'en' ? 'Low-glare dark UI' : '눈이 편안한 어두운 화면'],
                  ['system', lang === 'en' ? 'System Sync' : '시스템 연동', lang === 'en' ? 'Follow OS setting' : 'Windows 테마 자동 동기화'],
                ] as const
              ).map(([id, title, desc]) => (
                <button
                  key={id}
                  onClick={() => {
                    setTheme(id);
                    notify('ok', lang === 'en' ? `Theme changed to ${title}` : `테마가 '${title}'로 변경되었습니다.`);
                  }}
                  className={`rounded-xl border p-3 text-left transition ${
                    theme === id
                      ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                  }`}
                >
                  <div className="font-bold text-slate-900 flex items-center justify-between">
                    <span>{title}</span>
                    {theme === id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Language Selection */}
          <div>
            <div className="font-semibold text-slate-800 mb-2">
              {lang === 'en' ? 'Display Language' : '표시 언어 (Language)'}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  ['ko', '한국어 (Korean)', '인터페이스 및 메뉴를 한국어로 표시'],
                  ['en', 'English (US)', 'Display navigation and menus in English'],
                ] as const
              ).map(([id, title, desc]) => (
                <button
                  key={id}
                  onClick={() => {
                    setLang(id);
                    notify('ok', id === 'en' ? 'Language switched to English.' : '언어가 한국어로 변경되었습니다.');
                  }}
                  className={`rounded-xl border p-3 text-left transition ${
                    lang === id
                      ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                  }`}
                >
                  <div className="font-bold text-slate-900 flex items-center justify-between">
                    <span>{title}</span>
                    {lang === id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 3. Notification Toast Toggle */}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div>
              <div className="font-semibold text-slate-800">
                {lang === 'en' ? 'Status Notification Toasts' : '실시간 알림 토스트 표시'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {lang === 'en'
                  ? 'Show pop-up alerts in the bottom-right corner when actions complete.'
                  : '진단 완료, 설정 변경 등 작업 완료 시 우측 하단 알림 메시지를 표시합니다.'}
              </div>
            </div>
            <button
              onClick={() => setNotificationsEnabled(!notificationsEnabled)}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                notificationsEnabled
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'border border-slate-300 bg-white text-slate-600'
              }`}
            >
              {notificationsEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* 4. Reset Local Cache */}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div>
              <div className="font-semibold text-slate-800">
                {lang === 'en' ? 'Reset Local UI Cache' : '로컬 캐시 초기화'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {lang === 'en'
                  ? 'Clear saved folder path and UI preferences without deleting incident records.'
                  : '저장된 최근 폴더 경로 및 UI 설정 캐시를 초기 상태로 되돌립니다.'}
              </div>
            </div>
            <Button variant="default" onClick={handleResetCache}>
              <RefreshCw className="h-3.5 w-3.5" />
              {lang === 'en' ? 'Reset Cache' : '캐시 초기화'}
            </Button>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
          <span className="text-[11px] text-slate-400">Agent Autopsy Desktop v0.1.0</span>
          <Button variant="primary" onClick={onClose}>
            {lang === 'en' ? 'Done' : '닫기'}
          </Button>
        </div>
      </div>
    </div>
  );
}
