// SessionManager — Session 生命周期治理
// Phase D-2B: Session 检测 + 自动恢复 + 心跳保活 + 统计
// 覆盖: 登录状态判断(VALID/EXPIRED/UNKNOWN)、autoRelogin、keepAlive

import type { Page } from 'playwright';
import { RuntimeMetrics } from '../runtime/RuntimeMetrics';

// ── 类型定义 ──────────────────────────────────────────

export type SessionState = 'VALID' | 'EXPIRED' | 'UNKNOWN';

export interface SessionCheckResult {
  state: SessionState;
  currentUrl: string;
  pageTitle: string;
  detectedLoginPage: boolean;
  hasLoginForm: boolean;
  hasUsernameInput: boolean;
  hasPasswordInput: boolean;
  detectionMethod: string;  // 如 "url", "login_form", "username_input"
}

export interface SessionStats {
  totalChecks: number;
  validCount: number;
  expiredCount: number;
  unknownCount: number;
  totalRecoveries: number;
  recoverySuccess: number;
  recoveryFailure: number;
  totalRecoveryDurationMs: number;
  lastRecoveryTime: string | null;
  lastHeartbeatTime: string | null;
  totalHeartbeats: number;
  heartbeatFailures: number;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

// ── 登录检测选择器 ──────────────────────────────────

const LOGIN_PAGE_SELECTORS = {
  loginForm: '.login-container, .login-form, form',
  usernameInput: 'input[placeholder*="账号"], input[placeholder*="用户名"], input[placeholder*="工号"], input[name="username"], input[name="account"]',
  passwordInput: 'input[placeholder*="密码"], input[type="password"], input[name="password"]',
} as const;

// ── SessionManager 类 ─────────────────────────────────

export class SessionManager {
  private static instance: SessionManager | null = null;

  /** 外部注入的自动重登录函数（由 BrowserPool 提供） */
  private reloginFn: ((page: Page) => Promise<boolean>) | null = null;

  /** 心跳定时器集合（key = 窗口标识, value = interval handle） */
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  private stats: SessionStats = {
    totalChecks: 0,
    validCount: 0,
    expiredCount: 0,
    unknownCount: 0,
    totalRecoveries: 0,
    recoverySuccess: 0,
    recoveryFailure: 0,
    totalRecoveryDurationMs: 0,
    lastRecoveryTime: null,
    lastHeartbeatTime: null,
    totalHeartbeats: 0,
    heartbeatFailures: 0,
  };

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  // ── 注入 ────────────────────────────────────────────

  /** 注入自动重登录函数（BrowserPool 初始化后调用） */
  setRelogin(fn: (page: Page) => Promise<boolean>): void {
    this.reloginFn = fn;
  }

  // ── checkSession: 检测 Session 状态 ──

