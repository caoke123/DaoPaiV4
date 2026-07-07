// BusinessPageNavigator — 统一业务页面导航恢复机制
// Phase 5-G-8-4: 任何页面变化之后，都必须先清理原生 Alert，再清理 DOM 弹窗，然后再验证 URL 和目标元素
//
// 职责：
//   1. ensureCleanHome — 任务开始前恢复干净首页
//   2. navigateToBusinessPage — URL 优先 + 重试 + 侧边栏兜底
//   3. afterPageChangedCleanup — 页面变化后统一清理钩子
//   4. restoreCleanHome — 任务结束后恢复干净首页
//
// 与现有模块的分工：
//   - BusinessPageNavigator: 统一导航入口 + 页面变化后清理
//   - NativeAlertGuard: 原生 alert/confirm/prompt（被 BusinessPageNavigator 调用）
//   - PopupManager: DOM 弹窗（被 BusinessPageNavigator 调用）
//   - NavigationGovernance: 底层导航执行（被 BusinessPageNavigator 调用）
//   - PageStateManager: ensureReadyForTask 仍保留，内部集成 BusinessPageNavigator

import type { Page } from 'playwright';
import { PopupManager } from './PopupManager';
import { NativeAlertGuard, drainNativeAlerts } from './NativeAlertGuard';
import { NavigationGovernance } from './NavigationGovernance';

// ── 类型定义 ──────────────────────────────────────────

export type TaskPageType = 'arrival' | 'dispatch' | 'integrated' | 'sign';

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

/** 业务页面规格 */
interface BusinessPageSpec {
  /** 完整 URL */
  url: string;
  /** 侧边栏菜单文本（兜底用） */
  menuText: string;
  /** 关键元素选择器（验证页面 ready） */
  requiredElements: string[];
  /** URL 路径片段（用于 isOnPage 判断） */
  pathFragment: string;
}

/** 页面变化后清理结果 */
interface CleanupResult {
  currentUrl: string;
  alertClosed: boolean;
  domPopupClosed: boolean;
}

/** 导航结果 */
interface NavigateResult {
  success: boolean;
  method: 'sidebar_first' | 'sidebar_retry' | 'url_fallback';
  currentUrl: string;
  targetUrl: string;
  error?: string;
  durationMs: number;
}

/** ensureCleanHome 结果 */
interface HomeResult {
  success: boolean;
  currentUrl: string;
  error?: string;
  durationMs: number;
}

// ── 常量配置 ──────────────────────────────────────────

const BNSY_HOME_URL = 'https://bnsy.benniaosuyun.com/dashboard';
const BNSY_LOGIN_FRAGMENT = '/login';

/** 人工实测确认的业务页面 URL 映射 */
const BUSINESS_PAGE_SPECS: Record<TaskPageType, BusinessPageSpec> = {
  arrival: {
    url: 'https://bnsy.benniaosuyun.com/scanning/ArrivalscanBatch',
    menuText: '到件扫描(批量)',
    requiredElements: ['textarea', 'button.el-button--danger'],
    pathFragment: '/scanning/ArrivalscanBatch',
  },
  dispatch: {
    url: 'https://bnsy.benniaosuyun.com/scanning/dispatchscan',
    menuText: '派件扫描',
    requiredElements: ['.dispatchscan_left input', '.dispatchscan_left button.el-button--primary'],
    pathFragment: '/scanning/dispatchscan',
  },
  integrated: {
    url: 'https://bnsy.benniaosuyun.com/scanning/arrivalscan',
    menuText: '到派一体',
    requiredElements: ['#waybillNum', '.arrivalscan_left button.el-button--primary'],
    pathFragment: '/scanning/arrivalscan',
  },
  sign: {
    url: 'https://bnsy.benniaosuyun.com/scanning/signFor/signForInput',
    menuText: '签收录入',
    requiredElements: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor'],
    pathFragment: '/scanning/signFor/signForInput',
  },
};

// ── 超时配置 ──────────────────────────────────────────

