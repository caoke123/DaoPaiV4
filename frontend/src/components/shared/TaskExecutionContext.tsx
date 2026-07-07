// TaskExecutionContext — 任务执行状态全局上下文
// Phase 5-G-2: 简化，移除内部日志轮询逻辑，日志统一由 useTaskLiveLogs Hook 处理
// Phase 5-G-7-2: localStorage 只存索引，真实状态从后端 PG 恢复
//
// 职责：
//   1. 跨页面任务状态持久化（taskId, selectedWorkers, allocations, taskOrigin）
//   2. 任务进度统计（totalCount, doneCount, successCount, failedCount, workerProgress）
//   3. SSE 订阅 TASK_PROGRESS/TASK_FINISHED（旧 AssignmentEngine 链路）
//   4. PG 状态轮询兜底（Agent 任务状态更新）
//   5. 任务恢复：从 localStorage 加载索引，从 API 恢复完整状态
//
// 日志处理：完全交给 useTaskLiveLogs Hook，不再维护 workerLogs

import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { getTaskProgress, getTaskStatus, getTaskDetail, type WaybillResult, type TaskDetailResponse } from '../../api/client';

// ── Phase 5-G-7-2: localStorage 最小持久化 ──
const LS_PREFIX = 'daopai_task_';

interface PersistedTask {
  taskId: string;
  taskType: string;
  taskOrigin: string;
  savedAt: number;
}

function persistTask(task: PersistedTask): void {
  const key = `${LS_PREFIX}${originToTypeKey(task.taskOrigin)}`;
  try {
    localStorage.setItem(key, JSON.stringify(task));
  } catch { /* quota exceeded */ }
}

