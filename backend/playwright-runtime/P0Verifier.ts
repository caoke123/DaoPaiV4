/**
 * P0Verifier — Phase 2-D-Run 三次修正
 *
 * 复用原项目（bnsy-operator-next/backend/browser/BrowserPool.ts）中已验证过的 P0 检查逻辑：
 *   - BrowserPool.verifyReady（7 项检查，L368-451）
 *   - BrowserPool.ensureNoPopup（弹窗处理，L812-840，使用 PopupManager.dismissAll）
 *
 * 设计原则（用户要求）：
 *   1. 优先复用旧 P0 逻辑，最小适配接受 Playwright page
 *   2. 保留旧 P0 的判断顺序和超时策略（3s 超时）
 *   3. 保留旧 P0 已验证过的弹窗处理逻辑（PopupManager.dismissAll）
 *   4. 多轮检查（P0_ROUNDS=3，每轮间隔 5s），与 BrowserPool L713-727 一致
 *
 * 严禁修改：
 *   - BrowserPool.ts（旧 P0 源文件）
 *   - 正式业务 Handler / routes.ts / EasyBRClient / bnsy-operator/
 *
 * P0 检查 7 项（与 BrowserPool.verifyReady 完全一致）：
 *   1. cdp_evaluate  — page.evaluate(() => 1) 3s 超时，验证 CDP 可执行
 *   2. url_access    — page.url() 可获取
 *   3. url_domain    — URL 含 bnsy.benniaosuyun.com
 *   4. url_login     — URL 不含 /login 或 Login（否则视为未登录）
 *   5. url_dashboard — URL 含 /dashboard
 *   6. dom_missing   — 核心DOM存在：.el-menu / .app-container / .sidebar
 *   7. popup_blocking — 无阻塞弹窗：.el-dialog__wrapper / .el-message-box__wrapper 不可见
 */
import type { Page } from 'playwright';
import { PopupManager } from '../browser/PopupManager';

// ── 常量（与 BrowserPool.ts 保持一致） ──

const TARGET_DOMAIN = 'bnsy.benniaosuyun.com';

/** P0 多轮检查轮数（与 BrowserPool L713 一致） */
const P0_ROUNDS = 3;
/** P0 多轮检查间隔（与 BrowserPool L714 一致） */
const P0_INTERVAL_MS = 5000;

// ── 类型定义 ──

/** 单项检查结果 */
export interface P0CheckItem {
  name: string;
  passed: boolean;
  reason: string;
}

/** 单轮 P0 检查结果（对应 BrowserPool.verifyReady 的返回值） */
export interface P0RoundResult {
  round: number;
  ready: boolean;
  failedCheck: string;
  reason: string;
  pageUrl: string;
  items: P0CheckItem[];
  popupDismissed: number;   // 本轮弹窗处理数量
}

/** P0 检查完整报告 */
export interface P0Report {
  /** 复用的旧 P0 函数/文件 */
  source: string;
  /** 开始 URL（第一轮检查前） */
  startUrl: string;
  /** 结束 URL（最后一轮检查后） */
  endUrl: string;
  /** 是否 dashboard 页面 */
  isDashboard: boolean;
  /** 是否仍在登录页 */
  isLoginPage: boolean;
  /** 核心DOM是否存在（.el-menu/.app-container/.sidebar） */
  hasCoreDom: boolean;
  /** 是否检测到阻塞弹窗 */
  hasBlockingPopup: boolean;
  /** 旧 P0 是否尝试处理弹窗（调用 PopupManager.dismissAll） */
  popupDismissAttempted: boolean;
  /** P0 最终结果（所有轮次均 ready 才算通过） */
  passed: boolean;
  /** 失败原因（failedCheck + reason） */
  failedCheck: string;
  failedReason: string;
  /** 多轮检查详情 */
  rounds: P0RoundResult[];
  /** 检查时间戳 */
  timestamp: string;
}

// ── P0Verifier 类 ──

