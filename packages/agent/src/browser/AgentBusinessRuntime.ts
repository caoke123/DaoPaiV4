/**
 * AgentBusinessRuntime — Agent 侧基础运行时最小闭环
 *
 * Phase K-2E: 在 Agent 侧补齐 Phase 5-H 已验证的基础运行时 contract。
 *
 * 复刻自 Cloud 侧稳定实现（不直接依赖 backend 模块）：
 *   - backend/browser/NativeAlertGuard.ts
 *   - backend/browser/PopupManager.ts (dismissRechargeCancelDialog)
 *   - backend/browser/BusinessPageNavigator.ts
 *   - backend/playwright-runtime/PlaywrightRuntime.ts
 *
 * 提供：
 *   1. registerNativeAlertGuard   — 原生 alert/confirm/prompt 守卫
 *   2. cleanDomPopups              — DOM 弹窗清理（充值/余额/ dialog / message-box）
 *   3. afterPageChangedCleanup     — 页面变化后统一清理钩子
 *   4. ensureCleanHome             — 任务开始前恢复干净首页
 *   5. restoreCleanHome            — 任务结束后恢复干净首页（失败不抛异常）
 *   6. navigateToBusinessPageMenuFirst — 菜单优先业务页面导航
 *
 * 硬性约束：
 *   - 不让 Agent 运行时 import backend runtime 对象
 *   - 不点击最终提交按钮
 *   - DOM 弹窗清理只点"取消/关闭/知道了"，不点"确定"（避免充值弹窗误跳转）
 *   - restoreCleanHome 失败不覆盖原始业务错误
 */

import type { Page } from 'playwright-core';

// ══════════════════════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════════════════════

export type BusinessType = 'arrival' | 'dispatch' | 'sign' | 'integrated';

export type AgentRuntimeLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface AgentRuntimeMeta {
  staffName?: string;
  windowId?: string;
  siteId?: string;
}

export type AgentRuntimeLogFn = (
  level: AgentRuntimeLogLevel,
  message: string,
  meta?: AgentRuntimeMeta,
) => void;

export interface NavigateResult {
  success: boolean;
  method: 'sidebar_first' | 'sidebar_retry' | 'url_fallback' | 'already_on_page' | 'failed';
  pageUrl: string;
  message: string;
}

export interface CleanDomPopupsResult {
  cleaned: boolean;
  reason: 'no_visible_popup' | 'cleaned_message_box' | 'cleaned_pay_dialog' | 'cleaned_dialog' | 'no_cancel_button' | 'error';
  message: string;
}

// ══════════════════════════════════════════════════════════
// 常量（来源：Cloud 侧 BusinessPageNavigator + NavigationGovernance）
// ══════════════════════════════════════════════════════════

const BNSY_HOME_URL = 'https://bnsy.benniaosuyun.com/dashboard';
const BNSY_LOGIN_FRAGMENT = '/login';
const TARGET_DOMAIN = 'bnsy.benniaosuyun.com';

// 超时配置（来源：Cloud 侧 BusinessPageNavigator L101-109）
const TIMEOUT_URL_GOTO = 8000;
const TIMEOUT_ELEMENT_WAIT = 5000;
const TIMEOUT_DRAIN_NORMAL = 300;
const TIMEOUT_DRAIN_SHORT = 250;
const TIMEOUT_DRAIN_LONG = 800;
const TIMEOUT_HOME_GOTO = 8000;
const TIMEOUT_SIDEBAR_CLICK = 5000;

const LOGO_SELECTORS = [
  '#app > div.app-wrapper.openSidebar > div.has-logo.sidebar-container > div.sidebar-logo-container > a',
  '.sidebar-logo-container a',
  '.sidebar-logo-container',
  'a[href*="dashboard"]',
  'a:has-text("笨鸟")',
];

const POPUP_CONTAINER_SELECTORS = [
  '.el-message-box__wrapper:visible',
  '.el-message-box:visible',
  '.el-dialog__wrapper:visible',
  '.el-dialog:visible',
  '.pay-dialog:visible',
  '.v-modal:visible',
];

const CANCEL_BUTTON_SELECTORS = [
  'button:has-text("取 消")',
  '.el-button:has-text("取 消")',
  'button:has-text("取消")',
  '.el-button:has-text("取消")',
];

// 业务页面规格表（来源：Cloud 侧 BusinessPageNavigator BUSINESS_PAGE_SPECS + NavigationGovernance MENU_PATHS）
interface BusinessPageSpec {
  url: string;
  pathFragment: string;
  parentMenu: string;        // 一级菜单文本（操作中心）
  intermediateMenu?: string; // 中间菜单文本（仅 sign 需要：签收）
  childMenu: string;         // 实际点击的菜单项文本
  requiredElements: string[]; // 页面就绪验证选择器
}

