/**
 * LocalWindowRegistry — 本地窗口注册表 (Phase Deploy-0D-Fix-2)
 *
 * 维护 windowId → 窗口元数据的映射，支持：
 *   - open_window 成功后登记
 *   - close_window 按 windowId 精确查找
 *   - Agent 重启后通过 window_status 恢复
 *
 * 线程安全：单进程内 Map 操作，无并发问题。
 */

export interface WindowRegistryEntry {
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  chromePid: number | null;
  cdpEndpoint: string;
  debugPort: number;
  profilePath: string;
  launchedAt: number;
}

/** 全局注册表（进程级生命周期） */
const registry = new Map<string, WindowRegistryEntry>();

/**
 * 登记一个窗口
 */
export function registerWindow(entry: WindowRegistryEntry): void {
  registry.set(entry.windowId, entry);
  console.log(`[WindowRegistry] 登记窗口: windowId=${entry.windowId} pid=${entry.chromePid} port=${entry.debugPort}`);
}

/**
 * 注销一个窗口
 */
export function unregisterWindow(windowId: string): void {
  registry.delete(windowId);
  console.log(`[WindowRegistry] 注销窗口: windowId=${windowId}`);
}

/**
 * 查找窗口
 */
export function findWindow(windowId: string): WindowRegistryEntry | undefined {
  return registry.get(windowId);
}

/**
 * 获取所有已登记窗口
 */
export function getAllWindows(): WindowRegistryEntry[] {
  return Array.from(registry.values());
}

/**
 * 按 staffName 查找窗口
 */
export function findWindowByStaff(staffName: string): WindowRegistryEntry | undefined {
  for (const [, entry] of registry) {
    if (entry.staffName === staffName) return entry;
  }
  return undefined;
}

/**
 * 检查窗口是否已登记
 */
export function isWindowRegistered(windowId: string): boolean {
  return registry.has(windowId);
}

/**
 * 获取注册表大小
 */
export function getRegistrySize(): number {
  return registry.size;
}
