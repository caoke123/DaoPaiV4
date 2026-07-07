// NavigationGovernance — 菜单优先导航治理
// Phase D-2A: 菜单优先导航 + URL 降级 + 导航统计
// 禁止业务模块直接 page.goto()

import type { Page } from 'playwright';
import { PageStateManager } from './PageStateManager';
import { PopupManager } from './PopupManager';
import { RuntimeMetrics } from '../runtime/RuntimeMetrics';
import type { WindowCapability } from './PageStateManager';
import { drainNativeAlerts, forceAcceptCurrentNativeAlert } from './NativeAlertGuard';

// ── 类型定义 ──────────────────────────────────────────

export type { WindowCapability };

export type NavigationMethod = 'menu' | 'url_fallback';

export interface NavigateResult {
  success: boolean;
  method: NavigationMethod;
  targetUrl: string;
  attemptedMenu: boolean;
  menuSuccess: boolean;
  fallbackUsed: boolean;
  error?: string;
  durationMs: number;
}

export interface NavigateOptions {
  tryMenu?: boolean;
  menuTimeout?: number;
  urlTimeout?: number;
  verifyAfter?: boolean;
  menuRetries?: number;
}

export interface NavigationStats {
  totalNavigations: number;
  menuSuccess: number;
  menuFailed: number;
  urlFallbackUsed: number;
  urlFallbackSuccess: number;
  totalFailures: number;
  averageDurationMs: number;
  byCapability: Record<WindowCapability, { navigations: number; menuSuccess: number; failures: number }>;
}

// ── 菜单路径配置 ─────────────────────────────────────

interface MenuPath {
  parentMenu: string;
  childMenu: string;
  fallbackUrl: string;
  /** 三级菜单中间层：例如 "操作中心 > 签收 > 签收录入" 中的 "签收" */
  intermediateMenu?: string;
}

const MENU_PATHS: Record<WindowCapability, MenuPath> = {
  arrival: {
    parentMenu: '操作中心',
    childMenu: '到件扫描(批量)',
    fallbackUrl: '/scanning/ArrivalscanBatch',
  },
  dispatch: {
    parentMenu: '操作中心',
    childMenu: '派件扫描',
    fallbackUrl: '/scanning/dispatchscan',
  },
  sign: {
    parentMenu: '操作中心',
    intermediateMenu: '签收',
    childMenu: '签收录入',
    fallbackUrl: '/scanning/signFor/signForInput',
  },
  // 到派一体:到件扫描页面(非批量),URL 降级确保可靠(菜单文本与 arrival 冲突)
  integrated: {
    parentMenu: '操作中心',
    childMenu: '到件扫描',
    fallbackUrl: '/scanning/arrivalscan',
  },
};

const BASE_URL = 'https://bnsy.benniaosuyun.com';

/**
 * 精确判断当前 URL 是否在目标页面路径上。
 * - 提取 pathname 做比较，忽略 query/hash
 * - 大小写不敏感（path 统一小写化）
 * - 去除末尾斜杠后再做严格相等比较，避免子串重叠（如 arrivalscan vs ArrivalscanBatch）
 */
function isOnTargetPage(currentUrl: string, targetPath: string): boolean {
  const currentPath = new URL(currentUrl).pathname.toLowerCase().replace(/\/$/, '');
  const target = targetPath.toLowerCase().replace(/\/$/, '');
  return currentPath === target;
}

// ── NavigationGovernance 类 ──────────────────────────

export class NavigationGovernance {
  private static instance: NavigationGovernance | null = null;

  private stats: NavigationStats = this.createEmptyStats();

  private constructor() {}

  static getInstance(): NavigationGovernance {
    if (!NavigationGovernance.instance) {
      NavigationGovernance.instance = new NavigationGovernance();
    }
    return NavigationGovernance.instance;
  }

