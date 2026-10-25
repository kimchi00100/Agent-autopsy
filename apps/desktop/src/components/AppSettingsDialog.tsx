import React from 'react';
import { X, Check, RefreshCw } from 'lucide-react';
import { AppTheme, AppLang } from '../constants';
import { Button } from '../ui';

export function AppSettingsDialog({
  onClose,
  theme,
  setTheme,
  lang,
  setLang,
  notificationsEnabled,
  setNotificationsEnabled,
  notify,
}: {
  onClose: () => void;
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
  lang: AppLang;
  setLang: (l: AppLang) => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (v: boolean) => void;
  notify: (kind: 'ok' | 'error', msg: string) => void;
}) {
  const handleResetCache = () => {
    const msg =
      lang === 'en'
        ? 'Reset local UI cache and preferences? (Project files and incident history in SQLite will remain safe.)'
        : '로컬 UI 캐시 및 환경 설정을 초기화할까요? (원본 프로젝트 파일과 사건 기록 DB는 안전하게 유지됩니다.)';
    if (!window.confirm(msg)) return;
    localStorage.clear();
    window.location.reload();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-xs fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[520px] shrink-0 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-slate-100 pb-4">
          <div>
            <div className="text-base font-bold text-slate-900">
              {lang === 'en' ? 'Application Settings' : '앱 환경 설정'}
            </div>
            <p className="mt-0.5 text-xs text-slate-500">
              {lang === 'en'
                ? 'Customize theme appearance, display language, and notification preferences.'
                : '테마 외관, 표시 언어, 알림 토스트 및 로컬 캐시를 관리합니다.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 space-y-5 text-xs">
          {/* 1. Theme Selection */}
          <div>
            <div className="font-semibold text-slate-800 mb-2">
              {lang === 'en' ? 'Theme Appearance' : '화면 테마 설정'}
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {(
                [
                  ['light', lang === 'en' ? 'Light Mode' : '라이트 모드', lang === 'en' ? 'Clean bright UI' : '밝고 선명한 기본 화면'],
                  ['dark', lang === 'en' ? 'Dark Mode' : '다크 모드', lang === 'en' ? 'Low-glare dark UI' : '눈이 편안한 어두운 화면'],
                  ['system', lang === 'en' ? 'System Sync' : '시스템 연동', lang === 'en' ? 'Follow OS setting' : 'Windows 테마 자동 동기화'],
                ] as const
              ).map(([id, title, desc]) => (
                <button
                  key={id}
                  onClick={() => {
                    setTheme(id);
                    notify('ok', lang === 'en' ? `Theme changed to ${title}` : `테마가 '${title}'로 변경되었습니다.`);
                  }}
                  className={`rounded-xl border p-3 text-left transition ${
                    theme === id
                      ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                  }`}
                >
                  <div className="font-bold text-slate-900 flex items-center justify-between">
                    <span>{title}</span>
                    {theme === id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 2. Language Selection */}
          <div>
            <div className="font-semibold text-slate-800 mb-2">
              {lang === 'en' ? 'Display Language' : '표시 언어 (Language)'}
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {(
                [
                  ['ko', '한국어 (Korean)', '인터페이스 및 메뉴를 한국어로 표시'],
                  ['en', 'English (US)', 'Display navigation and menus in English'],
                ] as const
              ).map(([id, title, desc]) => (
                <button
                  key={id}
                  onClick={() => {
                    setLang(id);
                    notify('ok', id === 'en' ? 'Language switched to English.' : '언어가 한국어로 변경되었습니다.');
                  }}
                  className={`rounded-xl border p-3 text-left transition ${
                    lang === id
                      ? 'border-blue-600 bg-blue-50/70 ring-1 ring-blue-600'
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50'
                  }`}
                >
                  <div className="font-bold text-slate-900 flex items-center justify-between">
                    <span>{title}</span>
                    {lang === id && <Check className="h-3.5 w-3.5 text-blue-600" />}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 3. Notification Toast Toggle */}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div>
              <div className="font-semibold text-slate-800">
                {lang === 'en' ? 'Status Notification Toasts' : '실시간 알림 토스트 표시'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {lang === 'en'
                  ? 'Show pop-up alerts in the bottom-right corner when actions complete.'
                  : '진단 완료, 설정 변경 등 작업 완료 시 우측 하단 알림 메시지를 표시합니다.'}
              </div>
            </div>
            <button
              onClick={() => setNotificationsEnabled(!notificationsEnabled)}
              className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                notificationsEnabled
                  ? 'bg-emerald-600 text-white shadow-xs'
                  : 'border border-slate-300 bg-white text-slate-600'
              }`}
            >
              {notificationsEnabled ? 'ON' : 'OFF'}
            </button>
          </div>

          {/* 4. Reset Local Cache */}
          <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 p-3.5">
            <div>
              <div className="font-semibold text-slate-800">
                {lang === 'en' ? 'Reset Local UI Cache' : '로컬 캐시 초기화'}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {lang === 'en'
                  ? 'Clear saved folder path and UI preferences without deleting incident records.'
                  : '저장된 최근 폴더 경로 및 UI 설정 캐시를 초기 상태로 되돌립니다.'}
              </div>
            </div>
            <Button variant="default" onClick={handleResetCache}>
              <RefreshCw className="h-3.5 w-3.5" />
              {lang === 'en' ? 'Reset Cache' : '캐시 초기화'}
            </Button>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-slate-100 pt-4">
          <span className="text-[11px] text-slate-400">Agent Autopsy Desktop v0.1.0</span>
          <Button variant="primary" onClick={onClose}>
            {lang === 'en' ? 'Done' : '닫기'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default AppSettingsDialog;
