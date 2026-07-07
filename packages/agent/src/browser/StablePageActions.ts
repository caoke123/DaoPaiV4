/**
 * StablePageActions — 稳定页面输入工具
 *
 * Phase 5-E-1: 解决笨鸟系统 Vue/Element 输入框偶尔填写不上的问题。
 *
 * 核心模式：
 *   等待 visible/enabled → click 聚焦 → Ctrl+A 清空 → fill/type →
 *   dispatch input/change → blur → 读取校验 → 失败重试 → 仍失败抛中文错误
 *
 * 安全约束：
 *   - 密码不打印、不写入错误信息、只校验长度
 */

import type { Locator, Page } from 'playwright-core';

export interface StableFillOptions {
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 每次重试前等待毫秒，默认 500 */
  retryDelayMs?: number;
  /** 等待可见超时毫秒，默认 5000 */
  visibleTimeoutMs?: number;
  /** 输入后等待 Vue 双向绑定毫秒，默认 300 */
  settleMs?: number;
}

const DEFAULT_OPTIONS: Required<StableFillOptions> = {
  maxRetries: 3,
  retryDelayMs: 500,
  visibleTimeoutMs: 5000,
  settleMs: 300,
};

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 等待元素可见且可交互
 */
async function waitInteractable(
  locator: Locator,
  timeoutMs: number,
): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  await locator.waitFor({ state: 'attached', timeout: timeoutMs });
}

/**
 * 触发 input + change 事件（Vue/Element 双向绑定需要）
 */
async function dispatchInputEvents(locator: Locator): Promise<void> {
  await locator.evaluate((el: HTMLInputElement | HTMLTextAreaElement) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Vue 2 兼容
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

/**
 * 读取 input/textarea 的 value
 */
async function readValue(locator: Locator): Promise<string> {
  return locator.inputValue();
}

/**
 * 稳定填写普通输入框
 *
 * 流程：等待可见 → click 聚焦 → Ctrl+A 清空 → fill → dispatch 事件 → blur → 校验
 */
export async function stableFillInput(
  locator: Locator,
  value: string,
  options?: StableFillOptions,
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError = '';

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      await waitInteractable(locator, opts.visibleTimeoutMs);
      await locator.click({ timeout: opts.visibleTimeoutMs });
      // 全选清空
      await locator.press('Control+a');
      await locator.press('Delete');
      await sleep(100);
      // 填写
      await locator.fill(value, { timeout: opts.visibleTimeoutMs });
      // 触发事件
      await dispatchInputEvents(locator);
      await sleep(opts.settleMs);
      // 失焦
      await locator.evaluate((el: HTMLElement) => el.blur());
      await sleep(100);
      // 校验
      const actual = await readValue(locator);
      if (actual === value) {
        return; // 成功
      }
      lastError = `第 ${attempt} 次填写后校验失败：期望 "${maskValue(value)}"，实际 "${maskValue(actual)}"`;
      console.log(`  [StableInput] ${lastError}`);
    } catch (err) {
      lastError = `第 ${attempt} 次填写异常：${(err as Error).message}`;
      console.log(`  [StableInput] ${lastError}`);
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`输入框填写失败（重试 ${opts.maxRetries} 次）：${lastError}`);
}

/**
 * 稳定填写密码输入框
 *
 * 安全约束：
 *   - 不打印密码
 *   - 错误信息不含密码
 *   - 只校验长度
 */
export async function stableFillPassword(
  locator: Locator,
  password: string,
  options?: StableFillOptions,
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const expectedLength = password.length;
  let lastError = '';

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      await waitInteractable(locator, opts.visibleTimeoutMs);
      await locator.click({ timeout: opts.visibleTimeoutMs });
      await locator.press('Control+a');
      await locator.press('Delete');
      await sleep(100);
      await locator.fill(password, { timeout: opts.visibleTimeoutMs });
      await dispatchInputEvents(locator);
      await sleep(opts.settleMs);
      await locator.evaluate((el: HTMLElement) => el.blur());
      await sleep(100);
      // 密码只校验长度，不读取明文
      const actual = await readValue(locator);
      if (actual.length === expectedLength) {
        return; // 成功
      }
      lastError = `第 ${attempt} 次填写后长度校验失败：期望长度 ${expectedLength}，实际长度 ${actual.length}`;
      console.log(`  [StableInput] 密码${lastError}`);
    } catch (err) {
      const msg = (err as Error).message;
      // 确保错误信息不含密码
      lastError = msg.includes(password)
        ? `第 ${attempt} 次密码填写异常（错误信息已脱敏）`
        : `第 ${attempt} 次密码填写异常：${msg}`;
      console.log(`  [StableInput] ${lastError}`);
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`密码输入框填写失败（重试 ${opts.maxRetries} 次）：${lastError}`);
}

