import * as path from 'node:path';
import type { AxiosInstance } from 'axios';
import { getLocalRoot } from '../config';
import {
  pullWindowCommands,
  markWindowCommandRunning,
  completeWindowCommand,
  failWindowCommand,
  type WindowCommand,
} from '../httpClient';
import {
  executeOpenWindow,
  executeCloseWindow,
  executeRestartWindow,
  executeRefreshStatus,
  type LocalWindowConfig,
} from '../local-runtime/LocalWindowRuntime';
import { getWindowBusy } from '../local-runtime/WindowBusyRegistry';
import { collectWindowStatus } from '../local-runtime/WindowStatusCollector';
import { deriveWindowState } from '../local-runtime/WindowStateMachine';
import { acquireLaunchSlot } from '../local-runtime/WindowLaunchSemaphore';
import type { WindowStatusReportEntry } from '../types';
import { logTrace, warnTrace } from '../trace';
import type { AgentWsClient } from '../ws/AgentWsClient';
import type { StatusPublisherController } from './StatusPublisher';

interface WindowCommandLoopOptions {
  client: AxiosInstance;
  isShuttingDown: () => boolean;
  statusPublisher: StatusPublisherController;
  getWsClient: () => AgentWsClient | null;
}

export interface WindowCommandLoopController {
  start: () => void;
  stop: () => void;
  pullOnce: () => Promise<void>;
  setFastPolling: (fast: boolean) => void;
  isFastPolling: () => boolean;
}

export function createWindowCommandLoop(options: WindowCommandLoopOptions): WindowCommandLoopController {
  let commandPollFast = true;
  const COMMAND_POLL_FAST_MS = 1000;
  const COMMAND_POLL_SLOW_MS = 30_000;
  let commandTimer: ReturnType<typeof setTimeout> | null = null;

  const getCommandPollMs = () => commandPollFast ? COMMAND_POLL_FAST_MS : COMMAND_POLL_SLOW_MS;

  const publishSingle = async (entry: WindowStatusReportEntry) => {
    const t0 = Date.now();
    logTrace('agent-main', 'window_status_publish_start', {
      commandId: entry.commandId,
      windowId: entry.windowId, siteId: entry.siteId, staffName: entry.staffName,
      status: entry.status, statusText: entry.statusText,
    });
    // M5-2A: record status hint BEFORE publish so collectAndReport knows the latest state
    options.statusPublisher.recordStatusHint(entry.windowId, entry.status);
    await options.statusPublisher.publish([entry]).catch(() => {});
    logTrace('agent-main', 'window_status_publish_done', {
      commandId: entry.commandId,
      windowId: entry.windowId, status: entry.status,
      durationMs: Date.now() - t0,
    });
  };

  const pullOnce = async () => {
    if (options.isShuttingDown()) return;

    try {
      const pullStartedAt = Date.now();
      const commands = await pullWindowCommands(options.client, 5);
      logTrace('agent-main', 'window_command_pull_done', {
        commandCount: commands.length,
        durationMs: Date.now() - pullStartedAt,
      });
      if (commands.length === 0) return;

      console.log(`[Agent] 拉取到 ${commands.length} 条窗口命令，并行执行`);

      // P12-Fix: 所有窗口命令并行执行，不再串行等待
      // 每个命令有独立的 windowId/profile/port，互不冲突
      await Promise.allSettled(
        commands.map((cmd) => processOneCommand(cmd, options, publishSingle)),
      );
    } catch {
      // Silent failure, does not affect business task execution
    }
  };

  const scheduleNextCommandPoll = () => {
    if (options.isShuttingDown()) return;
    commandTimer = setTimeout(async () => {
      await pullOnce().catch(() => {});
      scheduleNextCommandPoll();
    }, getCommandPollMs());
  };

  return {
    start: () => {
      pullOnce().catch(() => {});
      scheduleNextCommandPoll();
      console.log(`窗口命令轮询已启动，WS 在线时 ${COMMAND_POLL_SLOW_MS / 1000}s，离线时 ${COMMAND_POLL_FAST_MS / 1000}s`);
    },
    stop: () => {
      if (commandTimer) clearTimeout(commandTimer);
      commandTimer = null;
    },
    pullOnce,
    setFastPolling: (fast) => {
      commandPollFast = fast;
    },
    isFastPolling: () => commandPollFast,
  };
}

