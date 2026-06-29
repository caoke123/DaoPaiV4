/**
 * Playwright Runtime — 原生浏览器窗口运行时核心
 *
 * bnsy-operator-next Phase 1 POC 核心模块。
 *
 * 与 legacy BrowserPool 的区别：
 *   - 不使用 EasyBR 指纹浏览器
 *   - 不使用 chromium.connectOverCDP()
 *   - 使用 chromium.launchPersistentContext() 原生启动 Chrome
 *   - 每个窗口独立 userDataDir，持久化登录态
 *
 * 隔离设计（Phase 1-A 补丁）：
 *   - userDataDir: runtime/profiles/{tenantId}/{siteId}/{windowId}/
 *   - runtimeKey:  `${tenantId}:${siteId}:${windowId}`
 *   - 所有 open/close/status/login 操作统一使用 runtimeKey
 *
 * 启动流程：
 *   1. 解析 tenantId/siteId/windowId → 计算 runtimeKey 和 userDataDir
 *   2. chromium.launchPersistentContext(userDataDir, { channel: 'chrome', headless: false })
 *   3. 获取第一个 page（或新建）
 *   4. 导航到 TARGET_DASHBOARD
 *   5. 检测登录状态（PlaywrightLoginVerifier）
 *   6. 如果 autoLogin=true 且在登录页，查找凭据并执行 autoLogin
 *   7. 更新状态（PlaywrightWindowStateStore）
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  TARGET_DASHBOARD,
  TARGET_DOMAIN,
  DEFAULT_TENANT_ID,
  DEFAULT_SITE_ID,
  buildRuntimeKey,
  type PlaywrightWindowOptions,
  type PlaywrightWindowState,
  type PlaywrightLaunchResult,
  type PlaywrightCredential,
  type PlaywrightLoginResult,
  type CloseResult,
  type SessionDebugInfo,
  type PlaywrightWindowStatus,
} from './types';
import { PlaywrightProfileManager } from './PlaywrightProfileManager';
import { PlaywrightLoginVerifier } from './PlaywrightLoginVerifier';
import { PlaywrightWindowStateStore } from './PlaywrightWindowState';
import { P0Verifier, type P0Report } from './P0Verifier';

export class PlaywrightRuntime {
  private static instance: PlaywrightRuntime;

  private readonly profileManager = PlaywrightProfileManager.getInstance();
  private readonly loginVerifier = new PlaywrightLoginVerifier();
  private readonly stateStore = new PlaywrightWindowStateStore();
  private readonly p0Verifier = new P0Verifier();

  static getInstance(): PlaywrightRuntime {
    if (!PlaywrightRuntime.instance) {
      PlaywrightRuntime.instance = new PlaywrightRuntime();
    }
    return PlaywrightRuntime.instance;
  }

  private constructor() {}

  /**
   * 启动一个 Playwright 原生窗口
   *
   * @returns 启动结果，包含窗口状态（含 runtimeKey 和 userDataDir）
   */
  async launchWindow(opts: PlaywrightWindowOptions): Promise<PlaywrightLaunchResult> {
    // ── 解析三元组与 runtimeKey ──
    const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
    const siteId = opts.siteId ?? DEFAULT_SITE_ID;
    const { windowId, windowName, staffName, siteName } = opts;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);
    const tag = `[PlaywrightRuntime/${windowName || runtimeKey}]`;

    // 已存在则先关闭旧的（避免重复启动）
    const existing = this.stateStore.get(runtimeKey);
    if (existing?.context) {
      console.log(`${tag} 检测到已存在窗口，先关闭...`);
      await this.closeWindow(runtimeKey).catch(() => {});
    }

    // 1. 解析 userDataDir（三层隔离）并设置状态为 launching
    const userDataDir = this.profileManager.resolveUserDataDir(tenantId, siteId, windowId);
    this.stateStore.set(runtimeKey, {
      runtimeKey,
      tenantId,
      siteId,
      windowId,
      windowName,
      staffName,
      siteName,
      status: 'launching',
      userDataDir,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
    });

    try {
      // 2. 确保 userDataDir 存在
      await this.profileManager.ensureDir(tenantId, siteId, windowId);
      console.log(`${tag} userDataDir: ${userDataDir}`);
      console.log(`${tag} runtimeKey:   ${runtimeKey}`);

      // 2.5 Phase 2-D-Run 补充修正：禁用 Chrome 密码保存弹窗
      // 写入/合并 Default/Preferences，关闭 credentials_enable_service 与 password_manager_enabled
      // 必须在 launchPersistentContext 之前执行，否则 Chrome 启动时已读取旧 Preferences
      // 写入失败只 warning，不阻断启动
      this.disableChromePasswordManager(userDataDir, tag);

      // 2.6 Phase 4-A 补丁：禁用 Chrome "恢复页面"弹窗（session restore bubble）
      // Chrome 在上次非正常关闭后会弹出"要恢复页面吗？Chrome 未正确关闭。"浏览器 UI 弹窗
      // 该弹窗不是网页 DOM 弹窗，无法通过 page.click 处理
      // 通过写入 Preferences（exit_type=Normal, exited_cleanly=true, session.restore_on_startup=0）处理
      // 必须在 launchPersistentContext 之前执行
      // 写入失败只 warning，不阻断启动
      this.disableChromeSessionRestore(userDataDir, tag);

      // 3. 启动持久化 context
      console.log(`${tag} 正在启动 Chrome（channel=chrome, headless=${opts.headless ?? false}）...`);
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: opts.headless ?? false,
        channel: 'chrome',
        viewport: { width: 1280, height: 800 },
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          // Phase 2-D-Run 补充修正：禁用 Chrome 密码保存弹窗（浏览器 UI，非页面 DOM）
          '--disable-save-password-bubble',
          '--disable-password-manager-reauthentication',
          '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection',
          // Phase 4-A 补丁：禁用 Chrome "恢复页面"弹窗（浏览器 UI，非页面 DOM）
          '--disable-session-crashed-bubble',
          '--restore-last-session=false',
        ],
      });

      // 4. 获取或创建 page
      let page = context.pages()[0];
      if (!page) {
        page = await context.newPage();
      }

      this.stateStore.update(runtimeKey, { context, page });

      // 5. 导航到目标系统
      const initialUrl = opts.initialUrl ?? TARGET_DASHBOARD;
      console.log(`${tag} 导航到 ${initialUrl} ...`);
      await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
        console.warn(`${tag} 初始导航失败: ${(e as Error).message}`);
      });

      // 等待页面稳定：目标系统可能在 DOM 加载后通过 JS 重定向到 /login
      // networkidle 等待网络请求空闲，确保重定向完成
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // 额外等待 1 秒，确保 SPA 路由切换完成
      await new Promise(r => setTimeout(r, 1000));

      // 6. 检测登录状态（在重定向完成后检测，避免误判）
      const isLoginPage = await this.loginVerifier.isLoginPage(page);
      const isLoggedIn = await this.loginVerifier.isLoggedIn(page);
      const currentUrl = page.url();

      console.log(`${tag} 状态: isLoginPage=${isLoginPage}, isLoggedIn=${isLoggedIn}, url=${currentUrl}`);

      this.stateStore.update(runtimeKey, {
        currentUrl,
        isLoginPage,
        isLoggedIn,
      });

      // 7. 自动登录（如果需要）
      if (isLoginPage && opts.autoLogin) {
        this.stateStore.setStatus(runtimeKey, 'logging_in');
        const cred = await this.resolveCredential(opts);
        if (!cred) {
          console.warn(`${tag} 未找到凭据，保持待登录状态`);
          this.stateStore.setStatus(runtimeKey, 'login_required');
        } else {
          const loginResult = await this.loginVerifier.autoLogin(page, cred, windowName);
          if (loginResult.success) {
            this.stateStore.update(runtimeKey, {
              status: 'ready',
              currentUrl: loginResult.finalUrl || page.url(),
              isLoginPage: false,
              isLoggedIn: true,
            });
            // ★ Phase 4-B：READY 守卫 — autoLogin 成功后执行 P0 检查（含标签页整理）
            await this.runP0Check(runtimeKey).catch(e =>
              console.warn(`${tag} autoLogin 后 P0 检查异常: ${(e as Error).message}`)
            );
          } else {
            this.stateStore.setStatus(runtimeKey, 'login_required', loginResult.message);
          }
        }
      } else if (isLoggedIn) {
        this.stateStore.setStatus(runtimeKey, 'ready');
        // ★ Phase 4-B：READY 守卫 — 已登录也执行 P0 检查
        await this.runP0Check(runtimeKey).catch(e =>
          console.warn(`${tag} isLoggedIn 后 P0 检查异常: ${(e as Error).message}`)
        );
      } else if (isLoginPage) {
        this.stateStore.setStatus(runtimeKey, 'login_required');
      } else {
        // 既不在登录页也未登录（可能是其他页面），标记为 ready
        this.stateStore.setStatus(runtimeKey, 'ready');
        // ★ Phase 4-B：READY 守卫 — 其他页面也执行 P0 检查
        await this.runP0Check(runtimeKey).catch(e =>
          console.warn(`${tag} 其他页面 P0 检查异常: ${(e as Error).message}`)
        );
      }

      // 监听 context 关闭事件（手动关闭 Chrome 或外部关闭时触发）
      // ★ Phase 4-I-2: 调用统一 cleanup，清理所有诊断字段
      //   Guard: 只在当前 context 就是关闭的这个 context 时才 cleanup，
      //   避免 launchWindow 先关旧 context 再开新 context 时，旧 close 事件误清新状态
      context.on('close', () => {
        console.log(`${tag} context 已关闭（手动关闭或外部关闭）`);
        const currentState = this.stateStore.get(runtimeKey);
        if (currentState?.context === context) {
          this.clearRuntimeStateForClose(runtimeKey);
        } else {
          console.log(`${tag} 当前 context 已更换，跳过 cleanup`);
        }
      });

      const finalState = this.stateStore.get(runtimeKey);
      console.log(`${tag} ✓ 启动完成，状态: ${finalState?.status}`);
      return { success: true, state: finalState };
    } catch (err) {
      const message = (err as Error).message;
      console.error(`${tag} ✗ 启动失败: ${message}`);
      this.stateStore.setStatus(runtimeKey, 'error', message);
      return { success: false, error: message };
    }
  }

  /**
   * 关闭指定窗口（幂等）— Phase 4-I-2 统一 close 事务
   *
   * 事务流程：
   *   1. busy → 拒绝关闭
   *   2. 尝试关闭 context（try/catch，失败不阻断 cleanup）
   *   3. 调用统一 cleanup（clearRuntimeStateForClose）— 无论关闭成功与否
   *   4. 返回结果
   *
   * 幂等保证：
   *   - 窗口不存在 → success + alreadyClosed
   *   - 已关闭 → 确保 cleanup 已执行 + success + alreadyClosed
   *   - context 不存在但状态非 closed → cleanup + success
   *
   * 支持两种调用方式：
   *   1. closeWindow(runtimeKey) — 直接传 runtimeKey
   *   2. closeWindow(tenantId, siteId, windowId) — 传三元组
   */
  async closeWindow(runtimeKeyOrTenantId: string, siteId?: string, windowId?: string): Promise<CloseResult> {
    const runtimeKey = siteId && windowId
      ? buildRuntimeKey(runtimeKeyOrTenantId, siteId, windowId)
      : runtimeKeyOrTenantId;
    const tag = `[PlaywrightRuntime/${runtimeKey}]`;

    const state = this.stateStore.get(runtimeKey);

    // 窗口不存在 → 幂等返回
    if (!state) {
      console.log(`${tag} 窗口不存在（幂等返回）`);
      return { success: true, alreadyClosed: true, status: 'closed', runtimeKey };
    }

    // busy → 拒绝关闭（前后端双重保护）
    if (state.status === 'busy') {
      console.warn(`${tag} 窗口执行中，拒绝关闭`);
      return { success: false, status: 'busy', runtimeKey };
    }

    // 尝试关闭 context（如果存在）
    if (state.context) {
      try {
        console.log(`${tag} 正在关闭 context...`);
        await state.context.close();
      } catch (err) {
        // 关闭失败不阻断 cleanup — 仍要清理诊断字段
        console.warn(`${tag} 关闭 context 异常（继续 cleanup）: ${(err as Error).message}`);
      }
    }

    // 统一 cleanup — 无论关闭成功与否
    this.clearRuntimeStateForClose(runtimeKey);
    console.log(`${tag} ✓ 已关闭并清理诊断字段`);
    return { success: true, status: 'closed', runtimeKey, alreadyClosed: !state.context };
  }

  /**
   * 关闭所有窗口
   *
   * ⚠️ POC 专用：仅用于 POC 验证和优雅停机。
   * 正式阶段应按 tenantId 维度关闭，避免跨租户误关。
   */
  async closeAll(): Promise<void> {
    const actives = this.stateStore.listActive();
    console.log(`[PlaywrightRuntime] 关闭 ${actives.length} 个活跃窗口...`);
    await Promise.all(actives.map(s => this.closeWindow(s.runtimeKey).catch(() => {})));
    console.log(`[PlaywrightRuntime] ✓ 全部关闭完成`);
  }

  /**
   * 实时刷新窗口状态（Phase 1-C 新增）
   *
   * 对当前 page 做实时检测（URL / isLoginPage / isLoggedIn），
   * 更新缓存状态，并返回最新状态。
   *
   * 用于解决 GET /window 返回缓存状态、手动登录后不实时更新的问题。
   */
  async refreshState(runtimeKey: string): Promise<{
    state?: Omit<PlaywrightWindowState, 'context' | 'page'>;
    notFound: boolean;
  }> {
    const state = this.stateStore.get(runtimeKey);
    if (!state?.page) {
      return { notFound: true };
    }

    const page = state.page;
    const currentUrl = page.url();
    const isLoginPage = await this.loginVerifier.isLoginPage(page);
    const isLoggedIn = await this.loginVerifier.isLoggedIn(page);

    // 计算最新状态码
    let newStatus: PlaywrightWindowStatus;
    if (state.status === 'closed') {
      newStatus = 'closed';
    } else if (state.status === 'launching') {
      newStatus = state.status; // 启动中不打断
    } else if (state.status === 'logging_in') {
      newStatus = state.status; // 登录中不打断
    } else if (state.status === 'busy') {
      newStatus = state.status; // 任务执行中不打断
    } else if (isLoggedIn) {
      newStatus = 'ready';
    } else if (isLoginPage) {
      newStatus = 'login_required';
    } else {
      newStatus = state.status;
    }

    this.stateStore.update(runtimeKey, {
      status: newStatus,
      currentUrl,
      isLoginPage,
      isLoggedIn,
      // ★ Phase 4-B：补充轻量诊断字段（不跑 P0，保持 refreshState 快速）
      // pageCount/activePageUrl 用于前端轮询时发现标签页异常（如 about:blank 或多标签页）
      pageCount: state.context?.pages().length ?? 0,
      activePageUrl: currentUrl,
    });

    console.log(`[PlaywrightRuntime/${runtimeKey}] refresh → status=${newStatus}, url=${currentUrl}, loggedIn=${isLoggedIn}`);

    return {
      state: this.stateStore.toJSON(runtimeKey),
      notFound: false,
    };
  }

  /**
   * 整理标签页 — Phase 4-B READY 守卫
   *
   * 规则：
   *   1. 获取 context.pages()
   *   2. 优先保留 URL 含 bnsy.benniaosuyun.com 的页面
   *   3. 如有多个 bnsy 页，保留第一个（最接近 dashboard 的）
   *   4. 关闭其他页面（about:blank + 重复 bnsy 页），try/catch 失败只 warning
   *   5. 如无任何页面，newPage
   *   6. 如保留页是 about:blank，导航到 TARGET_DASHBOARD
   *   7. 更新 state.page / state.pageCount / state.activePageUrl
   *
   * 安全约束：
   *   - 不在 busy 状态执行（任务执行中不打扰）
   *   - 关闭页面 try/catch，失败只 warning 不阻断
   *
   * @returns { success, pageCount, activePageUrl, page? }
   */
  async ensureSingleBusinessPage(runtimeKey: string): Promise<{
    success: boolean;
    pageCount: number;
    activePageUrl: string;
    page?: import('playwright').Page;
  }> {
    const state = this.stateStore.get(runtimeKey);
    const tag = `[PlaywrightRuntime/${runtimeKey}]`;
    if (!state?.context) {
      return { success: false, pageCount: 0, activePageUrl: '' };
    }
    // busy 状态不打扰（任务执行中）
    if (state.status === 'busy') {
      const url = state.page?.url() ?? '';
      return { success: false, pageCount: 0, activePageUrl: url };
    }

    const context = state.context;
    const pages = context.pages();
    console.log(`${tag} ensureSingleBusinessPage: 当前 ${pages.length} 个标签页`);

    // 1. 优先保留 URL 含业务域名的页面
    let keepPage = pages.find(p => {
      try { return p.url().includes(TARGET_DOMAIN); } catch { return false; }
    });

    // 2. 关闭其他页面（about:blank + 重复 bnsy 页）
    for (const p of pages) {
      if (p === keepPage) continue;
      try {
        const url = p.url();
        console.log(`${tag} 关闭多余标签页: ${url}`);
        await p.close().catch(e => console.warn(`${tag} 关闭标签页失败: ${(e as Error).message}`));
      } catch (e) {
        console.warn(`${tag} 关闭标签页异常: ${(e as Error).message}`);
      }
    }

    // 3. 如无任何页面，newPage
    if (!keepPage) {
      const remaining = context.pages();
      keepPage = remaining[0];
      if (!keepPage) {
        console.log(`${tag} 无任何标签页，新建并导航到 dashboard`);
        keepPage = await context.newPage();
        await keepPage.goto(TARGET_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
          console.warn(`${tag} 导航到 dashboard 失败: ${(e as Error).message}`);
        });
      } else if (keepPage.url() === 'about:blank' || !keepPage.url()) {
        // 保留页是 about:blank → 导航到 dashboard
        console.log(`${tag} 保留页是 about:blank，导航到 dashboard`);
        await keepPage.goto(TARGET_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
          console.warn(`${tag} 导航到 dashboard 失败: ${(e as Error).message}`);
        });
      }
    }

    // 4. 更新 state
    const finalPages = context.pages();
    const activePageUrl = (() => { try { return keepPage?.url() ?? ''; } catch { return ''; } })();
    this.stateStore.update(runtimeKey, {
      page: keepPage,
      pageCount: finalPages.length,
      activePageUrl,
      currentUrl: activePageUrl,
    });

    console.log(`${tag} ensureSingleBusinessPage 完成: ${finalPages.length} 个标签页, url=${activePageUrl}`);
    return { success: true, pageCount: finalPages.length, activePageUrl, page: keepPage };
  }

  /**
   * 执行 P0 检查 — Phase 4-B READY 守卫
   *
   * 流程：
   *   1. 先调用 ensureSingleBusinessPage（清理多余标签页，保留 1 个业务页）
   *   2. 调用 P0Verifier.runFullCheck(page, windowName)
   *   3. 更新 state 的 p0Passed / p0FailedCheck / p0FailedReason / pageCount / activePageUrl / p0CheckedAt
   *   4. 状态调整：
   *      - P0 passed 且原状态是 ready/launching/logging_in/login_required → ready
   *      - P0 failed 且 failedCheck='url_login' → login_required（仍需登录）
   *      - P0 failed 且 failedCheck='url_domain' 且原状态是 ready → error（前端映射为 degraded）
   *      - P0 failed 且原状态是 launching/logging_in → 不改状态（让启动流程继续）
   *
   * 安全约束：
   *   - 不在 busy 状态执行（任务执行中不打扰）
   *   - P0 异常不阻断主流程，只 warning
   *
   * @returns P0Report（即使异常也返回 failed report）
   */
  async runP0Check(runtimeKey: string): Promise<P0Report> {
    const state = this.stateStore.get(runtimeKey);
    const tag = `[PlaywrightRuntime/${runtimeKey}]`;
    if (!state?.page) {
      return {
        source: 'P0Verifier',
        startUrl: '',
        endUrl: '',
        isDashboard: false,
        isLoginPage: false,
        hasCoreDom: false,
        hasBlockingPopup: false,
        popupDismissAttempted: false,
        passed: false,
        failedCheck: 'no_page',
        failedReason: '窗口不存在或 page 不可用',
        rounds: [],
        timestamp: new Date().toISOString(),
      };
    }
    // busy 状态不打扰（任务执行中）
    if (state.status === 'busy') {
      return {
        source: 'P0Verifier',
        startUrl: state.currentUrl ?? '',
        endUrl: state.currentUrl ?? '',
        isDashboard: false,
        isLoginPage: false,
        hasCoreDom: false,
        hasBlockingPopup: false,
        popupDismissAttempted: false,
        passed: false,
        failedCheck: 'busy',
        failedReason: '窗口执行中，跳过 P0 检查',
        rounds: [],
        timestamp: new Date().toISOString(),
      };
    }

    // 1. 先整理标签页
    const normalizeResult = await this.ensureSingleBusinessPage(runtimeKey);
    if (!normalizeResult.success || !normalizeResult.page) {
      console.warn(`${tag} P0 检查前置失败：ensureSingleBusinessPage 未返回 page`);
      this.stateStore.update(runtimeKey, {
        p0Passed: false,
        p0FailedCheck: 'no_page',
        p0FailedReason: '标签页整理失败',
        pageCount: normalizeResult.pageCount,
        activePageUrl: normalizeResult.activePageUrl,
        p0CheckedAt: Date.now(),
      });
      return {
        source: 'P0Verifier',
        startUrl: normalizeResult.activePageUrl,
        endUrl: normalizeResult.activePageUrl,
        isDashboard: false,
        isLoginPage: false,
        hasCoreDom: false,
        hasBlockingPopup: false,
        popupDismissAttempted: false,
        passed: false,
        failedCheck: 'no_page',
        failedReason: '标签页整理失败',
        rounds: [],
        timestamp: new Date().toISOString(),
      };
    }

    // 2. 执行 P0 检查
    const page = normalizeResult.page;
    const windowName = state.windowName || runtimeKey;
    let report: P0Report;
    try {
      report = await this.p0Verifier.runFullCheck(page, windowName);
    } catch (e) {
      console.error(`${tag} P0 检查异常: ${(e as Error).message}`);
      this.stateStore.update(runtimeKey, {
        p0Passed: false,
        p0FailedCheck: 'exception',
        p0FailedReason: (e as Error).message,
        pageCount: normalizeResult.pageCount,
        activePageUrl: normalizeResult.activePageUrl,
        p0CheckedAt: Date.now(),
      });
      return {
        source: 'P0Verifier',
        startUrl: normalizeResult.activePageUrl,
        endUrl: normalizeResult.activePageUrl,
        isDashboard: false,
        isLoginPage: false,
        hasCoreDom: false,
        hasBlockingPopup: false,
        popupDismissAttempted: false,
        passed: false,
        failedCheck: 'exception',
        failedReason: (e as Error).message,
        rounds: [],
        timestamp: new Date().toISOString(),
      };
    }

    // 3. 更新 state 诊断字段
    // ★ 注意：state.status 在第 476 行已被收窄（排除 'busy'），
    //   但 ensureSingleBusinessPage / runFullCheck 期间状态可能被外部改为 busy，
    //   这里用类型断言还原完整联合类型，确保后续 'busy' 比较合法。
    const prevStatus = state.status as PlaywrightWindowStatus;
    this.stateStore.update(runtimeKey, {
      p0Passed: report.passed,
      p0FailedCheck: report.passed ? null : report.failedCheck,
      p0FailedReason: report.passed ? null : report.failedReason,
      pageCount: normalizeResult.pageCount,
      activePageUrl: report.endUrl,
      currentUrl: report.endUrl,
      isLoginPage: report.isLoginPage,
      isLoggedIn: report.passed ? true : state.isLoggedIn,
      p0CheckedAt: Date.now(),
    });

    // 4. 状态调整
    if (report.passed) {
      // P0 passed → 状态设为 ready（覆盖 launching/logging_in/login_required）
      if (prevStatus === 'launching' || prevStatus === 'logging_in' || prevStatus === 'login_required' || prevStatus === 'ready') {
        this.stateStore.setStatus(runtimeKey, 'ready');
        console.log(`${tag} P0 passed → status=ready`);
      }
    } else {
      // P0 failed → 根据 failedCheck 决定状态
      if (report.failedCheck === 'url_login') {
        // 仍在登录页 → login_required
        if (prevStatus !== 'busy' && prevStatus !== 'launching' && prevStatus !== 'logging_in') {
          this.stateStore.setStatus(runtimeKey, 'login_required', report.failedReason);
          console.log(`${tag} P0 failed (url_login) → status=login_required`);
        }
      } else if (prevStatus === 'ready') {
        // 原 ready 但 P0 failed → 降级为 error（前端映射为 degraded）
        this.stateStore.setStatus(runtimeKey, 'error', `P0 failed: ${report.failedCheck} - ${report.failedReason}`);
        console.warn(`${tag} P0 failed (${report.failedCheck}) → status=error (原 ready 降级)`);
      }
      // 其他情况（launching/logging_in/login_required 失败）不改状态，让上层流程处理
    }

    console.log(`${tag} P0 检查完成: passed=${report.passed}, failedCheck=${report.failedCheck}, prevStatus=${prevStatus}`);
    return report;
  }

  /**
   * 获取会话调试信息（Phase 1-C 新增）
   *
   * 综合采集 JWT token 分析 + Cookie 分析 + 登录状态。
   * 用于诊断关闭后登录态失效原因。
   *
   * @param runtimeKey tenantId:siteId:windowId
   */
  async getSessionDebug(runtimeKey: string): Promise<SessionDebugInfo | { error: string }> {
    const state = this.stateStore.get(runtimeKey);
    if (!state?.page) {
      return { error: `窗口 ${runtimeKey} 不存在或未启动` };
    }
    return await this.loginVerifier.collectSessionDebug(state.page, runtimeKey);
  }

  /**
   * 标记窗口为 busy（任务执行中）— Phase 2-A 新增
   *
   * 供 WindowAdapter 调用。任务开始前标记 busy，防止其他任务抢占。
   * 不关闭 context，不影响 page。
   *
   * @returns 成功返回更新后的状态；窗口不存在返回 notFound
   */
  async markBusy(runtimeKey: string): Promise<{ success: boolean; status?: PlaywrightWindowStatus; notFound?: boolean; message?: string }> {
    const state = this.stateStore.get(runtimeKey);
    if (!state) {
      return { success: false, notFound: true, message: `窗口 ${runtimeKey} 不存在` };
    }
    if (state.status === 'closed') {
      return { success: false, status: 'closed', message: `窗口 ${runtimeKey} 已关闭，无法标记 busy` };
    }
    if (state.status === 'busy') {
      return { success: true, status: 'busy', message: `窗口 ${runtimeKey} 已是 busy 状态` };
    }
    this.stateStore.setStatus(runtimeKey, 'busy');
    console.log(`[PlaywrightRuntime/${runtimeKey}] markBusy → busy`);
    return { success: true, status: 'busy' };
  }

  /**
   * 标记窗口为 ready（任务完成后）— Phase 2-A 新增
   *
   * 供 WindowAdapter 调用。任务结束后标记 ready。
   * **不关闭 context**，窗口保持打开，遵循 Phase 1-C 窗口生命周期策略。
   *
   * @returns 成功返回更新后的状态；窗口不存在返回 notFound
   */
  async markReady(runtimeKey: string): Promise<{ success: boolean; status?: PlaywrightWindowStatus; notFound?: boolean; message?: string }> {
    const state = this.stateStore.get(runtimeKey);
    if (!state) {
      return { success: false, notFound: true, message: `窗口 ${runtimeKey} 不存在` };
    }
    if (state.status === 'closed') {
      return { success: false, status: 'closed', message: `窗口 ${runtimeKey} 已关闭，无法标记 ready` };
    }
    // markReady 不关闭 context，只改状态
    this.stateStore.setStatus(runtimeKey, 'ready');
    console.log(`[PlaywrightRuntime/${runtimeKey}] markReady → ready（不关闭 context）`);
    return { success: true, status: 'ready' };
  }

  /**
   * 获取窗口状态
   * @param runtimeKey tenantId:siteId:windowId
   */
  getWindowState(runtimeKey: string): PlaywrightWindowState | undefined {
    return this.stateStore.get(runtimeKey);
  }

  /**
   * 通过三元组获取窗口状态
   */
  getWindowStateByTriple(tenantId: string, siteId: string, windowId: string): PlaywrightWindowState | undefined {
    return this.stateStore.findByTriple(tenantId, siteId, windowId);
  }

  /**
   * 获取窗口状态（可序列化，用于 API 返回）
   * @param runtimeKey tenantId:siteId:windowId
   */
  getWindowStateJSON(runtimeKey: string): Omit<PlaywrightWindowState, 'context' | 'page'> | undefined {
    return this.stateStore.toJSON(runtimeKey);
  }

  /**
   * 列出所有窗口状态（可序列化）
   */
  listWindowsJSON(): Array<Omit<PlaywrightWindowState, 'context' | 'page'>> {
    return this.stateStore.listJSON();
  }

  /** 获取活跃窗口数量 */
  getActiveCount(): number {
    return this.stateStore.listActive().length;
  }

  /**
   * 获取当前页面对象（供后续业务操作使用）
   * @param runtimeKey tenantId:siteId:windowId
   */
  getPage(runtimeKey: string) {
    return this.stateStore.get(runtimeKey)?.page;
  }

  /**
   * 获取当前 context 对象
   * @param runtimeKey tenantId:siteId:windowId
   */
  getContext(runtimeKey: string) {
    return this.stateStore.get(runtimeKey)?.context;
  }

  /**
   * 手动触发登录（用于窗口已启动但未登录时）
   * @param runtimeKey tenantId:siteId:windowId
   */
  async manualLogin(
    runtimeKey: string,
    credential: PlaywrightCredential,
  ): Promise<PlaywrightLoginResult> {
    const state = this.stateStore.get(runtimeKey);
    if (!state?.page) {
      return {
        success: false,
        reason: 'not_on_login_page',
        message: `窗口 ${runtimeKey} 不存在或未启动`,
      };
    }
    this.stateStore.setStatus(runtimeKey, 'logging_in');
    const result = await this.loginVerifier.autoLogin(state.page, credential, state.windowName);
    if (result.success) {
      this.stateStore.update(runtimeKey, {
        status: 'ready',
        currentUrl: result.finalUrl || state.page.url(),
        isLoginPage: false,
        isLoggedIn: true,
      });
    } else {
      this.stateStore.setStatus(runtimeKey, 'login_required', result.message);
    }
    return result;
  }

  // ── 内部方法 ──

  /**
   * 统一清理窗口诊断字段 — Phase 4-I-2
   *
   * 关闭窗口时调用，清理所有旧诊断字段，防止下次启动时残留：
   *   - p0Passed / p0FailedCheck / p0FailedReason / p0CheckedAt
   *   - currentUrl / activePageUrl / pageCount
   *   - isLoginPage / isLoggedIn
   *   - context / page 引用
   *   - error
   *
   * 保留身份字段：runtimeKey / tenantId / siteId / windowId / windowName / staffName / siteName / userDataDir / createdAt
   *
   * 幂等：多次调用安全，结果一致。
   */
  private clearRuntimeStateForClose(runtimeKey: string): void {
    this.stateStore.update(runtimeKey, {
      status: 'closed',
      p0Passed: undefined,
      p0FailedCheck: null,
      p0FailedReason: null,
      p0CheckedAt: undefined,
      pageCount: undefined,
      activePageUrl: undefined,
      currentUrl: undefined,
      isLoginPage: undefined,
      isLoggedIn: undefined,
      context: undefined,
      page: undefined,
      error: undefined,
    });
  }

  /**
   * 解析登录凭据
   *
   * 优先级：
   *   1. opts.credential（显式提供）
   *   2. SettingsManager（data/settings.json，按 staffName 查找）
   *   3. ⚠️ LEGACY: credentials.ts findCredential（仅 POC 阶段兜底）
   *
   * ⚠️ credentials.ts 是 legacy fallback，仅用于 Phase 1 POC 兼容测试。
   * 新项目长期方向是 Settings Center / tenant settings / database credentials。
   * 会员系统阶段不得继续依赖 credentials.ts 作为主凭据来源。
   */
  private async resolveCredential(opts: PlaywrightWindowOptions): Promise<PlaywrightCredential | null> {
    // 1. 显式提供
    if (opts.credential?.account && opts.credential?.password) {
      return opts.credential;
    }

    // 2. SettingsManager（新项目主凭据来源）
    if (opts.staffName) {
      try {
        const cred = await this.lookupCredentialFromSettings(opts.staffName, opts.siteName);
        if (cred) return cred;
      } catch (e) {
        console.warn(`[PlaywrightRuntime] SettingsManager 查找凭据失败: ${(e as Error).message}`);
      }

      // 3. ⚠️ LEGACY FALLBACK: credentials.ts
      // 仅用于 Phase 1 POC 兼容测试，会员系统阶段必须移除。
      try {
        const { findCredential } = await import('../config/credentials');
        const fallback = findCredential(opts.staffName);
        if (fallback?.account && fallback?.password) {
          console.warn(
            `[PlaywrightRuntime] ⚠️ 使用 legacy credentials.ts fallback，仅限 POC 阶段。` +
            `会员系统阶段不得依赖此路径。staffName=${opts.staffName}, account=${fallback.account}`,
          );
          return { account: fallback.account, password: fallback.password };
        }
      } catch {
        // credentials.ts 可能不存在（在 .gitignore 中），忽略
      }
    }

    return null;
  }

  /**
   * 从 SettingsManager 查找明文凭据
   */
  private async lookupCredentialFromSettings(
    staffName: string,
    siteName?: string,
  ): Promise<PlaywrightCredential | null> {
    const { SettingsManager } = await import('../config/SettingsManager');
    const mgr = SettingsManager.getInstance();
    const config = await mgr.getConfig();
    if (!config?.sites) return null;

    for (const site of config.sites) {
      // 如果指定了 siteName，先按 site.name 过滤
      if (siteName && site.name !== siteName && site.id !== siteName) continue;
      for (const w of site.windows) {
        if (w.employeeName === staffName || w.windowName === staffName) {
          if (w.username && w.password) {
            console.log(`[PlaywrightRuntime] 使用 settings.json 凭据: staffName=${staffName}, account=${w.username}`);
            return { account: w.username, password: w.password };
          }
        }
      }
    }
    return null;
  }

  /**
   * 禁用 Chrome 密码保存弹窗（Phase 2-D-Run 补充修正）
   *
   * Chrome 在登录后会弹出"是否保存密码"的浏览器 UI 弹窗。
   * 该弹窗不是网页 DOM 弹窗，无法通过 page.click 处理，
   * 应在 launchPersistentContext 之前写入 Chrome Preferences 关闭密码管理器。
   *
   * 写入目标：{userDataDir}/Default/Preferences
   * 必须保证以下配置存在（不覆盖已有数据，仅合并）：
   *   - credentials_enable_service: false
   *   - profile.password_manager_enabled: false
   *
   * 安全要求：
   *   - 不打印账号密码（本方法也不接触账号密码）
   *   - 写入失败只 warning，不阻断启动
   *   - 不覆盖已有 cookies / localStorage / session 数据
   *
   * @param userDataDir Chrome 用户数据目录
   * @param tag 日志前缀
   */
  private disableChromePasswordManager(userDataDir: string, tag: string): void {
    const preferencesPath = join(userDataDir, 'Default', 'Preferences');
    try {
      // 确保 Default 目录存在
      const defaultDir = dirname(preferencesPath);
      if (!existsSync(defaultDir)) {
        mkdirSync(defaultDir, { recursive: true });
      }

      // 读取已有 Preferences（如有）
      let prefs: Record<string, any> = {};
      if (existsSync(preferencesPath)) {
        try {
          const raw = readFileSync(preferencesPath, 'utf-8');
          prefs = JSON.parse(raw);
          if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
            console.warn(`${tag} Preferences 已存在但非对象，将保留原文件并跳过合并`);
            prefs = {};
          }
        } catch (parseErr) {
          // 解析失败不阻断：保留原文件，使用空对象写入最小结构
          console.warn(`${tag} Preferences 解析失败: ${(parseErr as Error).message}，将使用最小结构`);
          prefs = {};
        }
      }

      // 合并目标配置（不覆盖已有字段，仅在缺失时设置）
      let changed = false;
      if (prefs.credentials_enable_service !== false) {
        prefs.credentials_enable_service = false;
        changed = true;
      }
      prefs.profile = prefs.profile || {};
      if (prefs.profile.password_manager_enabled !== false) {
        prefs.profile.password_manager_enabled = false;
        changed = true;
      }

      if (!changed) {
        console.log(`${tag} Preferences 已禁用密码管理器，跳过写入`);
        return;
      }

      // 原子写入：先写 .tmp，再 rename 覆盖，防断电损坏
      const tmpPath = preferencesPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(prefs), 'utf-8');
      // Node.js fs.renameSync 在 Windows 上能原子覆盖已存在文件
      renameSync(tmpPath, preferencesPath);
      console.log(`${tag} ✓ 已禁用 Chrome 密码保存弹窗（写入 Preferences）`);
    } catch (err) {
      // 写入失败只 warning，不阻断启动
      console.warn(`${tag} ⚠️ 禁用 Chrome 密码管理器失败（不阻断启动）: ${(err as Error).message}`);
    }
  }

  /**
   * Phase 4-A 补丁：禁用 Chrome "恢复页面"弹窗（session restore bubble）
   *
   * Chrome 在上次非正常关闭（人工点 X / 进程被强制结束 / keep-open 调试后未优雅退出）后，
   * 下次启动会弹出"要恢复页面吗？Chrome 未正确关闭。"浏览器 UI 弹窗。
   *
   * 该弹窗不是网页 DOM 弹窗，无法通过 page.click 处理（且禁止用 page.click 处理）。
   * 应在 launchPersistentContext 之前写入 Chrome Preferences，将上次标记为正常退出，
   * 并禁止启动时恢复会话。
   *
   * 写入目标：{userDataDir}/Default/Preferences
   * 必须保证以下配置存在（不覆盖已有数据，仅合并）：
   *   - profile.exit_type = "Normal"
   *   - profile.exited_cleanly = true
   *   - session.restore_on_startup = 0
   *
   * 安全要求：
   *   - 不打印账号密码（本方法不接触账号密码）
   *   - 写入失败只 warning，不阻断启动
   *   - 不覆盖已有 cookies / localStorage / session 数据（仅合并上述字段）
   *   - 原子写入：.tmp → rename
   *
   * @param userDataDir Chrome 用户数据目录
   * @param tag 日志前缀
   */
  private disableChromeSessionRestore(userDataDir: string, tag: string): void {
    const preferencesPath = join(userDataDir, 'Default', 'Preferences');
    try {
      // 确保 Default 目录存在
      const defaultDir = dirname(preferencesPath);
      if (!existsSync(defaultDir)) {
        mkdirSync(defaultDir, { recursive: true });
      }

      // 读取已有 Preferences（如有）
      let prefs: Record<string, any> = {};
      if (existsSync(preferencesPath)) {
        try {
          const raw = readFileSync(preferencesPath, 'utf-8');
          prefs = JSON.parse(raw);
          if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
            console.warn(`${tag} Preferences 已存在但非对象，将保留原文件并跳过合并`);
            prefs = {};
          }
        } catch (parseErr) {
          console.warn(`${tag} Preferences 解析失败: ${(parseErr as Error).message}，将使用最小结构`);
          prefs = {};
        }
      }

      // 合并目标配置（不覆盖已有字段，仅在缺失或值不符时设置）
      let changed = false;
      prefs.profile = prefs.profile || {};
      if (prefs.profile.exit_type !== 'Normal') {
        prefs.profile.exit_type = 'Normal';
        changed = true;
      }
      if (prefs.profile.exited_cleanly !== true) {
        prefs.profile.exited_cleanly = true;
        changed = true;
      }
      prefs.session = prefs.session || {};
      if (prefs.session.restore_on_startup !== 0) {
        prefs.session.restore_on_startup = 0;
        changed = true;
      }

      if (!changed) {
        console.log(`${tag} Preferences 已禁用会话恢复弹窗，跳过写入`);
        return;
      }

      // 原子写入：先写 .tmp，再 rename 覆盖，防断电损坏
      const tmpPath = preferencesPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(prefs), 'utf-8');
      renameSync(tmpPath, preferencesPath);
      console.log(`${tag} ✓ 已禁用 Chrome 恢复页面弹窗（写入 Preferences）`);
    } catch (err) {
      // 写入失败只 warning，不阻断启动
      console.warn(`${tag} ⚠️ 禁用 Chrome 会话恢复弹窗失败（不阻断启动）: ${(err as Error).message}`);
    }
  }
}