  async checkSession(page: Page): Promise<SessionCheckResult> {
    this.stats.totalChecks++;
    let detectionMethod = 'unknown';

    // 方法1: URL 检测
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    const urlContainsLogin = currentUrl.includes('/login') || currentUrl.toLowerCase().includes('login');

    // 方法2: 登录表单检测
    let hasLoginForm = false;
    let hasUsernameInput = false;
    let hasPasswordInput = false;

    if (urlContainsLogin) {
      detectionMethod = 'url';
      // 在 /login 页面进一步确认
      try {
        const form = await page.$(LOGIN_PAGE_SELECTORS.loginForm).catch(() => null);
        hasLoginForm = form !== null;

        const userInput = await page.$(LOGIN_PAGE_SELECTORS.usernameInput).catch(() => null);
        hasUsernameInput = userInput !== null;
        if (hasUsernameInput) detectionMethod = 'username_input';

        const pwdInput = await page.$(LOGIN_PAGE_SELECTORS.passwordInput).catch(() => null);
        hasPasswordInput = pwdInput !== null;
        if (hasPasswordInput && !hasUsernameInput) detectionMethod = 'password_input';
      } catch { /* 忽略 DOM 访问错误 */ }
    } else {
      // URL 不含 /login → 快速验证是否登录页（页面可能被重定向但 URL 没变）
      try {
        const pwdInput = await page.$(LOGIN_PAGE_SELECTORS.passwordInput).catch(() => null);
        hasPasswordInput = pwdInput !== null;
        if (hasPasswordInput) {
          const userInput = await page.$(LOGIN_PAGE_SELECTORS.usernameInput).catch(() => null);
          hasUsernameInput = userInput !== null;
          if (hasUsernameInput) detectionMethod = 'username_input';
          else detectionMethod = 'password_input';
        }
      } catch { /* 忽略 */ }
    }

    // 判断状态
    let state: SessionState;
    const pageTitleContainsLogin = pageTitle.includes('登录');
    const detectedLoginPage = urlContainsLogin || pageTitleContainsLogin;

    if (hasUsernameInput || hasPasswordInput) {
      // 登录表单存在 → 确定在登录页
      state = 'EXPIRED';
    } else if (detectedLoginPage) {
      // URL/标题含 login 但无表单 → 可能是登录页还在加载
      state = 'EXPIRED';
    } else {
      // 无登录特征 → 已登录
      state = 'VALID';
    }

    // 更新统计
    if (state === 'VALID') this.stats.validCount++;
    else if (state === 'EXPIRED') this.stats.expiredCount++;
    else this.stats.unknownCount++;

    return {
      state,
      currentUrl,
      pageTitle,
      detectedLoginPage,
      hasLoginForm,
      hasUsernameInput,
      hasPasswordInput,
      detectionMethod,
    };
  }

  // ── ensureLoggedIn: 确保已登录（检测 + 自动恢复）──

  /**
   * 检测 Session → 已登录返回 → 未登录自动恢复
   * @throws AuthenticationError 如果无法自动恢复
   */
  async ensureLoggedIn(page: Page): Promise<boolean> {
    // Step 1: 快速检测
    const session = await this.checkSession(page);

    if (session.state === 'VALID') {
      return true;
    }

    if (session.state === 'UNKNOWN') {
      // 状态不明，保守处理——不妨碍已登录页面的操作
      // 如果 URL 不在 login 页面，假定为已登录
      if (!session.detectedLoginPage) {
        console.log('[SessionManager] Session 状态未知但不在登录页，允许继续');
        return true;
      }
    }

    // Step 2: Session 已过期 → 尝试自动恢复
    console.log(`[SessionManager] Session 已过期 (detection=${session.detectionMethod}), 尝试自动重登录...`);
    return this.autoRelogin(page);
  }

  // ── autoRelogin: 自动重登录 ──

  async autoRelogin(page: Page): Promise<boolean> {
    this.stats.totalRecoveries++;
    RuntimeMetrics.getInstance().sessionRecovered();
    const startTime = Date.now();

    if (!this.reloginFn) {
      console.error('[SessionManager] 未注入 relogin 函数，无法自动恢复');
      this.stats.recoveryFailure++;
      throw new AuthenticationError('自动恢复未配置：缺少 reloginFn');
    }

    try {
      const success = await this.reloginFn(page);

      const duration = Date.now() - startTime;
      this.stats.totalRecoveryDurationMs += duration;
      this.stats.lastRecoveryTime = new Date().toISOString();

      if (success) {
        // 恢复后再次验证
        const verify = await this.checkSession(page);
        if (verify.state === 'VALID') {
          this.stats.recoverySuccess++;
          RuntimeMetrics.getInstance().sessionRecoverSucceed();
          console.log(`[SessionManager] 自动重登录成功 (${(duration / 1000).toFixed(1)}s)`);
          return true;
        }

        console.warn('[SessionManager] reloginFn 返回成功但二次验证失败');
      }

      this.stats.recoveryFailure++;
      RuntimeMetrics.getInstance().sessionRecoverFailed();
      console.error(`[SessionManager] 自动重登录失败 (${(duration / 1000).toFixed(1)}s)`);
      throw new AuthenticationError(`自动重登录失败：reloginFn 返回 ${success}`);
    } catch (e) {
      this.stats.recoveryFailure++;
      RuntimeMetrics.getInstance().sessionRecoverFailed();
      const duration = Date.now() - startTime;
      this.stats.totalRecoveryDurationMs += duration;

      if (e instanceof AuthenticationError) throw e;
      console.error(`[SessionManager] 自动重登录异常 (${(duration / 1000).toFixed(1)}s): ${(e as Error).message}`);
      throw new AuthenticationError(`自动重登录异常: ${(e as Error).message}`);
    }
  }

