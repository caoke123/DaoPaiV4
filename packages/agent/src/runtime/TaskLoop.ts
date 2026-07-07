import type { AxiosInstance } from 'axios';
import type { AgentConfig } from '../types';
import { failTask, pullTask } from '../httpClient';
import { logTrace, warnTrace } from '../trace';
import { safeLog } from '../logger';

type TaskLoopTrigger = 'timer' | 'ws' | 'heartbeat' | 'reconnect';

interface PulledTask {
  taskId: string;
  type: string;
  siteId: string;
  payload: Record<string, unknown>;
}

interface TaskLoopOptions {
  client: AxiosInstance;
  config: AgentConfig;
  isShuttingDown: () => boolean;
  executeTask: (task: PulledTask) => Promise<void>;
}

export interface TaskLoopController {
  start: () => Promise<void>;
  stop: () => void;
  requestImmediatePoll: (reason: string) => void;
  getRunningTaskId: () => string | null;
}

export function createTaskLoop(options: TaskLoopOptions): TaskLoopController {
  let taskTimer: ReturnType<typeof setTimeout> | null = null;
  let taskLoopInFlight = false;
  let pendingImmediateTaskPoll = false;
  let runningTaskId: string | null = null;

  const scheduleNextTaskPoll = (delayMs: number) => {
    if (options.isShuttingDown()) return;
    if (taskTimer) clearTimeout(taskTimer);
    taskTimer = setTimeout(() => {
      taskTimer = null;
      runTaskLoop('timer').catch(() => {});
    }, Math.max(0, delayMs));
  };

  const requestImmediatePoll = (reason: string) => {
    logTrace('agent-main', 'task_poll_requested', {
      reason,
      runningTaskId: runningTaskId || undefined,
      taskLoopInFlight,
    });
    if (taskLoopInFlight || runningTaskId) {
      pendingImmediateTaskPoll = true;
      logTrace('agent-main', 'task_poll_queued', {
        reason,
        runningTaskId: runningTaskId || undefined,
        taskLoopInFlight,
      });
      return;
    }
    scheduleNextTaskPoll(0);
  };

  const runTaskLoop = async (trigger: TaskLoopTrigger) => {
    if (options.isShuttingDown()) return;
    if (taskLoopInFlight) {
      logTrace('agent-main', 'task_loop_skip_inflight', { trigger });
      return;
    }
    if (runningTaskId) {
      logTrace('agent-main', 'task_loop_skip_busy', {
        trigger,
        runningTaskId,
      });
      scheduleNextTaskPoll(options.config.taskPollIntervalMs);
      return;
    }

    taskLoopInFlight = true;
    let nextDelayMs = options.config.taskPollIntervalMs;

    try {
      const pullStart = Date.now();
      const pullResp = await pullTask(options.client);
      console.log(`[Agent] pullTask 耗时 ${Date.now() - pullStart}ms, hasTask=${pullResp.hasTask}`);
      logTrace('agent-main', 'task_pull_done', {
        trigger,
        hasTask: pullResp.hasTask,
        nextPollAfterMs: pullResp.nextPollAfterMs,
        durationMs: Date.now() - pullStart,
      });

      nextDelayMs = Math.max(500, pullResp.nextPollAfterMs || options.config.taskPollIntervalMs);
      if (pullResp.hasTask && pullResp.task) {
        const task = pullResp.task as PulledTask;
        const assignments = Array.isArray((task.payload as any)?.assignments) ? (task.payload as any).assignments : [];
        console.log(`[Agent] T3 拉到任务: taskId=${task.taskId} type=${task.type} siteId=${task.siteId}`);
        console.log(`[Agent] pulled task: id=${task.taskId}, type=${task.type}, assignments=${assignments.length}`);
        logTrace('agent-main', 'task_received', {
          taskId: task.taskId,
          taskType: task.type,
          siteId: task.siteId,
          assignmentCount: assignments.length,
        });

        runningTaskId = task.taskId;
        logTrace('agent-main', 'task_execute_start', {
          taskId: task.taskId,
          taskType: task.type,
          siteId: task.siteId,
        });
        try {
          await options.executeTask(task);
          logTrace('agent-main', 'task_execute_done', {
            taskId: task.taskId,
            taskType: task.type,
          });
        } finally {
          runningTaskId = null;
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      safeLog('warn', `任务拉取失败：${msg}`, options.config.agentToken);
      warnTrace('agent-main', 'task_pull_or_execute_failed', {
        trigger,
        runningTaskId: runningTaskId || undefined,
        error: msg,
      });
      if (runningTaskId) {
        await failTask(options.client, runningTaskId, msg).catch(() => {});
      }
      runningTaskId = null;
      nextDelayMs = options.config.taskPollIntervalMs;
    } finally {
      taskLoopInFlight = false;
      if (pendingImmediateTaskPoll && !runningTaskId) {
        pendingImmediateTaskPoll = false;
        scheduleNextTaskPoll(0);
      } else {
        scheduleNextTaskPoll(nextDelayMs);
      }
    }
  };

  return {
    start: async () => {
      await runTaskLoop('timer');
    },
    stop: () => {
      if (taskTimer) clearTimeout(taskTimer);
      taskTimer = null;
    },
    requestImmediatePoll,
    getRunningTaskId: () => runningTaskId,
  };
}
