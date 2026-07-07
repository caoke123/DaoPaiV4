/**
 * DispatchExecutor — 派件扫描 Agent 本地执行器
 *
 * Phase K-2B: Dispatch 从 Cloud run-engine 兼容路径迁回 Agent。
 * Phase K-2C: 支持多员工 assignments 顺序执行，避免串员工、串单号。
 */

import type { AxiosInstance } from 'axios';
import type { Page } from 'playwright-core';
import {
  reportProgress,
  completeTask,
  failTask,
  queryWindowConnections,
} from '../httpClient';
import { createAgentLogger } from '../logger/AgentLogger';
import type { AgentSettingsLoader } from '../AgentSettingsLoader';
import { BrowserManager } from '../browser/BrowserManager';
import { detectBnsyDashboardP0 } from '../browser/BnsyDashboardDetector';
import { runDispatchBrowserDryRun } from '../browser/DispatchBrowserDryRun';
import {
  registerNativeAlertGuard,
  drainNativeAlerts,
  ensureCleanHome,
  restoreCleanHome,
  afterPageChangedCleanup,
  createRuntimeLogFn,
} from '../browser/AgentBusinessRuntime';
import type { AgentConfig } from '../types';
import type { WindowConnection } from '../httpClient';
import { acquireWindowBusy, releaseWindowBusy } from '../local-runtime/WindowBusyRegistry';

type DispatchMode = 'default' | 'specified';

interface DispatchAssignment {
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  courierName?: string;
  targetCourierName?: string;
  dispatchStaffName?: string;
  windowId?: string;
  waybillNos?: string[];
  waybills?: string[];
  mode?: string;
  dispatchMode?: string;
  executionMode?: string;
}

interface DispatchPayload {
  waybillNos?: string[];
  waybills?: string[];
  assignments?: DispatchAssignment[];
  inputData?: {
    waybillNos?: string[];
    waybills?: string[];
    assignments?: DispatchAssignment[];
  };
  options?: Record<string, unknown>;
  siteName?: string;
  dryRun?: boolean;
  dryRunMode?: boolean;
  browserDryRun?: boolean;
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  courierName?: string;
  targetCourierName?: string;
  dispatchStaffName?: string;
  windowId?: string;
  mode?: string;
  dispatchMode?: string;
  executionMode?: string;
}

interface DispatchTask {
  taskId: string;
  siteId: string;
  tenantId?: string;
  workstationId?: string;
  payload: DispatchPayload;
}

interface DispatchAgentAssignment {
  executionStaffName: string;
  targetCourierName: string;
  targetCourierExplicit: boolean;
  windowId: string;
  waybillNos: string[];
  mode: DispatchMode;
}

interface AssignmentRunResult {
  executionStaffName: string;
  targetCourierName?: string;
  windowId?: string;
  mode?: DispatchMode;
  success: boolean;
  summary: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  successCount: number;
  failedCount: number;
  error?: string;
}

interface PreparedDispatchAssignment {
  assignment: DispatchAgentAssignment;
  assignmentIndex: number;
  matchedWindow?: WindowConnection;
  preflightError?: string;
}

function uniqueNonEmpty(values: unknown[]): string[] {
  return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))];
}

function firstString(...values: unknown[]): string {
  return String(values.find(v => typeof v === 'string' && v.trim()) || '').trim();
}

function optionString(options: Record<string, unknown> | undefined, key: string): string {
  return firstString(options?.[key]);
}

function normalizeDispatchMode(value: string): DispatchMode {
  const normalized = value.trim().toLowerCase();
  if (['specified', 'designated', 'target', 'manual', '指定', '指定派件员'].includes(normalized)) {
    return 'specified';
  }
  return 'default';
}

function collectAssignments(payload: DispatchPayload): DispatchAssignment[] {
  const direct = Array.isArray(payload.assignments) ? payload.assignments : [];
  const input = Array.isArray(payload.inputData?.assignments) ? payload.inputData!.assignments! : [];
  return direct.length > 0 ? direct : input;
}

