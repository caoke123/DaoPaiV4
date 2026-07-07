/**
 * Playwright Login Verifier — 登录状态判断与自动登录
 *
 * 参考 legacy BrowserPool.checkAndAutoLogin 的逻辑，但完全基于 Playwright 原生 Page。
 *
 * 登录页判断：URL 包含 /login 或 Login
 * 登录表单选择器（来自 legacy 观察）：
 *   - 账号输入框: input[placeholder="请输入账号"]
 *   - 密码输入框: input[placeholder="请输入密码"]
 *   - 登录按钮（按优先级）:
 *       1. button.submitBtn
 *       2. button.el-button--primary
 *       3. button:has-text("登录")
 *       4. button:has-text("立即登录")
 *       5. button[type="submit"]
 *
 * 登录后守卫策略（Phase 5-G-8-3）：
 *   - 登录阶段使用 NativeAlertGuard drain 原生 alert（如"网点余额低于警戒金额!"）
 *   - 点击登录前 forceAccept 一次，登录后 drain 2000ms
 *   - 未进入 dashboard 再 forceAccept 重试一次，仍失败才关闭窗口重登
 */
import type { Page, Cookie } from 'playwright';
import {
  TARGET_DOMAIN,
  TARGET_LOGIN_PAGE_HINTS,
  type PlaywrightCredential,
  type PlaywrightLoginResult,
  type JwtDebugInfo,
  type CookieDebugInfo,
  type CookieAnalysisResult,
  type SessionDebugInfo,
} from './types';
import { PopupManager } from '../browser/PopupManager';
import { NativeAlertGuard, drainNativeAlerts, forceAcceptCurrentNativeAlert } from '../browser/NativeAlertGuard';

/** 笨鸟速运系统可能使用的 localStorage token key 名（按优先级） */
const JWT_STORAGE_KEY_CANDIDATES = [
  'token',
  'accessToken',
  'access_token',
  'jwt',
  'jwtToken',
  'Authorization',
  'authToken',
  'bnsy_token',
];

