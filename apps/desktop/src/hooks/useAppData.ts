import { useCallback, useEffect, useState } from 'react';
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
      notify('ok', '민감 경로 및 작업 줄 수 임계치가 저장되었습니다.');
      load();
    } catch (err: any) {
      notify('error', `설정 저장 실패: ${err.message}`);
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
  };
}

export default useAppData;