const BUSINESS_SPECS: Record<BusinessType, BusinessPageSpec> = {
  arrival: {
    url: 'https://bnsy.benniaosuyun.com/scanning/ArrivalscanBatch',
    pathFragment: '/scanning/ArrivalscanBatch',
    parentMenu: '操作中心',
    childMenu: '到件扫描(批量)',
    requiredElements: ['textarea', 'button.el-button--danger'],
  },
  dispatch: {
    url: 'https://bnsy.benniaosuyun.com/scanning/dispatchscan',
    pathFragment: '/scanning/dispatchscan',
    parentMenu: '操作中心',
    childMenu: '派件扫描',
    requiredElements: ['.dispatchscan_left input', '.dispatchscan_left button.el-button--primary'],
  },
  integrated: {
    url: 'https://bnsy.benniaosuyun.com/scanning/arrivalscan',
    pathFragment: '/scanning/arrivalscan',
    parentMenu: '操作中心',
    // 笨鸟后台到派一体复用"到件扫描"页面入口，进入后再勾选"到派一体"复选框。
    childMenu: '到件扫描',
    requiredElements: ['#waybillNum', '.el-checkbox:has-text("到派一体")', '.arrivalscan_left button.el-button--primary'],
  },
  sign: {
    url: 'https://bnsy.benniaosuyun.com/scanning/signFor/signForInput',
    pathFragment: '/scanning/signFor/signForInput',
    parentMenu: '操作中心',
    intermediateMenu: '签收',
    childMenu: '签收录入',
    requiredElements: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor'],
  },
};

// ══════════════════════════════════════════════════════════
// 1. Native Alert Guard
// （来源：backend/browser/NativeAlertGuard.ts）
// ══════════════════════════════════════════════════════════

const registeredPages = new WeakSet<Page>();

/**
 * 注册原生 alert/confirm/prompt 守卫
 *
 * 策略（来源：NativeAlertGuard L93-120）：
 *   - beforeunload → dismiss（不阻止离开）
 *   - alert/confirm → accept（点击确定）
 *   - prompt → accept('')（输入空字符串后确定）
 *
 * 使用 WeakSet 防止重复注册。
 */
