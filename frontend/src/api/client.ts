// API 客户端
// 封装所有后端 REST 接口调用，统一错误处理
//
// ⚠️ 以下所有类型必须与 src/types/api-contracts.ts 保持 1:1 同步
//    任何字段新增/变更 → 先改 api-contracts.ts → 再改本文件
//    版本: v1.0 (2026-06-22)
//
// Phase 3-D: 新增 fetchWithAuth — 自动携带 Bearer token + 401 自动 refresh

import { getAccessToken, getRefreshToken, setAccessToken, clearAllTokens, triggerAuthFailure } from '../stores/authStore';

// ── 安全 JSON 解析（Phase 3-D-1-A）──

async function parseJsonSafely(resp: Response): Promise<Record<string, unknown> | null> {
  const text = await resp.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── fetchWithAuth: 自动携带 Bearer token + 401 自动 refresh ──

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (isRefreshing) return refreshPromise!;
  isRefreshing = true;
  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;
    try {
      const resp = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!resp.ok) {
        clearAllTokens();
        return null;
      }
      const data = await parseJsonSafely(resp);
      if (!data || !data.accessToken) return null;
      setAccessToken(data.accessToken as string);
      return data.accessToken as string;
    } catch {
      return null;
    } finally {
      isRefreshing = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let resp = await fetch(url, { ...options, headers });

  // 401 → 尝试 refresh 一次
  if (resp.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers['Authorization'] = `Bearer ${newToken}`;
      resp = await fetch(url, { ...options, headers });
    } else {
      // refresh 失败 → 清空 token 并跳转登录
      triggerAuthFailure();
    }
  }

  return resp;
}

// ── 基础字面量类型 ──
// MUST SYNC WITH src/types/api-contracts.ts

/** 任务生命周期状态 */
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务类型 */
export type TaskType = 'arrive' | 'arrival' | 'dispatch' | 'sign' | 'integrated';

/** 窗口角色 */
export type WindowRole = 'admin' | 'staff';

/** 日志级别 */
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

/** 运单结果详细状态 */
export type WaybillResultStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNKNOWN_NEEDS_MANUAL_CHECK' | 'DRY_RUN_SKIPPED';

// ── 核心实体 ──
// MUST SYNC WITH src/types/api-contracts.ts

/** EasyBR 窗口信息 */
export interface WindowInfo {
  id: string;
  name: string;
  cdpPort: number;
  role: WindowRole;
  site: string;
  staffName: string | null;
  isConnected: boolean;
  /** 是否启用（用户 toggle 状态） */
  enabled: boolean;
}

/** Phase 3-D-3: 本地浏览器运行时状态 */
export type BrowserRuntimeStatus = 'available' | 'unavailable' | 'degraded';

export interface RuntimeStatusResponse {
  alive: boolean;
  authRequired?: boolean;
  runtime: BrowserRuntimeStatus;
  runtimeError: string | null;
  total: number;
  connected: number;
  windows: unknown[];
  error?: string;
}

/** GET /api/status — 获取运行时状态 */
export async function getRuntimeStatus(): Promise<RuntimeStatusResponse> {
  const resp = await fetch('/api/status');
  if (!resp.ok) {
    return { alive: false, runtime: 'unavailable', runtimeError: '无法获取状态', total: 0, connected: 0, windows: [] };
  }
  return resp.json();
}

/** 运行时指标快照 */
export interface RuntimeMetricsSnapshot {
  popupDismissCount: number;
  sessionRecoverCount: number;
  sessionRecoverSuccessCount: number;
  sessionRecoverFailCount: number;
  navigationFixCount: number;
  taskSuccessCount: number;
  taskFailCount: number;
  startTime: string;
  snapshotTime: string;
  uptimeMs: number;
}

/** 运单操作结果 */
export interface WaybillResult {
  waybillNo: string;
  /** 处理该运单的员工姓名（到件扫描可能为 undefined） */
  staffName?: string;
  success: boolean;
  message: string;
  timestamp: number;
  /** 详细状态（此前缺失，现已修复） */
  status?: WaybillResultStatus;
  /** Phase 9-dryrun: 试运行模式标记 */
  dryRun?: boolean;
  /** Phase 9-dryrun: 是否跳过了最终提交 */
  skippedFinalSubmit?: boolean;
}

