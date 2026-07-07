/**
 * SignExecutor — 签收录入 Agent 本地执行器
 *
 * Phase K-2D: Sign 从 Cloud run-engine 兼容路径迁回 Agent。
 * Phase K-3C: Sign 真 Agent 迁移 — READY 窗口 CDP 接管 + 多员工并行执行。
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
import { runSignBrowserDryRun } from '../browser/SignBrowserDryRun';
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

type PageSize = 30 | 50 | 100 | 200;
type SignerName = '本人' | '家人' | '家门口' | '代收点';

const STANDARD_SIGNERS: Array<{ name: SignerName; weight: number }> = [
  { name: '本人', weight: 50 },
  { name: '家人', weight: 15 },
  { name: '家门口', weight: 10 },
  { name: '代收点', weight: 25 },
];

const DEFAULT_PAGE_SIZE: PageSize = 100;
const MAX_SIGN_ASSIGNMENT_CONCURRENCY = 5;

interface SignAssignmentPayload {
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  windowId?: string;
  waybillNos?: string[];
  waybills?: string[];
  pageSize?: number;
  signerPerson?: SignerName;
  targetCourierName?: string;
  targetCourierAccount?: string;
  dateRange?: { start?: string; end?: string };
}

interface SignPayload {
  waybillNos?: string[];
  waybills?: string[];
  assignments?: SignAssignmentPayload[];
  inputData?: {
    waybillNos?: string[];
    waybills?: string[];
    assignments?: SignAssignmentPayload[];
  };
  options?: Record<string, unknown>;
  siteName?: string;
  dryRun?: boolean;
  dryRunMode?: boolean;
  browserDryRun?: boolean;
  signRatio?: Record<string, number>;
  signers?: string[];
  pageSize?: number;
  strategy?: string;
  staffName?: string;
  workerName?: string;
  executionStaffName?: string;
  windowStaffName?: string;
  windowId?: string;
  signerPerson?: SignerName;
  targetCourierName?: string;
  targetCourierAccount?: string;
  dateRange?: { start?: string; end?: string };
}

interface SignTask {
  taskId: string;
  siteId: string;
  tenantId?: string;
  workstationId?: string;
  payload: SignPayload;
}

interface SignAgentAssignment {
  executionStaffName: string;
  windowId: string;
  waybillNos: string[];
  pageSize: PageSize;
  signerPerson?: SignerName;
  targetCourierName: string;
  dateRange?: { start: string; end: string };
}

interface SignPlan {
  assignments: SignerName[];
  counts: Record<SignerName, number>;
  totalPages: number;
}

interface AssignmentRunResult {
  staffName: string;
  windowId?: string;
  success: boolean;
  doneCount: number;
  failCount: number;
  searchedCount?: number;
  dryRunStopped?: boolean;
  finalSubmitClicked?: boolean;
  error?: string;
  summary: Record<string, unknown>;
  results: Array<Record<string, unknown>>;
  successCount: number;
  failedCount: number;
}

interface PreparedSignAssignment {
  assignment: SignAgentAssignment;
  assignmentIndex: number;
  matchedWindow?: WindowConnection;
  preflightError?: string;
}

// ── 工具函数 ──

function uniqueNonEmpty(values: unknown[]): string[] {
  return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))];
}

function firstString(...values: unknown[]): string {
  return String(values.find(v => typeof v === 'string' && v.trim()) || '').trim();
}

function optionString(options: Record<string, unknown> | undefined, key: string): string {
  return firstString(options?.[key]);
}

function normalizePageSize(value: unknown): PageSize {
  const n = Number(value);
  return ([30, 50, 100, 200] as number[]).includes(n) ? n as PageSize : DEFAULT_PAGE_SIZE;
}

function normalizeDateRange(value: unknown): { start: string; end: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const range = value as { start?: unknown; end?: unknown };
  const start = firstString(range.start);
  const end = firstString(range.end);
  return start && end ? { start, end } : undefined;
}

function collectAssignments(payload: SignPayload): SignAssignmentPayload[] {
  const direct = Array.isArray(payload.assignments) ? payload.assignments : [];
  const input = Array.isArray(payload.inputData?.assignments) ? payload.inputData!.assignments! : [];
  return direct.length > 0 ? direct : input;
}

function collectTopLevelWaybills(payload: SignPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(payload.waybillNos) ? payload.waybillNos : []),
    ...(Array.isArray(payload.waybills) ? payload.waybills : []),
    ...(Array.isArray(payload.inputData?.waybillNos) ? payload.inputData!.waybillNos! : []),
    ...(Array.isArray(payload.inputData?.waybills) ? payload.inputData!.waybills! : []),
  ]);
}

function collectAssignmentWaybills(assignment: SignAssignmentPayload): string[] {
  return uniqueNonEmpty([
    ...(Array.isArray(assignment.waybillNos) ? assignment.waybillNos : []),
    ...(Array.isArray(assignment.waybills) ? assignment.waybills : []),
  ]);
}

function parseSignAssignments(payload: SignPayload): SignAgentAssignment[] {
  const assignments = collectAssignments(payload);
  const options = payload.options || {};

  if (assignments.length > 0) {
    return assignments.map((assignment, index) => {
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
      const waybills = collectAssignmentWaybills(assignment);
      return {
        executionStaffName,
        targetCourierName: firstString(assignment.targetCourierName, payload.targetCourierName, executionStaffName),
        windowId: firstString(
          assignment.windowId,
          payload.windowId,
          optionString(options, 'windowId'),
          executionStaffName ? `staff-${executionStaffName}` : '',
        ),
        waybillNos: waybills.length > 0 ? waybills : [`SIGN_PREVIEW_${index + 1}`],
        pageSize: normalizePageSize(assignment.pageSize ?? payload.pageSize ?? optionString(options, 'pageSize')),
        signerPerson: assignment.signerPerson || payload.signerPerson,
        dateRange: normalizeDateRange(assignment.dateRange)
          || normalizeDateRange(payload.dateRange)
          || normalizeDateRange(options.dateRange),
      };
    });
  }

  const topLevelWaybills = collectTopLevelWaybills(payload);
  const executionStaffName = firstString(
    payload.executionStaffName,
    payload.windowStaffName,
    payload.staffName,
    payload.workerName,
    optionString(options, 'executionStaffName'),
    optionString(options, 'windowStaffName'),
    optionString(options, 'staffName'),
    optionString(options, 'workerName'),
  );

  return [{
    executionStaffName,
    windowId: firstString(payload.windowId, optionString(options, 'windowId'), executionStaffName ? `staff-${executionStaffName}` : ''),
    waybillNos: topLevelWaybills.length > 0 ? topLevelWaybills : ['SIGN_PREVIEW_1'],
    pageSize: normalizePageSize(payload.pageSize ?? optionString(options, 'pageSize')),
    signerPerson: payload.signerPerson,
    targetCourierName: firstString(payload.targetCourierName, executionStaffName),
    dateRange: normalizeDateRange(payload.dateRange) || normalizeDateRange(options.dateRange),
  }];
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function emptySignerCounts(): Record<SignerName, number> {
  return { '本人': 0, '家人': 0, '家门口': 0, '代收点': 0 };
}

function generateSignPlan(totalPages: number, fixedSigner?: SignerName): SignPlan {
  const counts = emptySignerCounts();
  if (totalPages <= 0) return { assignments: [], counts, totalPages };

  if (fixedSigner) {
    counts[fixedSigner] = totalPages;
    return { assignments: Array(totalPages).fill(fixedSigner), counts, totalPages };
  }

  const remainders: Array<{ name: SignerName; remainder: number }> = [];
  let allocated = 0;
  for (const signer of STANDARD_SIGNERS) {
    const exact = (signer.weight / 100) * totalPages;
    const floor = Math.floor(exact);
    counts[signer.name] = floor;
    remainders.push({ name: signer.name, remainder: exact - floor });
    allocated += floor;
  }
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < totalPages - allocated; i++) {
    counts[remainders[i].name]++;
  }

  const ordered: SignerName[] = [];
  for (const signer of STANDARD_SIGNERS) {
    for (let i = 0; i < counts[signer.name]; i++) ordered.push(signer.name);
  }
  return { assignments: fisherYatesShuffle(ordered), counts, totalPages };
}

function makeFailedResults(assignment: SignAgentAssignment, message: string): Array<Record<string, unknown>> {
  return assignment.waybillNos.map(waybillNo => ({
    waybillNo,
    staffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    status: 'failed',
    message: `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，签收录入失败：${message}`,
  }));
}

function makeAssignmentSummary(
  assignment: SignAgentAssignment,
  plan: SignPlan,
  successCount: number,
  failedCount: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionStaffName: assignment.executionStaffName,
    targetCourierName: assignment.targetCourierName,
    windowId: assignment.windowId,
    total: assignment.waybillNos.length,
    successCount,
    failedCount,
    pageSize: assignment.pageSize,
    signerDistribution: plan.counts,
    finalSubmitClicked: false,
    ...extra,
  };
}

function makePreflightFailureResult(assignment: SignAgentAssignment, message: string): AssignmentRunResult {
  const plan = generateSignPlan(Math.max(1, Math.ceil(assignment.waybillNos.length / assignment.pageSize)), assignment.signerPerson);
  const failedResults = makeFailedResults(assignment, message);
  return {
    staffName: assignment.executionStaffName,
    windowId: assignment.windowId,
    success: false,
    doneCount: 0,
    failCount: failedResults.length,
    error: message,
    summary: makeAssignmentSummary(assignment, plan, 0, failedResults.length, { success: false, message }),
    results: failedResults,
    successCount: 0,
    failedCount: failedResults.length,
  };
}

function createSignRuntimeProof(): string {
  return '[RuntimeProof][SignExecutor] mode=READY_CDP_ATTACH noNewChrome=true noRelogin=true parallel=true dryRun=true buildTime=K-3C';
}

// ── 并发控制 ──

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

// ── 预匹配 ──

async function prepareSignAssignments(
  task: SignTask,
  client: AxiosInstance,
  assignments: SignAgentAssignment[],
): Promise<PreparedSignAssignment[]> {
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
        assignment, assignmentIndex, matchedWindow: matched,
        preflightError: `READY_WINDOW_SITE_MISMATCH: 窗口 siteId=${matched.siteId}，任务 siteId=${siteId}，不一致`,
      };
    }
    if (matched.staffName !== assignment.executionStaffName) {
      return {
        assignment, assignmentIndex, matchedWindow: matched,
        preflightError: `READY_WINDOW_STAFF_MISMATCH: 窗口 staffName=${matched.staffName}，任务 executionStaffName=${assignment.executionStaffName}，不一致`,
      };
    }
    if (!matched.cdpAttachable) {
      return {
        assignment, assignmentIndex, matchedWindow: matched,
        preflightError: `READY_WINDOW_NOT_ATTACHABLE: 窗口 ${matched.windowId} cdpAttachable=false`,
      };
    }
    if (!matched.cdpEndpoint) {
      return {
        assignment, assignmentIndex, matchedWindow: matched,
        preflightError: `READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空`,
      };
    }
    if (usedWindowIds.has(matched.windowId)) {
      return {
        assignment, assignmentIndex, matchedWindow: matched,
        preflightError: `READY_WINDOW_DUPLICATED: 窗口 ${matched.windowId} 被多个 assignment 同时使用`,
      };
    }

    usedWindowIds.add(matched.windowId);
    return { assignment, assignmentIndex, matchedWindow: matched };
  });
}

// ── 单 assignment CDP 接管执行 ──

async function executeOneSignAssignment(
  task: SignTask,
  assignment: SignAgentAssignment,
  assignmentIndex: number,
  assignmentCount: number,
  client: AxiosInstance,
  _settingsLoader: AgentSettingsLoader,
  _config: AgentConfig | undefined,
  browserDryRun: boolean,
  siteName: string,
  preMatchedWindow?: WindowConnection,
  preflightError?: string,
): Promise<AssignmentRunResult> {
  const { taskId, siteId } = task;
  const meta = { staffName: assignment.executionStaffName, windowId: assignment.windowId, siteId };
  const logger = createAgentLogger(client, taskId);
  const log = createRuntimeLogFn(logger, meta);
  const totalPages = Math.max(1, Math.ceil(assignment.waybillNos.length / assignment.pageSize));
  const plan = generateSignPlan(totalPages, assignment.signerPerson);
  let page: Page | null = null;
  let busyWindowId: string | null = null;

  const failAssignment = async (message: string): Promise<AssignmentRunResult> => {
    logger.error(`[Agent][Sign] ${message}`, meta);
    await logger.flush();
    const failedResults = makeFailedResults(assignment, message);
    return {
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      success: false,
      doneCount: 0,
      failCount: failedResults.length,
      error: message,
      summary: makeAssignmentSummary(assignment, plan, 0, failedResults.length, { success: false, message }),
      results: failedResults,
      successCount: 0,
      failedCount: failedResults.length,
    };
  };

  try {
    // RuntimeProof + Guard
    const runtimeProof = createSignRuntimeProof();
    console.log(runtimeProof);
    console.log(`[Agent][Sign][${assignment.executionStaffName}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId}`);
    logger.info(runtimeProof, meta);
    logger.info('[Agent][Sign][Guard] SIGN_NEW_BROWSER_FORBIDDEN active; SIGN_RELOGIN_FORBIDDEN active; SIGN_REAL_SUBMIT_FORBIDDEN active', meta);
    logger.info(`[Agent][Sign][${assignment.executionStaffName}] assignment parallel start index=${assignmentIndex + 1}/${assignmentCount} windowId=${assignment.windowId}`, meta);
    logger.info(`[Agent][Sign] 执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，单号数量=${assignment.waybillNos.length}，pageSize=${assignment.pageSize}`, meta);
    logger.info(`[Agent][Sign] 签收计划：总${plan.totalPages}页，本人${plan.counts['本人']}页/家人${plan.counts['家人']}页/家门口${plan.counts['家门口']}页/代收点${plan.counts['代收点']}页`, meta);

    if (!assignment.executionStaffName) {
      return failAssignment('READY_WINDOW_STAFF_MISMATCH: 未找到执行窗口员工，无法匹配 READY 窗口');
    }
    if (assignment.waybillNos.length === 0) {
      return failAssignment('assignment 未找到 waybillNos，跳过该员工');
    }
    if (preflightError) {
      return failAssignment(preflightError);
    }

    logger.info(`[Agent][Sign][执行配置] browserDryRun=${browserDryRun} SIGN_DRY_RUN=true`, meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Sign][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交', meta);
    }
    logger.info(`[Agent][Sign] 网点：${siteName}`, meta);

    // ── CDP 接管 ──
    if (!preMatchedWindow) {
      return failAssignment(`READY_WINDOW_NOT_FOUND: staffName=${assignment.executionStaffName} siteId=${siteId}`);
    }
    const matched = preMatchedWindow;

    meta.windowId = matched.windowId;
    acquireWindowBusy({
      windowId: matched.windowId,
      taskId,
      siteId,
      staffName: assignment.executionStaffName,
      taskType: 'sign',
    });
    busyWindowId = matched.windowId;
    logger.info(`[Agent][Sign] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId} cdpAttachable=true`, meta);
    console.log(`[Agent][Sign] 匹配 READY 窗口成功 staffName=${matched.staffName} windowId=${matched.windowId}`);

    logger.info(`[Agent][Sign] connectOverCDP 开始 windowId=${matched.windowId}`, meta);
    console.log(`[Agent][Sign] connectOverCDP 开始 windowId=${matched.windowId}`);
    try {
      const cdpEndpoint = matched.cdpEndpoint;
      if (!cdpEndpoint) {
        return failAssignment(`READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 ${matched.windowId} cdpEndpoint 为空`);
      }
      const { page: cdpPage } = await BrowserManager.connectExisting(cdpEndpoint);
      page = cdpPage;
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[Agent][Sign] CDP_CONNECT_FAILED: ${msg}`, meta);
      return failAssignment(`CDP_CONNECT_FAILED: ${msg}`);
    }

    logger.success(`[Agent][Sign] connectOverCDP 成功 windowId=${matched.windowId}`, meta);
    logger.info('[Agent][Sign] 使用 READY 窗口执行，不新开 Chrome', meta);
    console.log(`[Agent][Sign] connectOverCDP 成功 windowId=${matched.windowId}`);

    registerNativeAlertGuard(page, log, meta);
    logger.info('[Agent][Sign] Native alert guard 已注册', meta);
    await drainNativeAlerts(page, 1200, 150, log, meta);

    const homeResult = await ensureCleanHome(page, log, meta);
    if (!homeResult.success) {
      logger.warning(`[Agent][Sign] ensureCleanHome 失败: ${homeResult.error}，继续做 Dashboard 状态校验`, meta);
    }

    logger.info('[Agent][Sign] 验证 READY 窗口 Dashboard 状态...', meta);
    const dashboardStatus = await detectBnsyDashboardP0(page);
    await drainNativeAlerts(page, 2500, 150, log, meta);
    if (!dashboardStatus.isLoggedIn || dashboardStatus.status !== 'READY') {
      return failAssignment(`READY_WINDOW_DASHBOARD_NOT_READY: 窗口 ${matched.windowId} 登录态已失效。READY 窗口接管要求预登录窗口，不执行重登。`);
    }

    logger.success(`[Agent][Sign] READY 窗口 Dashboard 验证通过: ${dashboardStatus.message}`, meta);
    logger.info('[Agent][Sign] 不新开 Chrome，不重新登录', meta);

    logger.info('[Agent][Sign] 准备进入签收录入页面', meta);
    await logger.flush();

    const dryRunResult = await runSignBrowserDryRun(page, {
      siteId,
      siteName,
      options: { staffName: assignment.targetCourierName, pageSize: assignment.pageSize, dateRange: assignment.dateRange },
      log,
      meta,
    });

    // Phase I-4-Sign-Fix: Check success FIRST before printing success logs,
    // avoiding misleading success messages when the task actually failed.
    if (!dryRunResult.success) {
      logger.error(`[Agent][Sign] DRY-RUN 失败: ${dryRunResult.message}`, meta);
      if (dryRunResult.validationLogs.length > 0) {
        logger.info(`[Agent][Sign] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
        for (const msg of dryRunResult.validationLogs) {
          logger.info(`[Agent][Sign] ${msg}`, meta);
        }
      }
      throw new Error(dryRunResult.message);
    }

    logger.info('[Agent][Sign] 已进入签收录入页面', meta);
    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`[Agent][Sign] 校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`, meta);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(`[Agent][Sign] ${msg}`, meta);
      }
    }
    if (dryRunResult.searched) logger.info('[Agent][Sign] 已点击搜索', meta);
    if (dryRunResult.pageSizeApplied) logger.info(`[Agent][Sign] pageSize 已设置：${dryRunResult.pageSizeApplied}`, meta);
    if (dryRunResult.courierSelected) logger.info(`[Agent][Sign] 派件员已选择：${assignment.targetCourierName}`, meta);
    logger.info('[Agent][Sign] 已执行到最终签收提交前', meta);
    logger.info('[Agent][Sign] SIGN_DRY_RUN=true，禁止真实签收', meta);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      logger.warning('[Agent][Sign][安全门] 跳过最终提交', meta);
    } else {
      logger.info('[Agent][Sign] dry-run 跳过最终提交', meta);
    }

    if (page) {
      await restoreCleanHome(page, log, meta);
      await afterPageChangedCleanup(page, log, meta, 'sign-before-done');
    }

    logger.success('[Agent][Sign] 签收录入浏览器 DRY-RUN 完成，未点击最终提交', meta);
    logger.info('[Agent][Sign] READY 窗口任务完成，浏览器保持运行（由 Backend 管理）', meta);
    await logger.flush();

    const status = browserDryRun ? 'dry_run' : 'SAFETY_GATE_SKIPPED';
    const results = assignment.waybillNos.map(waybillNo => ({
      waybillNo,
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      status,
      message: `执行窗口=${assignment.executionStaffName}，目标派件员=${assignment.targetCourierName}，签收录入已执行到最终提交前，未提交签收`,
    }));

    logger.success('[Agent][Sign] assignment 本地执行完成', meta);
    await logger.flush();
    return {
      staffName: assignment.executionStaffName,
      windowId: meta.windowId,
      success: true,
      doneCount: results.length,
      failCount: 0,
      searchedCount: dryRunResult.searched ? plan.totalPages : 0,
      dryRunStopped: true,
      finalSubmitClicked: false,
      summary: makeAssignmentSummary(assignment, plan, results.length, 0, {
        success: true,
        searched: dryRunResult.searched,
        pageUrl: dryRunResult.pageUrl,
        message: browserDryRun
          ? '签收录入浏览器 DRY-RUN 完成（READY 窗口接管），未点击最终提交'
          : '签收录入已执行到最终提交前，ENABLE_REAL_SUBMIT 未开启，已跳过最终提交',
      }),
      results,
      successCount: results.length,
      failedCount: 0,
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[SignExecutor] assignment ${assignmentIndex + 1}/${assignmentCount} 执行失败：${msg}`);
    logger.error(`[Agent][Sign] assignment 执行失败：${msg}`, meta);
    await logger.flush();

    if (page) {
      try {
        await restoreCleanHome(page, log, meta);
        await afterPageChangedCleanup(page, log, meta, 'sign-catch');
      } catch (restoreErr) {
        logger.warning(`[Agent][Sign] 失败路径回首页异常（忽略）: ${(restoreErr as Error).message}`, meta);
      }
    }

    logger.info('[Agent][Sign] 失败路径：READY 窗口浏览器保持运行（由 Backend 管理）', meta);
    return failAssignment(msg);
  } finally {
    if (busyWindowId) {
      releaseWindowBusy(busyWindowId, taskId);
    }
    await logger.close();
  }
}

// ── 并行入口 ──

export async function executeSignDryRun(
  task: SignTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  // Phase M-3B: dryRunMode 为主字段，browserDryRun/dryRun 仅兼容
  const browserDryRun = payload.dryRunMode ?? payload.browserDryRun ?? payload.dryRun ?? true;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const assignments = parseSignAssignments(payload);
  const total = assignments.reduce((sum, a) => sum + a.waybillNos.length, 0);
  const taskLogger = createAgentLogger(client, taskId);

  try {
    console.log(`[Agent][Sign] 收到任务 taskId=${taskId}`);
    console.log(`[Agent][Sign][执行配置] browserDryRun=${browserDryRun} SIGN_DRY_RUN=true`);
    if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
      console.log('[Agent][Sign][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交');
    }

    taskLogger.info(createSignRuntimeProof(), { siteId });
    taskLogger.info('[Agent][Sign] 收到任务', { siteId });
    taskLogger.info(`[Agent][Sign] assignmentCount=${assignments.length}，total=${total}`, { siteId });
    await taskLogger.flush();

    if (assignments.length === 0 || total === 0) {
      const message = '[Agent][Sign] 未找到 waybillNos，无法执行签收录入';
      taskLogger.error(message, { siteId });
      await taskLogger.close();
      await failTask(client, taskId, message);
      return;
    }

    await reportProgress(client, taskId, 'running', 5);

    const assignmentSummaries: Record<string, unknown>[] = [];
    const results: Array<Record<string, unknown>> = [];
    const concurrency = Math.max(1, Math.min(assignments.length, MAX_SIGN_ASSIGNMENT_CONCURRENCY));
    taskLogger.info(`[Agent][Sign] parallel assignments start count=${assignments.length} concurrency=${concurrency}`, { siteId });
    console.log(`[Agent][Sign] parallel assignments start count=${assignments.length} concurrency=${concurrency}`);
    await taskLogger.flush();

    const preparedAssignments = await prepareSignAssignments(task, client, assignments);
    const settled = await runWithConcurrency(preparedAssignments, concurrency, async (prepared) => executeOneSignAssignment(
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

    taskLogger.info(`[Agent][Sign] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`, { siteId });
    console.log(`[Agent][Sign] parallel assignments settled success=${successAssignments} failed=${failedAssignments}`);

    await reportProgress(client, taskId, 'running', 95);

    const aggregateDistribution = emptySignerCounts();
    for (const summary of assignmentSummaries) {
      const dist = summary.signerDistribution as Partial<Record<SignerName, number>> | undefined;
      for (const signer of STANDARD_SIGNERS) {
        aggregateDistribution[signer.name] += dist?.[signer.name] || 0;
      }
    }

    const summary = {
      mode: browserDryRun ? 'browserDryRun' : 'realSubmitBlockedBySafetyGate',
      assignmentCount: assignments.length,
      successAssignments,
      failedAssignments,
      concurrency,
      total,
      successCount,
      failedCount,
      finalSubmitClicked: false,
      pageSize: assignments[0]?.pageSize || DEFAULT_PAGE_SIZE,
      signerDistribution: aggregateDistribution,
      assignments: assignmentSummaries,
      message: failedCount === 0
        ? '签收录入所有 assignments 执行完成（READY 窗口接管），未点击最终提交'
        : `签收录入完成：成功 ${successCount} 条，失败 ${failedCount} 条`,
    };

    taskLogger.success('[Agent][Sign] 本地执行完成', { siteId });
    await taskLogger.flush();
    if (successAssignments > 0) {
      await completeTask(client, taskId, summary, results);
      console.log('[SignExecutor] 任务完成，已回传 Cloud');
    } else {
      await failTask(client, taskId, summary.message);
      console.log('[SignExecutor] 任务全部失败，已回传 Cloud');
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[SignExecutor] 任务 ${taskId} 执行失败：${msg}`);
    taskLogger.error(`[Agent][Sign] 执行失败：${msg}`, { siteId });
    await taskLogger.flush();
    await failTask(client, taskId, msg);
  } finally {
    await taskLogger.close();
  }
}
