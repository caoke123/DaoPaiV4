/**
 * WindowLockManager — 窗口级资源锁管理器
 *
 * 职责：
 *   - acquire / release 窗口锁
 *   - 查询窗口占用状态
 *   - 检测超时锁（仅监控，不自动释放）
 *
 * 设计原则：
 *   - 锁粒度：windowId（不使用 staffName，避免同名/映射变化问题）
 *   - 抢占式：acquire 失败立即抛 WindowBusyError，不排队等待
 *   - release 幂等：重复释放不报错
 *   - 单例：全局唯一实例
 *   - 内存锁：服务重启即清空，符合崩溃恢复需求
 */

/** 窗口锁信息 */
export interface WindowLock {
  windowId: string;
  taskId: string;
  acquiredAt: number;
}

/** 锁状态快照（含空闲窗口的占位项由调用方拼接） */
export interface WindowLockSnapshot {
  windowId: string;
  busy: boolean;
  taskId?: string;
  acquiredAt?: number;
}

/** 窗口被占用时抛出的错误 */
export class WindowBusyError extends Error {
  readonly windowId: string;
  readonly currentTaskId: string;

  constructor(windowId: string, currentTaskId: string) {
    super(
      `窗口 ${windowId} 已被任务 ${currentTaskId} 占用`,
    );
    this.name = 'WindowBusyError';
    this.windowId = windowId;
    this.currentTaskId = currentTaskId;
  }
}

/**
 * WindowLockManager 单例
 *
 * 使用方式：
 *   const lock = WindowLockManager.getInstance();
 *   await lock.acquire(windowId, taskId);
 *   try {
 *     // 操作窗口...
 *   } finally {
 *     lock.release(windowId, taskId);
 *   }
 */
export class WindowLockManager {
  private static instance: WindowLockManager | null = null;

  /** 锁表：windowId → WindowLock */
  private locks = new Map<string, WindowLock>();

  private constructor() {}

  static getInstance(): WindowLockManager {
    if (!WindowLockManager.instance) {
      WindowLockManager.instance = new WindowLockManager();
    }
    return WindowLockManager.instance;
  }

  /**
   * 获取窗口锁
   *
   * - 窗口空闲：立即成功，记录锁信息
   * - 窗口被占用：立即抛 WindowBusyError（不排队等待）
   *
   * @param windowId 目标窗口ID
   * @param taskId   当前任务ID（用于诊断与日志）
   * @throws WindowBusyError 窗口已被占用
   */
  async acquire(windowId: string, taskId: string): Promise<void> {
    const existing = this.locks.get(windowId);
    if (existing) {
      throw new WindowBusyError(windowId, existing.taskId);
    }

    const lock: WindowLock = {
      windowId,
      taskId,
      acquiredAt: Date.now(),
    };
    this.locks.set(windowId, lock);

    console.log(
      `[WindowLock] acquired windowId=${windowId} taskId=${taskId}`,
    );
  }

  /**
   * 释放窗口锁（幂等）
   *
   * - 重复释放不报错
   * - 可选校验 taskId：若提供且与当前锁的 taskId 不匹配，则忽略（不报错，仅 debug 日志）
   *
   * @param windowId 目标窗口ID
   * @param taskId   可选，用于校验释放者身份
   */
  release(windowId: string, taskId?: string): void {
    const existing = this.locks.get(windowId);
    if (!existing) {
      // 幂等：窗口未被锁定，静默返回
      return;
    }

    if (taskId !== undefined && existing.taskId !== taskId) {
      // taskId 不匹配：可能是误释放，仅记录日志，不报错
      console.log(
        `[WindowLock] release skipped (taskId mismatch) windowId=${windowId} callerTaskId=${taskId} holderTaskId=${existing.taskId}`,
      );
      return;
    }

    this.locks.delete(windowId);
    console.log(
      `[WindowLock] released windowId=${windowId} taskId=${existing.taskId}`,
    );
  }

  /**
   * 查询窗口是否被占用
   */
  isBusy(windowId: string): boolean {
    return this.locks.has(windowId);
  }

  /**
   * 获取窗口的锁信息（未占用时返回 undefined）
   */
  getLock(windowId: string): WindowLock | undefined {
    return this.locks.get(windowId);
  }

  /**
   * 获取所有锁状态快照（诊断/监控用）
   *
   * 仅返回当前已占用的窗口。调用方可与 BrowserPool 的窗口列表合并，
   * 拼出完整的 busy=false 快照。
   */
  getSnapshot(): WindowLockSnapshot[] {
    const snapshots: WindowLockSnapshot[] = [];
    for (const [windowId, lock] of this.locks) {
      snapshots.push({
        windowId,
        busy: true,
        taskId: lock.taskId,
        acquiredAt: lock.acquiredAt,
      });
    }
    return snapshots;
  }

  /**
   * 检测超时锁（仅监控，不自动释放）
   *
   * 用于诊断接口或定时巡检，发现长期未释放的锁。
   * 实际清理应由运维介入或进程重启。
   *
   * @param thresholdMs 阈值毫秒数（如 5 * 60 * 1000 = 5分钟）
   * @returns 超过阈值的锁列表
   */
  getOverdueLocks(thresholdMs: number): WindowLock[] {
    const now = Date.now();
    const overdue: WindowLock[] = [];
    for (const lock of this.locks.values()) {
      if (now - lock.acquiredAt > thresholdMs) {
        overdue.push(lock);
      }
    }
    return overdue;
  }
}