/** 向后兼容别名 */
export type OperationResult = WaybillResult;

/** 任务执行日志 */
export interface TaskLogEntry {
  id: string;
  taskId: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  source: string;
  staffName?: string;
  windowId?: string;
}

/** 任务列表项 */
export interface TaskItem {
  id: string;
  type: TaskType;
  site: string;
  /** 网点显示名称，例如 "天南大"，无名称时回退为 site id */
  siteName?: string;
  /** 含 'cancelled'（此前缺失，现已修复） */
  status: TaskStatus;
  totalCount: number;
  doneCount: number;
  failCount: number;
  inputData?: string;
  createdAt: string;
  finishedAt?: string | null;
  /** 参与员工数（来自 waybill_results.staff_name DISTINCT） */
  staffCount?: number;
}

/** 网点窗口凭据 */
export interface WindowCredential {
  windowName: string;
  employeeName: string;
  username: string;
  password: string;
  /** EasyBR 浏览器 ID（精准定位，用于直接 open 窗口） */
  easybrBrowserId?: string;
}

/** 网点配置 */
export interface SiteConfig {
  id: string;
  name: string;
  windows: WindowCredential[];
}

// ── API 请求/响应契约 ──
// MUST SYNC WITH src/types/api-contracts.ts

/** GET /api/status 响应 */
export interface StatusResponse {
  total: number;
  connected: number;
  windows: WindowInfo[];
  /** 运行时指标快照（此前缺失，现已修复） */
  runtimeMetrics: RuntimeMetricsSnapshot;
}

/** GET /api/operations/:taskId 响应 */
export interface TaskProgressResponse {
  taskId: string;
  /** 含 'cancelled'（此前缺失，现已修复） */
  status: TaskStatus;
  total: number;
  done: number;
  failCount: number;
  results: WaybillResult[];
}

/** 向后兼容别名 */
export type TaskProgress = TaskProgressResponse;

/** GET /api/operations 响应 */
export interface TaskListResponse {
  page: number;
  limit: number;
  /** 符合条件的任务真实总数（此前仅返回当前页长度，语义错误，现已修复） */
  total: number;
  tasks: TaskItem[];
}

/** POST /api/operations/* 响应 */
export interface TaskSubmitResponse {
  taskId: string;
  id?: string;
  status: 'pending';
}

/** GET /api/settings/config 响应 */
export interface SettingsConfigResponse {
  initialized: boolean;
  sites: SiteConfig[];
}

// ── 任务详情 API 响应 ──

/** GET /api/tasks/:id/logs 响应 */
export interface TaskLogsResponse {
  taskId: string;
  logs: TaskLogEntry[];
  total: number;
}

/** GET /api/tasks/:id/waybills 响应 */
export interface TaskWaybillsResponse {
  taskId: string;
  waybills: WaybillResult[];
  total: number;
}

/** GET /api/tasks/:id/summary 响应 */
export interface TaskSummaryResponse {
  taskId: string;
  type: string;
  siteId: string;
  status: string;
  totalCount: number;
  doneCount: number;
  failCount: number;
  createdAt: string;
  finishedAt: string | null;
  successCount: number;
  partialCount: number;
  failedCount: number;
  unknownCount: number;
}

/** GET /api/tasks/:id/staff 响应 */
export interface TaskStaffResponse {
  taskId: string;
  workers: WorkerStat[];
}

export interface WorkerStat {
  staffName: string;
  total: number;
  successCount: number;
  failCount: number;
}

// ── 常量 ──

const BASE = '/api';

// ── API 方法 ──

