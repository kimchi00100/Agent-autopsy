import React, { useEffect, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { McpInfo } from '../api';
import { AppLang } from '../constants';
import { Button, CodeBlock } from '../ui';

export const RECOMMENDED_RULES_TEXT = `# Agent Autopsy 에이전트 필수 운영 규칙
1. [작업 전 기준점] 작업 시작 전 반드시 capture_checkpoint를 호출하여 기준점을 기록하라.
2. [사전 코드 조사 금지] 버그나 기능 오작동 신고 시 코드를 읽거나 조사하기 전에 먼저 collect_incident_bundle을 호출하라.
   - userReportText에 사용자 원문을 그대로 넣고, 4대 의도는 원문에서 알 수 있는 것만 채워라.
   - 누락 항목은 안내되는 next_action(CLARIFY_INTENT)에 따라 사용자에게 질문하라. 의도 정리를 위한 사전 코드 조사는 금지된다.
3. [변경 범위 확인] 사건 등록 직후 get_change_scope로 변경 범위를 먼저 확인하라(원인 확정 아님).
4. [지침 준수] 모든 도구 응답의 next_action 구조화 지침을 엄격히 준수하라.
5. [직접 수정 금지] 소스 코드를 직접 수정하지 마라. 반드시 propose_and_verify_repair로 격리 검증을 수행하라.
6. [승인 착각 방지] 서브에이전트 독립 검토(submit_orchestration_review) 완료는 사용자 승인이 아니다.
7. [인간 승인 대기] 사용자가 앱 대시보드(http://localhost:3847)에서 직접 승인할 때까지 대기하라(await_user_decision). 사용자 승인 없이 apply_approved_repair를 호출하지 마라.`;

export function ConnectDialog({ onClose, lang = 'ko' }: { onClose: () => void; lang?: AppLang }) {
  const [info, setInfo] = useState<McpInfo>({
    command: 'node',
    args: ['<저장소 경로>\\packages\\mcp-server\\dist\\index.js'],
    env: {},
    packaged: false,
  });
  const [agent, setAgent] = useState<'antigravity' | 'codex' | 'claude'>('antigravity');
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [copiedRules, setCopiedRules] = useState(false);

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

  async function copyConfig() {
    await navigator.clipboard.writeText(snippets.text);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 1500);
  }

  async function copyRules() {
    await navigator.clipboard.writeText(RECOMMENDED_RULES_TEXT);
    setCopiedRules(true);
    setTimeout(() => setCopiedRules(false), 1500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-xs fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-[660px] shrink-0 flex-col overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-base font-bold text-slate-900">
                {lang === 'en' ? 'Connect Coding Agent (MCP)' : '코딩 에이전트 연결 및 규칙 설정'}
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {lang === 'en'
                  ? 'Connect the MCP server and register recommended operating rules for your agent.'
                  : 'MCP 서버를 연결하고 권장 운영 규칙을 등록해야 에이전트가 안전 복구 워크플로우를 준수합니다.'}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Section 1: MCP Configuration */}
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-800">
                  {lang === 'en' ? '1. MCP Server Configuration' : '1. MCP 서버 연결 설정'}
                </span>
              </div>
              <div className="flex gap-1.5">
                {([['antigravity', 'Antigravity'], ['codex', 'Codex'], ['claude', 'Claude Code']] as const).map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setAgent(id)}
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition ${
                      agent === id ? 'bg-blue-600 text-white shadow-xs' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-2 h-4 truncate text-xs font-medium text-slate-600">{snippets.where}</div>
            <div className="mt-1.5">
              <CodeBlock text={snippets.text} fixedHeight={120} />
            </div>

            <div className="mt-2 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">
                {lang === 'en'
                  ? 'Restart your coding agent after applying the configuration.'
                  : '설정을 적용한 뒤 에이전트를 재시작하면 도구가 활성화됩니다.'}
              </span>
              <Button variant="primary" onClick={copyConfig} className="!py-1 !px-2.5 text-xs">
                {copiedConfig ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedConfig ? (lang === 'en' ? 'Copied' : '복사됨') : lang === 'en' ? 'Copy Config' : '설정 복사'}
              </Button>
            </div>
          </div>

          {/* Section 2: Recommended Agent Rules */}
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-bold text-slate-800">
                  {lang === 'en' ? '2. Recommended Agent Rules (Prompt / System Rules)' : '2. 에이전트 권장 규칙 (프롬프트/시스템 규칙용)'}
                </span>
              </div>
              <Button variant="default" onClick={copyRules} className="!py-1 !px-2.5 text-xs">
                {copiedRules ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedRules ? (lang === 'en' ? 'Copied!' : '복사됨!') : lang === 'en' ? 'Copy Rules' : '규칙 복사'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {lang === 'en'
                ? 'Copy and add these rules to your agent\'s system rules or prompt to ensure it uses Agent Autopsy correctly.'
                : 'MCP 설정뿐 아니라 아래 권장 규칙을 에이전트의 프롬프트나 시스템 규칙에 추가해야 에이전트가 제품을 제대로 씁니다.'}
            </p>
            <div className="mt-2">
              <pre className="mono overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-200 max-h-[160px]">
                {RECOMMENDED_RULES_TEXT}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConnectDialog;
