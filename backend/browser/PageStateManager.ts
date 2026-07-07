// PageStateManager — 页面状态安检门
// Phase D-2A: 任务执行前的 6 项检查 + autoFix + remediate
// Phase D-2B: 登录检查委托给 SessionManager，不再直接判断登录状态
// 确保: 已登录 → URL 正确 → 无弹窗 → 侧边栏展开 → 关键元素可见

import type { Page } from 'playwright';
import { PopupManager, type VisiblePopup } from './PopupManager';
import { SessionManager, AuthenticationError } from './SessionManager';
import { NavigationGovernance } from './NavigationGovernance';
import { RuntimeMetrics } from '../runtime/RuntimeMetrics';
import { drainNativeAlerts, forceAcceptCurrentNativeAlert } from './NativeAlertGuard';

// ── 类型定义 ──────────────────────────────────────────

export type WindowCapability = 'arrival' | 'dispatch' | 'sign' | 'integrated';

/** 操作类型对应的目标路由 */
const CAPABILITY_ROUTES: Record<WindowCapability, string> = {
  arrival: '/scanning/ArrivalscanBatch',
  dispatch: '/scanning/dispatchscan',
  sign: '/scanning/signFor/signForInput',
  integrated: '/scanning/arrivalscan',
};

/** 各操作类型对应的关键元素（最低限度验证） */
const CAPABILITY_KEY_ELEMENTS: Record<WindowCapability, string[]> = {
  arrival: ['textarea', 'button.el-button--danger'],
  // 派件扫描:用左侧区域一定可见的元素(运单输入框 + 添加按钮)
  // 不用上传按钮(button.el-button--success),因为表格为空时它可能不可见
  dispatch: ['.dispatchscan_left input', '.dispatchscan_left button.el-button--primary'],
  // 签收录入: 搜索按钮(在 .item-actions 内) + 日期选择器(始终可见)
  sign: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor'],
  // 到派一体:用 #waybillNum(用户提供的 ID)+ 添加按钮,表格为空时上传按钮可能不可见
  integrated: ['#waybillNum', '.arrivalscan_left button.el-button--primary'],
};

export interface LoginCheckResult {
  loggedIn: boolean;
  currentUrl: string;
  detectedLoginPage: boolean;
  detectedSessionExpired: boolean;
  pageTitle: string;
}

export interface UrlCheckResult {
  matches: boolean;
  expected: string;
  actual: string;
  redirectDetected: boolean;
}

export interface ElementCheckResult {
  allPresent: boolean;
  found: string[];
  missing: string[];
  timeout: boolean;
  /** 检查时页面是否有可见弹窗遮挡 */
  popupsBlocking: boolean;
}

export interface PopupCheckResult {
  clean: boolean;
  visiblePopups: VisiblePopup[];
  cleanupAttempted: boolean;
  cleanupSucceeded: boolean;
}

export interface SidebarCheckResult {
  expanded: boolean;
  wasCollapsed: boolean;
  expandTimeMs: number;
  localStorageValue: string;
}

export interface StateRemediation {
  action: 'auto_login' | 'navigate' | 'dismiss_popups' | 'expand_sidebar' | 'reload' | 'manual';
  description: string;
  autoFixable: boolean;
}

export interface StateCheckResult {
  ready: boolean;
  login: LoginCheckResult;
  url: UrlCheckResult;
  elements: ElementCheckResult;
  popups: PopupCheckResult;
  sidebar: SidebarCheckResult;
  remediation?: StateRemediation;
  blockedBy: string[];
}

export interface StateCheckOptions {
  skipLoginCheck?: boolean;
  skipUrlCheck?: boolean;
  skipElementCheck?: boolean;
  skipPopupCheck?: boolean;
  skipSidebarCheck?: boolean;
  autoFix?: boolean;
  maxAutoFixRetries?: number;
  perfLog?: (message: string) => void;
  perfLabel?: string;
}

