import type { Page } from 'playwright';
import { SIGN_SELECTORS, DEFAULT_PAGE_SIZE, DEFAULT_SIGNER, type PageSizeOption } from '../selectors/signSelectors';
import { PaginationAdapter } from '../adapters/paginationAdapter';
import { OrderListAdapter } from '../adapters/orderListAdapter';
import { generateSignPlan, formatSignPlanLog, type SignPlan } from '../../utils/signAssignmentGenerator';
import { ExecutionLogger, createExecutionLogger, type ExternalLogFn } from '../../logger/executionLogger';
import { captureSignFailureScreenshot } from '../../screenshots/captureFailure';
import { PopupManager } from '../../browser/PopupManager';
import {
  ExecutionReportBuilder,
  formatExecutionReport,
  type ExecutionReport,
} from '../../reports/executionReport';

const TIMEOUT_ELEMENT = 10000;
const TIMEOUT_BUTTON = 3000;
const TIMEOUT_DIALOG = 10000;
const DIALOG_SETTLE = 500;
const MAX_RETRIES = 3;
const MAX_SEARCH_RETRIES = 2;
const SEARCH_WAIT_MIN_MS = 3500;
const SEARCH_WAIT_MAX_MS = 5000;
const POPUP_GUARD_TIMEOUT = 4000;

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;
type SearchResultStatus = 'has_rows' | 'no_data' | 'timeout' | 'error';

const noopLog: LogFn = () => {};

async function waitForLoadingHidden(page: Page, timeout: number = TIMEOUT_ELEMENT): Promise<void> {
  await page.waitForSelector(SIGN_SELECTORS.loadingMask, { state: 'hidden', timeout }).catch(() => {});
}

function page_wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomWaitMs(min = SEARCH_WAIT_MIN_MS, max = SEARCH_WAIT_MAX_MS): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function hasVisible(page: Page, selector: string): Promise<boolean> {
  const loc = page.locator(selector).first();
  return (await loc.count().catch(() => 0)) > 0 && await loc.isVisible().catch(() => false);
}

async function detectNoData(page: Page): Promise<boolean> {
  const emptySelector = '.el-table__empty-block:visible, .el-table__empty-text:visible';
  const emptyLoc = page.locator(emptySelector).first();
  if ((await emptyLoc.count().catch(() => 0)) > 0 && await emptyLoc.isVisible().catch(() => false)) {
    const text = ((await emptyLoc.textContent({ timeout: 300 }).catch(() => '')) || '').replace(/\s+/g, '');
    if (!text || /暂无数据|无数据|没有数据|没有查询到数据|未查询到/.test(text)) {
      return true;
    }
  }

  const tableText = ((await page.locator('.el-table').first().textContent({ timeout: 300 }).catch(() => '')) || '').replace(/\s+/g, '');
  return /暂无数据|无数据|没有数据|没有查询到数据|未查询到/.test(tableText);
}

async function isSearchLoadingVisible(page: Page): Promise<boolean> {
  return hasVisible(page, '.el-loading-mask:visible, .el-loading-spinner:visible');
}

/**
 * 轻量弹窗守卫：清理可能遮挡操作元素的弹窗，并检查 URL 稳定性
 */
async function dismissGuardingPopups(
  page: Page,
  logger: LogFn,
  timeout: number = POPUP_GUARD_TIMEOUT,
): Promise<void> {
  const urlBefore = page.url();
  try {
    const popupMgr = PopupManager.getInstance();
    const dismissed = await popupMgr.dismissAll(page, {
      timeout,
      maxRounds: 2,
      verifyAfter: false,
    });
    if (dismissed > 0) {
      logger('info', `[弹窗守卫] 清理了 ${dismissed} 个弹窗`);
    }
  } catch {
    // 清理失败不阻塞主流程
  }
  // 检查 URL 是否变化（dismissAll 的"取消"可能触发跳转）
  const urlAfter = page.url();
  if (urlBefore !== urlAfter) {
    logger('warning', `[弹窗守卫] 弹窗清理导致 URL 变化: ${urlBefore} → ${urlAfter}`);
  }
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
      if (page) {
        // 清理弹窗
        await dismissGuardingPopups(page, log).catch(() => {});
        // 关闭所有残留下拉框，避免 stale 状态干扰后续操作
        await page.keyboard.press('Escape').catch(() => {});
        await page_wait(300);
        await waitForLoadingHidden(page, 3000);
      }
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      log('warning', `[${label}] 第${i + 1}次重试失败: ${lastErr.message}`);
      await page_wait(800);
    }
  }
  throw lastErr ?? new Error(`[${label}] 重试${retries}次后仍失败`);
}

