import React, { useEffect, useState } from 'react';
import { X, Copy, Check } from 'lucide-react';
import { McpInfo } from '../api';
import { AppLang } from '../constants';
import { Button, CodeBlock } from '../ui';

export function ConnectDialog({ onClose, lang = 'ko' }: { onClose: () => void; lang?: AppLang }) {
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

export default ConnectDialog;