const BASE_URL = 'https://bnsy.benniaosuyun.com';

// ── 修复策略映射 ──────────────────────────────────────

const REMEDIATION_MAP: Record<string, StateRemediation> = {
  LOGIN_EXPIRED: {
    action: 'auto_login',
    description: '会话已过期，页面已跳转到登录页。自动重新登录。',
    autoFixable: true,
  },
  WRONG_PAGE: {
    action: 'navigate',
    description: '当前页面非目标操作页面。自动导航到正确页面。',
    autoFixable: true,
  },
  POPUP_BLOCKING: {
    action: 'dismiss_popups',
    description: '页面存在未关闭的弹窗，可能遮挡操作元素。已尝试自动清理。',
    autoFixable: true,
  },
  SIDEBAR_COLLAPSED: {
    action: 'expand_sidebar',
    description: '侧边栏处于收起状态，已自动展开。',
    autoFixable: true,
  },
  ELEMENT_MISSING: {
    action: 'reload',
    description: '页面关键操作元素未能找到，可能页面未完全渲染。已尝试 reload。',
    autoFixable: true,
  },
  UNKNOWN_PAGE: {
    action: 'manual',
    description: '页面状态未知，无法自动恢复。需要人工检查。',
    autoFixable: false,
  },
};

// ── PageStateManager 类 ───────────────────────────────

export class PageStateManager {
  private static instance: PageStateManager | null = null;

  private constructor() {}

  static getInstance(): PageStateManager {
    if (!PageStateManager.instance) {
      PageStateManager.instance = new PageStateManager();
    }
    return PageStateManager.instance;
  }

  // ── ensureReadyForTask: 主入口 ──