export class PlaywrightLoginVerifier {
  /**
   * 判断当前页面是否在登录页
   * 规则：URL 包含 /login 或 Login
   */
  async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url();
    return TARGET_LOGIN_PAGE_HINTS.some(hint => url.includes(hint));
  }

  /**
   * 判断当前页面是否已登录
   * 规则：在目标域名下，且 URL 不含 /login / Login
   */
  async isLoggedIn(page: Page): Promise<boolean> {
    const url = page.url();
    if (!url.includes(TARGET_DOMAIN)) return false;
    if (TARGET_LOGIN_PAGE_HINTS.some(hint => url.includes(hint))) return false;
    return true;
  }

  async waitForDashboardReady(page: Page, timeoutMs = 3000): Promise<boolean> {
    try {
      await page.waitForFunction(
        () => window.location.href.includes('/dashboard'),
        { timeout: timeoutMs },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 探测登录页表单元素是否存在
   */
  async probeLoginForm(page: Page): Promise<{
    hasAccountInput: boolean;
    hasPasswordInput: boolean;
    hasLoginButton: boolean;
  }> {
    const accountInput = await page.$('input[placeholder="请输入账号"]').catch(() => null);
    const passwordInput = await page.$('input[placeholder="请输入密码"]').catch(() => null);
    const loginButton = await this.findLoginButton(page);
    return {
      hasAccountInput: !!accountInput,
      hasPasswordInput: !!passwordInput,
      hasLoginButton: !!loginButton,
    };
  }

  /**
   * 执行自动登录流程
   *
   * 流程：
   *   1. 检测是否在登录页（不在则返回 already_logged_in）
   *   2. 等待表单元素出现
   *   3. 填入账号密码
   *   4. 点击登录按钮
   *   5. 等待 URL 跳转
   *   6. 导航到 /dashboard（如果不在）
   */
  async autoLogin(page: Page, cred: PlaywrightCredential, windowName?: string): Promise<PlaywrightLoginResult> {
    const tag = windowName ? `[${windowName}]` : '[PlaywrightRuntime]';

    // 1. 检测登录页
    const onLoginPage = await this.isLoginPage(page);
    if (!onLoginPage) {
      const isLoggedIn = await this.isLoggedIn(page);
      if (isLoggedIn) {
        return {
          success: true,
          reason: 'already_logged_in',
          finalUrl: page.url(),
          message: `${tag} 已登录，无需重新登录`,
        };
      }
      return {
        success: false,
        reason: 'not_on_login_page',
        finalUrl: page.url(),
        message: `${tag} 不在登录页也不在已登录状态，URL: ${page.url()}`,
      };
    }

    // 2. 等待表单
    await page.waitForSelector('input[placeholder="请输入账号"]', { timeout: 10000 }).catch(() => {});

    const accountInput = await page.$('input[placeholder="请输入账号"]').catch(() => null);
    const passwordInput = await page.$('input[placeholder="请输入密码"]').catch(() => null);

    if (!accountInput || !passwordInput) {
      return {
        success: false,
        reason: 'no_login_form',
        finalUrl: page.url(),
        message: `${tag} 未找到账号/密码输入框`,
      };
    }

    // 3. 填入凭据
    await accountInput.click({ clickCount: 3 }).catch(() => {});
    await accountInput.fill(cred.account);
    await passwordInput.click({ clickCount: 3 }).catch(() => {});
    await passwordInput.fill(cred.password);
    console.log(`${tag} 已填入账号密码: ${cred.account}`);

    // Phase 5-G-8-3: 登录守卫策略改为 drain 原生弹窗
    // 不再 suspendDialogHandling，而是主动清理 alert
    const popupMgr = PopupManager.getInstance();
    // 确保 NativeAlertGuard 已挂载（page 创建时已挂载，这里兜底）
    if (!NativeAlertGuard.getInstance().isAttached(page)) {
      NativeAlertGuard.getInstance().attachNativeAlertGuard(page, {
        scope: 'login',
        log: (level, msg) => {
          if (level === 'warn') console.warn(`${tag}${msg}`);
          else console[level](`${tag}${msg}`);
        },
      });
    }
    console.log(`${tag} [LoginGuard] 登录阶段启用 NativeAlertGuard drain 策略`);

    // 4. 点击登录前先 forceAccept 一次（可能有登录前的 alert）
    await forceAcceptCurrentNativeAlert(page, {
      scope: 'before-login-click',
      log: (level, msg) => {
        if (level === 'warn') console.warn(`${tag}${msg}`);
        else console[level](`${tag}${msg}`);
      },
    }).catch(() => {});

    // 5. 点击登录按钮
    const loginButton = await this.findLoginButton(page);
    if (!loginButton) {
      return {
        success: false,
        reason: 'no_login_form',
        finalUrl: page.url(),
        message: `${tag} 未找到登录按钮`,
      };
    }

    await loginButton.click();
    console.log(`${tag} 已点击登录按钮，drain 原生弹窗并等待进入首页...`);

    // 6. 登录后 drain 原生弹窗（alert 可能延迟出现）
    await drainNativeAlerts(page, {
      durationMs: 2000,
      intervalMs: 200,
      scope: 'after-login',
      log: (level, msg) => {
        if (level === 'warn') console.warn(`${tag}${msg}`);
        else console[level](`${tag}${msg}`);
      },
    }).catch(() => 0);

    // 7. 检查是否进入 dashboard
    const dashboardReady = await this.waitForDashboardReady(page, 3000);

    if (!dashboardReady) {
      // 再 forceAccept 一次，可能 alert 刚出现
      await forceAcceptCurrentNativeAlert(page, {
        scope: 'dashboard-retry',
        log: (level, msg) => {
          if (level === 'warn') console.warn(`${tag}${msg}`);
          else console[level](`${tag}${msg}`);
        },
      }).catch(() => {});
      const retryReady = await this.waitForDashboardReady(page, 2000);
      if (!retryReady) {
        return {
          success: false,
          reason: 'timeout',
          finalUrl: page.url(),
          message: `${tag} 登录后未进入首页（已 drain 原生弹窗），URL: ${page.url()}`,
        };
      }
    }

    const afterLoginUrl = page.url();
    console.log(`${tag} 登录成功，当前 URL: ${afterLoginUrl}`);

    return {
      success: true,
      reason: 'login_succeeded',
      finalUrl: page.url(),
      message: `${tag} 自动登录成功`,
    };
  }

  /** 按优先级查找登录按钮 */
  private async findLoginButton(page: Page) {
    const selectors = [
      'button.submitBtn',
      'button.el-button--primary',
      'button:has-text("登录")',
      'button:has-text("立即登录")',
      'button[type="submit"]',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) return btn;
    }
    return null;
  }

  // ── Phase 1-C：会话调试方法 ──

  /**
   * 分析 Cookie 和 localStorage 中的 JWT token
   *
   * Phase 1-C 改进：先查 Cookie（笨鸟速运系统实际把 JWT 放在名为 Jwt-Token 的
   * session cookie 中），再查 localStorage。
   *
   * 找到第一个形如 JWT 格式（三段 base64）的值后：
   *   - 解析 header 和 payload
   *   - 提取 iat / exp
   *   - 计算是否过期 / 剩余秒数
   * token 脱敏显示：前 12 位 + ... + 后 6 位
   */
  async analyzeJwt(page: Page): Promise<JwtDebugInfo> {
    const now = Date.now();
    const nowLocalTime = new Date(now).toISOString();

    let rawToken: string | null = null;
    let storageKey = '';

    // 1. 先从 Cookie 中查找（笨鸟速运实际位置：Jwt-Token session cookie）
    try {
      const allCookies = await page.context().cookies(page.url());
      const targetCookies = allCookies.filter(c =>
        c.domain.includes(TARGET_DOMAIN) || c.domain.includes('benniaosuyun'),
      );
      // 优先匹配 Jwt-Token / token / accessToken 等候选名
      const candidateNames = ['Jwt-Token', ...JWT_STORAGE_KEY_CANDIDATES];
      for (const name of candidateNames) {
        const hit = targetCookies.find(c => c.name === name);
        if (hit && this.looksLikeJwt(hit.value)) {
          rawToken = hit.value;
          storageKey = `cookie:${hit.name}`;
          break;
        }
      }
      // 兜底：扫描所有 cookie 找 JWT 格式
      if (!rawToken) {
        for (const c of targetCookies) {
          if (this.looksLikeJwt(c.value)) {
            rawToken = c.value;
            storageKey = `cookie:${c.name}`;
            break;
          }
        }
      }
    } catch (e) {
      // 读取 cookie 失败不致命，继续尝试 localStorage
      console.warn(`[analyzeJwt] 读取 cookie 失败: ${(e as Error).message}`);
    }

    // 2. 如果 Cookie 中未找到，再查 localStorage
    if (!rawToken) {
      try {
        const entries = await page.evaluate((candidates: string[]) => {
          const result: { key: string; value: string }[] = [];
          for (const k of candidates) {
            const v = localStorage.getItem(k);
            if (v) result.push({ key: k, value: v });
          }
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && !candidates.includes(k)) {
              const v = localStorage.getItem(k);
              if (v && v.length > 40 && v.includes('.')) {
                result.push({ key: k, value: v });
              }
            }
          }
          return result;
        }, JWT_STORAGE_KEY_CANDIDATES);

        for (const entry of entries) {
          if (this.looksLikeJwt(entry.value)) {
            rawToken = entry.value;
            storageKey = `localStorage:${entry.key}`;
            break;
          }
        }
      } catch (e) {
        return {
          found: false,
          nowLocalTime,
          expired: false,
          parseError: `读取 localStorage 失败: ${(e as Error).message}`,
        };
      }
    }

    if (!rawToken) {
      return { found: false, nowLocalTime, expired: false };
    }

    // 3. 解析 JWT
    const parts = rawToken.split('.');
    if (parts.length !== 3) {
      return {
        found: true,
        storageKey,
        tokenMasked: this.maskToken(rawToken),
        nowLocalTime,
        expired: false,
        parseError: `token 不是标准 JWT 格式（${parts.length} 段）`,
      };
    }

    try {
      const header = this.decodeBase64ToJson(parts[0]);
      const payload = this.decodeBase64ToJson(parts[1]);

      const exp = typeof payload.exp === 'number' ? payload.exp : undefined;
      const iat = typeof payload.iat === 'number' ? payload.iat : undefined;

      // exp 是 Unix 秒级时间戳
      const expMs = exp ? exp * 1000 : undefined;
      const expired = expMs ? now >= expMs : false;
      const remainingSeconds = expMs ? Math.floor((expMs - now) / 1000) : undefined;

      return {
        found: true,
        storageKey,
        tokenMasked: this.maskToken(rawToken),
        header: {
          alg: typeof header.alg === 'string' ? header.alg : undefined,
          typ: typeof header.typ === 'string' ? header.typ : undefined,
        },
        payload: {
          iat,
          exp,
          ...this.sanitizePayload(payload),
        },
        expLocalTime: expMs ? new Date(expMs).toISOString() : undefined,
        nowLocalTime,
        expired,
        remainingSeconds,
      };
    } catch (e) {
      return {
        found: true,
        storageKey,
        tokenMasked: this.maskToken(rawToken),
        nowLocalTime,
        expired: false,
        parseError: `解析 JWT 失败: ${(e as Error).message}`,
      };
    }
  }

  /**
   * 分析当前 domain 下的 Cookie
   *
   * 使用 page.context().cookies() 获取，过滤目标 domain 的 cookie。
   * 脱敏：不打印 value，只打印属性。
   */
  async analyzeCookies(page: Page): Promise<CookieAnalysisResult> {
    let allCookies: Cookie[] = [];
    try {
      // 获取当前 page URL 对应的 cookies
      allCookies = await page.context().cookies(page.url());
    } catch (e) {
      return {
        count: 0,
        names: [],
        hasSessionCookie: false,
        hasPersistentCookie: false,
        cookies: [],
      };
    }

    // 过滤目标 domain 相关的 cookie
    const targetCookies = allCookies.filter(c =>
      c.domain.includes(TARGET_DOMAIN) || c.domain.includes('benniaosuyun'),
    );

    const cookies: CookieDebugInfo[] = targetCookies.map(c => {
      // Playwright Cookie: expires 为 Unix 秒级时间戳，-1 或 0 表示 session cookie
      const isSession = !c.expires || c.expires <= 0;
      const hasExpires = !isSession;
      const expiresMs = hasExpires ? c.expires * 1000 : null;

      return {
        name: c.name,
        domain: c.domain,
        isSession,
        hasExpires,
        expiresLocalTime: hasExpires && expiresMs
          ? new Date(expiresMs).toISOString()
          : null,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      };
    });

    return {
      count: cookies.length,
      names: cookies.map(c => c.name),
      hasSessionCookie: cookies.some(c => c.isSession),
      hasPersistentCookie: cookies.some(c => !c.isSession),
      cookies,
    };
  }

  /**
   * 综合收集会话调试信息（JWT + Cookie + 状态）
   */
  async collectSessionDebug(page: Page, runtimeKey: string): Promise<SessionDebugInfo> {
    const [isLoginPage, isLoggedIn, jwt, cookies] = await Promise.all([
      this.isLoginPage(page),
      this.isLoggedIn(page),
      this.analyzeJwt(page),
      this.analyzeCookies(page),
    ]);

    return {
      runtimeKey,
      currentUrl: page.url(),
      isLoginPage,
      isLoggedIn,
      jwt,
      cookies,
      collectedAt: Date.now(),
    };
  }

  // ── 内部工具方法 ──

  /** 脱敏 token：前 12 位 + ... + 后 6 位 */
  private maskToken(token: string): string {
    if (token.length <= 18) return '***';
    return `${token.slice(0, 12)}...${token.slice(-6)}`;
  }

  /**
   * 判断字符串是否符合 JWT 格式（三段 base64url，以 . 分隔）
   *
   * 用于在 Cookie / localStorage 中过滤出真正的 JWT，排除 JSON 对象等非 JWT 值。
   * 规则：
   *   1. 长度 >= 40（JWT 通常远长于此）
   *   2. 包含两个 '.'
   *   3. 三段都非空
   *   4. 第一段（header）可被 base64url 解码为 JSON 且含 alg 字段
   */
  private looksLikeJwt(value: string): boolean {
    if (typeof value !== 'string' || value.length < 40) return false;
    const parts = value.split('.');
    if (parts.length !== 3 || parts.some(p => p.length === 0)) return false;
    try {
      const header = this.decodeBase64ToJson(parts[0]);
      return typeof header.alg === 'string';
    } catch {
      return false;
    }
  }

  /** Base64URL 解码为 JSON 对象 */
  private decodeBase64ToJson(b64: string): Record<string, unknown> {
    // JWT 使用 Base64URL，需替换字符并补齐 padding
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  }

  /** 过滤 payload 中的敏感字段（如密码），保留业务字段 */
  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['password', 'passwd', 'secret', 'credential'];
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        result[key] = '***';
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}
