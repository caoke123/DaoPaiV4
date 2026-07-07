/**
 * Phase D-0B: Runtime 状态模块（EasyBR legacy removed）
 *
 * 跟踪运行时可用性，与 Express 启动完全解耦。
 * Deploy-0B: EasyBR 生产路径已断开，不再暴露 easybrConnected 字段。
 */

export type RuntimeHealth = 'available' | 'unavailable' | 'degraded';

interface RuntimeState {
  health: RuntimeHealth;
  error: string | null;
  lastCheckedAt: number | null;
}

export class RuntimeStatus {
  private state: RuntimeState = {
    health: 'unavailable',
    error: null,
    lastCheckedAt: null,
  };

  private static instance: RuntimeStatus;

  static getInstance(): RuntimeStatus {
    if (!RuntimeStatus.instance) {
      RuntimeStatus.instance = new RuntimeStatus();
    }
    return RuntimeStatus.instance;
  }

  /** 运行时初始化成功 */
  markAvailable(): void {
    this.state = {
      health: 'available',
      error: null,
      lastCheckedAt: Date.now(),
    };
    console.log('[RuntimeStatus] 状态 → available');
  }

  /** 运行时初始化失败 */
  markUnavailable(error: string): void {
    this.state = {
      health: 'unavailable',
      error,
      lastCheckedAt: Date.now(),
    };
    console.warn(`[RuntimeStatus] 状态 → unavailable: ${error}`);
  }

  /** 部分功能可用 */
  markDegraded(error: string): void {
    this.state = {
      health: 'degraded',
      error,
      lastCheckedAt: Date.now(),
    };
    console.warn(`[RuntimeStatus] 状态 → degraded: ${error}`);
  }

  /** 获取当前状态 */
  getState(): Readonly<RuntimeState> {
    return this.state;
  }

  /** 是否可用于执行任务 */
  isAvailable(): boolean {
    return this.state.health === 'available';
  }

  /** 获取状态摘要（用于 /api/status） */
  getSummary(): {
    runtime: RuntimeHealth;
    runtimeError: string | null;
    runtimeLastCheckedAt: number | null;
  } {
    return {
      runtime: this.state.health,
      runtimeError: this.state.error,
      runtimeLastCheckedAt: this.state.lastCheckedAt,
    };
  }
}

export const runtimeStatus = RuntimeStatus.getInstance();