function collectTopLevelWaybills(payload: DispatchPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(payload.waybillNos) ? payload.waybillNos : []),
    ...(Array.isArray(payload.waybills) ? payload.waybills : []),
    ...(Array.isArray(payload.inputData?.waybillNos) ? payload.inputData!.waybillNos! : []),
    ...(Array.isArray(payload.inputData?.waybills) ? payload.inputData!.waybills! : []),
  ]);
}

function collectAssignmentWaybills(assignment: DispatchAssignment): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(assignment.waybillNos) ? assignment.waybillNos : []),
    ...(Array.isArray(assignment.waybills) ? assignment.waybills : []),
  ]);
}

function parseOneAssignment(
  payload: DispatchPayload,
  assignment: DispatchAssignment,
  waybillNos: string[],
): DispatchAgentAssignment {
  const options = payload.options || {};
  const executionStaffName = firstString(
    assignment.executionStaffName,
    assignment.windowStaffName,
    assignment.staffName,
    assignment.workerName,
    payload.executionStaffName,
    payload.windowStaffName,
    payload.staffName,
    payload.workerName,
    optionString(options, 'executionStaffName'),
    optionString(options, 'windowStaffName'),
    optionString(options, 'staffName'),
    optionString(options, 'workerName'),
    assignment.courierName,
    payload.courierName,
    optionString(options, 'courierName'),
  );

  const explicitTargetCourierName = firstString(
    assignment.targetCourierName,
    assignment.dispatchStaffName,
    assignment.courierName,
    payload.targetCourierName,
    payload.dispatchStaffName,
    payload.courierName,
    optionString(options, 'targetCourierName'),
    optionString(options, 'dispatchStaffName'),
    optionString(options, 'courierName'),
  );

  const modeField = firstString(
    assignment.dispatchMode,
    assignment.executionMode,
    assignment.mode,
    payload.dispatchMode,
    payload.executionMode,
    payload.mode,
    optionString(options, 'dispatchMode'),
    optionString(options, 'executionMode'),
    optionString(options, 'mode'),
  );
  const mode = explicitTargetCourierName && explicitTargetCourierName !== executionStaffName
    ? 'specified'
    : normalizeDispatchMode(modeField);

  return {
    executionStaffName,
    targetCourierName: explicitTargetCourierName || executionStaffName,
    targetCourierExplicit: !!explicitTargetCourierName,
    windowId: firstString(
      assignment.windowId,
      payload.windowId,
      optionString(options, 'windowId'),
      executionStaffName ? `staff-${executionStaffName}` : '',
    ),
    waybillNos,
    mode,
  };
}

function createDispatchRuntimeProof(): string {
  return '[RuntimeProof][DispatchExecutor] mode=READY_CDP_ATTACH noNewChrome=true noRelogin=true parallel=true';
}