  getStats(): NavigationStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = this.createEmptyStats();
  }

  // ── navigateTo: 主入口 ──

  async navigateTo(
    page: Page,
    capability: WindowCapability,
    options?: NavigateOptions,
  ): Promise<NavigateResult> {
    const startTime = Date.now();
    const menuPath = MENU_PATHS[capability];
    const tryMenu = options?.tryMenu ?? true;
    const verifyAfter = options?.verifyAfter ?? true;
    const menuRetries = options?.menuRetries ?? 1;

    this.stats.totalNavigations++;
    if (!this.stats.byCapability[capability]) {
      this.stats.byCapability[capability] = { navigations: 0, menuSuccess: 0, failures: 0 };
    }
    this.stats.byCapability[capability].navigations++;

    // 已在目标页面 → 直接返回
    if (isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
      console.log(`[Navigation] 已在目标页面 ${menuPath.fallbackUrl}`);
      if (verifyAfter) {
        const state = await PageStateManager.getInstance().ensureReadyForTask(page, capability, { autoFix: true });
        if (!state.ready) {
          this.stats.totalFailures++;
          this.stats.byCapability[capability].failures++;
          return {
            success: false,
            method: 'menu',
            targetUrl: page.url(),
            attemptedMenu: false,
            menuSuccess: false,
            fallbackUsed: false,
            error: `页面状态检查未通过: ${state.blockedBy.join(', ')}`,
            durationMs: Date.now() - startTime,
          };
        }
      }
      return {
        success: true,
        method: 'menu',
        targetUrl: page.url(),
        attemptedMenu: false,
        menuSuccess: true,
        fallbackUsed: false,
        durationMs: Date.now() - startTime,
      };
    }

    let menuSuccess = false;

    // Step 1: 尝试菜单导航
    if (tryMenu) {
      for (let retry = 0; retry < menuRetries; retry++) {
        menuSuccess = await this.navigateByMenu(page, capability);
        if (menuSuccess) break;
        if (retry < menuRetries - 1) {
          console.log(`[Navigation] 菜单导航失败，重试 (${retry + 1}/${menuRetries - 1})`);
          await page.waitForTimeout(1000);
        }
      }

      if (menuSuccess) {
        this.stats.menuSuccess++;
        this.stats.byCapability[capability].menuSuccess++;

        if (verifyAfter) {
          // 先验证 URL 是否真的到达了目标页面，防止菜单点击成功但实际未导航的情况
          if (!isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
            console.warn(`[Navigation] 菜单点击成功但 URL 未变化: ${page.url()}，预期: ${menuPath.fallbackUrl}`);
            this.stats.totalFailures++;
            this.stats.byCapability[capability].failures++;
            return {
              success: false,
              method: 'menu',
              targetUrl: page.url(),
              attemptedMenu: true,
              menuSuccess: true,
              fallbackUsed: false,
              error: `菜单点击后页面未导航到目标路径 (当前: ${page.url()})`,
              durationMs: Date.now() - startTime,
            };
          }
          // URL 验证通过即认为导航成功；完整状态检查交给调用方（如 SignScan.executeSign）
          console.log(`[Navigation] URL 验证通过: ${page.url()}`);
        }

        this.updateAverageDuration(Date.now() - startTime);
        return {
          success: true,
          method: 'menu',
          targetUrl: page.url(),
          attemptedMenu: true,
          menuSuccess: true,
          fallbackUsed: false,
          durationMs: Date.now() - startTime,
        };
      }

      this.stats.menuFailed++;
      RuntimeMetrics.getInstance().navigationFixed();
      console.warn(`[Navigation] 菜单导航失败，降级为 URL 直连: ${capability}`);
    }

    // Step 2: URL 降级
    this.stats.urlFallbackUsed++;
    const urlSuccess = await this.navigateByUrl(page, capability);

    if (urlSuccess) {
      this.stats.urlFallbackSuccess++;

      // 导航后清理充值/取消弹窗（短超时，不做全量清理）
      await PopupManager.getInstance().dismissRechargeCancelDialog(page).catch(() => false);

      if (verifyAfter) {
        // 仅做 URL 验证，不调用 ensureReadyForTask（避免 autoFix → navigateViaMenu → navigateTo 无限递归）
        if (!isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
          console.warn(`[Navigation] URL 降级后未到达目标页面: ${page.url()}，预期: ${menuPath.fallbackUrl}`);
          this.stats.totalFailures++;
          this.stats.byCapability[capability].failures++;
          return {
            success: false,
            method: 'url_fallback',
            targetUrl: page.url(),
            attemptedMenu: tryMenu,
            menuSuccess: false,
            fallbackUsed: true,
            error: `URL 降级后页面重定向，未到达目标路径 (当前: ${page.url()})`,
            durationMs: Date.now() - startTime,
          };
        }
      }

      this.updateAverageDuration(Date.now() - startTime);
      return {
        success: true,
        method: 'url_fallback',
        targetUrl: page.url(),
        attemptedMenu: tryMenu,
        menuSuccess: false,
        fallbackUsed: true,
        durationMs: Date.now() - startTime,
      };
    }

    // 全部失败
    this.stats.totalFailures++;
    this.stats.byCapability[capability].failures++;
    return {
      success: false,
      method: 'url_fallback',
      targetUrl: page.url(),
      attemptedMenu: tryMenu,
      menuSuccess: false,
      fallbackUsed: true,
      error: '菜单导航和 URL 直连均失败',
      durationMs: Date.now() - startTime,
    };
  }

  // ── navigateBusinessPage: URL 优先导航（Phase 5-G-8-1） ──
  //
  // 核心策略：
  // 1. 切换前先快速清理最上层 .el-message-box 的"取 消"
  // 2. 使用 page.goto 进行目标 URL 导航
  // 3. 等 URL 进入目标路径
  // 4. 导航后再清理一次"取 消"
  // 5. 等目标页面关键元素（.app-container）出现
  // 不依赖菜单点击，不做全量弹窗清理，失败快速返回

  async navigateBusinessPage(
    page: Page,
    capability: WindowCapability,
  ): Promise<{ success: boolean; method: 'url_direct'; durationMs: number; error?: string }> {
    const startTime = Date.now();
    const menuPath = MENU_PATHS[capability];
    const targetUrl = BASE_URL + menuPath.fallbackUrl;
    const popupMgr = PopupManager.getInstance();

    // Step 0: 导航前清理 — 先 drain 原生 alert，再清理 DOM 充值弹窗
    await drainNativeAlerts(page, { durationMs: 1000, intervalMs: 200, scope: 'before-navigation' }).catch(() => 0);
    await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);

    // Step 1: URL 直接导航
    let navSuccess = false;
    try {
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      navSuccess = response !== null && (response.ok === undefined || response.ok());
    } catch (e) {
      const errMsg = (e as Error).message;
      console.warn(`[Navigation] navigateBusinessPage goto 异常: ${errMsg}`);
      navSuccess = false;
    }

    if (!navSuccess) {
      // 尝试 location.href 兜底（不等待load事件）
      try {
        await page.evaluate((url) => { window.location.href = url; }, targetUrl).catch(() => {});
      } catch { /* ignore */ }
      // 等待URL变化
      try {
        await page.waitForURL((url) => isOnTargetPage(url.toString(), menuPath.fallbackUrl), { timeout: 10000 });
        if (isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
          navSuccess = true;
        }
      } catch { /* timeout */ }
    }

    // Step 2: 等待 URL 匹配
    if (navSuccess) {
      try {
        await page.waitForURL((url) => isOnTargetPage(url.toString(), menuPath.fallbackUrl), { timeout: 5000 });
      } catch {
        if (!isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
          navSuccess = false;
        }
      }
    }

    if (!navSuccess) {
      return { success: false, method: 'url_direct', durationMs: Date.now() - startTime, error: `URL导航失败: ${page.url()} -> ${targetUrl}` };
    }

    // Step 3: 等待页面DOM加载（关键容器出现）
    await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 5000 }).catch(() => {});

    // Step 4: 导航后清理 — 先 drain 原生 alert（可能在页面加载后才出现），再清理 DOM 充值弹窗
    await drainNativeAlerts(page, { durationMs: 2000, intervalMs: 200, scope: 'after-navigation' }).catch(() => 0);
    await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);

    // Step 5: 最终验证URL正确
    const finalUrl = page.url();
    if (!isOnTargetPage(finalUrl, menuPath.fallbackUrl)) {
      console.error(`[Navigation] navigateBusinessPage 最终URL不匹配: ${finalUrl}, 预期: ${menuPath.fallbackUrl}`);
      return { success: false, method: 'url_direct', durationMs: Date.now() - startTime, error: `最终URL不匹配: ${finalUrl}` };
    }

    console.log(`[Navigation] navigateBusinessPage 成功: ${finalUrl} (${Date.now() - startTime}ms)`);
    return { success: true, method: 'url_direct', durationMs: Date.now() - startTime };
  }

  // ── navigateByMenu: 菜单导航 ──

  async navigateByMenu(page: Page, capability: WindowCapability): Promise<boolean> {
    const menuPath = MENU_PATHS[capability];

    // Step 1: 确保侧边栏展开
    const sidebarResult = await PageStateManager.getInstance().ensureSidebarExpanded(page);
    if (!sidebarResult.expanded) {
      console.warn('[Navigation] 侧边栏无法展开，菜单导航不可用');
      return false;
    }

    // Step 2: 查找并展开一级菜单 (El-Submenu)
    const parentMenuOpened = await this.openParentMenu(page, menuPath.parentMenu);
    if (!parentMenuOpened) {
      console.warn(`[Navigation] 一级菜单 "${menuPath.parentMenu}" 未找到`);
      return false;
    }

    // Step 3a: 如果有中间层子菜单，先展开（如：操作中心 > 签收 > 签收录入）
    if (menuPath.intermediateMenu) {
      const intermediateOpened = await this.openParentMenu(page, menuPath.intermediateMenu);
      if (!intermediateOpened) {
        console.warn(`[Navigation] 中间子菜单 "${menuPath.intermediateMenu}" 未找到`);
        return false;
      }
      // 等待中间子菜单动画展开
      await page.waitForTimeout(500);
    }

    // Step 3b: 查找并点击目标菜单项 (El-Menu-Item)
    const childClicked = await this.clickChildMenuItem(page, menuPath.childMenu);
    if (!childClicked) {
      console.warn(`[Navigation] 目标菜单项 "${menuPath.childMenu}" 未找到`);
      return false;
    }

    // Step 4: 等待 URL 变化
    console.log(`[Navigation] 等待 URL 变化，当前: ${page.url()}, 目标: ${menuPath.fallbackUrl}`);
    try {
      await page.waitForURL(
        (url) => {
          const matches = isOnTargetPage(url.toString(), menuPath.fallbackUrl);
          if (matches) console.log(`[Navigation] waitForURL 回调: URL匹配! ${url.toString()}`);
          return matches;
        },
        { timeout: 10000 },
      );
      console.log(`[Navigation] waitForURL 成功，当前URL: ${page.url()}`);
      console.log(`[Navigation] 菜单导航成功: ${page.url()}`);
      return true;
    } catch {
      console.warn(`[Navigation] waitForURL 超时 (10s)，当前URL: ${page.url()}`);
      // 二次检查：当前 URL 是否已包含目标路径
      if (isOnTargetPage(page.url(), menuPath.fallbackUrl)) {
        console.log(`[Navigation] 二次检查通过，URL已在目标路径`);
        return true;
      }
      console.warn(`[Navigation] 菜单点击后 URL 未变化到预期路径，当前: ${page.url()}`);
      return false;
    }
  }

  private async openParentMenu(page: Page, menuText: string): Promise<boolean> {
    // 先尝试找 el-submenu
    const submenuTitles = await page.$$('.el-submenu__title').catch(() => []);
    for (const title of submenuTitles) {
      const text = (await title.textContent().catch(() => ''))?.trim();
      if (text === menuText || text?.includes(menuText)) {
        // 检查是否已展开 (aria-expanded)
        const parentEl = await title.evaluateHandle(el => el.closest('.el-submenu')).catch(() => null);
        if (parentEl) {
          const isOpened = await parentEl.evaluate((el: Element | null) => el?.classList.contains('is-opened') ?? false).catch(() => false);
          if (isOpened) {
            console.log(`[Navigation] 一级菜单 "${menuText}" 已展开`);
            return true;
          }
        }
        // 点击展开
        const isVisible = await title.isVisible().catch(() => false);
        if (isVisible) {
          await title.click().catch(() => {});
          await page.waitForTimeout(300);
          console.log(`[Navigation] 点击一级菜单 "${menuText}"`);
          return true;
        }
      }
    }

    // Fallback: 尝试 el-menu-item 作为一级菜单
    const menuItems = await page.$$('.el-menu-item').catch(() => []);
    for (const item of menuItems) {
      const text = (await item.textContent().catch(() => ''))?.trim();
      if (text === menuText) {
        const isVisible = await item.isVisible().catch(() => false);
        if (isVisible) {
          await item.click().catch(() => {});
          await page.waitForTimeout(300);
          return true;
        }
      }
    }

    return false;
  }

  private async clickChildMenuItem(page: Page, menuText: string): Promise<boolean> {
    // 查找所有可见的 el-menu-item
    const menuItems = await page.$$('.el-menu-item').catch(() => []);
    for (const item of menuItems) {
      const text = (await item.textContent().catch(() => ''))?.trim();
      if (text === menuText) {
        const isVisible = await item.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[Navigation] 点击二级菜单 "${menuText}"`);
          await item.click().catch(() => {});
          return true;
        }
      }
    }
    // 模糊匹配（含子字符串）
    for (const item of menuItems) {
      const text = (await item.textContent().catch(() => ''))?.trim();
      if (text?.includes(menuText)) {
        const isVisible = await item.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[Navigation] 模糊匹配点击 "${text}" (查找: "${menuText}")`);
          await item.click().catch(() => {});
          return true;
        }
      }
    }

    // 三级菜单支持：目标菜单项可能嵌套在未展开的子菜单内
    // 例如：操作中心 > 签收 > 签收录入
    // 遍历所有不可见的 el-menu-item，找到包含目标文本的，展开其父级子菜单
    for (const item of menuItems) {
      const text = (await item.textContent().catch(() => ''))?.trim();
      if (text === menuText || text?.includes(menuText)) {
        const isVisible = await item.isVisible().catch(() => false);
        if (isVisible) continue;

        // 向上查找最近的未展开 el-submenu 父级
        const parentSubmenuHandle = await item.evaluateHandle((el: Element) => {
          let node = el.parentElement;
          while (node && node !== document.body) {
            if (node.classList.contains('el-submenu') && !node.classList.contains('is-opened')) {
              return node;
            }
            node = node.parentElement;
          }
          return null;
        }).catch(() => null);

        if (parentSubmenuHandle) {
          const titleEl = await (parentSubmenuHandle as any).$('.el-submenu__title').catch(() => null);
          if (titleEl) {
            const titleVisible = await titleEl.isVisible().catch(() => false);
            if (titleVisible) {
              const titleText = (await titleEl.textContent().catch(() => ''))?.trim();
              console.log(`[Navigation] 展开嵌套子菜单 "${titleText}" 以显示 "${menuText}"`);
              await titleEl.click().catch(() => {});
              await page.waitForTimeout(500);

              // 再次尝试点击目标菜单项
              const isVisibleNow = await item.isVisible().catch(() => false);
              if (isVisibleNow) {
                console.log(`[Navigation] 点击嵌套菜单项 "${menuText}"`);
                await item.click().catch(() => {});
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  // ── navigateByUrl: URL 降级 ──

  async navigateByUrl(page: Page, capability: WindowCapability): Promise<boolean> {
    const menuPath = MENU_PATHS[capability];
    const url = BASE_URL + menuPath.fallbackUrl;
    const popupMgr = PopupManager.getInstance();

    try {
      // Phase 5-G-8-3: 导航前先 drain 原生 alert
      await drainNativeAlerts(page, { durationMs: 1000, intervalMs: 200, scope: 'before-url-fallback' }).catch(() => 0);
      await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: 5000 }).catch(() => {});
      await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
      // 导航后 drain 原生 alert + DOM 弹窗
      await drainNativeAlerts(page, { durationMs: 1500, intervalMs: 200, scope: 'after-url-fallback' }).catch(() => 0);
      await popupMgr.dismissRechargeCancelDialog(page).catch(() => false);
      console.log(`[Navigation] URL 降级成功: ${page.url()}`);
      return true;
    } catch (e) {
      console.error(`[Navigation] URL 降级失败: ${(e as Error).message}`);
      return false;
    }
  }

  // ── 内部辅助 ────────────────────────────────────────

  private updateAverageDuration(durationMs: number): void {
    if (this.stats.totalNavigations <= 1) {
      this.stats.averageDurationMs = durationMs;
    } else {
      this.stats.averageDurationMs =
        (this.stats.averageDurationMs * (this.stats.totalNavigations - 1) + durationMs) / this.stats.totalNavigations;
    }
  }

  private createEmptyStats(): NavigationStats {
    return {
      totalNavigations: 0,
      menuSuccess: 0,
      menuFailed: 0,
      urlFallbackUsed: 0,
      urlFallbackSuccess: 0,
      totalFailures: 0,
      averageDurationMs: 0,
      byCapability: {
        arrival: { navigations: 0, menuSuccess: 0, failures: 0 },
        dispatch: { navigations: 0, menuSuccess: 0, failures: 0 },
        sign: { navigations: 0, menuSuccess: 0, failures: 0 },
        integrated: { navigations: 0, menuSuccess: 0, failures: 0 },
      },
    };
  }
}