export function registerNativeAlertGuard(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): void {
  if (registeredPages.has(page)) {
    return;
  }

  page.on('dialog', async (dialog) => {
    try {
      const dialogType = dialog.type();
      const dialogMessage = dialog.message();

      if (dialogType === 'beforeunload') {
        await dialog.dismiss();
        log?.('info', `[Agent][Runtime] native beforeunload 已 dismiss: message=${dialogMessage.substring(0, 100)}`, meta);
      } else if (dialogType === 'prompt') {
        await dialog.accept('');
        log?.('info', `[Agent][Runtime] native prompt 已点击确定: message=${dialogMessage.substring(0, 100)}`, meta);
      } else {
        // alert / confirm 的正确处理方式是点击"确定"。
        await dialog.accept();
        log?.('info', `[Agent][Runtime] native ${dialogType} 已点击确定: message=${dialogMessage.substring(0, 100)}`, meta);
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      // No dialog is showing 是无害竞争条件
      if (!msg.includes('No dialog')) {
        log?.('warning', `[Agent][Runtime] native dialog 处理异常: ${msg}`, meta);
      }
    }
  });

  registeredPages.add(page);
  log?.('info', '[Agent][Runtime] Native alert 已注册', meta);
}

/**
 * CDP 兜底：强制接受当前已弹出但 page.on('dialog') 错过的 alert
 * （来源：NativeAlertGuard.forceAcceptCurrentNativeAlert L143-170）
 */
export async function forceAcceptCurrentNativeAlert(page: Page): Promise<boolean> {
  try {
    const context = page.context();
    const session = await context.newCDPSession(page);
    try {
      await session.send('Page.enable');
      await session.send('Page.handleJavaScriptDialog', { accept: true });
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (err) {
    const msg = (err as Error).message || '';
    if (!msg.includes('No dialog') && !msg.includes('handleJavaScriptDialog')) {
      // 静默失败，不打 warn
    }
    return false;
  }
}

/**
 * 短轮询清理原生 alert
 * （来源：NativeAlertGuard.drainNativeAlerts L185-220）
 */
export async function drainNativeAlerts(
  page: Page,
  durationMs: number = TIMEOUT_DRAIN_NORMAL,
  intervalMs: number = 200,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<number> {
  let closed = 0;
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    const ok = await forceAcceptCurrentNativeAlert(page);
    if (ok) {
      closed++;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (closed > 0) {
    log?.('info', `[Agent][Runtime] drainNativeAlerts 关闭 ${closed} 个原生弹窗`, meta);
  }
  return closed;
}

// ══════════════════════════════════════════════════════════
// 2. DOM 弹窗清理
// （来源：backend/browser/PopupManager.ts dismissRechargeCancelDialog）
// ══════════════════════════════════════════════════════════

/**
 * 清理 DOM 弹窗（先判断可见弹窗，只点弹窗内部"取 消/取消"）
 *
 * 策略（来源：PopupManager.dismissRechargeCancelDialog）：
 *   1. 未发现可见弹窗 → 不点击任何按钮
 *   2. 可见弹窗 → 只在弹窗容器内部查找"取 消/取消"
 *   3. 找不到"取 消/取消" → 只记录 warning，不点关闭/X/确定/确认/提交/保存
 *
 * 清理失败不抛异常，只打 warning。
 */
export async function cleanDomPopups(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<CleanDomPopupsResult> {
  try {
    const popup = page.locator(POPUP_CONTAINER_SELECTORS.join(', ')).first();
    const popupCount = await popup.count().catch(() => 0);
    if (popupCount === 0 || !(await popup.isVisible().catch(() => false))) {
      log?.('info', '[Agent][Runtime] cleanDomPopups: no_visible_popup，跳过清理', meta);
      return { cleaned: false, reason: 'no_visible_popup', message: '未发现可见 DOM 弹窗，跳过清理' };
    }

    const className = await popup.evaluate((el) => (el.className || '').toString()).catch(() => '');
    const text = await popup.textContent({ timeout: 1000 }).catch(() => '') || '';
    const popupKind = className.includes('pay-dialog') || text.includes('充值')
      ? '充值弹窗'
      : className.includes('message') ? 'message-box' : 'dialog';

    for (const selector of CANCEL_BUTTON_SELECTORS) {
      const cancelButton = popup.locator(selector).first();
      if (await cancelButton.count().catch(() => 0) > 0 && await cancelButton.isVisible().catch(() => false)) {
        await cancelButton.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
        await page.waitForTimeout(500);
        const reason = popupKind === '充值弹窗'
          ? 'cleaned_pay_dialog'
          : popupKind === 'message-box' ? 'cleaned_message_box' : 'cleaned_dialog';
        log?.('info', `[Agent][Runtime] cleanDomPopups: 发现${popupKind}，点击取 消`, meta);
        return { cleaned: true, reason, message: `发现${popupKind}，已点击取 消` };
      }
    }

    log?.('warning', `[Agent][Runtime] cleanDomPopups: 发现${popupKind}，但未找到弹窗内部取 消按钮，跳过`, meta);
    return { cleaned: false, reason: 'no_cancel_button', message: `发现${popupKind}，但未找到取 消按钮` };
  } catch (err) {
    // 清理失败不阻断主流程
    log?.('warning', `[Agent][Runtime] DOM 弹窗清理异常（忽略）: ${(err as Error).message}`, meta);
    return { cleaned: false, reason: 'error', message: (err as Error).message };
  }
}

// ══════════════════════════════════════════════════════════
// 3. afterPageChangedCleanup
// （来源：backend/browser/BusinessPageNavigator.ts afterPageChangedCleanup L162-217）
// ══════════════════════════════════════════════════════════

/**
 * 页面变化后统一清理钩子
 *
 * 流程：
 *   1. 注册 native alert guard（幂等）
 *   2. drainNativeAlerts（默认短轮询，无弹窗时快速返回）
 *   3. cleanDomPopups
 *   4. 若 DOM 弹窗被关闭，再短轮询确认无残留
 */
export async function afterPageChangedCleanup(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
  scope?: string,
  drainMs?: number,
): Promise<{ alertClosed: boolean; domPopupClosed: boolean; currentUrl: string }> {
  const tag = scope ? `[Agent][Runtime][${scope}]` : '[Agent][Runtime]';

  // 1. 注册 native alert guard（幂等）
  registerNativeAlertGuard(page, log, meta);

  // 2. drainNativeAlerts
  const alertCount = await drainNativeAlerts(page, drainMs ?? TIMEOUT_DRAIN_NORMAL, 200, log, meta);

  // 3. cleanDomPopups
  const popupResult = await cleanDomPopups(page, log, meta);

  // 4. 若 DOM 弹窗被关闭，再 drain 一次确认无残留
  if (popupResult.cleaned) {
    await drainNativeAlerts(page, TIMEOUT_DRAIN_SHORT, 200);
  }

  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }

  if (alertCount > 0 || popupResult.cleaned) {
    log?.('info', `${tag} 清理完成: alert=${alertCount}, domPopup=${popupResult.reason}`, meta);
  } else {
    log?.('info', `${tag} afterPageChangedCleanup: no_visible_popup`, meta);
  }

  return { alertClosed: alertCount > 0, domPopupClosed: popupResult.cleaned, currentUrl };
}

// ══════════════════════════════════════════════════════════
// 4. URL / 页面判断工具
// ══════════════════════════════════════════════════════════

function isOnLogin(url: string): boolean {
  return url.includes(BNSY_LOGIN_FRAGMENT);
}

function isOnHome(url: string): boolean {
  try {
    const u = new URL(url);
    // 大小写不敏感 + 去末尾斜杠
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    return path === '/dashboard' || path === '';
  } catch {
    return url.includes('/dashboard');
  }
}

function isOnTargetPage(url: string, pathFragment: string): boolean {
  try {
    const u = new URL(url);
    // 大小写不敏感 + 去末尾斜杠严格比较（来源：NavigationGovernance.isOnTargetPage）
    const path = u.pathname.toLowerCase().replace(/\/+$/, '');
    const target = pathFragment.toLowerCase().replace(/\/+$/, '');
    return path === target;
  } catch {
    return url.toLowerCase().includes(pathFragment.toLowerCase());
  }
}

async function verifyRequiredElements(page: Page, spec: BusinessPageSpec, timeoutMs: number = TIMEOUT_ELEMENT_WAIT): Promise<boolean> {
  for (const sel of spec.requiredElements) {
    try {
      await page.waitForSelector(sel, { timeout: timeoutMs, state: 'visible' });
    } catch {
      return false;
    }
  }
  return true;
}

async function isHomeReady(page: Page): Promise<boolean> {
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }
  if (isOnLogin(currentUrl)) return false;

  const hasHomeUrl = isOnHome(currentUrl) || currentUrl.toLowerCase().includes('/home');
  const hasHomeDom = await page.evaluate(() => {
    const logo = document.querySelector('.sidebar-logo-container a, .sidebar-logo-container');
    const sidebar = document.querySelector('.el-menu, .sidebar, .sidebar-container, nav.el-menu');
    const main = document.querySelector('.app-main, .main-container, .dashboard-container, section.app-main');
    return {
      logo: !!logo,
      sidebar: !!sidebar,
      main: !!main,
    };
  }).catch(() => ({ logo: false, sidebar: false, main: false }));

  return hasHomeUrl && (hasHomeDom.logo || hasHomeDom.sidebar || hasHomeDom.main);
}

async function clickLogoHome(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  for (const selector of LOGO_SELECTORS) {
    const logo = page.locator(selector).first();
    if (await logo.count().catch(() => 0) === 0) continue;
    if (!(await logo.isVisible().catch(() => false))) continue;

    try {
      log?.('info', `[Agent][Runtime] 点击笨鸟官网 logo 回首页: ${selector}`, meta);
      await logo.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
      await page.waitForTimeout(1200);
      await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_HOME_GOTO }).catch(() => {});
      if (await isHomeReady(page)) {
        log?.('info', '[Agent][Runtime] logo_click 回首页成功', meta);
        return true;
      }
      log?.('warning', `[Agent][Runtime] logo_click 后首页未就绪，currentUrl=${page.url()}`, meta);
    } catch (err) {
      log?.('warning', `[Agent][Runtime] logo_click 失败 selector=${selector}: ${(err as Error).message}`, meta);
    }
  }
  return false;
}

async function gotoHomeFallback(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
  scope: string = 'ensureCleanHome',
): Promise<void> {
  log?.('warning', `[Agent][Runtime] ${scope}: logo_click 失败，url_fallback 到首页: ${BNSY_HOME_URL}`, meta);
  await page.goto(BNSY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_HOME_GOTO });
}

// ══════════════════════════════════════════════════════════
// 5. ensureCleanHome
// （来源：backend/browser/BusinessPageNavigator.ts ensureCleanHome L237-290）
// ══════════════════════════════════════════════════════════

/**
 * 任务开始前恢复干净首页
 *
 * 流程：
 *   1. 先清理弹窗
 *   2. 若在 login 页 → 失败 LOGIN_REQUIRED
 *   3. 若不在首页 → goto dashboard
 *   4. 页面变化后再次清理
 *   5. 验证首页 URL + 侧边栏
 */
export async function ensureCleanHome(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<{ success: boolean; currentUrl: string; error?: string }> {
  log?.('info', '[Agent][Runtime] ensureCleanHome 开始', meta);

  // 1. 判断当前 URL
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }

  if (isOnLogin(currentUrl)) {
    log?.('warning', '[Agent][Runtime] ensureCleanHome 失败：当前在登录页', meta);
    return { success: false, currentUrl, error: 'LOGIN_REQUIRED' };
  }

  // 2. 若已在首页，不做任何跳转；若不在首页，优先真实点击 logo。
  if (await isHomeReady(page)) {
    log?.('info', '[Agent][Runtime] ensureCleanHome: already_home，跳过首页跳转', meta);
  } else {
    const clicked = await clickLogoHome(page, log, meta);
    if (!clicked) {
      try {
        await gotoHomeFallback(page, log, meta, 'ensureCleanHome');
      } catch (err) {
        log?.('warning', `[Agent][Runtime] ensureCleanHome url_fallback 异常: ${(err as Error).message}`, meta);
      }
    }
  }

  // 3. 首页到达后只做弹窗判断；没有弹窗则不点击。
  await afterPageChangedCleanup(page, log, meta, 'ensure-clean-home-after');

  // 4. 验证
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }

  if (!(await isHomeReady(page))) {
    log?.('warning', `[Agent][Runtime] ensureCleanHome 失败：不在首页，currentUrl=${currentUrl}`, meta);
    return { success: false, currentUrl, error: 'NOT_ON_HOME' };
  }
  if (isOnLogin(currentUrl)) {
    log?.('warning', '[Agent][Runtime] ensureCleanHome 失败：被重定向到登录页', meta);
    return { success: false, currentUrl, error: 'LOGIN_REDIRECT' };
  }

  // 侧边栏检查（缺失只 warning，不阻断）
  try {
    const hasSidebar = await page.evaluate(() => {
      return !!(document.querySelector('.el-menu') || document.querySelector('.sidebar') || document.querySelector('.aside-container') || document.querySelector('nav.el-menu'));
    });
    if (!hasSidebar) {
      log?.('warning', '[Agent][Runtime] ensureCleanHome：侧边栏未检测到，但继续执行', meta);
    }
  } catch {
    // 忽略
  }

  log?.('info', '[Agent][Runtime] ensureCleanHome 成功', meta);
  return { success: true, currentUrl };
}