const MAX_DISPATCH_ASSIGNMENT_CONCURRENCY = 5;

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<AssignmentRunResult>,
): Promise<PromiseSettledResult<AssignmentRunResult>[]> {
  const results: PromiseSettledResult<AssignmentRunResult>[] = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = { status: 'fulfilled', value: await worker(items[currentIndex]) };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

function makePreflightFailureResult(assignment: DispatchAgentAssignment, message: string): AssignmentRunResult {
  const failedResults = makeFailedResults(assignment, message);
  return {
    executionStaffName: assignment.executionStaffName,
    targetCourierName: assignment.targetCourierName,
    windowId: assignment.windowId,
    mode: assignment.mode,
    success: false,
    summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
    results: failedResults,
    successCount: 0,
    failedCount: failedResults.length,
    error: message,
  };
}

async function prepareDispatchAssignments(
  task: DispatchTask,
  client: AxiosInstance,
  assignments: DispatchAgentAssignment[],
): Promise<PreparedDispatchAssignment[]> {
  const { siteId } = task;
  let readyWindows: WindowConnection[] = [];
  let allWindows: WindowConnection[] = [];

  try {
    const ready = await queryWindowConnections(client, { siteId, status: 'ready' });
    readyWindows = ready.windows;
  } catch (err) {
    const message = `READY_WINDOW_QUERY_FAILED: ${(err as Error).message}`;
    return assignments.map((assignment, assignmentIndex) => ({ assignment, assignmentIndex, preflightError: message }));
  }

  try {
    const all = await queryWindowConnections(client, { siteId });
    allWindows = all.windows;
  } catch {
    allWindows = readyWindows;
  }

  const usedWindowIds = new Set<string>();

  return assignments.map((assignment, assignmentIndex) => {
    if (!assignment.executionStaffName) {
      return {
        assignment,
        assignmentIndex,
        preflightError: 'READY_WINDOW_STAFF_MISMATCH: 未找到执行窗口员工，无法匹配 READY 窗口',
      };
    }

    const matched = readyWindows.find(w => assignment.windowId && w.windowId === assignment.windowId)
      || readyWindows.find(w => w.staffName === assignment.executionStaffName);

    if (!matched) {
      const visible = allWindows
        .map(w => `${w.staffName || '(空)'}:${w.windowId}:${w.status}:cdpAttachable=${w.cdpAttachable}`)
        .join(', ') || '(none)';
      const staffWindows = allWindows.filter(w => w.staffName === assignment.executionStaffName);
      const suffix = staffWindows.length > 0
        ? `；visible windows: ${visible}`
        : `；visible windows: ${visible}`;
      return {
        assignment,
        assignmentIndex,
        preflightError: `READY_WINDOW_NOT_FOUND: staffName=${assignment.executionStaffName} siteId=${siteId}${suffix}`,
      };
    }

    if (matched.siteId !== siteId) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_SITE_MISMATCH: 窗口 siteId=${matched.siteId}，任务 siteId=${siteId}，不一致`,
      };
    }
    if (matched.staffName !== assignment.executionStaffName) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_STAFF_MISMATCH: 窗口 staffName=${matched.staffName}，任务 executionStaffName=${assignment.executionStaffName}，不一致`,
      };
    }
    if (!matched.cdpAttachable) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_NOT_ATTACHABLE: 窗口 ${matched.windowId} cdpAttachable=false，可能是旧窗口或 CDP 开关未启用`,
      };
    }
    if (!matched.cdpEndpoint) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空，无法连接`,
      };
    }
    if (usedWindowIds.has(matched.windowId)) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_DUPLICATED: 窗口 ${matched.windowId} 被多个 assignment 同时使用，已拒绝并发执行`,
      };
    }

    usedWindowIds.add(matched.windowId);
    return { assignment, assignmentIndex, matchedWindow: matched };
  });
}

function parseDispatchAssignments(payload: DispatchPayload): DispatchAgentAssignment[] {
  const assignments = collectAssignments(payload);
  if (assignments.length > 0) {
    return assignments.map(a => parseOneAssignment(payload, a, collectAssignmentWaybills(a)));
  }

  const topLevelWaybills = collectTopLevelWaybills(payload);
  if (topLevelWaybills.length === 0) return [];
  return [parseOneAssignment(payload, {}, topLevelWaybills)];
}

function makeFailedResults(
  assignment: DispatchAgentAssignment,
  message: string,
): Array<Record<string, unknown>> {
  return assignment.waybillNos.map(waybillNo => ({
    waybillNo,
    staffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    status: 'failed',
    message: `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，失败：${message}`,
  }));
}

function makeAssignmentSummary(
  assignment: DispatchAgentAssignment,
  successCount: number,
  failedCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionStaffName: assignment.executionStaffName,
    targetCourierName: assignment.targetCourierName,
    dispatchMode: assignment.mode,
    windowId: assignment.windowId,
    total: assignment.waybillNos.length,
    successCount,
    failedCount,
    finalSubmitClicked: false,
    ...extra,
  };
}

async function executeOneDispatchAssignment(
  task: DispatchTask,
  assignment: DispatchAgentAssignment,
  assignmentIndex: number,
  assignmentCount: number,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config: AgentConfig | undefined,
  browserDryRun: boolean,
  siteName: string,
  preMatchedWindow?: WindowConnection,
  preflightError?: string,
): Promise<AssignmentRunResult> {
  const { taskId, siteId } = task;
  const meta = { staffName: assignment.executionStaffName, windowId: assignment.windowId, siteId };
  const logger = createAgentLogger(client, taskId);
  const log = createRuntimeLogFn(logger, meta);
  let page: Page | null = null;
  let busyWindowId: string | null = null;

  const failAssignment = async (message: string): Promise<AssignmentRunResult> => {
    logger.error(`[Agent][Dispatch] ${message}`, meta);
    await logger.flush();
    const failedResults = makeFailedResults(assignment, message);
    return {
      executionStaffName: assignment.executionStaffName,
      targetCourierName: assignment.targetCourierName,
      windowId: meta.windowId,
      mode: assignment.mode,
      success: false,
      summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
      results: failedResults,
      successCount: 0,
      failedCount: failedResults.length,
      error: message,
    };
  };

  try {
    const runtimeProof = createDispatchRuntimeProof();
    console.log(runtimeProof);
    console.log(`[Agent][Dispatch][${assignment.executionStaffName || 'unknown'}] parallel assignment start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'} mode=${assignment.mode} executionStaff=${assignment.executionStaffName || '(empty)'} targetCourier=${assignment.targetCourierName || '(empty)'}`);
    logger.info(runtimeProof, meta);
    logger.info('[Agent][Dispatch][Guard] DISPATCH_NEW_BROWSER_FORBIDDEN active; DISPATCH_RELOGIN_FORBIDDEN active', meta);
    logger.info(`[Agent][Dispatch][${assignment.executionStaffName || 'unknown'}] parallel assignment start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'}`, meta);
    logger.info(`[Agent][Dispatch] 开始处理 assignment ${assignmentIndex + 1}/${assignmentCount}`, meta);
    logger.info(`[Agent][Dispatch] 模式=${assignment.mode}，执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，单号数量=${assignment.waybillNos.length}`, meta);

    if (assignment.waybillNos.length === 0) {
      return failAssignment('assignment 未找到 waybillNos，跳过该员工');
    }
    if (!assignment.executionStaffName) {
      return failAssignment('未找到执行窗口员工，无法匹配登录凭据');
    }
    if (assignment.mode === 'specified' && !assignment.targetCourierExplicit) {
      return failAssignment('指定模式缺少目标派件员');
    }
    if (preflightError) {
      return failAssignment(preflightError);
    }

    logger.info(`[Agent][Dispatch][执行配置] browserDryRun=${browserDryRun}`, meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Dispatch][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交', meta);
    }
    logger.info(`[Agent][Dispatch] 网点：${siteName}，运单数：${assignment.waybillNos.length}`, meta);

    logger.info('[Agent][Dispatch] 使用 preflight READY 窗口匹配结果', meta);
    await logger.flush();

    if (!preMatchedWindow) {
      return failAssignment(`READY_WINDOW_NOT_FOUND: staffName=${assignment.executionStaffName} siteId=${siteId}`);
    }
    const matched = preMatchedWindow;

    if (matched.siteId !== siteId) {
      return failAssignment(`READY_WINDOW_SITE_MISMATCH: 窗口 siteId=${matched.siteId}，任务 siteId=${siteId}，不一致`);
    }
    if (matched.staffName !== assignment.executionStaffName) {
      return failAssignment(`READY_WINDOW_STAFF_MISMATCH: 窗口 staffName=${matched.staffName}，任务 executionStaffName=${assignment.executionStaffName}，不一致`);
    }
    if (!matched.cdpAttachable) {
      return failAssignment(`READY_WINDOW_NOT_ATTACHABLE: 窗口 ${matched.windowId} cdpAttachable=false，可能是旧窗口或 CDP 开关未启用`);
    }
    if (!matched.cdpEndpoint) {
      return failAssignment(`READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空，无法连接`);
    }

    meta.windowId = matched.windowId;
    acquireWindowBusy({
      windowId: matched.windowId,
      taskId,
      siteId,
      staffName: assignment.executionStaffName,
      taskType: 'dispatch',
    });
    busyWindowId = matched.windowId;
    logger.info(`[Agent][Dispatch] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId} cdpAttachable=true`, meta);
    console.log(`[Agent][Dispatch] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId}`);

    logger.info(`[Agent][Dispatch] connectOverCDP 开始 windowId=${matched.windowId}`, meta);
    console.log(`[Agent][Dispatch] connectOverCDP 开始 windowId=${matched.windowId}`);
    try {
      const { page: cdpPage } = await BrowserManager.connectExisting(matched.cdpEndpoint);
      page = cdpPage;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[Agent][Dispatch] CDP_CONNECT_FAILED: ${msg}`, meta);
      return failAssignment(`CDP_CONNECT_FAILED: ${msg}`);
    }

    logger.success(`[Agent][Dispatch] connectOverCDP 成功 windowId=${matched.windowId}`, meta);
    logger.info('[Agent][Dispatch] 使用 READY 窗口执行，不新开 Chrome', meta);
    console.log(`[Agent][Dispatch] connectOverCDP 成功 windowId=${matched.windowId}`);

    registerNativeAlertGuard(page, log, meta);
    logger.info('[Agent][Dispatch] Native alert guard 已注册', meta);
    await drainNativeAlerts(page, 1200, 150, log, meta);

    logger.info('[Agent][Dispatch] 验证 READY 窗口 Dashboard 状态...', meta);
    const dashboardStatus = await detectBnsyDashboardP0(page);
    await drainNativeAlerts(page, 2500, 150, log, meta);
    if (!dashboardStatus.isLoggedIn || dashboardStatus.status !== 'READY') {
      return failAssignment(`READY_WINDOW_DASHBOARD_NOT_READY: 窗口 ${matched.windowId} 登录态已失效，当前状态=${dashboardStatus.status}。READY 窗口接管要求预登录窗口，不执行重登。`);
    }

    logger.success(`[Agent][Dispatch] READY 窗口 Dashboard 验证通过: ${dashboardStatus.message}`, meta);
    logger.info('[Agent][Dispatch] 不新开 Chrome，不重新登录', meta);

    // Phase K-2E/R1: guard 已在登录前注册；这里进入首页清理。
    const homeResult = await ensureCleanHome(page, log, meta);
    if (!homeResult.success) {
      logger.warning(`[Agent][Dispatch] ensureCleanHome 失败: ${homeResult.error}，继续尝试业务导航`, meta);
    }

    logger.info('[Agent][Dispatch] 准备进入派件扫描页面', meta);
    logger.info(`[Agent][Dispatch] 准备填写单号，数量=${assignment.waybillNos.length}，首条=${assignment.waybillNos[0]}，末条=${assignment.waybillNos[assignment.waybillNos.length - 1]}`, meta);
    logger.info('[Agent][Dispatch] 单号输入框已定位', meta);
    await logger.flush();

    const dryRunResult = await runDispatchBrowserDryRun(page, {
      siteId,
      siteName,
      waybills: assignment.waybillNos,
      options: { courierName: assignment.targetCourierName },
      log,
      meta,
    });

    logger.info('[Agent][Dispatch] 已进入派件扫描页面', meta);
    logger.info('[Agent][Dispatch] 单号写入完成，开始校验', meta);

    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`[Agent][Dispatch] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(`[Agent][Dispatch] ${msg}`, meta);
      }
    }

    logger.info(`[Agent][Dispatch] 输入运单：${dryRunResult.inputCount} 条`, meta);
    logger.info(`[Agent][Dispatch] 添加完成: 成功${dryRunResult.successCount}条, 失败${dryRunResult.failedCount}条`, meta);
    if (dryRunResult.courierSelected) {
      logger.info(`[Agent][Dispatch] 派件员选择完成：${assignment.targetCourierName}`, meta);
    }
    logger.info('[Agent][Dispatch] 单号填写校验通过', meta);
    logger.info('[Agent][Dispatch] 已执行到最终提交前', meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Dispatch][安全门] 跳过最终提交', meta);
    } else {
      logger.info('[Agent][Dispatch] dry-run 跳过最终提交', meta);
    }

    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    logger.success('[Agent][Dispatch] 派件扫描浏览器 DRY-RUN 完成，未点击最终提交', meta);
    await logger.flush();

    // Phase K-2E: 关闭浏览器前恢复干净首页 + 清理弹窗
    if (page) {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'dispatch-before-close');
    }

    logger.info('[Agent][Dispatch] READY 窗口任务完成，浏览器保持运行（由 Backend 管理）', meta);

    const results = dryRunResult.addResults.length > 0
      ? dryRunResult.addResults.map(item => ({
        waybillNo: item.waybillNo,
        staffName: assignment.executionStaffName,
        windowId: assignment.windowId,
        status: item.success ? (browserDryRun ? 'dry_run' : 'SAFETY_GATE_SKIPPED') : 'failed',
        message: item.success
          ? `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，已加入表格，未提交派件`
          : `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，失败：${item.message}`,
        reason: item.reason,
        durationMs: item.durationMs,
      }))
      : assignment.waybillNos.map(waybillNo => ({
        waybillNo,
        staffName: assignment.executionStaffName,
        windowId: assignment.windowId,
        status: 'failed',
        message: `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，失败：未生成添加结果`,
      }));
    const addSuccessCount = results.filter(item => item.status !== 'failed').length;
    const addFailedCount = results.length - addSuccessCount;

    logger.success('[Agent][Dispatch] assignment 本地执行完成', meta);
    await logger.flush();

    return {
      executionStaffName: assignment.executionStaffName,
      targetCourierName: assignment.targetCourierName,
      windowId: meta.windowId,
      mode: assignment.mode,
      success: true,
      summary: makeAssignmentSummary(assignment, addSuccessCount, addFailedCount, {
        success: true,
        inputCount: dryRunResult.inputCount,
        successCount: addSuccessCount,
        failedCount: addFailedCount,
        courierSelected: dryRunResult.courierSelected,
        pageUrl: dryRunResult.pageUrl,
        message: browserDryRun
          ? `派件扫描浏览器 DRY-RUN 完成：成功${addSuccessCount}条，失败${addFailedCount}条，未点击最终提交`
          : `派件扫描已执行到最终提交前：成功${addSuccessCount}条，失败${addFailedCount}条，ENABLE_REAL_SUBMIT 未开启，已跳过最终提交`,
      }),
      results,
      successCount: addSuccessCount,
      failedCount: addFailedCount,
    };

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[DispatchExecutor] assignment ${assignmentIndex + 1}/${assignmentCount} 执行失败：${msg}`);
    logger.error(`[Agent][Dispatch] assignment 执行失败：${msg}`, meta);
    await logger.flush();

    // Phase K-2E: 失败路径也尽力回首页 + 清理弹窗（失败不覆盖原始错误）
    if (page) {
      try {
        await restoreCleanHome(page, log, meta);
        await afterPageChangedCleanup(page, log, meta, 'dispatch-catch');
      } catch (restoreErr) {
        logger.warning(`[Agent][Dispatch] 失败路径回首页异常（忽略）: ${(restoreErr as Error).message}`, meta);
      }
    }

    logger.info('[Agent][Dispatch] 失败路径：READY 窗口浏览器保持运行（由 Backend 管理）', meta);

    return failAssignment(msg);
  } finally {
    if (busyWindowId) {
      releaseWindowBusy(busyWindowId, taskId);
    }
    await logger.close();
  }
}

export async function executeDispatchDryRun(
  task: DispatchTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  // Phase M-3B: dryRunMode 为主字段，browserDryRun/dryRun 仅兼容
  const browserDryRun = payload.dryRunMode ?? payload.browserDryRun ?? payload.dryRun ?? true;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const assignments = parseDispatchAssignments(payload);
  const totalWaybills = assignments.reduce((sum, a) => sum + a.waybillNos.length, 0);
  const taskLogger = createAgentLogger(client, taskId);

  try {
    taskLogger.info('[Agent][Dispatch] 收到任务', { siteId });
    taskLogger.info('[Agent][Dispatch] 进入 DispatchExecutor', { siteId });
    await taskLogger.flush();

    if (assignments.length === 0 || totalWaybills === 0) {
      const message = '[Agent][Dispatch] 未找到 waybillNos，无法执行派件扫描';
      taskLogger.error(message, { siteId });
      await taskLogger.close();
      await failTask(client, taskId, message);
      return;
    }

    console.log(`[Agent][Dispatch] 本地执行开始，任务: ${taskId}`);
    console.log(`[Agent][Dispatch][执行配置] browserDryRun=${browserDryRun}`);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      console.log('[Agent][Dispatch][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交');
    }

    taskLogger.info('[Agent][Dispatch] 本地执行开始', { siteId });
    taskLogger.info(`[Agent][Dispatch] assignmentCount=${assignments.length}，total=${totalWaybills}`, { siteId });
    await taskLogger.flush();
    await reportProgress(client, taskId, 'running', 5);

    const assignmentSummaries: Record<string, unknown>[] = [];
    const results: Array<Record<string, unknown>> = [];
    const concurrency = Math.max(1, Math.min(assignments.length, MAX_DISPATCH_ASSIGNMENT_CONCURRENCY));
    taskLogger.info(`[Agent][Dispatch] parallel assignments start count=${assignments.length} concurrency=${concurrency}`, { siteId });
    console.log(`[Agent][Dispatch] parallel assignments start count=${assignments.length} concurrency=${concurrency}`);
    await taskLogger.flush();

    const preparedAssignments = await prepareDispatchAssignments(task, client, assignments);
    const settled = await runWithConcurrency(preparedAssignments, concurrency, async (prepared) => executeOneDispatchAssignment(
      task,
      prepared.assignment,
      prepared.assignmentIndex,
      assignments.length,
      client,
      settingsLoader,
      config,
      browserDryRun,
      siteName,
      prepared.matchedWindow,
      prepared.preflightError,
    ));

    let successCount = 0;
    let failedCount = 0;
    let successAssignments = 0;
    let failedAssignments = 0;

    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      if (item.status === 'fulfilled') {
        const run = item.value;
        assignmentSummaries.push(run.summary);
        results.push(...run.results);
        successCount += run.successCount;
        failedCount += run.failedCount;
        if (run.success) successAssignments++;
        else failedAssignments++;
      } else {
        const assignment = assignments[i];
        const message = (item.reason as Error)?.message || String(item.reason || 'assignment 执行异常');
        const failed = makePreflightFailureResult(assignment, message);
        assignmentSummaries.push(failed.summary);
        results.push(...failed.results);
        failedCount += failed.failedCount;
        failedAssignments++;
      }
    }

    taskLogger.info(`[Agent][Dispatch] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`, { siteId });
    console.log(`[Agent][Dispatch] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`);

    await reportProgress(client, taskId, 'running', 95);

    const summary = {
      mode: browserDryRun ? 'browserDryRun' : 'realSubmitBlockedBySafetyGate',
      assignmentCount: assignments.length,
      successAssignments,
      failedAssignments,
      concurrency,
      total: totalWaybills,
      successCount,
      failedCount,
      assignments: assignmentSummaries,
      finalSubmitClicked: false,
      message: failedCount === 0
        ? '派件扫描所有 assignments 执行完成，未点击最终提交'
        : `派件扫描完成：成功 ${successCount} 条，失败 ${failedCount} 条`,
    };

    taskLogger.success('[Agent][Dispatch] 本地执行完成', { siteId });
    await taskLogger.flush();
    if (successAssignments > 0) {
      await completeTask(client, taskId, summary, results);
      console.log('[DispatchExecutor] 任务完成，已回传 Cloud');
    } else {
      await failTask(client, taskId, summary.message);
      console.log('[DispatchExecutor] 任务全部失败，已回传 Cloud');
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[DispatchExecutor] 任务 ${taskId} 执行失败：${msg}`);
    taskLogger.error(`[Agent][Dispatch] 执行失败：${msg}`, { siteId });
    await taskLogger.flush();
    await failTask(client, taskId, msg);
  } finally {
    await taskLogger.close();
  }
}
