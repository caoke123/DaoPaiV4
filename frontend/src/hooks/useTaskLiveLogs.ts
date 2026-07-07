/**
 * useTaskLiveLogs — 统一实时日志 Hook
 * Phase 5-G-2: 统一 SSE 订阅 + PG 轮询兜底 + 日志合并去重 + 排序 + 状态管理
 * Phase 5-G-7-2: 页面切换不丢日志，从日志 staffName 自动分组
 *
 * 职责：
 *   1. 订阅 SSE：/api/operations/:taskId/events（实时推送 TASK_LOG）
 *   2. PG 轮询兜底：GET /api/tasks/:id/logs（1.5s 一次）
 *   3. 日志合并去重（优先 id，降级用 taskId+timestamp+level+message+staffName）
 *   4. 按 timestamp ASC 统一排序
 *   5. status 进入 done/failed/cancelled 后 final fetch 再停止轮询
 *   6. 日志自动按 staffName 分组，workers 延迟到达也不丢日志
 *   7. 同一 taskId 页面切换不重置日志（保留 final fetch 结果）
 *
 * 返回：allLogs / logsByWorker / globalLogs / status / isRunning
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getTaskLogs, getTaskLogsById, getTaskStatus, type TaskLogEntry, type TaskStatus } from '../api/client';

interface SseTaskLogEvent {
  type: 'TASK_LOG';
  taskId: string;
  payload: TaskLogEntry;
}

interface SseTaskFinishedEvent {
  type: 'TASK_FINISHED';
  taskId: string;
  status: 'done' | 'failed';
  successCount: number;
  failedCount: number;
  finishedAt: number;
}

type SseEvent = SseTaskLogEvent | SseTaskFinishedEvent;

function makeLogKey(log: TaskLogEntry): string {
  if (log.id) return `id:${log.id}`;
  return `k:${log.timestamp}|${log.level}|${log.message}|${log.staffName || ''}`;
}

export interface UseTaskLiveLogsOptions {
  taskId: string | null;
  enabled?: boolean;
  workers?: string[];
  pollIntervalMs?: number;
}

export interface UseTaskLiveLogsResult {
  allLogs: TaskLogEntry[];
  logsByWorker: Record<string, TaskLogEntry[]>;
  globalLogs: TaskLogEntry[];
  status: TaskStatus | 'idle';
  isRunning: boolean;
}

export function useTaskLiveLogs(options: UseTaskLiveLogsOptions): UseTaskLiveLogsResult {
  const { taskId, enabled = true, workers = [], pollIntervalMs = 1500 } = options;

  const [status, setStatus] = useState<TaskStatus | 'idle'>('idle');
  const [logsMap, setLogsMap] = useState<Map<string, TaskLogEntry>>(new Map());
  const logsMapRef = useRef<Map<string, TaskLogEntry>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const workersRef = useRef<string[]>(workers);
  // Phase 5-G-5: 跟踪进度变化，用于触发立即补拉日志
  const lastProgressRef = useRef<{ doneCount: number; failCount: number; status: string }>({
    doneCount: 0, failCount: 0, status: 'idle',
  });
  // Phase 5-G-7-2: 跟踪 taskId 变化，同一 taskId 不清空日志
  const prevTaskIdRef = useRef<string | null>(null);

  workersRef.current = workers;

  const upsertLogs = useCallback((incoming: TaskLogEntry[]) => {
    if (incoming.length === 0) return;
    setLogsMap(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const log of incoming) {
        const key = makeLogKey(log);
        if (!next.has(key)) {
          next.set(key, log);
          changed = true;
        }
      }
      if (changed) {
        logsMapRef.current = next;
        return next;
      }
      return prev;
    });
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (statusTimerRef.current) {
      clearInterval(statusTimerRef.current);
      statusTimerRef.current = null;
    }
  }, []);

  const doFinalFetch = useCallback(async (tid: string) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 1200));
      const data = await getTaskLogsById(tid, 500);
      if (data.logs.length > 0) {
        upsertLogs(data.logs);
      } else {
        const legacyLogs = await getTaskLogs(tid, 500).catch(() => []);
        upsertLogs(legacyLogs);
      }
    } catch {
      const legacyLogs = await getTaskLogs(tid, 500).catch(() => []);
      upsertLogs(legacyLogs);
    }
  }, [upsertLogs]);

  const handleFinished = useCallback((tid: string, finalStatus: TaskStatus) => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    stopPolling();
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStatus(finalStatus);
    finalFetchTimerRef.current = setTimeout(() => {
      doFinalFetch(tid);
    }, 500);
  }, [stopPolling, doFinalFetch]);

  useEffect(() => {
    if (!taskId || !enabled) {
      stoppedRef.current = true;
      stopPolling();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (finalFetchTimerRef.current) {
        clearTimeout(finalFetchTimerRef.current);
        finalFetchTimerRef.current = null;
      }
      // Phase 5-G-7-2: 仅当 taskId 从有变无（真正清空）时才重置
      if (prevTaskIdRef.current !== null) {
        setStatus('idle');
        setLogsMap(new Map());
        logsMapRef.current = new Map();
      }
      prevTaskIdRef.current = null;
      return;
    }

    // Phase 5-G-7-2: 同一 taskId 不清空日志（支持页面切换恢复）
    const isSameTask = prevTaskIdRef.current === taskId;
    prevTaskIdRef.current = taskId;

    stoppedRef.current = false;

    if (!isSameTask) {
      setLogsMap(new Map());
      logsMapRef.current = new Map();
    }
    setStatus('pending');

    // 从 PG 拉取已有日志
    getTaskLogsById(taskId, 500).then(async data => {
      if (data.logs.length > 0) {
        upsertLogs(data.logs);
      } else {
        const legacyLogs = await getTaskLogs(taskId, 500).catch(() => []);
        upsertLogs(legacyLogs);
      }
    }).catch(async () => {
      const legacyLogs = await getTaskLogs(taskId, 500).catch(() => []);
      upsertLogs(legacyLogs);
    });

    // 获取任务状态
    getTaskStatus(taskId).then(s => {
      setStatus(s.status);
      if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') {
        handleFinished(taskId, s.status);
      }
    }).catch(() => {});

    const esUrl = `/api/operations/${taskId}/events`;
    const es = new EventSource(esUrl);
    eventSourceRef.current = es;

    es.addEventListener('TASK_LOG', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseEvent;
        if (data.type === 'TASK_LOG' && data.payload) {
          upsertLogs([data.payload]);
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener('TASK_FINISHED', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseEvent;
        if (data.type === 'TASK_FINISHED') {
          handleFinished(taskId, data.status === 'done' ? 'done' : 'failed');
        }
      } catch {
        // ignore
      }
    });

    es.addEventListener('end', () => {
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
    });

    es.onerror = () => {
      // SSE 错误不致命，PG 轮询兜底；不关闭连接让浏览器自动重连
    };

    pollTimerRef.current = setInterval(async () => {
      if (stoppedRef.current) return;
      try {
        const data = await getTaskLogsById(taskId, 500);
        if (data.logs.length > 0) {
          upsertLogs(data.logs);
        } else {
          const legacyLogs = await getTaskLogs(taskId, 500).catch(() => []);
          upsertLogs(legacyLogs);
        }
      } catch {
        const legacyLogs = await getTaskLogs(taskId, 500).catch(() => []);
        upsertLogs(legacyLogs);
      }
    }, pollIntervalMs);

    statusTimerRef.current = setInterval(async () => {
      if (stoppedRef.current) return;
      try {
        const s = await getTaskStatus(taskId);
        setStatus(s.status);

        // Phase 5-G-5: 进度/状态变化时立即补拉日志，减少日志滞后
        const prev = lastProgressRef.current;
        const progressChanged = s.doneCount !== prev.doneCount || s.failCount !== prev.failCount;
        const statusChanged = s.status !== prev.status;
        lastProgressRef.current = { doneCount: s.doneCount, failCount: s.failCount, status: s.status };

        if (progressChanged || statusChanged) {
          try {
            const data = await getTaskLogsById(taskId, 500);
            if (data.logs.length > 0) {
              upsertLogs(data.logs);
            }
          } catch {
            // ignore
          }
        }

        if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') {
          handleFinished(taskId, s.status);
        }
      } catch {
        // ignore
      }
    }, 2000);

    return () => {
      stoppedRef.current = true;
      stopPolling();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (finalFetchTimerRef.current) {
        clearTimeout(finalFetchTimerRef.current);
        finalFetchTimerRef.current = null;
      }
      // Phase 5-G-7-2: 不清空 prevTaskIdRef，让下一次挂载判断 isSameTask
    };
  }, [taskId, enabled, pollIntervalMs, upsertLogs, handleFinished, stopPolling]);

  const allLogs = useMemo(() => {
    const arr = Array.from(logsMap.values());
    arr.sort((a, b) => a.timestamp - b.timestamp);
    return arr;
  }, [logsMap]);

  // Phase 5-G-7-2: 从日志自动发现 staffName，workers prop 为空时也能分组
  const logsByWorker = useMemo(() => {
    const byWorker: Record<string, TaskLogEntry[]> = {};
    const currentWorkers = workersRef.current;

    // 先初始化已知 workers
    for (const name of currentWorkers) {
      byWorker[name] = [];
    }

    // 遍历所有日志，按 staffName 分组
    for (const log of allLogs) {
      const name = log.staffName;
      if (!name) continue;
      // workers 为空时自动创建分组
      if (!byWorker[name]) {
        byWorker[name] = [];
      }
      byWorker[name].push(log);
    }
    return byWorker;
  }, [allLogs]);

  const globalLogs = useMemo(() => {
    return allLogs.filter(log => !log.staffName);
  }, [allLogs]);

  const isRunning = status === 'pending' || status === 'assigned' || status === 'running';

  return {
    allLogs,
    logsByWorker,
    globalLogs,
    status,
    isRunning,
  };
}
