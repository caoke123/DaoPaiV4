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
   */
  register(page: Page): void {
    page.on('dialog', async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();
      const url = page.url();

      console.log(`[PopupManager] dialog.${type}: "${message}" @ ${url}`);

      try {
        // alert 使用 accept() 点击"确定"；confirm/prompt 使用 dismiss() 取消
        if (type === 'alert') {
          await dialog.accept();
          this.stats.nativeAlertDismissed++;
          console.log(`[Popup] 已关闭登录后弹窗：${message}`);
        } else if (type === 'confirm') {
          await dialog.dismiss();
          this.stats.nativeConfirmDismissed++;
        } else {
          await dialog.dismiss();
          this.stats.otherDismissed++;
        }
      } catch (e) {
        // "No dialog is showing" — 无害竞争条件，dialog 已自动关闭
        if (!(e as Error).message.includes('No dialog is showing')) {
          console.warn(`[PopupManager] dialog 处理失败: ${(e as Error).message}`);
        }
      }
    });
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

    // 等待 toast 消失
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

      // 1. 处理 el-dialog / pay-dialog
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

      // 2. 处理 el-message-box
      const msgBoxes = await page.$$('.el-message-box:not([style*="display: none"])').catch(() => []);
      for (const box of msgBoxes) {
        const isVisible = await box.isVisible().catch(() => false);
        if (!isVisible) continue;
        const btnWrapper = await box.$('.el-message-box__btns').catch(() => null);
        const searchEl = btnWrapper ?? box;
        const clicked = await this.clickSmartButton(searchEl);
        if (clicked) { totalDismissed++; foundInThisRound++; await page.waitForTimeout(300).catch(() => {}); continue; }
        const closeBtn = await box.$('.el-message-box__headerbtn').catch(() => null);
        if (closeBtn) {
          await closeBtn.click().catch(() => {});
          totalDismissed++; foundInThisRound++;
          await page.waitForTimeout(300).catch(() => {});
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
