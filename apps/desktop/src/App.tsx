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
import SettingsView from './views/Settings';
import useAppData from './hooks/useAppData';
import { Badge, Button, Card, CodeBlock, Empty, UnifiedDiff } from './ui';
import Drawer from './components/Drawer';
import ConnectDialog from './components/ConnectDialog';
import AppSettingsDialog from './components/AppSettingsDialog';

export {
  NAV,
  STORAGE_KEY,
  type View,
  type AppTheme,
  type AppLang,
} from './constants';
import { View, NAV, STORAGE_KEY, AppTheme, AppLang } from './constants';

export default function App() {
  const [view, setView] = useState<View>('analysis');
  const [drawer, setDrawer] = useState<TimelineEvent | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(() => (localStorage.getItem('agent-autopsy:theme') as AppTheme) || 'light');
  const [lang, setLang] = useState<AppLang>(() => (localStorage.getItem('agent-autopsy:lang') as AppLang) || 'ko');
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => localStorage.getItem('agent-autopsy:notifications') !== 'false'
  );
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [compareFile, setCompareFile] = useState<string | null>(null);
  const [compareCommitSha, setCompareCommitSha] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState<'working' | 'checkpoint' | 'proposal' | 'commit'>('working');

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

  const {
    repoPath,
    overview,
    events,
    incidents,
    checkpoints,
    incidentId,
    setIncidentId,
    analysis,
    agents,
    error,
    backendStatus,
    verificationMode,
    preferredHost,
    sensitivePaths,
    setSensitivePaths,
    riskThresholdLines,
    setRiskThresholdLines,
    newSensitivePathInput,
    setNewSensitivePathInput,
    diagnostics,
    diagnosing,
    onboarding,
    testCommandInput,
    setTestCommandInput,
    runDiagnostics,
    runOnboarding,
    handleUpdateSettings,
    handleSaveRiskSettings,
    load,
    chooseFolder,
    activeIncident,
    pendingCount,
  } = useAppData({ view, notify });

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

        {overview && (!overview.project.sensitivePaths || overview.project.sensitivePaths.length === 0) && view !== 'settings' && (
          <div className="bg-slate-50 border-b border-slate-200 px-7 py-2 text-xs text-slate-700 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0" />
              <span>민감 경로가 지정되지 않아 위험도가 변경 줄 수와 검증 실패 횟수로만 판정됩니다</span>
            </div>
            <button
              className="text-[11px] font-medium text-blue-600 hover:underline shrink-0"
              onClick={() => setView('settings')}
            >
              민감 경로 설정 &gt;
            </button>
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
            <SettingsView
              overview={overview}
              verificationMode={verificationMode}
              preferredHost={preferredHost}
              handleUpdateSettings={handleUpdateSettings}
              diagnostics={diagnostics}
              runDiagnostics={runDiagnostics}
              diagnosing={diagnosing}
              runOnboarding={runOnboarding}
              onboarding={onboarding}
              notify={notify}
              load={load}
              testCommandInput={testCommandInput}
              setTestCommandInput={setTestCommandInput}
              sensitivePaths={sensitivePaths}
              setSensitivePaths={setSensitivePaths}
              newSensitivePathInput={newSensitivePathInput}
              setNewSensitivePathInput={setNewSensitivePathInput}
              riskThresholdLines={riskThresholdLines}
              setRiskThresholdLines={setRiskThresholdLines}
              handleSaveRiskSettings={handleSaveRiskSettings}
              chooseFolder={chooseFolder}
              onOpenConnect={() => setShowConnect(true)}
            />
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