const TIMEOUT_URL_GOTO = 5000;        // URL 导航超时
const TIMEOUT_URL_RETRY_GOTO = 5000;  // URL 重试超时
const TIMEOUT_ELEMENT_WAIT = 5000;    // 关键元素等待
const TIMEOUT_DRAIN_SHORT = 800;      // 短 drain
const TIMEOUT_DRAIN_NORMAL = 1200;    // 正常 drain
const TIMEOUT_DRAIN_LONG = 1500;      // 长 drain（导航后）
const TIMEOUT_DOM_POPUP_WAIT = 1200;  // DOM 弹窗关闭等待
const TIMEOUT_HOME_GOTO = 8000;       // 回首页超时
const TIMEOUT_SIDEBAR_CLICK = 5000;   // 侧边栏点击超时

// ── 工具函数 ──────────────────────────────────────────

/** 判断 URL 是否在目标页面 */
function isOnPage(url: string, pathFragment: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === pathFragment;
  } catch {
    return url.includes(pathFragment);
  }
}

/** 判断 URL 是否在首页 */
function isOnHome(url: string): boolean {
  return isOnPage(url, '/dashboard');
}

/** 判断 URL 是否在登录页 */
function isOnLogin(url: string): boolean {
  return url.includes(BNSY_LOGIN_FRAGMENT);
}

// ── BusinessPageNavigator ────────────────────────────

export class BusinessPageNavigator {
  private static instance: BusinessPageNavigator | null = null;

  private constructor() {}

  static getInstance(): BusinessPageNavigator {
    if (!BusinessPageNavigator.instance) {
      BusinessPageNavigator.instance = new BusinessPageNavigator();
    }
    return BusinessPageNavigator.instance;
  }

  // ════════════════════════════════════════════════════
  // afterPageChangedCleanup — 页面变化后统一清理钩子
  // ════════════════════════════════════════════════════

  /**
   * 任何页面变化之后必须调用。
   *
   * 固定流程：
   *   1. attachNativeAlertGuard（幂等）
   *   2. drainNativeAlerts（800-1500ms）
   *   3. dismissRechargeCancelDialog（DOM 弹窗）
   *   4. 再 drainNativeAlerts（300-800ms，确认无残留）
   *
   * @returns 当前 URL + 是否处理过 alert/domPopup
   */
  async afterPageChangedCleanup(
    page: Page,
    options: { staffName?: string; scope?: string; log?: LogFn; drainMs?: number },
  ): Promise<CleanupResult> {
    const { staffName, scope = 'after-page-changed', log, drainMs } = options;
    const logger = log ?? ((level, msg) => {
      if (level === 'warning') console.warn(`[BusinessNav]${msg}`);
      else console[level](`[BusinessNav]${msg}`);
    });

    // 1. 确保 NativeAlertGuard 已挂载
    if (!NativeAlertGuard.getInstance().isAttached(page)) {
      NativeAlertGuard.getInstance().attachNativeAlertGuard(page, {
        staffName,
        scope,
        log: (level, msg) => logger(level === 'warn' ? 'warning' : level, msg),
      });
    }

    // 2. drain 原生 Alert
    const alertCount = await drainNativeAlerts(page, {
      durationMs: drainMs ?? TIMEOUT_DRAIN_NORMAL,
      intervalMs: 200,
      staffName,
      scope,
      log: (level, msg) => logger(level === 'warn' ? 'warning' : level, msg),
    }).catch(() => 0);

    // 3. 清理 DOM 充值弹窗
    const popupMgr = PopupManager.getInstance();
    const domClosed = await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);

    // 4. 再 drain 一次短确认（DOM 弹窗关闭后可能触发新的 alert）
    if (domClosed) {
      await drainNativeAlerts(page, {
        durationMs: TIMEOUT_DRAIN_SHORT,
        intervalMs: 200,
        staffName,
        scope: `${scope}-confirm`,
        log: () => {}, // 静默
      }).catch(() => 0);
    }

    const currentUrl = page.url();
    const result: CleanupResult = {
      currentUrl,
      alertClosed: alertCount > 0,
      domPopupClosed: domClosed,
    };

    if (result.alertClosed || result.domPopupClosed) {
      logger('info', `[${scope}] 页面变化后清理完成: alert=${alertCount}, domPopup=${domClosed}, url=${currentUrl}`);
    }

