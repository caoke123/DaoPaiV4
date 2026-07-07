// PopupManager — 统一弹窗治理
// 覆盖: 原生 dialog (alert/confirm/prompt) + DOM 弹窗 (pay-dialog/el-dialog/message-box) + overlay + toast
// Phase D-2A: 统一入口，替代 BrowserPool 内联 dialog handler 和 index.ts 的 setInterval(dismissAllPopups, 10s)

import type { Page, ElementHandle } from 'playwright';
import { RuntimeMetrics } from '../runtime/RuntimeMetrics';

// ── 类型定义 ──────────────────────────────────────────

/** 弹窗类型 */
export type PopupType =
  | 'native-alert'
  | 'native-confirm'
  | 'native-prompt'
  | 'pay-dialog'
  | 'el-dialog'
  | 'el-message-box'
  | 'custom-overlay'
  | 'toast';

/** 可见弹窗的详细信息 */
export interface VisiblePopup {
  type: PopupType;
  visible: boolean;
  text: string;
  selector: string;
  dismissible: boolean;
}

/** 弹窗清除选项 */
export interface DismissOptions {
  timeout?: number;
  maxRounds?: number;
  verifyAfter?: boolean;
}

/** 弹窗统计 */
export interface PopupStats {
  nativeAlertDismissed: number;
  nativeConfirmDismissed: number;
  payDialogDismissed: number;
  messageBoxDismissed: number;
  otherDismissed: number;
  totalCleanupCalls: number;
  totalCleanupFailures: number;
  lastCleanupTime: string | null;
}

// ── 关键词常量 ────────────────────────────────────────

/** 不需要二次确认就能关闭的按钮文本 */
const DISMISS_BTN_TEXTS = ['取消', '关闭', '否', '暂不', '忽略', '跳过', '我再想想', '以后再说'];

/** 二次确认关闭弹窗的识别关键词 — Phase D-2A 修正: 补充"确认关闭" */
const CLOSE_CONFIRM_KEYWORDS = [
  '确定关闭', '是否关闭', '确认关闭', '确定要关闭',
  '确定取消', '确认取消',
  '放弃修改', '放弃保存', '不保存',
  '退出当前', '退出编辑',
  '关闭页面', '关闭窗口',
  '取消支付', '放弃支付', '关闭支付',
];

/** 顽固弹窗选择器 */
const STUBBORN_DIALOG_SELECTORS = [
  '.el-dialog__wrapper:not([style*="display: none"])',
  '.pay-dialog:not([style*="display: none"])',
];

// ── PopupManager 类 ───────────────────────────────────

export class PopupManager {
  private static instance: PopupManager | null = null;

  private stats: PopupStats = {
    nativeAlertDismissed: 0,
    nativeConfirmDismissed: 0,
    payDialogDismissed: 0,
    messageBoxDismissed: 0,
    otherDismissed: 0,
    totalCleanupCalls: 0,
    totalCleanupFailures: 0,
    lastCleanupTime: null,
  };

  /** 已注册 dialog handler 的 page 集合（WeakSet 防止重复注册） */
  private registeredPages = new WeakSet<Page>();
  /** 登录守卫期间暂停自动处理原生 dialog，让外层按超时重启策略处理 */
  private suspendedDialogPages = new WeakSet<Page>();

  private constructor() {}

  static getInstance(): PopupManager {
    if (!PopupManager.instance) {
      PopupManager.instance = new PopupManager();
    }
    return PopupManager.instance;
  }

  // ── register: 为 page 注册全局 dialog 拦截器 ──