/** 获取所有窗口连接状态 */
export async function fetchStatus(): Promise<StatusResponse> {
  const resp = await fetchWithAuth(`${BASE}/status`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 提交到件扫描任务 */
export async function submitArriveTask(
  site: string,
  waybillNos: string[],
): Promise<TaskSubmitResponse> {
  const resp = await fetchWithAuth(`${BASE}/operations/arrive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site, waybillNos }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 查询任务进度 */
export async function getTaskProgress(taskId: string): Promise<TaskProgress> {
  const resp = await fetchWithAuth(`${BASE}/operations/${taskId}`);
  if (!resp.ok) throw new Error(`查询任务失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务执行日志 */
export async function getTaskLogs(taskId: string, limit = 500): Promise<TaskLogEntry[]> {
  const resp = await fetchWithAuth(`${BASE}/operations/${taskId}/logs?limit=${limit}`);
  if (!resp.ok) throw new Error(`查询任务日志失败: HTTP ${resp.status}`);
  const data = await resp.json();
  return data.logs || [];
}

/** Phase 4-D: 关闭 Playwright 窗口（不删除配置） */
export async function closePlaywrightWindow(siteId: string, staffName: string): Promise<{ success: boolean; alreadyClosed?: boolean; status?: string }> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/playwright-windows/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffName }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 获取历史任务列表（支持搜索、筛选、分页） */
export async function getTaskList(
  limit = 20,
  search?: string,
  type?: string,
  status?: string,
  page = 1,
): Promise<TaskListResponse> {
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  const resp = await fetchWithAuth(`${BASE}/operations?${params}`);
  if (!resp.ok) throw new Error(`获取任务列表失败: HTTP ${resp.status}`);
  return resp.json();
}

// ── 统计接口类型 ──
export interface TaskStatsResponse {
  tasks: {
    total: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
    pending: number;
  };
  system: {
    onlineWindows: number;
    activeWorkers: number;
    runningTasks: number;
  };
  warning?: string;
  /** 交付前加固：PG 不可用时为 true，统计为降级数据 */
  degraded?: boolean;
  /** 统计数据来源：pg（PostgreSQL）/ fallback（本地 SQLite）/ empty（空统计） */
  source?: 'pg' | 'fallback' | 'empty';
}

/** 获取服务端聚合统计 + 系统状态 */
export async function getTaskStats(): Promise<TaskStatsResponse> {
  const resp = await fetchWithAuth(`${BASE}/operations/stats`);
  if (!resp.ok) throw new Error(`获取统计失败: HTTP ${resp.status}`);
  return resp.json();
}

/**
 * 通用任务提交（UnifiedTaskPage 使用）
 */
export async function submitTask(
  api: string,
  payload: Record<string, unknown>,
): Promise<TaskSubmitResponse> {
  const t0 = performance.now();
  console.log(`[TaskStartTiming] T1 POST ${api} 发出`);
  const resp = await fetchWithAuth(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  const taskId = data.taskId || data.id;
  if (!taskId) {
    throw new Error('任务创建成功但后端未返回 taskId');
  }
  console.log(`[TaskStartTiming] T2 返回 taskId=${taskId} submitMs=${Math.round(performance.now() - t0)}`);
  return { ...data, taskId };
}

/** 提交派件扫描任务（多员工并发） */
export async function submitDispatchTask(
  site: string,
  assignments: { staffName: string; siteId?: string; windowId?: string; browserId?: string | null; runtimeKey?: string; waybillNos: string[] }[],
): Promise<TaskSubmitResponse> {
  const resp = await fetchWithAuth(`${BASE}/operations/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site, assignments }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 提交到派一体扫描任务 */
export async function submitIntegratedTask(
  site: string,
  assignments: { staffName: string; siteId?: string; windowId?: string; browserId?: string | null; runtimeKey?: string; waybillNos: string[] }[],
): Promise<TaskSubmitResponse> {
  const resp = await fetchWithAuth(`${BASE}/operations/integrated`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site, assignments }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * 提交签收录入任务（Phase 9-dryrun: 是否真实签收由后端 dryRunMode 控制）
 */
export async function submitSignTask(
  site: string,
  assignments: { staffName: string; siteId?: string; windowId?: string; browserId?: string | null; runtimeKey?: string; waybillNos: string[] }[],
): Promise<TaskSubmitResponse> {
  const resp = await fetchWithAuth(`${BASE}/operations/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site, assignments }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── 系统设置 API ──

/** 获取系统设置配置（网点 + 窗口凭据） */
export async function getSettingsConfig(): Promise<SettingsConfigResponse> {
  const resp = await fetchWithAuth(`${BASE}/settings/config`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 验证管理员 PIN 码 */
export async function verifyPin(pin: string): Promise<{ ok: boolean }> {
  const resp = await fetchWithAuth(`${BASE}/settings/verify-pin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 更新系统设置配置 */
export async function updateSettingsConfig(sites: SiteConfig[]): Promise<{ ok: boolean }> {
  const resp = await fetchWithAuth(`${BASE}/settings/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sites }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── 任务详情 API（基于 PgDatabase） ──

/** 查询任务执行日志（从 PG task_logs 表，Phase 5-G-2: 默认 limit 500） */
export async function getTaskLogsById(
  taskId: string,
  limit = 500,
  offset = 0,
): Promise<TaskLogsResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}/logs?${params}`);
  if (!resp.ok) throw new Error(`查询任务日志失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务最新状态（从 PG，供前端实时轮询） */
export async function getTaskStatus(taskId: string): Promise<{
  taskId: string;
  status: TaskStatus;
  type: string;
  totalCount: number;
  doneCount: number;
  failCount: number;
}> {
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}/status`);
  if (!resp.ok) throw new Error(`查询任务状态失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务完整详情（含 inputData、assignments） */
export interface TaskDetailResponse {
  taskId: string;
  type: string;
  site: string;
  siteName: string;
  status: string;
  totalCount: number;
  doneCount: number;
  failCount: number;
  createdAt: string;
  finishedAt: string | null;
  updatedAt: string;
  inputData: Record<string, unknown> | null;
  assignments: Array<{ staffName: string; count?: number }>;
}

export async function getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}`);
  if (!resp.ok) throw new Error(`查询任务详情失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务运单明细（从 PG waybill_results 表，支持 status + staffName 过滤） */
export async function getTaskWaybills(
  taskId: string,
  status?: string,
  staffName?: string,
): Promise<TaskWaybillsResponse> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (staffName) params.set('staffName', staffName);
  const qs = params.toString();
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}/waybills${qs ? `?${qs}` : ''}`);
  if (!resp.ok) throw new Error(`查询运单明细失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务摘要（任务信息 + 运单统计） */
export async function getTaskSummary(taskId: string): Promise<TaskSummaryResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}/summary`);
  if (!resp.ok) throw new Error(`查询任务摘要失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 查询任务执行人员统计 */
export async function getTaskStaffSummary(taskId: string): Promise<TaskStaffResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/${encodeURIComponent(taskId)}/staff`);
  if (!resp.ok) throw new Error(`查询员工统计失败: HTTP ${resp.status}`);
  return resp.json();
}

/** 清理 30 天前已结束的历史任务 */
export interface CleanupResponse {
  deletedTasks: number;
  deletedWaybills: number;
  deletedLogs: number;
}

export async function cleanupTasks(days?: number): Promise<CleanupResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days: days ?? 30 }),
  });
  if (!resp.ok) throw new Error(`清理任务失败: HTTP ${resp.status}`);
  return resp.json();
}

/** GET /api/settings/data-retention — 获取数据保留配置 */
export interface DataRetentionConfig {
  retentionDays: number;
  cleanupFrequency: 'weekly' | 'monthly' | 'off';
}

export async function getDataRetentionConfig(): Promise<DataRetentionConfig> {
  const resp = await fetchWithAuth(`${BASE}/settings/data-retention`);
  if (!resp.ok) throw new Error(`获取数据保留配置失败: HTTP ${resp.status}`);
  return resp.json();
}

/** PUT /api/settings/data-retention — 更新数据保留配置 */
export async function updateDataRetentionConfig(config: DataRetentionConfig): Promise<{ success: boolean }> {
  const resp = await fetchWithAuth(`${BASE}/settings/data-retention`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!resp.ok) throw new Error(`更新数据保留配置失败: HTTP ${resp.status}`);
  return resp.json();
}

/** POST /api/tasks/delete-stats — 统计选中任务关联数据量 */
export interface DeleteStatsResponse {
  taskCount: number;
  waybillCount: number;
  logCount: number;
  typeBreakdown: Record<string, number>;
}

export async function getTaskDeleteStats(taskIds: string[]): Promise<DeleteStatsResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/delete-stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!resp.ok) throw new Error(`获取删除统计失败: HTTP ${resp.status}`);
  return resp.json();
}

/** POST /api/tasks/batch-delete — 批量删除任务 */
export interface BatchDeleteResponse {
  success: number;
  skipped: number;
  deletedWaybills: number;
  deletedLogs: number;
}

export async function batchDeleteTasks(taskIds: string[]): Promise<BatchDeleteResponse> {
  const resp = await fetchWithAuth(`${BASE}/tasks/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskIds }),
  });
  if (!resp.ok) throw new Error(`删除任务失败: HTTP ${resp.status}`);
  return resp.json();
}

