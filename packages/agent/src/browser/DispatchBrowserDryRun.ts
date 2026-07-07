/**
 * DispatchBrowserDryRun — 派件扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行派件扫描页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/dispatchScan.selectors.ts
 * 交互顺序来源：
 *   backend/operations/DispatchScan.ts:126-185 processOneBatch
 *
 * 硬性边界：
 *   - 禁止点击"上传"按钮（最终提交）
 *   - 禁止点击"添加"按钮（spec 白名单只允许查询/搜索/检索）
 *   - 只输入运单到 waybillInput，检测元素，不产生真实业务
 *   - 不处理真实生产单号
 */

import type { Locator, Page } from 'playwright-core';
import { detectDispatchPage, type DispatchPageDetectResult } from './DispatchPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { DISPATCH_SCAN_SELECTORS, DISPATCH_TABLE_ROW_SELECTOR } from './dispatchSelectors';
import {
  navigateToBusinessPageMenuFirst,
  afterPageChangedCleanup,
  type AgentRuntimeLogFn,
  type AgentRuntimeMeta,
} from './AgentBusinessRuntime';

export interface DispatchBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    staffName?: string;

    /** 派件员姓名（用于下拉框文本匹配选择） */
    courierName?: string;
  };
  /** Phase K-2E: Agent 运行时日志函数（可选） */
  log?: AgentRuntimeLogFn;
  /** Phase K-2E: Agent 运行时元数据（可选） */
  meta?: AgentRuntimeMeta;
}

export interface DispatchBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  successCount: number;
  failedCount: number;
  addResults: DispatchAddWaybillResult[];
  courierSelected: boolean;
  clickedButton: 'none' | 'search';
  finalSubmitClicked: false;
  detectBefore: DispatchPageDetectResult | null;
  detectAfter: DispatchPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
}

interface DispatchAddWaybillResult {
  waybillNo: string;
  success: boolean;
  reason: 'added_to_table' | 'message' | 'no_response' | 'input_verify_failed' | 'click_failed';
  message: string;
  durationMs: number;
  countBefore: number;
  countAfter: number;
}

interface WaybillInputRef {
  locator: Locator;
  method: string;
  index: number;
}

// 派件扫描页面 URL 兜底来源：PageStateManager.ts:19 DISPATCH_PAGE_ROUTE（由 AgentBusinessRuntime 内部使用）

// 禁止点击的按钮关键词（用于 assertNotFinalSubmit 安全保护）
const FORBIDDEN_BUTTON_KEYWORDS = [
  '上传', '提交', '确认', '批量', '派件', '签收', '保存', '完成', '执行', '到派',
];

/**
 * 硬性保护：检查按钮文本是否是最终提交按钮
 */
function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

/**
 * Phase I-4-Dispatch: 读取右侧分页 "共 N 条"。
 * 选择器优先级：el-pagination__total → 多级回退
 */
