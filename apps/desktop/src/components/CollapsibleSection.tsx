import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface CollapsibleSectionProps {
  id: string;
  title: string;
  icon?: React.ReactNode;
  summary?: React.ReactNode;
  warning?: React.ReactNode;
  defaultOpen?: boolean;
  hasWarning?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function CollapsibleSection({
  id,
  title,
  icon,
  summary,
  warning,
  defaultOpen = false,
  hasWarning = false,
  children,
  className = '',
}: CollapsibleSectionProps) {
  const storageKey = `agent-autopsy:incidentPanel:${id}`;

  const [isOpen, setIsOpen] = useState<boolean>(() => {
    if (hasWarning) return true;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) {
        return saved === 'true';
      }
    } catch {
      // ignore localStorage errors
    }
    return defaultOpen;
  });

  // Warning auto-expansion overrides saved state
  useEffect(() => {
    if (hasWarning) {
      setIsOpen(true);
    }
  }, [hasWarning]);

  const toggle = () => {
    setIsOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        // ignore localStorage errors
      }
      return next;
    });
  };

  return (
    <div className={`rounded-xl border border-slate-200/90 bg-white shadow-xs overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-slate-50/70 hover:bg-slate-100/60 transition text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate-400">
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
          {icon && <span className="shrink-0">{icon}</span>}
          <span className="text-xs font-semibold text-slate-800 truncate">{title}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {warning}
          {summary}
        </div>
      </button>

      {isOpen && (
        <div className="p-3.5 border-t border-slate-100">
          {children}
        </div>
      )}
    </div>
  );
}

export default CollapsibleSection;