// ── Phase K-3A-2-Prep: 任务重置 API ──

export interface ResetTasksResponse {
  ok: boolean;
  deleted: {
    tasks: number;
    task_logs: number;
    waybill_results: number;
  };
  message: string;
}

export async function resetAllTasks(): Promise<ResetTasksResponse> {
  const resp = await fetchWithAuth(`${BASE}/admin/tasks/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET_TASKS', scope: 'all' }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error((body as any).message || `清理任务失败: HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── 窗口初始化 API ──

/** POST /api/windows/init — 提交窗口初始化任务 */
export interface InitWindowResponse {
  taskId: string;
  status: string;
  windowId: string;
}

export async function initWindow(siteId: string, windowId: string): Promise<InitWindowResponse> {
  const resp = await fetchWithAuth(`${BASE}/windows/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: siteId, window_id: windowId }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** GET /api/windows/status — 所有窗口状态及最新 init_task */
export interface WindowStatusItem {
  id: string;
  name: string;
  role: string;
  site: string;
  staffName: string | null;
  isConnected: boolean;
  updatedAt: string;
  latestInitTask: {
    taskId: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
  } | null;
}

export interface WindowsStatusResponse {
  windows: WindowStatusItem[];
  bySite: Record<string, WindowStatusItem[]>;
  totals: { total: number; connected: number };
}

export async function getWindowsStatus(): Promise<WindowsStatusResponse> {
  const resp = await fetchWithAuth(`${BASE}/windows/status`);
  if (!resp.ok) throw new Error(`查询窗口状态失败: HTTP ${resp.status}`);
  return resp.json();
}

// ── 站点窗口 4 态 API ──

/** 窗口状态 (M5-2: 含 Agent 分段状态) */
export type WindowState = 'offline' | 'connecting' | 'login_required' | 'connected' | 'ready' | 'busy' | 'degraded' | 'failed' | 'error'
  | 'opening' | 'process_started' | 'cdp_connecting' | 'cdp_connected'
  | 'login_checking' | 'p0_checking' | 'popup_cleaning'
  | 'ready_checking' | 'closing' | 'closed';

/** 单个站点窗口状态 */
export interface SiteWindowState {
  windowName: string;
  employeeName: string;
  browserId: string | null;
  status: WindowState;
}

/** GET /api/sites/:siteId/windows 响应 */
export interface SiteWindowsResponse {
  siteId: string;
  siteName: string;
  windows: SiteWindowState[];
}

export async function getSiteWindows(siteId: string): Promise<SiteWindowsResponse> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/windows`);
  if (!resp.ok) throw new Error(`查询站点窗口失败: HTTP ${resp.status}`);
  return resp.json();
}

/** POST /api/sites/:siteId/windows/launch-all 响应 */
export interface LaunchAllResponse {
  launched: number;
  failed: number;
  partial: number;
  total: number;
  timeout: boolean;
  success: boolean;
  message: string;
  windows: { windowName: string; staffName: string; browserId: string; status: string; ready: boolean; message?: string }[];
}

export async function launchAllWindows(siteId: string): Promise<LaunchAllResponse> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/windows/launch-all`, {
    method: 'POST',
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 4-B: Window Runtime Mode API（playwright 模式专用） ──

/** 窗口运行模式（与 backend/config/runtimeMode.ts 对齐） */
export type WindowRuntimeMode = 'legacy_easybr' | 'playwright';

/** GET /api/runtime-mode 响应 */
export interface WindowRuntimeModeResponse {
  runtimeMode: WindowRuntimeMode;
}

// ── M5-0: Version API ──

/** GET /api/version 响应 */
export interface VersionResponse {
  service: string;
  gitCommit: string;
  buildId: string;
  startedAt: string;
  runtimeMode: string;
  agent: {
    agentVersion?: string;
    gitCommit?: string;
    buildId?: string;
    startedAt?: string;
    chromePath?: string;
    chromeKind?: string;
    lastHeartbeatAt?: string;
    status?: string;
    workstationId?: string;
  } | { status: string };
}

/** GET /api/version — 获取后端和 Agent 版本信息 */
export async function getVersion(): Promise<VersionResponse> {
  const resp = await fetchWithAuth(`${BASE}/version`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** playwright 模式下的单个窗口状态（含 runtimeKey/runtimeMode 标记） */
export interface PlaywrightSiteWindowState extends SiteWindowState {
  /** 标记为 playwright 模式窗口（前端据此区分点击行为） */
  runtimeMode?: 'playwright';
  /** Playwright runtimeKey = tenantId:siteId:windowId */
  runtimeKey?: string;
  // ── Phase 4-B READY 守卫诊断字段 ──
  /** 当前页面 URL */
  currentUrl?: string;
  /** 当前标签页数量（应为 1） */
  pageCount?: number;
  /** 当前激活页 URL */
  activePageUrl?: string;
  /** P0 检查是否通过（ready 状态必须为 true） */
  p0Passed?: boolean;
  /** P0 失败的检查项名 */
  p0FailedCheck?: string | null;
  /** P0 失败原因 */
  p0FailedReason?: string | null;
  // ── M5-2: Agent 状态上报扩展字段 ──
  /** 状态中文文本（来自 Agent SSE 推送） */
  statusText?: string;
  /** 是否在登录页 */
  isLoginPage?: boolean;
  /** 浏览器进程是否存活 */
  isProcessAlive?: boolean;
  /** 最后错误信息 */
  lastError?: string | null;
  /** 最后命令 ID */
  commandId?: string;
}

/** GET /api/sites/:siteId/playwright-windows 响应 */
export interface PlaywrightSiteWindowsResponse {
  siteId: string;
  siteName: string;
  windows: PlaywrightSiteWindowState[];
  /** playwright 模式标识 */
  runtimeMode: 'playwright';
}

/** 获取当前窗口运行模式（只读，不触发启动） */
export async function getWindowRuntimeMode(): Promise<WindowRuntimeModeResponse> {
  const resp = await fetchWithAuth(`${BASE}/runtime-mode`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 查询站点 Playwright 窗口状态（仅查询缓存，不触发启动） */
export async function getSitePlaywrightWindows(siteId: string): Promise<PlaywrightSiteWindowsResponse> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/playwright-windows`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** POST /api/sites/:siteId/playwright-windows/launch-all 响应 */
export interface PlaywrightLaunchAllResponse {
  launched: number;
  failed: number;
  partial: number;
  total: number;
  timeout: boolean;
  success: boolean;
  message: string;
  windows: { windowName: string; staffName: string; runtimeKey: string; status: string; ready: boolean; message?: string }[];
  runtimeMode: 'playwright';
}

/** 一键启动该网点所有 offline 的 Playwright 窗口 */
export async function launchAllPlaywrightWindows(siteId: string): Promise<PlaywrightLaunchAllResponse> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/playwright-windows/launch-all`, {
    method: 'POST',
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** POST /api/sites/:siteId/playwright-windows/ensure 响应 */
export interface PlaywrightEnsureResponse {
  success: boolean;
  runtimeKey: string;
  status: string;
  ready: boolean;
  launched: boolean;
  currentUrl?: string;
  isLoggedIn?: boolean;
  message?: string;
  runtimeMode: 'playwright';
  // ── Phase 4-B READY 守卫诊断字段 ──
  pageCount?: number;
  activePageUrl?: string;
  p0Passed?: boolean;
  p0FailedCheck?: string | null;
  p0FailedReason?: string | null;
}

/** 启动单个员工的 Playwright Chrome 窗口（headed=true, keepOpen=true） */
export async function ensurePlaywrightWindow(siteId: string, staffName: string): Promise<PlaywrightEnsureResponse> {
  const resp = await fetchWithAuth(`${BASE}/sites/${siteId}/playwright-windows/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staffName }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── 运行模式 API（Phase 9-dryrun） ──

/** 运行模式类型 */
export type RuntimeMode = 'dry-run' | 'real';

/** GET /api/runtime/mode 响应 */
export interface RuntimeModeResponse {
  dryRunMode: boolean;
  mode: RuntimeMode;
}

/** POST /api/runtime/mode 响应 */
export interface RuntimeModeUpdateResponse {
  success: boolean;
  dryRunMode: boolean;
  mode: RuntimeMode;
}

/** 获取当前运行模式 */
export async function getRuntimeMode(): Promise<RuntimeModeResponse> {
  const resp = await fetchWithAuth(`${BASE}/runtime/mode`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** 修改运行模式 */
export async function updateRuntimeMode(dryRunMode: boolean): Promise<RuntimeModeUpdateResponse> {
  const resp = await fetchWithAuth(`${BASE}/runtime/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRunMode }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Deploy-0C: Cloud 窗口状态查询 ──

/** Cloud 窗口状态（来自 Agent 上报的持久化数据） */
export interface CloudWindowStatus {
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  status: string;
  statusText: string;
  currentUrl?: string;
  isProcessAlive: boolean;
  isCdpReady: boolean;
  isDashboardReady: boolean;
  isLoginPage: boolean;
  /** M5-2: last command ID */
  commandId?: string;
  lastHeartbeatAt: string;
  updatedAt: string;
  stale: boolean;
  lastError?: string | null;
}

/** GET /api/cloud/windows/status — 查询 Agent 上报的持久化窗口状态 */
export async function getCloudWindowStatus(siteId: string): Promise<{ windows: CloudWindowStatus[] }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/windows/status?siteId=${encodeURIComponent(siteId)}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Deploy-0D: Window Command API ──

/** 窗口命令类型 */
export type WindowCommandType = 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';

/** 创建窗口命令参数 */
export interface CreateWindowCommandParams {
  siteId: string;
  windowId: string;
  staffName: string;
  type: WindowCommandType;
  workstationId?: string;
}

/** 创建窗口命令响应 */
export interface CreateWindowCommandResponse {
  commandId: string;
  status: string;
  message: string;
  /** S2: Agent 是否在线（用于前端立即提示） */
  agentOnline?: boolean;
}

/** 查询命令状态响应 */
export interface GetWindowCommandResponse {
  id: string;
  status: string;
  type: string;
  windowId: string;
  staffName: string;
  result?: Record<string, unknown>;
  error?: string;
  updatedAt: string;
}

/** 批量创建响应 */
export interface CreateWindowCommandBatchResponse {
  created: number;
  commands: Array<{ commandId: string; windowId: string; staffName: string }>;
  agentOnlineCount?: number;
  wsPushedCount?: number;
  workstationCount?: number;
}

/**
 * POST /api/cloud/windows/commands — 创建窗口命令
 *
 * Deploy-0D: Header 启动/关闭窗口不再直接调用 PlaywrightRuntime，
 * 而是创建一条 window_command 由 Agent 拉取并执行。
 */
export async function createWindowCommand(params: CreateWindowCommandParams): Promise<CreateWindowCommandResponse> {
  const resp = await fetchWithAuth(`${BASE}/cloud/windows/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * POST /api/cloud/windows/commands/batch — 批量创建窗口命令
 *
 * 用于一键启动：为当前站点所有员工批量创建 open_window command。
 */
export async function createWindowCommandBatch(
  commands: CreateWindowCommandParams[],
): Promise<CreateWindowCommandBatchResponse> {
  const resp = await fetchWithAuth(`${BASE}/cloud/windows/commands/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/**
 * GET /api/cloud/windows/commands/:commandId — 查询命令状态
 *
 * Header 用于轮询命令执行状态。
 */
export async function getWindowCommand(commandId: string): Promise<GetWindowCommandResponse> {
  const resp = await fetchWithAuth(`${BASE}/cloud/windows/commands/${commandId}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 3-F: Cloud 组织信息 API ──

/** 租户信息 */
export interface TenantInfo {
  id: string;
  name: string;
  status: string;
  maxWorkstations: number;
  expiresAt: string | null;
  createdAt: string;
}

/** 站点信息 */
export interface SiteInfo {
  id: string;
  name: string;
  code: string | null;
  enabled: boolean;
  createdAt: string;
}

/** 工作站信息 */
export interface WorkstationInfo {
  id: string;
  name: string;
  siteId: string | null;
  status: string;
  onlineStatus: string;
  browserStatus: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

/** GET /api/cloud/tenant — 获取当前租户信息 */
export async function getCurrentTenant(): Promise<TenantInfo> {
  const resp = await fetchWithAuth(`${BASE}/cloud/tenant`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** GET /api/cloud/sites — 获取当前租户下站点列表 */
export async function getTenantSites(): Promise<{ tenantId: string; sites: SiteInfo[] }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/sites`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

/** GET /api/cloud/workstations — 获取当前租户下工作站列表 */
export async function getTenantWorkstations(): Promise<{ tenantId: string; workstations: WorkstationInfo[] }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/workstations`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 3-G: Cloud 用户信息 API ──

/** 用户信息 */
export interface UserInfo {
  id: string;
  tenantId: string;
  username: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/cloud/users — 获取当前租户下用户列表 */
export async function getTenantUsers(): Promise<{ tenantId: string; users: UserInfo[] }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/users`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 5-E: Agent arrival 浏览器 DRY-RUN 任务创建 ──

export interface CreateArrivalDryRunParams {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: { prevStation?: string; batchSize?: number };
  dryRunMode?: boolean;   // Phase M-3B: 主字段（兼容 browserDryRun）
  browserDryRun?: boolean; // Phase M-3B: 兼容旧字段
}

/** POST /api/cloud/agent-arrival-task — 创建到件扫描浏览器 DRY-RUN 任务 */
export async function createArrivalDryRunTask(params: CreateArrivalDryRunParams): Promise<{ taskId: string; message: string }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/agent-arrival-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 5-E: Agent dispatch 派件浏览器 DRY-RUN 任务创建 ──

export interface CreateAgentDispatchParams {
  siteId: string;
  siteName: string;
  courierName?: string;
  waybills: string[];
  options?: { prevStation?: string; batchSize?: number };
  dryRunMode?: boolean;   // Phase M-3B: 主字段
  browserDryRun?: boolean; // Phase M-3B: 兼容旧字段
}

/** POST /api/cloud/agent-dispatch-task — 创建派件扫描浏览器 DRY-RUN 任务 */
export async function createAgentDispatchTask(params: CreateAgentDispatchParams): Promise<{ taskId: string; message: string }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/agent-dispatch-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 5-E: Agent integrated 到派一体浏览器 DRY-RUN 任务创建 ──

export interface CreateAgentIntegratedParams {
  siteId: string;
  siteName: string;
  courierName?: string;
  waybills: string[];
  options?: { prevStation?: string; batchSize?: number };
  dryRunMode?: boolean;   // Phase M-3B: 主字段
  browserDryRun?: boolean; // Phase M-3B: 兼容旧字段
}

/** POST /api/cloud/agent-integrated-task — 创建到派一体浏览器 DRY-RUN 任务 */
export async function createAgentIntegratedTask(params: CreateAgentIntegratedParams): Promise<{ taskId: string; message: string }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/agent-integrated-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Phase 5-E: Agent sign 签收浏览器 DRY-RUN 任务创建 ──

export interface CreateAgentSignParams {
  siteId: string;
  siteName: string;
  courierName?: string;
  waybills: string[];
  options?: { prevStation?: string; batchSize?: number };
  dryRunMode?: boolean;   // Phase M-3B: 主字段
  browserDryRun?: boolean; // Phase M-3B: 兼容旧字段
}

/** POST /api/cloud/agent-sign-task — 创建签收录入浏览器 DRY-RUN 任务 */
export async function createAgentSignTask(params: CreateAgentSignParams): Promise<{ taskId: string; message: string }> {
  const resp = await fetchWithAuth(`${BASE}/cloud/agent-sign-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: '请求失败' }));
    throw new Error(err.error || err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}