// ══════════════════════════════════════════════════════════
// 6. restoreCleanHome
// （来源：backend/browser/BusinessPageNavigator.ts restoreCleanHome L500-569）
// ══════════════════════════════════════════════════════════

/**
 * 任务结束后恢复干净首页
 *
 * 关键：回首页失败不抛异常，只打 warning，不覆盖原始业务错误。
 */
export async function restoreCleanHome(
  page: Page,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<{ success: boolean; currentUrl: string }> {
  log?.('info', '[Agent][Runtime] restoreCleanHome 开始', meta);

  // 1. 若已在首页，不跳转；若不在首页，优先真实点击 logo。
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }

  if (await isHomeReady(page)) {
    log?.('info', '[Agent][Runtime] restoreCleanHome: skipped_already_home', meta);
  } else {
    const clicked = await clickLogoHome(page, log, meta);
    if (!clicked) {
      try {
        await gotoHomeFallback(page, log, meta, 'restoreCleanHome');
      } catch (err) {
        log?.('warning', `[Agent][Runtime] restoreCleanHome url_fallback 异常: ${(err as Error).message}`, meta);
      }
    }
  }

  // 2. 回到首页后只做弹窗判断；没有弹窗则不点击。
  await afterPageChangedCleanup(page, log, meta, 'restore-home-after');

  // 3. 验证首页
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }

  if (!(await isHomeReady(page))) {
    log?.('warning', `[Agent][Runtime] restoreCleanHome 失败：不在首页，currentUrl=${currentUrl}`, meta);
    return { success: false, currentUrl };
  }

  log?.('info', '[Agent][Runtime] restoreCleanHome 成功', meta);
  return { success: true, currentUrl };
}

