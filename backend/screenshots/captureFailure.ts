import type { Page } from 'playwright';
import path from 'path';
import fs from 'fs-extra';

// bnsy-operator-next: 截图保存到 runtime/screenshots（与生产项目 logs/screenshots 隔离）
const SCREENSHOT_DIR = path.join(process.cwd(), 'runtime', 'screenshots');

/** Phase 5-G-8: 全局截图开关 */
function isScreenshotEnabled(): boolean {
  return process.env.ENABLE_RUNTIME_SCREENSHOTS === '1'
    || process.env.ENABLE_RUNTIME_SCREENSHOTS === 'true';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function fileTimestamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_').slice(0, 40);
}

export interface FailureScreenshotOptions {
  pageNum: number;
  signer?: string;
  label?: string;
}

export async function captureSignFailureScreenshot(
  page: Page,
  opts: FailureScreenshotOptions,
): Promise<string> {
  // Phase 5-G-8: 默认关闭截图
  if (!isScreenshotEnabled()) return '';
  const { pageNum, signer, label } = opts;
  try {
    await fs.ensureDir(SCREENSHOT_DIR);
    const ts = fileTimestamp();
    const parts: string[] = [`page_${pageNum}`, ts];
    if (signer) parts.push(sanitize(signer));
    if (label) parts.push(sanitize(label));
    const fileName = `${parts.join('_')}.png`;
    const filePath = path.join(SCREENSHOT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 });
    return `runtime/screenshots/${fileName}`;
  } catch (e) {
    return '';
  }
}
