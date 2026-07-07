import type { Page } from 'playwright';
import { captureFailureScreenshot } from '../browser/PageNavigator';
import type { OperationResult } from './BaseOperation';
import type { LogContext } from '../utils/TaskLogManager';
import { SignExecutor } from './core/signExecutor';
import { SUPPORTED_SIGNERS as _SUPPORTED_SIGNERS, DEFAULT_PAGE_SIZE } from './selectors/signSelectors';
import { formatDuration } from '../reports/executionReport';
import { BusinessPageNavigator } from '../browser/BusinessPageNavigator';
import { SettingsManager } from '../config/SettingsManager';
import { verifyBusinessPageReady } from './businessPageReady';

export const SUPPORTED_SIGNERS = _SUPPORTED_SIGNERS;
export type SupportedSigner = typeof SUPPORTED_SIGNERS[number];

export interface SignAssignment {
  staffName: string;
  waybillNos: string[];
  signer?: string;
  pageSize?: 30 | 50 | 100 | 200;
  /** Phase 2-B: 指定模式 — 入参透传 */
  executionMode?: 'default' | 'designated';
  targetCourierName?: string;
  targetCourierAccount?: string;
  /** Phase 2-B: 指定模式签收 — 签收人 */
  signerPerson?: '本人' | '家人' | '家门口' | '代收点';
}

type LogFn = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void;

const NAV_SETTLE = 1500;
const SLOW_STEP_MS = 1500;  // Phase 5-G-8: 超过该耗时的子步骤输出 warning

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

function createExecutorLogger(log: LogFn, staffLabel: string): (level: 'info' | 'warning' | 'error', msg: string) => void {
  return (level, msg) => log(level, `[${staffLabel}] ${msg}`);
}

