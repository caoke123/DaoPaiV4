// RuntimeMetrics — 统一运行指标收集
// Phase D-2C: 跨模块指标汇总，供 /api/status 暴露和长稳测试量化

// ── 类型定义 ──────────────────────────────────────────

export interface RuntimeMetricsSnapshot {
  /** 弹窗清除次数（PopupManager.dismissAll 成功次数） */
  popupDismissCount: number;
  /** Session 自动恢复尝试次数 */
  sessionRecoverCount: number;
  /** Session 自动恢复成功次数 */
  sessionRecoverSuccessCount: number;
  /** Session 自动恢复失败次数 */
  sessionRecoverFailCount: number;
  /** 导航自动修复次数（URL 降级/autoFix） */
  navigationFixCount: number;
  /** 任务成功次数（运单级别） */
  taskSuccessCount: number;
  /** 任务失败次数（运单级别） */
  taskFailCount: number;
  /** 运行开始时间 */
  startTime: string;
  /** 快照时间 */
  snapshotTime: string;
  /** 运行时长（毫秒） */
  uptimeMs: number;
}

// ── RuntimeMetrics 类 ─────────────────────────────────

export class RuntimeMetrics {
  private static instance: RuntimeMetrics | null = null;

  private startTime: number;

  private metrics = {
    popupDismiss: 0,
    sessionRecover: 0,
    sessionRecoverSuccess: 0,
    sessionRecoverFail: 0,
    navigationFix: 0,
    taskSuccess: 0,
    taskFail: 0,
  };

  private constructor() {
    this.startTime = Date.now();
  }

  static getInstance(): RuntimeMetrics {
    if (!RuntimeMetrics.instance) {
      RuntimeMetrics.instance = new RuntimeMetrics();
    }
    return RuntimeMetrics.instance;
  }

  // ── increment ───────────────────────────────────────

  /** 弹窗清除 +1 */
  popupDismissed(n = 1): void {
    this.metrics.popupDismiss += n;
  }

  /** Session 恢复尝试 +1 */
  sessionRecovered(): void {
    this.metrics.sessionRecover++;
  }

  /** Session 恢复成功 */
  sessionRecoverSucceed(): void {
    this.metrics.sessionRecoverSuccess++;
  }

  /** Session 恢复失败 */
  sessionRecoverFailed(): void {
    this.metrics.sessionRecoverFail++;
  }

  /** 导航修复 +1 */
  navigationFixed(n = 1): void {
    this.metrics.navigationFix += n;
  }

  /** 任务成功（运单级别） +n */
  taskSucceeded(n = 1): void {
    this.metrics.taskSuccess += n;
  }

  /** 任务失败（运单级别） +n */
  taskFailed(n = 1): void {
    this.metrics.taskFail += n;
  }

  // ── snapshot ────────────────────────────────────────

  snapshot(): RuntimeMetricsSnapshot {
    return {
      popupDismissCount: this.metrics.popupDismiss,
      sessionRecoverCount: this.metrics.sessionRecover,
      sessionRecoverSuccessCount: this.metrics.sessionRecoverSuccess,
      sessionRecoverFailCount: this.metrics.sessionRecoverFail,
      navigationFixCount: this.metrics.navigationFix,
      taskSuccessCount: this.metrics.taskSuccess,
      taskFailCount: this.metrics.taskFail,
      startTime: new Date(this.startTime).toISOString(),
      snapshotTime: new Date().toISOString(),
      uptimeMs: Date.now() - this.startTime,
    };
  }

  // ── reset ───────────────────────────────────────────

  reset(): void {
    this.metrics = {
      popupDismiss: 0,
      sessionRecover: 0,
      sessionRecoverSuccess: 0,
      sessionRecoverFail: 0,
      navigationFix: 0,
      taskSuccess: 0,
      taskFail: 0,
    };
    this.startTime = Date.now();
  }
}
