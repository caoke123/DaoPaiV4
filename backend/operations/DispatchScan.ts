// 派件扫描操作模块（批次模型 + 多窗口并发）
// 架构：与到件扫描相同的批次模型（逐个添加构建表格 → 200条/页 → 全选 → 上传 → 批次级toast四态判定）
// 区别：派件用员工账号(staff)、多窗口并发、逐个点"添加"构建表格、上传按钮提交
//
// ⚠️ 安全开关 DISPATCH_SCAN_DRY_RUN：true=跳过真实点击上传，false=真实提交
// 开发期间默认 true，生产上线前可 dry-run 验证
import type { Page } from 'playwright';
import { waitForToast, takeScreenshot, captureFailureScreenshot } from '../browser/PageNavigator';
import { PageStateManager } from '../browser/PageStateManager';
import { NavigationGovernance } from '../browser/NavigationGovernance';
import type { OperationResult } from './BaseOperation';
import type { LogContext } from '../utils/TaskLogManager';
import { DISPATCH_SCAN_SELECTORS, DISPATCH_TABLE_ROW_SELECTOR } from './selectors/dispatchScan.selectors';
import { parseDispatchScanResult } from './dispatchScanResult';

// 系统限制：每次最多处理 200 条
const MAX_BATCH_SIZE = 200;

// 超时配置
const TIMEOUT_ELEMENT = 10000;      // 页面元素
const TIMEOUT_BUTTON = 3000;        // 按钮点击
const TIMEOUT_TOAST = 10000;        // toast 等待
const TIMEOUT_RELOAD = 15000;       // 页面重新加载

// 间隔配置
const BATCH_INTERVAL = 2000;        // 批次间间隔
const ADD_INTERVAL = 300;           // 添加单条间隔
const NAV_SETTLE = 1500;            // 导航后稳定等待

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void;

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
      // Phase G-2: 失败自动截图
      if (taskId) {
        const ssPath = await captureFailureScreenshot(page, taskId, `dispatch_${staffName}_batch${batchIdx + 1}`);
        if (ssPath) log('error', `异常截图已保存 路径: ${ssPath}`);
      }

      // FatalDispatchError 或其他批次错误：本批标记失败，继续下一批
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
 * a. 导航到派件扫描页面 + 强制 reload 清空表格
 * b. PageStateManager 前置检查
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

  // a. 每批重新导航到派件扫描页面
  log('info', `[${batchLabel}] 导航到派件扫描页面`);
  const navGov = NavigationGovernance.getInstance();
  const navResult = await navGov.navigateTo(page, 'dispatch');
  if (!navResult.success) {
    throw new Error(`[${batchLabel}] 导航失败: ${navResult.error ?? '未知错误'}`);
  }

  // 强制重新加载，清空上一批表格状态（确保每批干净开始）
  await page.reload({ timeout: TIMEOUT_RELOAD });
  await page.waitForTimeout(NAV_SETTLE);

  // b. PageStateManager 前置检查
  log('info', `[${batchLabel}] PageStateManager.ensureReadyForTask('dispatch')`);
  const stateMgr = PageStateManager.getInstance();
  const state = await stateMgr.ensureReadyForTask(page, 'dispatch', {
    autoFix: true,
    maxAutoFixRetries: 1,
  });

  if (!state.ready) {
    throw new Error(`[${batchLabel}] 页面状态检查未通过: ${state.blockedBy.join(', ')}`);
  }

  log('info', `[${batchLabel}] Page Ready (URL=${state.url.actual})`);
  await takeScreenshot(page, `${batchLabel}_page_ready`);

  // c. 选择派件员（失败 throw FatalDispatchError）
  await selectCourier(page, courierName, batchLabel, log);

  // d. 逐个添加运单，检测添加成功/失败
  const { addedWaybills, addFailures } = await addWaybillsOneByOne(page, batch, staffName, batchLabel, log);

  // e. 无成功添加则跳过上传
  if (addedWaybills.length === 0) {
    log('warning', `[${batchLabel}] 无运单添加成功，跳过上传`);
    return addFailures;
  }

  // f. 设200条/页 + 全选 + [DRY-RUN]上传 + toast判定
  await setPageSize200(page, batchLabel, log);
  await selectAll(page, batchLabel, log);

  const uploadResults = await uploadAndJudge(page, addedWaybills, staffName, batchLabel, log, dryRunMode);

  // g. 合并添加失败 + 上传结果
  return [...addFailures, ...uploadResults];
}

/**
 * 选择派件员（精确文本匹配，找不到 throw FatalDispatchError）
 */
async function selectCourier(
  page: Page,
  courierName: string,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 选择派件员: ${courierName}`);

  // 点击派件员下拉框
  await page.click(DISPATCH_SCAN_SELECTORS.courierSelectInput, { timeout: TIMEOUT_ELEMENT });
  await page.waitForTimeout(500);

  // 文本匹配选择员工（用可见浮层）
  const optionSel = DISPATCH_SCAN_SELECTORS.courierOption.replace('${staffName}', courierName);
  const optionLoc = page.locator(optionSel);
  const optionCount = await optionLoc.count();

  if (optionCount === 0) {
    // C1 教训：派件员选择失败必须 throw，不仅 warning
    throw new FatalDispatchError(courierName, batchLabel);
  }

  await optionLoc.first().click();
  await page.waitForTimeout(500);
  log('info', `[${batchLabel}] 派件员已选择`);
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
    const intervalSuccess = newSuccess - batchSuccess;
    const intervalFail = newFail - batchFail;

    if (intervalSuccess > 0 || intervalFail > 0 || force) {
      log('info', `[${batchLabel}] 批次进度: ${processed}/${batch.length} (成功${newSuccess}, 失败${newFail})`);
    }
    batchSuccess = newSuccess;
    batchFail = newFail;
    lastAggregateIdx = currentIdx;
  };

  for (let i = 0; i < batch.length; i++) {
    const waybillNo = batch[i];

    try {
      // 添加前表格行数
      const rowsBefore = await countTableRows(page);

      // 填入单号
      await page.fill(DISPATCH_SCAN_SELECTORS.waybillInput, waybillNo, { timeout: TIMEOUT_ELEMENT });

      // Phase L-2: 验证 fill 后 input 真实值（防止前端防抖截断或 SPA 重渲染抢焦）
      const inputLoc = page.locator(DISPATCH_SCAN_SELECTORS.waybillInput);
      const actualValue = await inputLoc.first().inputValue().catch(() => '');
      if (actualValue.trim() !== waybillNo.trim()) {
        throw new Error(`填入单号验证失败: 预期="${waybillNo}", 实际="${actualValue}"`);
      }

      // 点击添加（用 locator().first() 避免 strict mode 多匹配报错）
      await page.locator(DISPATCH_SCAN_SELECTORS.addButton).first().click({ timeout: TIMEOUT_BUTTON });
      await page.waitForTimeout(ADD_INTERVAL);

      // 添加后表格行数
      const rowsAfter = await countTableRows(page);

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

