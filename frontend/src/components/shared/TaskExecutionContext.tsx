// TaskExecutionContext — 任务执行状态全局上下文
// TC-05B: 使用 SSE (Server-Sent Events) 替代轮询，实现日志实时推送 + 任务完成即时通知
//
// 数据流：
//   后端 taskLogManager.addLog() → EventBus.emit('TASK_LOG') → SSE 推送 → 前端 EventSource 接收 → 实时追加日志
//   后端 Engine 完成 → EventBus.emit('TASK_FINISHED') → SSE 推送 → 前端 100ms 内更新状态
//   后端 onProgress → EventBus.emit('TASK_PROGRESS') → SSE 推送 → 前端实时更新统计
//
// 兜底策略：SSE 断开时自动重连；低频轮询（5秒）作为备用获取 result 详情（异常运单数据）

import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { getTaskProgress, type WaybillResult, type TaskLogEntry as ApiTaskLogEntry } from '../../api/client';

// ── 类型 ──

export interface WorkerProgress {
  [employeeName: string]: { done: number; total: number; failed: number };
}

export interface WorkerLogs {
  [employeeName: string]: ApiTaskLogEntry[];
}

type LiveStatus = 'idle' | 'running' | 'completed' | 'error';

interface Allocations {
  [staffName: string]: number;
}

interface TaskExecutionContextValue {
  taskId: string | null;
  liveStatus: LiveStatus;
  submitting: boolean;
  totalCount: number;
  doneCount: number;
  successCount: number;
  failedCount: number;
  workerProgress: WorkerProgress;
  workerLogs: WorkerLogs;
  rate: number;
  eta: number | null;

  /** 当前任务的选中的员工列表（用于日志展示跨路由恢复） */
  selectedWorkers: string[];
  /** 当前任务的分配信息 */
  allocations: Allocations;
  /** 任务来源页面（submitApi），用于隔离不同操作类型的日志展示 */
  taskOrigin: string | null;
  /** 任务完成时间戳（用于即时通知） */
  finishedAt: number | null;

  /** 开始任务：传入 taskId + 分配信息 + 来源页面 */
  startTask: (taskId: string, selectedWorkers: string[], allocations: Allocations, origin: string) => void;
  /** 重置所有状态 */
  resetTask: () => void;
  /** 清除日志 */
  clearLogs: () => void;
  /** 设置提交状态 */
  setSubmitting: (v: boolean) => void;
}

const MAX_LOGS_PER_WORKER = 500;

// ── Context ──

const TaskExecutionContext = createContext<TaskExecutionContextValue | null>(null);

export function useTaskExecution() {
  const ctx = useContext(TaskExecutionContext);
  if (!ctx) throw new Error('useTaskExecution 必须在 TaskExecutionProvider 内使用');
  return ctx;
}