async function readDispatchRightTotal(page: Page): Promise<number | null> {
  const selectors = [
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_right > div > div.el-pagination.is-background > span.el-pagination__total',
    '.dispatchscan_right .el-pagination__total',
    '.dispatchscan_right span.el-pagination__total',
  ];
  for (const sel of selectors) {
    try {
      const text = await page.locator(sel).first().textContent({ timeout: 1000 }).catch(() => null);
      if (text) {
        const m = text.match(/共\s*(\d+)\s*条/);
        if (m) return parseInt(m[1], 10);
        const n = parseInt(text.replace(/\D/g, ''), 10);
        if (!isNaN(n)) return n;
      }
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Phase I-4-Dispatch: 日志截断 — 防止超长文本污染 task_logs。
 */
function formatDispatchLogValue(value: string, maxLen = 80): string {
  if (value.length <= maxLen) return value;
  return `len=${value.length} preview=${value.substring(0, maxLen)}...`;
}

/**
 * 执行派件扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 运单输入框：DISPATCH_SCAN_SELECTORS.waybillInput
 *   - 派件员下拉框：DISPATCH_SCAN_SELECTORS.courierSelectInput（仅检测）
 *   - 添加按钮：DISPATCH_SCAN_SELECTORS.addButton（仅检测，不点击）
 *   - 上传按钮：DISPATCH_SCAN_SELECTORS.uploadButton（仅检测，绝不点击）
 */
export async function runDispatchBrowserDryRun(
  page: Page,
  input: DispatchBrowserDryRunInput,
): Promise<DispatchBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options, log, meta } = input;
  const courierName = options?.courierName;

  const result: DispatchBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    successCount: 0,
    failedCount: 0,
    addResults: [],
    courierSelected: false,
    clickedButton: 'none',
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  console.log('  [Dispatch-DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [Dispatch-DRY-RUN] Dashboard P0 = READY');

  // 2. 进入派件扫描页面 —— Phase K-2E: 菜单优先导航（sidebar_first → sidebar_retry → url_fallback）
  console.log(`  [Dispatch-DRY-RUN] 菜单优先导航到派件扫描页面`);
  console.log(`  [Dispatch-DRY-RUN] 派件页面 URL 兜底来源: PageStateManager.ts:19 DISPATCH_PAGE_ROUTE`);
  const navResult = await navigateToBusinessPageMenuFirst(page, 'dispatch', log, meta);
  if (!navResult.success) {
    result.message = `派件页面导航失败: ${navResult.message}`;
    warnings.push(`导航方法: ${navResult.method}`);
    return result;
  }
  console.log(`  [Dispatch-DRY-RUN] 导航成功，方法: ${navResult.method}，URL: ${navResult.pageUrl}`);
  result.validationLogs.push(`导航方法: ${navResult.method}`);

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
  }
  console.log(`  [Dispatch-DRY-RUN] 页面已打开: ${result.pageUrl}`);

  // 3. 检测派件页面元素（输入前）
  console.log('  [Dispatch-DRY-RUN] 检测派件页面元素（输入前）...');
  const detectBefore = await detectDispatchPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [Dispatch-DRY-RUN] 是否派件页面: ${detectBefore.isDispatchPage}`);
  console.log(`  [Dispatch-DRY-RUN] 派件员下拉框: ${detectBefore.hasCourierSelectInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 运单输入框: ${detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 添加按钮: ${detectBefore.hasAddButton ? '已检测到（不点击）' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 上传按钮: ${detectBefore.hasUploadButton ? '已检测到（不点击）' : '未检测到'}`);

  // 4. 选派件员 —— el-select 下拉框，文本匹配 courierName
  //    选择器来源：dispatchSelectors.ts courierSelectInput / courierOption
  //    交互顺序来源：DispatchScan.ts:188-215 selectCourier
  //    ⚠️ 派件扫描的派件员选择是 el-select 下拉框（与到派一体的弹窗选择不同）
  //    ⚠️ 候选项是 li 元素，不是按钮，不触发 assertNotFinalSubmit
  let courierSelectSuccess = false;
  if (detectBefore.hasCourierSelectInput && courierName) {
    console.log(`  [Dispatch-DRY-RUN] 选派件员开始：${courierName}`);
    console.log(`  [Dispatch-DRY-RUN] 派件员下拉框选择器来源: dispatchScan.selectors.ts:27-28 courierSelectInput`);
    console.log(`  [Dispatch-DRY-RUN] 派件员候选项选择器来源: dispatchScan.selectors.ts:35-36 courierOption`);
    result.validationLogs.push(`选派件员开始：${courierName}`);
    try {
      courierSelectSuccess = await selectCourier(page, courierName);
      if (courierSelectSuccess) {
        result.courierSelected = true;
        console.log(`  [Dispatch-DRY-RUN] 派件员选择校验通过：${courierName}`);
        result.validationLogs.push(`派件员选择校验通过：${courierName}`);
      } else {
        console.log(`  [Dispatch-DRY-RUN] 派件员选择校验失败：未确认选中"${courierName}"`);
      }
    } catch (err) {
      console.log(`  [Dispatch-DRY-RUN] 派件员选择异常: ${(err as Error).message}`);
    }

    if (!courierSelectSuccess) {
      warnings.push(`派件员选择失败：未确认选中"${courierName}"`);
    }
  } else if (!courierName) {
    console.log(`  [Dispatch-DRY-RUN] 未提供 courierName，跳过派件员选择`);
    warnings.push('未提供派件员姓名，跳过派件员选择');
  }

  // 5. 逐条添加运单到页面表格（不点击最终上传）
  //    添加按钮只是加入表格，不是最终提交；上传按钮仍然禁止点击。
  //    Phase I-4-Dispatch: 快速输入模式，不监控 rowCount/loading/message
  let waybillInputSuccess = false;
  if (waybills.length > 0) {
    log?.('info', `[Agent][Dispatch][waybill] START count=${waybills.length}`, meta);
    try {
      const waybillInput = await findWaybillInput(page);
      console.log(`  [Dispatch-DRY-RUN] 单号输入框定位: method=${waybillInput.method}, index=${waybillInput.index}`);
      result.validationLogs.push(`单号输入框定位: method=${waybillInput.method}, index=${waybillInput.index}`);

      const batchResult = await addWaybillsOneByOne(page, waybillInput.locator, waybills, log, meta);
      result.addResults = batchResult.results;
      result.successCount = batchResult.results.filter(r => r.success).length;
      result.failedCount = batchResult.results.length - result.successCount;
      result.inputCount = batchResult.results.length;
      waybillInputSuccess = batchResult.results.length > 0;
      result.validationLogs.push(`添加完成: 成功${result.successCount}条, 失败${result.failedCount}条`);
    } catch (err) {
      log?.('error', `[Agent][Dispatch][waybill] ADD_BATCH_FAIL reason=${(err as Error).message}`, meta);
      warnings.push(`运单输入失败: ${(err as Error).message}`);
      console.log(`  [Dispatch-DRY-RUN] 运单输入异常: ${(err as Error).message}`);
    }
  }

  // 6. 输入前置校验：派件员 + 运单输入必须全部成功
  console.log('  [Dispatch-DRY-RUN] 输入前置校验开始...');
  const preInputChecks = {
    courier: courierSelectSuccess,
    waybill: waybillInputSuccess,
  };
  console.log(`  [Dispatch-DRY-RUN] 校验结果：派件员=${preInputChecks.courier}，运单=${preInputChecks.waybill}`);

  if (!preInputChecks.courier || !preInputChecks.waybill) {
    const failedParts: string[] = [];
    if (!preInputChecks.courier) failedParts.push('派件员选择');
    if (!preInputChecks.waybill) failedParts.push('运单输入');
    result.message = `输入前置校验失败：${failedParts.join('、')}未通过，已停止执行`;
    result.success = false;
    result.validationLogs.push(`输入校验失败，已停止执行，未点击上传`);
    console.log(`  [Dispatch-DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [Dispatch-DRY-RUN] 输入前置校验通过');
  result.validationLogs.push('输入前置校验通过');

  // 6. 安全检测添加按钮和上传按钮（仅检测，不点击）
  //    来源：dispatchScan.selectors.ts:43 addButton, :65 uploadButton
  console.log(`  [Dispatch-DRY-RUN] 添加按钮选择器来源: dispatchScan.selectors.ts:43 addButton（仅检测，不点击）`);
  console.log(`  [Dispatch-DRY-RUN] 上传按钮选择器来源: dispatchScan.selectors.ts:65 uploadButton（仅检测，不点击）`);
  result.validationLogs.push('已检测添加按钮（已用于加入表格，未点击最终上传）');
  result.validationLogs.push('已检测上传按钮（未点击）');
  result.validationLogs.push('已阻止最终提交');

  // 7. 再次检测页面元素（输入后）
  console.log('  [Dispatch-DRY-RUN] 检测派件页面元素（输入后）...');
  const detectAfter = await detectDispatchPage(page);
  result.detectAfter = detectAfter;

  // 8. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.clickedButton = 'none';

  // 9. 结果
  result.success = true;
  result.message = `派件扫描 DRY-RUN 完成：成功${result.successCount}条, 失败${result.failedCount}条，未点击上传按钮`;

  console.log(`  [Dispatch-DRY-RUN] ${result.message}`);
  return result;
}

async function findWaybillInput(page: Page): Promise<WaybillInputRef> {
  const candidates = page.locator(
    '.dispatchscan_left input:not([type="hidden"]):not([disabled]):not([readonly]), .dispatchscan_left textarea:not([disabled]):not([readonly])'
  );
  const count = await candidates.count();

  for (let i = 0; i < count; i++) {
    const loc = candidates.nth(i);
    if (!(await loc.isVisible().catch(() => false))) continue;
    if (!(await loc.isEnabled().catch(() => false))) continue;

    const isSelectInput = await loc.evaluate((el) => {
      const input = el as HTMLInputElement;
      const className = (input.className || '').toString();
      return input.readOnly || !!input.closest('.el-select') || className.includes('el-select');
    }).catch(() => false);
    if (isSelectInput) continue;

    return { locator: loc, method: 'dispatch_left_non_select_input', index: i };
  }

  const fallback = page.locator(DISPATCH_SCAN_SELECTORS.waybillInput).first();
  if ((await fallback.count().catch(() => 0)) > 0 && await fallback.isVisible().catch(() => false)) {
    return { locator: fallback, method: 'legacy_waybill_selector', index: 0 };
  }

  throw new Error('未找到可用的单号输入框');
}

async function fillWaybillValue(input: Locator, waybillNo: string): Promise<boolean> {
  // Phase I-4-Dispatch: 移除冗余 fill('')，Playwright fill() 内部已先清空
  await input.fill(waybillNo, { timeout: 1500 });
  let value = await input.inputValue({ timeout: 500 }).catch(() => '');
  if (value === waybillNo) return true;

  // 兜底：逐字符 type
  await input.click({ timeout: 1000 });
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
  await input.press('Backspace').catch(() => {});
  await input.type(waybillNo, { delay: 0, timeout: 2000 });
  value = await input.inputValue({ timeout: 500 }).catch(() => '');
  return value === waybillNo;
}

async function getDispatchRowCount(page: Page): Promise<number> {
  return page.locator(DISPATCH_TABLE_ROW_SELECTOR).count().catch(() => 0);
}

async function clickAddButton(page: Page): Promise<void> {
  const addButton = page.locator(DISPATCH_SCAN_SELECTORS.addButton).first();
  const text = ((await addButton.textContent().catch(() => '')) || '').trim();
  assertNotFinalSubmit(text);
  await addButton.click({ timeout: 500, noWaitAfter: true }).catch(async () => {
    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('.dispatchscan_left button.el-button--primary') as HTMLButtonElement | null;
      if (!btn || btn.disabled || btn.classList.contains('is-disabled')) return false;
      btn.click();
      return true;
    }).catch(() => false);
    if (!clicked) {
      await addButton.click({ timeout: 500, force: true, noWaitAfter: true });
    }
  });
}

/**
 * Phase I-4-Dispatch: 快速添加单号 — fill → click → 150ms → 完成。
 * 5000ms Promise.race 超时兜底，彻底消除 page.evaluate Promise 卡死风险。
 * 不监控 rowCount / loading / error message。
 */
async function addWaybill(
  page: Page,
  input: Locator,
  waybillNo: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<DispatchAddWaybillResult> {
  const started = Date.now();
  const ADD_PER_ITEM_TIMEOUT = 5000;

  try {
    return await Promise.race([
      (async (): Promise<DispatchAddWaybillResult> => {
        const filled = await fillWaybillValue(input, waybillNo);
        if (!filled) {
          return {
            waybillNo, success: false, reason: 'input_verify_failed',
            message: '输入值校验失败', durationMs: Date.now() - started,
            countBefore: 0, countAfter: 0,
          };
        }
        await clickAddButton(page);
        await page.waitForTimeout(150);
        return {
          waybillNo, success: true, reason: 'added_to_table',
          message: '已添加', durationMs: Date.now() - started,
          countBefore: 0, countAfter: 0,
        };
      })(),
      new Promise<DispatchAddWaybillResult>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), ADD_PER_ITEM_TIMEOUT)
      ),
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    log?.('error', `[Agent][Dispatch][waybill] FAST_ADD_FAIL waybillNo=${waybillNo} reason=${msg}`, meta);
    return {
      waybillNo, success: false,
      reason: msg === 'TIMEOUT' ? 'no_response' : 'click_failed',
      message: msg === 'TIMEOUT' ? `单号添加超时(${ADD_PER_ITEM_TIMEOUT}ms)` : `添加失败: ${msg}`,
      durationMs: Date.now() - started, countBefore: 0, countAfter: 0,
    };
  }
}

/**
 * Phase I-4-Dispatch: 快速批量添加 — TOTAL_BEFORE → 逐条快速添加 → TOTAL 汇总。
 * 不监控 rowCount / loading / error message / 连续 no_response。
 * 5000ms 单条超时兜底。
 */
async function addWaybillsOneByOne(
  page: Page,
  input: Locator,
  waybills: string[],
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<{ results: DispatchAddWaybillResult[]; beforeTotal: number | null; afterTotal: number | null }> {
  const beforeTotal = await readDispatchRightTotal(page);
  log?.('info', `[Agent][Dispatch][waybill] TOTAL_BEFORE pageTotal=${beforeTotal ?? '?'} count=${waybills.length}`, meta);

  const results: DispatchAddWaybillResult[] = [];
  const batchStart = Date.now();
  const timings: number[] = [];

  for (let i = 0; i < waybills.length; i++) {
    const waybill = waybills[i];
    const result = await addWaybill(page, input, waybill, log, meta);
    results.push(result);
    timings.push(result.durationMs);
    log?.('info', `[Agent][Dispatch][waybill] FAST_ADD index=${i + 1}/${waybills.length} waybillNo=${waybill} durationMs=${result.durationMs}`, meta);
  }

  await page.waitForTimeout(300);
  const afterTotal = await readDispatchRightTotal(page);
  const totalDuration = Date.now() - batchStart;
  const avgMs = timings.length > 0 ? Math.round(timings.reduce((a, b) => a + b, 0) / timings.length) : 0;
  const attempted = results.length;
  const actualAdded = afterTotal !== null && beforeTotal !== null ? afterTotal - beforeTotal : null;

  log?.('info', `[Agent][Dispatch][waybill] TOTAL attempted=${attempted} beforeTotal=${beforeTotal ?? '?'} afterTotal=${afterTotal ?? '?'} actualAdded=${actualAdded ?? '?'} durationMs=${totalDuration} avgMs=${avgMs}`, meta);
  console.log(`  [Dispatch-DRY-RUN] 单号汇总: attempted=${attempted} beforeTotal=${beforeTotal ?? '?'} afterTotal=${afterTotal ?? '?'} actualAdded=${actualAdded ?? '?'} durationMs=${totalDuration} avgMs=${avgMs}`);

  return { results, beforeTotal, afterTotal };
}

// ══════════════════════════════════════════════════════════
// 选派件员 —— el-select 下拉框，文本匹配 courierName
//
// 严格遵循旧代码 DispatchScan.ts:188-215 selectCourier 原样逻辑：
//   1. Playwright .click() 点击派件员下拉框 input（触发 el-select 展开浮层）
//   2. 等 500ms 浮层动画
//   3. 文本匹配候选项（li.el-select-dropdown__item，:visible 过滤当前可见浮层）
//   4. 点击匹配的候选项
//   5. 等 500ms 选择动画
//   6. 验证：派件员 input.value 包含 courierName
//
// ⚠️ 派件扫描的派件员选择是 el-select 下拉框，与到派一体的弹窗选择不同：
//   - 派件扫描：el-select 下拉框，文本匹配 staffName → 点击 li 候选项
//   - 到派一体：点击 input 触发"选择派件员"弹窗 → 表格按 employeeId 匹配 → 点击"使用"按钮
//
// 选择器来源：
//   - courierSelectInput: dispatchSelectors.ts（来源 dispatchScan.selectors.ts:27-28）
//   - courierOption: dispatchSelectors.ts（来源 dispatchScan.selectors.ts:35-36）
//     ${staffName} 为运行时替换占位符
// ══════════════════════════════════════════════════════════

async function selectCourier(
  page: Page,
  courierName: string,
): Promise<boolean> {
  const started = Date.now();
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(100);
      const inputLoc = await findCourierSelectInput(page);
      const openedBy = await clickCourierSelectInput(page, inputLoc);
      if (attempt === 1) {
        console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 派件员下拉框打开方式=${openedBy}`);
        console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 目标派件员=${courierName}`);
      }
      await waitForVisibleSelectDropdown(page, 2500);

      const choice = await chooseCourierOption(page, courierName);
      const finalChoice = choice.clicked ? choice : await filterAndChooseCourierOption(page, inputLoc, courierName);
      if (!finalChoice.clicked) {
        console.log(`  [Dispatch-DRY-RUN] 派件员候选项未命中：${courierName}`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(200);
        continue;
      }

      if (finalChoice.matchType === 'substring') {
        console.log(`  [Dispatch-DRY-RUN] 派件员精确匹配失败，使用子串匹配: "${finalChoice.selectedText}" vs "${courierName}"`);
      }

      const verified = await verifyCourierSelected(page, inputLoc, courierName);
      if (verified) {
        const elapsed = Date.now() - started;
        if (elapsed > 3000) {
          console.log(`  [Dispatch-DRY-RUN] 派件员选择偏慢: ${elapsed}ms`);
        }
        return true;
      }

      const diagnostics = await getCourierSelectDiagnostics(page, inputLoc);
      console.log(`  [Dispatch-DRY-RUN] 派件员校验失败（第 ${attempt} 次），input="${diagnostics.inputValue}"，候选=${JSON.stringify(diagnostics.visibleOptions.slice(0, 20))}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    } catch (err) {
      console.log(`  [Dispatch-DRY-RUN] 派件员选择第 ${attempt} 次异常: ${(err as Error).message}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  return false;
}

async function findCourierSelectInput(page: Page): Promise<Locator> {
  const preferred = page.locator('.dispatchscan_left .el-select input:not([disabled])');
  const count = await preferred.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const loc = preferred.nth(i);
    if (await loc.isVisible().catch(() => false)) {
      return loc;
    }
  }

  const legacy = page.locator(DISPATCH_SCAN_SELECTORS.courierSelectInput).first();
  if ((await legacy.count().catch(() => 0)) > 0 && await legacy.isVisible({ timeout: 800 }).catch(() => false)) {
    return legacy;
  }
  throw new Error('未找到派件员 el-select input');
}

async function filterAndChooseCourierOption(
  page: Page,
  inputLoc: Locator,
  courierName: string,
): Promise<{ clicked: boolean; selectedText: string; matchType: 'exact' | 'substring' | 'none' }> {
  // Phase K-Final-R1-Fix-A: 移除 readonly input 的 fill+Enter 兜底
  // 改为：重新点击 input → 等 popper → 再次搜索候选项
  console.log(`  [Dispatch-DRY-RUN] 派件员可见候选未命中，重新点击 input 重试: ${courierName}`);
  await inputLoc.click({ timeout: 5000 }).catch(() => {});
  try {
    await waitForVisibleSelectDropdown(page, 3000);
  } catch {
    return { clicked: false, selectedText: '', matchType: 'none' };
  }
  return chooseCourierOption(page, courierName);
}

async function clickCourierSelectInput(page: Page, inputLoc: Locator): Promise<string> {
  try {
    await inputLoc.click({ timeout: 5000 });
    return 'input_click';
  } catch (inputErr) {
    const wrapper = inputLoc.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]');
    try {
      await wrapper.click({ timeout: 5000 });
      return 'select_wrapper_click';
    } catch {
      const labelledWrapper = page
        .locator('.dispatchscan_left .el-form-item:has(label:has-text("派件员")) .el-select')
        .first();
      if ((await labelledWrapper.count().catch(() => 0)) > 0 && await labelledWrapper.isVisible().catch(() => false)) {
        await labelledWrapper.click({ timeout: 5000 });
        return 'labelled_wrapper_click';
      }
      await inputLoc.click({ timeout: 5000, force: true });
      console.log(`  [Dispatch-DRY-RUN] 派件员 input 普通点击失败，使用 force 兜底: ${(inputErr as Error).message}`);
      return 'input_force_click';
    }
  }
}

async function chooseCourierOption(
  page: Page,
  courierName: string,
): Promise<{ clicked: boolean; selectedText: string; matchType: 'exact' | 'substring' | 'none' }> {
  // Phase K-Final-R1-Fix-A: 先显式等待 popper 出现，再在候选项列表中搜索
  try {
    await waitForVisibleSelectDropdown(page, 3000);
  } catch {
    return { clicked: false, selectedText: '', matchType: 'none' };
  }

  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    const result = await page.evaluate((name: string) => {
      const visibleItems: HTMLElement[] = [];
      const poppers = document.querySelectorAll('div.el-select-dropdown.el-popper');
      let activePopper: HTMLElement | null = null;
      for (const popper of poppers) {
        const html = popper as HTMLElement;
        const ps = window.getComputedStyle(html);
        const pr = html.getBoundingClientRect();
        if (ps.display === 'none' || ps.visibility === 'hidden' || pr.width === 0 || pr.height === 0) continue;
        activePopper = html;
      }
      if (!activePopper) return { clicked: false, selectedText: '', matchType: 'none' as const };
      const items = activePopper.querySelectorAll('li.el-select-dropdown__item');
      for (const item of items) {
        const html = item as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
          if (style.display !== 'none' && style.visibility !== 'hidden' && rect.height > 0) {
            visibleItems.push(html);
          }
      }

      const texts = visibleItems.map(item => ({ item, text: (item.textContent || '').trim() }));
      const exact = texts.find(entry => entry.text === name);
      if (exact) {
        exact.item.click();
        return { clicked: true, selectedText: exact.text, matchType: 'exact' as const };
      }
      const contains = texts.find(entry => entry.text.includes(name));
      if (contains) {
        contains.item.click();
        return { clicked: true, selectedText: contains.text, matchType: 'substring' as const };
      }
      return { clicked: false, selectedText: '', matchType: 'none' as const };
    }, courierName).catch(() => ({ clicked: false, selectedText: '', matchType: 'none' as const }));

    if (result.clicked) return result;
    await page.waitForTimeout(100);
  }

  return { clicked: false, selectedText: '', matchType: 'none' };
}

/**
 * 校验派件员是否成功选中
 *
 * el-select 选中后，input.value 应为选中的文本（即 courierName）。
 * 部分场景下 input.value 为空但 li.el-select-dropdown__item 有 selected 类。
 *
 * 校验策略：
 *   1. 读取 input.value，若包含 courierName → 通过
 *   2. 否则查找 li.el-select-dropdown__item.selected，若文本包含 courierName → 通过
 *   3. 否则失败
 */
async function verifyCourierSelected(page: Page, inputLoc: Locator, courierName: string): Promise<boolean> {
  try {
    // 1. 读取 input.value
    const verified = await page.waitForFunction(
      ({ expected }) => {
        const active = document.activeElement as HTMLInputElement | null;
        const candidates = Array.from(document.querySelectorAll('.dispatchscan_left .el-select input')) as HTMLInputElement[];
        if (active?.value?.includes(expected)) return true;
        return candidates.some(input => input.value.includes(expected));
      },
      { expected: courierName },
      { timeout: 1500, polling: 80 },
    ).then(() => true).catch(() => false);
    const inputValue = await inputLoc.inputValue().catch(() => '');
    if (inputValue.includes(courierName)) {
      const matchType = inputValue.trim() === courierName.trim() ? 'exact' : 'substring';
      console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 目标派件员=${courierName}，页面派件员=${inputValue}，匹配=true，matchType=${matchType}`);
      return true;
    }
    if (verified) {
      const fallback = await page.evaluate((expected: string) => {
        const candidates = Array.from(document.querySelectorAll('.dispatchscan_left .el-select input')) as HTMLInputElement[];
        return candidates.map(input => input.value).find(value => value.includes(expected)) || '';
      }, courierName).catch(() => '');
      if (fallback) {
        console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 目标派件员=${courierName}，页面派件员=${fallback}，匹配=true，matchType=fallback`);
        return true;
      }
    }

    // 2. 检查 li.el-select-dropdown__item.selected
    const selectedText = await page.evaluate((search: string) => {
      const poppers = document.querySelectorAll('div.el-select-dropdown.el-popper');
      for (const popper of poppers) {
        const ws = window.getComputedStyle(popper as HTMLElement);
        if (ws.display === 'none') continue;
        const selectedItems = popper.querySelectorAll('li.el-select-dropdown__item.selected');
        for (const item of selectedItems) {
          const text = (item.textContent || '').trim();
          if (text.includes(search)) return text;
        }
      }
      return '';
    }, courierName).catch(() => '');

    if (selectedText.includes(courierName)) {
      const matchType = selectedText.trim() === courierName.trim() ? 'exact' : 'substring';
      console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 目标派件员=${courierName}，页面派件员(selected)=${selectedText}，匹配=true，matchType=${matchType}`);
      return true;
    }

    console.log(`  [Dispatch-DRY-RUN] [Agent][Dispatch] 目标派件员=${courierName}，页面派件员=${inputValue}，匹配=false`);
    return false;
  } catch {
    return false;
  }
}

async function waitForVisibleSelectDropdown(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    return poppers.some((popper) => {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
  }, {}, { timeout: timeoutMs, polling: 80 });
}

async function getCourierSelectDiagnostics(page: Page, inputLoc: Locator): Promise<{ inputValue: string; visibleOptions: string[] }> {
  const inputValue = await inputLoc.inputValue().catch(() => '');
  const visibleOptions = await page.evaluate(() => {
    const result: string[] = [];
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    for (const popper of poppers) {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
      const items = Array.from(popper.querySelectorAll('li.el-select-dropdown__item'));
      for (const item of items) {
        const text = (item.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) result.push(text);
      }
    }
    return result;
  }).catch(() => []);
  return { inputValue, visibleOptions };
}
