import type { Page } from 'playwright';
import { PageStateManager } from '../browser/PageStateManager';
import { NavigationGovernance } from '../browser/NavigationGovernance';
import { captureFailureScreenshot } from '../browser/PageNavigator';
import type { OperationResult } from './BaseOperation';
import type { LogContext } from '../utils/TaskLogManager';
import { SignExecutor } from './core/signExecutor';
import { SUPPORTED_SIGNERS as _SUPPORTED_SIGNERS, DEFAULT_PAGE_SIZE } from './selectors/signSelectors';
import { formatDuration } from '../reports/executionReport';

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
  const isDryRun = dryRunMode ?? true;

  // Phase 2-B2: 签收人校验
  if (signerPerson && !['本人', '家人', '家门口', '代收点'].includes(signerPerson)) {
    throw new Error(`非法签收人参数: "${signerPerson}"，允许值: 本人, 家人, 家门口, 代收点`);
  }

  try {
    log('info', `[${staffLabel}] 进入签收页面${isDryRun ? ' [试运行模式]' : ''}`);
    const navGov = NavigationGovernance.getInstance();
    const navResult = await navGov.navigateTo(page, 'sign');
    // 诊断日志：记录导航细节
    log('info', `[${staffLabel}] 导航结果: method=${navResult.method}, success=${navResult.success}, targetUrl=${navResult.targetUrl}, menuSuccess=${navResult.menuSuccess}, fallbackUsed=${navResult.fallbackUsed}`);
    if (!navResult.success) {
      throw new Error(`导航失败: ${navResult.error ?? '未知错误'} (当前URL: ${page.url()})`);
    }
    await page.waitForTimeout(NAV_SETTLE);

    log('info', `[${staffLabel}] 导航后URL: ${page.url()}`);

    // 尝试用 Escape 关闭可能的弹窗（不点击按钮，防止触发重定向）
    try {
      const msgBox = await page.$('.el-message-box__wrapper:not([style*="display: none"])').catch(() => null);
      if (msgBox) {
        const isVisible = await msgBox.isVisible().catch(() => false);
        if (isVisible) {
          const popupText = (await msgBox.textContent().catch(() => ''))?.trim().slice(0, 100) ?? '';
          log('info', `[${staffLabel}] 检测到弹窗: "${popupText}"，尝试 Escape 关闭`);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          // 检查是否跳转
          const newUrl = page.url();
          if (!newUrl.includes('/scanning/signFor/signForInput')) {
            log('warning', `[${staffLabel}] Escape 关闭弹窗后页面跳转: ${newUrl}`);
            // 弹窗关闭导致跳转，需要重新导航
            const reNav = await navGov.navigateTo(page, 'sign');
            if (!reNav.success) {
              throw new Error(`弹窗关闭后重导航失败: ${reNav.error}`);
            }
            await page.waitForTimeout(NAV_SETTLE);
            log('info', `[${staffLabel}] 重导航后URL: ${page.url()}`);
          }
        }
      }
    } catch { /* 忽略弹窗处理异常 */ }

    log('info', `[${staffLabel}] PageStateManager.ensureReadyForTask('sign')`);
    const stateMgr = PageStateManager.getInstance();
    const state = await stateMgr.ensureReadyForTask(page, 'sign', {
      autoFix: true,
      maxAutoFixRetries: 1,
    });

    if (!state.ready) {
      // 诊断：输出更多细节
      log('warning', `[${staffLabel}] 页面URL: ${state.url.actual}; 预期: ${state.url.expected}; missingElements: ${state.elements.missing.join(', ')}; popupsBlocking: ${state.elements.popupsBlocking}`);
      throw new Error(`页面状态检查未通过: ${state.blockedBy.join(', ')}`);
    }

    log('info', `[${staffLabel}] 签收页面已就绪 (URL=${state.url.actual})`);

    const executorLog = createExecutorLogger(log, staffLabel);
    const executor = new SignExecutor(page, executorLog, isDryRun);

    await executor.setDateRangeToday();
    // Phase 2-B2: 指定模式用目标派件员搜索，默认模式用 staffName
    await executor.selectCourier(effectiveCourierName);
    if (executionMode === 'designated') {
      const accountMsg = targetCourierAccount ? ` / ${targetCourierAccount}` : '（账号未知，按姓名匹配）';
      log('info', `[${staffLabel}] 签收录入使用目标派件员：${effectiveCourierName}${accountMsg}`);
    }

    const pageSize = assignment.pageSize ?? DEFAULT_PAGE_SIZE;
    log('info', `[${staffLabel}] 使用分页大小: ${pageSize}条/页`);
    // Phase 2-B2: 透传 signerPerson，指定模式单一签收人跳过比例分配
    const batchResult = await executor.executeBatchFlow(pageSize, signerPerson);
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
      const ssPath = await captureFailureScreenshot(page, taskId, `sign_${staffName}`);
      if (ssPath) log('error', `异常截图已保存 路径: ${ssPath}`);
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