export class P0Verifier {
  /**
   * 执行完整 P0 检查（多轮 + 弹窗处理 + verifyReady）
   *
   * 流程（与 BrowserPool L713-739 一致）：
   *   for round 1..3:
   *     1. ensureNoPopup（PopupManager.dismissAll）
   *     2. verifyReady（7 项检查）
   *     3. 如未通过且非最后一轮，等待 5s
   *   返回完整报告
   */
  async runFullCheck(page: Page, windowName: string): Promise<P0Report> {
    const timestamp = new Date().toISOString();
    const startUrl = this.safeGetUrl(page);
    const rounds: P0RoundResult[] = [];

    console.log(`[P0Verifier] 开始 P0 检查: ${windowName} (startUrl=${startUrl})`);

    let finalResult: P0RoundResult | null = null;

    for (let round = 1; round <= P0_ROUNDS; round++) {
      console.log(`[P0Verifier] P0 检查第 ${round}/${P0_ROUNDS} 轮: ${windowName}`);

      // 1. 弹窗处理（复用 BrowserPool.ensureNoPopup L812-840 逻辑）
      const popupDismissed = await this.ensureNoPopup(page, windowName);

      // 2. verifyReady（复用 BrowserPool.verifyReady L368-451 逻辑）
      const roundResult = await this.verifyReady(page, windowName, round);
      roundResult.popupDismissed = popupDismissed;
      rounds.push(roundResult);

      console.log(`[P0Verifier] 第 ${round} 轮结果: ready=${roundResult.ready}, failedCheck=${roundResult.failedCheck}, url=${roundResult.pageUrl}`);

      if (roundResult.ready) {
        finalResult = roundResult;
        break;
      }

      // 3. 未通过且非最后一轮，等待 5s（与 BrowserPool L722-724 一致）
      if (round < P0_ROUNDS) {
        console.log(`[P0Verifier] 第 ${round} 轮未通过，等待 ${P0_INTERVAL_MS / 1000}s 后继续...`);
        await new Promise(r => setTimeout(r, P0_INTERVAL_MS));
      } else {
        finalResult = roundResult;
      }
    }

    const endUrl = this.safeGetUrl(page);
    const last = finalResult!;

    // 汇总核心 DOM 检查结果（取最后一轮）
    const lastDomItem = last.items.find(i => i.name === 'dom_missing');
    const hasCoreDom = lastDomItem ? lastDomItem.passed : false;

    // 汇总弹窗检查结果（取最后一轮）
    const lastPopupItem = last.items.find(i => i.name === 'popup_blocking');
    const hasBlockingPopup = lastPopupItem ? !lastPopupItem.passed : false;

    // 是否尝试过处理弹窗（只要执行过 ensureNoPopup 就算 true）
    const popupDismissAttempted = rounds.some(r => r.popupDismissed >= 0);

    const report: P0Report = {
      source: 'BrowserPool.verifyReady (L368-451) + BrowserPool.ensureNoPopup (L812-840, PopupManager.dismissAll)',
      startUrl,
      endUrl,
      isDashboard: endUrl.includes('/dashboard'),
      isLoginPage: endUrl.includes('/login') || endUrl.includes('Login'),
      hasCoreDom,
      hasBlockingPopup,
      popupDismissAttempted,
      passed: last.ready,
      failedCheck: last.failedCheck,
      failedReason: last.reason,
      rounds: rounds.map(r => ({
        round: r.round,
        ready: r.ready,
        failedCheck: r.failedCheck,
        reason: r.reason,
        pageUrl: r.pageUrl,
        items: r.items,
        popupDismissed: r.popupDismissed,
      })),
      timestamp,
    };

    console.log(`[P0Verifier] P0 检查完成: passed=${report.passed}, failedCheck=${report.failedCheck}, endUrl=${endUrl}`);
    return report;
  }

