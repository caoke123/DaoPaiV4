/**
 * Playwright Window State Store — 窗口状态管理
 *
 * Phase 1-A 补丁：Map key 从 windowId 改为 runtimeKey（tenantId:siteId:windowId）
 *
 * 维护 runtimeKey → PlaywrightWindowState 的内存映射。
 * 不持久化，进程重启后状态丢失（但 userDataDir 保留登录态）。
 */
import type { PlaywrightWindowState, PlaywrightWindowStatus } from './types';
import { buildRuntimeKey } from './types';

export class PlaywrightWindowStateStore {
  /** 内部 Map key 为 runtimeKey = tenantId:siteId:windowId */
  private windows = new Map<string, PlaywrightWindowState>();

  /**
   * 设置窗口状态（覆盖）
   * @param runtimeKey tenantId:siteId:windowId
   */
  set(runtimeKey: string, state: PlaywrightWindowState): void {
    if (state.runtimeKey !== runtimeKey) {
      throw new Error(`runtimeKey 不匹配: map key=${runtimeKey}, state.runtimeKey=${state.runtimeKey}`);
    }
    state.lastUpdated = Date.now();
    this.windows.set(runtimeKey, state);
  }

  /**
   * 获取窗口状态
   * @param runtimeKey tenantId:siteId:windowId
   */
  get(runtimeKey: string): PlaywrightWindowState | undefined {
    return this.windows.get(runtimeKey);
  }

  /**
   * 通过三元组获取窗口状态
   */
  findByTriple(tenantId: string, siteId: string, windowId: string): PlaywrightWindowState | undefined {
    return this.windows.get(buildRuntimeKey(tenantId, siteId, windowId));
  }

  /**
   * 局部更新窗口状态
   * @param runtimeKey tenantId:siteId:windowId
   */
  update(runtimeKey: string, patch: Partial<PlaywrightWindowState>): PlaywrightWindowState | undefined {
    const current = this.windows.get(runtimeKey);
    if (!current) return undefined;
    const updated: PlaywrightWindowState = {
      ...current,
      ...patch,
      runtimeKey: current.runtimeKey,       // runtimeKey 不可变
      tenantId: current.tenantId,            // tenantId 不可变
      siteId: current.siteId,                // siteId 不可变
      windowId: current.windowId,            // windowId 不可变
      userDataDir: current.userDataDir,      // userDataDir 不可变
      createdAt: current.createdAt,          // createdAt 不可变
      lastUpdated: Date.now(),
    };
    this.windows.set(runtimeKey, updated);
    return updated;
  }

  /**
   * 仅更新状态码
   * @param runtimeKey tenantId:siteId:windowId
   */
  setStatus(runtimeKey: string, status: PlaywrightWindowStatus, error?: string): void {
    this.update(runtimeKey, { status, error });
  }

  /**
   * 删除窗口状态（窗口关闭时调用）
   * @param runtimeKey tenantId:siteId:windowId
   */
  delete(runtimeKey: string): void {
    this.windows.delete(runtimeKey);
  }

  /** 列出所有窗口状态 */
  list(): PlaywrightWindowState[] {
    return Array.from(this.windows.values());
  }

  /** 列出所有活跃窗口（非 closed） */
  listActive(): PlaywrightWindowState[] {
    return this.list().filter(s => s.status !== 'closed' && s.status !== 'error');
  }

  /** 获取窗口数量 */
  size(): number {
    return this.windows.size;
  }

  /** 清空所有状态（不关闭浏览器，仅清内存映射） */
  clear(): void {
    this.windows.clear();
  }

  /** 序列化为可返回给前端的格式（移除 context/page 等不可序列化字段） */
  toJSON(runtimeKey: string): Omit<PlaywrightWindowState, 'context' | 'page'> | undefined {
    const state = this.get(runtimeKey);
    if (!state) return undefined;
    const { context, page, ...rest } = state;
    return rest;
  }

  /** 序列化所有窗口状态 */
  listJSON(): Array<Omit<PlaywrightWindowState, 'context' | 'page'>> {
    return this.list().map(s => {
      const { context, page, ...rest } = s;
      return rest;
    });
  }
}
