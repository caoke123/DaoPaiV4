// 到派一体扫描操作模块（批次模型 + 多窗口并发）
// 架构：基于 DispatchScan 骨架改造，在到件扫描页面勾选"到派一体"选项实现到件+派件一次性扫描
// 流程：导航到到件扫描页面 → 选上一站 → 勾选到派一体 → 选派件员 → 逐个添加 → 200条/页 → 全选 → 上传 → 四态判定
//
// Phase 9-dryrun: 最终提交按钮受全局 dryRunMode 控制（由 Engine 通过参数传入）
import type { Locator, Page } from 'playwright';
import { waitForToast, takeScreenshot, captureFailureScreenshot } from '../browser/PageNavigator';
import type { OperationResult } from './BaseOperation';
import type { LogContext } from '../utils/TaskLogManager';
import {
  INTEGRATED_SCAN_SELECTORS,
  INTEGRATED_TABLE_ROW_SELECTOR,
  DEFAULT_PREV_STATION,
} from './selectors/integratedScan.selectors';
import { parseArriveScanResult } from './arriveScanResult';
import { SettingsManager } from '../config/SettingsManager';
import type { Site } from '../db/Database';
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
const ADD_INTERVAL = 300;           // 添加单条间隔
const NAV_SETTLE = 1500;            // 导航后稳定等待
const SLOW_STEP_MS = 1500;           // 超过该耗时的子步骤输出 warning，便于定位单窗口慢点

const DIAGNOSTIC_SCREENSHOTS_ENABLED =
  process.env.INTEGRATED_DIAGNOSTIC_SCREENSHOTS === '1' ||
  process.env.INTEGRATED_DIAGNOSTIC_SCREENSHOTS === 'true';

/** 日志函数类型 */
type LogFn = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void;

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

async function takeDiagnosticScreenshot(page: Page, label: string): Promise<void> {
  if (!DIAGNOSTIC_SCREENSHOTS_ENABLED) return;
  await takeScreenshot(page, label);
}

async function fastStableBypassClick(locator: Locator, timeout = TIMEOUT_BUTTON): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, force: true });
}

/** 到派一体任务分配（每个员工一组运单） */
export interface IntegratedAssignment {
  staffName: string;
  waybillNos: string[];
  /** Phase 2-B: 指定模式 — 入参透传 */
  executionMode?: 'default' | 'designated';
  targetCourierName?: string;
  targetCourierAccount?: string;
}

/** Fatal Error：派件员选择失败，终止该批次（不终止整个员工，继续下一批） */
class FatalIntegratedError extends Error {
  constructor(staffName: string, batchLabel: string) {
    super(`[${batchLabel}][员工:${staffName}] [FATAL] 派件员选择失败，本批终止`);
    this.name = 'FatalIntegratedError';
  }
}

/**
 * 单员工处理：按 200 一组分批，每批重新导航+选上一站+勾选到派一体+选派件员
 *
 * employeeId 解析：通过 SettingsManager.resolveWorkerCredential 统一解析，
 * 优先从设置中心 settings.json 获取 username 作为 employeeId，
 * credentials.ts 仅作为兜底。
 *
 * Phase D-1: 导出供 IntegratedHandler 调用（Engine 负责锁/连接/进度，此函数仅处理业务）
 * @param dryRunMode 试运行模式：true=跳过最终提交按钮（Phase 9-dryrun 全局开关）
 */
