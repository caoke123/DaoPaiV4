/**
 * HTTP Client
 *
 * 封装对 Cloud /agent/* 接口的 HTTP 请求。
 */

import axios, { type AxiosInstance } from 'axios';
import type { AgentConfig, HeartbeatRequest, HeartbeatResponse, AgentMeResponse } from './types';

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
  const res = await client.post('/agent/tasks/pull', {});
  return res.data.data;
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
  logs: Array<{ level: string; message: string; timestamp: string; staffName?: string }>,
): Promise<void> {
  await client.post(`/agent/tasks/${taskId}/logs`, { logs });
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