    return result;
  }

  // ════════════════════════════════════════════════════
  // ensureCleanHome — 任务开始前恢复干净首页
  // ════════════════════════════════════════════════════

  /**
   * 确保窗口在干净首页。
   *
   * 流程：
   *   1. attachNativeAlertGuard
   *   2. drainNativeAlerts
   *   3. dismissRechargeCancelDialog
   *   4. 如果不在 /dashboard，goto 首页
   *   5. 页面变化后再次 drainNativeAlerts
   *   6. 再次 dismissRechargeCancelDialog
   *   7. 验证：URL=/dashboard, 不在/login, 侧边栏存在, 无弹窗
   *
   * 失败时快速失败，不继续盲目执行业务动作。
   */
  async ensureCleanHome(
    page: Page,
    options: { staffName?: string; log?: LogFn },
  ): Promise<HomeResult> {
    const { staffName, log } = options;
    const logger = log ?? ((level, msg) => {
      if (level === 'warning') console.warn(`[BusinessNav]${msg}`);
      else console[level](`[BusinessNav]${msg}`);
    });
    const startTime = Date.now();

    // 1-3. 先清理弹窗
    await this.afterPageChangedCleanup(page, { staffName, scope: 'ensure-clean-home-before', log: logger });

    // 4. 如果不在首页，goto 首页
    const currentUrl = page.url();
    if (!isOnHome(currentUrl)) {
      if (isOnLogin(currentUrl)) {
        logger('error', `ensureCleanHome 失败：当前在登录页，需要重新登录`);
        return { success: false, currentUrl, error: 'LOGIN_REQUIRED', durationMs: Date.now() - startTime };
      }
      logger('info', `当前不在首页(${currentUrl})，导航到首页...`);
      try {
        await page.goto(BNSY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_HOME_GOTO });
      } catch (e) {
        logger('warning', `goto 首页失败: ${(e as Error).message}，尝试 location.href 兜底`);
        await page.evaluate((url) => { window.location.href = url; }, BNSY_HOME_URL).catch(() => {});
        await page.waitForTimeout(2000);
      }

      // 5-6. 页面变化后再次清理
      await this.afterPageChangedCleanup(page, { staffName, scope: 'ensure-clean-home-after', log: logger });
    }

    // 7. 验证首页 ready
    const finalUrl = page.url();
    if (!isOnHome(finalUrl)) {
      logger('error', `ensureCleanHome 失败：URL=${finalUrl}, 预期=/dashboard`);
      return { success: false, currentUrl: finalUrl, error: 'NOT_ON_HOME', durationMs: Date.now() - startTime };
    }
    if (isOnLogin(finalUrl)) {
      logger('error', `ensureCleanHome 失败：被重定向到登录页`);
      return { success: false, currentUrl: finalUrl, error: 'LOGIN_REDIRECT', durationMs: Date.now() - startTime };
    }

    // 检查侧边栏存在
    const sidebarExists = await page.$('.el-menu, .sidebar, .aside-container, nav.el-menu').catch(() => null) !== null;
    if (!sidebarExists) {
      logger('warning', `首页侧边栏未检测到，但 URL 正确，继续执行`);
    }

    logger('info', `首页已就绪: ${finalUrl} (${Date.now() - startTime}ms)`);
    return { success: true, currentUrl: finalUrl, durationMs: Date.now() - startTime };
  }

  // ════════════════════════════════════════════════════
  // navigateToBusinessPage — 侧边栏菜单优先 + 重试 + URL 兜底
  // ════════════════════════════════════════════════════

  /**
   * 从干净首页进入目标业务页。
   *
   * Phase 5-G-8-6 策略调整：侧边栏菜单点击为主路径，URL 仅兜底。
   *
   * 流程：
   *   1. ensureCleanHome() — 先回干净首页
   *   2. 第一次侧边栏菜单点击 → afterPageChangedCleanup → 验证
   *   3. 失败则回首页 → 清弹窗 → 第二次侧边栏菜单点击 → 验证
   *   4. 仍失败则 URL 兜底 → afterPageChangedCleanup → 验证
   *   5. 仍失败则 15s 内快速失败
   */
  async navigateToBusinessPage(
    page: Page,
    taskType: TaskPageType,
    options: { staffName?: string; log?: LogFn },
  ): Promise<NavigateResult> {
    const { staffName, log } = options;
    const logger = log ?? ((level, msg) => {
      if (level === 'warning') console.warn(`[BusinessNav]${msg}`);
      else console[level](`[BusinessNav]${msg}`);
    });
    const spec = BUSINESS_PAGE_SPECS[taskType];
    const startTime = Date.now();

    logger('info', `准备进入业务页面：${spec.menuText}`);

    // 如果已在目标页且元素存在，直接返回
    if (isOnPage(page.url(), spec.pathFragment)) {
      const elementsOk = await this.checkElements(page, spec.requiredElements, logger);
      if (elementsOk) {
        await this.afterPageChangedCleanup(page, { staffName, scope: `already-on-${taskType}`, log: logger });
        logger('info', `已在目标页 ${spec.menuText}，元素就绪`);
        return { success: true, method: 'sidebar_first', currentUrl: page.url(), targetUrl: spec.url, durationMs: Date.now() - startTime };
      }
    }

    // Step 1: 先回干净首页
    logger('info', `回首页，准备进入业务页面`);
    const homeResult = await this.ensureCleanHome(page, { staffName, log: logger });
    if (!homeResult.success) {
      return { success: false, method: 'sidebar_first', currentUrl: homeResult.currentUrl, targetUrl: spec.url, error: `首页恢复失败: ${homeResult.error}`, durationMs: Date.now() - startTime };
    }

    // Step 2: 第一次点击侧边栏菜单
    logger('info', `第一次点击侧边栏菜单：${spec.menuText}`);
    const firstSidebarOk = await this.trySidebarNavigate(page, spec, staffName, logger);
    if (firstSidebarOk) {
      logger('info', `第一次菜单点击进入成功 (${Date.now() - startTime}ms)`);
      return { success: true, method: 'sidebar_first', currentUrl: page.url(), targetUrl: spec.url, durationMs: Date.now() - startTime };
    }

    // Step 3: 第一次失败，回首页再点击一次
    logger('warning', `第一次菜单点击未进入目标页面，准备回首页重试`);
    await this.ensureCleanHome(page, { staffName, log: logger });
    logger('info', `第二次点击侧边栏菜单：${spec.menuText}`);
    const secondSidebarOk = await this.trySidebarNavigate(page, spec, staffName, logger);
    if (secondSidebarOk) {
      logger('info', `第二次菜单点击进入成功 (${Date.now() - startTime}ms)`);
      return { success: true, method: 'sidebar_retry', currentUrl: page.url(), targetUrl: spec.url, durationMs: Date.now() - startTime };
    }

    // Step 4: 两次菜单都失败，URL 兜底
    logger('warning', `两次菜单点击均失败，准备使用 URL 兜底`);
    // URL 兜底前先回首页清弹窗
    await this.ensureCleanHome(page, { staffName, log: logger });
    const urlResult = await this.tryUrlNavigate(page, spec, staffName, 'url-fallback', logger);
    if (urlResult) {
      logger('info', `URL 兜底进入成功 (${Date.now() - startTime}ms)`);
      return { success: true, method: 'url_fallback', currentUrl: page.url(), targetUrl: spec.url, durationMs: Date.now() - startTime };
    }

    // Step 5: 全部失败，快速失败
    const currentUrl = page.url();
    const elementsOk = await this.checkElements(page, spec.requiredElements, logger);
    const errorMsg = `进入业务页面失败: ${spec.menuText}, current=${currentUrl}, elementsOk=${elementsOk}`;
    logger('error', errorMsg);
    return { success: false, method: 'sidebar_first', currentUrl, targetUrl: spec.url, error: errorMsg, durationMs: Date.now() - startTime };
  }

  /** URL 导航 + 清理 + 验证 */
  private async tryUrlNavigate(
    page: Page,
    spec: BusinessPageSpec,
    staffName: string | undefined,
    scope: string,
    logger: LogFn,
  ): Promise<boolean> {
    try {
      await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_URL_GOTO });
    } catch (e) {
      // timeout 或网络错误，尝试 location.href
      logger('warning', `[${scope}] goto 异常: ${(e as Error).message}，尝试 location.href`);
      await page.evaluate((url) => { window.location.href = url; }, spec.url).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // 等待关键容器
    await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: TIMEOUT_ELEMENT_WAIT }).catch(() => {});
    await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});

    // 页面变化后清理
    await this.afterPageChangedCleanup(page, { staffName, scope, log: logger, drainMs: TIMEOUT_DRAIN_LONG });

    // 验证 URL + 元素
    if (!isOnPage(page.url(), spec.pathFragment)) {
      logger('warning', `[${scope}] URL 不匹配: ${page.url()}, 预期: ${spec.pathFragment}`);
      return false;
    }
    return this.checkElements(page, spec.requiredElements, logger);
  }

  /** 侧边栏菜单兜底导航 */
  private async trySidebarNavigate(
    page: Page,
    spec: BusinessPageSpec,
    staffName: string | undefined,
    logger: LogFn,
  ): Promise<boolean> {
    // 使用 NavigationGovernance 的菜单导航（它有菜单展开逻辑）
    const navGov = NavigationGovernance.getInstance();
    const capability = this.specToCapability(spec);
    if (!capability) {
      logger('error', `侧边栏导航失败：无法识别 capability`);
      return false;
    }

    try {
      // 先展开菜单
      const menuOk = await navGov.navigateByMenu(page, capability).catch(() => false);
      if (!menuOk) {
        logger('warning', `侧边栏菜单点击失败`);
        return false;
      }

      // 等待页面变化
      await page.waitForTimeout(1500);
      await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});

      // 页面变化后清理（此时可能接受原生 alert，BNSY 网站可能重定向回首页）
      await this.afterPageChangedCleanup(page, { staffName, scope: 'after-sidebar-click', log: logger });

      // 验证 URL
      if (!isOnPage(page.url(), spec.pathFragment)) {
        // Phase 5-G-8-4: 侧边栏点击已成功进入业务页，但原生 alert 被接受后
        // BNSY 网站 JS 可能重定向回 /dashboard。
        // 此时 alert 已清理，直接 URL 导航应该能成功（不会再触发 alert 重定向）
        logger('warning', `侧边栏导航后 URL 被弹窗重定向到: ${page.url()}，弹窗已清理，尝试 URL 重新导航`);
        try {
          await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_URL_GOTO });
          await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: TIMEOUT_ELEMENT_WAIT }).catch(() => {});
          await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
          // URL 导航后再次清理（可能有新的延迟弹窗）
          await this.afterPageChangedCleanup(page, { staffName, scope: 'sidebar-url-retry', log: logger, drainMs: TIMEOUT_DRAIN_LONG });
        } catch (e) {
          logger('warning', `侧边栏后 URL 重新导航失败: ${(e as Error).message}`);
          return false;
        }
      }

      // 最终验证
      if (!isOnPage(page.url(), spec.pathFragment)) {
        logger('warning', `侧边栏导航后 URL 最终不匹配: ${page.url()}, 预期: ${spec.pathFragment}`);
        return false;
      }
      return this.checkElements(page, spec.requiredElements, logger);
    } catch (e) {
      logger('error', `侧边栏导航异常: ${(e as Error).message}`);
      return false;
    }
  }

  /** 检查关键元素是否存在 */
  private async checkElements(page: Page, selectors: string[], logger: LogFn): Promise<boolean> {
    for (const sel of selectors) {
      const el = await page.$(sel).catch(() => null);
      if (!el) {
        logger('warning', `关键元素缺失: ${sel}`);
        return false;
      }
    }
    return true;
  }

  /** spec → WindowCapability */
  private specToCapability(spec: BusinessPageSpec): 'arrival' | 'dispatch' | 'sign' | 'integrated' | null {
    for (const [key, s] of Object.entries(BUSINESS_PAGE_SPECS)) {
      if (s === spec) return key as 'arrival' | 'dispatch' | 'sign' | 'integrated';
    }
    return null;
  }

  // ════════════════════════════════════════════════════
  // restoreCleanHome — 任务结束后恢复干净首页
  // ════════════════════════════════════════════════════

  /**
   * 任务执行完成后恢复首页。
   *
   * 注意：
   *   - 回首页失败不改变任务结果（done/failed）
   *   - 但写 warning 并标记窗口状态
   *   - 必须在释放窗口锁之前完成
   */
  async restoreCleanHome(
    page: Page,
    options: { staffName?: string; log?: LogFn },
  ): Promise<HomeResult> {
    const { staffName, log } = options;
    const logger = log ?? ((level, msg) => {
      if (level === 'warning') console.warn(`[BusinessNav]${msg}`);
      else console[level](`[BusinessNav]${msg}`);
    });
    const startTime = Date.now();

    logger('info', `任务结束，恢复首页...`);

    // 1. 先清理弹窗
    await drainNativeAlerts(page, { durationMs: TIMEOUT_DRAIN_NORMAL, staffName, scope: 'restore-home-before', log: (level, msg) => logger(level === 'warn' ? 'warning' : level, msg) }).catch(() => 0);
    await PopupManager.getInstance().dismissRechargeCancelDialog(page).catch(() => false);

    // 2. goto 首页
    const currentUrl = page.url();
    if (!isOnHome(currentUrl)) {
      try {
        await page.goto(BNSY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_HOME_GOTO });
      } catch (e) {
        logger('warning', `回首页 goto 失败: ${(e as Error).message}，尝试 location.href`);
        await page.evaluate((url) => { window.location.href = url; }, BNSY_HOME_URL).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // 3. 页面变化后再次清理
    await this.afterPageChangedCleanup(page, { staffName, scope: 'restore-home-after', log: logger });

    // 4. 验证首页 URL
    const finalUrl = page.url();
    if (!isOnHome(finalUrl)) {
      // 回首页失败，不改变任务结果，但写 warning
      logger('warning', `任务已结束，但窗口恢复首页失败，下次任务前将重新校验。当前URL=${finalUrl}`);
      return { success: false, currentUrl: finalUrl, error: 'RESTORE_HOME_FAILED', durationMs: Date.now() - startTime };
    }

    // 5. 最终确认清理：首页 URL 正确后，再做一次原生 Alert + DOM 弹窗清理
    //    确保下一个任务从完全干净的首页出发
    const finalCleanup = await this.afterPageChangedCleanup(page, { staffName, scope: 'restore-home-final-confirm', log: logger, drainMs: TIMEOUT_DRAIN_SHORT });

    // 6. 确认无残留弹窗
    const residualPopup = await page.$('.el-dialog__wrapper:not([style*="display: none"]):not([style*="display:none"]), .el-message-box:not([style*="display: none"]):not([style*="display:none"])').catch(() => null);
    if (residualPopup) {
      logger('warning', `首页已恢复但仍有残留DOM弹窗，尝试最后一次清理`);
      await PopupManager.getInstance().dismissRechargeCancelDialog(page).catch(() => false);
      await drainNativeAlerts(page, { durationMs: TIMEOUT_DRAIN_SHORT, staffName, scope: 'restore-home-residual', log: (level, msg) => logger(level === 'warn' ? 'warning' : level, msg) }).catch(() => 0);
    }

    // 7. 如果最终清理关闭了弹窗，可能 URL 被改变，再验证一次
    if (finalCleanup.alertClosed || finalCleanup.domPopupClosed) {
      const postCleanupUrl = page.url();
      if (!isOnHome(postCleanupUrl)) {
        logger('warning', `最终清理后 URL 变化: ${postCleanupUrl}，重新回首页`);
        try {
          await page.goto(BNSY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_HOME_GOTO });
          await this.afterPageChangedCleanup(page, { staffName, scope: 'restore-home-re-confirm', log: logger, drainMs: TIMEOUT_DRAIN_SHORT });
        } catch (e) {
          logger('warning', `重新回首页失败: ${(e as Error).message}`);
        }
      }
    }

    const cleanUrl = page.url();
    logger('info', `首页已恢复并确认干净: ${cleanUrl} (${Date.now() - startTime}ms)`);
    return { success: isOnHome(cleanUrl), currentUrl: cleanUrl, durationMs: Date.now() - startTime };
  }
}

// ── 便捷导出 ──────────────────────────────────────────

/** 获取业务页面规格 */
export function getBusinessPageSpec(taskType: TaskPageType): BusinessPageSpec {
  return BUSINESS_PAGE_SPECS[taskType];
}

/** 获取首页 URL */
export function getHomeUrl(): string {
  return BNSY_HOME_URL;
}