export async function executeOneStaff(
  page: Page,
  assignment: IntegratedAssignment,
  log: LogFn,
  taskId?: string,
  dryRunMode?: boolean,
  site?: Site,
): Promise<OperationResult[]> {
  const { staffName, waybillNos, targetCourierName, targetCourierAccount, executionMode } = assignment;
  const staffLabel = `员工:${staffName}`;
  // Phase 2-B2: 指定模式下优先使用 targetCourierAccount 作为 employeeId，否则按姓名解析
  const effectiveCourierName = targetCourierName || staffName;
  const batches = chunkArray(waybillNos, MAX_BATCH_SIZE);
  log('info', `[${staffLabel}] 共${waybillNos.length}条, 分${batches.length}批`);

  // 解析 employeeId —— 指定模式优先直接用 targetCourierAccount
  let employeeId: string;
  try {
    if (executionMode === 'designated' && targetCourierAccount) {
      employeeId = targetCourierAccount;
      log('info', `[${staffLabel}] 到派一体使用目标派件员：${effectiveCourierName} / ${targetCourierAccount}（指定模式，直接按账号匹配）`);
    } else {
      const worker = await SettingsManager.getInstance().resolveWorkerCredential({ site, staffName: effectiveCourierName });
      employeeId = worker.employeeId;
      log('info', `[${staffLabel}] employeeId 解析: ${employeeId} (source=${worker.source})`);
    }
  } catch (e) {
    log('error', `[${staffLabel}] ${(e as Error).message}`);
    return waybillNos.map(no => ({
      waybillNo: no,
      staffName,
      success: false,
      message: (e as Error).message,
      timestamp: Date.now(),
      status: 'FAILED',
    }));
  }

  const staffResults: OperationResult[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchLabel = `${staffLabel} 批次 ${batchIdx + 1}/${batches.length}`;

    try {
      const batchResults = await processOneBatch(page, staffName, effectiveCourierName, employeeId, batch, batchIdx, batches.length, log, dryRunMode);
      staffResults.push(...batchResults);
    } catch (err) {
      // Phase G-2: 失败自动截图（默认ENABLE_RUNTIME_SCREENSHOTS=0关闭）
      if (taskId) {
        await captureFailureScreenshot(page, taskId, `integrated_${staffName}_batch${batchIdx + 1}`).catch(() => '');
      }

      // FatalIntegratedError 或其他批次错误：本批标记失败，继续下一批
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
 * 处理单批：导航 → 选上一站 → 勾选到派一体 → 选派件员 → 逐个添加 → 设200/页 → 全选 → [DRY-RUN]上传 → toast判定
 *
 * 每批都重新走完整流程，不复用上一批页面状态：
 * a. 导航到到件扫描页面 + 强制 reload 清空表格
 * b. 菜单优先导航 + 轻量页面验证
 * c. 选上一站（天津分拨中心）—— 到派一体专属
 * d. 勾选"到派一体"选项框 —— 到派一体专属
 * e. 选择派件员（失败 throw FatalIntegratedError）
 * f. 逐个添加运单（对比表格行数检测成功/失败）
 * g. 无成功添加则跳过上传
 * h. 设200条/页 + 全选 + [DRY-RUN]上传 + toast判定
 * i. 合并添加失败 + 上传结果
 */
async function processOneBatch(
  page: Page,
  staffName: string,
  courierVerifyName: string,
  employeeId: string,
  batch: string[],
  batchIdx: number,
  totalBatches: number,
  log: LogFn,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  const batchLabel = `员工:${staffName} 批次 ${batchIdx + 1}/${totalBatches}`;
  const batchStart = Date.now();

  // a. 每批重新导航到到件扫描页面
  // Phase 5-G-8-4: 统一使用 BusinessPageNavigator（ensureCleanHome + URL优先 + 重试 + 侧边栏兜底）
  log('info', `[${batchLabel}] 导航到到件扫描页面(到派一体)`);
  const businessNav = BusinessPageNavigator.getInstance();
  const navResult = await timedStep(log, batchLabel, 'navigateToBusinessPage(integrated)', () =>
    businessNav.navigateToBusinessPage(page, 'integrated', {
      staffName,
      log: (level, msg) => log(level, `[${batchLabel}] ${msg}`),
    }),
  );
  if (!navResult.success) {
    throw new Error(`[${batchLabel}] 导航失败: ${navResult.error ?? '未知错误'}`);
  }
  log('info', `[${batchLabel}] 导航结果: method=${navResult.method}, duration=${navResult.durationMs}ms`);

  const ready = await timedStep(log, batchLabel, 'verifyBusinessPageReady(integrated)', () =>
    verifyBusinessPageReady(page, 'integrated', batchLabel, log),
  );
  if (!ready.ready) {
    throw new Error(`[${batchLabel}] 页面轻量验证未通过: missing=${ready.missing.join(',') || '-'}, popupVisible=${ready.popupVisible}`);
  }

  log('info', `[${batchLabel}] Page Ready (URL=${ready.url})`);
  await takeDiagnosticScreenshot(page, `${batchLabel}_page_ready`);

  // c. 选上一站（天津分拨中心）—— 到派一体专属
  await timedStep(log, batchLabel, 'selectPrevStation', () => selectPrevStation(page, batchLabel, log));

  // d. 勾选"到派一体"选项框 —— 到派一体专属
  await timedStep(log, batchLabel, 'checkIntegratedCheckbox', () => checkIntegratedCheckbox(page, batchLabel, log));

  // e. 选择派件员（失败 throw FatalIntegratedError）
  await timedStep(log, batchLabel, 'selectCourier', () => selectCourier(page, courierVerifyName, employeeId, batchLabel, log));

  // f. 逐个添加运单，检测添加成功/失败
  const { addedWaybills, addFailures } = await timedStep(log, batchLabel, 'addWaybillsOneByOne', () =>
    addWaybillsOneByOne(page, batch, staffName, batchLabel, log),
  );

  // g. 无成功添加则跳过上传
  if (addedWaybills.length === 0) {
    log('warning', `[${batchLabel}] 无运单添加成功，跳过上传`);
    log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
    return addFailures;
  }

  // h. 设200条/页 + 全选 + [DRY-RUN]上传 + toast判定
  await setPageSize200(page, batchLabel, log);
  await selectAll(page, batchLabel, log);

  const uploadResults = await uploadAndJudge(page, addedWaybills, staffName, batchLabel, log, dryRunMode);

  // i. 合并添加失败 + 上传结果
  log('info', `[${batchLabel}] PERF batch total ${Date.now() - batchStart}ms`);
  return [...addFailures, ...uploadResults];
}

/**
 * 选上一站（天津分拨中心）—— 到派一体专属步骤
 * 用 page.evaluate 直接操作 DOM，绕过 Playwright 可见性检查
 */
async function selectPrevStation(
  page: Page,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 选上一站: ${DEFAULT_PREV_STATION}`);

  try {
    // 诊断：点击前截图
    await takeDiagnosticScreenshot(page, `${batchLabel}_prevStation_before_click`);

    // 点击"上一站"下拉框 input
    await timedStep(log, batchLabel, 'prevStation.clickInput', () =>
      page.click(INTEGRATED_SCAN_SELECTORS.prevStationInput, { timeout: TIMEOUT_ELEMENT }),
    );
    await timedStep(log, batchLabel, 'prevStation.waitDropdown', () => page.waitForTimeout(800), 1200);

    // 用 page.evaluate 直接 DOM click 选项（绕过 Playwright 可见性检查）
    const clicked = await timedStep(log, batchLabel, 'prevStation.pickOption', () =>
      page.evaluate((stationName) => {
        const items = document.querySelectorAll('li.el-select-dropdown__item');
        for (const item of items) {
          if (item.textContent && item.textContent.includes(stationName)) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, DEFAULT_PREV_STATION),
    );

    if (clicked) {
      log('info', `[${batchLabel}] 上一站已选择: ${DEFAULT_PREV_STATION}`);
    } else {
      // 兜底：直接输入文本
      log('warning', `[${batchLabel}] 未找到上一站选项，尝试直接输入文本`);
      await timedStep(log, batchLabel, 'prevStation.fillFallback', () =>
        page.fill(INTEGRATED_SCAN_SELECTORS.prevStationInput, DEFAULT_PREV_STATION),
      );
      await timedStep(log, batchLabel, 'prevStation.pressEnterFallback', () => page.keyboard.press('Enter'));
      await timedStep(log, batchLabel, 'prevStation.waitFallback', () => page.waitForTimeout(500), 900);

      // Phase L-2: 验证 fill 后 input 真实值（防止前端防抖截断）
      const stationInput = page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInput);
      const actualStation = await stationInput.first().inputValue().catch(() => '');
      if (!actualStation.includes(DEFAULT_PREV_STATION)) {
        throw new Error(`[${batchLabel}] 上一站 fill 验证失败: 预期包含"${DEFAULT_PREV_STATION}", 实际="${actualStation}"`);
      }
      log('info', `[${batchLabel}] 上一站已输入: ${actualStation}`);
    }
    await timedStep(log, batchLabel, 'prevStation.waitAfterPick', () => page.waitForTimeout(500), 900);

    // 诊断：点击后截图
    await takeDiagnosticScreenshot(page, `${batchLabel}_prevStation_after_click`);
  } catch (e) {
    log('warning', `[${batchLabel}] 选上一站异常: ${(e as Error).message}`);
    await takeScreenshot(page, `${batchLabel}_prevStation_error`);
  }
}

/**
 * 勾选"到派一体"复选框 —— 到派一体专属步骤
 * 勾选后派件员下拉框会动态出现
 */
async function checkIntegratedCheckbox(
  page: Page,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 勾选"到派一体"`);

  try {
    // 检查是否已勾选（Element UI 的 is-checked class）
    const checkedLoc = page.locator('.el-checkbox:has-text("到派一体").is-checked');
    const isChecked = await checkedLoc.count();

    if (isChecked > 0) {
      log('info', `[${batchLabel}] "到派一体"已勾选，跳过`);
      return;
    }

    // 点击 checkbox
    const checkboxLoc = page.locator(INTEGRATED_SCAN_SELECTORS.integratedCheckbox);
    const cbCount = await checkboxLoc.count();

    if (cbCount === 0) {
      throw new Error(`[${batchLabel}] 未找到"到派一体"复选框`);
    }

    await timedStep(log, batchLabel, 'integratedCheckbox.click', () =>
      checkboxLoc.first().click({ timeout: TIMEOUT_BUTTON }),
    );
    await timedStep(log, batchLabel, 'integratedCheckbox.waitCourierField', () => page.waitForTimeout(800), 1200);
    log('info', `[${batchLabel}] "到派一体"已勾选`);
  } catch (e) {
    log('error', `[${batchLabel}] 勾选"到派一体"失败: ${(e as Error).message}`);
    throw e;
  }
}

/**
 * 选择派件员 —— 触发"选择派件员"弹窗，按员工编号精确匹配，点击"使用"按钮
 *
 * 真实 DOM 结构（2026-06-21 诊断）：
 * 派件员字段并非 el-select 下拉，而是点击 input 后弹出 el-dialog__wrapper 弹窗，
 * 弹窗内 el-table 列出所有员工，按员工编号列（el-table_2_column_16）精确匹配，
 * 匹配行右侧固定列（.el-table__fixed-right）内有"使用"按钮。
 *
 * ⚠️ 关键：必须用 Playwright 真实 .click()（page.click / locator.click），
 *    不能用 page.evaluate(el => el.click()) —— 后者不触发 Vue 监听器，
 *    弹窗不会弹出，"使用"按钮点击也不会生效。
 *
 * 流程：
 * 1. Playwright 真实 .click() 点击派件员 input（.arrivalscan_left > div > div:nth-child(12) input）
 * 2. 等待 div.el-dialog__wrapper 弹窗出现（textContent 包含"选择派件员"）
 * 3. 遍历表格行，按 el-table_2_column_16（员工编号列）精确匹配传入的 employeeId（字符串严格相等）
 * 4. 匹配行的 .el-table__fixed-right tbody tr 下的 button.el-button--primary.el-button--mini，
 *    用 Playwright 真实 .click() 点击"使用"按钮
 * 5. 验证：弹窗关闭 + 派件员 input 回填的姓名与传入 staffName 一致
 */
async function selectCourier(
  page: Page,
  staffName: string,
  employeeId: string,
  batchLabel: string,
  log: LogFn,
): Promise<void> {
  log('info', `[${batchLabel}] 选择派件员: ${staffName} (employeeId=${employeeId})`);

  await takeDiagnosticScreenshot(page, `${batchLabel}_courier_before_click`);

  // Step 1: Playwright 真实 .click() 点击派件员 input 触发弹窗
  log('info', `[${batchLabel}] Step1: 点击派件员 input 触发弹窗`);
  const inputLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput);
  const inputCount = await inputLoc.count();
  if (inputCount === 0) {
    log('error', `[${batchLabel}] 未找到派件员 input（选择器: ${INTEGRATED_SCAN_SELECTORS.courierSelectInput}）`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }

  try {
    await timedStep(log, batchLabel, 'courier.clickInput', () =>
      inputLoc.first().click({ timeout: TIMEOUT_ELEMENT }),
    );
  } catch (e) {
    log('error', `[${batchLabel}] 点击派件员 input 失败: ${(e as Error).message}`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }

  // Step 2: 等待"选择派件员"弹窗出现
  log('info', `[${batchLabel}] Step2: 等待"选择派件员"弹窗出现`);
  const dialogLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierDialogWrapper);
  try {
    await timedStep(log, batchLabel, 'courier.waitDialogVisible', () =>
      dialogLoc.waitFor({ state: 'visible', timeout: TIMEOUT_ELEMENT }).then(() => undefined),
    );
  } catch (e) {
    log('error', `[${batchLabel}] "选择派件员"弹窗未出现: ${(e as Error).message}`);
    await takeScreenshot(page, `${batchLabel}_courier_dialog_missing`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }
  log('info', `[${batchLabel}] "选择派件员"弹窗已出现`);

  await takeDiagnosticScreenshot(page, `${batchLabel}_courier_dialog_open`);

  // Step 3: 遍历表格行，按员工编号列（el-table_2_column_16）精确匹配 employeeId
  log('info', `[${batchLabel}] Step3: 遍历表格行按员工编号精确匹配 (employeeId=${employeeId})`);
  const rowLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierDialogTableRow);
  const rowCount = await timedStep(log, batchLabel, 'courier.countRows', () => rowLoc.count());
  log('info', `[${batchLabel}] 弹窗表格行数: ${rowCount}`);

  if (rowCount === 0) {
    log('error', `[${batchLabel}] 弹窗表格无行数据`);
    await takeScreenshot(page, `${batchLabel}_courier_dialog_empty`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }

  // 遍历所有行，按员工编号列精确匹配（字符串严格相等，不用 includes 模糊匹配）
  let matchedRowIdx = -1;
  const idDump: string[] = [];
  await timedStep(log, batchLabel, 'courier.scanEmployeeRows', async () => {
    for (let i = 0; i < rowCount; i++) {
      const idCell = rowLoc.nth(i).locator('td.el-table_2_column_16').first();
      const idText = (await idCell.textContent())?.trim() ?? '';
      idDump.push(idText);
      if (idText === employeeId) {
        matchedRowIdx = i;
        log('info', `[${batchLabel}] 匹配命中: 第${i + 1}行, 员工编号=${idText}`);
        break;
      }
    }
  });

  if (matchedRowIdx === -1) {
    log('error', `[${batchLabel}] 未找到员工编号=${employeeId} 的行。表格中所有员工编号: ${JSON.stringify(idDump)}`);
    await takeScreenshot(page, `${batchLabel}_courier_no_match`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }

  // Step 4: 点击匹配行的"使用"按钮（位于 .el-table__fixed-right 固定列内）
  // Element UI 固定列机制：操作列在主表中 is-hidden，在 .el-table__fixed-right 中可见
  // 匹配行索引在主表和固定列表中是一致的（同一行数据）
  log('info', `[${batchLabel}] Step4: 点击第${matchedRowIdx + 1}行的"使用"按钮`);
  const useButtonLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierUseButton).nth(matchedRowIdx);

  try {
    await timedStep(log, batchLabel, 'courier.clickUseButton', () =>
      fastStableBypassClick(useButtonLoc, TIMEOUT_BUTTON),
    );
  } catch (e) {
    log('error', `[${batchLabel}] 点击"使用"按钮失败: ${(e as Error).message}`);
    await takeScreenshot(page, `${batchLabel}_courier_use_button_error`);
    throw new FatalIntegratedError(staffName, batchLabel);
  }

  // Step 5: 验证 —— 弹窗关闭 + 派件员 input 回填的姓名与传入 staffName 一致
  log('info', `[${batchLabel}] Step5: 验证弹窗关闭 + 派件员 input 回填`);

  // 等待弹窗关闭（Element UI 关闭动画约 300-500ms，给 5s 兜底）
  let dialogClosed = true;
  try {
    await timedStep(log, batchLabel, 'courier.waitDialogHidden', () =>
      dialogLoc.waitFor({ state: 'hidden', timeout: 5000 }).then(() => undefined),
    );
  } catch {
    dialogClosed = false;
  }

  if (!dialogClosed) {
    // 弹窗未关闭 —— 可能是"使用"按钮未生效，但也可能是动画未完成
    // 用派件员 input 回填值做兜底判断：如果已回填正确姓名，说明选择已生效
    const fallbackValue = await page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first().inputValue().catch(() => '');
    if (fallbackValue === staffName) {
      log('warning', `[${batchLabel}] 弹窗未完全关闭，但派件员 input 已回填"${fallbackValue}"，视为选择成功`);
    } else {
      log('error', `[${batchLabel}] "选择派件员"弹窗未关闭且 input 未回填（value="${fallbackValue}"），"使用"按钮可能未生效`);
      await takeScreenshot(page, `${batchLabel}_courier_dialog_not_closed`);
      throw new FatalIntegratedError(staffName, batchLabel);
    }
  } else {
    log('info', `[${batchLabel}] "选择派件员"弹窗已关闭`);
  }

  // 验证派件员 input 回填的姓名与传入 staffName 一致
  const courierInputValue = await timedStep(log, batchLabel, 'courier.verifyInputValue', () =>
    page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first().inputValue().catch(() => ''),
  );
  if (courierInputValue === staffName) {
    log('info', `[${batchLabel}] 派件员 input 回填验证通过: ${courierInputValue}`);
  } else {
    log('warning', `[${batchLabel}] 派件员 input 回填值="${courierInputValue}" 与 staffName="${staffName}" 不一致（弹窗已关闭，继续执行）`);
  }

  await takeDiagnosticScreenshot(page, `${batchLabel}_courier_after_select`);
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
  let lastAggregateAt = Date.now();

  const emitAggregateIfNeeded = (currentIdx: number, force: boolean = false) => {
    const processed = currentIdx + 1;
    const shouldEmit = force
      || (processed % AGGREGATE_INTERVAL === 0)
      || (processed === batch.length);
    if (!shouldEmit || processed === lastAggregateIdx + 1 && !force) return;
    if (processed <= lastAggregateIdx + 1 && !force) return;

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

      // 填入单号
      await itemStep('fill', () =>
        page.fill(INTEGRATED_SCAN_SELECTORS.waybillInput, waybillNo, { timeout: TIMEOUT_ELEMENT }),
      );

      // Phase L-2: 验证 fill 后 input 真实值（防止前端防抖截断或 SPA 重渲染抢焦）
      const inputLoc = page.locator(INTEGRATED_SCAN_SELECTORS.waybillInput);
      const actualValue = await itemStep('verifyInput', () => inputLoc.first().inputValue().catch(() => ''));
      if (actualValue.trim() !== waybillNo.trim()) {
        throw new Error(`填入单号验证失败: 预期="${waybillNo}", 实际="${actualValue}"`);
      }

      // 点击添加（用 locator().first() 避免 strict mode 多匹配报错）
      await itemStep('clickAdd', () =>
        fastStableBypassClick(page.locator(INTEGRATED_SCAN_SELECTORS.addButton).first(), TIMEOUT_BUTTON),
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
 * 统计到派一体表格行数（用于检测添加是否成功）
 */
async function countTableRows(page: Page): Promise<number> {
  const rowsLoc = page.locator(INTEGRATED_TABLE_ROW_SELECTOR);
  return await rowsLoc.count();
}

async function inspectAddFormState(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const input = document.querySelector('#waybillNum') as HTMLInputElement | null;
    const addBtn = document.querySelector('.arrivalscan_left button.el-button--primary') as HTMLButtonElement | null;
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
      `inputDisabled=${input?.disabled ?? 'missing'}`,
      `inputReadonly=${input?.readOnly ?? 'missing'}`,
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
    await page.click(INTEGRATED_SCAN_SELECTORS.pageSizeInput, { timeout: TIMEOUT_BUTTON });
    await page.waitForTimeout(500);

    const optLoc = page.locator(INTEGRATED_SCAN_SELECTORS.pageSizeOption200);
    const optCount = await optLoc.count();
    if (optCount === 0) {
      throw new Error(`[${batchLabel}] Step 分页 未找到 200条/页 选项`);
    }

    await optLoc.first().click();
    await page.waitForTimeout(1500); // 等待分页重新加载

    // Phase L-2: 验证分页组件的 input 确实变成了 "200条/页"
    const pageSizeInput = page.locator(INTEGRATED_SCAN_SELECTORS.pageSizeInput);
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
    const selLoc = page.locator(INTEGRATED_SCAN_SELECTORS.selectAllCheckbox);
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
 * 点击上传确认弹窗中的"确定"按钮
 *
 * 真实执行流程：点击"上传" → 系统弹出 el-message-box 确认弹窗 → 点击"确定" → 提交完成
 *
 * 选择器策略：
 *   1. 限定在 .el-message-box__wrapper 内查找，避免误点页面其他"确定"按钮
 *   2. 优先用户提供的完整 CSS 路径
 *   3. 备用：文本匹配"确定"的 primary 按钮
 */
async function clickUploadConfirmDialog(page: Page, batchLabel: string, log: LogFn): Promise<void> {
  log('info', `[真实执行模式] 等待确认提交弹窗`);

  const dialog = page.locator(INTEGRATED_SCAN_SELECTORS.confirmDialogWrapper);
  try {
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    await takeScreenshot(page, `${batchLabel}_confirm_dialog_missing`);
    throw new Error(`[${batchLabel}] 到派一体点击上传后未出现确认提交弹窗`);
  }

  // 在弹窗内查找"确定"按钮，多策略兜底
  const confirmBtn = dialog.locator(INTEGRATED_SCAN_SELECTORS.confirmButton).last();
  try {
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    // 备用：文本匹配"确定"
    const fallbackBtn = dialog.locator('button:has-text("确定")').last();
    try {
      await fallbackBtn.waitFor({ state: 'visible', timeout: 3000 });
      await fallbackBtn.click({ timeout: TIMEOUT_BUTTON });
    } catch {
      await takeScreenshot(page, `${batchLabel}_confirm_button_missing`);
      throw new Error(`[${batchLabel}] 到派一体确认提交弹窗中未找到"确定"按钮`);
    }
    log('info', `[真实执行模式] 已点击确认弹窗：确定（备用选择器）`);
    return;
  }

  await confirmBtn.click({ timeout: TIMEOUT_BUTTON });
  log('info', `[真实执行模式] 已点击确认弹窗：确定`);
}

/**
 * [DRY-RUN 检查点] 上传 + toast 判定
 *
 * ⚠️ DRY-RUN 模式：跳过真实点击上传，直接返回 UNKNOWN
 * 真实模式：点击上传 → 确认弹窗 → 等待 toast → 四态判定（复用 arriveScanResult）
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
    log('info', `[试运行模式] 到派一体已执行到最终提交前，跳过真实提交 (${addedWaybills.length}条)`);
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

  log('info', `[真实执行模式] 即将点击"上传"按钮，执行真实到派一体提交 (${addedWaybills.length}条)`);
  // 真实上传
  log('info', `[${batchLabel}] 点击上传 (${addedWaybills.length}条)`);
  await takeDiagnosticScreenshot(page, `${batchLabel}_before_upload`);

  // Phase L-2: 记录上传前表格行数（用于 DOM 回退判定）
  const rowLoc = page.locator(INTEGRATED_TABLE_ROW_SELECTOR);
  const rowsBeforeUpload = await timedStep(log, batchLabel, 'upload.countRowsBefore', () =>
    rowLoc.count().catch(() => -1),
  );

  let clicked = false;
  try {
    await timedStep(log, batchLabel, 'upload.clickButton', () =>
      page.locator(INTEGRATED_SCAN_SELECTORS.uploadButton).first().click({ timeout: TIMEOUT_BUTTON }),
    );
    clicked = true;
  } catch (e) {
    log('warning', `[${batchLabel}] 点击上传按钮失败: ${(e as Error).message}`);
  }

  if (!clicked) {
    throw new Error(`[${batchLabel}] 未找到"上传"按钮`);
  }

  // 点击"上传"后，系统弹出确认弹窗（"是否确认提交?"），需点击"确定"才真正提交
  await timedStep(log, batchLabel, 'upload.confirmDialog', () => clickUploadConfirmDialog(page, batchLabel, log));

  await takeDiagnosticScreenshot(page, `${batchLabel}_after_upload`);

  // Phase L-2: Toast 重试 + DOM 回退判定（与到件/派件扫描保持一致）
  let toastMsg = await timedStep(log, batchLabel, 'upload.waitToast', () => waitForToast(page, TIMEOUT_TOAST));

  if (toastMsg.includes('timeout:未收到系统响应')) {
    log('warning', `[${batchLabel}] 首次 toast 超时，等待 2s 后重试`);
    await page.waitForTimeout(2000);
    toastMsg = await timedStep(log, batchLabel, 'upload.waitToastRetry', () => waitForToast(page, 5000));

    if (toastMsg.includes('timeout:未收到系统响应')) {
      // DOM 回退判定：对比上传前后表格行数变化
      log('warning', `[${batchLabel}] 二次 toast 仍超时，使用 DOM 回退判定`);
      const rowsAfterUpload = await timedStep(log, batchLabel, 'upload.countRowsAfterFallback', () =>
        rowLoc.count().catch(() => -1),
      );

      if (rowsBeforeUpload >= 0 && rowsAfterUpload === 0) {
        toastMsg = '批量到件成功';
        log('info', `[${batchLabel}] DOM回退判定: 表格已清空 (${rowsBeforeUpload}→0)，认为提交成功`);
      } else if (rowsBeforeUpload >= 0 && rowsAfterUpload > 0 && rowsAfterUpload < rowsBeforeUpload) {
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

  // 四态判定（复用到件扫描判定，到派一体在到件扫描页面操作，toast 文案应一致）
  const outcome = parseArriveScanResult(toastMsg, addedWaybills.length);
  log('info', `[${batchLabel}] 判定: status=${outcome.status}, success=${outcome.successCount ?? '?'}, fail=${outcome.failCount ?? '?'}`);

  await takeDiagnosticScreenshot(page, `${batchLabel}_done`);

  // PARTIAL/UNKNOWN 无法按单号归因，全批统一标记（与到件/派件扫描一致）
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