// ══════════════════════════════════════════════════════════
// 7. 菜单导航辅助函数
// （来源：backend/browser/NavigationGovernance.ts）
// ══════════════════════════════════════════════════════════

/**
 * 展开一级菜单（如"操作中心"）
 *
 * 策略（来源：NavigationGovernance.openParentMenu L427-466）：
 *   1. 查找 .el-submenu__title 文本匹配
 *   2. 检查父级 .el-submenu 是否已展开（is-opened class）
 *   3. 未展开则点击 title
 *   4. 兜底：.el-menu-item 直接作为一级菜单
 */
async function openParentMenu(page: Page, parentMenuText: string, log?: AgentRuntimeLogFn, meta?: AgentRuntimeMeta): Promise<boolean> {
  try {
    // 1. 查找 .el-submenu__title 文本匹配
    const titleLoc = page.locator('.el-submenu__title');
    const count = await titleLoc.count();
    for (let i = 0; i < count; i++) {
      const loc = titleLoc.nth(i);
      const text = (await loc.textContent().catch(() => '') || '').replace(/\s+/g, '');
      if (text === parentMenuText || text.includes(parentMenuText)) {
        if (!(await loc.isVisible().catch(() => false))) {
          log?.('warning', `[Agent][Navigator] 一级菜单不可见: ${parentMenuText}`, meta);
          continue;
        }
        // 检查父级是否已展开
        const parentSubmenu = await loc.evaluate((el) => {
          const sub = el.closest('.el-submenu');
          return sub ? sub.classList.contains('is-opened') : false;
        }).catch(() => false);

        if (!parentSubmenu) {
          await loc.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
          await page.waitForTimeout(300);
          log?.('info', `[Agent][Navigator] parent menu clicked: ${parentMenuText}`, meta);
        } else {
          log?.('info', `[Agent][Navigator] parent menu already opened: ${parentMenuText}`, meta);
        }
        return true;
      }
    }

    // 2. 兜底：.el-menu-item 直接作为一级菜单
    const itemLoc = page.locator('.el-menu-item');
    const itemCount = await itemLoc.count();
    for (let i = 0; i < itemCount; i++) {
      const loc = itemLoc.nth(i);
      const text = (await loc.textContent().catch(() => '') || '').replace(/\s+/g, '');
      if (text === parentMenuText || text.includes(parentMenuText)) {
        if (!(await loc.isVisible().catch(() => false))) continue;
        log?.('info', `[Agent][Navigator] 一级菜单直接匹配 .el-menu-item: ${parentMenuText}`, meta);
        return true;
      }
    }

    log?.('warning', `[Agent][Navigator] 未找到一级菜单: ${parentMenuText}`, meta);
    return false;
  } catch (err) {
    log?.('warning', `[Agent][Navigator] 展开一级菜单异常: ${(err as Error).message}`, meta);
    return false;
  }
}