  // ── keepAlive: 真实心跳保活 ──

  /**
   * 对单个 page 执行心跳
   * C2 修复：从 page.evaluate(() => 1)（无网络请求）改为页面内 fetch 真实只读请求
   * - 使用页面内 fetch（credentials:'include' 自动携带 session cookie）
   * - 请求当前页面 URL（dashboard，业务本身会正常访问的只读 GET）
   * - 通过响应状态/是否重定向到登录页判断 session 存活
   * 60 秒一次的保活信号，延长 Session 生命周期
   */
  async keepAlive(page: Page): Promise<void> {
    this.stats.totalHeartbeats++;

    try {
      // C2: 页面内发起真实只读 HTTP 请求，携带 session cookie
      const result = await page.evaluate(async () => {
        try {
          const resp = await fetch(window.location.href, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
          });
          return { ok: resp.ok, status: resp.status, redirected: resp.redirected, url: resp.url };
        } catch (e) {
          return { ok: false, status: 0, redirected: false, url: '', error: (e as Error).message };
        }
      });

      const redirectedToLogin = result.redirected
        && (result.url.includes('/login') || result.url.toLowerCase().includes('login'));

      if (redirectedToLogin || result.status === 401 || result.status === 403) {
        this.stats.heartbeatFailures++;
        console.warn(`[SessionManager] 心跳检测到 session 失效: status=${result.status}, url=${result.url}`);
      } else if (!result.ok) {
        this.stats.heartbeatFailures++;
        console.warn(`[SessionManager] 心跳请求失败: status=${result.status}`);
      } else {
        this.stats.lastHeartbeatTime = new Date().toISOString();
      }
    } catch (e) {
      this.stats.heartbeatFailures++;
      console.warn(`[SessionManager] 心跳失败: ${(e as Error).message}`);
    }
  }

  /**
   * 为指定窗口启动定时心跳
   * @param windowId 窗口标识
   * @param page Page 对象
   * @param intervalMs 心跳间隔（默认 60000ms = 60 秒）
   */
  startHeartbeat(windowId: string, page: Page, intervalMs = 60_000): void {
    if (this.heartbeatTimers.has(windowId)) {
      this.stopHeartbeat(windowId);
    }

    console.log(`[SessionManager] 启动心跳: ${windowId} (每 ${intervalMs / 1000}s)`);

    const timer = setInterval(async () => {
      await this.keepAlive(page).catch(() => {});
    }, intervalMs);

    this.heartbeatTimers.set(windowId, timer);
  }

  /** 停止指定窗口的心跳 */
  stopHeartbeat(windowId: string): void {
    const timer = this.heartbeatTimers.get(windowId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(windowId);
      console.log(`[SessionManager] 停止心跳: ${windowId}`);
    }
  }

  /** 停止所有心跳 */
  stopAllHeartbeats(): void {
    for (const [windowId] of this.heartbeatTimers) {
      this.stopHeartbeat(windowId);
    }
  }

  // ── getStats / resetStats ──

  getStats(): SessionStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalChecks: 0,
      validCount: 0,
      expiredCount: 0,
      unknownCount: 0,
      totalRecoveries: 0,
      recoverySuccess: 0,
      recoveryFailure: 0,
      totalRecoveryDurationMs: 0,
      lastRecoveryTime: null,
      lastHeartbeatTime: null,
      totalHeartbeats: 0,
      heartbeatFailures: 0,
    };
  }
}
