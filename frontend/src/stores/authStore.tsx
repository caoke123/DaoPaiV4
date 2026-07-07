// Phase 3-D: Auth 状态管理（React Context）
//
// 提供：
//   - user / accessToken / refreshToken / isAuthenticated / isLoading
//   - login / logout / refresh / loadMe 方法
//   - ProtectedRoute 组件（Phase 3-G-2）
//
// token 存储在 localStorage，页面刷新后可恢复。

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

// ── 类型 ──

export interface AuthUser {
  id: string;
  tenantId: string;
  role: string;
  username: string;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<string | null>;
  loadMe: () => Promise<void>;
}

// ── localStorage keys ──

const LS_ACCESS_TOKEN = 'daopai_access_token';
const LS_REFRESH_TOKEN = 'daopai_refresh_token';
const LS_USER = 'daopai_user';

function loadTokens(): { accessToken: string | null; refreshToken: string | null; user: AuthUser | null } {
  try {
    return {
      accessToken: localStorage.getItem(LS_ACCESS_TOKEN),
      refreshToken: localStorage.getItem(LS_REFRESH_TOKEN),
      user: JSON.parse(localStorage.getItem(LS_USER) || 'null'),
    };
  } catch {
    return { accessToken: null, refreshToken: null, user: null };
  }
}

function saveTokens(accessToken: string, refreshToken: string, user: AuthUser) {
  localStorage.setItem(LS_ACCESS_TOKEN, accessToken);
  localStorage.setItem(LS_REFRESH_TOKEN, refreshToken);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

function clearTokens() {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_USER);
}

// ── 安全 JSON 解析（Phase 3-D-1-A）──
// 防止后端返回空 body 或非 JSON 时 response.json() 直接抛异常

async function parseJsonSafely(resp: Response): Promise<Record<string, unknown> | null> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Context ──

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const { accessToken, refreshToken, user } = loadTokens();
    return {
      user,
      accessToken,
      refreshToken,
      isAuthenticated: !!(accessToken && user),
      isLoading: !!(accessToken && user), // 有 token 时需验证
    };
  });

  // 启动时恢复用户状态
  useEffect(() => {
    const { accessToken, refreshToken } = loadTokens();
    if (!accessToken || !refreshToken) {
      setState(s => ({ ...s, isLoading: false }));
      return;
    }
    // 调用 /api/auth/me 验证 token 是否有效
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(async res => {
        if (!res.ok) throw new Error('token invalid');
        const data = await parseJsonSafely(res);
        if (!data) throw new Error('empty response');
        return data;
      })
      .then((data) => {
        setState({
          user: { id: (data as any).id as string, tenantId: (data as any).tenantId as string, role: (data as any).role as string, username: ((data as any).username || '') as string },
          accessToken,
          refreshToken,
          isAuthenticated: true,
          isLoading: false,
        });
      })
      .catch(() => {
        // token 无效，清除
        clearTokens();
        setState({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          isLoading: false,
        });
      });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    let resp: Response;
    try {
      resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      throw new Error('网络异常，请确认后端服务已启动');
    }
    const data = await parseJsonSafely(resp);
    if (!resp.ok) {
      throw new Error((data as any)?.error || '登录失败，请检查后端服务或接口响应');
    }
    if (!data || !data.accessToken || !data.user) {
      throw new Error('登录失败，请检查后端服务或接口响应');
    }
    const user: AuthUser = {
      id: (data.user as any).id,
      tenantId: (data.user as any).tenantId,
      role: (data.user as any).role,
      username: (data.user as any).username,
    };
    saveTokens(data.accessToken as string, data.refreshToken as string, user);
    setState({
      user,
      accessToken: data.accessToken as string,
      refreshToken: data.refreshToken as string,
      isAuthenticated: true,
      isLoading: false,
    });
  }, []);

  const logout = useCallback(async () => {
    const { refreshToken } = loadTokens();
    if (refreshToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // logout 失败也不阻塞
      }
    }
    clearTokens();
    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
    // Phase 3-D-1-A: 退出后跳转到登录页
    window.location.href = '/login';
  }, []);

  const refresh = useCallback(async (): Promise<string | null> => {
    const { refreshToken } = loadTokens();
    if (!refreshToken) return null;
    try {
      const resp = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!resp.ok) {
        clearTokens();
        setState(s => ({ ...s, isAuthenticated: false, accessToken: null, refreshToken: null, user: null }));
        return null;
      }
      const data = await parseJsonSafely(resp);
      if (!data || !data.accessToken) return null;
      const newAccessToken = data.accessToken as string;
      // 更新 localStorage
      localStorage.setItem(LS_ACCESS_TOKEN, newAccessToken);
      setState(s => ({ ...s, accessToken: newAccessToken }));
      return newAccessToken;
    } catch {
      return null;
    }
  }, []);

  const loadMe = useCallback(async () => {
    const { accessToken } = loadTokens();
    if (!accessToken) {
      setState(s => ({ ...s, isLoading: false }));
      return;
    }
    try {
      const resp = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) throw new Error('not authenticated');
      const data = await parseJsonSafely(resp);
      if (!data) throw new Error('empty response');
      setState(s => ({
        ...s,
        user: { id: (data as any).id as string, tenantId: (data as any).tenantId as string, role: (data as any).role as string, username: ((data as any).username || '') as string },
        isAuthenticated: true,
        isLoading: false,
      }));
    } catch {
      clearTokens();
      setState({
        user: null, accessToken: null, refreshToken: null,
        isAuthenticated: false, isLoading: false,
      });
    }
  }, []);

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    refresh,
    loadMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** 获取当前 accessToken（供 API client 使用，不依赖 React） */
export function getAccessToken(): string | null {
  return localStorage.getItem(LS_ACCESS_TOKEN);
}

/** 获取当前 refreshToken（供 API client 使用） */
export function getRefreshToken(): string | null {
  return localStorage.getItem(LS_REFRESH_TOKEN);
}

/** 保存新的 accessToken（供 refresh 成功后使用） */
export function setAccessToken(token: string) {
  localStorage.setItem(LS_ACCESS_TOKEN, token);
}

/** 清除所有 token（refresh 失败时使用） */
export function clearAllTokens() {
  clearTokens();
}

/** 全局事件：触发跳转登录页 */
let onAuthFailure: (() => void) | null = null;
export function setOnAuthFailure(handler: (() => void) | null) {
  onAuthFailure = handler;
}
export function triggerAuthFailure() {
  clearAllTokens();
  if (onAuthFailure) onAuthFailure();
  else window.location.href = '/login';
}

// ── Phase 3-G-2: ProtectedRoute 路由保护组件 ──

/**
 * 统一路由保护：
 *   1. isLoading 期间显示 loading spinner
 *   2. 未认证时跳转 /login（携带 from 路径供登录后回跳）
 *   3. 已认证则渲染子路由
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg)]">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-3)]" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