  /**
   * 为指定 page 注册全局弹窗拦截
   * 替代 BrowserPool 中的 page.on('dialog') 内联注册
   *
   * @param page      Playwright Page
   * @param staffName 可选，员工姓名，用于弹窗日志标注
   */
  register(page: Page, staffName?: string): void {
    // 防止同一 page 重复注册 listener
    if (this.registeredPages.has(page)) return;
    this.registeredPages.add(page);

    const staffTag = staffName ? `[${staffName}] ` : '';

    page.on('dialog', async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();
      const url = page.url();

      console.log(`${staffTag}[PopupManager] dialog.${type}: "${message}" @ ${url}`);

      if (this.suspendedDialogPages.has(page)) {
        console.warn(`${staffTag}[PopupManager] dialog 自动处理已暂停，等待登录守卫重启窗口: "${message}"`);
        return;
      }

      try {
        // 对 alert / confirm / prompt 统一 accept（点击确定）
        if (type === 'alert') {
          await dialog.accept();
          this.stats.nativeAlertDismissed++;
          console.log(`${staffTag}[Popup] 检测到浏览器弹窗：${message}`);
          console.log(`${staffTag}[Popup] 已关闭浏览器弹窗，继续执行`);
        } else if (type === 'confirm') {
          await dialog.accept();
          this.stats.nativeConfirmDismissed++;
          console.log(`${staffTag}[Popup] 检测到浏览器弹窗(confirm)：${message}`);
          console.log(`${staffTag}[Popup] 已关闭浏览器弹窗(confirm)，继续执行`);
        } else if (type === 'prompt') {
          await dialog.accept('');
          this.stats.otherDismissed++;
          console.log(`${staffTag}[Popup] 检测到浏览器弹窗(prompt)：${message}`);
          console.log(`${staffTag}[Popup] 已关闭浏览器弹窗(prompt)，继续执行`);
        } else {
          await dialog.dismiss();
          this.stats.otherDismissed++;
        }
      } catch (e) {
        // "No dialog is showing" — 无害竞争条件，dialog 已自动关闭
        if (!(e as Error).message.includes('No dialog is showing')) {
          console.warn(`${staffTag}[PopupManager] dialog 处理失败: ${(e as Error).message}`);
        }
      }
    });
  }

  /**
   * 检查 page 是否已注册 dialog handler
   */
  isRegistered(page: Page): boolean {
    return this.registeredPages.has(page);
  }

  suspendDialogHandling(page: Page): void {
    this.suspendedDialogPages.add(page);
  }

  resumeDialogHandling(page: Page): void {
    this.suspendedDialogPages.delete(page);
  }

  // ── dismissAll: 清除所有弹窗（一次性） ──

  /**
   * 清除当前页面上所有弹窗
   * @returns 清除数量；verifyAfter=true 且验证失败时返回 -1
   */
  async dismissAll(page: Page, options?: DismissOptions): Promise<number> {
    const timeout = options?.timeout ?? 8000;
    const maxRounds = options?.maxRounds ?? 5;
    const verifyAfter = options?.verifyAfter ?? true;

    const startTime = Date.now();
    let totalDismissed = 0;
    this.stats.totalCleanupCalls++;

    try {
      await Promise.race([
        this.dismissAllInternal(page, maxRounds, (count) => { totalDismissed = count; }),
        new Promise<void>((resolve) => setTimeout(resolve, timeout)),
      ]);
    } catch {
      // 超时，继续验证
    }

    // P0 策略：无论当前是否立刻可见，都给 toast/notification 动画一个稳定窗口。
    await page.waitForSelector('.el-message, .el-notification', { state: 'hidden', timeout: 2000 }).catch(() => {});

    if (verifyAfter) {
      const clean = await this.ensureClean(page);
      if (!clean) {
        this.stats.totalCleanupFailures++;
        console.warn(`[PopupManager] dismissAll 验证失败，页面可能仍有弹窗 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
        return -1;
      }
    }

    this.stats.lastCleanupTime = new Date().toISOString();
    if (totalDismissed > 0) {
      RuntimeMetrics.getInstance().popupDismissed(totalDismissed);
      console.log(`[PopupManager] 清除了 ${totalDismissed} 个弹窗 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
    }
    return totalDismissed;
  }

  private async dismissAllInternal(
    page: Page,
    maxRounds: number,
    onCount: (count: number) => void,
  ): Promise<void> {
    let totalDismissed = 0;
    const originalUrl = page.url();

    for (let round = 0; round < maxRounds; round++) {
      // 每次循环前检查 URL 是否已跳转（dismiss 可能触发导航）
      const currentUrl = page.url();
      if (currentUrl !== originalUrl) {
        console.warn(`[PopupManager] 弹窗清理过程中 URL 已变化: ${originalUrl} → ${currentUrl}，停止清理`);
        break;
      }

      let foundInThisRound = 0;

      // 1. 先处理最上层 el-message-box。
      // 例如余额不足弹窗点击 X 后会出现“确认关闭?”，正确动作是先点“取 消”，
      // 不要继续点击后层 dialog 的 X，否则会反复制造/叠加确认框。
      const msgBoxes = await page.$$('.el-message-box:not([style*="display: none"])').catch(() => []);
      let visibleMessageBoxHandled = false;
      for (const box of msgBoxes) {
        const isVisible = await box.isVisible().catch(() => false);
        if (!isVisible) continue;

        const btnWrapper = await box.$('.el-message-box__btns').catch(() => null);
        const searchEl = btnWrapper ?? box;
        const cancelClicked = await this.clickCancelButton(searchEl);
        if (cancelClicked) {
          totalDismissed++;
          foundInThisRound++;
          visibleMessageBoxHandled = true;
          await page.waitForTimeout(300).catch(() => {});
          continue;
        }

        const clicked = await this.clickSmartButton(searchEl);
        if (clicked) {
          totalDismissed++;
          foundInThisRound++;
          visibleMessageBoxHandled = true;
          await page.waitForTimeout(300).catch(() => {});
          continue;
        }

        const closeBtn = await box.$('.el-message-box__headerbtn').catch(() => null);
        if (closeBtn) {
          await closeBtn.click().catch(() => {});
          totalDismissed++;
          foundInThisRound++;
          visibleMessageBoxHandled = true;
          await page.waitForTimeout(300).catch(() => {});
        }
      }

      if (visibleMessageBoxHandled) {
        onCount(totalDismissed);
        continue;
      }

      // 2. 处理 el-dialog / pay-dialog
      for (const sel of STUBBORN_DIALOG_SELECTORS) {
        const dialogWrappers = await page.$$(sel).catch(() => []);
        for (const wrapper of dialogWrappers) {
          const isVisible = await wrapper.isVisible().catch(() => false);
          if (!isVisible) continue;

          // footer 关闭按钮
          const footer = await wrapper.$('.el-dialog__footer').catch(() => null);
          if (footer) {
            const clicked = await this.clickSmartButton(footer);
            if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
          }
          // body 内关闭按钮
          const body = await wrapper.$('.el-dialog__body').catch(() => null);
          if (body) {
            const clicked = await this.clickSmartButton(body);
            if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
          }
          // 全局查找
          const clicked = await this.clickSmartButton(wrapper);
          if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
          // X 按钮
          const headerBtn = await wrapper.$('.el-dialog__headerbtn').catch(() => null);
          if (headerBtn) {
            await headerBtn.click().catch(() => {});
            totalDismissed++; foundInThisRound++;
            await page.waitForTimeout(300).catch(() => {});
          }
        }
      }

      // 3. 自定义遮罩弹窗
      const customCloseBtns = await page.$$(
        '.modal-close, .popup-close, .ad-close, [class*="close-btn"]:not([style*="display: none"])',
      ).catch(() => []);
      for (const btn of customCloseBtns) {
        const isVisible = await btn.isVisible().catch(() => false);
        if (isVisible) {
          await btn.click().catch(() => {});
          totalDismissed++; foundInThisRound++;
          await page.waitForTimeout(200).catch(() => {});
        }
      }

      // 4. Escape + 遮罩兜底
      await this.closeViaEscapeOrOverlay(page);

      if (foundInThisRound === 0) {
        const stillThere = await this.stillHasPopups(page);
        if (!stillThere) break;
      }
    }

    onCount(totalDismissed);
  }

  // ── ensureClean: 验证页面无弹窗 ──

  async ensureClean(page: Page): Promise<boolean> {
    const checks = [
      page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 2000 }).catch(() => {}),
      page.waitForSelector('.el-message, .el-notification', { state: 'hidden', timeout: 2000 }).catch(() => {}),
    ];
    await Promise.all(checks);

    const selectors = ['.el-dialog__wrapper', '.pay-dialog', '.el-message-box', '.v-modal'];
    for (const sel of selectors) {
      const elements = await page.$$(sel).catch(() => []);
      for (const el of elements) {
        const isVisible = await el.isVisible().catch(() => false);
        if (isVisible) return false;
      }
    }
    return true;
  }

  // ── inspect: 列出所有可见弹窗 ──

  async inspect(page: Page): Promise<VisiblePopup[]> {
    const result: VisiblePopup[] = [];
    const dialogWrappers = await page.$$('.el-dialog__wrapper, .pay-dialog, .el-message-box').catch(() => []);
    for (const el of dialogWrappers) {
      const isVisible = await el.isVisible().catch(() => false);
      const tagName = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
      const classList = await el.evaluate(e => e.className).catch(() => '');
      const text = (await el.textContent().catch(() => ''))?.trim().slice(0, 200) ?? '';
      let type: PopupType = 'el-dialog';
      if (classList.includes('pay-dialog')) type = 'pay-dialog';
      else if (classList.includes('message-box')) type = 'el-message-box';

      result.push({
        type,
        visible: isVisible,
        text,
        selector: `${tagName}.${classList.split(' ').join('.')}`,
        dismissible: true,
      });
    }
    return result;
  }

  // ── getStats / resetStats ──

  getStats(): PopupStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      nativeAlertDismissed: 0,
      nativeConfirmDismissed: 0,
      payDialogDismissed: 0,
      messageBoxDismissed: 0,
      otherDismissed: 0,
      totalCleanupCalls: 0,
      totalCleanupFailures: 0,
      lastCleanupTime: null,
    };
  }

  // ── dismissRechargeCancelDialog: 快速清理充值/余额不足弹窗 + 二次确认框 ──
  // Phase 5-G-8-2: 基于 Chrome DevTools MCP 真实DOM排查结果实现
  //
  // DevTools MCP 真实DOM结论（肖飞账号，2026-07-01）：
  // - 充值弹窗根节点: .el-dialog__wrapper.pay-dialog (z-index:2002, position:fixed)
  // - 内部结构: .el-dialog[role=dialog][aria-modal=true] > .el-dialog__header + .el-dialog__body + .el-dialog__footer
  // - 取消按钮: .el-dialog__footer .el-button > span ("取 消"，文本中间有空格)
  // - X按钮: .el-dialog__headerbtn[aria-label=Close] (点击后触发二次确认框，禁止优先使用)
  // - 二次确认框: .el-message-box__wrapper > .el-message-box ("确认关闭？")，含"取消""确定"按钮
  // - 遮罩层: .v-modal
  // - 原生alert: "网点余额低于警戒金额!"（页面加载/导航时出现，阻塞JS执行）
  //
  // 策略优先级：
  // 1. 最上层 .el-message-box 二次确认框 → 点"取消/取 消"
  // 2. .pay-dialog 充值弹窗 → 点footer内"取消/取 消"
  // 3. 其他 .el-dialog__wrapper (标题含"充值/余额不足/警告") → 点footer取消
  // 全部短超时，无弹窗立即返回，不做全量清理

  /**
   * 快速清理充值弹窗和二次确认框
   * 设计原则：短超时、快速返回、优先"取消"按钮、不点X（X触发二次确认）
   * @returns true=成功关闭了至少一个弹窗; false=无可关闭弹窗
   */
  async dismissRechargeCancelDialog(page: Page): Promise<boolean> {
    const start = Date.now();
    let closedAny = false;
    try {
      // Step 1: 先处理最上层 .el-message-box（二次确认框"确认关闭？"）
      const msgBoxes = await page.$$('.el-message-box__wrapper:not([style*="display: none"]) .el-message-box, .el-message-box:not([style*="display: none"])').catch(() => []);
      for (const box of msgBoxes) {
        const isVisible = await box.isVisible().catch(() => false);
        if (!isVisible) continue;
        const btns = await box.$$('.el-message-box__btns .el-button, .el-message-box__btns button').catch(() => []);
        for (const btn of btns) {
          const rawText = (await btn.textContent().catch(() => '')) ?? '';
          const normalized = rawText.replace(/\s+/g, '');
          if (normalized === '取消') {
            const btnVisible = await btn.isVisible().catch(() => false);
            if (btnVisible) {
              console.log(`[PopupManager] dismissRechargeCancelDialog: 点击确认框"${rawText.trim()}"`);
              await btn.click({ timeout: 1500 }).catch(() => {});
              await page.waitForTimeout(300).catch(() => {});
              closedAny = true;
              break;
            }
          }
        }
        if (closedAny) break;
      }

      // Step 2: 处理 .pay-dialog 充值弹窗（余额不足警告）
      const payDialogs = await page.$$('.el-dialog__wrapper.pay-dialog:not([style*="display: none"])').catch(() => []);
      for (const wrapper of payDialogs) {
        const isVisible = await wrapper.isVisible().catch(() => false);
        if (!isVisible) continue;

        // 优先点 footer 里的"取消/取 消"按钮
        const footer = await wrapper.$('.el-dialog__footer').catch(() => null);
        let clicked = false;
        if (footer) {
          const cancelBtns = await footer.$$('.el-button, button').catch(() => []);
          for (const btn of cancelBtns) {
            const rawText = (await btn.textContent().catch(() => '')) ?? '';
            const normalized = rawText.replace(/\s+/g, '');
            if (normalized === '取消') {
              const btnVisible = await btn.isVisible().catch(() => false);
              if (btnVisible) {
                console.log(`[PopupManager] dismissRechargeCancelDialog: 点击充值弹窗"${rawText.trim()}"`);
                await btn.click({ timeout: 1500 }).catch(() => {});
                clicked = true;
                closedAny = true;
                break;
              }
            }
          }
        }

        // 如果footer没找到取消按钮，在整个dialog内搜索（兜底）
        if (!clicked) {
          const allBtns = await wrapper.$$('.el-button, button').catch(() => []);
          for (const btn of allBtns) {
            const rawText = (await btn.textContent().catch(() => '')) ?? '';
            const normalized = rawText.replace(/\s+/g, '');
            if (normalized === '取消') {
              const btnVisible = await btn.isVisible().catch(() => false);
              if (btnVisible) {
                console.log(`[PopupManager] dismissRechargeCancelDialog: 兜底点击"${rawText.trim()}"`);
                await btn.click({ timeout: 1500 }).catch(() => {});
                clicked = true;
                closedAny = true;
                break;
              }
            }
          }
        }

        // 不点击X按钮（会触发二次确认框，增加复杂度）
        if (!clicked) {
          console.log('[PopupManager] dismissRechargeCancelDialog: 充值弹窗未找到取消按钮，跳过');
        }
      }

      // Step 3: 处理其他 .el-dialog__wrapper（标题含充值/余额不足/警告的弹窗）
      const otherDialogs = await page.$$('.el-dialog__wrapper:not(.pay-dialog):not([style*="display: none"])').catch(() => []);
      for (const wrapper of otherDialogs) {
        const isVisible = await wrapper.isVisible().catch(() => false);
        if (!isVisible) continue;
        const titleText = (await wrapper.$eval('.el-dialog__title', (el: Element) => el.textContent?.trim() ?? '').catch(() => '')) ?? '';
        const isRechargeRelated = /充值|余额不足|警告|缴费|付费/.test(titleText);
        if (!isRechargeRelated) continue;

        const footer = await wrapper.$('.el-dialog__footer').catch(() => null);
        if (footer) {
          const cancelBtns = await footer.$$('.el-button, button').catch(() => []);
          for (const btn of cancelBtns) {
            const rawText = (await btn.textContent().catch(() => '')) ?? '';
            const normalized = rawText.replace(/\s+/g, '');
            if (normalized === '取消') {
              const btnVisible = await btn.isVisible().catch(() => false);
              if (btnVisible) {
                console.log(`[PopupManager] dismissRechargeCancelDialog: 点击"${titleText}"弹窗"${rawText.trim()}"`);
                await btn.click({ timeout: 1500 }).catch(() => {});
                closedAny = true;
                break;
              }
            }
          }
        }
      }

      // 等待弹窗消失（最多1500ms）
      if (closedAny) {
        await page.waitForTimeout(500).catch(() => {});
        // 验证pay-dialog是否隐藏
        const stillVisible = await page.$('.el-dialog__wrapper.pay-dialog:not([style*="display: none"])').catch(() => null);
        if (stillVisible) {
          const vis = await stillVisible.isVisible().catch(() => false);
          if (vis) {
            // 可能出现了二次确认框，再处理一次
            const msgBtn = await page.$('.el-message-box__btns .el-button:not(.el-button--primary)').catch(() => null);
            if (msgBtn) {
              const msgBtnVis = await msgBtn.isVisible().catch(() => false);
              if (msgBtnVis) {
                await msgBtn.click({ timeout: 1500 }).catch(() => {});
                await page.waitForTimeout(500).catch(() => {});
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[PopupManager] dismissRechargeCancelDialog 异常: ${(e as Error).message}`);
    }
    if (closedAny) {
      console.log(`[PopupManager] dismissRechargeCancelDialog 完成 (${Date.now() - start}ms)`);
    }
    return closedAny;
  }

  // ── dismissTopCancelConfirm: 快速清理最上层"取 消"确认框 ──
  // Phase 5-G-8-1: 导航前后快速清理二次确认框，不做全量弹窗清理
  // Phase 5-G-8-2: 标记为 @deprecated，建议使用 dismissRechargeCancelDialog 替代

  /**
   * 快速清理最上层 .el-message-box 的"取消/取 消"按钮。
   *
   * 设计原则：
   * - 只处理最上层 .el-message-box（不处理 dialog、overlay、toast）
   * - 优先点"取消/取 消"（去除空格匹配）
   * - 默认超时极短（2000ms），无弹窗时立即返回
   * - 不调用 dismissAll，不做后续弹窗检查，不破坏原有 dismissAll 逻辑
   * - 导航前后调用，用于防止旧页面的二次确认框阻塞新页面加载
   *
   * @returns true=点击了取消按钮; false=无取消按钮/无弹窗
   */
  async dismissTopCancelConfirm(page: Page): Promise<boolean> {
    try {
      const msgBoxes = await page.$$('.el-message-box:not([style*="display: none"])').catch(() => []);
      for (const box of msgBoxes) {
        const isVisible = await box.isVisible().catch(() => false);
        if (!isVisible) continue;

        // 在 message-box 内找按钮，优先"取消"（去除空格匹配 取 消）
        const buttons = await box.$$('.el-message-box__btns button, .el-message-box__btns .el-button').catch(() => []);
        for (const btn of buttons) {
          const rawText = (await btn.textContent().catch(() => '')) ?? '';
          const normalized = rawText.replace(/\s+/g, '');
          if (normalized === '取消') {
            const btnVisible = await btn.isVisible().catch(() => false);
            if (btnVisible) {
              console.log(`[PopupManager] dismissTopCancelConfirm: 点击"${rawText.trim()}"`);
              await btn.click({ timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(400).catch(() => {});
              // 等待 message-box 消失
              await box.waitForElementState('hidden', { timeout: 3000 }).catch(() => {});
              return true;
            }
          }
        }

        // 没有找到取消按钮，跳过（不强行点其他按钮）
        return false;
      }
    } catch (e) {
      // 快速清理失败不应阻塞导航
      console.warn(`[PopupManager] dismissTopCancelConfirm 异常: ${(e as Error).message}`);
    }
    return false;
  }

  // ── backgroundCleanup: 后台轻量清理 ──

  /** 对单个 page 执行轻量弹窗清理（替代 index.ts 中每10秒全窗口清理） */
  async backgroundCleanup(page: Page): Promise<void> {
    await this.dismissAll(page, { timeout: 5000, maxRounds: 3, verifyAfter: false }).catch(() => {});
  }

  // ── 内部辅助 ────────────────────────────────────────

  private isCloseConfirmation(text: string): boolean {
    const normalized = text.replace(/\s+/g, '');
    return CLOSE_CONFIRM_KEYWORDS.some(kw => normalized.includes(kw));
  }

  private async clickCancelButton(container: ElementHandle): Promise<boolean> {
    const buttons = await container.$$('button, .el-button, .btn, [role="button"]').catch(() => []);
    for (const btn of buttons) {
      const rawText = (await btn.textContent().catch(() => '')) ?? '';
      const normalized = rawText.replace(/\s+/g, '');
      if (normalized.includes('取消')) {
        const isVisible = await btn.isVisible().catch(() => false);
        if (isVisible) {
          console.log(`[PopupManager] 点击按钮 "${rawText.trim()}"`);
          await btn.click().catch(() => {});
          return true;
        }
      }
    }
    return false;
  }

  private async clickSmartButton(container: ElementHandle): Promise<boolean> {
    const fullText = (await container.textContent().catch(() => '')) ?? '';
    const buttons = await container.$$('button, .el-button, .btn, [role="button"]').catch(() => []);

    const tryClickByText = async (texts: string[]): Promise<boolean> => {
      for (const targetText of texts) {
        for (const btn of buttons) {
          const rawText = (await btn.textContent().catch(() => '')) ?? '';
          const text = rawText.replace(/\s+/g, '');
          if (text.includes(targetText)) {
            const isVisible = await btn.isVisible().catch(() => false);
            if (isVisible) {
              console.log(`[PopupManager] 点击按钮 "${text}"`);
              await btn.click().catch(() => {});
              return true;
            }
          }
        }
      }
      return false;
    };

    if (await tryClickByText(['取消'])) return true;
    const otherDismiss = DISMISS_BTN_TEXTS.filter(t => t !== '取消');
    if (await tryClickByText(otherDismiss)) return true;
    if (this.isCloseConfirmation(fullText)) {
      if (await tryClickByText(['确定', '是'])) return true;
    }
    // Phase 4-G: 兜底 — 对于非确认型弹窗（如余额警告只有"确定"按钮），
    // 点击"确定"关闭弹窗。确认型弹窗（isCloseConfirmation）已在上方处理。
    // 这里处理的是 el-message-box / el-dialog 中只有"确定"按钮的简单提示。
    if (await tryClickByText(['确定'])) return true;
    return false;
  }

  private async closeViaEscapeOrOverlay(page: Page): Promise<void> {
    const overlaySelectors = ['.v-modal:not([style*="display: none"])', '.el-overlay:not([style*="display: none"])'];
    for (const sel of overlaySelectors) {
      const overlays = await page.$$(sel).catch(() => []);
      for (const overlay of overlays) {
        await overlay.click().catch(() => {});
        await page.waitForTimeout(200).catch(() => {});
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
  }

  private async stillHasPopups(page: Page): Promise<boolean> {
    const selectors = ['.el-dialog__wrapper', '.pay-dialog', '.el-message-box'];
    for (const sel of selectors) {
      const elements = await page.$$(sel).catch(() => []);
      for (const el of elements) {
        const isVisible = await el.isVisible().catch(() => false);
        if (isVisible) return true;
      }
    }
    return false;
  }

}
