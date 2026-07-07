// 到件扫描操作模块（批量 textarea 模式）
// Phase B-3: URL直达导航 + Fatal Error机制 + 超时优化
// 每批：Dashboard → 弹窗清扫 → URL直达ArrivalscanBatch → 弹窗清扫 → 确认页面 → 填入 → 提交
import type { Page } from 'playwright';
import { waitForToast, takeScreenshot, captureFailureScreenshot } from '../browser/PageNavigator';
import type { OperationResult } from './BaseOperation';
import { taskLogManager, type LogContext } from '../utils/TaskLogManager';
import { ARRIVAL_BATCH_SELECTORS, DEFAULT_PREV_STATION } from './selectors/arrivalScanBatch.selectors';
import { SettingsManager } from '../config/SettingsManager';
import { parseArriveScanResult } from './arriveScanResult';
import { BusinessPageNavigator } from '../browser/BusinessPageNavigator';
import { verifyBusinessPageReady } from './businessPageReady';

// 系统限制：每次最多处理 200 条
const MAX_BATCH_SIZE = 200;

// 超时配置（Phase B-3 统一缩短）
const TIMEOUT_ELEMENT = 10000;      // 页面元素（textarea 需要等待 SPA 渲染）
const TIMEOUT_BUTTON = 3000;        // 按钮点击
const TIMEOUT_TOAST = 10000;        // toast 等待
const SLOW_STEP_MS = 1500;           // Phase 5-G-8: 超过该耗时的子步骤输出 warning

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
class FatalNavigationError extends Error {
  constructor(batchLabel: string) {
    super(`[${batchLabel}] [FATAL] 无法进入到件扫描页面。检查：1.是否登录失效 2.是否页面结构变化 3.是否弹窗遮挡 4.是否网络异常。任务已终止`);
    this.name = 'FatalNavigationError';
  }
}

/**
 * 执行到件扫描（批量模式）
 * @param dryRunMode 试运行模式：true=跳过最终提交按钮（Phase 9-dryrun 全局开关）
 */
export async function execute(
  page: Page,
  waybillNos: string[],
  onProgress: (done: number, results: OperationResult[]) => void,
  taskId?: string,
  windowId?: string,
  staffName?: string,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  if (waybillNos.length === 0) {
    return [];
  }

  const log = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => {
    const consoleMethod = level === 'warning' ? 'warn' : level;
    console[consoleMethod](`[ArriveScan] ${msg}`);
    if (taskId) taskLogManager.addLog(taskId, level, msg, 'ArriveScan', { staffName: staffName ?? '管理员', windowId, ...context });
  };

  log('info', `开始到件扫描: 共${waybillNos.length}条运单, 批次大小=${MAX_BATCH_SIZE}`);

  // 按批次大小拆分
  const batches = chunkArray(waybillNos, MAX_BATCH_SIZE);
  log('info', `拆分${batches.length}批`);
  batches.forEach((batch, i) => {
    log('info', `第${i + 1}批：${batch.length}条`);
  });

  // 逐批处理
  const allResults: OperationResult[] = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];

    try {
      await processOneBatch(page, batchIndex, batches.length, batch, allResults, onProgress, log, staffName, dryRunMode);
    } catch (err) {
      // Phase G-2: 失败自动截图（默认ENABLE_RUNTIME_SCREENSHOTS=0关闭）
      if (taskId) {
        await captureFailureScreenshot(page, taskId, `arrival_batch${batchIndex + 1}`).catch(() => '');
      }

      // FatalNavigationError：终止整个任务
      if (err instanceof FatalNavigationError) {
        log('error', err.message);
        // 剩余所有单号标记失败
        for (let i = batchIndex; i < batches.length; i++) {
          const failBatch = batches[i];
          const batchResults: OperationResult[] = failBatch.map(no => ({
            waybillNo: no,
            staffName,
            success: false,
            message: '任务因页面导航失败而终止',
            timestamp: Date.now(),
          }));
          allResults.push(...batchResults);
          onProgress(allResults.length, batchResults);
        }
        log('error', `任务终止: 成功=${allResults.filter(r => r.success).length}, 失败=${allResults.filter(r => !r.success).length}`);
        return allResults;
      }

      // 普通错误：本批标记失败，继续下一批
      log('error', `[批次 ${batchIndex + 1}/${batches.length}] 失败: ${(err as Error).message}`);
      const batchResults: OperationResult[] = batch.map(no => ({
        waybillNo: no,
        staffName,
        success: false,
        message: (err as Error).message,
        timestamp: Date.now(),
      }));
      allResults.push(...batchResults);
      onProgress(allResults.length, batchResults);
    }

    // 批次间等待 2s 缓冲
    if (batchIndex < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  const successCount = allResults.filter(r => r.success).length;
  const failCount = allResults.filter(r => !r.success).length;
  log('info', `完成: 成功=${successCount}, 失败=${failCount}`);

  return allResults;
}

