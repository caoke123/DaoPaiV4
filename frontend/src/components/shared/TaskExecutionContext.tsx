// TaskExecutionContext — 任务执行状态全局上下文
// Phase 5-G-2: 简化，移除内部日志轮询逻辑，日志统一由 useTaskLiveLogs Hook 处理
//
// 职责：
//   1. 跨页面任务状态持久化（taskId, selectedWorkers, allocations, taskOrigin）
//   2. 任务进度统计（totalCount, doneCount, successCount, failedCount, workerProgress）
//   3. SSE 订阅 TASK_PROGRESS/TASK_FINISHED（旧 AssignmentEngine 链路）
//   4. PG 状态轮询兜底（Agent 任务状态更新）
//
// 日志处理：完全交给 useTaskLiveLogs Hook，不再维护 workerLogs

import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { getTaskProgress, getTaskStatus, type WaybillResult } from '../../api/client';

// ── 类型 ──

export interface WorkerProgress {
  [employeeName: string]: { done: number; total: number; failed: number };
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
  rate: number;
  eta: number | null;

  selectedWorkers: string[];
  allocations: Allocations;
  taskOrigin: string | null;
  finishedAt: number | null;

  startTask: (taskId: string, selectedWorkers: string[], allocations: Allocations, origin: string) => void;
  resetTask: () => void;
  setSubmitting: (v: boolean) => void;
}

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

  const pgStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pgCompletedRef = useRef(false);

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

  // ── 从 result 列表更新 workerProgress ──
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

  // ── SSE 订阅：TASK_PROGRESS / TASK_FINISHED（旧 AssignmentEngine 链路）──
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
    const initialWp: WorkerProgress = {};
    workers.forEach(name => {
      initialWp[name] = { done: 0, total: allocs[name] || 0, failed: 0 };
    });
    setWorkerProgress(initialWp);

    const esUrl = `/api/operations/${taskId}/events`;
    const es = new EventSource(esUrl);
    eventSourceRef.current = es;

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
          if (pgStatusPollRef.current) {
            clearInterval(pgStatusPollRef.current);
            pgStatusPollRef.current = null;
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
          if (pgStatusPollRef.current) {
            clearInterval(pgStatusPollRef.current);
            pgStatusPollRef.current = null;
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
  }, [taskId, liveStatus, updateProgressFromResults]);

  // ── PG 状态轮询（Agent 任务状态更新兜底）──
  useEffect(() => {
    if (!taskId) {
      if (pgStatusPollRef.current) { clearInterval(pgStatusPollRef.current); pgStatusPollRef.current = null; }
      return;
    }

    pgCompletedRef.current = false;

    getTaskStatus(taskId).then(s => {
      setTotalCount(s.totalCount);
      setDoneCount(s.doneCount);
      setFailedCount(s.failCount);
      setSuccessCount(Math.max(0, s.doneCount - s.failCount));

      if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') {
        pgCompletedRef.current = true;
        setFinishedAt(Date.now());
        setLiveStatus(s.status === 'done' ? 'completed' : 'error');
        setSubmittingState(false);
        if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
        if (fallbackPollRef.current) { clearInterval(fallbackPollRef.current); fallbackPollRef.current = null; }
      }
    }).catch(() => {});

    pgStatusPollRef.current = setInterval(async () => {
      if (pgCompletedRef.current || isCompletedRef.current) return;
      try {
        const s = await getTaskStatus(taskId);
        setTotalCount(s.totalCount);
        setDoneCount(s.doneCount);
        setFailedCount(s.failCount);
        setSuccessCount(Math.max(0, s.doneCount - s.failCount));

        if (s.status === 'done' || s.status === 'failed' || s.status === 'cancelled') {
          pgCompletedRef.current = true;
          setFinishedAt(Date.now());
          setLiveStatus(s.status === 'done' ? 'completed' : 'error');
          setSubmittingState(false);
          if (pgStatusPollRef.current) { clearInterval(pgStatusPollRef.current); pgStatusPollRef.current = null; }
          if (eventSourceRef.current) { eventSourceRef.current.close(); eventSourceRef.current = null; }
          if (fallbackPollRef.current) { clearInterval(fallbackPollRef.current); fallbackPollRef.current = null; }
        }
      } catch {
        // silently ignore
      }
    }, 2000);

    return () => {
      if (pgStatusPollRef.current) { clearInterval(pgStatusPollRef.current); pgStatusPollRef.current = null; }
    };
  }, [taskId]);

  const startTask = useCallback((tid: string, workers: string[], allocs: Allocations, origin: string) => {
    selectedWorkersRef.current = workers;
    allocationsRef.current = allocs;
    setSelectedWorkers(workers);
    setAllocations(allocs);
    setTaskOrigin(origin);
    setTaskId(tid);
    setLiveStatus('running');
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
    pgCompletedRef.current = false;
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
    if (pgStatusPollRef.current) {
      clearInterval(pgStatusPollRef.current);
      pgStatusPollRef.current = null;
    }
    selectedWorkersRef.current = [];
    allocationsRef.current = {};
    setSelectedWorkers([]);
    setAllocations({});
    setTaskOrigin(null);
    setTaskId(null);
    setLiveStatus('idle');
    setSubmittingState(false);
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
    pgCompletedRef.current = false;
  }, []);

  return (
    <TaskExecutionContext.Provider value={{
      taskId, liveStatus, submitting, totalCount, doneCount, successCount, failedCount,
      workerProgress, rate, eta,
      selectedWorkers, allocations, taskOrigin, finishedAt,
      startTask, resetTask,
      setSubmitting: setSubmittingState,
    }}>
      {children}
    </TaskExecutionContext.Provider>
  );
}
