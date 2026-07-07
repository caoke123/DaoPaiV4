/**
 * ArrivalExecutor — 到件扫描 Agent 执行器
 *
 * Phase 5-B: 模拟 dryRun，不启动浏览器
 * Phase 5-E: 接入浏览器 DRY-RUN（payload.browserDryRun=true 时）
 * Phase 5-G-3: 使用 AgentLogger 缓冲日志，定时/定量 flush，减少日志真空期
 *
 * 硬性约束：
 *   - dryRun 必须为 true，否则拒绝执行
 *   - browserDryRun=true 时执行浏览器页面操作，但禁止点击最终提交
 *   - 不修改 /api/operations/arrive、BrowserPool、AssignmentEngine、ArrivalHandler
 *   - 不触碰 V2
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
import { runArrivalBrowserDryRun } from '../browser/ArrivalBrowserDryRun';
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

interface ArrivalTask {
  taskId: string;
  siteId: string;
  tenantId?: string;
  workstationId?: string;
  payload: {
    waybills?: string[];
    waybillNos?: string[];
    assignments?: ArrivalAssignmentPayload[];
    inputData?: {
      waybills?: string[];
      waybillNos?: string[];
      assignments?: ArrivalAssignmentPayload[];
    };
    options?: {
      batchSize?: number;
      prevStation?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    dryRunMode?: boolean;
    browserDryRun?: boolean;
    staffName?: string;
    workerName?: string;
    executionStaffName?: string;
    windowStaffName?: string;
    windowId?: string;
  };
}

interface ArrivalAssignmentPayload {
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  windowId?: string;
  waybillNos?: string[];
  waybills?: string[];
}

interface ArrivalAgentAssignment {
  executionStaffName: string;
  windowId: string;
  waybillNos: string[];
}

interface AssignmentRunResult {
  staffName: string;
  windowId?: string;
  success: boolean;
  summary: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  successCount: number;
  failedCount: number;
  error?: string;
}

interface PreparedArrivalAssignment {
  assignment: ArrivalAgentAssignment;
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

function collectTopLevelWaybills(payload: ArrivalTask['payload']): string[] {
  const input = payload.inputData || {};
  return uniqueNonEmpty([
    ...(Array.isArray(payload.waybillNos) ? payload.waybillNos : []),
    ...(Array.isArray(payload.waybills) ? payload.waybills : []),
    ...(Array.isArray(input.waybillNos) ? input.waybillNos : []),
    ...(Array.isArray(input.waybills) ? input.waybills : []),
  ]);
}

function collectAssignmentWaybills(assignment: ArrivalAssignmentPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(assignment.waybillNos) ? assignment.waybillNos : []),
    ...(Array.isArray(assignment.waybills) ? assignment.waybills : []),
  ]);
}

function parseArrivalAssignments(payload: ArrivalTask['payload']): ArrivalAgentAssignment[] {
  const assignments = Array.isArray(payload.assignments) && payload.assignments.length > 0
    ? payload.assignments
    : Array.isArray(payload.inputData?.assignments) ? payload.inputData!.assignments! : [];

  if (assignments.length > 0) {
    return assignments.map((assignment) => {
      const executionStaffName = firstString(
        assignment.executionStaffName,
        assignment.windowStaffName,
        assignment.staffName,
        assignment.workerName,
        payload.executionStaffName,
        payload.windowStaffName,
        payload.staffName,
        payload.workerName,
      );
      return {
        executionStaffName,
        windowId: firstString(assignment.windowId, payload.windowId, executionStaffName ? `staff-${executionStaffName}` : ''),
        waybillNos: collectAssignmentWaybills(assignment),
      };
    });
  }

  const topLevelWaybills = collectTopLevelWaybills(payload);
  if (topLevelWaybills.length === 0) return [];
  const executionStaffName = firstString(payload.executionStaffName, payload.windowStaffName, payload.staffName, payload.workerName);
  return [{
    executionStaffName,
    windowId: firstString(payload.windowId, executionStaffName ? `staff-${executionStaffName}` : ''),
    waybillNos: topLevelWaybills,
  }];
}

function makeFailedResults(assignment: ArrivalAgentAssignment, message: string): Array<Record<string, unknown>> {
  return assignment.waybillNos.map(waybillNo => ({
    waybillNo,
    staffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    status: 'failed',
    message: `执行窗口=${assignment.executionStaffName}，失败：${message}`,
  }));
}

function makeAssignmentSummary(
  assignment: ArrivalAgentAssignment,
  successCount: number,
  failedCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionStaffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    total: assignment.waybillNos.length,
    successCount,
    failedCount,
    finalSubmitClicked: false,
    ...extra,
  };
}

function createArrivalRuntimeProof(): string {
  return '[RuntimeProof][ArrivalExecutor] mode=READY_CDP_ATTACH noNewChrome=true noRelogin=true';
}

const MAX_ARRIVAL_ASSIGNMENT_CONCURRENCY = 5;

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

function makePreflightFailureResult(assignment: ArrivalAgentAssignment, message: string): AssignmentRunResult {
  const failedResults = makeFailedResults(assignment, message);
  return {
    staffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    success: false,
    summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
    results: failedResults,
    successCount: 0,
    failedCount: failedResults.length,
    error: message,
  };
}

async function prepareArrivalAssignments(
  task: ArrivalTask,
  client: AxiosInstance,
  assignments: ArrivalAgentAssignment[],
): Promise<PreparedArrivalAssignment[]> {
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
      const staffWindows = allWindows.filter(w => w.staffName === assignment.executionStaffName);
      if (staffWindows.length > 0) {
        const statuses = staffWindows.map(w => `${w.windowId}=${w.status}`).join(', ');
        return {
          assignment,
          assignmentIndex,
          preflightError: `READY_WINDOW_NOT_FOUND: 员工 ${assignment.executionStaffName} 在站点 ${siteId} 有 ${staffWindows.length} 个窗口，但没有 READY 状态（状态: ${statuses}），无法接管`,
        };
      }
      return {
        assignment,
        assignmentIndex,
        preflightError: `READY_WINDOW_NOT_FOUND: 未找到员工 ${assignment.executionStaffName} 在站点 ${siteId} 的 READY 窗口，请先在前端启动员工窗口`,
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
        preflightError: `READY_WINDOW_STAFF_MISMATCH: 窗口 staffName=${matched.staffName}，任务 staffName=${assignment.executionStaffName}，不一致`,
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

/**
 * 执行 Arrival 到件扫描任务
 *
 * 内部判断：
 *   - payload.browserDryRun === true → 浏览器 DRY-RUN
 *   - 否则 → 模拟 DRY-RUN（Phase 5-B 兼容）
 */