/**
 * 点击二级/三级菜单项
 *
 * 策略（来源：NavigationGovernance.clickChildMenuItem L470-490）：
 *   1. 查找 .el-menu-item 文本精确匹配
 *   2. 兜底 includes 模糊匹配
 */
async function clickChildMenuItem(page: Page, childMenuText: string, log?: AgentRuntimeLogFn, meta?: AgentRuntimeMeta): Promise<boolean> {
  try {
    const itemLoc = page.locator('.el-menu-item');
    const count = await itemLoc.count();

    // 1. 精确匹配优先
    for (let i = 0; i < count; i++) {
      const loc = itemLoc.nth(i);
      const text = (await loc.textContent().catch(() => '') || '').replace(/\s+/g, '');
      if (text === childMenuText) {
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
        log?.('info', `[Agent][Navigator] child menu clicked: ${childMenuText}`, meta);
        return true;
      }
    }

    // 2. includes 模糊匹配
    for (let i = 0; i < count; i++) {
      const loc = itemLoc.nth(i);
      const text = (await loc.textContent().catch(() => '') || '').replace(/\s+/g, '');
      if (text.includes(childMenuText) || childMenuText.includes(text)) {
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
        log?.('info', `[Agent][Navigator] child menu clicked fuzzy: ${childMenuText}`, meta);
        return true;
      }
    }

    log?.('warning', `[Agent][Navigator] 未找到菜单项: ${childMenuText}`, meta);
    return false;
  } catch (err) {
    log?.('warning', `[Agent][Navigator] 点击菜单项异常: ${(err as Error).message}`, meta);
    return false;
  }
}

/**
 * 尝试通过侧边栏菜单导航到业务页面
 */
