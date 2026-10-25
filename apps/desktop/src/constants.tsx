import React from 'react';
import {
  LayoutDashboard,
  GitFork,
  History,
  GitCompare,
  Wrench,
  Settings,
} from 'lucide-react';

export type View = 'dashboard' | 'analysis' | 'timeline' | 'compare' | 'repair' | 'settings';

export const NAV: Array<{ id: View; label: string; labelEn: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: '대시보드', labelEn: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'analysis', label: '사건 분석', labelEn: 'Incident Analysis', icon: <GitFork className="h-4 w-4" /> },
  { id: 'timeline', label: '작업 타임라인', labelEn: 'Timeline', icon: <History className="h-4 w-4" /> },
  { id: 'compare', label: '코드 비교', labelEn: 'Code Compare', icon: <GitCompare className="h-4 w-4" /> },
  { id: 'repair', label: '복구 센터', labelEn: 'Repair Center', icon: <Wrench className="h-4 w-4" /> },
  { id: 'settings', label: '프로젝트 설정', labelEn: 'Project Settings', icon: <Settings className="h-4 w-4" /> },
];

export const STORAGE_KEY = 'agent-autopsy:repoPath';
export type AppTheme = 'light' | 'dark' | 'system';
export type AppLang = 'ko' | 'en';
