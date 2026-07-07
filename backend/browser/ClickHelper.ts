/**
 * ClickHelper — 通用稳定点击工具
 *
 * Phase 5-G-8: 从 IntegratedScan.ts 的 fastStableBypassClick 提取为公共模块。
 *
 * 策略：
 *   1. 先确认元素可见（waitFor visible）
 *   2. 优先短超时普通 click()
 *   3. 普通点击因 element is not stable / timeout 失败时，使用 force: true 回退
 *   4. 点击后必须做结果验证（verify 回调）
 *   5. 验证失败抛出明确错误，不静默继续
 *
 * ⚠️ 不要全局滥用 force click。只在明确不稳定、且点击后有结果验证的按钮上使用。
 */

import type { Locator } from 'playwright';

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export interface StableClickOptions {
  /** 日志函数 */
  log?: LogFn;
  /** 按钮标签（用于日志） */
  label: string;
  /** 超时毫秒数，默认 5000 */
  timeoutMs?: number;
  /** 点击后验证回调，返回 true 表示点击生效 */
  verify?: () => Promise<boolean>;
}

/**
 * 稳定点击：先普通点击，失败后 force 回退，结果验证
 */
export async function fastStableBypassClick(
  locator: Locator,
  options: StableClickOptions,
): Promise<void> {
  const { log, label, timeoutMs = 5000, verify } = options;

  // 1. 确认元素存在且可见
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    const msg = `[${label}] 元素不可见或超时 (${timeoutMs}ms)`;
    log?.('error', msg);
    throw new Error(msg);
  }

  // 2. 优先普通点击（短超时）
  let clicked = false;
  try {
    await locator.click({ timeout: Math.min(timeoutMs, 3000) });
    clicked = true;
  } catch (e) {
    const errMsg = (e as Error).message;
    const isStable = errMsg.includes('not stable');
    const isTimeout = errMsg.includes('Timeout');

    if (isStable || isTimeout) {
      log?.('warning', `[${label}] 普通点击失败 (${isStable ? 'not stable' : 'timeout'}), 使用 force: true 回退`);
      try {
        await locator.click({ timeout: timeoutMs, force: true });
        clicked = true;
      } catch (e2) {
        const msg = `[${label}] force click 也失败: ${(e2 as Error).message}`;
        log?.('error', msg);
        throw new Error(msg);
      }
    } else {
      const msg = `[${label}] 点击失败: ${errMsg}`;
      log?.('error', msg);
      throw new Error(msg);
    }
  }

  if (!clicked) {
    throw new Error(`[${label}] 点击未执行`);
  }

  // 3. 结果验证
  if (verify) {
    const verified = await verify().catch(() => false);
    if (!verified) {
      const msg = `[${label}] 点击后验证失败`;
      log?.('error', msg);
      throw new Error(msg);
    }
  }
}