function loadPersistedTask(originKey: string): PersistedTask | null {
  const key = `${LS_PREFIX}${originKey}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedTask;
  } catch { return null; }
}

function clearPersistedTask(originKey: string): void {
  const key = `${LS_PREFIX}${originKey}`;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

/** 将 taskOrigin 如 /api/operations/integrated 标准化为 integrated */
function normalizeOriginKey(origin: string): string {
  const parts = origin.split('/');
  return parts[parts.length - 1] || origin;
}

/** 将 taskOrigin 映射到 localStorage key（处理 arrive→arrival） */
function originToTypeKey(origin: string): string {
  const normalized = normalizeOriginKey(origin);
  if (normalized === 'arrive') return 'arrival';
  return normalized;
}

/** 根据 origin 验证 task type 是否匹配 */
function taskTypeMatchesOrigin(taskType: string, origin: string): boolean {
  const typeKey = originToTypeKey(origin);
  return taskType === typeKey;
}

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
  /** 从 localStorage + 后端 PG 恢复任务状态，返回是否成功 */
  restoreTask: (origin: string) => Promise<boolean>;
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
  const taskOriginRef = useRef<string | null>(null);

  const pgStatusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pgCompletedRef = useRef(false);

  // 防止同一 origin 重复恢复
  const restoredRef = useRef<Set<string>>(new Set());

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
    if (results.length === 0 && done > 0) {
      const workers = selectedWorkersRef.current;
      const allocs = allocationsRef.current;
      setTotalCount(total);
      setDoneCount(done);
      setSuccessCount(done - fail);
      setFailedCount(fail);
      const wp: WorkerProgress = {};
      workers.forEach(name => {
        const allocTotal = allocs[name] || 0;
        const ratio = total > 0 ? allocTotal / total : 0;
        wp[name] = {
          done: Math.min(allocTotal, Math.round(done * ratio)),
          total: allocTotal,
          failed: Math.min(allocTotal, Math.round(fail * ratio)),
        };
      });
      setWorkerProgress(wp);
      return;
    }

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

  const updateProgressFromCounts = useCallback((total: number, done: number, fail: number) => {
    setTotalCount(total);
    setDoneCount(done);
    setSuccessCount(Math.max(0, done - fail));
    setFailedCount(fail);

    const workers = selectedWorkersRef.current;
    const allocs = allocationsRef.current;
    const wp: WorkerProgress = {};
    workers.forEach(name => {
      const allocTotal = allocs[name] || 0;
      const ratio = total > 0 ? allocTotal / total : 0;
      wp[name] = {
        done: Math.min(allocTotal, Math.round(done * ratio)),
        total: allocTotal,
        failed: Math.min(allocTotal, Math.round(fail * ratio)),
      };
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
      updateProgressFromCounts(s.totalCount, s.doneCount, s.failCount);

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
        updateProgressFromCounts(s.totalCount, s.doneCount, s.failCount);

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
  }, [taskId, updateProgressFromCounts]);

  // ── 从后端恢复任务状态 ──
  const restoreFromDetail = useCallback((detail: TaskDetailResponse, origin: string) => {
    const workers = detail.assignments.map(a => a.staffName).filter(Boolean);
    const allocs: Allocations = {};
    detail.assignments.forEach(a => {
      if (a.staffName) allocs[a.staffName] = a.count || 0;
    });

    selectedWorkersRef.current = workers;
    allocationsRef.current = allocs;
    setSelectedWorkers(workers);
    setAllocations(allocs);
    setTaskOrigin(origin);
    taskOriginRef.current = origin;
    setTaskId(detail.taskId);

    setTotalCount(detail.totalCount);
    setDoneCount(detail.doneCount);
    setFailedCount(detail.failCount);
    setSuccessCount(Math.max(0, detail.doneCount - detail.failCount));

    // 计算 workerProgress
    const wp: WorkerProgress = {};
    workers.forEach(name => {
      const wTotal = allocs[name] || 0;
      const ratio = detail.totalCount > 0 ? wTotal / detail.totalCount : 0;
      wp[name] = {
        done: Math.min(wTotal, Math.round(detail.doneCount * ratio)),
        total: wTotal,
        failed: Math.min(wTotal, Math.round(detail.failCount * ratio)),
      };
    });
    setWorkerProgress(wp);

    if (detail.status === 'running' || detail.status === 'assigned' || detail.status === 'pending') {
      setLiveStatus('running');
    } else if (detail.status === 'done') {
      setLiveStatus('completed');
      setFinishedAt(detail.finishedAt ? new Date(detail.finishedAt).getTime() : Date.now());
    } else if (detail.status === 'failed' || detail.status === 'cancelled') {
      setLiveStatus('error');
      setFinishedAt(detail.finishedAt ? new Date(detail.finishedAt).getTime() : Date.now());
    } else {
      setLiveStatus('idle');
    }

    setRate(0);
    setEta(null);
    startTimeRef.current = null;
    isCompletedRef.current = detail.status === 'done' || detail.status === 'failed' || detail.status === 'cancelled';
    pgCompletedRef.current = isCompletedRef.current;
  }, []);

  const restoreTask = useCallback(async (origin: string): Promise<boolean> => {
    const typeKey = originToTypeKey(origin);
    const persisted = loadPersistedTask(typeKey);
    if (!persisted?.taskId) return false;

    // 同一任务已经恢复完整时直接返回；若 workers/stats 仍为空，允许再次从后端补齐。
    if (restoredRef.current.has(typeKey) && taskId === persisted.taskId && selectedWorkersRef.current.length > 0) {
      return true;
    }
    restoredRef.current.add(typeKey);

    try {
      const detail = await getTaskDetail(persisted.taskId);

      // 校验 type 匹配
      if (!taskTypeMatchesOrigin(detail.type, origin)) {
        console.warn(`[TaskRestore] 任务类型不匹配: localStorage=${typeKey}, API=${detail.type}`);
        clearPersistedTask(typeKey);
        restoredRef.current.delete(typeKey);
        return false;
      }

      restoreFromDetail(detail, origin);
      console.log(`[TaskRestore] 恢复任务成功: ${persisted.taskId}, type=${detail.type}, status=${detail.status}, workers=${detail.assignments.length}`);
      return true;
    } catch (e) {
      console.error(`[TaskRestore] 恢复失败:`, (e as Error).message);
      // API 失败不删除 localStorage，下次重试
      restoredRef.current.delete(typeKey);
      return false;
    }
  }, [restoreFromDetail, taskId]);

  const startTask = useCallback((tid: string, workers: string[], allocs: Allocations, origin: string) => {
    selectedWorkersRef.current = workers;
    allocationsRef.current = allocs;
    setSelectedWorkers(workers);
    setAllocations(allocs);
    setTaskOrigin(origin);
    taskOriginRef.current = origin;
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

    // Phase 5-G-7-2: localStorage 只存索引（taskId, taskType, taskOrigin）
    const typeKey = originToTypeKey(origin);
    persistTask({
      taskId: tid,
      taskType: typeKey,
      taskOrigin: origin,
      savedAt: Date.now(),
    });
    // 标记已恢复，防止页面重载后 restoreTask 再来一次覆盖
    restoredRef.current.add(typeKey);
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
    // Phase 5-G-7-2: 清除 localStorage 任务持久化
    const currentOrigin = taskOriginRef.current;
    if (currentOrigin) {
      const typeKey = originToTypeKey(currentOrigin);
      clearPersistedTask(typeKey);
      restoredRef.current.delete(typeKey);
    }
    taskOriginRef.current = null;
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
      restoreTask,
    }}>
      {children}
    </TaskExecutionContext.Provider>
  );
}