// P12: 将每条命令的处理提取为独立函数，支持并行执行
async function processOneCommand(
  cmd: WindowCommand,
  options: WindowCommandLoopOptions,
  publishSingle: (entry: WindowStatusReportEntry) => Promise<void>,
): Promise<void> {
  if (options.isShuttingDown()) return;

  const windowConfig: LocalWindowConfig = {
    tenantId: cmd.tenantId,
    siteId: cmd.siteId,
    workstationId: cmd.workstationId,
    windowId: cmd.windowId,
    staffName: cmd.staffName,
    commandId: cmd.commandId,
  };

  const busyEntry = getWindowBusy(cmd.windowId);
  if ((cmd.type === 'close_window' || cmd.type === 'restart_window') && busyEntry) {
    console.warn(`[Agent] 窗口 ${cmd.windowId} 正在执行任务 ${busyEntry.taskId}，拒绝 ${cmd.type} 命令`);
    await failWindowCommand(options.client, cmd.commandId, `当前窗口正在执行任务，不能关闭 (${busyEntry.taskType})`).catch(() => {});
    return;
  }

  try {
    console.log(`[Agent] 执行窗口命令: ${cmd.type} windowId=${cmd.windowId}`);
    logTrace('agent-main', 'window_command_received', {
      commandId: cmd.commandId, type: cmd.type,
      siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
    });
    options.getWsClient()?.send({ type: 'command_ack', commandId: cmd.commandId });
    await markWindowCommandRunning(options.client, cmd.commandId).catch((err) => {
      warnTrace('agent-main', 'window_command_mark_running_failed', {
        commandId: cmd.commandId, error: (err as Error).message,
      });
    });
    options.getWsClient()?.send({ type: 'command_running', commandId: cmd.commandId });
    logTrace('agent-main', 'window_command_execute_start', {
      commandId: cmd.commandId, type: cmd.type,
      siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
    });

    let result: { success: boolean; cdpEndpoint?: string; profilePath?: string; chromePid?: number; debugPort?: number; error?: string; loginRequired?: boolean; isDashboardReady?: boolean };

    switch (cmd.type) {
      case 'open_window': {
        const openDebugPort = computeDebugPortFromWindowId(cmd.windowId);
        const openProfilePath = computeProfilePathForConfig({
          tenantId: cmd.tenantId, siteId: cmd.siteId, windowId: cmd.windowId,
        });
        options.statusPublisher.upsertTrackedWindow({
          siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
          profilePath: openProfilePath, debugPort: openDebugPort,
        });
        await publishSingle({
          siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
          commandId: cmd.commandId,
          status: 'opening', statusText: '启动中',
          isProcessAlive: false, isCdpReady: false,
          isDashboardReady: false, isLoginPage: false,
          lastError: null, cdpEndpoint: null,
          profilePath: openProfilePath, chromePid: null,
        });

        // M5-2A: Chrome 冷启动限流 — acquire launch slot before executeOpenWindow
        const releaseSlot = await acquireLaunchSlot(cmd.windowId);
        try {
          result = await executeOpenWindow(windowConfig, (phase, detail) => {
            const phaseState = deriveWindowState({ phase, phaseDetail: detail });
            publishSingle({
              siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
              commandId: cmd.commandId,
              status: phaseState.reportStatus, statusText: phaseState.statusText,
              isProcessAlive: phase !== 'starting',
              isCdpReady: phase !== 'starting',
              isDashboardReady: phase === 'ready',
              isLoginPage: phase === 'login_required' || phase === 'logging_in',
              lastError: phase === 'error' ? detail : null,
              cdpEndpoint: null, profilePath: null, chromePid: null,
            }).catch(() => {});
          });
        } finally {
          releaseSlot();
        }

        if (result.success && result.cdpEndpoint && result.profilePath) {
          options.statusPublisher.upsertTrackedWindow({
            siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
            profilePath: result.profilePath,
            debugPort: result.debugPort || openDebugPort,
            pid: result.chromePid ?? null,
            cdpEndpoint: result.cdpEndpoint ?? null,
          });

          try {
            const status = await collectWindowStatus({
              debugPort: result.debugPort || openDebugPort,
              profilePath: result.profilePath,
              pid: result.chromePid ?? undefined,
            });
            const derived = deriveWindowState({ status });
            const forceLogin = result.loginRequired === true;
            // M5-2C: respect executeOpenWindow's confirmed ready state — don't let
            // a transient collectWindowStatus result (ReadyGuard WS timeout) downgrade it.
            const finalReportStatus = result.isDashboardReady
              ? 'ready'
              : forceLogin ? 'login_required' : derived.reportStatus;
            const finalStatusText = result.isDashboardReady
              ? '就绪'
              : forceLogin ? '待登录' : derived.statusText;
            await publishSingle({
              siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
              commandId: cmd.commandId,
              status: finalReportStatus, statusText: finalStatusText,
              currentUrl: status.currentUrl || undefined,
              isProcessAlive: status.isProcessAlive,
              isCdpReady: status.isCdpReady,
              isDashboardReady: result.isDashboardReady === true,
              isLoginPage: forceLogin ? true : status.isLoginPage,
              lastError: status.lastError,
              cdpEndpoint: result.cdpEndpoint,
              profilePath: result.profilePath,
              chromePid: result.chromePid,
            });
          } catch { /* ignore */ }
        }
        break;
      }

      case 'close_window':
        // M5-2D: publish closing state before attempting close, so frontend sees transition
        await publishSingle({
          siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
          status: 'closing', statusText: '关闭中',
          isProcessAlive: true, isCdpReady: true,
          isDashboardReady: false, isLoginPage: false,
          lastError: null, cdpEndpoint: null,
          profilePath: '', chromePid: null,
        });
        result = await executeCloseWindow(windowConfig, false);
        if (result.success) {
          options.statusPublisher.removeTrackedWindow(cmd.windowId);
          await publishSingle({
            siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
            status: 'offline', statusText: '离线',
            isProcessAlive: false, isCdpReady: false,
            isDashboardReady: false, isLoginPage: false,
            lastError: null, cdpEndpoint: null,
            profilePath: result.profilePath, chromePid: null,
          });
        }
        break;

      case 'restart_window':
        // M5-2A: Chrome 冷启动限流 — restart involves close + open
        const restartReleaseSlot = await acquireLaunchSlot(cmd.windowId);
        try {
          result = await executeRestartWindow(windowConfig, false);
        } finally {
          restartReleaseSlot();
        }
        break;

      case 'refresh_status': {
        const refreshResult = await executeRefreshStatus(windowConfig);
        result = {
          success: refreshResult.success,
          cdpEndpoint: refreshResult.cdpEndpoint,
          profilePath: refreshResult.profilePath,
          debugPort: refreshResult.debugPort,
          error: refreshResult.error,
        };
        try {
          const st = refreshResult.statusResult;
          const derived = deriveWindowState({ status: st });
          await publishSingle({
            siteId: cmd.siteId, windowId: cmd.windowId, staffName: cmd.staffName,
            status: derived.reportStatus, statusText: derived.statusText,
            currentUrl: st.currentUrl || undefined,
            isProcessAlive: st.isProcessAlive, isCdpReady: st.isCdpReady,
            isDashboardReady: st.isDashboardReady, isLoginPage: st.isLoginPage,
            lastError: st.lastError, cdpEndpoint: st.cdpEndpoint,
            profilePath: refreshResult.profilePath,
            chromePid: st.chromePid || undefined,
          });
        } catch { /* ignore */ }
        break;
      }

      default:
        await failWindowCommand(options.client, cmd.commandId, `不支持的命令类型: ${cmd.type}`).catch(() => {});
        return;
    }

    if (result.success) {
      await completeWindowCommand(options.client, cmd.commandId, {
        cdpEndpoint: result.cdpEndpoint,
        profilePath: result.profilePath,
        chromePid: result.chromePid,
        debugPort: result.debugPort,
        loginRequired: result.loginRequired === true,
        isDashboardReady: result.isDashboardReady === true,
      }).catch(() => {});
      logTrace('agent-main', 'window_command_execute_done', {
        commandId: cmd.commandId, type: cmd.type,
        siteId: cmd.siteId, windowId: cmd.windowId, success: true,
      });
    } else {
      await failWindowCommand(options.client, cmd.commandId, result.error || '命令执行失败').catch(() => {});
      warnTrace('agent-main', 'window_command_execute_done', {
        commandId: cmd.commandId, type: cmd.type,
        siteId: cmd.siteId, windowId: cmd.windowId,
        success: false, error: result.error || '命令执行失败',
      });
    }
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[Agent] 窗口命令 ${cmd.type} 异常:`, msg);
    await failWindowCommand(options.client, cmd.commandId, msg).catch(() => {});
    warnTrace('agent-main', 'window_command_execute_failed', {
      commandId: cmd.commandId, type: cmd.type,
      siteId: cmd.siteId, windowId: cmd.windowId, error: msg,
    });
  }
}

function computeDebugPortFromWindowId(windowId: string): number {
  const basePort = 31000;
  let hash = 0;
  for (let i = 0; i < windowId.length; i++) {
    hash = ((hash << 5) - hash) + windowId.charCodeAt(i);
    hash |= 0;
  }
  return basePort + (Math.abs(hash) % 100);
}

function computeProfilePathForConfig(cfg: { tenantId: string; siteId: string; windowId: string }): string {
  const localRoot = getLocalRoot();
  return path.resolve(localRoot, 'profiles', cfg.tenantId, cfg.siteId, cfg.windowId);
}
