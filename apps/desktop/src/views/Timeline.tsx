import React, { useMemo, useState } from 'react';
import { TimelineEvent, TimelineKind } from '../api';
import { clock, relativeTime } from '../diff';
import { Badge, Card, Empty, PageHeader } from '../ui';
import {
  Eye, Pencil, Terminal, CheckCircle2, XCircle, Flag, AlertOctagon, Lightbulb, RotateCcw, StickyNote, ChevronDown, ChevronRight,
} from 'lucide-react';

const META: Record<TimelineKind, { label: string; icon: React.ReactNode; dot: string; tone: 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'violet' }> = {
  READ: { label: '파일 읽기', icon: <Eye className="h-3.5 w-3.5" />, dot: 'bg-slate-400', tone: 'gray' },
  EDIT: { label: '코드 수정', icon: <Pencil className="h-3.5 w-3.5" />, dot: 'bg-blue-500', tone: 'blue' },
  COMMAND: { label: '명령 실행', icon: <Terminal className="h-3.5 w-3.5" />, dot: 'bg-violet-500', tone: 'violet' },
  TEST_PASS: { label: '테스트 통과', icon: <CheckCircle2 className="h-3.5 w-3.5" />, dot: 'bg-emerald-500', tone: 'green' },
  TEST_FAIL: { label: '테스트 실패', icon: <XCircle className="h-3.5 w-3.5" />, dot: 'bg-rose-500', tone: 'red' },
  CHECKPOINT: { label: 'Checkpoint', icon: <Flag className="h-3.5 w-3.5" />, dot: 'bg-slate-500', tone: 'gray' },
  INCIDENT: { label: 'Incident', icon: <AlertOctagon className="h-3.5 w-3.5" />, dot: 'bg-amber-500', tone: 'amber' },
  PROPOSAL: { label: '수정안', icon: <Lightbulb className="h-3.5 w-3.5" />, dot: 'bg-blue-600', tone: 'blue' },
  RECOVERY: { label: '복구', icon: <RotateCcw className="h-3.5 w-3.5" />, dot: 'bg-emerald-500', tone: 'green' },
  NOTE: { label: '메모', icon: <StickyNote className="h-3.5 w-3.5" />, dot: 'bg-slate-400', tone: 'gray' },
};

type Filter = 'ALL' | 'EDIT' | 'COMMAND' | 'TEST' | 'ISSUE';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'ALL', label: '전체' },
  { id: 'EDIT', label: '코드 수정' },
  { id: 'COMMAND', label: '명령 실행' },
  { id: 'TEST', label: '테스트' },
  { id: 'ISSUE', label: '사고·복구' },
];

function matches(kind: TimelineKind, f: Filter): boolean {
  if (f === 'ALL') return true;
  if (f === 'EDIT') return kind === 'EDIT' || kind === 'PROPOSAL';
  if (f === 'COMMAND') return kind === 'COMMAND';
  if (f === 'TEST') return kind === 'TEST_PASS' || kind === 'TEST_FAIL';
  return kind === 'INCIDENT' || kind === 'RECOVERY' || kind === 'CHECKPOINT';
}

type Item = { type: 'event'; event: TimelineEvent } | { type: 'reads'; events: TimelineEvent[]; id: string };

function group(events: TimelineEvent[]): Item[] {
  const out: Item[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (ev.kind === 'READ') {
      if (last && last.type === 'reads') last.events.push(ev);
      else out.push({ type: 'reads', events: [ev], id: ev.id });
    } else {
      out.push({ type: 'event', event: ev });
    }
  }
  return out;
}

export default function Timeline({
  events,
  selectedId,
  onSelect,
  searchQuery = '',
}: {
  events: TimelineEvent[];
  selectedId: string | null;
  onSelect: (e: TimelineEvent) => void;
  searchQuery?: string;
}) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const filteredEvents = useMemo(() => {
    let list = events.filter((e) => matches(e.kind, filter));
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.summary.toLowerCase().includes(q) ||
          e.actor.toLowerCase().includes(q) ||
          (e.log && e.log.toLowerCase().includes(q)) ||
          e.files.some((f) => f.toLowerCase().includes(q))
      );
    }
    return list;
  }, [events, filter, searchQuery]);

  const items = useMemo(() => group(filteredEvents), [filteredEvents]);

  return (
    <div className="fade-in space-y-4">
      <PageHeader title="AI 작업 타임라인" desc="AI가 어떤 순서로 무엇을 했는지 시간순으로 재구성합니다." />

      <div className="flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3.5 py-1 text-xs font-medium transition ${
              filter === f.id
                ? 'bg-blue-600 text-white shadow-sm'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <Empty
          title="표시할 작업이 없습니다"
          desc="에이전트가 도구를 호출하거나 Checkpoint·Incident가 기록되면 시간순으로 나타납니다."
        />
      ) : (
        <div className="relative ml-3 border-l border-slate-200 pl-8">
          {items.map((item) => {
            if (item.type === 'reads') {
              const isOpen = open[item.id];
              return (
                <div key={item.id} className="relative mb-3">
                  <span className="absolute -left-[37px] top-3.5 h-2.5 w-2.5 rounded-full bg-slate-400 ring-4 ring-slate-50" />
                  <button
                    onClick={() => setOpen((o) => ({ ...o, [item.id]: !o[item.id] }))}
                    className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-left text-xs font-medium text-slate-600 transition hover:bg-slate-50 shadow-sm"
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
                    <Eye className="h-3.5 w-3.5 text-slate-500" />
                    파일 탐색 ({item.events.length}개)
                    <span className="ml-auto text-[11px] text-slate-400">{clock(item.events[0].createdAt)}</span>
                  </button>
                  {isOpen && (
                    <div className="ml-6 mt-1.5 space-y-1">
                      {item.events.map((e) => (
                        <button
                          key={e.id}
                          onClick={() => onSelect(e)}
                          className="mono block w-full truncate rounded border border-slate-100 bg-white px-3 py-1.5 text-left text-[11px] text-slate-600 hover:bg-slate-50"
                        >
                          {e.files[0] ?? e.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            const e = item.event;
            const meta = META[e.kind];
            const selected = selectedId === e.id;
            return (
              <div key={e.id} className="relative mb-3">
                <span className={`absolute -left-[37px] top-4 h-2.5 w-2.5 rounded-full ring-4 ring-slate-50 ${meta.dot}`} />
                <Card
                  onClick={() => onSelect(e)}
                  className={`p-3.5 ${selected ? '!border-blue-500 !ring-2 !ring-blue-500/10' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={meta.tone}>
                      {meta.icon}
                      {meta.label}
                    </Badge>
                    <span className="truncate font-semibold text-xs text-slate-900">{e.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                      {clock(e.createdAt)} · {relativeTime(e.createdAt)}
                    </span>
                  </div>
                  {e.summary && <div className="mt-1.5 truncate text-xs text-slate-500">{e.summary}</div>}
                  {e.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {e.files.slice(0, 4).map((f) => (
                        <span key={f} className="mono rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-700">
                          {f}
                        </span>
                      ))}
                      {e.files.length > 4 && <span className="text-[10px] text-slate-400">외 {e.files.length - 4}개</span>}
                    </div>
                  )}
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
