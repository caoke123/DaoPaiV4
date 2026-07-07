// 派件扫描操作模块（批次模型 + 多窗口并发）
// 架构：与到件扫描相同的批次模型（逐个添加构建表格 → 200条/页 → 全选 → 上传 → 批次级toast四态判定）
// 区别：派件用员工账号(staff)、多窗口并发、逐个点"添加"构建表格、上传按钮提交
//
// ⚠️ 安全开关 DISPATCH_SCAN_DRY_RUN：true=跳过真实点击上传，false=真实提交
// 开发期间默认 true，生产上线前可 dry-run 验证
import type { Page } from 'playwright';
import { waitForToast, takeScreenshot, captureFailureScreenshot } from '../browser/PageNavigator';
import { fastStableBypassClick } from '../browser/ClickHelper';
import type { OperationResult } from './BaseOperation';
import type { LogContext } from '../utils/TaskLogManager';
import { DISPATCH_SCAN_SELECTORS, DISPATCH_TABLE_ROW_SELECTOR } from './selectors/dispatchScan.selectors';
import { parseDispatchScanResult } from './dispatchScanResult';
import { SettingsManager } from '../config/SettingsManager';
import { BusinessPageNavigator } from '../browser/BusinessPageNavigator';
import { verifyBusinessPageReady } from './businessPageReady';

// 系统限制：每次最多处理 200 条
const MAX_BATCH_SIZE = 200;

// 超时配置
const TIMEOUT_ELEMENT = 10000;      // 页面元素
const TIMEOUT_BUTTON = 3000;        // 按钮点击
const TIMEOUT_TOAST = 10000;        // toast 等待

// 间隔配置
const BATCH_INTERVAL = 2000;        // 批次间间隔
const ADD_INTERVAL = 150;           // 添加单条间隔
const NAV_SETTLE = 1500;            // 导航后稳定等待
const SLOW_STEP_MS = 1500;           // 超过该耗时的子步骤输出 warning

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void;

/** Phase 5-G-8: PERF 计时包装 */
async function timedStep<T>(
  log: LogFn,
  batchLabel: string,
  label: string,
  fn: () => Promise<T>,
  warnAfterMs = SLOW_STEP_MS,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - start;
    const level = elapsed >= warnAfterMs ? 'warning' : 'info';
    log(level, `[${batchLabel}] PERF ${label} ${elapsed}ms`);
  }
}

/** 派件任务分配（每个员工一组运单） */
export interface DispatchAssignment {
  staffName: string;
  waybillNos: string[];
  /** Phase 2-B: 指定模式 — 入参透传 */
  executionMode?: 'default' | 'designated';
  targetCourierName?: string;
  targetCourierAccount?: string;
}

/** Fatal Error：派件员选择失败，终止该批次（不终止整个员工，继续下一批） */
class FatalDispatchError extends Error {
  constructor(staffName: string, batchLabel: string) {
    super(`[${batchLabel}][员工:${staffName}] [FATAL] 派件员选择失败，本批终止`);
    this.name = 'FatalDispatchError';
  }
}

/**
 * 单员工处理：按 200 一组分批，每批重新导航+选派件员
 *
 * Phase D-1: 导出供 DispatchHandler 调用（Engine 负责锁/连接/进度，此函数仅处理业务）
 * @param dryRunMode 试运行模式：true=跳过最终提交按钮（Phase 9-dryrun 全局开关）
 */
