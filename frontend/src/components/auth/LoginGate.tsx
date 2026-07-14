// LoginGate — 最普通的登录页 (M1 身份分级的入口)。
//
// 全屏门: RoleProvider 在未登录时渲染它, 应用树完全不挂载。
// 身份存本地库 patients.db (SQLite, agent_service :8100):
//   患者 = 病人编号 (P-001) + 配对码, 由医生端"新建病人"创建
//   医生/开发者 = 用户名 + 密码 (首启 seed: doctor/1234, dev/1234)
//
// 视觉: 跟随应用主题变量 (bg-window-bg / bg-card-bg / accent), 患者
// 场景刻意大字号大触控 (输入框/按钮 ≥44px)。文案双语跟随 LanguageContext。

import { useState, type FormEvent } from 'react';
import { useLang } from '../../contexts/LanguageContext';
import type { AuthInfo } from '../../contexts/RoleContext';

const TEXT = {
  zh: {
    title: '欢迎回来',
    subtitle: '输入你的编号和配对码 · 医护和开发人员用工作账号',
    idPlaceholder: '病人编号（如 P-001）或工作账号',
    codePlaceholder: '配对码 / 密码',
    submit: '登 录',
    submitting: '正在核对…',
    hint: '账号保存在本机数据库（patients.db），不经过任何云端。病人编号由医生创建；配对码忘了请医生一键重置。',
    failed: '编号或口令不对，再试一次',
    network: '连不上服务，请确认后端已启动',
  },
  en: {
    title: 'Welcome back',
    subtitle: 'Patients sign in with ID + pair code · staff with work accounts',
    idPlaceholder: 'Patient ID (e.g. P-001) or staff username',
    codePlaceholder: 'Pair code / password',
    submit: 'Sign in',
    submitting: 'Checking…',
    hint: 'Accounts live in a local database (patients.db) — nothing leaves this machine. Patient IDs are created by the doctor; lost pair codes can be reset in one click.',
    failed: 'ID or code incorrect, try again',
    network: 'Cannot reach the service — is the backend running?',
  },
};

export function LoginGate({ onLogin }: { onLogin: (info: AuthInfo) => void }) {
  const { lang } = useLang();
  const t = TEXT[lang];
  const [id, setId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), code }),
      });
      if (res.ok) {
        const data = await res.json();
        onLogin({ role: data.role, id: data.id, name: data.name });
        return; // Provider 切换到应用树, 本组件卸载
      }
      setError(res.status === 401 ? t.failed : `HTTP ${res.status}`);
    } catch {
      setError(t.network);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-window-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo 区 — 与 BackendGate 的等待页保持同一品牌感 */}
        <div className="flex justify-center mb-6">
          <img
            src="/logo-horizontal.svg"
            alt="i-Thread Lab"
            className="h-16 w-auto select-none"
            draggable={false}
          />
        </div>

        <form
          onSubmit={submit}
          className="bg-card-bg border border-card-border rounded-xl p-6 shadow-sm"
        >
          <h1 className="text-lg font-bold text-text-primary text-center">
            {t.title}
          </h1>
          <p className="text-xs text-text-muted text-center mt-1 mb-5">
            {t.subtitle}
          </p>

          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={t.idPlaceholder}
            autoFocus
            autoComplete="username"
            className="w-full min-h-[44px] px-4 rounded-lg border border-card-border bg-window-bg
                       text-[15px] text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t.codePlaceholder}
            type="password"
            autoComplete="current-password"
            className="w-full min-h-[44px] px-4 mt-3 rounded-lg border border-card-border bg-window-bg
                       text-[15px] text-text-primary placeholder:text-text-muted
                       focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />

          {error && (
            <div className="mt-3 text-[13px] text-status-danger" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !id.trim() || !code}
            className="w-full min-h-[44px] mt-4 rounded-lg bg-accent text-white text-[15px] font-semibold
                       hover:bg-accent-hover transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? t.submitting : t.submit}
          </button>

          <p className="text-[11px] leading-relaxed text-text-muted mt-4">
            🗄 {t.hint}
          </p>
        </form>
      </div>
    </div>
  );
}