export interface SignPageResult {
  pageNum: number;
  signer: string;
  selectedCount: number;
  orderNumbers: string[];
  dryRun: boolean;
  error?: string;
  screenshot?: string;
}

export interface SignBatchResult {
  totalPages: number;
  totalSelected: number;
  pageResults: SignPageResult[];
  signPlan?: SignPlan;
  dryRun: boolean;
  report: ExecutionReport;
}

export class SignExecutor {
  private page: Page;
  private pagination: PaginationAdapter;
  private orderList: OrderListAdapter;
  private logger: ExecutionLogger;
  private dryRunMode: boolean;

  constructor(page: Page, externalLog?: ExternalLogFn, dryRunMode?: boolean) {
    this.page = page;
    this.dryRunMode = dryRunMode ?? true;
    this.logger = createExecutionLogger(externalLog);

    const adapterLog: LogFn = (level, msg) => {
      if (level === 'error') this.logger.error(msg);
      else if (level === 'warning') this.logger.warn(msg);
      else this.logger.info(msg);
    };
    this.pagination = new PaginationAdapter(page, adapterLog);
    this.orderList = new OrderListAdapter(page, adapterLog);
  }

  async waitForPageReady(): Promise<void> {
    await this.page.waitForSelector(SIGN_SELECTORS.searchButton, { state: 'visible', timeout: TIMEOUT_ELEMENT });
    await waitForLoadingHidden(this.page);
  }

  private async waitForSearchResult(attempt: number, timeoutMs: number): Promise<SearchResultStatus> {
    const start = Date.now();
    let loadingSeen = false;

    while (Date.now() - start < timeoutMs) {
      const rowCount = await this.page.locator(SIGN_SELECTORS.orderRow).count().catch(() => 0);
      if (rowCount > 0) {
        this.logger.info(`[clickSearch] has_rows: ${rowCount} 条`);
        return 'has_rows';
      }

      if (await detectNoData(this.page)) {
        this.logger.info('[clickSearch] 搜索完成：暂无数据，结束本页处理');
        return 'no_data';
      }

      const loadingVisible = await isSearchLoadingVisible(this.page);
      if (loadingVisible) {
        loadingSeen = true;
      } else if (loadingSeen || Date.now() - start >= 800) {
        const latestRowCount = await this.page.locator(SIGN_SELECTORS.orderRow).count().catch(() => 0);
        if (latestRowCount === 0) {
          this.logger.info('[clickSearch] Loading 已结束且无表格行，按暂无数据处理');
          return 'no_data';
        }
      }

      await page_wait(150);
    }

    this.logger.warn(`[clickSearch] 第${attempt}次等待失败：未出现表格行/暂无数据/Loading结束状态`);
    return 'timeout';
  }

  async clickSearch(): Promise<SearchResultStatus> {
    const label = 'clickSearch';
    this.logger.setContext({ action: '搜索' });
    this.logger.info('点击搜索');

    for (let attempt = 1; attempt <= MAX_SEARCH_RETRIES; attempt++) {
      try {
        await dismissGuardingPopups(this.page, this.adapterScopedLog()).catch(() => {});
        await this.page.keyboard.press('Escape').catch(() => {});
        await page_wait(300);
        await waitForLoadingHidden(this.page, 3000);
        await this.waitForPageReady();
        await this.page.click(SIGN_SELECTORS.searchButton, { timeout: TIMEOUT_BUTTON });

        const timeoutMs = randomWaitMs();
        this.logger.info(`[clickSearch] 第${attempt}次等待搜索结果，timeout=${timeoutMs}ms`);
        const status = await this.waitForSearchResult(attempt, timeoutMs);

        if (status === 'has_rows') {
          return status;
        }
        if (status === 'no_data') {
          return status;
        }
      } catch (e) {
        this.logger.warn(`[${label}] 第${attempt}次重试失败: ${(e as Error).message}`);
      }

      if (attempt < MAX_SEARCH_RETRIES) {
        await page_wait(800);
      }
    }

    this.logger.warn('[clickSearch] 2次重试后仍无结果，结束搜索');
    throw new Error('搜索结果等待超时：2 次重试后仍未出现表格行或暂无数据状态');
  }