/**
 * 稳定填写 textarea
 *
 * 适用于运单号批量输入等场景。
 */
export async function stableFillTextarea(
  locator: Locator,
  value: string,
  options?: StableFillOptions,
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError = '';

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      await waitInteractable(locator, opts.visibleTimeoutMs);
      await locator.click({ timeout: opts.visibleTimeoutMs });
      await locator.press('Control+a');
      await locator.press('Delete');
      await sleep(100);
      await locator.fill(value, { timeout: opts.visibleTimeoutMs });
      await dispatchInputEvents(locator);
      await sleep(opts.settleMs);
      await locator.evaluate((el: HTMLElement) => el.blur());
      await sleep(100);
      // 校验：textarea 可能包含换行，比较去除首尾空格后的内容
      const actual = await readValue(locator);
      if (actual.trim() === value.trim()) {
        return; // 成功
      }
      lastError = `第 ${attempt} 次填写后校验失败：期望 ${value.split('\n').length} 行，实际 ${actual.split('\n').filter(s => s.trim()).length} 行`;
      console.log(`  [StableTextarea] ${lastError}`);
    } catch (err) {
      lastError = `第 ${attempt} 次填写异常：${(err as Error).message}`;
      console.log(`  [StableTextarea] ${lastError}`);
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`Textarea 填写失败（重试 ${opts.maxRetries} 次）：${lastError}`);
}

/**
 * 稳定填写 Vue/Element 输入框（带事件触发）
 *
 * Element UI 的 el-input 需要额外触发 input 事件才能更新 v-model。
 */
export async function stableFillVueInput(
  locator: Locator,
  value: string,
  options?: StableFillOptions,
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError = '';

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      await waitInteractable(locator, opts.visibleTimeoutMs);
      await locator.click({ timeout: opts.visibleTimeoutMs });
      await locator.press('Control+a');
      await locator.press('Delete');
      await sleep(100);
      // 使用 type 逐字符输入，更容易触发 Vue 监听
      await locator.pressSequentially(value, { delay: 30, timeout: opts.visibleTimeoutMs });
      // 触发完整事件链
      await locator.evaluate((el: HTMLInputElement) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      await sleep(opts.settleMs);
      await locator.evaluate((el: HTMLElement) => el.blur());
      await sleep(100);
      // 校验
      const actual = await readValue(locator);
      if (actual === value || actual.includes(value)) {
        return; // 成功
      }
      lastError = `第 ${attempt} 次填写后校验失败：期望 "${maskValue(value)}"，实际 "${maskValue(actual)}"`;
      console.log(`  [StableVue] ${lastError}`);
    } catch (err) {
      lastError = `第 ${attempt} 次填写异常：${(err as Error).message}`;
      console.log(`  [StableVue] ${lastError}`);
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`Vue 输入框填写失败（重试 ${opts.maxRetries} 次）：${lastError}`);
}

/**
 * 校验输入框值是否等于期望值
 */
export async function verifyInputValue(
  locator: Locator,
  expected: string,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const timeout = options?.timeoutMs ?? 3000;
  try {
    await waitInteractable(locator, timeout);
    const actual = await readValue(locator);
    return actual === expected;
  } catch {
    return false;
  }
}

/**
 * 稳定点击
 *
 * 流程：等待可见 → 等待 enabled → scroll into view → click
 */