  /**
   * 旧 P0 verifyReady 逻辑（原样复制自 BrowserPool.verifyReady L368-451）
   *
   * 7 项检查，保留判断顺序和 3s 超时策略。
   * 任何一项失败立即返回，不继续后续检查。
   */
  private async verifyReady(page: Page, windowName: string, round: number): Promise<P0RoundResult> {
    const items: P0CheckItem[] = [];
    const fail = (failedCheck: string, reason: string, pageUrl: string): P0RoundResult => {
      console.warn(`[P0Verifier] 第${round}轮 "${windowName}" 未通过 [${failedCheck}]: ${reason}`);
      return {
        round,
        ready: false,
        failedCheck,
        reason,
        pageUrl,
        items,
        popupDismissed: 0,
      };
    };

    // 检查 1: cdp_evaluate — page.evaluate(() => 1) 3s 超时
    try {
      await Promise.race([
        page.evaluate(() => 1),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('evaluate_timeout')), 3000)),
      ]);
      items.push({ name: 'cdp_evaluate', passed: true, reason: 'ok' });
    } catch (e) {
      items.push({ name: 'cdp_evaluate', passed: false, reason: `CDP页面执行失败: ${(e as Error).message}` });
      return fail('cdp_evaluate', `CDP页面执行失败: ${(e as Error).message}`, this.safeGetUrl(page));
    }

    // 检查 2: url_access — page.url() 可获取
    let url: string;
    try {
      url = page.url();
      items.push({ name: 'url_access', passed: true, reason: 'ok' });
    } catch (e) {
      items.push({ name: 'url_access', passed: false, reason: `无法获取page.url(): ${(e as Error).message}` });
      return fail('url_access', `无法获取page.url(): ${(e as Error).message}`, '');
    }

    // 检查 3: url_domain — URL 含 TARGET_DOMAIN
    if (!url.includes(TARGET_DOMAIN)) {
      items.push({ name: 'url_domain', passed: false, reason: `URL不在目标域名(${TARGET_DOMAIN}): ${url}` });
      return fail('url_domain', `URL不在目标域名(${TARGET_DOMAIN}): ${url}`, url);
    }
    items.push({ name: 'url_domain', passed: true, reason: 'ok' });

    // 检查 4: url_login — URL 不含 /login 或 Login
    if (url.includes('/login') || url.includes('Login')) {
      items.push({ name: 'url_login', passed: false, reason: `URL仍在登录页: ${url}` });
      return fail('url_login', `URL仍在登录页: ${url}`, url);
    }
    items.push({ name: 'url_login', passed: true, reason: 'ok' });

    // 检查 5: url_dashboard — URL 含 /dashboard
    if (!url.includes('/dashboard')) {
      items.push({ name: 'url_dashboard', passed: false, reason: `URL不在Dashboard页面: ${url}` });
      return fail('url_dashboard', `URL不在Dashboard页面: ${url}`, url);
    }
    items.push({ name: 'url_dashboard', passed: true, reason: 'ok' });

    // 检查 6: dom_missing — 核心DOM存在 .el-menu / .app-container / .sidebar
    let hasCoreDom = false;
    try {
      hasCoreDom = await Promise.race([
        page.evaluate(() => {
          return !!document.querySelector('.el-menu')
            || !!document.querySelector('.app-container')
            || !!document.querySelector('.sidebar');
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dom_timeout')), 3000)),
      ]);
      items.push({ name: 'dom_missing', passed: hasCoreDom, reason: hasCoreDom ? 'ok' : '核心业务DOM不存在' });
    } catch (e) {
      items.push({ name: 'dom_missing', passed: false, reason: `核心DOM检查超时: ${(e as Error).message}` });
      return fail('dom_timeout', `核心DOM检查超时: ${(e as Error).message}`, url);
    }
    if (!hasCoreDom) {
      return fail('dom_missing', '核心业务DOM不存在（.el-menu/.app-container/.sidebar均未找到），Dashboard可能未完全加载', url);
    }

    // 检查 7: popup_blocking — 无阻塞弹窗 .el-dialog__wrapper / .el-message-box__wrapper
    let hasBlockingPopup = false;
    try {
      hasBlockingPopup = await Promise.race([
        page.evaluate(() => {
          const blockers = document.querySelectorAll(
            '.el-dialog__wrapper, .el-message-box__wrapper',
          );
          for (const el of Array.from(blockers)) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              return true;
            }
          }
          return false;
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('popup_check_timeout')), 3000)),
      ]);
      items.push({ name: 'popup_blocking', passed: !hasBlockingPopup, reason: hasBlockingPopup ? '存在阻塞弹窗' : 'ok' });
    } catch (e) {
      console.warn(`[P0Verifier] 第${round}轮 "${windowName}" 弹窗检查超时，跳过: ${(e as Error).message}`);
      items.push({ name: 'popup_blocking', passed: true, reason: `弹窗检查超时，跳过: ${(e as Error).message}` });
      hasBlockingPopup = false;
    }
    if (hasBlockingPopup) {
      return fail('popup_blocking', '存在阻塞弹窗（.el-dialog__wrapper/.el-message-box__wrapper可见）', url);
    }

    // 全部通过
    console.log(`[P0Verifier] 第${round}轮 "${windowName}" ✓ READY验证通过 (${url})`);
    return {
      round,
      ready: true,
      failedCheck: '',
      reason: 'ok',
      pageUrl: url,
      items,
      popupDismissed: 0,
    };
  }

  /**
   * 旧 P0 ensureNoPopup 逻辑（原样复制自 BrowserPool.ensureNoPopup L812-840）
   *
   * 使用 PopupManager.dismissAll 处理弹窗，最多 5 轮。
   * 返回处理的弹窗数量（dismissAll 返回值）。
   */
  private async ensureNoPopup(page: Page, windowName: string): Promise<number> {
    const popupMgr = PopupManager.getInstance();
    const maxRounds = 5;
    let totalDismissed = 0;

    for (let round = 1; round <= maxRounds; round++) {
      // dismissAll 返回处理的弹窗数量
      const dismissed = await Promise.race([
        popupMgr.dismissAll(page, { timeout: 5000, maxRounds: 3, verifyAfter: false }),
        new Promise<number>(resolve => setTimeout(() => resolve(0), 5000)),
      ]);
      totalDismissed += dismissed || 0;

      // 检查是否还有可见弹窗
      const visibleDialogs = await page.$$('.el-dialog__wrapper, .pay-dialog, .el-message-box').catch(() => []);
      let hasVisible = false;
      for (const d of visibleDialogs) {
        const visible = await d.isVisible().catch(() => false);
        if (visible) { hasVisible = true; break; }
      }

      if (!hasVisible) {
        if (round > 1) {
          console.log(`[P0Verifier] ✓ 窗口 "${windowName}" 弹窗已清除 (第${round}轮验证通过)`);
        }
        return totalDismissed;
      }

      console.warn(`[P0Verifier] 窗口 "${windowName}" 仍有可见弹窗，重试清除 ${round}/${maxRounds}`);
      await new Promise(r => setTimeout(r, 500));
    }

    console.error(`[P0Verifier] ✗ 窗口 "${windowName}" 弹窗清除 ${maxRounds} 轮仍有残留！`);
    return totalDismissed;
  }

  /** 安全获取 page.url()，失败返回空字符串 */
  private safeGetUrl(page: Page): string {
    try {
      return page.url();
    } catch {
      return '';
    }
  }
}