/**
 * 处理单批到件扫描
 * Phase K-2E-R2: 使用菜单优先导航 + 轻量页面验证，避免进入成功后重复 ready/reload
 */
async function processOneBatch(
  page: Page,
  batchIndex: number,
  totalBatches: number,
  batch: string[],
  allResults: OperationResult[],
  onProgress: (done: number, results: OperationResult[]) => void,
  log: (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void,
  staffName?: string,
  dryRunMode?: boolean,
): Promise<void> {
  const batchLabel = `批次 ${batchIndex + 1}/${totalBatches}`;
  const batchStart = Date.now();
  const ssName = `batch${batchIndex + 1}`;

  // ── Phase K-2E-R2: 菜单优先进入业务页后只做轻量验证，不再触发重型 ready/reload ──
  // Phase 5-G-8-4: 统一使用 BusinessPageNavigator 导航到到件扫描页面
  log('info', `[${batchLabel}] 导航到到件扫描页面`);
  const businessNav = BusinessPageNavigator.getInstance();
  const navResult = await timedStep(log, batchLabel, 'navigateToBusinessPage(arrival)', () =>
    businessNav.navigateToBusinessPage(page, 'arrival', {
      staffName,
      log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
    }),
  );
  if (!navResult.success) {
    throw new Error(`[${batchLabel}] 导航失败: ${navResult.error ?? '未知错误'}`);
  }
  log('info', `[${batchLabel}] 导航结果: method=${navResult.method}, duration=${navResult.durationMs}ms`);

  const ready = await timedStep(log, batchLabel, 'verifyBusinessPageReady(arrival)', () =>
    verifyBusinessPageReady(page, 'arrival', batchLabel, log),
  );

  if (!ready.ready) {
    log('error', `[${batchLabel}] 页面轻量验证未通过: missing=${ready.missing.join(',') || '-'}, popupVisible=${ready.popupVisible}`);
    throw new FatalNavigationError(batchLabel);
  }

  log('info', `[${batchLabel}] Page Ready (URL=${ready.url})`);
  await takeScreenshot(page, `${ssName}_page_ready`);

  // ── Step 6: 填入运单号 ──
  const textareaSel = ARRIVAL_BATCH_SELECTORS.waybillTextarea;

  // 清空兜底
  try {
    await page.click(textareaSel, { timeout: TIMEOUT_BUTTON });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.fill(textareaSel, '');
  } catch (e) {
    log('warning', `[${batchLabel}] textarea 清空异常: ${(e as Error).message}`);
  }

  // 填入运单号
  log('info', `[${batchLabel}] Fill Waybills (${batch.length}条)`);
  await timedStep(log, batchLabel, 'fillWaybills', async () => {
    try {
      await page.fill(textareaSel, batch.join('\n'));
    } catch (e) {
      throw new Error(`填充运单号失败: ${(e as Error).message}`);
    }
  });

  // ── Step 7: 选择"上一站" ──
  await timedStep(log, batchLabel, 'selectPrevStation', async () => {
    log('info', `[${batchLabel}] Select Previous Station`);
    try {
      // 点击"上一站"下拉框
      await page.click(ARRIVAL_BATCH_SELECTORS.prevStationInput, { timeout: TIMEOUT_ELEMENT });
      await page.waitForTimeout(800);
      // 使用 locator 选择下拉选项（更稳健）
      const prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption);
      const prevCount = await prevOptionLoc.count();
      if (prevCount > 0) {
        await prevOptionLoc.first().click();
        await page.waitForTimeout(500);
        log('info', `[${batchLabel}] 上一站已选择`);
      } else {
        // 兜底: 直接输入文本
        await page.fill(ARRIVAL_BATCH_SELECTORS.prevStationInput, DEFAULT_PREV_STATION);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        log('warning', `[${batchLabel}] 未找到上一站选项，已输入文本: ${DEFAULT_PREV_STATION}`);
      }
    } catch (e) {
      log('warning', `[${batchLabel}] 选择上一站异常: ${(e as Error).message}`);
    }
  });

  // ── Step 8: 点击"查询"按钮 ──
  // C1-1: 查询失败必须 throw，终止本批，不进入全选/提交
  await timedStep(log, batchLabel, 'queryWaybills', async () => {
    log('info', `[${batchLabel}] Click Query`);
    try {
      await page.click(ARRIVAL_BATCH_SELECTORS.queryBtn, { timeout: TIMEOUT_BUTTON });
      await page.waitForTimeout(3000); // 等待查询结果 + 表格渲染

      // Phase L-2: DOM 验证 — 确认查询结果表格行已加载
      try {
        await page.waitForSelector('.el-table__body-wrapper .el-table__row', { timeout: 8000, state: 'visible' });
        log('info', `[${batchLabel}] 查询结果表格行已加载`);
      } catch {
        throw new Error(`[${batchLabel}] Step 8 查询后表格行未加载(批次${batch.length}条)，请检查网络或页面状态`);
      }

      log('info', `[${batchLabel}] 查询已提交，结果加载完成`);
    } catch (e) {
      // 已是本函数抛出的明确错误则直接向上抛
      if (e instanceof Error && e.message.includes('Step 8')) {
        throw e;
      }
      throw new Error(`[${batchLabel}] Step 8 查询失败(批次${batch.length}条): ${(e as Error).message}`);
    }
  });

  // ── Step 9: 选择 200 条/页 ──
  // C1-1: 分页失败必须 throw，避免因分页未生效导致部分单号不可见
  await timedStep(log, batchLabel, 'setPageSize200', async () => {
    log('info', `[${batchLabel}] Set Page Size 200`);
    try {
      await page.click(ARRIVAL_BATCH_SELECTORS.pageSizeSelect, { timeout: TIMEOUT_BUTTON });
      await page.waitForTimeout(800);
      const pageSizeLoc = page.locator(ARRIVAL_BATCH_SELECTORS.pageSizeOption);
      const psCount = await pageSizeLoc.count();
      if (psCount > 0) {
        await pageSizeLoc.first().click();
        await page.waitForTimeout(1500); // 等待分页重新加载
        log('info', `[${batchLabel}] 分页已设为 200 条/页`);
      } else {
        throw new Error(`[${batchLabel}] Step 9 未找到 200 条/页选项(批次${batch.length}条)，分页可能不完整`);
      }
    } catch (e) {
      // 已是本函数抛出的明确错误则直接向上抛
      if (e instanceof Error && e.message.includes('Step 9')) {
        throw e;
      }
      throw new Error(`[${batchLabel}] Step 9 设置分页失败(批次${batch.length}条): ${(e as Error).message}`);
    }
  });

  // ── Step 10: 点击全选 ──
  await timedStep(log, batchLabel, 'selectAll', async () => {
    log('info', `[${batchLabel}] Select All`);
    try {
      const selectAllLoc = page.locator(ARRIVAL_BATCH_SELECTORS.selectAllCheckbox);
      const saCount = await selectAllLoc.count();
      if (saCount > 0) {
        // 检查第一个是否为 enabled
        const isEnabled = await selectAllLoc.first().isEnabled().catch(() => false);
        if (isEnabled) {
          await selectAllLoc.first().click({ timeout: TIMEOUT_ELEMENT });
          await page.waitForTimeout(500);
          log('info', `[${batchLabel}] 全选成功`);
        } else {
          // 表格为空或无数据，尝试 force click
          log('warning', `[${batchLabel}] 全选 checkbox 未启用，尝试 force click`);
          await selectAllLoc.first().dispatchEvent('click');
          await page.waitForTimeout(500);
        }
      } else {
        // Phase L-2: 全选 checkbox 缺失为硬错误，必须 throw 终止本批
        throw new Error(`[${batchLabel}] Step 10 未找到全选 checkbox(批次${batch.length}条)`);
      }
    } catch (e) {
      // 已是本函数抛出的明确错误则直接向上抛
      if (e instanceof Error && e.message.includes('Step 10')) {
        throw e;
      }
      log('warning', `[${batchLabel}] 点击全选异常: ${(e as Error).message}`);
    }
  });

  // ── Step 11: 点击"批量到件"按钮 ──
  log('info', `[${batchLabel}] Submit`);
  await takeScreenshot(page, `${ssName}_before_submit`);

  // Phase 9-dryrun: 试运行模式阻断最终提交
  if (dryRunMode) {
    log('info', `[试运行模式] 到件扫描已执行到最终提交前，跳过真实提交 (${batch.length}条)`);
    const dryResults: OperationResult[] = batch.map(no => ({
      waybillNo: no,
      staffName,
      success: true,
      status: 'DRY_RUN_SKIPPED',
      message: '[试运行跳过提交] 已执行到最终提交前，未点击提交按钮',
      timestamp: Date.now(),
      dryRun: true,
      skippedFinalSubmit: true,
    }));
    allResults.push(...dryResults);
    onProgress(allResults.length, dryResults);
    log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
    return;
  }

  // Phase 5-I-1: 安全门 — dryRun=false 但未开启真实提交开关
  if (!SettingsManager.isRealSubmitAllowed()) {
    log('warning', `[安全门] 真实执行开关已传递到执行层，但当前未开启 ENABLE_REAL_SUBMIT，跳过最终提交 (${batch.length}条)`);
    const safetyResults: OperationResult[] = batch.map(no => ({
      waybillNo: no,
      staffName,
      success: true,
      status: 'SAFETY_GATE_SKIPPED',
      message: '[安全门拦截] 真实执行开关已打通，但未开启最终提交保护开关，未点击提交按钮',
      timestamp: Date.now(),
      dryRun: true,
      skippedFinalSubmit: true,
    }));
    allResults.push(...safetyResults);
    onProgress(allResults.length, safetyResults);
    log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
    return;
  }

  log('info', `[真实执行模式] 即将点击"批量到件"提交按钮，执行真实到件操作 (${batch.length}条)`);

  await timedStep(log, batchLabel, 'submitAndJudge', async () => {
    let clicked = false;
    try {
      await page.click(ARRIVAL_BATCH_SELECTORS.submitBatchBtn, { timeout: TIMEOUT_BUTTON });
      clicked = true;
    } catch (e) {
      log('warning', `[${batchLabel}] 点击批量到件按钮失败: ${(e as Error).message}`);
    }

    if (!clicked) {
      throw new Error('未找到"批量到件"按钮');
    }

    await takeScreenshot(page, `${ssName}_after_submit`);

    // ── Step 12: 等待 toast 提示 ──
    // Phase L-2: Toast 重试 + DOM 回退判定
    let toastMsg = await waitForToast(page, TIMEOUT_TOAST);

    if (toastMsg.includes('timeout:未收到系统响应')) {
      log('warning', `[${batchLabel}] 首次 toast 超时，等待 2s 后重试`);
      await page.waitForTimeout(2000);
      toastMsg = await waitForToast(page, 5000);

      if (toastMsg.includes('timeout:未收到系统响应')) {
        // DOM 回退判定：检查表格行是否消失来判断提交是否生效
        log('warning', `[${batchLabel}] 二次 toast 仍超时，使用 DOM 回退判定`);
        const tableRowCount = await page.locator('.el-table__body-wrapper .el-table__row').count().catch(() => 0);
        if (tableRowCount === 0) {
          // 表格已清空，推测提交成功
          toastMsg = '批量到件成功';
          log('info', `[${batchLabel}] DOM回退判定: 表格已清空，认为提交成功`);
        } else {
          toastMsg = `系统未返回明确结果，表格仍有 ${tableRowCount} 行数据，需人工核实`;
          log('warning', `[${batchLabel}] DOM回退判定: 表格仍有 ${tableRowCount} 行`);
        }
      }
    }

    log('info', `[${batchLabel}] Toast: ${toastMsg}`);

    // ── Step 13: 完成 ──
    await takeScreenshot(page, `${ssName}_done`);

    // C1-2/C1-3: 使用纯函数判定结果，区分 SUCCESS/PARTIAL/FAILED/UNKNOWN
    const outcome = parseArriveScanResult(toastMsg, batch.length);
    log('info', `[${batchLabel}] 判定: status=${outcome.status}, success=${outcome.successCount ?? '?'}, fail=${outcome.failCount ?? '?'}`);

    // PARTIAL/UNKNOWN 无法按单号归因，统一标记需人工核实
    const batchResults: OperationResult[] = batch.map(no => ({
      waybillNo: no,
      staffName,
      success: outcome.status === 'SUCCESS',
      message: outcome.message,
      timestamp: Date.now(),
      status: outcome.status,
    }));

    allResults.push(...batchResults);
    onProgress(allResults.length, batchResults);
  });

  log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
  log('info', `[${batchLabel}] Done`);
}

/** 将数组按指定大小分批 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
