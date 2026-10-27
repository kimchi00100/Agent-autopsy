import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  Checkpoint,
  Incident,
  IncidentAnalysis,
  Overview,
  TimelineEvent,
  AgentSession,
  VerificationMode,
  HostEnvironment,
  ProjectDiagnostics,
  BackendStatus,
  AuditChainVerificationResult,
} from '../api';
import { STORAGE_KEY, View } from '../constants';

export interface UseAppDataOptions {
  view: View;
  notify: (kind: 'ok' | 'error', msg: string) => void;
}

export function useAppData({ view, notify }: UseAppDataOptions) {
  const [repoPath, setRepoPath] = useState<string>(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<{ incident: Incident; analysis: IncidentAnalysis } | null>(null);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [verificationMode, setVerificationMode] = useState<VerificationMode>('AUTO');
  const [preferredHost, setPreferredHost] = useState<HostEnvironment>('antigravity');
  const [sensitivePaths, setSensitivePaths] = useState<string[]>([]);
  const [riskThresholdLines, setRiskThresholdLines] = useState<number>(200);
  const [newSensitivePathInput, setNewSensitivePathInput] = useState('');
  const [diagnostics, setDiagnostics] = useState<ProjectDiagnostics | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [testCommandInput, setTestCommandInput] = useState('');
  const [auditChain, setAuditChain] = useState<AuditChainVerificationResult | null>(null);

  const checkAuditChain = useCallback(async () => {
    try {
      const res = await api.auditChainStatus();
      if (res && res.result) {
        setAuditChain(res.result);
        return res.result;
      }
    } catch {}
    return null;
  }, []);

  // Check audit chain once on initial app load (NOT on periodic 2.5s polling)
  useEffect(() => {
    checkAuditChain();
  }, [checkAuditChain]);

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

  const isLoadingRef = useRef(false);
  const hasPendingLoadRef = useRef(false);
  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const load = useCallback(async () => {
    if (isLoadingRef.current) {
      hasPendingLoadRef.current = true;
      return;
    }
    isLoadingRef.current = true;
    hasPendingLoadRef.current = false;

    try {
      loadAgents();
      if (!repoPath) return;
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
    } catch (e: any) {
      setError(e.message);
    } finally {
      isLoadingRef.current = false;
      if (hasPendingLoadRef.current) {
        hasPendingLoadRef.current = false;
        loadRef.current();
      }
    }
  }, [repoPath, loadAgents]);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

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

  const prevViewRef = useRef<View>(view);
  useEffect(() => {
    const justOpenedSettings = view === 'settings' && prevViewRef.current !== 'settings';
    prevViewRef.current = view;
    if ((justOpenedSettings || (view === 'settings' && !diagnostics)) && overview?.project?.id) {
      runDiagnostics(overview.project.id);
    }
  }, [view, overview?.project?.id, diagnostics, runDiagnostics]);

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

  // Real-time SSE stream listener + periodic fallback polling (every 20s as fallback)
  useEffect(() => {
    load();
    const unsub = api.subscribeStream(() => {
      load();
    });
    const pollInterval = setInterval(() => {
      load();
    }, 20000);
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
      setDiagnostics(null);
      setRepoPath(picked);
    }
  }

  const activeIncident = incidents.find((i) => i.id === incidentId) || incidents[0] || null;
  const pendingCount = incidents.filter((i) => i.status !== 'RESOLVED').length;

  return {
    repoPath,
    setRepoPath,
    overview,
    setOverview,
    events,
    incidents,
    checkpoints,
    incidentId,
    setIncidentId,
    analysis,
    setAnalysis,
    agents,
    error,
    setError,
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
    auditChain,
    checkAuditChain,
  };
}

export default useAppData;
