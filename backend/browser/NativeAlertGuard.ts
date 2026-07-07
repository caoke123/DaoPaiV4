// NativeAlertGuard — 全局原生浏览器弹窗清理
// Phase 5-G-8-3: 专门处理浏览器原生 alert / confirm / prompt
//
// 与 PopupManager 的分工：
//   - NativeAlertGuard: 处理浏览器原生 dialog（page.on('dialog') / CDP handleJavaScriptDialog）
//   - PopupManager: 处理 DOM 弹窗（.el-dialog / .el-message-box / .pay-dialog）
//
// 设计原则：
//   1. alert / confirm / prompt 默认 accept（点击"确定"）
//   2. beforeunload 默认 dismiss
//   3. 同一个 page 不重复注册 dialog handler
//   4. forceAccept 用 CDP 兜底关闭已存在的 alert（page.on 可能错过旧事件）
//   5. drain 短轮询清理一段时间内反复出现的 alert
//   6. "没有 alert" 不是错误，返回 false 即可

import type { Page } from 'playwright';

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** attach 选项 */
export interface AttachOptions {
  staffName?: string;
  log?: LogFn;
  scope?: string;
}

/** forceAccept / drain 选项 */
export interface DrainOptions {
  /** drain 持续时间，默认 1500ms */
  durationMs?: number;
  /** drain 轮询间隔，默认 200ms */
  intervalMs?: number;
  staffName?: string;
  log?: LogFn;
  scope?: string;
}

/**
 * 全局原生弹窗守卫
 *
 * 使用方式：
 *   1. page 创建后立即 attachNativeAlertGuard(page, ...)
 *   2. 关键节点调用 drainNativeAlerts(page, ...) 短轮询清理
 *   3. 紧急情况调用 forceAcceptCurrentNativeAlert(page, ...) CDP 兜底
 */
export class NativeAlertGuard {
  private static instance: NativeAlertGuard | null = null;

  /** 已注册 dialog handler 的 page 集合（WeakSet 防止重复注册） */
  private registeredPages = new WeakSet<Page>();

  /** 记录每个 page 的 staffName（用于日志） */
  private pageStaffMap = new WeakMap<Page, string>();

  private constructor() {}

  static getInstance(): NativeAlertGuard {
    if (!NativeAlertGuard.instance) {
      NativeAlertGuard.instance = new NativeAlertGuard();
    }
    return NativeAlertGuard.instance;
  }

  // ── attach: 为 page 注册全局 dialog 拦截器 ──

  /**
   * 为指定 page 注册原生弹窗自动处理
   *
   * - alert / confirm / prompt → accept（点击"确定"）
   * - beforeunload → dismiss
   * - 同一 page 不重复注册
   *
   * @param page      Playwright Page
   * @param options   选项（staffName / log / scope）
   */
  attachNativeAlertGuard(page: Page, options?: AttachOptions): void {
    if (this.registeredPages.has(page)) return;
    this.registeredPages.add(page);

    const staffName = options?.staffName ?? '';
    if (staffName) {
      this.pageStaffMap.set(page, staffName);
    }

    const log = options?.log ?? ((level, msg) => {
      if (level === 'warn') console.warn(`[NativeAlert]${msg}`);
      else console[level](`[NativeAlert]${msg}`);
    });
    const scope = options?.scope ?? 'page-init';
    const staffTag = staffName ? `[${staffName}]` : '';

    page.on('dialog', async (dialog) => {
      const type = dialog.type();
      const message = dialog.message();

      // beforeunload → dismiss（不阻止离开页面）
      if (type === 'beforeunload') {
        log('info', `${staffTag}[${scope}] 检测到 beforeunload 弹窗，dismiss`);
        await dialog.dismiss().catch(() => {});
        return;
      }

      // alert / confirm / prompt → accept
      log('info', `${staffTag}[${scope}] 检测到原生弹窗(${type})：${message}`);
      try {
        if (type === 'prompt') {
          await dialog.accept('');
        } else {
          await dialog.accept();
        }
        log('info', `${staffTag}[${scope}] 已点击确定，继续执行`);
      } catch (e) {
        // "No dialog is showing" — 无害竞争条件
        const errMsg = (e as Error).message;
        if (!errMsg.includes('No dialog is showing')) {
          log('warn', `${staffTag}[${scope}] 原生弹窗处理失败: ${errMsg}`);
        }
      }
    });

    log('info', `${staffTag}[${scope}] NativeAlertGuard 已挂载`);
  }

  /** 检查 page 是否已注册 dialog handler */
  isAttached(page: Page): boolean {
    return this.registeredPages.has(page);
  }