export async function executeOneStaff(
  page: Page,
  assignment: DispatchAssignment,
  log: LogFn,
  taskId?: string,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  const { staffName, waybillNos, targetCourierName, targetCourierAccount, executionMode } = assignment;
  const staffLabel = `员工:${staffName}`;
  // Phase 2-B2: 指定模式下使用目标派件员姓名选择派件员，默认模式回退 staffName
  const effectiveCourierName = targetCourierName || staffName;
  if (executionMode === 'designated') {
    const accountMsg = targetCourierAccount ? ` / ${targetCourierAccount}` : '（账号未知，按姓名匹配）';
    log('info', `[${staffLabel}] 派件扫描使用目标派件员：${effectiveCourierName}${accountMsg}`);
  }
  const batches = chunkArray(waybillNos, MAX_BATCH_SIZE);
  log('info', `[${staffLabel}] 共${waybillNos.length}条, 分${batches.length}批`);

  const staffResults: OperationResult[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchLabel = `${staffLabel} 批次 ${batchIdx + 1}/${batches.length}`;

    try {
      const batchResults = await processOneBatch(page, staffName, effectiveCourierName, batch, batchIdx, batches.length, log, dryRunMode);
      staffResults.push(...batchResults);
    } catch (err) {
      // Phase G-2: 失败自动截图（默认ENABLE_RUNTIME_SCREENSHOTS=0关闭，开启时才会保存）
      if (taskId) {
        await captureFailureScreenshot(page, taskId, `dispatch_${staffName}_batch${batchIdx + 1}`).catch(() => '');
      }

      log('error', `[${batchLabel}] 批次失败: ${(err as Error).message}`);
      const failResults: OperationResult[] = batch.map(no => ({
        waybillNo: no,
        staffName,
        success: false,
        message: (err as Error).message,
        timestamp: Date.now(),
        status: 'FAILED',
      }));
      staffResults.push(...failResults);
    }

    // 批次间等待
    if (batchIdx < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
    }
  }

  log('info', `[${staffLabel}] 完成 ${waybillNos.length} 条`);
  return staffResults;
}

/**
 * 处理单批：导航 → 选派件员 → 逐个添加 → 设200/页 → 全选 → [DRY-RUN]上传 → toast判定
 *
 * 每批都重新走完整流程，不复用上一批页面状态：
 * a. 导航到派件扫描页面
 * b. 轻量页面验证
 * c. 选择派件员（失败 throw FatalDispatchError）
 * d. 逐个添加运单（对比表格行数检测成功/失败）
 * e. 无成功添加则跳过上传
 * f. 设200条/页 + 全选 + [DRY-RUN]上传 + toast判定
 * g. 合并添加失败 + 上传结果
 */
async function processOneBatch(
  page: Page,
  staffName: string,
  courierName: string,
  batch: string[],
  batchIdx: number,
  totalBatches: number,
  log: LogFn,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  const batchLabel = `员工:${staffName} 批次 ${batchIdx + 1}/${totalBatches}`;
  const batchStart = Date.now();

  // a. 每批重新导航到派件扫描页面
  // Phase 5-G-8-4: 统一使用 BusinessPageNavigator（ensureCleanHome + URL优先 + 重试 + 侧边栏兜底）
  log('info', `[${batchLabel}] 导航到派件扫描页面`);
  const businessNav = BusinessPageNavigator.getInstance();
  const navResult = await timedStep(log, batchLabel, 'navigateToBusinessPage(dispatch)', () =>
    businessNav.navigateToBusinessPage(page, 'dispatch', {
      staffName,
      log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
    }),
  );
  if (!navResult.success) {
    throw new Error(`[${batchLabel}] 导航失败: ${navResult.error ?? '未知错误'}`);
  }
  log('info', `[${batchLabel}] 导航结果: method=${navResult.method}, duration=${navResult.durationMs}ms`);

  const ready = await timedStep(log, batchLabel, 'verifyBusinessPageReady(dispatch)', () =>
    verifyBusinessPageReady(page, 'dispatch', batchLabel, log),
  );
  if (!ready.ready) {
    throw new Error(`[${batchLabel}] 页面轻量验证未通过: missing=${ready.missing.join(',') || '-'}, popupVisible=${ready.popupVisible}`);
  }

  log('info', `[${batchLabel}] Page Ready (URL=${ready.url})`);
  await takeScreenshot(page, `${batchLabel}_page_ready`);

  // c. 选择派件员（失败 throw FatalDispatchError）
  await timedStep(log, batchLabel, 'selectCourier', () =>
    selectCourier(page, courierName, batchLabel, log),
  );

  // d. 逐个添加运单，检测添加成功/失败
  const { addedWaybills, addFailures } = await timedStep(log, batchLabel, 'addWaybillsOneByOne', () =>
    addWaybillsOneByOne(page, batch, staffName, batchLabel, log),
  );

  // e. 无成功添加则跳过上传
  if (addedWaybills.length === 0) {
    log('warning', `[${batchLabel}] 无运单添加成功，跳过上传`);
    log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
    return addFailures;
  }

  // f. 设200条/页 + 全选 + [DRY-RUN]上传 + toast判定
  await setPageSize200(page, batchLabel, log);
  await selectAll(page, batchLabel, log);

  const uploadResults = await timedStep(log, batchLabel, 'uploadAndJudge', () =>
    uploadAndJudge(page, addedWaybills, staffName, batchLabel, log, dryRunMode),
  );

  // g. 合并添加失败 + 上传结果
  log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
  return [...addFailures, ...uploadResults];
}

