/**
 * TaskEventBus — 任务事件总线
 * TC-05B: 实现服务端事件推送，用于SSE实时日志和任务完成通知
 *
 * 支持事件类型:
 *   - TASK_LOG: 新日志产生
 *   - TASK_PROGRESS: 进度更新（批次完成）
 *   - TASK_FINISHED: 任务完成
 */
import type { TaskLogEntry } from './TaskLogManager';

export type TaskEventType = 'TASK_LOG' | 'TASK_PROGRESS' | 'TASK_FINISHED';

export interface TaskFinishedEvent {
  type: 'TASK_FINISHED';
  taskId: string;
  status: 'done' | 'failed';
  successCount: number;
  failedCount: number;
  finishedAt: number;
}

export interface TaskLogEvent {
  type: 'TASK_LOG';
  taskId: string;
  payload: TaskLogEntry;
}

export interface TaskProgressEvent {
  type: 'TASK_PROGRESS';
  taskId: string;
  done: number;
  total: number;
  success: number;
  failed: number;
  batchLabel?: string;
}

export type TaskEvent = TaskLogEvent | TaskProgressEvent | TaskFinishedEvent;

type Listener = (event: TaskEvent) => void;

class TaskEventBus {
  private static instance: TaskEventBus | null = null;
  private listeners: Map<string, Set<Listener>> = new Map();

  private constructor() {}

  static getInstance(): TaskEventBus {
    if (!TaskEventBus.instance) {
      TaskEventBus.instance = new TaskEventBus();
    }
    return TaskEventBus.instance;
  }

  emit(event: TaskEvent): void {
    const key = event.taskId;
    const listeners = this.listeners.get(key);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('[TaskEventBus] listener error:', e);
        }
      }
    }

    const globalListeners = this.listeners.get('*');
    if (globalListeners) {
      for (const listener of globalListeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('[TaskEventBus] global listener error:', e);
        }
      }
    }
  }

  on(taskId: string, listener: Listener): () => void {
    if (!this.listeners.has(taskId)) {
      this.listeners.set(taskId, new Set());
    }
    this.listeners.get(taskId)!.add(listener);
    return () => this.off(taskId, listener);
  }

  off(taskId: string, listener: Listener): void {
    const listeners = this.listeners.get(taskId);
    if (listeners) {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(taskId);
      }
    }
  }

  listenerCount(taskId: string): number {
    return this.listeners.get(taskId)?.size ?? 0;
  }
}

export const taskEventBus = TaskEventBus.getInstance();
