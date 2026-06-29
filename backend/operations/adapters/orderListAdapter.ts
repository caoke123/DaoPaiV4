import type { Page, Locator } from 'playwright';
import { SIGN_SELECTORS } from '../selectors/signSelectors';

const TIMEOUT_ELEMENT = 10000;
const TIMEOUT_BUTTON = 3000;
const CHECK_SETTLE = 500;
const MAX_RETRIES = 3;

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

const noopLog: LogFn = () => {};

async function waitForLoadingHidden(page: Page, timeout: number = TIMEOUT_ELEMENT): Promise<void> {
  await page.waitForSelector(SIGN_SELECTORS.loadingMask, { state: 'hidden', timeout }).catch(() => {});
}

function page_wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  label: string = 'operation',
  log: LogFn = noopLog,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      log('warning', `[${label}] 第${i + 1}次重试失败: ${lastErr.message}`);
      await page_wait(500);
    }
  }
  throw lastErr ?? new Error(`[${label}] 重试${retries}次后仍失败`);
}

export interface OrderRow {
  index: number;
  orderNumber: string;
  locator: Locator;
}

export class OrderListAdapter {
  private page: Page;
  private log: LogFn;

  constructor(page: Page, log?: LogFn) {
    this.page = page;
    this.log = log ?? noopLog;
  }

  async waitForReady(): Promise<void> {
    await this.page.waitForSelector(SIGN_SELECTORS.orderRow, { state: 'visible', timeout: TIMEOUT_ELEMENT });
    await waitForLoadingHidden(this.page);
  }

  async getAllRows(): Promise<OrderRow[]> {
    await this.waitForReady();
    const rowLocs = this.page.locator(SIGN_SELECTORS.orderRow);
    const count = await rowLocs.count();
    const rows: OrderRow[] = [];

    for (let i = 0; i < count; i++) {
      const row = rowLocs.nth(i);
      const orderNumberCell = row.locator(SIGN_SELECTORS.orderNumberCell);
      const orderNumber = (await orderNumberCell.textContent().catch(() => ''))?.trim() ?? '';
      rows.push({ index: i, orderNumber, locator: row });
    }

    return rows;
  }

  async getRowCount(): Promise<number> {
    await this.waitForReady();
    return this.page.locator(SIGN_SELECTORS.orderRow).count();
  }

  async selectAll(): Promise<number> {
    const label = 'selectAll';
    this.log('info', '[OrderList] 全选当前页订单');

    let selectedCount = 0;

    await retry(async () => {
      await this.waitForReady();

      const checkboxLoc = this.page.locator(SIGN_SELECTORS.selectAllCheckbox).first();
      const cbCount = await checkboxLoc.count();

      if (cbCount === 0) {
        const jsOk = await this.page.evaluate(() => {
          const input = document.querySelector(
            '.el-table__header-wrapper input[type="checkbox"]'
          ) as HTMLInputElement | null;
          if (input) {
            input.click();
            return true;
          }
          return false;
        }).catch(() => false);

        if (!jsOk) {
          throw new Error('未找到全选 checkbox');
        }
        await page_wait(CHECK_SETTLE);
      } else {
        const isChecked = await checkboxLoc.isChecked().catch(() => false);
        if (!isChecked) {
          try {
            await checkboxLoc.check({ force: true, timeout: TIMEOUT_BUTTON });
          } catch {
            await this.page.evaluate(() => {
              const input = document.querySelector(
                '.el-table__header-wrapper input[type="checkbox"]'
              ) as HTMLInputElement | null;
              if (input) input.click();
            });
          }
          await page_wait(CHECK_SETTLE);
        }
      }

      const checkedRows = await this.getCheckedRows();
      selectedCount = checkedRows.length;

      if (selectedCount === 0) {
        const totalRows = await this.getRowCount();
        if (totalRows > 0) {
          throw new Error(`全选后未检测到已勾选行 (共${totalRows}行)`);
        }
      }
    }, MAX_RETRIES, label, this.log);

    this.log('info', `[OrderList] 已勾选 ${selectedCount} 条订单`);
    return selectedCount;
  }

  async getCheckedRows(): Promise<OrderRow[]> {
    await this.waitForReady();
    const allRows = await this.getAllRows();
    const checked: OrderRow[] = [];

    for (const row of allRows) {
      const cb = row.locator.locator('input[type="checkbox"]').first();
      const isChecked = await cb.isChecked().catch(() => false);
      if (isChecked) {
        checked.push(row);
      }
    }

    return checked;
  }

  async getOrderNumbers(): Promise<string[]> {
    const rows = await this.getAllRows();
    return rows.map(r => r.orderNumber).filter(n => n.length > 0);
  }

  async unselectAll(): Promise<void> {
    const label = 'unselectAll';
    this.log('info', '[OrderList] 取消全选');

    await retry(async () => {
      await this.waitForReady();
      const checkboxLoc = this.page.locator(SIGN_SELECTORS.selectAllCheckbox).first();
      const isChecked = await checkboxLoc.isChecked().catch(() => false);

      if (isChecked) {
        try {
          await checkboxLoc.uncheck({ force: true, timeout: TIMEOUT_BUTTON });
        } catch {
          await this.page.evaluate(() => {
            const input = document.querySelector(
              '.el-table__header-wrapper input[type="checkbox"]'
            ) as HTMLInputElement | null;
            if (input && input.checked) input.click();
          });
        }
        await page_wait(CHECK_SETTLE);
      }
    }, MAX_RETRIES, label, this.log);
  }
}