/**
 * 选择派件员（多策略查找 + 结果验证）
 * Phase 5-G-8-1: 重写为稳定版本，参考 IntegratedScan 的结果导向策略
 */
async function selectCourier(
  page: Page,
  courierName: string,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 选择派件员: ${courierName}`);

  // Step 1: 多策略定位派件员 input
  let courierInputLoc = page.locator(DISPATCH_SCAN_SELECTORS.courierSelectInput).first();
  let inputCount = await courierInputLoc.count().catch(() => 0);

  if (inputCount === 0) {
    log('warning', `[${batchLabel}] 语义选择器未找到派件员input，尝试getByLabel兜底`);
    courierInputLoc = page.getByLabel('派件员', { exact: false }).first();
    inputCount = await courierInputLoc.count().catch(() => 0);
  }

  if (inputCount === 0) {
    log('warning', `[${batchLabel}] getByLabel未找到，尝试.dispatchscan_left第一个el-select input兜底`);
    courierInputLoc = page.locator('.dispatchscan_left .el-select .el-input__inner').first();
    inputCount = await courierInputLoc.count().catch(() => 0);
  }

  if (inputCount === 0) {
    log('error', `[${batchLabel}] 打开派件员选择失败: 所有策略均未找到派件员input`);
    throw new FatalDispatchError(courierName, batchLabel);
  }

  // Step 2: 点击派件员input打开下拉
  try {
    await fastStableBypassClick(courierInputLoc, {
      log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
      label: 'dispatchCourierInput',
      timeoutMs: TIMEOUT_ELEMENT,
    });
    await page.waitForTimeout(400);
  } catch (e) {
    log('error', `[${batchLabel}] 点击派件员input失败: ${(e as Error).message}`);
    throw new FatalDispatchError(courierName, batchLabel);
  }

  // Step 3: 等待下拉浮层出现
  const dropdownLoc = page.locator('div.el-select-dropdown.el-popper:visible');
  try {
    await dropdownLoc.waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {
    log('warning', `[${batchLabel}] 下拉浮层未在5s内出现，重试点击: ${(e as Error).message}`);
    try {
      await courierInputLoc.click({ timeout: TIMEOUT_BUTTON, force: true });
      await page.waitForTimeout(500);
      await dropdownLoc.waitFor({ state: 'visible', timeout: 3000 });
    } catch (e2) {
      log('error', `[${batchLabel}] 打开派件员选择失败: 下拉浮层始终未出现: ${(e2 as Error).message}`);
      throw new FatalDispatchError(courierName, batchLabel);
    }
  }

  // Step 4: 文本匹配查找目标员工选项（精确匹配优先，子串兜底）
  const allOptions = dropdownLoc.locator('li.el-select-dropdown__item');
  const optionCount = await allOptions.count().catch(() => 0);
  log('info', `[${batchLabel}] 派件员下拉选项数: ${optionCount}`);

  if (optionCount === 0) {
    log('error', `[${batchLabel}] 未找到目标员工: 下拉选项为空`);
    throw new FatalDispatchError(courierName, batchLabel);
  }

  let matchedOption: any = null;
  let matchType = '';
  const optionTexts: string[] = [];

  for (let i = 0; i < optionCount; i++) {
    const opt = allOptions.nth(i);
    const optText = (await opt.textContent().catch(() => ''))?.trim() ?? '';
    if (optText) optionTexts.push(optText);
    if (optText === courierName) {
      matchedOption = opt;
      matchType = 'exact';
      break;
    }
  }

  if (!matchedOption) {
    for (let i = 0; i < optionCount; i++) {
      const opt = allOptions.nth(i);
      const optText = (await opt.textContent().catch(() => ''))?.trim() ?? '';
      if (optText.includes(courierName) || (optText.length >= 2 && courierName.includes(optText))) {
        matchedOption = opt;
        matchType = 'fuzzy';
        log('info', `[${batchLabel}] 派件员精确匹配失败，使用子串匹配: "${optText}" vs "${courierName}"`);
        break;
      }
    }
  }

  if (!matchedOption) {
    log('error', `[${batchLabel}] 未找到目标员工"${courierName}"。下拉选项: ${JSON.stringify(optionTexts.slice(0, 20))}`);
    throw new FatalDispatchError(courierName, batchLabel);
  }

  // Step 5: 稳定点击选项
  try {
    await fastStableBypassClick(matchedOption, {
      log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
      label: 'dispatchCourierOption',
      timeoutMs: TIMEOUT_BUTTON,
    });
    await page.waitForTimeout(500);
  } catch (e) {
    log('error', `[${batchLabel}] 点击派件员选项失败: ${(e as Error).message}`);
    throw new FatalDispatchError(courierName, batchLabel);
  }

  // Step 6: 验证 - 下拉浮层消失 + input回填
  let dropdownClosed = false;
  try {
    await dropdownLoc.waitFor({ state: 'hidden', timeout: 5000 });
    dropdownClosed = true;
  } catch {
    dropdownClosed = false;
  }

  const inputValue = await courierInputLoc.inputValue().catch(() => '');
  const nameInInput = inputValue.includes(courierName);

  if (dropdownClosed && nameInInput) {
    log('info', `[${batchLabel}] 派件员已选择: ${courierName} (match=${matchType}, input="${inputValue}")`);
  } else if (nameInInput) {
    log('warning', `[${batchLabel}] 派件员选择疑似成功(input已回填"${inputValue}"但下拉未完全关闭)，继续执行`);
  } else if (dropdownClosed) {
    log('warning', `[${batchLabel}] 下拉已关闭但input值="${inputValue}"未包含"${courierName}"，继续执行`);
  } else {
    log('error', `[${batchLabel}] input回填验证失败: 下拉未关闭且input值="${inputValue}"不含"${courierName}"`);
    throw new FatalDispatchError(courierName, batchLabel);
  }
}

/**
 * Phase 5-G-8-7: 精准定位派件扫描单号输入框
 *
 * 策略（按优先级）：
 *   1. 原语义选择器（label/placeholder 匹配）
 *   2. 兜底：.dispatchscan_left 内所有 input.el-input__inner，排除 el-select 内的（派件员下拉框）
 *   3. 再兜底：.dispatchscan_left 内所有可见 input.el-input__inner
 *
 * 返回 locator 和候选数量
 */
async function locateDispatchWaybillInput(
  page: Page,
  log: (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void,
  batchLabel: string,
): Promise<{ loc: import('playwright').Locator; count: number }> {
  // 策略 1: 原语义选择器
  let loc = page.locator(DISPATCH_SCAN_SELECTORS.waybillInput);
  let count = await loc.count().catch(() => 0);
  if (count > 0) {
    log('info', `[${batchLabel}] 单号输入框已定位（语义选择器），候选数量：${count}`);
    return { loc: loc.first(), count };
  }

  // 策略 2: 排除 el-select 内的 input
  log('warning', `[${batchLabel}] 语义选择器未命中，尝试排除 el-select 兜底定位`);
  const allInputs = page.locator('.dispatchscan_left input.el-input__inner');
  const totalInputs = await allInputs.count().catch(() => 0);
  for (let i = 0; i < totalInputs; i++) {
    const candidate = allInputs.nth(i);
    const isInsideSelect = await candidate.evaluate(el => {
      return !!el.closest('.el-select');
    }).catch(() => true);
    if (!isInsideSelect) {
      const isVisible = await candidate.isVisible().catch(() => false);
      if (isVisible) {
        log('info', `[${batchLabel}] 单号输入框已定位（排除 el-select 兜底），候选索引：${i}`);
        return { loc: candidate, count: 1 };
      }
    }
  }

  // 策略 3: 所有可见 input
  log('warning', `[${batchLabel}] 排除 el-select 后未找到，尝试所有可见 input 兜底`);
  const visibleInputs = page.locator('.dispatchscan_left input.el-input__inner:visible');
  const visibleCount = await visibleInputs.count().catch(() => 0);
  if (visibleCount > 0) {
    log('warning', `[${batchLabel}] 使用第 1 个可见 input（共 ${visibleCount} 个），可能不准确`);
    return { loc: visibleInputs.first(), count: visibleCount };
  }

  log('error', `[${batchLabel}] 单号输入框定位失败：所有策略均未找到可用 input`);
  return { loc: page.locator('.__not_found__'), count: 0 };
}

/**
 * Phase 5-G-8-7: 稳定填写派件扫描单号（优化版）
 *
 * 优化点：
 *   - 定位提到循环外，每批只定位一次
 *   - 去掉每条 drainNativeAlerts（NativeAlertGuard 已全局挂载）
 *   - 去掉冗余清空（fill() 本身已清空）
 *   - 去掉每条 waitFor/isEnabled（首批确认后不重复）
 *   - fill() 成功时跳过验证，仅异常时兜底
 */
async function fillDispatchWaybill(
  page: Page,
  inputLoc: import('playwright').Locator,
  waybillNo: string,
  log: (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void,
  batchLabel: string,
): Promise<void> {
  // fill() 本身会清空并写入，无需手动清空
  await inputLoc.fill(waybillNo, { timeout: 5000 }).catch(async (e: Error) => {
    log('warning', `[${batchLabel}] fill() 异常: ${e.message}，尝试 evaluate 兜底`);
  });

  // 验证（仅在 fill 可能失败时执行）
  const actualValue = await inputLoc.inputValue().catch(() => '');
  if (actualValue.trim() === waybillNo.trim()) {
    return; // 成功，快速返回
  }

  // evaluate 兜底：直接设置 value 并触发 Vue input/change 事件
  log('warning', `[${batchLabel}] fill 后校验失败(实际="${actualValue}")，尝试 input/change 事件兜底`);
  await inputLoc.evaluate((el, value) => {
    const element = el as HTMLInputElement;
    const proto = window.HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, waybillNo).catch(() => {});

  // 再次验证
  const retryValue = await inputLoc.inputValue().catch(() => '');
  if (retryValue.trim() !== waybillNo.trim()) {
    throw new Error(`单号填写失败：预期="${waybillNo}", 实际="${retryValue}", inputValue.length=${retryValue.length}`);
  }
  log('info', `[${batchLabel}] evaluate 兜底写入成功`);
}

/**
 * 逐个添加运单，对比表格行数检测成功/失败
 *
 * 添加成功 → 表格行数增加 → 进入 addedWaybills
 * 添加失败 → 表格行数不变（单号错误未进表格）→ 进入 addFailures
 */
async function addWaybillsOneByOne(
  page: Page,
  batch: string[],
  staffName: string,
  batchLabel: string,
  log: LogFn,
): Promise<{ addedWaybills: string[]; addFailures: OperationResult[] }> {
  const addedWaybills: string[] = [];
  const addFailures: OperationResult[] = [];

  // TC-05B: 日志聚合 — 每5条输出一次进度，避免刷屏
  const AGGREGATE_INTERVAL = 5;
  let batchSuccess = 0;
  let batchFail = 0;
  let lastAggregateIdx = -1;

  const emitAggregateIfNeeded = (currentIdx: number, force: boolean = false) => {
    const processed = currentIdx + 1;
    const shouldEmit = force
      || (processed % AGGREGATE_INTERVAL === 0)
      || (processed === batch.length);
    if (!shouldEmit || (processed <= lastAggregateIdx + 1 && !force)) return;

    const newSuccess = addedWaybills.length;
    const newFail = addFailures.length;
    const intervalStart = lastAggregateIdx + 2;
    const intervalEnd = processed;
    const intervalSuccess = newSuccess - batchSuccess;
    const intervalFail = newFail - batchFail;

    if (intervalSuccess > 0 || intervalFail > 0 || force) {
      const intervalElapsed = Date.now() - lastAggregateAt;
      log('info', `[${batchLabel}] Batch进度: ${intervalEnd}/${batch.length} (成功${newSuccess}, 失败${newFail}, 区间${intervalStart}-${intervalEnd}耗时${intervalElapsed}ms)`);
      lastAggregateAt = Date.now();
    }
    batchSuccess = newSuccess;
    batchFail = newFail;
    lastAggregateIdx = currentIdx;
  };

  let lastAggregateAt = Date.now();

  // Phase 5-G-8-7: 循环前一次性定位单号输入框，避免每条都重新定位
  const { loc: waybillInputLoc, count: waybillInputCount } = await locateDispatchWaybillInput(page, log, batchLabel);
  if (waybillInputCount === 0) {
    log('error', `[${batchLabel}] 单号输入框定位失败，终止本批`);
    return { addedWaybills, addFailures: batch.map(waybillNo => ({ waybillNo, staffName, success: false, message: '单号输入框定位失败', timestamp: Date.now(), status: 'FAILED' as const })) };
  }
  // 首次确认可见+可编辑
  await waybillInputLoc.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  for (let i = 0; i < batch.length; i++) {
    const waybillNo = batch[i];
    const itemStart = Date.now();
    const itemPerf: string[] = [];
    const itemStep = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        itemPerf.push(`${label}=${Date.now() - start}ms`);
      }
    };

    try {
      // 添加前表格行数
      const rowsBefore = await itemStep('countBefore', () => countTableRows(page));

      // Phase 5-G-8-7: 使用 fillDispatchWaybill 稳定填写单号（传入已定位的 locator）
      await itemStep('fill', () =>
        fillDispatchWaybill(page, waybillInputLoc, waybillNo, log, batchLabel),
      );

      // Phase 5-G-8: 使用稳定点击（先普通 click，失败后 force 回退，带验证）
      await itemStep('clickAdd', () =>
        fastStableBypassClick(page.locator(DISPATCH_SCAN_SELECTORS.addButton).first(), {
          log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
          label: 'dispatchAddButton',
          timeoutMs: TIMEOUT_BUTTON,
        }),
      );
      await itemStep('waitAfterClick', () => page.waitForTimeout(ADD_INTERVAL));

      // 添加后表格行数
      const rowsAfter = await itemStep('countAfter', () => countTableRows(page));

      if (rowsAfter > rowsBefore) {
        // 行数增加 → 添加成功
        addedWaybills.push(waybillNo);
      } else {
        // 行数未增加 → 单号错误，未进表格（warning级别，聚合输出，不逐条打日志）
        addFailures.push({
          waybillNo,
          staffName,
          success: false,
          message: '单号错误，未能添加',
          timestamp: Date.now(),
          status: 'FAILED',
        });
      }
    } catch (e) {
      // error级别的异常（真实错误）仍然立即输出，便于排查
      addFailures.push({
        waybillNo,
        staffName,
        success: false,
        message: `添加异常: ${(e as Error).message}`,
        timestamp: Date.now(),
        status: 'FAILED',
      });
      log('error', `[${batchLabel}] ${i + 1}/${batch.length} ${waybillNo} 添加异常: ${(e as Error).message}`);
    }

    const itemElapsed = Date.now() - itemStart;
    if (itemElapsed >= SLOW_STEP_MS) {
      const formState = await inspectAddFormState(page);
      log('warning', `[${batchLabel}] PERF addWaybill slow ${i + 1}/${batch.length} ${waybillNo} ${itemElapsed}ms (${itemPerf.join(', ')}; ${formState})`);
    }

    // 每 AGGREGATE_INTERVAL 条或最后一条输出聚合进度
    emitAggregateIfNeeded(i);
  }

  // 确保最终进度输出
  emitAggregateIfNeeded(batch.length - 1, true);
  log('info', `[${batchLabel}] 添加完成: 成功${addedWaybills.length}条, 失败${addFailures.length}条`);
  return { addedWaybills, addFailures };
}

/**
 * 统计派件表格行数（用于检测添加是否成功）
 */
async function countTableRows(page: Page): Promise<number> {
  const rowsLoc = page.locator(DISPATCH_TABLE_ROW_SELECTOR);
  return await rowsLoc.count();
}

/** Phase 5-G-8: 检查添加表单状态（慢路径诊断用） */
async function inspectAddFormState(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const addBtn = document.querySelector('.dispatchscan_left button.el-button--primary') as HTMLButtonElement | null;
    const messages = Array.from(document.querySelectorAll('.el-message, .el-notification'))
      .filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      })
      .map(el => (el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const loadingCount = Array.from(document.querySelectorAll('.el-loading-mask'))
      .filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }).length;

    return [
      `buttonDisabled=${addBtn?.disabled ?? 'missing'}`,
      `buttonLoading=${addBtn?.classList.contains('is-loading') ?? 'missing'}`,
      `loadingMasks=${loadingCount}`,
      `messages=${messages.length ? messages.join('|') : '-'}`,
    ].join(', ');
  }).catch(err => `inspect failed: ${(err as Error).message}`);
}

/**
 * 设200条/页（固定执行，不判断实际数量）
 * Phase L-2: 缺选项 throw + 验证分页切换成功
 */
async function setPageSize200(
  page: Page,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 设置 200 条/页`);
  try {
    await page.click(DISPATCH_SCAN_SELECTORS.pageSizeInput, { timeout: TIMEOUT_BUTTON });
    await page.waitForTimeout(500);

    const optLoc = page.locator(DISPATCH_SCAN_SELECTORS.pageSizeOption200);
    const optCount = await optLoc.count();
    if (optCount === 0) {
      throw new Error(`[${batchLabel}] Step 分页 未找到 200条/页 选项`);
    }

    await optLoc.first().click();
    await page.waitForTimeout(1500); // 等待分页重新加载

    // Phase L-2: 验证分页组件的 input 确实变成了 "200条/页"
    const pageSizeInput = page.locator(DISPATCH_SCAN_SELECTORS.pageSizeInput);
    const currentValue = await pageSizeInput.inputValue().catch(() => '');
    if (!currentValue.includes('200')) {
      throw new Error(`[${batchLabel}] Step 分页 切换验证失败: 预期包含"200", 实际="${currentValue}"`);
    }
    log('info', `[${batchLabel}] 分页已设为 200 条/页`);
  } catch (e) {
    // 已是本函数抛出的明确错误则直接向上抛
    if (e instanceof Error && e.message.includes('Step 分页')) {
      throw e;
    }
    log('warning', `[${batchLabel}] 设置分页异常: ${(e as Error).message}`);
  }
}

