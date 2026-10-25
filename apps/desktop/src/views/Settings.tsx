import React from 'react';
import {
  Check,
  Terminal,
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
  Overview,
  VerificationMode,
  HostEnvironment,
  ProjectDiagnostics,
} from '../api';
import { Button, Card } from '../ui';

export interface SettingsViewProps {
  overview: Overview;
  verificationMode: VerificationMode;
  preferredHost: HostEnvironment;
  handleUpdateSettings: (mode: VerificationMode, host: HostEnvironment) => Promise<void> | void;
  diagnostics: ProjectDiagnostics | null;
  runDiagnostics: (projId?: string) => Promise<void>;
  diagnosing: boolean;
  runOnboarding: () => Promise<void>;
  onboarding: boolean;
  notify: (kind: 'ok' | 'error', msg: string) => void;
  load: (overridePath?: string) => Promise<void>;
  testCommandInput: string;
  setTestCommandInput: React.Dispatch<React.SetStateAction<string>>;
  sensitivePaths: string[];
  setSensitivePaths: React.Dispatch<React.SetStateAction<string[]>>;
  newSensitivePathInput: string;
  setNewSensitivePathInput: React.Dispatch<React.SetStateAction<string>>;
  riskThresholdLines: number;
  setRiskThresholdLines: React.Dispatch<React.SetStateAction<number>>;
  handleSaveRiskSettings: () => Promise<void>;
  chooseFolder: () => Promise<void>;
  onOpenConnect: () => void;
}

export default function SettingsView({
  overview,
  verificationMode,
  preferredHost,
  handleUpdateSettings,
  diagnostics,
  runDiagnostics,
  diagnosing,
  runOnboarding,
  onboarding,
  notify,
  load,
  testCommandInput,
  setTestCommandInput,
  sensitivePaths,
  setSensitivePaths,
  newSensitivePathInput,
  setNewSensitivePathInput,
  riskThresholdLines,
  setRiskThresholdLines,
  handleSaveRiskSettings,
  chooseFolder,
  onOpenConnect,
}: SettingsViewProps) {
  return (
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
                      {sensitivePaths.length === 0 && (
                        <div className="mt-2 rounded-lg bg-amber-50/80 border border-amber-200 p-2.5 text-xs text-amber-900 flex items-center gap-2">
                          <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0" />
                          <span>민감 경로가 지정되지 않아 위험도가 변경 줄 수와 검증 실패 횟수로만 판정됩니다</span>
                        </div>
                      )}
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
                        <div className="text-xs font-semibold text-slate-700">커버리지 정밀 분석 (LCOV 기반)</div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          테스트 실패/성공 시 실행된 줄을 비교하여 결함 위치를 특정하는 분석입니다.
                        </p>
                      </div>
                      <span className="rounded bg-slate-100 border border-slate-200 text-slate-500 px-2.5 py-1 text-xs font-medium shrink-0">
                        아직 지원 안 함
                      </span>
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
                    <Button variant="primary" onClick={onOpenConnect}>MCP 연결 설정 열기</Button>
                  </div>
                </Card>
              </div>
  );
}