export async function executeSign(
  page: Page,
  assignment: SignAssignment,
  log: LogFn,
  taskId?: string,
  dryRunMode?: boolean,
): Promise<OperationResult[]> {
  const { staffName, targetCourierName, targetCourierAccount, executionMode, signerPerson } = assignment;
  const staffLabel = `员工:${staffName}`;
  // Phase 2-B2: 指定模式下使用目标派件员搜索签收运单，signerPerson 单一签收人
  const effectiveCourierName = targetCourierName || staffName;
  let isDryRun = dryRunMode ?? true;

  // Phase 5-I-1: 安全门 — dryRun=false 但未开启真实提交开关
  if (!isDryRun && !SettingsManager.isRealSubmitAllowed()) {
    log('warning', '[安全门] 真实执行开关已传递到执行层，但当前未开启 ENABLE_REAL_SUBMIT，签收将停止在确认弹窗前');
    isDryRun = true; // 强制 dry-run，保护真实签收
  }

  // Phase 2-B2: 签收人校验
  if (signerPerson && !['本人', '家人', '家门口', '代收点'].includes(signerPerson)) {
    throw new Error(`非法签收人参数: "${signerPerson}"，允许值: 本人, 家人, 家门口, 代收点`);
  }

  try {
    // Phase 5-G-8-4: 统一使用 BusinessPageNavigator 导航到签收录入页面
    log('info', `[${staffLabel}] 进入签收页面${isDryRun ? ' [试运行模式]' : ''}`);
    const businessNav = BusinessPageNavigator.getInstance();
    const navResult = await timedStep(log, staffLabel, 'navigateToBusinessPage(sign)', () =>
      businessNav.navigateToBusinessPage(page, 'sign', {
        staffName,
        log: (level, msg) => log(level, `[${staffLabel}] ${msg}`),
      }),
    );
    log('info', `[${staffLabel}] 导航结果: method=${navResult.method}, success=${navResult.success}, duration=${navResult.durationMs}ms${navResult.error ? `, error=${navResult.error}` : ''}`);
    if (!navResult.success) {
      throw new Error(`导航失败: ${navResult.error ?? '未知错误'} (当前URL: ${page.url()})`);
    }
    await timedStep(log, staffLabel, `wait nav settle ${NAV_SETTLE}ms`, () => page.waitForTimeout(NAV_SETTLE), NAV_SETTLE + 500);

    log('info', `[${staffLabel}] 导航后URL: ${page.url()}`);

    const ready = await timedStep(log, staffLabel, 'verifyBusinessPageReady(sign)', () =>
      verifyBusinessPageReady(page, 'sign', staffLabel, log),
    );

    if (!ready.ready) {
      log('warning', `[${staffLabel}] 页面URL: ${ready.url}; missingElements: ${ready.missing.join(', ') || '-'}; popupVisible: ${ready.popupVisible}`);
      throw new Error(`页面轻量验证未通过`);
    }

    log('info', `[${staffLabel}] 签收页面已就绪 (URL=${ready.url})`);

    const executorLog = createExecutorLogger(log, staffLabel);
    const executor = new SignExecutor(page, executorLog, isDryRun);

    await timedStep(log, staffLabel, 'setDateRangeToday', () => executor.setDateRangeToday());
    // Phase 2-B2: 指定模式用目标派件员搜索，默认模式用 staffName
    await timedStep(log, staffLabel, 'selectCourier', () => executor.selectCourier(effectiveCourierName));
    if (executionMode === 'designated') {
      const accountMsg = targetCourierAccount ? ` / ${targetCourierAccount}` : '（账号未知，按姓名匹配）';
      log('info', `[${staffLabel}] 签收录入使用目标派件员：${effectiveCourierName}${accountMsg}`);
    }

    const pageSize = assignment.pageSize ?? DEFAULT_PAGE_SIZE;
    log('info', `[${staffLabel}] 使用分页大小: ${pageSize}条/页`);
    // Phase 2-B2: 透传 signerPerson，指定模式单一签收人跳过比例分配
    const batchResult = await timedStep(log, staffLabel, 'executeBatchFlow', () =>
      executor.executeBatchFlow(pageSize, signerPerson),
    );
    const report = batchResult.report;

    const plan = batchResult.signPlan;
    const planSummary = plan
      ? `签收计划：共${plan.totalPages}页（本人${plan.counts['本人'] ?? 0}页/家人${plan.counts['家人'] ?? 0}页/家门口${plan.counts['家门口'] ?? 0}页/代收点${plan.counts['代收点'] ?? 0}页）`
      : '';

    const durationStr = formatDuration(report.durationMs);

    const reportSummary = [
      isDryRun ? '试运行模式' : '签收执行',
      `总${report.totalPages}页/成功${report.successPages}页/失败${report.failedPages}页`,
      `选中${report.totalSelected}条`,
      `耗时${durationStr}`,
    ].join('，');

    const signerStatsStr = [
      `本人${report.signerStats['本人'] ?? 0}页`,
      `家人${report.signerStats['家人'] ?? 0}页`,
      `家门口${report.signerStats['家门口'] ?? 0}页`,
      `代收点${report.signerStats['代收点'] ?? 0}页`,
    ].join('/');

    let message: string;
    if (isDryRun) {
      message = `[试运行模式] 签收录入已执行到最终确认前，跳过真实签收提交：共${batchResult.totalSelected}条记录；${planSummary}；${reportSummary}；${signerStatsStr}`;
    } else {
      message = `签收完成：${reportSummary}；${signerStatsStr}`;
    }

    if (report.failedPages > 0) {
      const errBrief = report.errors.map(e => `P${e.pageNum}(${e.signer}): ${e.message}`).join('; ');
      message += `；错误：${errBrief}`;
    }

    log('info', `[${staffLabel}] ${message}`);

    return [{
      waybillNo: 'SIGN_PREVIEW',
      staffName,
      success: report.failedPages === 0,
      message,
      timestamp: Date.now(),
      status: isDryRun ? 'DRY_RUN_SKIPPED' : (report.failedPages === 0 ? 'SUCCESS' : 'FAILED'),
      dryRun: isDryRun,
      skippedFinalSubmit: isDryRun,
    }];
  } catch (err) {
    if (taskId) {
      await captureFailureScreenshot(page, taskId, `sign_${staffName}`).catch(() => '');
    }

    const errMsg = (err as Error).message;
    log('error', `[${staffLabel}] 签收执行失败: ${errMsg}`);
    return [{
      waybillNo: 'SIGN_PREVIEW',
      staffName,
      success: false,
      message: `签收执行失败: ${errMsg}`,
      timestamp: Date.now(),
      status: 'FAILED',
    }];
  }
}

export { PaginationAdapter } from './adapters/paginationAdapter';
export { OrderListAdapter } from './adapters/orderListAdapter';
export { SignExecutor } from './core/signExecutor';
export { SIGN_SELECTORS, DEFAULT_PAGE_SIZE, DEFAULT_SIGNER } from './selectors/signSelectors';
export { STANDARD_SIGNERS } from '../config/signConfig';
export { generateAssignments, generateSignPlan, formatSignPlanLog } from '../utils/signAssignmentGenerator';
export type { SignPlan } from '../utils/signAssignmentGenerator';
export type { SignerConfig } from '../config/signConfig';
export { ExecutionLogger, createExecutionLogger } from '../logger/executionLogger';
export type { LogLevel, LogContext as ExecutionLogContext, ExternalLogFn } from '../logger/executionLogger';
export { ExecutionReportBuilder, formatExecutionReport, formatDuration } from '../reports/executionReport';
export type { ExecutionReport, ExecutionError } from '../reports/executionReport';
export { captureSignFailureScreenshot } from '../screenshots/captureFailure';
