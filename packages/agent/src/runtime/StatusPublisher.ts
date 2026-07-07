import type { AxiosInstance } from 'axios';
import type { WindowStatusReportEntry } from '../types';
import { reportWindowStatus } from '../httpClient';
import { getWindowBusy } from '../local-runtime/WindowBusyRegistry';
import { collectWindowStatus } from '../local-runtime/WindowStatusCollector';
import { deriveWindowState } from '../local-runtime/WindowStateMachine';

// M5-2A: 中间状态保护 — collectAndReport 不得将这些状态覆盖为 offline
const INTERMEDIATE_STATUSES = new Set<string>([
  'opening', 'process_started', 'cdp_connecting', 'cdp_connected',
  'login_checking', 'p0_checking', 'popup_cleaning', 'ready_checking',
  'restarting', 'closing',
]);

// M5-2A: 中间状态超时保护 — 超过 120 秒未推进 → 允许降级为 failed
const INTERMEDIATE_STATUS_TIMEOUT_MS = 120_000;

// M5-2C: ready 防误降级 — 一次 ReadyGuard timeout/健康检查失败不应将 ready 降级
// 连续失败次数阈值，超过后才允许降级为 failed
const READY_DEGRADE_FAIL_COUNT = 3;
// 降级允许的状态：这些状态可能由 transient 故障（ReadyGuard timeout/CDP WS timeout）产生
const READY_DEGRADING_STATUSES = new Set<string>([
  'ready_checking', 'offline',
]);

export interface ActiveWindowRecord {
  siteId: string;
  windowId: string;
  staffName: string;
  profilePath: string;
  debugPort: number;
  pid?: number | null;
  cdpEndpoint?: string | null;
  // M5-2A: track last reported status to prevent collectAndReport drift
  lastReportedStatus?: string;
  lastReportedStatusAt?: number;
}

interface StatusPublisherOptions {
  client: AxiosInstance;
  isShuttingDown: () => boolean;
  reportIntervalMs?: number;
}

export interface StatusPublisherController {
  start: () => void;
  stop: () => void;
  publish: (siteWindows: WindowStatusReportEntry[]) => Promise<void>;
  collectAndReport: () => Promise<void>;
  upsertTrackedWindow: (window: ActiveWindowRecord) => void;
  removeTrackedWindow: (windowId: string) => void;
  getTrackedWindow: (windowId: string) => ActiveWindowRecord | undefined;
  /** M5-2A: record a status hint from publishSingle to prevent collectAndReport from overwriting intermediate states */
  recordStatusHint: (windowId: string, status: string) => void;
}

