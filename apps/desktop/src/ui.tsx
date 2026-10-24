import React from 'react';
import { EvidenceStrength } from './api';

export function Card({
  className = '',
  children,
  onClick,
}: {
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-slate-200/90 bg-white shadow-sm ${
        onClick ? 'cursor-pointer transition hover:border-slate-300 hover:shadow' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'violet';
const tones: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  red: 'bg-rose-50 text-rose-700 border-rose-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  gray: 'bg-slate-100 text-slate-700 border-slate-200',
  violet: 'bg-violet-50 text-violet-700 border-violet-200',
};

export function Badge({ tone = 'gray', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium border ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EvidenceStrengthBadge({ level }: { level: EvidenceStrength }) {
  const map: Record<EvidenceStrength, [Tone, string]> = {
    HIGH: ['red', '강도 높음'],
    MEDIUM: ['amber', '강도 중간'],
    LOW: ['gray', '강도 낮음'],
    UNKNOWN: ['gray', '미상 (증거 부족)'],
  };
  const [tone, text] = map[level] || ['gray', level];
  return <Badge tone={tone}>{text}</Badge>;
}

export const ConfidenceBadge = EvidenceStrengthBadge;

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles = {
    default: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 shadow-sm',
    primary: 'bg-blue-600 text-white hover:bg-blue-500 shadow-sm',
    danger: 'bg-rose-600 text-white hover:bg-rose-500 shadow-sm',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  }[variant];

  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function PageHeader({ title, desc, right }: { title: string; desc: string; right?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-0.5 text-xs text-slate-500">{desc}</p>
      </div>
      {right}
    </div>
  );
}

export function Empty({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 py-12 text-center">
      <div className="text-sm font-medium text-slate-700">{title}</div>
      {desc && <div className="mt-1 max-w-md text-xs text-slate-400">{desc}</div>}
    </div>
  );
}

export function CodeBlock({
  text,
  maxHeight = 360,
  fixedHeight,
}: {
  text: string;
  maxHeight?: number;
  fixedHeight?: number;
}) {
  return (
    <pre
      style={fixedHeight ? { height: fixedHeight } : { maxHeight }}
      className="mono overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-200"
    >
      {text || '(내용 없음)'}
    </pre>
  );
}

export function UnifiedDiff({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <div style={{ maxHeight: 420 }} className="mono overflow-auto rounded-lg border border-slate-200 bg-white text-[12px] leading-relaxed">
      {lines.map((l, i) => {
        let cls = 'text-slate-600 bg-white';
        if (l.startsWith('+') && !l.startsWith('+++')) cls = 'bg-emerald-50 text-emerald-800';
        else if (l.startsWith('-') && !l.startsWith('---')) cls = 'bg-rose-50 text-rose-800';
        else if (l.startsWith('@@')) cls = 'bg-blue-50 text-blue-700 font-semibold';
        else if (l.startsWith('diff ')) cls = 'bg-slate-100 font-semibold text-slate-900';
        return (
          <div key={i} className={`whitespace-pre-wrap break-words px-3 py-0.5 border-b border-slate-100/60 ${cls}`}>
            {l || ' '}
          </div>
        );
      })}
    </div>
  );
}
