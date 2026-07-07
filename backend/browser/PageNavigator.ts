// 页面导航封装
// 提供 URL 导航、toast 等待、截图、loading 等待等功能
import type { Page } from 'playwright';
import path from 'path';
import fs from 'fs-extra';
import { dismissPopups } from './PopupDismiss';

// 目标系统基础 URL
const BASE_URL = 'https://bnsy.benniaosuyun.com';

// 截图保存目录（bnsy-operator-next: runtime/screenshots，与生产项目 logs/screenshots 隔离）
const SCREENSHOT_DIR = path.join(process.cwd(), 'runtime', 'screenshots');

/** Phase 5-G-8: 全局截图开关。默认关闭，设置 ENABLE_RUNTIME_SCREENSHOTS=1 开启 */
function isScreenshotEnabled(): boolean {
  return process.env.ENABLE_RUNTIME_SCREENSHOTS === '1'
    || process.env.ENABLE_RUNTIME_SCREENSHOTS === 'true';
}

/**
 * 导航到指定路由
 * 基础 URL: https://bnsy.benniaosuyun.com
 * 若 page.url() 已包含 route 字符串，直接 return，不重复导航
 * 否则执行 page.goto，导航后调用 waitForLoadingDone
 */
export async function navigateTo(page: Page, route: string): Promise<void> {
  // 已在该路由则不重复导航
  if (page.url().includes(route)) {
    console.log(`[Navigator] 已在目标路由 ${route}，跳过导航`);
    return;
  }

  console.log(`[Navigator] 导航到 ${route}`);
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[Navigator] page.goto 失败: ${(e as Error).message}，继续执行`);
  }

  // 导航后等待 loading 完成
  await waitForLoadingDone(page);

  // 清除弹窗
  await dismissPopups(page);

  console.log(`[Navigator] 导航完成，当前 URL: ${page.url()}`);
}

/**
 * 等待 toast 提示出现并返回文字
 * 依次尝试 '.el-message' '.el-notification' '.el-message-box__message' '[class*="el-message"]'
 * @param page Playwright Page 对象
 * @param timeoutMs 超时时间（毫秒），默认 15000
 * @returns toast 文字内容；全部超时返回 'timeout:未收到系统响应'（不抛异常）
 */
export async function waitForToast(page: Page, timeoutMs = 15000): Promise<string> {
  const selectors = [
    '.el-message',
    '.el-notification',
    '.el-message-box__message',
    '[class*="el-message"]',
  ];

  for (const selector of selectors) {
    try {
      const el = await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
      if (el) {
        const text = (await el.textContent().catch(() => ''))?.trim() || '';
        const trimmed = text.trim();
        console.log(`[Toast] ${trimmed}`);

        // 等待 toast 消失
        await page.waitForSelector(selector, { state: 'hidden', timeout: 5000 }).catch(() => {});
        return trimmed;
      }
    } catch {
      // 当前 selector 未匹配，尝试下一个
      continue;
    }
  }

  return 'timeout:未收到系统响应';
}

/**
 * 截图保存到 ./logs/screenshots/ 目录
 *
 * Phase 5-G-8: 默认关闭截图。设置 ENABLE_RUNTIME_SCREENSHOTS=1 可重新开启。
 *
 * @param page Playwright Page 对象
 * @param label 截图标签（如 "arrive_start"）
 * @returns 截图文件相对路径（关闭时返回空字符串）
 */
export async function takeScreenshot(page: Page, label: string): Promise<string> {
  if (!isScreenshotEnabled()) return '';
  fs.ensureDirSync(SCREENSHOT_DIR);
  // 本地时间格式化: yyyyMMdd_HHmmss
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const fileName = `${timestamp}_${label}.png`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 }).catch((e) => {
    console.warn(`[Screenshot] 截图失败 ${label}:`, (e as Error).message);
  });
  return `runtime/screenshots/${fileName}`;
}

/**
 * Phase G-2: 失败自动截图
 *
 * Phase 5-G-8: 默认关闭截图。设置 ENABLE_RUNTIME_SCREENSHOTS=1 可重新开启。
 *
 * 所有 Scan 模块（ArrivalScan/DispatchScan/IntegratedScan/SignScan）异常捕获时统一调用。
 * 文件名格式：YYYYMMDD-HHmmss-taskId-step.png
 * 保存目录：logs/screenshots
 *
 * @param page Playwright Page 对象
 * @param taskId 任务ID
 * @param step 失败步骤标识（如 "batch1_navigation"）
 * @returns 截图文件相对路径；截图失败或关闭时返回空字符串
 */
export async function captureFailureScreenshot(
  page: Page,
  taskId: string,
  step: string,
): Promise<string> {
  if (!isScreenshotEnabled()) return '';
  try {
    fs.ensureDirSync(SCREENSHOT_DIR);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-12);
    const safeStep = step.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-30);
    const fileName = `${timestamp}-${safeTaskId}-${safeStep}.png`;
    const filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 });
    console.log(`[Screenshot] 截图已保存 路径: runtime/screenshots/${fileName}`);
    return `runtime/screenshots/${fileName}`;
  } catch (e) {
    console.warn(`[Screenshot] 失败截图异常 ${step}:`, (e as Error).message);
    return '';
  }
}

// 旧函数名向后兼容
export { takeScreenshot as screenshot };

// toast 信息类型（向后兼容）
export interface ToastInfo {
  text: string;
  type: 'success' | 'warning' | 'error' | 'info';
}

/**
 * 等待页面 loading 遮罩消失
 * page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 10000 })
 * 若 10 秒内未消失或元素不存在，静默忽略
 */
export async function waitForLoadingDone(page: Page): Promise<void> {
  await page.waitForSelector('.el-loading-mask', { state: 'hidden', timeout: 10000 }).catch(() => {});
}

/**
 * 等待页面就绪（向后兼容，内部调用 waitForLoadingDone）
 */
export async function waitForPageReady(page: Page, _timeout = 5000): Promise<void> {
  await page.waitForSelector('.app-container, .el-table, .el-form, .el-card', { timeout: _timeout }).catch(() => {});
  await waitForLoadingDone(page);
}
