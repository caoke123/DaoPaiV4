/**
 * HTTP Client
 *
 * 封装对 Cloud /agent/* 接口的 HTTP 请求。
 */

import axios, { type AxiosInstance } from 'axios';
import type { AgentConfig, HeartbeatRequest, HeartbeatResponse, AgentMeResponse } from './types';
import { logTrace, warnTrace } from './trace';

/** 任务拉取响应 */
export interface PullTaskResponse {
  hasTask: boolean;
  task: {
    taskId: string;
    type: string;
    siteId: string;
    siteName: string;
    status: string;
    payload: Record<string, unknown>;
    createdAt: string;
  } | null;
  nextPollAfterMs: number;
}

/** 创建带鉴权的 HTTP 客户端 */
export function createHttpClient(config: AgentConfig): AxiosInstance {
  const client = axios.create({
    baseURL: config.cloudBaseUrl,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.agentToken}`,
    },
  });

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response) {
        const { status, data } = err.response;
        if (status === 401) {
          console.error('执行电脑授权码无效，请检查 agent.json 中的 agentToken');
        } else if (status === 403) {
          console.error('执行电脑已停用或已删除，请联系管理员');
        }
        return Promise.reject(new Error(
          data?.message || `请求失败 (${status})`
        ));
      }
      return Promise.reject(new Error(`无法连接 Cloud：${err.message}`));
    }
  );

  return client;
}

/** GET /agent/me */
export async function getAgentMe(client: AxiosInstance): Promise<AgentMeResponse> {
  const res = await client.get('/agent/me');
  return res.data.data;
}

/** POST /agent/heartbeat */
export async function sendHeartbeat(
  client: AxiosInstance,
  payload: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  const res = await client.post('/agent/heartbeat', payload);
  return res.data.data;
}

/**
 * POST /agent/tasks/pull — 拉取待执行任务
 */
export async function pullTask(client: AxiosInstance): Promise<PullTaskResponse> {
  const t0 = Date.now();
  const res = await client.post('/agent/tasks/pull', {});
  logTrace('agent-http', 'pull_task_response', {
    durationMs: Date.now() - t0,
    hasTask: !!res.data?.data?.hasTask,
    taskId: res.data?.data?.task?.taskId as string | undefined,
    taskType: res.data?.data?.task?.type as string | undefined,
  });
  return res.data.data;
}

/**
 * POST /agent/tasks/:id/run-engine — 让后端 AssignmentEngine 驱动业务页员工窗口执行
 */
export async function runTaskWithBackendEngine(
  client: AxiosInstance,
  taskId: string,
): Promise<void> {
  await client.post(`/agent/tasks/${taskId}/run-engine`, {}, {
    timeout: 35 * 60 * 1000,
  });
}

/**
 * POST /agent/tasks/:id/progress — 上报任务进度
 */
export async function reportProgress(
  client: AxiosInstance,
  taskId: string,
  status: string,
  progress: number,
  currentAction?: string,
): Promise<void> {
  await client.post(`/agent/tasks/${taskId}/progress`, {
    status,
    progress,
    currentAction: currentAction || '',
  });
}

/**
 * POST /agent/tasks/:id/logs — 批量上报日志
 */
export async function uploadLogs(
  client: AxiosInstance,
  taskId: string,
  logs: Array<{ level: string; message: string; timestamp: string; staffName?: string; windowId?: string; siteId?: string }>,
): Promise<void> {
  logTrace('agent-http', 'upload_logs_start', {
    taskId,
    logCount: logs.length,
    firstMessage: typeof logs[0]?.message === 'string' ? logs[0].message.slice(0, 120) : null,
  });
  await client.post(`/agent/tasks/${taskId}/logs`, { logs });
  logTrace('agent-http', 'upload_logs_done', {
    taskId,
    logCount: logs.length,
  });
}

/**
 * POST /agent/tasks/:id/complete — 任务完成
 */
export async function completeTask(
  client: AxiosInstance,
  taskId: string,
  summary?: Record<string, unknown>,
  results?: Array<Record<string, unknown>>,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (summary) body.summary = summary;
  if (results) body.results = results;
  await client.post(`/agent/tasks/${taskId}/complete`, body);
}

/**
 * POST /agent/tasks/:id/fail — 任务失败
 */
export async function failTask(
  client: AxiosInstance,
  taskId: string,
  errorMessage: string,
): Promise<void> {
  await client.post(`/agent/tasks/${taskId}/fail`, {
    error: { code: 'UNKNOWN_ERROR', message: errorMessage },
  });
}

// ── Phase K-3A-2: READY 窗口连接查询 ──

export interface WindowConnection {
  runtimeKey: string;
  windowId: string;
  staffName: string | null;
  windowName: string | null;
  tenantId: string;
  siteId: string;
  status: string;
  currentUrl: string | null;
  isLoggedIn: boolean | null;
  cdpPort: number | null;
  cdpEndpoint: string | null;
  cdpAttachable: boolean;
}

export interface WindowConnectionsResponse {
  windows: WindowConnection[];
  total: number;
}

/**
 * GET /agent/window-connections — 查询当前 tenant 下所有 Playwright 窗口的连接信息
 *
 * 用途：Agent pull 到 arrival task 后，先调此接口查找匹配 staffName 的 READY 窗口，
 *       若窗口 cdpAttachable=true 且 status=ready，则使用 connectOverCDP 接管已有 Chrome。
 */
export async function queryWindowConnections(
  client: AxiosInstance,
  filters?: { staffName?: string; status?: string; siteId?: string },
): Promise<WindowConnectionsResponse> {
  const params: Record<string, string> = {};
  if (filters?.staffName) params.staffName = filters.staffName;
  if (filters?.status) params.status = filters.status;
  if (filters?.siteId) params.siteId = filters.siteId;
  const res = await client.get('/agent/window-connections', { params, timeout: 10_000 });
  return res.data.data;
}

// ══════════════════════════════════════════════════════════
// Phase Deploy-0C: Agent 窗口状态上报
// ══════════════════════════════════════════════════════════

/**
 * POST /agent/windows/status — Agent 上报本机窗口状态
 *
 * 将窗口状态数组上报到 Cloud，upsert 到 PostgreSQL。
 * 失败时只打印 warn，不影响任务执行。
 */
export async function reportWindowStatus(
  client: AxiosInstance,
  siteWindows: Array<{
    siteId: string;
    windowId: string;
    staffName: string;
    status: string;
    statusText: string;
    currentUrl?: string;
    isProcessAlive: boolean;
    isCdpReady: boolean;
    isDashboardReady: boolean;
    isLoginPage: boolean;
    lastError?: string | null;
    cdpEndpoint?: string | null;
    profilePath?: string | null;
    chromePid?: number | null;
  }>,
): Promise<void> {
  // S2-优化: 增加一次重试，应对 ECONNRESET
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.post('/agent/windows/status', { siteWindows }, { timeout: 10_000 });
      logTrace('agent-http', 'report_window_status_done', {
        windowCount: siteWindows.length,
        attempt: attempt + 1,
      });
      return;
    } catch (err) {
      if (attempt === 0) {
        // 首次失败 → 500ms 后重试
        warnTrace('agent-http', 'report_window_status_retry', {
          windowCount: siteWindows.length,
          error: (err as Error).message,
        });
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.warn('[Agent] 窗口状态上报失败（非致命）:', (err as Error).message);
        warnTrace('agent-http', 'report_window_status_failed', {
          windowCount: siteWindows.length,
          error: (err as Error).message,
        });
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// Phase Deploy-0D: Window Command API
// ══════════════════════════════════════════════════════════

/** Cloud 下发的窗口命令 */
export interface WindowCommand {
  commandId: string;
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  type: 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';
  params: Record<string, unknown>;
}

/** POST /agent/windows/commands/pull — Agent 拉取待执行的窗口命令 */
export async function pullWindowCommands(
  client: AxiosInstance,
  limit: number = 10,
): Promise<WindowCommand[]> {
  try {
    const t0 = Date.now();
    const res = await client.post('/agent/windows/commands/pull', { limit }, { timeout: 10_000 });
    logTrace('agent-http', 'pull_window_commands_done', {
      limit,
      durationMs: Date.now() - t0,
      commandCount: (res.data?.data?.commands || []).length,
    });
    return (res.data?.data?.commands || []) as WindowCommand[];
  } catch (err) {
    console.warn('[Agent] 拉取窗口命令失败（非致命）:', (err as Error).message);
    warnTrace('agent-http', 'pull_window_commands_failed', {
      limit,
      error: (err as Error).message,
    });
    return [];
  }
}

/** POST /agent/windows/commands/:commandId/complete — 上报命令完成 */
export async function markWindowCommandRunning(
  client: AxiosInstance,
  commandId: string,
): Promise<void> {
  await client.post(`/agent/windows/commands/${commandId}/running`, {}, { timeout: 10_000 });
}

/** POST /agent/windows/commands/:commandId/complete — 上报命令完成 */
export async function completeWindowCommand(
  client: AxiosInstance,
  commandId: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await client.post(`/agent/windows/commands/${commandId}/complete`, { result }, { timeout: 10_000 });
}

/** POST /agent/windows/commands/:commandId/fail — 上报命令失败 */
export async function failWindowCommand(
  client: AxiosInstance,
  commandId: string,
  error: string,
): Promise<void> {
  await client.post(`/agent/windows/commands/${commandId}/fail`, { error }, { timeout: 10_000 });
}