  // ── forceAccept: CDP 兜底关闭当前已存在的 Alert ──

  /**
   * 使用 CDP 强制关闭当前已存在的原生弹窗
   *
   * 适用场景：
   *   - alert 已经弹出，page.on('dialog') 可能错过旧事件
   *   - 登录前/导航前紧急清理
   *
   * 注意：没有 alert 时返回 false，不是错误
   *
   * @returns true=成功关闭了一个弹窗; false=当前无弹窗或关闭失败
   */
  async forceAcceptCurrentNativeAlert(page: Page, options?: AttachOptions): Promise<boolean> {
    const staffName = options?.staffName ?? this.pageStaffMap.get(page) ?? '';
    const log = options?.log ?? ((level, msg) => {
      if (level === 'warn') console.warn(`[NativeAlert]${msg}`);
      else console[level](`[NativeAlert]${msg}`);
    });
    const scope = options?.scope ?? 'force-accept';
    const staffTag = staffName ? `[${staffName}]` : '';

    try {
      const client = await page.context().newCDPSession(page);
      try {
        await client.send('Page.enable');
        await client.send('Page.handleJavaScriptDialog', { accept: true });
        log('info', `${staffTag}[${scope}] CDP 强制关闭原生弹窗成功`);
        return true;
      } finally {
        await client.detach().catch(() => {});
      }
    } catch (e) {
      const errMsg = (e as Error).message;
      // "No dialog is showing" 是正常情况，不打 warn
      if (!errMsg.includes('No dialog') && !errMsg.includes('dialog')) {
        log('warn', `${staffTag}[${scope}] CDP 强制关闭原生弹窗失败: ${errMsg}`);
      }
      return false;
    }
  }

  // ── drain: 短轮询清理一段时间内反复出现的 Alert ──

  /**
   * 在 durationMs 时间内，每 intervalMs 尝试一次 forceAccept
   *
   * 适用场景：
   *   - 登录后（alert 可能延迟出现）
   *   - 业务 URL 导航前/后
   *   - ensureReadyForTask 前
   *   - 关键元素检查前
   *
   * @returns 实际关闭的 alert 数量
   */
  async drainNativeAlerts(page: Page, options?: DrainOptions): Promise<number> {
    const durationMs = options?.durationMs ?? 1500;
    const intervalMs = options?.intervalMs ?? 200;
    const staffName = options?.staffName ?? this.pageStaffMap.get(page) ?? '';
    const log = options?.log ?? ((level, msg) => {
      if (level === 'warn') console.warn(`[NativeAlert]${msg}`);
      else console[level](`[NativeAlert]${msg}`);
    });
    const scope = options?.scope ?? 'drain';
    const staffTag = staffName ? `[${staffName}]` : '';

    let count = 0;
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline) {
      const closed = await this.forceAcceptCurrentNativeAlert(page, {
        staffName,
        log: () => {}, // drain 内部静默，避免刷屏
        scope,
      }).catch(() => false);

      if (closed) {
        count++;
        // 关闭一个后短等待再继续（避免连续 CDP 调用过快）
        await page.waitForTimeout(intervalMs).catch(() => {});
      } else {
        // 没有弹窗，等待 intervalMs 再试
        await page.waitForTimeout(intervalMs).catch(() => {});
      }
    }

    if (count > 0) {
      log('info', `${staffTag}[${scope}] drain 完成，清理了 ${count} 个原生弹窗 (${durationMs}ms)`);
    }
    return count;
  }
}

// ── 便捷导出函数（方便调用方不需要 getInstance）──

/**
 * 为 page 挂载原生弹窗守卫
 * @see NativeAlertGuard.attachNativeAlertGuard
 */
export function attachNativeAlertGuard(page: Page, options?: AttachOptions): void {
  NativeAlertGuard.getInstance().attachNativeAlertGuard(page, options);
}

/**
 * CDP 强制关闭当前已存在的原生弹窗
 * @see NativeAlertGuard.forceAcceptCurrentNativeAlert
 */
export async function forceAcceptCurrentNativeAlert(page: Page, options?: AttachOptions): Promise<boolean> {
  return NativeAlertGuard.getInstance().forceAcceptCurrentNativeAlert(page, options);
}

/**
 * 短轮询清理一段时间内反复出现的原生弹窗
 * @see NativeAlertGuard.drainNativeAlerts
 */
export async function drainNativeAlerts(page: Page, options?: DrainOptions): Promise<number> {
  return NativeAlertGuard.getInstance().drainNativeAlerts(page, options);
}
