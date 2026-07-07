/**
 * IntegratedExecutor — 到派一体 Agent 本地执行器
 *
 * Phase K-3D: Integrated 真 Agent 迁移 — READY 窗口 CDP 接管 + 多员工并行执行。
 * 本阶段禁止 new BrowserManager / manager.start / ensureBnsyLoggedIn 路径。
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
import { runIntegratedBrowserDryRun } from '../browser/IntegratedBrowserDryRun';
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

type IntegratedMode = 'default' | 'specified';

const MAX_INTEGRATED_ASSIGNMENT_CONCURRENCY = 5;

interface IntegratedAssignmentPayload {
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  targetCourierName?: string;
  targetCourierAccount?: string;
  dispatchStaffName?: string;
  courierName?: string;
  courierEmployeeId?: string;
  windowId?: string;
  waybillNos?: string[];
  waybills?: string[];
  mode?: string;
  dispatchMode?: string;
  executionMode?: string;
}

interface IntegratedPayload {
  waybillNos?: string[];
  waybills?: string[];
  assignments?: IntegratedAssignmentPayload[];
  inputData?: {
    waybillNos?: string[];
    waybills?: string[];
    assignments?: IntegratedAssignmentPayload[];
  };
  options?: Record<string, unknown>;
  siteName?: string;
  dryRun?: boolean;
  dryRunMode?: boolean;
  browserDryRun?: boolean;
  executionMode?: string;
  dispatchMode?: string;
  mode?: string;
  prevStation?: string;
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  targetCourierName?: string;
  targetCourierAccount?: string;
  dispatchStaffName?: string;
  courierName?: string;
  courierEmployeeId?: string;
  windowId?: string;
}

interface IntegratedTask {
  taskId: string;
  siteId: string;
  tenantId?: string;
  workstationId?: string;
  payload: IntegratedPayload;
}

interface IntegratedAgentAssignment {
  executionStaffName: string;
  targetCourierName: string;
  targetCourierAccount: string;
  targetCourierExplicit: boolean;
  windowId: string;
  waybillNos: string[];
  mode: IntegratedMode;
}

interface AssignmentRunResult {
  staffName: string;
  targetCourierName?: string;
  windowId?: string;
  success: boolean;
  doneCount: number;
  failCount: number;
  summary: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  successCount: number;
  failedCount: number;
  error?: string;
}

interface PreparedIntegratedAssignment {
  assignment: IntegratedAgentAssignment;
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

function normalizeIntegratedMode(value: string): IntegratedMode {
  const normalized = value.trim().toLowerCase();
  if (['specified', 'designated', 'target', 'manual', '指定', '指定派件员'].includes(normalized)) {
    return 'specified';
  }
  return 'default';
}

function collectAssignments(payload: IntegratedPayload): IntegratedAssignmentPayload[] {
  const direct = Array.isArray(payload.assignments) ? payload.assignments : [];
  const input = Array.isArray(payload.inputData?.assignments) ? payload.inputData!.assignments! : [];
  return direct.length > 0 ? direct : input;
}

function collectTopLevelWaybills(payload: IntegratedPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(payload.waybillNos) ? payload.waybillNos : []),
    ...(Array.isArray(payload.waybills) ? payload.waybills : []),
    ...(Array.isArray(payload.inputData?.waybillNos) ? payload.inputData!.waybillNos! : []),
    ...(Array.isArray(payload.inputData?.waybills) ? payload.inputData!.waybills! : []),
  ]);
}

function collectAssignmentWaybills(assignment: IntegratedAssignmentPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(assignment.waybillNos) ? assignment.waybillNos : []),
    ...(Array.isArray(assignment.waybills) ? assignment.waybills : []),
  ]);
}

function parseOneAssignment(
  payload: IntegratedPayload,
  assignment: IntegratedAssignmentPayload,
  waybillNos: string[],
): IntegratedAgentAssignment {
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
  const explicitTargetCourierAccount = firstString(
    assignment.targetCourierAccount,
    assignment.courierEmployeeId,
    payload.targetCourierAccount,
    payload.courierEmployeeId,
    optionString(options, 'targetCourierAccount'),
    optionString(options, 'courierEmployeeId'),
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
    : normalizeIntegratedMode(modeField);

  return {
    executionStaffName,
    targetCourierName: explicitTargetCourierName || executionStaffName,
    targetCourierAccount: explicitTargetCourierAccount,
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

function parseIntegratedAssignments(payload: IntegratedPayload): IntegratedAgentAssignment[] {
  const assignments = collectAssignments(payload);
  if (assignments.length > 0) {
    return assignments.map(a => parseOneAssignment(payload, a, collectAssignmentWaybills(a)));
  }

  const topLevelWaybills = collectTopLevelWaybills(payload);
  if (topLevelWaybills.length === 0) return [];
  return [parseOneAssignment(payload, {}, topLevelWaybills)];
}

function makeFailedResults(
  assignment: IntegratedAgentAssignment,
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
  assignment: IntegratedAgentAssignment,
  successCount: number,
  failedCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionStaffName: assignment.executionStaffName,
    targetCourierName: assignment.targetCourierName,
    integratedMode: assignment.mode,
    windowId: assignment.windowId,
    total: assignment.waybillNos.length,
    successCount,
    failedCount,
    finalSubmitClicked: false,
    ...extra,
  };
}

function makePreflightFailureResult(assignment: IntegratedAgentAssignment, message: string): AssignmentRunResult {
  const failedResults = makeFailedResults(assignment, message);
  return {
    staffName: assignment.executionStaffName,
    targetCourierName: assignment.targetCourierName,
    windowId: assignment.windowId,
    success: false,
    doneCount: 0,
    failCount: failedResults.length,
    summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
    results: failedResults,
    successCount: 0,
    failedCount: failedResults.length,
    error: message,
  };
}

function createIntegratedRuntimeProof(): string {
  return '[RuntimeProof][IntegratedExecutor] mode=READY_CDP_ATTACH noNewChrome=true noRelogin=true parallel=true dryRun=true buildTime=K-3D';
}

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

async function prepareIntegratedAssignments(
  task: IntegratedTask,
  client: AxiosInstance,
  assignments: IntegratedAgentAssignment[],
): Promise<PreparedIntegratedAssignment[]> {
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
      return {
        assignment,
        assignmentIndex,
        preflightError: `READY_WINDOW_NOT_FOUND: staffName=${assignment.executionStaffName} siteId=${siteId}；visible windows: ${visible}`,
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
        preflightError: `READY_WINDOW_NOT_ATTACHABLE: 窗口 ${matched.windowId} cdpAttachable=false`,
      };
    }
    if (!matched.cdpEndpoint) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空`,
      };
    }
    if (usedWindowIds.has(matched.windowId)) {
      return {
        assignment,
        assignmentIndex,
        matchedWindow: matched,
        preflightError: `READY_WINDOW_DUPLICATED: 窗口 ${matched.windowId} 被多个 assignment 同时使用`,
      };
    }

    usedWindowIds.add(matched.windowId);
    return { assignment, assignmentIndex, matchedWindow: matched };
  });
}

async function executeOneIntegratedAssignment(
  task: IntegratedTask,
  assignment: IntegratedAgentAssignment,
  assignmentIndex: number,
  assignmentCount: number,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  _config: AgentConfig | undefined,
  browserDryRun: boolean,
  siteName: string,
  prevStation: string,
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
    logger.error(`[Agent][Integrated] ${message}`, meta);
    await logger.flush();
    const failedResults = makeFailedResults(assignment, message);
    return {
      staffName: assignment.executionStaffName,
      targetCourierName: assignment.targetCourierName,
      windowId: meta.windowId,
      success: false,
      doneCount: 0,
      failCount: failedResults.length,
      summary: makeAssignmentSummary(assignment, 0, failedResults.length, { success: false, message }),
      results: failedResults,
      successCount: 0,
      failedCount: failedResults.length,
      error: message,
    };
  };

  try {
    const runtimeProof = createIntegratedRuntimeProof();
    console.log(runtimeProof);
    console.log(`[Agent][Integrated][${assignment.executionStaffName || 'unknown'}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'} mode=${assignment.mode} executionStaff=${assignment.executionStaffName || '(empty)'} targetCourier=${assignment.targetCourierName || '(empty)'}`);
    logger.info(runtimeProof, meta);
    logger.info('[Agent][Integrated][Guard] INTEGRATED_NEW_BROWSER_FORBIDDEN active; INTEGRATED_RELOGIN_FORBIDDEN active; INTEGRATED_REAL_SUBMIT_FORBIDDEN active', meta);
    logger.info(`[Agent][Integrated][${assignment.executionStaffName || 'unknown'}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId || '(empty)'}`, meta);
    logger.info(`[Agent][Integrated] 模式=${assignment.mode}，执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，单号数量=${assignment.waybillNos.length}`, meta);

    if (assignment.waybillNos.length === 0) {
      return failAssignment('assignment 未找到 waybillNos，跳过该员工');
    }
    if (!assignment.executionStaffName) {
      return failAssignment('READY_WINDOW_STAFF_MISMATCH: 未找到执行窗口员工，无法匹配 READY 窗口');
    }
    if (assignment.mode === 'specified' && !assignment.targetCourierExplicit) {
      return failAssignment('指定模式缺少目标派件员');
    }
    if (preflightError) {
      return failAssignment(preflightError);
    }

    const executionCredential = await settingsLoader.getLoginCredentialForStaff(siteId, assignment.executionStaffName);
    const targetCourierAccount = assignment.mode === 'specified'
      ? assignment.targetCourierAccount
      : (assignment.targetCourierAccount || executionCredential?.loginAccount || '');
    if (!targetCourierAccount) {
      return failAssignment(`未找到目标派件员账号：${assignment.targetCourierName}`);
    }

    logger.info(`[Agent][Integrated][执行配置] browserDryRun=${browserDryRun}`, meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Integrated][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交', meta);
    }
    logger.info(`[Agent][Integrated] 网点：${siteName}，上一站：${prevStation}`, meta);

    if (!preMatchedWindow) {
      return failAssignment(`READY_WINDOW_NOT_FOUND: staffName=${assignment.executionStaffName} siteId=${siteId}`);
    }
    const matched = preMatchedWindow;
    const cdpEndpoint = matched.cdpEndpoint;
    if (!cdpEndpoint) {
      return failAssignment(`READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空`);
    }

    meta.windowId = matched.windowId;
    acquireWindowBusy({
      windowId: matched.windowId,
      taskId,
      siteId,
      staffName: assignment.executionStaffName,
      taskType: 'integrated',
    });
    busyWindowId = matched.windowId;
    logger.info(`[Agent][Integrated] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId} cdpAttachable=true`, meta);
    console.log(`[Agent][Integrated] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId}`);
    logger.info(`[Agent][Integrated] connectOverCDP 开始 windowId=${matched.windowId}`, meta);
    console.log(`[Agent][Integrated] connectOverCDP 开始 windowId=${matched.windowId}`);

    try {
      const { page: cdpPage } = await BrowserManager.connectExisting(cdpEndpoint);
      page = cdpPage;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[Agent][Integrated] CDP_CONNECT_FAILED: ${msg}`, meta);
      return failAssignment(`CDP_CONNECT_FAILED: ${msg}`);
    }

    logger.success(`[Agent][Integrated] connectOverCDP 成功 windowId=${matched.windowId}`, meta);
    logger.info('[Agent][Integrated] 使用 READY 窗口执行，不新开 Chrome', meta);
    console.log(`[Agent][Integrated] connectOverCDP 成功 windowId=${matched.windowId}`);

    registerNativeAlertGuard(page, log, meta);
    logger.info('[Agent][Integrated] Native alert guard 已注册', meta);
    await drainNativeAlerts(page, 1200, 150, log, meta);

    const homeResult = await ensureCleanHome(page, log, meta);
    if (!homeResult.success) {
      logger.warning(`[Agent][Integrated] ensureCleanHome 失败: ${homeResult.error}，继续做 Dashboard 状态校验`, meta);
    }

    logger.info('[Agent][Integrated] 验证 READY 窗口 Dashboard 状态...', meta);
    const dashboardStatus = await detectBnsyDashboardP0(page);
    await drainNativeAlerts(page, 2500, 150, log, meta);
    if (!dashboardStatus.isLoggedIn || dashboardStatus.status !== 'READY') {
      return failAssignment(`READY_WINDOW_DASHBOARD_NOT_READY: 窗口 ${matched.windowId} 登录态已失效。READY 窗口接管要求预登录窗口，不执行重登。`);
    }

    logger.success(`[Agent][Integrated] READY 窗口 Dashboard 验证通过: ${dashboardStatus.message}`, meta);
    logger.info('[Agent][Integrated] 不新开 Chrome，不重新登录', meta);
    logger.info('[Agent][Integrated] 准备进入到派一体页面', meta);
    await logger.flush();

    const dryRunResult = await runIntegratedBrowserDryRun(page, {
      siteId,
      siteName,
      waybills: assignment.waybillNos,
      options: {
        prevStation,
        courierName: assignment.targetCourierName,
        courierEmployeeId: targetCourierAccount,
      },
      log,
      meta,
    });

    logger.info('[Agent][Integrated] 已进入到派一体页面', meta);
    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`[Agent][Integrated] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(`[Agent][Integrated] ${msg}`, meta);
      }
    }
    logger.info(`[Agent][Integrated] 输入运单：${dryRunResult.inputCount} 条`, meta);
    if (dryRunResult.prevStationSelected) logger.info('[Agent][Integrated] 上一站选中', meta);
    if (dryRunResult.integratedCheckboxChecked) logger.info('[Agent][Integrated] 到派一体勾选', meta);
    if (dryRunResult.courierSelected) logger.info(`[Agent][Integrated] 派件员选择完成：${assignment.targetCourierName}`, meta);
    logger.info('[Agent][Integrated] 已执行到最终提交前', meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Integrated][安全门] 跳过最终提交', meta);
    } else {
      logger.info('[Agent][Integrated] dry-run 跳过最终提交', meta);
    }

    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    if (page) {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'integrated-before-done');
    }

    logger.success('[Agent][Integrated] 到派一体浏览器 DRY-RUN 完成，未点击最终提交', meta);
    logger.info('[Agent][Integrated] READY 窗口任务完成，浏览器保持运行（由 Backend 管理）', meta);
    await logger.flush();

    const status = browserDryRun ? 'dry_run' : 'SAFETY_GATE_SKIPPED';
    const results = assignment.waybillNos.map(waybillNo => ({
      waybillNo,
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      status,
      message: `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，未提交到派一体`,
    }));

    logger.success('[Agent][Integrated] assignment 本地执行完成', meta);
    await logger.flush();
    return {
      staffName: assignment.executionStaffName,
      targetCourierName: assignment.targetCourierName,
      windowId: meta.windowId,
      success: true,
      doneCount: results.length,
      failCount: 0,
      summary: makeAssignmentSummary(assignment, results.length, 0, {
        success: true,
        inputCount: dryRunResult.inputCount,
        prevStationSelected: dryRunResult.prevStationSelected,
        integratedCheckboxChecked: dryRunResult.integratedCheckboxChecked,
        courierSelected: dryRunResult.courierSelected,
        pageUrl: dryRunResult.pageUrl,
        message: browserDryRun
          ? '到派一体浏览器 DRY-RUN 完成（READY 窗口接管），未点击最终提交'
          : '到派一体已执行到最终提交前，ENABLE_REAL_SUBMIT 未开启，已跳过最终提交',
      }),
      results,
      successCount: results.length,
      failedCount: 0,
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[IntegratedExecutor] assignment ${assignmentIndex + 1}/${assignmentCount} 执行失败：${msg}`);
    logger.error(`[Agent][Integrated] assignment 执行失败：${msg}`, meta);
    await logger.flush();

    if (page) {
      try {
        await restoreCleanHome(page, log, meta);
        await afterPageChangedCleanup(page, log, meta, 'integrated-catch');
      } catch (cleanupErr) {
        logger.warning(`[Agent][Integrated] 失败路径回首页异常（忽略）: ${(cleanupErr as Error).message}`, meta);
      }
    }

    logger.info('[Agent][Integrated] 失败路径：READY 窗口浏览器保持运行（由 Backend 管理）', meta);
    return failAssignment(msg);
  } finally {
    if (busyWindowId) {
      releaseWindowBusy(busyWindowId, taskId);
    }
    await logger.close();
  }
}

export async function executeIntegratedDryRun(
  task: IntegratedTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  // Phase M-3B: dryRunMode 为主字段，browserDryRun/dryRun 仅兼容
  const browserDryRun = payload.dryRunMode ?? payload.browserDryRun ?? payload.dryRun ?? true;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const prevStation = firstString(payload.prevStation, optionString(payload.options, 'prevStation'), '天津分拨中心');
  const assignments = parseIntegratedAssignments(payload);
  const totalWaybills = assignments.reduce((sum, a) => sum + a.waybillNos.length, 0);
  const taskLogger = createAgentLogger(client, taskId);

  try {
    console.log(`[Agent][Integrated] 收到任务 taskId=${taskId}`);
    console.log(`[Agent][Integrated][执行配置] browserDryRun=${browserDryRun}`);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      console.log('[Agent][Integrated][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交');
    }

    taskLogger.info(createIntegratedRuntimeProof(), { siteId });
    taskLogger.info('[Agent][Integrated] 本地执行开始', { siteId });
    taskLogger.info(`[Agent][Integrated] assignmentCount=${assignments.length}，total=${totalWaybills}`, { siteId });
    await taskLogger.flush();

    if (assignments.length === 0 || totalWaybills === 0) {
      const message = '[Agent][Integrated] 未找到 waybillNos，无法执行到派一体';
      taskLogger.error(message, { siteId });
      await taskLogger.close();
      await failTask(client, taskId, message);
      return;
    }

    await reportProgress(client, taskId, 'running', 5);

    const assignmentSummaries: Record<string, unknown>[] = [];
    const results: Array<Record<string, unknown>> = [];
    const concurrency = Math.max(1, Math.min(assignments.length, MAX_INTEGRATED_ASSIGNMENT_CONCURRENCY));
    taskLogger.info(`[Agent][Integrated] parallel assignments start count=${assignments.length} concurrency=${concurrency}`, { siteId });
    console.log(`[Agent][Integrated] parallel assignments start count=${assignments.length} concurrency=${concurrency}`);
    await taskLogger.flush();

    const preparedAssignments = await prepareIntegratedAssignments(task, client, assignments);
    const settled = await runWithConcurrency(preparedAssignments, concurrency, async (prepared) => executeOneIntegratedAssignment(
      task,
      prepared.assignment,
      prepared.assignmentIndex,
      assignments.length,
      client,
      settingsLoader,
      config,
      browserDryRun,
      siteName,
      prevStation,
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

    taskLogger.info(`[Agent][Integrated] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`, { siteId });
    console.log(`[Agent][Integrated] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`);

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
        ? '到派一体所有 assignments 执行完成（READY 窗口接管），未点击最终提交'
        : `到派一体完成：成功 ${successCount} 条，失败 ${failedCount} 条`,
    };

    taskLogger.success('[Agent][Integrated] 本地执行完成', { siteId });
    await taskLogger.flush();
    if (successAssignments > 0) {
      await completeTask(client, taskId, summary, results);
      console.log('[IntegratedExecutor] 任务完成，已回传 Cloud');
    } else {
      await failTask(client, taskId, summary.message);
      console.log('[IntegratedExecutor] 任务全部失败，已回传 Cloud');
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[IntegratedExecutor] 任务 ${taskId} 执行失败：${msg}`);
    taskLogger.error(`[Agent][Integrated] 执行失败：${msg}`, { siteId });
    await taskLogger.flush();
    await failTask(client, taskId, msg);
  } finally {
    await taskLogger.close();
  }
}