async function trySidebarNavigate(
  page: Page,
  spec: BusinessPageSpec,
  businessType: BusinessType,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  try {
    log?.('info', `[Agent][Navigator] ${businessType} sidebar_first start`, meta);
    // 1. 展开一级菜单
    const parentOk = await openParentMenu(page, spec.parentMenu, log, meta);
    if (!parentOk) return false;

    // 2. 若有中间菜单（sign 的"签收"），先展开
    if (spec.intermediateMenu) {
      // 中间菜单可能是 .el-submenu__title，也可能需要再次展开
      const interLoc = page.locator('.el-submenu__title');
      const interCount = await interLoc.count();
      let interOpened = false;
      for (let i = 0; i < interCount; i++) {
        const loc = interLoc.nth(i);
        const text = (await loc.textContent().catch(() => '') || '').replace(/\s+/g, '');
        if (text === spec.intermediateMenu || text.includes(spec.intermediateMenu)) {
          const isOpened = await loc.evaluate((el) => {
            const sub = el.closest('.el-submenu');
            return sub ? sub.classList.contains('is-opened') : false;
          }).catch(() => false);
          if (!isOpened) {
            if (!(await loc.isVisible().catch(() => false))) continue;
            await loc.click({ timeout: TIMEOUT_SIDEBAR_CLICK });
            await page.waitForTimeout(300);
          }
          interOpened = true;
          log?.('info', `[Agent][Navigator] 已展开中间菜单: ${spec.intermediateMenu}`, meta);
          break;
        }
      }
      if (!interOpened) {
        log?.('warning', `[Agent][Navigator] 未找到中间菜单: ${spec.intermediateMenu}`, meta);
      }
    }

    // 3. 点击目标菜单项
    const childOk = await clickChildMenuItem(page, spec.childMenu, log, meta);
    if (!childOk) return false;

    // 4. 等待页面加载
    await page.waitForTimeout(1500);
    try {
      await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
    } catch {
      // 忽略
    }

    // 5. 清理弹窗
    await afterPageChangedCleanup(page, log, meta, 'after-sidebar-click');

    // 6. URL 验证
    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch {
      currentUrl = '';
    }

    // sidebar 阶段只判断真实点击结果，不在这里偷偷 URL 跳转。
    if (isOnHome(currentUrl) || isOnLogin(currentUrl)) {
      log?.('warning', `[Agent][Navigator] 菜单真实点击后仍在首页/登录页: ${currentUrl}`, meta);
      return false;
    }

    // 7. 最终验证
    try {
      currentUrl = page.url();
    } catch {
      currentUrl = '';
    }
    if (!isOnTargetPage(currentUrl, spec.pathFragment)) {
      log?.('warning', `[Agent][Navigator] URL 不在目标页: ${currentUrl}（期望含 ${spec.pathFragment}）`, meta);
      return false;
    }

    const elementsOk = await verifyRequiredElements(page, spec);
    if (!elementsOk) {
      log?.('warning', `[Agent][Navigator] 必需元素未就绪`, meta);
      return false;
    }

    log?.('success', `[Agent][Navigator] ${businessType} verify success`, meta);
    return true;
  } catch (err) {
    log?.('warning', `[Agent][Navigator] trySidebarNavigate 异常: ${(err as Error).message}`, meta);
    return false;
  }
}

/**
 * URL 兜底导航
 */