export async function executeArrivalDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const assignments = parseArrivalAssignments(payload);
  const totalWaybills = assignments.reduce((sum, a) => sum + a.waybillNos.length, 0);
  // Phase M-3B: dryRunMode 为主字段，browserDryRun/dryRun 仅兼容
  const browserDryRun = payload.dryRunMode ?? payload.browserDryRun ?? payload.dryRun ?? true;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const taskLogger = createAgentLogger(client, taskId);

  if (assignments.length === 0 || totalWaybills === 0) {
    const message = '[Agent][Arrival] 未找到 waybillNos，无法执行到件扫描';
    console.error(message);
    taskLogger.error(message, { siteId });
    await taskLogger.close();
    await failTask(client, taskId, message);
    return;
  }

  console.log(`[Agent][Arrival][执行配置] browserDryRun=${browserDryRun}`);
  if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
    console.log('[Agent][Arrival][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交');
  }

  try {
    taskLogger.info('[Agent][Arrival] 收到任务', { siteId });
    taskLogger.info(`[Agent][Arrival] assignmentCount=${assignments.length}，total=${totalWaybills}`, { siteId });
    await taskLogger.flush();
    await reportProgress(client, taskId, 'running', 5);

    const assignmentSummaries: Record<string, unknown>[] = [];
    const results: Array<Record<string, unknown>> = [];
    const concurrency = Math.max(1, Math.min(assignments.length, MAX_ARRIVAL_ASSIGNMENT_CONCURRENCY));
    taskLogger.info(`[Agent][Arrival] parallel assignments start count=${assignments.length} concurrency=${concurrency}`, { siteId });
    console.log(`[Agent][Arrival] parallel assignments start count=${assignments.length} concurrency=${concurrency}`);
    await taskLogger.flush();

    const preparedAssignments = await prepareArrivalAssignments(task, client, assignments);
    const settled = await runWithConcurrency(preparedAssignments, concurrency, async (prepared) => executeBrowserDryRunAssignment(
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

    taskLogger.info(`[Agent][Arrival] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`, { siteId });
    console.log(`[Agent][Arrival] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`);

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
        ? '到件扫描所有 assignments 执行完成，未点击最终提交'
        : `到件扫描完成：成功 ${successCount} 条，失败 ${failedCount} 条`,
    };

    taskLogger.success('[Agent][Arrival] 本地执行完成', { siteId });
    await taskLogger.flush();
    if (successAssignments > 0) {
      await completeTask(client, taskId, summary, results);
      console.log('[ArrivalExecutor] 任务完成，已回传 Cloud');
    } else {
      await failTask(client, taskId, summary.message);
      console.log('[ArrivalExecutor] 任务全部失败，已回传 Cloud');
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[ArrivalExecutor] 任务 ${taskId} 执行失败：${msg}`);
    taskLogger.error(`[Agent][Arrival] 执行失败：${msg}`, { siteId });
    await taskLogger.flush();
    await failTask(client, taskId, msg);
  } finally {
    await taskLogger.close();
  }
}

// ══════════════════════════════════════════════════════════
// 浏览器 DRY-RUN（Phase 5-E）
// ══════════════════════════════════════════════════════════

async function executeBrowserDryRunAssignment(
  task: ArrivalTask,
  assignment: ArrivalAgentAssignment,
  assignmentIndex: number,
  assignmentCount: number,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
  browserDryRun: boolean = true,
  siteName: string = task.siteId,
  preMatchedWindow?: WindowConnection,
  preflightError?: string,
): Promise<AssignmentRunResult> {
  const { taskId, siteId, payload } = task;
  const waybills = assignment.waybillNos;
  const prevStation = payload.options?.prevStation || '天津分拨中心';

  const logger = createAgentLogger(client, taskId);
  const meta = { staffName: assignment.executionStaffName, windowId: assignment.windowId, siteId };
  const log = createRuntimeLogFn(logger, meta);
  let page: Page | null = null;
  let busyWindowId: string | null = null;

  const failAssignment = async (message: string): Promise<AssignmentRunResult> => {
    logger.error(`[Agent][Arrival] ${message}`, meta);
    await logger.flush();
    const failedResults = makeFailedResults(assignment, message);
    return {
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      success: false,
      summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
      results: failedResults,
      successCount: 0,
      failedCount: failedResults.length,
      error: message,
    };
  };

  try {
    // 1. 上报开始日志
    const runtimeProof = createArrivalRuntimeProof();
    console.log(runtimeProof);
    console.log(`[Agent][Arrival] 收到任务 taskId=${taskId} siteId=${siteId}`);
    console.log(`[Agent][Arrival] assignment 准备执行 staffName=${assignment.executionStaffName} windowId=${assignment.windowId}`);
    console.log(`[Agent][Arrival][${assignment.executionStaffName || 'unknown'}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'}`);
    logger.info(runtimeProof, meta);
    logger.info('[Agent][Arrival][Guard] ARRIVAL_NEW_BROWSER_FORBIDDEN active; ARRIVAL_RELOGIN_FORBIDDEN active', meta);
    logger.info(`[Agent][Arrival][${assignment.executionStaffName || 'unknown'}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'}`, meta);
    logger.info(`[Agent][Arrival] 收到任务`, meta);
    logger.info(`[Agent][Arrival] assignment 准备执行 staffName=${assignment.executionStaffName} windowId=${assignment.windowId}`, meta);
    logger.info(`[Agent][Arrival] assignmentCount=${assignmentCount}，total=${waybills.length}`, meta);
    logger.info(`[Agent][Arrival][执行配置] browserDryRun=${browserDryRun}`, meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Arrival][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交', meta);
    }
    logger.info(`[Agent][Arrival] 网点：${siteName}，运单数：${waybills.length}`, meta);
    logger.info(`[Agent][Arrival] 参数校验完成，上一站：${prevStation}`, meta);
    if (!assignment.executionStaffName) {
      return failAssignment('READY_WINDOW_STAFF_MISMATCH: 未找到执行窗口员工，无法匹配 READY 窗口');
    }
    if (waybills.length === 0) {
      return failAssignment('assignment 未找到 waybillNos，跳过该员工');
    }
    if (preflightError) {
      return failAssignment(preflightError);
    }

    // ── Phase K-3A-2: 查询 READY 窗口并接管 ──

    // 2. 使用 preflight 阶段已匹配且去重的 READY 窗口
    console.log(`[Agent][Arrival][${assignment.executionStaffName}] 使用 preflight READY 窗口匹配结果`);
    logger.info(`[Agent][Arrival] 使用 preflight READY 窗口匹配结果`, meta);
    await logger.flush();

    if (!preMatchedWindow) {
      return failAssignment(`READY_WINDOW_NOT_FOUND: 未找到员工 ${assignment.executionStaffName} 在站点 ${siteId} 的 READY 窗口，请先在前端启动员工窗口`);
    }

    const matched = preMatchedWindow;

    // 4. 验证匹配窗口
    if (matched.siteId !== siteId) {
      return failAssignment(`READY_WINDOW_SITE_MISMATCH: 窗口 siteId=${matched.siteId}，任务 siteId=${siteId}，不一致`);
    }
    if (matched.staffName !== assignment.executionStaffName) {
      return failAssignment(`READY_WINDOW_STAFF_MISMATCH: 窗口 staffName=${matched.staffName}，任务 staffName=${assignment.executionStaffName}，不一致`);
    }
    if (!matched.cdpAttachable) {
      return failAssignment(`READY_WINDOW_NOT_ATTACHABLE: 窗口 ${matched.windowId} cdpAttachable=false，可能是旧窗口或 CDP 开关未启用`);
    }
    if (!matched.cdpEndpoint) {
      return failAssignment(`READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空，无法连接`);
    }

    // 更新 meta 为实际匹配的窗口
    meta.windowId = matched.windowId;
    acquireWindowBusy({
      windowId: matched.windowId,
      taskId,
      siteId,
      staffName: assignment.executionStaffName,
      taskType: 'arrival',
    });
    busyWindowId = matched.windowId;

    logger.info(`[Agent][Arrival] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId} cdpAttachable=true`, meta);
    console.log(`[Agent][Arrival] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId}`);

    // 5. connectOverCDP 接管
    logger.info(`[Agent][Arrival] connectOverCDP 开始 windowId=${matched.windowId}`, meta);
    console.log(`[Agent][Arrival] connectOverCDP 开始 windowId=${matched.windowId}`);

    try {
      const { page: cdpPage } = await BrowserManager.connectExisting(matched.cdpEndpoint);
      page = cdpPage;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[Agent][Arrival] CDP_CONNECT_FAILED: ${msg}`, meta);
      return failAssignment(`CDP_CONNECT_FAILED: ${msg}`);
    }

    logger.success(`[Agent][Arrival] connectOverCDP 成功 windowId=${matched.windowId}`, meta);
    logger.info(`[Agent][Arrival] 使用 READY 窗口执行，不新开 Chrome`, meta);
    console.log(`[Agent][Arrival] connectOverCDP 成功 windowId=${matched.windowId}`);

    // 6. 注册 native alert guard
    registerNativeAlertGuard(page, log, meta);
    logger.info('[Agent][Arrival] Native alert guard 已注册', meta);
    await drainNativeAlerts(page, 1200, 150, log, meta);

    // 7. 验证 Dashboard 仍为 READY（不发登录请求，不重登）
    logger.info('[Agent][Arrival] 验证 READY 窗口 Dashboard 状态...', meta);
    const dashboardStatus = await detectBnsyDashboardP0(page);
    await drainNativeAlerts(page, 2500, 150, log, meta);

    if (!dashboardStatus.isLoggedIn || dashboardStatus.status !== 'READY') {
      return failAssignment(`READY_WINDOW_DASHBOARD_NOT_READY: 窗口 ${matched.windowId} 登录态已失效，当前状态=${dashboardStatus.status}。READY 窗口接管要求预登录窗口，不执行重登。`);
    }

    logger.success(`[Agent][Arrival] READY 窗口 Dashboard 验证通过: ${dashboardStatus.message}`, meta);
    logger.info(`[Agent][Arrival] 不新开 Chrome，不重新登录`, meta);

    // Phase K-2E/R1: guard 已在上面注册；这里进入首页清理。
    const homeResult = await ensureCleanHome(page, log, meta);
    if (!homeResult.success) {
      logger.warning(`[Agent][Arrival] ensureCleanHome 失败: ${homeResult.error}，继续尝试业务导航`, meta);
    }

    // 8. 执行到件页面 DRY-RUN
    console.log('[ArrivalExecutor] 进入到件扫描页面...');
    logger.info(`[员工:${assignment.executionStaffName} 批次 1/1] 准备进入业务页面：到件扫描`, meta);
    logger.info('[Agent][Arrival] 准备进入到件扫描页面', meta);
    logger.info(`[Agent][Arrival] 准备填写单号，数量=${waybills.length}`, meta);
    await logger.flush();

    const dryRunResult = await runArrivalBrowserDryRun(page, {
      siteId,
      siteName,
      waybills,
      options: { prevStation },
      log,
      meta,
    });

    // Phase I-4-Arrival-Fix: Check success FIRST before printing success logs,
    // avoiding misleading "单号填写校验通过" when the task actually failed.
    if (!dryRunResult.success) {
      logger.error(`[Agent][Arrival] DRY-RUN 失败: ${dryRunResult.message}`, meta);
      logger.info(`[Agent][Arrival] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(`[Agent][Arrival] ${msg}`, meta);
      }
      throw new Error(dryRunResult.message);
    }

    logger.info('[Agent][Arrival] 已进入到件扫描页面', meta);
    logger.info('[Agent][Arrival] 单号填写完成，开始校验', meta);

    // 9. 上报校验日志
    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`[Agent][Arrival] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(`[Agent][Arrival] ${msg}`, meta);
      }
    }

    logger.info(`[Agent][Arrival] 输入运单：${dryRunResult.inputCount} 条`, meta);

    if (dryRunResult.queried) {
      logger.info('[Agent][Arrival] 已点击查询按钮', meta);
    }

    logger.info('[Agent][Arrival] 单号填写校验通过', meta);
    logger.info('[Agent][Arrival] 已执行到最终提交前', meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Arrival][安全门] 跳过最终提交', meta);
    } else {
      logger.info('[Agent][Arrival] dry-run 跳过最终提交', meta);
    }

    // 11. 上报 progress 90%
    console.log('[ArrivalExecutor] 页面 DRY-RUN 完成');
    logger.success('[Agent][Arrival] 到件扫描浏览器 DRY-RUN 完成，未点击最终提交', meta);

    // 先 flush 日志
    await logger.flush();

    // Phase K-2E: 恢复干净首页 + 清理弹窗（不关闭浏览器，浏览器属于 Backend PlaywrightRuntime）
    if (page) {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'arrival-before-done');
    }

    // 不关闭浏览器 — 窗口由 Backend PlaywrightRuntime 管理
    logger.info('[Agent][Arrival] READY 窗口任务完成，浏览器保持运行（由 Backend 管理）', meta);

    await logger.flush();

    const results = waybills.map(wb => ({
      waybillNo: wb,
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      status: browserDryRun ? 'dry_run' : 'SAFETY_GATE_SKIPPED',
      message: browserDryRun ? '已输入并查询，未提交到件' : '安全门拦截，未提交到件',
    }));

    return {
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      success: true,
      summary: makeAssignmentSummary(assignment, results.length, 0, {
        success: true,
        mode: browserDryRun ? 'browserDryRun' : 'realSubmitBlockedBySafetyGate',
        inputCount: dryRunResult.inputCount,
        pageUrl: dryRunResult.pageUrl,
        message: browserDryRun
          ? '到件扫描浏览器 DRY-RUN 完成（READY 窗口接管），未点击最终提交'
          : '到件扫描已执行到最终提交前，ENABLE_REAL_SUBMIT 未开启，已跳过最终提交',
      }),
      results,
      successCount: results.length,
      failedCount: 0,
    };

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[ArrivalExecutor] 任务 ${taskId} 执行失败：${msg}`);

    logger.error(`[Agent][Arrival] 执行失败：${msg}`, meta);
    await logger.flush();

    // Phase K-2E: 失败路径也尽力回首页 + 清理弹窗（失败不覆盖原始错误）
    if (page) {
      try {
        await restoreCleanHome(page, log, meta);
        await afterPageChangedCleanup(page, log, meta, 'arrival-catch');
      } catch (restoreErr) {
        logger.warning(`[Agent][Arrival] 失败路径回首页异常（忽略）: ${(restoreErr as Error).message}`, meta);
      }
    }

    // 不关闭浏览器 — 窗口由 Backend PlaywrightRuntime 管理
    logger.info('[Agent][Arrival] 失败路径：READY 窗口浏览器保持运行（由 Backend 管理）', meta);

    return failAssignment(msg);

  } finally {
    if (busyWindowId) {
      releaseWindowBusy(busyWindowId, taskId);
    }
    await logger.close();
  }
}

