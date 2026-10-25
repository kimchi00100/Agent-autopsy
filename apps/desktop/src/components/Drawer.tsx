import React, { useEffect, useState } from 'react';
import { GitCompare, Terminal, FileCode2, X } from 'lucide-react';
import { TimelineEvent } from '../api';
import { Badge, CodeBlock, UnifiedDiff } from '../ui';

export function Drawer({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
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

export default Drawer;
