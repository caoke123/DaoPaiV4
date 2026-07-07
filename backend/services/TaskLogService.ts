/**
 * TaskLogService — 统一任务日志服务
 * Phase 5-G-2: 统一日志标准化、PG 持久化、EventBus 广播
 *
 * 职责：
 *   1. 标准化日志字段（level/message/timestamp/staffName/source）
 *   2. 写入 PostgreSQL task_logs（通过 PgDatabase.insertTaskLogs）
 *   3. 写入成功后对每条日志 emit TASK_LOG 事件（打通 SSE）
 *   4. 兼容 Agent 日志和其他任务类型
 *
 * 注意：不通过 taskLogManager.addLog() 写内存，避免与旧链路的内存日志重复。
 * 旧 AssignmentEngine 链路仍走 taskLogManager.addLog()，保持兼容。
 */

import { randomUUID } from 'node:crypto';
import { PgDatabase } from '../db/PgDatabase';
import { taskEventBus } from '../utils/TaskEventBus';
import type { TaskLogEntry } from '../utils/TaskLogManager';

export interface TaskLogInput {
  level?: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp?: number;
  staffName?: string;
  windowId?: string;
}

export interface TaskLogContext {
  tenantId: string;
  workstationId?: string;
  siteId?: string;
  source: string;
}

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STAFFNAME_LENGTH = 100;
const VALID_LEVELS = new Set(['info', 'success', 'warning', 'error']);

function normalizeLevel(level: string | undefined): 'info' | 'success' | 'warning' | 'error' {
  if (level && VALID_LEVELS.has(level)) {
    return level as 'info' | 'success' | 'warning' | 'error';
  }
  return 'info';
}

function normalizeMessage(msg: string | undefined): string {
  if (!msg) return '';
  return String(msg).substring(0, MAX_MESSAGE_LENGTH);
}

function normalizeStaffName(name: string | undefined): string {
  if (!name) return '';
  return String(name).substring(0, MAX_STAFFNAME_LENGTH);
}

class TaskLogService {
  private static instance: TaskLogService | null = null;

  static getInstance(): TaskLogService {
    if (!TaskLogService.instance) {
      TaskLogService.instance = new TaskLogService();
    }
    return TaskLogService.instance;
  }

  /**
   * 追加日志到 PG 并广播 TASK_LOG 事件
   *
   * @param taskId  任务 ID
   * @param logs    日志条目数组
   * @param context 上下文（tenantId/source/workstationId 等）
   * @returns 写入的标准化日志条目
   */
  async appendLogs(
    taskId: string,
    logs: TaskLogInput[],
    context: TaskLogContext
  ): Promise<TaskLogEntry[]> {
    if (!logs || logs.length === 0) return [];

    const pg = PgDatabase.getInstance();
    const now = Date.now();

    const normalizedEntries = logs.map(entry => {
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : now;
      const level = normalizeLevel(entry.level);
      const message = normalizeMessage(entry.message);
      const staffName = normalizeStaffName(entry.staffName);
      return {
        id: randomUUID(),
        taskId,
        timestamp: isNaN(ts) ? now : ts,
        level: level as TaskLogEntry['level'],
        message,
        source: context.source || 'system',
        staffName: staffName || undefined,
        windowId: entry.windowId || undefined,
      } as TaskLogEntry;
    });

    const logEntriesForPg = normalizedEntries.map(e => ({
      id: e.id,
      taskId: e.taskId,
      level: e.level,
      message: e.message,
      source: e.source,
      staffName: e.staffName || '',
      windowId: e.windowId,
      timestamp: e.timestamp,
    }));

    await pg.insertTaskLogs(logEntriesForPg, context.tenantId);

    // Phase 5-J-1: Agent 日志保存简洁日志（仅 source=agent 时输出，避免冗余）
    if (context.source === 'agent') {
      const firstStaff = normalizedEntries[0]?.staffName || '(空)';
      const firstWindow = normalizedEntries[0]?.windowId || '(空)';
      console.log(`[TaskLogService] Agent日志已保存，taskId=${taskId}, staffName=${firstStaff}, windowId=${firstWindow}, count=${normalizedEntries.length}`);
    }

    for (const entry of normalizedEntries) {
      try {
        taskEventBus.emit({
          type: 'TASK_LOG',
          taskId,
          payload: entry,
        });
      } catch (emitErr) {
        console.error('[TaskLogService] emit TASK_LOG failed:', (emitErr as Error).message);
      }
    }

    return normalizedEntries;
  }
}

export const taskLogService = TaskLogService.getInstance();