// ══════════════════════════════════════════════════════════
// 模拟 DRY-RUN（Phase 5-B 兼容，不启动浏览器）
// ══════════════════════════════════════════════════════════

async function executeSimulatedDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills ||
    (payload.assignments || []).flatMap(a => a.waybillNos || []);
  const batchSize = payload.options?.batchSize || 200;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  const totalWaybills = waybills.length;
  console.log(`[ArrivalExecutor] 发现到件扫描任务：${taskId}`);
  console.log(`[ArrivalExecutor] 网点：${siteName}，运单数：${totalWaybills}`);
  console.log(`[ArrivalExecutor] 模式：模拟 DRY-RUN（不启动浏览器）`);

  const logger = createAgentLogger(client, taskId);

  try {
    logger.info(`开始到件扫描 DRY-RUN，网点：${siteName}，运单数：${totalWaybills}`);
    logger.info(`模式：模拟 DRY-RUN（不启动浏览器）`);
    logger.info(`参数：batchSize=${batchSize}`);
    await reportProgress(client, taskId, 'running', 10);
    console.log(`进度：10%`);

    const totalBatches = Math.ceil(totalWaybills / batchSize);
    let processed = 0;

    for (let batch = 0; batch < totalBatches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, totalWaybills);
      const batchWaybills = waybills.slice(start, end);

      logger.info(`开始处理第 ${batch + 1}/${totalBatches} 批（${start + 1}-${end}）`);

      for (const waybillNo of batchWaybills) {
        processed++;
        console.log(`模拟处理运单：${waybillNo}`);

        if (processed % 5 === 0 || processed === totalWaybills) {
          logger.info(`DRY-RUN 模拟处理运单 ${processed}/${totalWaybills}`);
        }

        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const progress = Math.floor(10 + ((batch + 1) / totalBatches) * 85);
      await reportProgress(client, taskId, 'running', progress);
      logger.info(`第 ${batch + 1}/${totalBatches} 批处理完成，进度 ${progress}%`);
      console.log(`进度：${progress}% (第 ${batch + 1}/${totalBatches} 批)`);
    }

    await reportProgress(client, taskId, 'running', 100);
    console.log(`进度：100%`);

    logger.success(`到件扫描 DRY-RUN 完成，共处理 ${totalWaybills} 条运单`);
    await logger.flush();

    await completeTask(client, taskId);
    console.log('到件扫描 DRY-RUN 完成，已回传 Cloud');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`到件扫描任务 ${taskId} 执行失败：${msg}`);

    logger.error(`任务执行失败：${msg}`);
    await logger.flush();

    try {
      await logger.close();
      await failTask(client, taskId, msg);
    } catch {
      // 忽略 fail 失败
    }
    return;
  } finally {
    await logger.close();
  }
}
