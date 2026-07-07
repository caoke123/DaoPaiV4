/** 日志上下文（窗口级追踪） */
export interface LogContext {
  staffName?: string;
  windowId?: string;
}

export interface TaskLogEntry {
  id: string;
  taskId: string;
  timestamp: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  source: string;
  /** 结构化窗口追踪：员工姓名（Worker Window 标识，admin 角色冻结后统一为员工姓名） */
  staffName?: string;
  /** 结构化窗口追踪：窗口ID */
  windowId?: string;
  workstationId?: string;
}

const MAX_LOGS_PER_TASK = 500;
const MAX_TOTAL_TASKS = 100;

/**
 * TC-05B: 日志消息清洗 — 移除前端用户无需看到的技术细节
 *
 * 清洗内容：
 *   1. ANSI 转义序列（颜色/格式控制符，如 \x1B[2m、[22m 等）
 *   2. Playwright "Call log:" 及其后面的内部调用栈信息
 *   3. 多余空行和首尾空白
 *
 * 注意：只清洗前端展示用的日志，后端控制台输出仍保留完整错误信息用于排查问题
 */
function sanitizeLogMessage(msg: string): string {
  let cleaned = msg;

  cleaned = cleaned
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\[\d{1,2}(;\d{1,2})?m/g, '')
    .replace(/Call log:[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

export class TaskLogManager {
  private static instance: TaskLogManager | null = null;
  private logs: Map<string, TaskLogEntry[]> = new Map();
  private taskOrder: string[] = [];
  private onLogCallback: ((entry: TaskLogEntry) => void) | null = null;

  private constructor() {}

  static getInstance(): TaskLogManager {
    if (!TaskLogManager.instance) {
      TaskLogManager.instance = new TaskLogManager();
    }
    return TaskLogManager.instance;
  }

  /**
   * 设置日志回调（供 EventBus 使用，延迟导入避免循环依赖）
   */
  setLogCallback(cb: (entry: TaskLogEntry) => void): void {
    this.onLogCallback = cb;
  }

  addLog(
    taskId: string,
    level: 'info' | 'success' | 'warning' | 'error',
    message: string,
    source: string,
    context?: LogContext,
  ): void {
    const entry: TaskLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      timestamp: Date.now(),
      level,
      message: sanitizeLogMessage(message),
      source,
      staffName: context?.staffName,
      windowId: context?.windowId,
    };

    let taskLogs = this.logs.get(taskId);
    if (!taskLogs) {
      taskLogs = [];
      this.logs.set(taskId, taskLogs);
      this.taskOrder.push(taskId);
      if (this.taskOrder.length > MAX_TOTAL_TASKS) {
        const oldestTaskId = this.taskOrder.shift()!;
        this.logs.delete(oldestTaskId);
      }
    }

    taskLogs.push(entry);
    if (taskLogs.length > MAX_LOGS_PER_TASK) {
      taskLogs.shift();
    }

    if (this.onLogCallback) {
      this.onLogCallback(entry);
    }
  }

  getLogs(taskId: string): TaskLogEntry[] {
    return this.logs.get(taskId) || [];
  }

  getRecentLogs(taskId: string, limit: number = 50): TaskLogEntry[] {
    const logs = this.getLogs(taskId);
    return logs.slice(-limit);
  }

  clearLogs(taskId: string): void {
    this.logs.delete(taskId);
    const idx = this.taskOrder.indexOf(taskId);
    if (idx > -1) this.taskOrder.splice(idx, 1);
  }
}

export const taskLogManager = TaskLogManager.getInstance();