  async ensureReadyForTask(
    page: Page,
    capability: WindowCapability,
    options?: StateCheckOptions,
  ): Promise<StateCheckResult> {
    const opts: Required<StateCheckOptions> = {
      skipLoginCheck: options?.skipLoginCheck ?? false,
      skipUrlCheck: options?.skipUrlCheck ?? false,
      skipElementCheck: options?.skipElementCheck ?? false,
      skipPopupCheck: options?.skipPopupCheck ?? false,
      skipSidebarCheck: options?.skipSidebarCheck ?? false,
      autoFix: options?.autoFix ?? true,
      maxAutoFixRetries: options?.maxAutoFixRetries ?? 1,
      perfLog: options?.perfLog ?? (() => {}),
      perfLabel: options?.perfLabel ?? capability,
    };

    const expectedRoute = CAPABILITY_ROUTES[capability];
    const keyElements = CAPABILITY_KEY_ELEMENTS[capability];
    const popupMgr = PopupManager.getInstance();
    const blockedBy: string[] = [];
    const autoFix = opts.autoFix;
    const perf = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        opts.perfLog(`[${opts.perfLabel}] PERF ensureReady.${label} ${Date.now() - start}ms`);
      }
    };

    // ── Step 1: 登录检查（委托给 SessionManager）──
    const sessionMgr = SessionManager.getInstance();
    let loginResult: LoginCheckResult;
    let sessionExpired = false;

    try {
      await perf('login.ensureLoggedIn', () => sessionMgr.ensureLoggedIn(page));
      loginResult = {
        loggedIn: true,
        currentUrl: page.url(),
        detectedLoginPage: false,
        detectedSessionExpired: false,
        pageTitle: '',
      };
    } catch (e) {
      sessionExpired = true;
      const sessionCheck = await perf('login.checkSessionAfterFailure', () => sessionMgr.checkSession(page));
      loginResult = {
        loggedIn: false,
        currentUrl: sessionCheck.currentUrl,
        detectedLoginPage: sessionCheck.detectedLoginPage,
        detectedSessionExpired: sessionCheck.state === 'EXPIRED',
        pageTitle: sessionCheck.pageTitle,
      };

      // 如果 autoRelogin 失败，尝试 autoFix 再重试
      if (autoFix && sessionExpired) {
        blockedBy.push('LOGIN_EXPIRED');
        for (let retry = 0; retry < opts.maxAutoFixRetries; retry++) {
          console.log(`[PageStateManager] autoFix: 自动重登录 (${retry + 1}/${opts.maxAutoFixRetries})`);
          try {
            await perf('login.autoRelogin', () => sessionMgr.autoRelogin(page));
            const verify = await perf('login.verifyAfterAutoRelogin', () => sessionMgr.checkSession(page));
            if (verify.state === 'VALID') {
              loginResult.loggedIn = true;
              loginResult.detectedSessionExpired = false;
              blockedBy.splice(blockedBy.indexOf('LOGIN_EXPIRED'), 1);
              sessionExpired = false;
              break;
            }
          } catch { /* autoRelogin 内部已记录统计 */ }
        }
      } else {
        blockedBy.push('LOGIN_EXPIRED');
      }
    }

    // ── Step 2: 侧边栏检查（先于导航 — 需要展开才能点菜单）──
    const sidebarResult = await perf('sidebar.ensureExpanded', () => this.ensureSidebarExpanded(page));
    if (!sidebarResult.expanded) {
      blockedBy.push('SIDEBAR_COLLAPSED');
      if (autoFix) {
        for (let retry = 0; retry < opts.maxAutoFixRetries; retry++) {
          console.log(`[PageStateManager] autoFix: 重试展开侧边栏 (${retry + 1}/${opts.maxAutoFixRetries})`);
          const retryResult = await perf('sidebar.ensureExpandedRetry', () => this.ensureSidebarExpanded(page));
          if (retryResult.expanded) {
            const idx = blockedBy.indexOf('SIDEBAR_COLLAPSED');
            if (idx >= 0) blockedBy.splice(idx, 1);
            break;
          }
        }
      }
    }

    // ── Step 3: 弹窗检查（先 drain 原生 alert，再清理 DOM 充值弹窗）──
    await perf('nativeAlert.drainBeforePopupCheck', () => drainNativeAlerts(page, { durationMs: 1000, scope: 'before-popup-check' }).catch(() => 0));
    await perf('popup.dismissRechargeBeforeCheck', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
    let popupClean = await perf('popup.ensureCleanBeforeNav', () => popupMgr.ensureClean(page));
    let cleanupAttempted = false;
    let cleanupSucceeded = false;
    if (!popupClean) {
      blockedBy.push('POPUP_BLOCKING');
      if (autoFix) {
        cleanupAttempted = true;
        await perf('popup.dismissRechargeBeforeFullCleanup', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
        const dismissed = await perf('popup.dismissAllBeforeNav', () => popupMgr.dismissAll(page, { timeout: 5000, verifyAfter: false }));
        cleanupSucceeded = dismissed >= 0;
        popupClean = await perf('popup.ensureCleanAfterDismissBeforeNav', () => popupMgr.ensureClean(page));
        if (popupClean) {
          const idx = blockedBy.indexOf('POPUP_BLOCKING');
          if (idx >= 0) blockedBy.splice(idx, 1);
        }
      }
    }
    const visiblePopups = cleanupAttempted ? [] : await perf('popup.inspectBeforeNav', () => popupMgr.inspect(page).catch(() => []));
    const popupResult: PopupCheckResult = {
      clean: popupClean,
      visiblePopups,
      cleanupAttempted,
      cleanupSucceeded,
    };

    // ── Step 4: URL 检查 + URL 优先导航（Phase 5-G-8-2: dismissRechargeCancelDialog）──
    const navGov = NavigationGovernance.getInstance();
    let urlResult = await perf('url.checkInitial', () => this.checkUrlState(page, expectedRoute));
    if (!urlResult.matches) {
      blockedBy.push(urlResult.redirectDetected ? 'LOGIN_EXPIRED' : 'WRONG_PAGE');
      if (autoFix) {
        // Phase 5-G-8-3: WRONG_PAGE 时先 drain 原生 alert，再清理 DOM 弹窗，再 URL 导航
        await perf('url.drainNativeBeforeNav', () => drainNativeAlerts(page, { durationMs: 1000, scope: 'wrong-page-before-nav' }).catch(() => 0));
        await perf('url.dismissRechargeBeforeNav', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));

        const urlNavResult = await perf('url.navigateBusinessPage', () => navGov.navigateBusinessPage(page, capability));

        if (urlNavResult.success) {
          await perf('url.dismissRechargeAfterNav', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
          urlResult = await perf('url.checkAfterUrlNav', () => this.checkUrlState(page, expectedRoute));
          if (urlResult.matches) {
            const idx = blockedBy.indexOf('WRONG_PAGE');
            if (idx >= 0) blockedBy.splice(idx, 1);
          }
        } else {
          console.warn(`[PageStateManager] URL导航失败(${urlNavResult.error})，降级菜单导航`);
          await perf('url.dismissRechargeBeforeMenu', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
          const menuOk = await perf('url.navigateViaMenuFallback', () => this.navigateViaMenu(page, capability).catch(() => false));
          if (menuOk) {
            await perf('url.dismissRechargeAfterMenu', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
            urlResult = await perf('url.checkAfterMenuNav', () => this.checkUrlState(page, expectedRoute));
            if (urlResult.matches) {
              const idx = blockedBy.indexOf('WRONG_PAGE');
              if (idx >= 0) blockedBy.splice(idx, 1);
            }
          }
        }

        if (!urlResult.matches) {
          const msgBoxVisible = await page.$('.el-message-box:not([style*="display: none"])').catch(() => null) !== null;
          const payDialogVisible = await page.$('.el-dialog__wrapper.pay-dialog:not([style*="display: none"])').catch(() => null) !== null;
          console.error(`[PageStateManager] WRONG_PAGE 修复失败: currentUrl=${page.url()}, expected=${expectedRoute}, messageBoxVisible=${msgBoxVisible}, payDialogVisible=${payDialogVisible}`);
        }
      }
    }

    // ── Step 5: 关键元素检查（先 drain 原生 alert，再清理 DOM 弹窗） ──
    await perf('nativeAlert.drainBeforeElementCheck', () => drainNativeAlerts(page, { durationMs: 1000, scope: 'before-element-check' }).catch(() => 0));
    await perf('popup.dismissRechargeBeforeElementCheck', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
    let elementResult = await perf('elements.checkKeyElements', () => this.checkKeyElements(page, keyElements));
    if (!elementResult.allPresent) {
      blockedBy.push('ELEMENT_MISSING');
      if (autoFix) {
        for (let retry = 0; retry < opts.maxAutoFixRetries; retry++) {
          console.log(`[PageStateManager] autoFix: 清理弹窗+URL导航修正页面 (${retry + 1}/${opts.maxAutoFixRetries})`);
          try {
            await drainNativeAlerts(page, { durationMs: 1000, scope: 'element-missing-fix' }).catch(() => 0);
            await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
            await navGov.navigateBusinessPage(page, capability);
            await drainNativeAlerts(page, { durationMs: 1000, scope: 'element-missing-after-nav' }).catch(() => 0);
            await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
          } catch { /* ignore */ }

          elementResult = await perf('elements.checkKeyElementsAfterUrlNav', () => this.checkKeyElements(page, keyElements));
          if (elementResult.allPresent) {
            const idx = blockedBy.indexOf('ELEMENT_MISSING');
            if (idx >= 0) blockedBy.splice(idx, 1);
            break;
          }

          if (retry === opts.maxAutoFixRetries - 1) {
            console.log(`[PageStateManager] autoFix: reload页面作为最终兜底`);
            try {
              await perf('elements.reload', () => page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).then(() => undefined));
              await perf('elements.reloadSettle', () => page.waitForTimeout(2000));
              await perf('popup.dismissRechargeAfterReload', () => popupMgr.dismissRechargeCancelDialog(page).catch(() => false));
            } catch { /* ignore */ }
            elementResult = await perf('elements.checkKeyElementsAfterReload', () => this.checkKeyElements(page, keyElements));
            if (elementResult.allPresent) {
              const idx = blockedBy.indexOf('ELEMENT_MISSING');
              if (idx >= 0) blockedBy.splice(idx, 1);
            }
          }
        }
      }
    }

    // ── 构建结果 ──
    const ready = blockedBy.length === 0;
    let remediation: StateRemediation | undefined;
    if (!ready && blockedBy.length > 0) {
      remediation = REMEDIATION_MAP[blockedBy[0]] ?? REMEDIATION_MAP['UNKNOWN_PAGE'];
    }

    return {
      ready,
      login: loginResult,
      url: urlResult,
      elements: elementResult,
      popups: popupResult,
      sidebar: sidebarResult,
      remediation,
      blockedBy,
    };
  }

  // ── checkUrlState ──

  async checkUrlState(page: Page, expectedRoute: string): Promise<UrlCheckResult> {
    const actual = page.url();
    const redirectDetected = actual.includes('/login') || actual.includes('Login');
    const matches = actual.includes(expectedRoute) && !redirectDetected;

    return {
      matches,
      expected: expectedRoute,
      actual,
      redirectDetected,
    };
  }

  // ── checkKeyElements ──

  async checkKeyElements(page: Page, selectors: string[]): Promise<ElementCheckResult> {
    const found: string[] = [];
    const missing: string[] = [];
    let timeout = false;

    // 先检查是否有可见弹窗遮挡
    let popupsBlocking = false;
    try {
      const blockers = ['.el-dialog__wrapper', '.el-message-box__wrapper', '.el-message-box', '.pay-dialog', '.v-modal'];
      for (const sel of blockers) {
        const elements = await page.$$(sel).catch(() => []);
        for (const el of elements) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) {
            popupsBlocking = true;
            break;
          }
        }
        if (popupsBlocking) break;
      }
    } catch {
      // 检测失败不阻塞主流程
    }

    if (popupsBlocking) {
      console.warn('[PageStateManager] checkKeyElements: 检测到可见弹窗遮挡，降级为 DOM 存在性检查');
    }

    for (const sel of selectors) {
      try {
        // 如果有弹窗遮挡，只检查 DOM 中存在即可（不要求 visible）
        const waitState = popupsBlocking ? 'attached' : 'visible';
        const el = await page.waitForSelector(sel, { timeout: popupsBlocking ? 5000 : 10000, state: waitState });
        if (el) {
          found.push(sel);
        } else {
          missing.push(sel);
        }
      } catch {
        // 检查是否因超时
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            found.push(sel);
            continue;
          }
          // 如果有弹窗遮挡，DOM 中存在即视为通过
          if (popupsBlocking) {
            console.log(`[PageStateManager] 弹窗遮挡下元素 ${sel} 存在于 DOM，视为通过`);
            found.push(sel);
            continue;
          }
        }
        timeout = true;
        missing.push(sel);
      }
    }

    return {
      allPresent: missing.length === 0,
      found,
      missing,
      timeout,
      popupsBlocking,
    };
  }

  // ── ensureSidebarExpanded ──

  async ensureSidebarExpanded(page: Page): Promise<SidebarCheckResult> {
    const startTime = Date.now();

    // 检查 localStorage 中的持久化值
    const localStorageValue = await page.evaluate(() => localStorage.getItem('sidebarStatus')).catch(() => 'unknown') ?? 'unknown';

    // 检查 DOM 中的当前状态
    const isExpanded = await page.evaluate(() => {
      const app = document.querySelector('.app-wrapper');
      return app?.classList.contains('openSidebar') ?? false;
    }).catch(() => false);

    if (isExpanded) {
      return {
        expanded: true,
        wasCollapsed: false,
        expandTimeMs: Date.now() - startTime,
        localStorageValue,
      };
    }

    // 侧边栏收起 → 尝试展开
    console.log('[PageStateManager] 侧边栏收起，尝试展开...');
    const wasCollapsed = true;

    try {
      const hamburger = await page.$('.hamburger-container, .hamburger, #hamburger-container').catch(() => null);
      if (hamburger) {
        await hamburger.click();
        // 等待 CSS 动画完成 (class switch 108ms + animation 1550ms → 2000ms)
        await page.waitForTimeout(2000);
      }
    } catch {
      // 忽略点击失败
    }

    const nowExpanded = await page.evaluate(() => {
      const app = document.querySelector('.app-wrapper');
      return app?.classList.contains('openSidebar') ?? false;
    }).catch(() => false);

    return {
      expanded: nowExpanded,
      wasCollapsed,
      expandTimeMs: Date.now() - startTime,
      localStorageValue,
    };
  }

  // ── navigateViaMenu: 菜单优先导航 ──

  /** capability → 侧边栏菜单文本映射 */
  private static readonly CAPABILITY_MENU_TEXT: Record<WindowCapability, string> = {
    arrival: '到件扫描(批量)',
    dispatch: '派件扫描',
    sign: '签收录入',
    integrated: '到件扫描',
  };

  /**
   * 通过侧边栏菜单导航到指定功能页面
   * 策略：文本匹配点击 → 检查 URL → 失败返回 false
   */
  private async navigateViaMenu(page: Page, capability: WindowCapability): Promise<boolean> {
    const menuText = PageStateManager.CAPABILITY_MENU_TEXT[capability];
    if (!menuText) return false;

    try {
      const navGov = NavigationGovernance.getInstance();
      const result = await navGov.navigateTo(page, capability);
      return result.success;
    } catch (e) {
      console.warn(`[PageStateManager] navigateViaMenu 异常: ${(e as Error).message}`);
      return false;
    }
  }

  // ── remediate ──

  async remediate(page: Page, result: StateCheckResult): Promise<boolean> {
    if (result.ready) return true;
    if (!result.remediation?.autoFixable) return false;

    const popupMgr = PopupManager.getInstance();
    const navGov = NavigationGovernance.getInstance();
    const action = result.remediation.action;

    switch (action) {
      case 'auto_login':
        try {
          await SessionManager.getInstance().autoRelogin(page);
          return true;
        } catch {
          return false;
        }
      case 'navigate':
        try {
          // Phase 5-G-8-2: 使用URL优先导航，带前后充值/取消弹窗清理
          await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
          const cap = this.getCapabilityFromRoute(result.url.expected);
          if (cap) {
            const navResult = await navGov.navigateBusinessPage(page, cap);
            if (navResult.success) return true;
          }
          await page.goto(BASE_URL + result.url.expected, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
          await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
          return true;
        } catch {
          return false;
        }
      case 'dismiss_popups':
        await popupMgr.dismissAll(page, { timeout: 8000, verifyAfter: true });
        return popupMgr.ensureClean(page);
      case 'expand_sidebar':
        await this.ensureSidebarExpanded(page);
        return true;
      case 'reload':
        try {
          // Phase 5-G-8-2: reload前先尝试URL导航修正+弹窗清理
          await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
          const cap = this.getCapabilityFromRoute(result.url.expected);
          if (cap) {
            const navResult = await navGov.navigateBusinessPage(page, cap);
            if (navResult.success) return true;
          }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2000);
          await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
          return true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /** 根据路由路径反查 WindowCapability */
  private getCapabilityFromRoute(route: string): WindowCapability | null {
    for (const [cap, path] of Object.entries(CAPABILITY_ROUTES)) {
      if (path === route) return cap as WindowCapability;
    }
    return null;
  }
}
