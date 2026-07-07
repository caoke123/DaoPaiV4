/**
 * WindowBusyRegistry — 窗口级 BUSY 注册表
 *
 * 目标：
 *   1. 将 BUSY 从全局 runningTaskId 收敛到具体 windowId
 *   2. 为状态上报、命令保护、执行器占用提供统一数据源
 *   3. 不改变当前 Agent 单任务主循环，只缩小被误伤的窗口范围
 */

export interface WindowBusyEntry {
  windowId: string;
  taskId: string;
  siteId: string;
  staffName: string;
  taskType: string;
  acquiredAt: number;
}

const busyRegistry = new Map<string, WindowBusyEntry>();

export function acquireWindowBusy(entry: Omit<WindowBusyEntry, 'acquiredAt'>): WindowBusyEntry {
  const value: WindowBusyEntry = {
    ...entry,
    acquiredAt: Date.now(),
  };
  busyRegistry.set(entry.windowId, value);
  return value;
}

export function releaseWindowBusy(windowId: string, taskId?: string): void {
  const current = busyRegistry.get(windowId);
  if (!current) return;
  if (taskId && current.taskId !== taskId) return;
  busyRegistry.delete(windowId);
}

export function getWindowBusy(windowId: string): WindowBusyEntry | null {
  return busyRegistry.get(windowId) ?? null;
}

export function isWindowBusy(windowId: string): { busy: boolean; reason?: string; entry?: WindowBusyEntry } {
  const entry = busyRegistry.get(windowId);
  if (!entry) return { busy: false };
  return {
    busy: true,
    reason: `窗口正在执行任务 ${entry.taskId} (${entry.taskType})`,
    entry,
  };
}

export function listBusyWindows(): WindowBusyEntry[] {
  return Array.from(busyRegistry.values());
}