/**
 * 全选（Phase L-2: check({ force: true }) + isChecked 验证）
 */
async function selectAll(
  page: Page,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 全选`);
  try {
    const selLoc = page.locator(DISPATCH_SCAN_SELECTORS.selectAllCheckbox);
    const saCount = await selLoc.count();
    if (saCount === 0) {
      // Phase L-2: checkbox 缺失必须 throw，终止本批
      throw new Error(`[${batchLabel}] Step 全选 未找到全选 checkbox`);
    }

    // Phase L-2: 使用 Playwright 原生 check({ force: true })，而非 dispatchEvent('click')
    // check() 能正确触发 Vue/Element UI 的合成事件监听
    await selLoc.first().check({ force: true, timeout: TIMEOUT_ELEMENT });
    await page.waitForTimeout(500);

    // Phase L-2: 验证 checkbox 确实被勾选
    const isChecked = await selLoc.first().isChecked().catch(() => false);
    if (!isChecked) {
      throw new Error(`[${batchLabel}] Step 全选 check 后验证失败: checkbox 未勾选`);
    }
    log('info', `[${batchLabel}] 全选成功`);
  } catch (e) {
    // 已是本函数抛出的明确错误则直接向上抛
    if (e instanceof Error && e.message.includes('Step 全选')) {
      throw e;
    }
    log('warning', `[${batchLabel}] 全选异常: ${(e as Error).message}`);
  }
}

/**
 * [DRY-RUN 检查点] 上传 + toast 判定
 *
 * ⚠️ 试运行模式：跳过真实点击上传，返回 dryRun 标记
 * 真实模式：点击上传 → 等待 toast → 四态判定
 */
async function uploadAndJudge(
  page: Page,
  addedWaybills: string[],
  staffName: string,
  batchLabel: string,
  log: LogFn,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  // Phase 9-dryrun: 全局试运行模式检查点
  if (dryRunMode) {
    log('info', `[试运行模式] 派件扫描已执行到最终提交前，跳过真实提交 (${addedWaybills.length}条)`);
    return addedWaybills.map(no => ({
      waybillNo: no,
      staffName,
      success: true,
      status: 'DRY_RUN_SKIPPED',
      message: '[试运行跳过提交] 已执行到最终提交前，未点击提交按钮',
      timestamp: Date.now(),
      dryRun: true,
      skippedFinalSubmit: true,
    }));
  }

  // Phase 5-I-1: 安全门 — dryRun=false 但未开启真实提交开关
  if (!SettingsManager.isRealSubmitAllowed()) {
    log('warning', `[安全门] 真实执行开关已传递到执行层，但当前未开启 ENABLE_REAL_SUBMIT，跳过最终提交 (${addedWaybills.length}条)`);
    return addedWaybills.map(no => ({
      waybillNo: no,
      staffName,
      success: true,
      status: 'SAFETY_GATE_SKIPPED',
      message: '[安全门拦截] 真实执行开关已打通，但未开启最终提交保护开关，未点击提交按钮',
      timestamp: Date.now(),
      dryRun: true,
      skippedFinalSubmit: true,
    }));
  }

  log('info', `[真实执行模式] 即将点击"上传"按钮，执行真实派件扫描提交 (${addedWaybills.length}条)`);
  // 真实上传
  log('info', `[${batchLabel}] 点击上传 (${addedWaybills.length}条)`);
  await takeScreenshot(page, `${batchLabel}_before_upload`);

  // Phase L-2: 记录上传前表格行数（用于 DOM 回退判定）
  const rowLoc = page.locator(DISPATCH_TABLE_ROW_SELECTOR);
  const rowsBeforeUpload = await rowLoc.count().catch(() => -1);

  let clicked = false;
  try {
    await page.locator(DISPATCH_SCAN_SELECTORS.uploadButton).first().click({ timeout: TIMEOUT_BUTTON });
    clicked = true;
  } catch (e) {
    log('warning', `[${batchLabel}] 点击上传按钮失败: ${(e as Error).message}`);
  }

  if (!clicked) {
    throw new Error(`[${batchLabel}] 未找到"上传"按钮`);
  }

  await takeScreenshot(page, `${batchLabel}_after_upload`);

  // Phase L-2: Toast 重试 + DOM 回退判定
  let toastMsg = await waitForToast(page, TIMEOUT_TOAST);

  if (toastMsg.includes('timeout:未收到系统响应')) {
    log('warning', `[${batchLabel}] 首次 toast 超时，等待 2s 后重试`);
    await page.waitForTimeout(2000);
    toastMsg = await waitForToast(page, 5000);

    if (toastMsg.includes('timeout:未收到系统响应')) {
      // DOM 回退判定：对比上传前后表格行数变化
      // 派件上传成功后表格行可能清空、减少或状态列变化，不完全依赖"表格为空"
      log('warning', `[${batchLabel}] 二次 toast 仍超时，使用 DOM 回退判定`);
      const rowsAfterUpload = await rowLoc.count().catch(() => -1);

      if (rowsBeforeUpload >= 0 && rowsAfterUpload === 0) {
        // 表格完全清空 → 强烈暗示全部成功
        toastMsg = '上传成功';
        log('info', `[${batchLabel}] DOM回退判定: 表格已清空 (${rowsBeforeUpload}→0)，认为提交成功`);
      } else if (rowsBeforeUpload >= 0 && rowsAfterUpload > 0 && rowsAfterUpload < rowsBeforeUpload) {
        // 行数减少但未清空 → 可能部分成功（被移除的行=成功，剩余=失败）
        const removedCount = rowsBeforeUpload - rowsAfterUpload;
        toastMsg = `部分成功,成功${removedCount}条,失败${rowsAfterUpload}条`;
        log('warning', `[${batchLabel}] DOM回退判定: 表格行减少 ${rowsBeforeUpload}→${rowsAfterUpload}，推测部分成功`);
      } else {
        toastMsg = `系统未返回明确结果，表格行数(${rowsBeforeUpload}→${rowsAfterUpload})未变化，需人工核实`;
        log('warning', `[${batchLabel}] DOM回退判定: 表格行数未明显变化，结果不确定`);
      }
    }
  }

  log('info', `[${batchLabel}] Toast: ${toastMsg}`);

  // 四态判定
  const outcome = parseDispatchScanResult(toastMsg, addedWaybills.length);
  log('info', `[${batchLabel}] 判定: status=${outcome.status}, success=${outcome.successCount ?? '?'}, fail=${outcome.failCount ?? '?'}`);

  await takeScreenshot(page, `${batchLabel}_done`);

  // PARTIAL/UNKNOWN 无法按单号归因，全批统一标记（与到件扫描一致）
  return addedWaybills.map(no => ({
    waybillNo: no,
    staffName,
    success: outcome.status === 'SUCCESS',
    message: outcome.message,
    timestamp: Date.now(),
    status: outcome.status,
  }));
}

/** 将数组按指定大小分批 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