export function TaskExecutionProvider({ children }: { children: ReactNode }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const [submitting, setSubmittingState] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [successCount, setSuccessCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [workerProgress, setWorkerProgress] = useState<WorkerProgress>({});
  const [workerLogs, setWorkerLogs] = useState<WorkerLogs>({});
  const [rate, setRate] = useState(0);
  const [eta, setEta] = useState<number | null>(null);
  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [allocations, setAllocations] = useState<Allocations>({});
  const [taskOrigin, setTaskOrigin] = useState<string | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const fallbackPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const selectedWorkersRef = useRef<string[]>([]);
  const allocationsRef = useRef<Allocations>({});
  const isCompletedRef = useRef(false);

  // ── 速率/ETA 计算 ──
  useEffect(() => {
    if (liveStatus === 'running' && !startTimeRef.current) {
      startTimeRef.current = Date.now();
      const iv = setInterval(() => {
        if (!startTimeRef.current || liveStatus !== 'running') return;
        const elapsed = (Date.now() - startTimeRef.current) / 60000;
        if (elapsed > 0.05) {
          setRate(() => Math.round(doneCount / elapsed));
          setEta(() => {
            if (doneCount > 0) return Math.round((totalCount - doneCount) / (doneCount / elapsed));
            return null;
          });
        }
      }, 1000);
      return () => clearInterval(iv);
    }
  }, [liveStatus, doneCount, totalCount]);

  // ── 将日志按 worker 分组的辅助函数 ──
  const appendLogToWorker = useCallback((log: ApiTaskLogEntry) => {
    setWorkerLogs(prev => {
      const workers = selectedWorkersRef.current;
      const next: WorkerLogs = {};
      for (const name of workers) {
        next[name] = prev[name] ? [...prev[name]] : [];
      }
      const name = log.staffName;
      if (name && next[name]) {
        next[name].push(log);
        if (next[name].length > MAX_LOGS_PER_WORKER) {
          next[name] = next[name].slice(-MAX_LOGS_PER_WORKER);
        }
      } else if (!name) {
        for (const n of workers) {
          next[n].push(log);
          if (next[n].length > MAX_LOGS_PER_WORKER) {
            next[n] = next[n].slice(-MAX_LOGS_PER_WORKER);
          }
        }
      }
      return next;
    });
  }, []);

  // ── 从 result 列表更新 workerProgress（兜底轮询用）──
  const updateProgressFromResults = useCallback((results: WaybillResult[], total: number, done: number, fail: number) => {
    const workers = selectedWorkersRef.current;
    const allocs = allocationsRef.current;

    setTotalCount(total);
    setDoneCount(done);
    setSuccessCount(done - fail);
    setFailedCount(fail);

    const wp: WorkerProgress = {};
    workers.forEach(name => {
      wp[name] = { done: 0, total: allocs[name] || 0, failed: 0 };
    });
    results.forEach((r: WaybillResult) => {
      const name = r.staffName;
      if (!name || !wp[name]) return;
      wp[name].done++;
      if (!r.success) wp[name].failed++;
    });
    setWorkerProgress(wp);
  }, []);

  // ── TC-05B: SSE 核心逻辑 ──
  useEffect(() => {
    if (!taskId || liveStatus !== 'running') {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
      return;
    }

    isCompletedRef.current = false;

    const workers = selectedWorkersRef.current;
    const allocs = allocationsRef.current;
    const initialWl: WorkerLogs = {};
    const initialWp: WorkerProgress = {};
    workers.forEach(name => {
      initialWl[name] = [];
      initialWp[name] = { done: 0, total: allocs[name] || 0, failed: 0 };
    });
    setWorkerLogs(initialWl);
    setWorkerProgress(initialWp);

    const esUrl = `/api/operations/${taskId}/events`;
    const es = new EventSource(esUrl);
    eventSourceRef.current = es;

    es.addEventListener('TASK_LOG', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TASK_LOG' && data.payload) {
          appendLogToWorker(data.payload as ApiTaskLogEntry);
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('TASK_PROGRESS', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TASK_PROGRESS') {
          setTotalCount(data.total);
          setDoneCount(data.done);
          setSuccessCount(data.success);
          setFailedCount(data.failed);

          const wps: WorkerProgress = {};
          workers.forEach(name => {
            const allocTotal = allocs[name] || 0;
            const ratio = data.total > 0 ? allocTotal / data.total : 0;
            const estDone = Math.round(data.done * ratio);
            const estFail = Math.round(data.failed * ratio);
            wps[name] = { done: estDone, total: allocTotal, failed: estFail };
          });
          setWorkerProgress(wps);
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('TASK_FINISHED', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TASK_FINISHED') {
          isCompletedRef.current = true;
          setFinishedAt(data.finishedAt);
          setTotalCount(prev => Math.max(prev, data.successCount + data.failedCount));
          setDoneCount(data.successCount + data.failedCount);
          setSuccessCount(data.successCount);
          setFailedCount(data.failedCount);
          setLiveStatus(data.status === 'done' ? 'completed' : 'error');
          setSubmittingState(false);

          es.close();
          eventSourceRef.current = null;
          if (fallbackPollRef.current) {
            clearInterval(fallbackPollRef.current);
            fallbackPollRef.current = null;
          }
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('end', () => {
      es.close();
      eventSourceRef.current = null;
    });

    es.onerror = () => {
      if (isCompletedRef.current) {
        es.close();
        eventSourceRef.current = null;
      }
    };

    fallbackPollRef.current = setInterval(async () => {
      if (isCompletedRef.current) return;
      try {
        const p = await getTaskProgress(taskId);
        updateProgressFromResults(p.results, p.total, p.done, p.failCount);

        if (p.status === 'done' || p.status === 'failed') {
          isCompletedRef.current = true;
          setFinishedAt(Date.now());
          setLiveStatus(p.status === 'done' ? 'completed' : 'error');
          setSubmittingState(false);
          if (fallbackPollRef.current) {
            clearInterval(fallbackPollRef.current);
            fallbackPollRef.current = null;
          }
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
        }
      } catch {
        // silently ignore
      }
    }, 5000);

    getTaskProgress(taskId).then(p => {
      updateProgressFromResults(p.results, p.total, p.done, p.failCount);
    }).catch(() => {});

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (fallbackPollRef.current) {
        clearInterval(fallbackPollRef.current);
        fallbackPollRef.current = null;
      }
    };
  }, [taskId, liveStatus, appendLogToWorker, updateProgressFromResults]);

  const startTask = useCallback((tid: string, workers: string[], allocs: Allocations, origin: string) => {
    selectedWorkersRef.current = workers;
    allocationsRef.current = allocs;
    setSelectedWorkers(workers);
    setAllocations(allocs);
    setTaskOrigin(origin);
    setTaskId(tid);
    setLiveStatus('running');
    setWorkerLogs({});
    setWorkerProgress({});
    setDoneCount(0);
    setSuccessCount(0);
    setFailedCount(0);
    setTotalCount(0);
    setRate(0);
    setEta(null);
    setFinishedAt(null);
    startTimeRef.current = null;
    isCompletedRef.current = false;
  }, []);

  const resetTask = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (fallbackPollRef.current) {
      clearInterval(fallbackPollRef.current);
      fallbackPollRef.current = null;
    }
    selectedWorkersRef.current = [];
    allocationsRef.current = {};
    setSelectedWorkers([]);
    setAllocations({});
    setTaskOrigin(null);
    setTaskId(null);
    setLiveStatus('idle');
    setSubmittingState(false);
    setWorkerLogs({});
    setWorkerProgress({});
    setDoneCount(0);
    setSuccessCount(0);
    setFailedCount(0);
    setTotalCount(0);
    setRate(0);
    setEta(null);
    setFinishedAt(null);
    startTimeRef.current = null;
    isCompletedRef.current = false;
  }, []);

  const clearLogs = useCallback(() => {
    setWorkerLogs({});
  }, []);

  return (
    <TaskExecutionContext.Provider value={{
      taskId, liveStatus, submitting, totalCount, doneCount, successCount, failedCount,
      workerProgress, workerLogs, rate, eta,
      selectedWorkers, allocations, taskOrigin, finishedAt,
      startTask, resetTask, clearLogs,
      setSubmitting: setSubmittingState,
    }}>
      {children}
    </TaskExecutionContext.Provider>
  );
}
