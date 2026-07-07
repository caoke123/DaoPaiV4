import type { Page } from 'playwright';
import { SIGN_SELECTORS, type PageSizeOption } from '../selectors/signSelectors';

const TIMEOUT_ELEMENT = 10000;
const TIMEOUT_BUTTON = 3000;
const PAGINATION_SETTLE = 1500;
const MAX_RETRIES = 3;

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

const noopLog: LogFn = () => {};

async function waitForLoadingHidden(page: Page, timeout: number = TIMEOUT_ELEMENT): Promise<void> {
  await page.waitForSelector(SIGN_SELECTORS.loadingMask, { state: 'hidden', timeout }).catch(() => {});
}

async function retry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  label: string = 'operation',
  log: LogFn = noopLog,
  page?: Page,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      // 重试前关闭所有下拉框和弹窗，避免残留状态干扰
      if (page && i > 0) {
        await page.keyboard.press('Escape').catch(() => {});
        await page_wait(500);
        // 确认 loading 遮罩已消失
        await waitForLoadingHidden(page, 3000);
      }
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      log('warning', `[${label}] 第${i + 1}次重试失败: ${lastErr.message}`);
      // 失败后额外等待，让页面恢复
      await page_wait(800);
    }
  }
  throw lastErr ?? new Error(`[${label}] 重试${retries}次后仍失败`);
}

function page_wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class PaginationAdapter {
  private page: Page;
  private log: LogFn;

  constructor(page: Page, log?: LogFn) {
    this.page = page;
    this.log = log ?? noopLog;
  }

  async waitForReady(): Promise<void> {
    await this.page.waitForSelector(SIGN_SELECTORS.pageSizeInput, { state: 'visible', timeout: TIMEOUT_ELEMENT });
    await waitForLoadingHidden(this.page);
  }

  async setPageSize(size: PageSizeOption): Promise<void> {
    const label = `setPageSize(${size})`;
    this.log('info', `[Pagination] 设置每页 ${size} 条`);

    await retry(async () => {
      await this.waitForReady();

      const sizeText = `${size}条/页`;

      // 先确保没有残留的下拉框
      await this.page.keyboard.press('Escape').catch(() => {});
      await page_wait(300);

      await this.page.click(SIGN_SELECTORS.pageSizeInput, { timeout: TIMEOUT_BUTTON });
      await page_wait(800);  // 增加等待时间，确保下拉框动画完成

      // 使用 evaluate 原生点击绕过 CSS 动画导致的视口外问题
      const clicked = await this.page.evaluate((text) => {
        const items = document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item');
        for (const item of items) {
          if ((item.textContent ?? '').trim() === text) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, sizeText);

      if (!clicked) {
        // 诊断：列举实际可用的选项
        const availableItems = await this.page.evaluate(() => {
          const items = document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item');
          return Array.from(items).map(i => (i.textContent ?? '').trim());
        });
        throw new Error(`无法点击 ${sizeText} 选项，实际可用: ${availableItems.join(', ')}`);
      }

      await page_wait(PAGINATION_SETTLE);
      await waitForLoadingHidden(this.page);

      // 用 evaluate 读取 input 值（inputValue 对 readonly el-select input 不可靠）
      const currentValue = await this.page.evaluate(() => {
        const input = document.querySelector('.el-pagination .el-pagination__sizes .el-input__inner');
        return (input as HTMLInputElement)?.value ?? '';
      });
      if (!currentValue.includes(String(size))) {
        throw new Error(`分页切换验证失败: 预期包含"${size}", 实际="${currentValue}"`);
      }
    }, MAX_RETRIES, label, this.log, this.page);

    this.log('info', `[Pagination] 已设为 ${size} 条/页`);
  }

  async getCurrentPage(): Promise<number> {
    await this.waitForReady();
    const loc = this.page.locator(SIGN_SELECTORS.currentPage).first();
    const text = await loc.textContent().catch(() => '');
    const page = parseInt(text?.trim() ?? '1', 10);
    return isNaN(page) ? 1 : page;
  }

  async getTotalCount(): Promise<number> {
    await this.waitForReady();
    const loc = this.page.locator(SIGN_SELECTORS.totalCount).first();
    const text = await loc.textContent().catch(() => '');
    const match = text?.match(/共\s*(\d+)\s*条/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  }

  async getTotalPages(): Promise<number> {
    const total = await this.getTotalCount();
    const sizeText = await this.page.locator(SIGN_SELECTORS.pageSizeInput).inputValue().catch(() => '100');
    const sizeMatch = sizeText.match(/(\d+)/);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 100;
    return Math.max(1, Math.ceil(total / size));
  }

  async nextPage(): Promise<boolean> {
    const label = 'nextPage';
    this.log('info', '[Pagination] 下一页');

    try {
      await this.waitForReady();

      const btnLoc = this.page.locator(SIGN_SELECTORS.nextPageBtn).first();
      const isDisabled = await btnLoc.evaluate(el => el.classList.contains('disabled')).catch(() => true);

      if (isDisabled) {
        this.log('info', '[Pagination] 已是最后一页');
        return false;
      }

      await btnLoc.click({ timeout: TIMEOUT_BUTTON });
      await page_wait(PAGINATION_SETTLE);
      await waitForLoadingHidden(this.page);
      return true;
    } catch (e) {
      this.log('warning', `[${label}] 失败: ${(e as Error).message}`);
      return false;
    }
  }

  async prevPage(): Promise<boolean> {
    const label = 'prevPage';
    this.log('info', '[Pagination] 上一页');

    try {
      await this.waitForReady();

      const btnLoc = this.page.locator(SIGN_SELECTORS.prevPageBtn).first();
      const isDisabled = await btnLoc.evaluate(el => el.classList.contains('disabled')).catch(() => true);

      if (isDisabled) {
        this.log('info', '[Pagination] 已是第一页');
        return false;
      }

      await btnLoc.click({ timeout: TIMEOUT_BUTTON });
      await page_wait(PAGINATION_SETTLE);
      await waitForLoadingHidden(this.page);
      return true;
    } catch (e) {
      this.log('warning', `[${label}] 失败: ${(e as Error).message}`);
      return false;
    }
  }

  async jumpToPage(pageNum: number): Promise<void> {
    const label = `jumpToPage(${pageNum})`;
    this.log('info', `[Pagination] 跳转到第 ${pageNum} 页`);

    await retry(async () => {
      await this.waitForReady();

      const totalPages = await this.getTotalPages();
      if (pageNum < 1 || pageNum > totalPages) {
        throw new Error(`页码 ${pageNum} 超出范围 (1-${totalPages})`);
      }

      const inputLoc = this.page.locator(SIGN_SELECTORS.jumpPageInput).first();
      await inputLoc.fill(String(pageNum), { timeout: TIMEOUT_ELEMENT });
      await this.page.keyboard.press('Enter');
      await page_wait(PAGINATION_SETTLE);
      await waitForLoadingHidden(this.page);

      const current = await this.getCurrentPage();
      if (current !== pageNum) {
        throw new Error(`跳转验证失败: 预期=${pageNum}, 实际=${current}`);
      }
    }, MAX_RETRIES, label, this.log, this.page);

    this.log('info', `[Pagination] 已跳转到第 ${pageNum} 页`);
  }
}
