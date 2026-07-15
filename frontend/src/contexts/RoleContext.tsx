// Role context — 登录身份 + 角色能力查询 (M1 身份分级)。
//
// Mirrors ThemeContext/LanguageContext's shape: localStorage-persisted
// auth, React context, small hooks (useAuth / useCan). 身份由后端本地库
// patients.db 校验 (POST /api/agent/auth/login); 这里只保管返回的
// {role, id, name} 并把它翻译成 rolePolicy 的能力开关。
//
// 未登录时 Provider 直接渲染 <LoginGate/> 而不渲染 children —— 整个
// 应用树 (路由/WS/轮询) 在登录前根本不挂载, 而不是挂载后再遮罩。
//
// 诚实边界: localStorage 里的身份是"自我声明", 防误触不防越权 (M2 的
// 后端 authz 才是门)。所以这里刻意不存配对码/密码, 只存登录结果。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { can, type FeatureKey, type Role } from '../lib/rolePolicy';
import { LoginGate } from '../components/auth/LoginGate';
import { useTheme } from './ThemeContext';

export interface AuthInfo {
  role: Role;
  id: string;      // 患者编号 P-xxx / staff 用户名
  name: string;    // 显示名 (患者姓名; staff 同用户名)
  token?: string;  // M2: 签名 token — authToken.ts 的 fetch 包装读它注头
}

interface RoleContextValue {
  auth: AuthInfo;
  can: (feature: FeatureKey) => boolean;
  logout: () => void;
}

const RoleContext = createContext<RoleContextValue | null>(null);

const STORAGE_KEY = 'app.auth';

function readStoredAuth(): AuthInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      (parsed.role === 'patient' || parsed.role === 'doctor' || parsed.role === 'developer') &&
      typeof parsed.id === 'string' && typeof parsed.name === 'string' &&
      // M2: a session without a signed token is a stale M1 login — force
      // re-login rather than render a role whose API calls all 403.
      typeof parsed.token === 'string' && parsed.token
    ) {
      return parsed as AuthInfo;
    }
  } catch {
    /* corrupt entry / private mode — treat as logged out */
  }
  return null;
}

export function RoleProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo | null>(readStoredAuth);
  const { setThemeName, setPreference } = useTheme();

  const handleLogin = useCallback((info: AuthInfo) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    } catch {
      /* ignore quota / private mode — session-only login */
    }
    // Patients land on a calm light medical-blue theme immediately —
    // only when they haven't already picked one (theme-config present).
    if (info.role === 'patient' && !localStorage.getItem('theme-config')) {
      setThemeName('nord');
      setPreference('light');
    }
    setAuth(info);
  }, [setThemeName, setPreference]);

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setAuth(null);
  }, []);

  const canFeature = useCallback(
    (feature: FeatureKey) => can(auth?.role ?? null, feature),
    [auth],
  );

  const value = useMemo<RoleContextValue | null>(
    () => (auth ? { auth, can: canFeature, logout } : null),
    [auth, canFeature, logout],
  );

  if (!value) {
    return <LoginGate onLogin={handleLogin} />;
  }

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

/** 登录身份 + 登出。仅在 RoleProvider 内 (= 已登录) 可用。 */
export function useAuth(): { auth: AuthInfo; logout: () => void } {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useAuth must be used within a RoleProvider');
  return { auth: ctx.auth, logout: ctx.logout };
}

/** 能力查询: useCan()('chat.terminal') 或解构后多次调用。 */
export function useCan(): (feature: FeatureKey) => boolean {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useCan must be used within a RoleProvider');
  return ctx.can;
}