  async selectCourier(staffName: string): Promise<void> {
    const label = 'selectCourier';
    this.logger.setContext({ action: '选择派件员' });
    this.logger.info(`选择派件员: ${staffName}`);

    await retry(async () => {
      await this.waitForPageReady();

      // 点击输入框打开下拉
      const inputLoc = this.page.locator(SIGN_SELECTORS.courierSelectInput).first();
      await inputLoc.click({ timeout: TIMEOUT_ELEMENT });
      await page_wait(800);

      // Element UI 下拉框有 CSS 动画 (el-zoom-in-top)，后台标签页动画可能不完成
      // 导致选项 height=0 opacity=0 且在视口外。使用 evaluate 原生点击绕过所有 Playwright 检查
      const clicked = await this.page.evaluate((name) => {
        const items = document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item');
        for (const item of items) {
          if ((item.textContent ?? '').trim() === name) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, staffName);

      if (!clicked) {
        // 枚举实际下拉选项用于诊断
        const allOpts = this.page.locator(
          'div.el-select-dropdown.el-popper li.el-select-dropdown__item'
        );
        const allCount = await allOpts.count();
        const texts: string[] = [];
        for (let i = 0; i < Math.min(allCount, 20); i++) {
          const t = (await allOpts.nth(i).textContent().catch(() => ''))?.trim() ?? '';
          texts.push(t);
        }
        throw new Error(`派件员列表中未找到"${staffName}"，下拉选项(${allCount}项): ${texts.join(', ')}`);
      }

      await page_wait(500);
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    this.logger.success(`派件员已选择: ${staffName}`);
  }

  async setDateRangeToday(): Promise<void> {
    const label = 'setDateRangeToday';
    this.logger.setContext({ action: '设置日期' });
    this.logger.info('设置签收时间为当天');

    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${month}-${day}`;

    await retry(async () => {
      await this.waitForPageReady();

      await this.page.click(SIGN_SELECTORS.dateRangeInput, { timeout: TIMEOUT_ELEMENT });
      await page_wait(500);

      const startInputLoc = this.page.locator(SIGN_SELECTORS.datePickerStartInput).first();
      await startInputLoc.fill(dateStr, { timeout: TIMEOUT_ELEMENT });
      await page_wait(300);

      const endInputLoc = this.page.locator(SIGN_SELECTORS.datePickerEndInput).first();
      await endInputLoc.fill(dateStr, { timeout: TIMEOUT_ELEMENT });
      await page_wait(300);

      const confirmLoc = this.page.locator(SIGN_SELECTORS.datePickerConfirm).first();
      await confirmLoc.click({ timeout: TIMEOUT_BUTTON });
      await page_wait(500);
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    this.logger.success(`签收时间已设置: ${dateStr}`);
  }

  async executePageSign(signer: string = DEFAULT_SIGNER): Promise<SignPageResult> {
    const label = 'executePageSign';
    const pageNum = await this.pagination.getCurrentPage();
    this.logger.setContext({ pageNum, signer, action: '签收' });
    this.logger.info('开始执行...');

    let selectedCount = 0;
    let orderNumbers: string[] = [];

    await retry(async () => {
      await this.waitForPageReady();
      await this.pagination.waitForReady();
      await this.orderList.waitForReady();

      selectedCount = await this.orderList.selectAll();
      orderNumbers = await this.orderList.getOrderNumbers();

      if (selectedCount === 0) {
        this.logger.info('本页无订单，跳过');
        return;
      }

      await this.clickBatchSignButton();
      await this.selectSignerInDialog(signer);

      // Phase 9-dryrun: 全局试运行模式检查点 —— 签收是高风险操作，在最终确认前阻断
      if (this.dryRunMode) {
        this.logger.info('[试运行模式] 签收录入已执行到最终确认前，跳过真实签收提交');
        return;
      }

      this.logger.info('[真实执行模式] 即将点击"确认"按钮，执行真实签收提交');
      await this.confirmSignInDialog();
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    if (selectedCount === 0) {
      return { pageNum, signer, selectedCount: 0, orderNumbers: [], dryRun: this.dryRunMode };
    }

    if (this.dryRunMode) {
      this.logger.success(`[试运行模式] 签收确认弹窗已停，选中${selectedCount}条，跳过真实提交`);
      return { pageNum, signer, selectedCount, orderNumbers, dryRun: true };
    }

    this.logger.success(`签收完成，选中${selectedCount}条`);
    return { pageNum, signer, selectedCount, orderNumbers, dryRun: false };
  }

  async executeBatchFlow(pageSize: PageSizeOption = DEFAULT_PAGE_SIZE, signerPerson?: string): Promise<SignBatchResult> {
    const flowStart = Date.now();
    this.logger.resetContext();
    this.logger.setContext({ action: '批量签收' });
    this.logger.info(`开始批量签收流程 (pageSize=${pageSize}${signerPerson ? `, signerPerson=${signerPerson}` : ''})`);

    let totalPages = 0;
    let signPlan: SignPlan | undefined;
    const pageResults: SignPageResult[] = [];
    let totalSelected = 0;
    let report: ExecutionReport;

    try {
      await this.waitForPageReady();
      await this.pagination.setPageSize(pageSize);
      const searchStatus = await this.clickSearch();
      if (searchStatus === 'no_data') {
        this.logger.info('搜索结果为空：无可签收记录，结束批量签收流程');
        report = new ExecutionReportBuilder(0, this.dryRunMode).build();
        this.logger.info(`PERF executeBatchFlow total ${Date.now() - flowStart}ms`);
        this.logger.info('\n' + formatExecutionReport(report));
        return {
          totalPages: report.totalPages,
          totalSelected: report.totalSelected,
          pageResults,
          signPlan,
          dryRun: this.dryRunMode,
          report,
        };
      }

      totalPages = await this.pagination.getTotalPages();
      const totalCount = await this.pagination.getTotalCount();
      this.logger.info(`共 ${totalCount} 条，${totalPages} 页`);

      // Phase 2-B2: 指定模式单一签收人，跳过比例分配
      if (signerPerson) {
        signPlan = {
          totalPages,
          assignments: Array(totalPages).fill(signerPerson),
          counts: { [signerPerson]: totalPages },
        };
        this.logger.info(`指定模式单一签收人: ${signerPerson}，共${totalPages}页`);
      } else {
        signPlan = generateSignPlan(totalPages);
        this.logger.info('\n' + formatSignPlanLog(signPlan));
      }

      const reportBuilder = new ExecutionReportBuilder(totalPages, this.dryRunMode);

      // Phase 9-dryrun: 试运行模式下也处理全部页面，但每页在最终确认前阻断
      const pagesToProcess = totalPages;

      for (let i = 0; i < pagesToProcess; i++) {
        const pageSigner = signPlan.assignments[i] ?? DEFAULT_SIGNER;
        let pageNum = i + 1;

        try {
          if (i > 0) {
            this.logger.setContext({ action: '翻页' });
            const hasNext = await this.pagination.nextPage();
            if (!hasNext) {
              this.logger.warn(`无法翻到第 ${i + 1} 页，终止流程`);
              break;
            }
            pageNum = await this.pagination.getCurrentPage();
          }

          this.logger.setContext({ pageNum, signer: pageSigner, action: '签收' });
          this.logger.info(`开始处理第 ${pageNum} 页 (Signer=${pageSigner})${this.dryRunMode ? ' [试运行模式]' : ''}`);

          const pageResult = await this.executePageSign(pageSigner);
          pageResults.push(pageResult);

          if (pageResult.selectedCount === 0) {
            reportBuilder.recordSkip();
            this.logger.info(`第 ${pageNum} 页无订单，已跳过`);
          } else {
            reportBuilder.recordSuccess(pageSigner, pageResult.selectedCount);
            totalSelected += pageResult.selectedCount;
            this.logger.success(`第 ${pageNum} 页处理完成${this.dryRunMode ? '（试运行，已跳过最终确认）' : ''}`);
          }

          await page_wait(1000);
        } catch (pageErr) {
          const errMsg = (pageErr as Error).message;
          this.logger.setContext({ pageNum, signer: pageSigner, action: '签收异常' });
          this.logger.error(`第 ${pageNum} 页执行失败: ${errMsg}`);

          let screenshot: string | undefined;
          try {
            screenshot = await captureSignFailureScreenshot(this.page, {
              pageNum,
              signer: pageSigner,
              label: 'error',
            });
          } catch {
            // 截图失败不再抛出
          }

          reportBuilder.recordError({
            pageNum,
            signer: pageSigner,
            message: errMsg,
            screenshot,
          });

          pageResults.push({
            pageNum,
            signer: pageSigner,
            selectedCount: 0,
            orderNumbers: [],
            dryRun: this.dryRunMode,
            error: errMsg,
            screenshot,
          });

          this.logger.error(`流程终止于第 ${pageNum} 页`);
          break;
        }
      }

      report = reportBuilder.build();
    } catch (flowErr) {
      const errMsg = (flowErr as Error).message;
      this.logger.setContext({ action: '流程异常' });
      this.logger.error(`批量流程异常: ${errMsg}`);

      let screenshot: string | undefined;
      try {
        screenshot = await captureSignFailureScreenshot(this.page, {
          pageNum: 0,
          label: 'flow_error',
        });
      } catch {
        // 截图失败不再抛出
      }

      const fallbackBuilder = new ExecutionReportBuilder(totalPages || 0, this.dryRunMode);
      for (const r of pageResults) {
        if (r.error) {
          fallbackBuilder.recordError({ pageNum: r.pageNum, signer: r.signer, message: r.error, screenshot: r.screenshot });
        } else if (r.selectedCount === 0) {
          fallbackBuilder.recordSkip();
        } else {
          fallbackBuilder.recordSuccess(r.signer, r.selectedCount);
        }
      }
      fallbackBuilder.recordError({ pageNum: 0, signer: '-', message: errMsg, screenshot });
      report = fallbackBuilder.build();
    }

    this.logger.resetContext();
    this.logger.info(`批量流程完成: 成功 ${report.successPages} 页，失败 ${report.failedPages} 页，选中 ${report.totalSelected} 条`);
    this.logger.info(`PERF executeBatchFlow total ${Date.now() - flowStart}ms`);
    this.logger.info('\n' + formatExecutionReport(report));

    return {
      totalPages: report.totalPages,
      totalSelected: report.totalSelected,
      pageResults,
      signPlan,
      dryRun: this.dryRunMode,
      report,
    };
  }

  private async clickBatchSignButton(): Promise<void> {
    const label = 'clickBatchSignButton';
    this.logger.info('点击批量签收');

    await retry(async () => {
      await this.waitForPageReady();
      await this.page.click(SIGN_SELECTORS.batchSignButton, { timeout: TIMEOUT_BUTTON });

      await this.page.waitForSelector(SIGN_SELECTORS.signDialog, {
        state: 'visible',
        timeout: TIMEOUT_DIALOG,
      });
      await page_wait(DIALOG_SETTLE);
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    this.logger.info('签收弹窗已打开');
  }

  private async selectSignerInDialog(signer: string): Promise<void> {
    const label = 'selectSignerInDialog';
    this.logger.info(`选择签收人: ${signer}`);

    await retry(async () => {
      const dialogLoc = this.page.locator(SIGN_SELECTORS.signDialog).first();

      await dialogLoc.locator(SIGN_SELECTORS.signerSelectInput).first().click({ timeout: TIMEOUT_ELEMENT });
      await page_wait(500);

      const optSel = SIGN_SELECTORS.signerOptionTpl.replace('${signerName}', signer);
      const optLoc = this.page.locator(optSel);
      const optCount = await optLoc.count();

      if (optCount === 0) {
        throw new Error(`签收人列表中未找到"${signer}"选项`);
      }

      // 使用 evaluate 原生点击绕过 CSS 动画导致的视口外问题
      const clicked = await this.page.evaluate((name) => {
        const items = document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item');
        for (const item of items) {
          if ((item.textContent ?? '').trim() === name) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, signer);

      if (!clicked) {
        throw new Error(`无法点击签收人选项: ${signer}`);
      }
      await page_wait(500);
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    this.logger.info(`签收人已选择: ${signer}`);
  }

  private async confirmSignInDialog(): Promise<void> {
    const label = 'confirmSignInDialog';
    this.logger.info('确认签收');

    await retry(async () => {
      const dialogLoc = this.page.locator(SIGN_SELECTORS.signDialog).first();
      await dialogLoc.locator(SIGN_SELECTORS.dialogConfirmBtn).first().click({ timeout: TIMEOUT_BUTTON });
      await page_wait(1000);
      await waitForLoadingHidden(this.page);
    }, MAX_RETRIES, label, this.adapterScopedLog(), this.page);

    this.logger.success('签收已提交');
  }

  private adapterScopedLog(): LogFn {
    return (level, msg) => {
      if (level === 'error') this.logger.error(msg);
      else if (level === 'warning') this.logger.warn(msg);
      else this.logger.info(msg);
    };
  }
}