export function createStatusPublisher(options: StatusPublisherOptions): StatusPublisherController {
  const reportIntervalMs = options.reportIntervalMs ?? 5000;
  const activeWindows = new Map<string, ActiveWindowRecord>();
  let reportTimer: ReturnType<typeof setInterval> | null = null;

  const publish = async (siteWindows: WindowStatusReportEntry[]) => {
    if (siteWindows.length === 0) return;
    // M5-2C: sync lastReportedStatus to local ActiveWindowRecord so
    // collectAndReport's ready anti-degradation can detect the current state.
    for (const sw of siteWindows) {
      const win = activeWindows.get(sw.windowId);
      if (win && sw.status) {
        win.lastReportedStatus = sw.status;
        win.lastReportedStatusAt = Date.now();
      }
    }
    await reportWindowStatus(options.client, siteWindows);
  };

  // M5-2A: track status hints from publishSingle to protect intermediate states
  const statusHints = new Map<string, { status: string; at: number }>();

  // M5-2C: track consecutive health failures for ready windows to prevent false downgrades
  const readyFailCount = new Map<string, number>();

  const collectAndReport = async () => {
    try {
      const siteWindows: WindowStatusReportEntry[] = [];

      for (const [, win] of activeWindows) {
        try {
          const status = await collectWindowStatus({ debugPort: win.debugPort, profilePath: win.profilePath, pid: win.pid ?? undefined });
          const busyEntry = getWindowBusy(win.windowId);
          const derived = deriveWindowState({
            status,
            busyTaskType: busyEntry?.taskType || null,
          });

          // M5-2A: Intermediate status protection — prevent collectAndReport from
          // overwriting publishSingle's recently-set intermediate states with offline.
          const hint = statusHints.get(win.windowId);
          const now = Date.now();
          const hintAge = hint ? now - hint.at : Infinity;
          const isHintIntermediate = hint && INTERMEDIATE_STATUSES.has(hint.status);
          const hintTimedOut = hintAge > INTERMEDIATE_STATUS_TIMEOUT_MS;

          let effectiveStatus: WindowStatusReportEntry['status'];
          let effectiveStatusText: string;

          if (isHintIntermediate && !hintTimedOut && derived.reportStatus === 'offline') {
            // Protected: intermediate status is still valid, keep it instead of offline
            effectiveStatus = hint.status as WindowStatusReportEntry['status'];
            effectiveStatusText = `[PROTECTED] ${hint.status}`;
            console.log(
              `[StatusPublisher] 中间状态保护: windowId=${win.windowId} status=${hint.status}` +
              ` (collectAndReport would have set offline, hintAge=${(hintAge / 1000).toFixed(1)}s)`,
            );
          } else if (isHintIntermediate && hintTimedOut) {
            // Intermediate status timed out → escalate to failed
            effectiveStatus = 'failed';
            effectiveStatusText = `超时(${hint.status})`;
            console.warn(
              `[StatusPublisher] 中间状态超时: windowId=${win.windowId} status=${hint.status}` +
              ` hintAge=${(hintAge / 1000).toFixed(1)}s → failed`,
            );
          } else {
            // Normal path: use derived state
            effectiveStatus = derived.reportStatus;
            effectiveStatusText = derived.statusText;
          }

          // M5-2C: ready anti-degradation — don't let a single ReadyGuard/health-check
          // transient failure downgrade a ready window to ready_checking/offline.
          const lastReportedStatus = win.lastReportedStatus;
          const isCurrentlyReady = lastReportedStatus === 'ready' || effectiveStatus === 'ready';
          const isDegradingFromReady =
            lastReportedStatus === 'ready' &&
            READY_DEGRADING_STATUSES.has(effectiveStatus);

          if (isDegradingFromReady) {
            const fails = (readyFailCount.get(win.windowId) ?? 0) + 1;
            readyFailCount.set(win.windowId, fails);

            if (fails < READY_DEGRADE_FAIL_COUNT) {
              // Keep ready, log warning
              effectiveStatus = 'ready';
              effectiveStatusText = `[READY-GUARD] transient ${derived.reportStatus} (${fails}/${READY_DEGRADE_FAIL_COUNT})`;
              console.warn(
                `[StatusPublisher] ready防误降级: windowId=${win.windowId} ` +
                `derived=${derived.reportStatus} failCount=${fails}/${READY_DEGRADE_FAIL_COUNT} → 保持ready`,
              );
            } else {
              // Threshold exceeded → allow degradation
              console.warn(
                `[StatusPublisher] ready防误降级: windowId=${win.windowId} ` +
                `failCount=${fails}/${READY_DEGRADE_FAIL_COUNT} → 允许降级为 ${effectiveStatus}`,
              );
            }
          } else if (effectiveStatus === 'ready') {
            // Reset fail count when window returns to ready
            readyFailCount.set(win.windowId, 0);
          } else if (!isCurrentlyReady) {
            // Window is not ready → reset fail count
            readyFailCount.delete(win.windowId);
          }

          if (!status.isProcessAlive && effectiveStatus !== 'opening' && effectiveStatus !== 'process_started') {
            // Process is dead and we're not in a transitional state → skip reporting
            // to avoid broadcasting a potentially-stale "offline" for a window
            // that just hasn't been registered yet.
            // But DO report if status was explicitly set to opening/process_started
            // (process hasn't forked yet, isProcessAlive=false is expected).
            continue;
          }

          siteWindows.push({
            siteId: win.siteId,
            windowId: win.windowId,
            staffName: win.staffName,
            status: effectiveStatus,
            statusText: effectiveStatusText,
            currentUrl: status.currentUrl || undefined,
            isProcessAlive: status.isProcessAlive,
            isCdpReady: status.isCdpReady,
            isDashboardReady: status.isDashboardReady,
            isLoginPage: status.isLoginPage,
            lastError: status.lastError,
            cdpEndpoint: status.cdpEndpoint,
            profilePath: win.profilePath,
            chromePid: status.chromePid || undefined,
          });
        } catch (err) {
          console.warn(`[Agent] 窗口 ${win.windowId} 状态采集失败:`, (err as Error).message);
        }
      }

      await publish(siteWindows);
    } catch {
      // Silent failure, does not affect business
    }
  };

  return {
    start: () => {
      collectAndReport().catch(() => {});
      reportTimer = setInterval(() => {
        if (options.isShuttingDown()) return;
        collectAndReport().catch(() => {});
      }, reportIntervalMs);
      console.log(`窗口状态上报已启动，每 ${reportIntervalMs / 1000} 秒上报`);
    },
    stop: () => {
      if (reportTimer) clearInterval(reportTimer);
      reportTimer = null;
    },
    publish,
    collectAndReport,
    upsertTrackedWindow: (window) => {
      activeWindows.set(window.windowId, window);
    },
    removeTrackedWindow: (windowId) => {
      activeWindows.delete(windowId);
    },
    getTrackedWindow: (windowId) => activeWindows.get(windowId),
    recordStatusHint: (windowId, status) => {
      statusHints.set(windowId, { status, at: Date.now() });
    },
  };
}
