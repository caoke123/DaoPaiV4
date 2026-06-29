import type { Browser, Page } from 'playwright';

export interface LivenessResult {
  alive: boolean;
  tier: 'healthy' | 'degraded' | 'dead';
  browserConnected: boolean;
  pageUrl: string | null;
  hasSidebar: boolean | null;
  isLoginPage: boolean;
  error: string | null;
}

export interface HealthCheckTarget {
  windowId: string;
  browser: Browser;
  page: Page;
  windowName: string;
}

export interface HealthMonitorCallbacks {
  getTargets(): HealthCheckTarget[];
  shouldSkipCycle(): boolean;
  onHealthy(windowId: string, isLoginPage: boolean): void;
  onDegraded(windowId: string, degradedCount: number, error: string): void;
  onDegradedReconnect(windowId: string): void;
  onDead(windowId: string, error: string): void;
  afterCheckCycle(): Promise<void>;
}

export class HealthMonitor {
  private degradedCounts: Map<string, number> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private static readonly DEGRADED_RECONNECT_THRESHOLD = 3;
  private readonly targetDomain: string;

  constructor(callbacks: HealthMonitorCallbacks, targetDomain: string) {
    this.cb = callbacks;
    this.targetDomain = targetDomain;
  }

  private cb: HealthMonitorCallbacks;

  async checkLiveness(target: HealthCheckTarget): Promise<LivenessResult> {
    const attempt = async (): Promise<LivenessResult> => {
      const result: LivenessResult = {
        alive: false,
        tier: 'dead',
        browserConnected: false,
        pageUrl: null,
        hasSidebar: null,
        isLoginPage: false,
        error: null,
      };
      try {
        result.browserConnected = target.browser.isConnected();
        if (!result.browserConnected) {
          result.tier = 'dead';
          result.error = 'browser.isConnected() = false (CDP 断开)';
          return result;
        }
        result.pageUrl = target.page.url();
        const urlOk = result.pageUrl.includes(this.targetDomain);
        if (!urlOk) {
          result.tier = 'degraded';
          result.error = `URL 不在目标域名: ${result.pageUrl}`;
          return result;
        }
        if (result.pageUrl.includes('/login') || result.pageUrl.includes('Login')) {
          result.isLoginPage = true;
          result.alive = true;
          result.tier = 'healthy';
          return result;
        }
        result.hasSidebar = await Promise.race([
          target.page.evaluate(() => !!document.querySelector('.el-menu, .app-container, .sidebar')),
          new Promise<null>((_, reject) => setTimeout(() => reject(new Error('DOM 检查超时')), 3000)),
        ]).catch(() => null);
        if (!result.hasSidebar) {
          result.tier = 'degraded';
          result.error = 'DOM 校验失败：侧边栏不存在或超时';
          return result;
        }
        result.alive = true;
        result.tier = 'healthy';
      } catch (e) {
        result.tier = 'dead';
        result.error = (e as Error).message;
      }
      return result;
    };

    const r1 = await attempt();
    if (r1.tier === 'healthy') return r1;
    if (r1.tier === 'degraded') return r1;

    const firstError = r1.error;
    await new Promise(resolve => setTimeout(resolve, 400));
    const r2 = await attempt();
    if (r2.tier === 'healthy') {
      console.log(`[HealthMonitor] checkLiveness 首次 dead 但重试 alive: ${target.windowName}`);
      return r2;
    }
    r2.error = `两次检查均 dead。首次: ${firstError}; 二次: ${r2.error}`;
    return r2;
  }

  getDegradedCount(windowId: string): number {
    return this.degradedCounts.get(windowId) ?? 0;
  }

  isWindowDegraded(windowId: string): boolean {
    return this.degradedCounts.has(windowId);
  }

  clearDegraded(windowId: string): void {
    this.degradedCounts.delete(windowId);
  }

  clearAllDegraded(): void {
    this.degradedCounts.clear();
  }

  resetDegraded(windowId: string): void {
    this.degradedCounts.delete(windowId);
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.stopped = false;
    console.log(`[HealthMonitor] 启动周期健康巡检 (间隔 ${intervalMs / 1000}s)`);
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.checkCycle().catch((e) => {
        console.warn('[HealthMonitor] checkCycle 失败:', (e as Error).message);
      });
    }, intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[HealthMonitor] 周期健康巡检已停止');
  }

  private async checkCycle(): Promise<void> {
    if (this.cb.shouldSkipCycle()) return;

    const targets = this.cb.getTargets();
    for (const target of targets) {
      if (this.stopped) return;
      const liveness = await this.checkLiveness(target);
      const { windowId } = target;

      if (liveness.tier === 'healthy') {
        this.degradedCounts.delete(windowId);
        this.cb.onHealthy(windowId, liveness.isLoginPage);
      } else if (liveness.tier === 'degraded') {
        const count = (this.degradedCounts.get(windowId) || 0) + 1;
        this.degradedCounts.set(windowId, count);
        console.warn(`[HealthMonitor] ⚠ 窗口 "${target.windowName}" 状态降级 (${count}/${HealthMonitor.DEGRADED_RECONNECT_THRESHOLD}): ${liveness.error}`);
        this.cb.onDegraded(windowId, count, liveness.error || '');

        if (count >= HealthMonitor.DEGRADED_RECONNECT_THRESHOLD) {
          console.warn(`[HealthMonitor] 🔄 窗口 "${target.windowName}" 连续 ${count} 次降级，触发轻量级重连`);
          this.degradedCounts.delete(windowId);
          this.cb.onDegradedReconnect(windowId);
        }
      } else {
        const ts = new Date().toISOString();
        console.log(`[${ts}][HealthMonitor] 🔴 窗口 "${target.windowName}" 存活检查失败 (真死亡): ${liveness.error}`);
        this.degradedCounts.delete(windowId);
        this.cb.onDead(windowId, liveness.error || '');
      }
    }

    await this.cb.afterCheckCycle();
  }
}