export async function stableClick(
  locator: Locator,
  options?: { timeoutMs?: number },
): Promise<void> {
  const timeout = options?.timeoutMs ?? 5000;
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded({ timeout });
  await locator.click({ timeout });
}

// ── 工具函数 ──

/**
 * 脱敏值：只显示前2后2字符
 */
function maskValue(value: string): string {
  if (value.length <= 6) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

/**
 * 稳定填写 Element 下拉选择（远程搜索/自动完成）
 *
 * 流程：
 *   1. 点击输入框激活下拉
 *   2. 清空 + 输入搜索文本
 *   3. 等待候选项出现
 *   4. 点击包含目标文本的候选项
 *   5. blur
 *   6. 读取输入框或已选文本校验
 *
 * 支持的候选项选择器：
 *   .el-select-dropdown__item
 *   .el-autocomplete-suggestion li
 *   .el-cascader-node
 *   [role="option"]
 */
export async function stableSelectDropdown(
  page: Page,
  inputLocator: Locator,
  searchText: string,
  options?: StableFillOptions,
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const candidateSelectors = [
    '.el-select-dropdown__item',
    '.el-autocomplete-suggestion li',
    '.el-cascader-node',
    '[role="option"]',
  ];

  let lastError = '';

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      // 1. 点击输入框
      await waitInteractable(inputLocator, opts.visibleTimeoutMs);
      await inputLocator.click({ timeout: opts.visibleTimeoutMs });
      await sleep(300);

      // 2. 清空 + 输入
      await inputLocator.press('Control+a');
      await inputLocator.press('Delete');
      await sleep(100);
      await inputLocator.pressSequentially(searchText, { delay: 50, timeout: opts.visibleTimeoutMs });
      await dispatchInputEvents(inputLocator);
      await sleep(800); // 等待远程搜索返回

      // 3. 查找候选项
      let selected = false;
      for (const sel of candidateSelectors) {
        try {
          const items = page.locator(sel);
          const count = await items.count();
          for (let i = 0; i < count; i++) {
            const item = items.nth(i);
            if (await item.isVisible({ timeout: 500 })) {
              const text = (await item.textContent() || '').trim();
              if (text.includes(searchText)) {
                await item.click({ timeout: 2000 });
                selected = true;
                await sleep(opts.settleMs);
                console.log(`  [StableSelect] 第 ${attempt} 次尝试：选中候选项 "${text}"`);
                break;
              }
            }
          }
          if (selected) break;
        } catch {
          // 跳过该选择器
        }
      }

      if (!selected) {
        // 如果没找到候选项，尝试直接回车确认
        await inputLocator.press('Enter');
        await sleep(opts.settleMs);
      }

      // 4. blur
      await inputLocator.evaluate((el: HTMLElement) => el.blur());
      await sleep(200);

      // 5. 校验：读取输入框值或已选标签文本
      const inputVal = await readValue(inputLocator).catch(() => '');
      if (inputVal.includes(searchText)) {
        return inputVal;
      }

      // 也检查 el-tag（Element select 选中后显示的标签）
      const tagText = await page.evaluate((search: string) => {
        const tags = document.querySelectorAll('.el-select .el-tag, .el-input__prefix .el-tag');
        for (const tag of tags) {
          const text = (tag.textContent || '').trim();
          if (text.includes(search)) return text;
        }
        return '';
      }, searchText).catch(() => '');

      if (tagText.includes(searchText)) {
        return tagText;
      }

      lastError = `第 ${attempt} 次选择后校验失败：未确认选中 "${searchText}"（input="${maskValue(inputVal)}"）`;
      console.log(`  [StableSelect] ${lastError}`);
    } catch (err) {
      lastError = `第 ${attempt} 次选择异常：${(err as Error).message}`;
      console.log(`  [StableSelect] ${lastError}`);
    }
    if (attempt < opts.maxRetries) {
      await sleep(opts.retryDelayMs);
    }
  }

  throw new Error(`下拉选择填写失败（重试 ${opts.maxRetries} 次）：${lastError}`);
}