async function tryUrlNavigate(
  page: Page,
  spec: BusinessPageSpec,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  try {
    log?.('info', `[Agent][Navigator] URL 兜底导航: ${spec.url}`, meta);
    try {
      await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_URL_GOTO });
    } catch {
      // 兜底：location.href
      try {
        await page.evaluate((url: string) => { window.location.href = url; }, spec.url);
        await page.waitForTimeout(2000);
      } catch (err2) {
        log?.('warning', `[Agent][Navigator] URL 兜底 location.href 失败: ${(err2 as Error).message}`, meta);
      }
    }

    // 等待页面元素
    try {
      await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: 3000 }).catch(() => {});
      await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 3000 }).catch(() => {});
    } catch {
      // 忽略
    }

    await afterPageChangedCleanup(page, log, meta, 'url-fallback', TIMEOUT_DRAIN_LONG);

    // 验证
    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch {
      currentUrl = '';
    }
    if (!isOnTargetPage(currentUrl, spec.pathFragment)) {
      log?.('warning', `[Agent][Navigator] URL 兜底后仍不在目标页: ${currentUrl}`, meta);
      return false;
    }

    const elementsOk = await verifyRequiredElements(page, spec);
    if (!elementsOk) {
      log?.('warning', `[Agent][Navigator] URL 兜底后必需元素未就绪`, meta);
      return false;
    }

    return true;
  } catch (err) {
    log?.('warning', `[Agent][Navigator] tryUrlNavigate 异常: ${(err as Error).message}`, meta);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 8. navigateToBusinessPageMenuFirst
// （来源：backend/browser/BusinessPageNavigator.ts navigateToBusinessPage L308-374）
// ══════════════════════════════════════════════════════════

/**
 * 菜单优先业务页面导航
 *
 * 策略三段式：sidebar_first → sidebar_retry → url_fallback
 *
 * 流程：
 *   1. 快速短路：若已在目标页且元素就绪 → 成功
 *   2. ensureCleanHome
 *   3. sidebar_first：菜单点击 + 验证
 *   4. sidebar_retry：回首页 + 再次菜单点击
 *   5. url_fallback：回首页 + URL 兜底
 *   6. 全部失败 → 返回 failed
 */
export async function navigateToBusinessPageMenuFirst(
  page: Page,
  businessType: BusinessType,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<NavigateResult> {
  const spec = BUSINESS_SPECS[businessType];
  log?.('info', `[Agent][Navigator] ${businessType} 菜单优先导航开始`, meta);

  // 1. 快速短路：若已在目标页且元素就绪
  let currentUrl = '';
  try {
    currentUrl = page.url();
  } catch {
    currentUrl = '';
  }
  if (isOnTargetPage(currentUrl, spec.pathFragment)) {
    const elementsOk = await verifyRequiredElements(page, spec, 2000).catch(() => false);
    if (elementsOk) {
      await afterPageChangedCleanup(page, log, meta, 'already-on-page');
      log?.('info', `[Agent][Navigator] ${businessType} 已在目标页，直接使用`, meta);
      return { success: true, method: 'already_on_page', pageUrl: currentUrl, message: '已在目标页' };
    }
  }

  // 2. ensureCleanHome
  const homeResult = await ensureCleanHome(page, log, meta);
  if (!homeResult.success) {
    log?.('warning', `[Agent][Navigator] ${businessType} 首页恢复失败: ${homeResult.error}`, meta);
    // 首页失败仍然尝试 URL 兜底
    const urlOk = await tryUrlNavigate(page, spec, log, meta);
    if (urlOk) {
      return { success: true, method: 'url_fallback', pageUrl: page.url(), message: '首页恢复失败后 URL 兜底成功' };
    }
    return { success: false, method: 'failed', pageUrl: page.url(), message: `首页恢复失败: ${homeResult.error}` };
  }

  // 3. sidebar_first
  const sidebar1Ok = await trySidebarNavigate(page, spec, businessType, log, meta);
  if (sidebar1Ok) {
    log?.('info', `[Agent][Navigator] ${businessType} 第一次菜单点击成功`, meta);
    return { success: true, method: 'sidebar_first', pageUrl: page.url(), message: '菜单优先导航成功' };
  }
  log?.('warning', `[Agent][Navigator] ${businessType} 第一次菜单点击失败`, meta);

  // 4. sidebar_retry
  log?.('info', `[Agent][Navigator] ${businessType} 菜单失败，回首页后重试`, meta);
  await restoreCleanHome(page, log, meta);
  const sidebar2Ok = await trySidebarNavigate(page, spec, businessType, log, meta);
  if (sidebar2Ok) {
    log?.('info', `[Agent][Navigator] ${businessType} 第二次菜单点击成功`, meta);
    return { success: true, method: 'sidebar_retry', pageUrl: page.url(), message: '菜单重试导航成功' };
  }
  log?.('warning', `[Agent][Navigator] ${businessType} 第二次菜单点击失败`, meta);

  // 5. url_fallback
  log?.('info', `[Agent][Navigator] ${businessType} 使用 URL 兜底`, meta);
  await restoreCleanHome(page, log, meta);
  const urlOk = await tryUrlNavigate(page, spec, log, meta);
  if (urlOk) {
    return { success: true, method: 'url_fallback', pageUrl: page.url(), message: 'URL 兜底导航成功' };
  }

  // 6. 全部失败
  log?.('error', `[Agent][Navigator] ${businessType} 导航全部失败`, meta);
  return { success: false, method: 'failed', pageUrl: page.url(), message: `${businessType} 导航全部失败` };
}

// ══════════════════════════════════════════════════════════
// 9. Logger 适配器
// ══════════════════════════════════════════════════════════

/**
 * 从 AgentLogger 创建 RuntimeLogFn
 *
 * AgentLogger 有 4 级（info/success/warning/error），
 * RuntimeLogFn 也用同样 4 级，直接透传。
 */
export function createRuntimeLogFn(
  logger: {
    info: (msg: string, meta?: AgentRuntimeMeta) => void;
    success: (msg: string, meta?: AgentRuntimeMeta) => void;
    warning: (msg: string, meta?: AgentRuntimeMeta) => void;
    error: (msg: string, meta?: AgentRuntimeMeta) => void;
  },
  defaultMeta?: AgentRuntimeMeta,
): AgentRuntimeLogFn {
  return (level, message, meta) => {
    const mergedMeta = { ...defaultMeta, ...meta };
    switch (level) {
      case 'info':
        logger.info(message, mergedMeta);
        break;
      case 'success':
        logger.success(message, mergedMeta);
        break;
      case 'warning':
        logger.warning(message, mergedMeta);
        break;
      case 'error':
        logger.error(message, mergedMeta);
        break;
    }
  };
}
