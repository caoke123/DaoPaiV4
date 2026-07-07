import type { AxiosInstance } from 'axios';
import type { AgentConfig, ChromeKind } from '../types';
import { logger, safeLog } from '../logger';
import { startupCheck } from '../startupCheck';
import {
  createHttpClient,
  getAgentMe,
  sendHeartbeat,
  runTaskWithBackendEngine,
  reportProgress,
  uploadLogs,
  completeTask,
  failTask,
} from '../httpClient';
import { AgentSettingsLoader } from '../AgentSettingsLoader';
import { executeArrivalDryRun } from '../executors/ArrivalExecutor';
import { executeDispatchDryRun } from '../executors/DispatchExecutor';
import { executeSignDryRun } from '../executors/SignExecutor';
import { executeIntegratedDryRun } from '../executors/IntegratedExecutor';
import { AgentWsClient } from '../ws/AgentWsClient';
import { logTrace, warnTrace } from '../trace';
import { createTaskLoop, type TaskLoopController } from './TaskLoop';
import { createStatusPublisher, type StatusPublisherController } from './StatusPublisher';
import { createWindowCommandLoop, type WindowCommandLoopController } from './WindowCommandLoop';

export interface AgentDaemonOptions {
  config: AgentConfig;
  agentVersion: string;
  /** M5-0: 版本指纹 */
  gitCommit?: string;
  buildId?: string;
  startedAt?: string;
  chromeKind?: ChromeKind;
}

interface BusinessTask {
  taskId: string;
  type: string;
  siteId: string;
  payload: Record<string, unknown>;
  taskType?: string;
}

export class AgentDaemon {
  private readonly config: AgentConfig;
  private readonly agentVersion: string;
  private readonly versionFingerprint: {
    gitCommit: string;
    buildId: string;
    startedAt: string;
    chromeKind: string;
  };
  private readonly client: AxiosInstance;
  private readonly settingsLoader: AgentSettingsLoader;

  private shuttingDown = false;
  private started = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollModeTimer: ReturnType<typeof setInterval> | null = null;
  private taskLoop: TaskLoopController | null = null;
  private statusPublisher: StatusPublisherController | null = null;
  private commandLoop: WindowCommandLoopController | null = null;
  private wsClient: AgentWsClient | null = null;

  constructor(options: AgentDaemonOptions) {
    this.config = options.config;
    this.agentVersion = options.agentVersion;
    this.versionFingerprint = {
      gitCommit: options.gitCommit || 'unknown',
      buildId: options.buildId || 'unknown',
      startedAt: options.startedAt || 'unknown',
      chromeKind: options.chromeKind || 'unknown',
    };
    this.client = createHttpClient(options.config);
    this.settingsLoader = new AgentSettingsLoader(options.config.settingsPath);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    logger.info('DaoPai 本地执行端启动中...');
    logger.info(`Cloud 地址：${this.config.cloudBaseUrl}`);
    logger.info(`执行电脑：${this.config.workstationName}`);

    console.log('正在执行启动检查...\n');
    const startup = await startupCheck(this.config);
    if (!startup.ok) {
      logger.error('启动检查未通过，本地执行端退出');
      throw new Error('启动检查未通过');
    }

    console.log(`settings.json 路径：${this.settingsLoader['settingsPath']}`);
    await this.verifyAgentIdentity();

    console.log('');
    console.log(`心跳循环已启动，每 ${(this.config.heartbeatIntervalMs / 1000).toFixed(0)} 秒上报一次...`);
    console.log(`  heartbeatIntervalMs=${this.config.heartbeatIntervalMs}`);
    console.log(`  taskPollIntervalMs=${this.config.taskPollIntervalMs}`);
    console.log('按 Ctrl+C 停止\n');
    logger.info('心跳循环已启动');

    const executePulledTask = this.createPulledTaskExecutor();
    this.taskLoop = createTaskLoop({
      client: this.client,
      config: this.config,
      isShuttingDown: () => this.shuttingDown,
      executeTask: executePulledTask,
    });

    this.statusPublisher = createStatusPublisher({
      client: this.client,
      isShuttingDown: () => this.shuttingDown,
    });

    this.commandLoop = createWindowCommandLoop({
      client: this.client,
      isShuttingDown: () => this.shuttingDown,
      statusPublisher: this.statusPublisher,
      getWsClient: () => this.wsClient,
    });

    await this.tickHeartbeat();
    await this.taskLoop.start();

    this.heartbeatTimer = setInterval(() => {
      this.tickHeartbeat().catch(() => {});
    }, this.config.heartbeatIntervalMs);

    this.statusPublisher.start();
    this.commandLoop.start();
    this.setupWebSocket();
    this.registerProcessSignals();
    this.started = true;
  }

  stop(options?: { exitProcess?: boolean; exitCode?: number }): void {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    console.log('\n正在停止本地执行端...');

    this.wsClient?.disconnect();
    this.wsClient = null;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollModeTimer) {
      clearInterval(this.pollModeTimer);
      this.pollModeTimer = null;
    }

    this.statusPublisher?.stop();
    this.commandLoop?.stop();
    this.taskLoop?.stop();

    logger.info('本地执行端已停止');

    if (options?.exitProcess) {
      process.exit(options.exitCode ?? 0);
    }
  }

  private async verifyAgentIdentity(): Promise<void> {
    try {
      const me = await getAgentMe(this.client);
      console.log(`执行电脑：${me.name}`);
      console.log(`快递公司：${me.tenantName}`);
      console.log(`所属网点：${me.siteName || '未绑定'}`);
      logger.info(`授权码验证成功，执行电脑：${me.name}`);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`授权码验证失败：${msg}`);
      console.error(`错误：${msg}`);
      throw err;
    }
  }

  private createPulledTaskExecutor(): (task: BusinessTask) => Promise<void> {
    return async (task: BusinessTask) => {
      if (task.type === 'agent_test') {
        await this.executeAgentTestTask(task.taskId, task.payload);
      }
      else if (task.type === 'arrival' || task.type === 'arrive' || task.taskType === 'arrival' || task.taskType === 'arrive') {
        console.log(`[Agent] 收到 Arrival 任务，使用 Agent 本地执行器`);
        console.log(`[Agent] Arrival 本地执行开始，taskId=${task.taskId}`);
        logger.info(`[Agent] 收到 Arrival 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
        await executeArrivalDryRun(task as any, this.client, this.settingsLoader, this.config);
        console.log(`[Agent] Arrival 本地执行结束，taskId=${task.taskId}`);
      }
      else if (task.type === 'dispatch' || task.taskType === 'dispatch') {
        console.log(`[Agent] 收到 Dispatch 任务，使用 Agent 本地执行器`);
        console.log(`[Agent] Dispatch 本地执行开始，taskId=${task.taskId}`);
        logger.info(`[Agent] 收到 Dispatch 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
        await executeDispatchDryRun(task as any, this.client, this.settingsLoader, this.config);
        console.log(`[Agent] Dispatch 本地执行结束，taskId=${task.taskId}`);
      }
      else if (task.type === 'sign' || task.taskType === 'sign') {
        console.log(`[Agent] 收到 Sign 任务，使用 Agent 本地执行器`);
        console.log(`[Agent][Sign] 本地执行开始，taskId=${task.taskId}`);
        logger.info(`[Agent] 收到 Sign 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
        await executeSignDryRun(task as any, this.client, this.settingsLoader, this.config);
        console.log(`[Agent] Sign 本地执行结束，taskId=${task.taskId}`);
      }
      else if (task.type === 'integrated' || task.taskType === 'integrated') {
        console.log(`[Agent] 收到 Integrated 任务，使用 Agent 本地执行器`);
        console.log(`[Agent][Integrated] 本地执行开始，taskId=${task.taskId}`);
        logger.info(`[Agent] 收到 Integrated 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
        await executeIntegratedDryRun(task as any, this.client, this.settingsLoader, this.config);
        console.log(`[Agent] Integrated 本地执行结束，taskId=${task.taskId}`);
      }
      else {
        console.log(`[Agent] 任务类型 ${task.type} 未识别，继续使用 Cloud run-engine 兼容路径`);
        await this.executeBusinessTaskWithBackendEngine(task);
      }
    };
  }

  private async executeAgentTestTask(
    taskId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const durationMs = (payload.durationMs as number) || 3000;
    const message = (payload.message as string) || 'Agent 测试任务';

    console.log(`发现测试任务：${taskId}`);
    console.log(`任务内容：${message}`);
    console.log(`模拟执行时长：${durationMs}ms`);
    logger.info(`开始执行测试任务 ${taskId}`);

    try {
      await uploadLogs(this.client, taskId, [{
        level: 'info',
        message: `开始测试任务：${message}`,
        timestamp: new Date().toISOString(),
      }]);

      await reportProgress(this.client, taskId, 'running', 10);
      console.log('进度：10%');
      logger.info(`任务 ${taskId} 进度：10%`);

      await new Promise(resolve => setTimeout(resolve, durationMs / 2));

      await reportProgress(this.client, taskId, 'running', 50);
      await uploadLogs(this.client, taskId, [{
        level: 'info',
        message: '测试任务执行中...',
        timestamp: new Date().toISOString(),
      }]);
      console.log('进度：50%');
      logger.info(`任务 ${taskId} 进度：50%`);

      await new Promise(resolve => setTimeout(resolve, durationMs / 2));

      await reportProgress(this.client, taskId, 'running', 100);
      console.log('进度：100%');
      logger.info(`任务 ${taskId} 进度：100%`);

      await uploadLogs(this.client, taskId, [{
        level: 'success',
        message: '测试任务完成',
        timestamp: new Date().toISOString(),
      }]);

      await completeTask(this.client, taskId);
      console.log('测试任务完成，已回传 Cloud');
      logger.info(`任务 ${taskId} 已完成`);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`任务 ${taskId} 执行失败：${msg}`);
      console.error(`任务执行失败：${msg}`);

      try {
        await failTask(this.client, taskId, msg);
        logger.info(`任务 ${taskId} 已标记为 failed`);
      } catch {
        logger.error(`任务 ${taskId} 标记失败时出错`);
      }
    }
  }

  private logBusinessTaskPayload(task: BusinessTask): void {
    const payload = task.payload || {};
    const assignments = Array.isArray((payload as any).assignments) ? (payload as any).assignments : [];
    const assignmentsPreview = assignments.map((a: any) => ({
      staffName: a?.staffName,
      siteId: a?.siteId,
      windowId: a?.windowId,
      browserId: a?.browserId,
      runtimeKey: a?.runtimeKey,
      waybillCount: Array.isArray(a?.waybillNos) ? a.waybillNos.length : 0,
    }));
    console.log('[Agent][task payload]', {
      taskId: task.taskId,
      type: task.type,
      siteId: task.siteId,
      hasPayload: !!payload,
      assignmentCount: assignments.length,
      assignmentsPreview,
    });
  }

  private async executeBusinessTaskWithBackendEngine(task: BusinessTask): Promise<void> {
    this.logBusinessTaskPayload(task);
    const label = `Agent-run-engine-${task.taskId}`;
    console.time(label);

    const assignments = Array.isArray((task.payload as any)?.assignments) ? (task.payload as any).assignments : [];
    const firstStaff = assignments[0]?.staffName || '';
    const firstWindowId = assignments[0]?.windowId || '';

    if (!firstStaff) {
      logger.warn(`[Agent日志] staffName 来源缺失：task=${task.taskId} assignments.length=${assignments.length}，日志将降级到全局区`);
    }
    if (!firstWindowId) {
      logger.warn(`[Agent日志] windowId 来源缺失：task=${task.taskId} assignments.length=${assignments.length}，日志将降级到全局区`);
    }

    console.log(`[Agent日志] 上传日志：staffName=${firstStaff || '(空)'}, windowId=${firstWindowId || '(空)'}, siteId=${task.siteId || '(空)'}, count=1`);

    await uploadLogs(this.client, task.taskId, [{
      level: 'info',
      message: `[兼容路径] 任务类型 ${task.type} 暂未迁移，继续使用 Cloud run-engine 兼容路径。正式方向是 Agent 本地执行；Arrival 已从 Phase K-2A 开始迁移。`,
      timestamp: new Date().toISOString(),
      staffName: firstStaff,
      windowId: firstWindowId,
      siteId: task.siteId,
    }]);

    console.time(`Agent-run-engine-POST-${task.taskId}`);
    await runTaskWithBackendEngine(this.client, task.taskId);
    console.timeEnd(`Agent-run-engine-POST-${task.taskId}`);
    console.timeEnd(label);
  }

  private async tickHeartbeat(): Promise<void> {
    if (this.shuttingDown || !this.taskLoop) {
      return;
    }

    try {
      const heartbeatStartedAt = Date.now();
      const runningTaskId = this.taskLoop.getRunningTaskId();
      logTrace('agent-main', 'heartbeat_start', {
        runningTaskId,
      });
      const resp = await sendHeartbeat(this.client, {
        agentVersion: this.agentVersion,
        machineFingerprint: 'placeholder',
        browserStatus: 'unknown',
        localStatus: {
          runningTaskId,
          pendingLogCount: 0,
          diskFreeMb: 0,
        },
        // M5-0: 版本指纹 + Chrome 信息
        gitCommit: this.versionFingerprint.gitCommit,
        buildId: this.versionFingerprint.buildId,
        startedAt: this.versionFingerprint.startedAt,
        chromePath: this.config.browser.executablePath,
        chromeKind: this.versionFingerprint.chromeKind as ChromeKind,
      });
      logTrace('agent-main', 'heartbeat_done', {
        runningTaskId,
        hasTask: resp.hasTask,
        nextPollAfterMs: resp.nextPollAfterMs,
        durationMs: Date.now() - heartbeatStartedAt,
      });

      if (resp.hasTask && !runningTaskId) {
        this.taskLoop.requestImmediatePoll('heartbeat_has_task');
      }
    } catch (err) {
      const msg = (err as Error).message;
      const runningTaskId = this.taskLoop.getRunningTaskId();
      if (msg.includes('401') || msg.includes('403') || msg.includes('授权码') || msg.includes('已停用')) {
        logger.error(`心跳失败（鉴权错误）：${msg}`);
        console.error(`心跳失败：${msg}`);
        this.stop();
        return;
      }
      safeLog('warn', `心跳失败：${msg}`, this.config.agentToken);
      warnTrace('agent-main', 'heartbeat_failed', {
        runningTaskId: runningTaskId || undefined,
        error: msg,
      });
    }
  }

  private setupWebSocket(): void {
    if (!this.taskLoop || !this.commandLoop) {
      return;
    }

    this.wsClient = new AgentWsClient({
      tenantId: this.config.tenantId || 'tenant-default',
      workstationId: this.config.workstationId || 'ws-local-default',
      agentVersion: this.agentVersion,
      onCommand: async (cmd) => {
        console.log(`[Agent] WS 收到命令: ${cmd.type} windowId=${cmd.windowId}`);
        this.commandLoop?.pullOnce().catch(() => {});
      },
      onTaskAvailable: async (task) => {
        console.log(`[Agent] WS 收到任务通知: ${task.type} taskId=${task.id}`);
        this.taskLoop?.requestImmediatePoll('ws_task_available');
      },
      onReconnect: () => {
        console.log('[Agent] WS 重连，补偿拉取 pending commands / tasks');
        this.commandLoop?.pullOnce().catch(() => {});
        this.taskLoop?.requestImmediatePoll('ws_reconnect');
      },
    });

    const updatePollMode = () => {
      if (!this.wsClient || !this.commandLoop) {
        return;
      }
      const nextFast = !this.wsClient.isConnected();
      const wasFast = this.commandLoop.isFastPolling();
      this.commandLoop.setFastPolling(nextFast);
      if (wasFast !== nextFast) {
        console.log(`[Agent] ${nextFast ? 'WS 离线，恢复快速轮询 (1s)' : 'WS 在线，降至慢轮询 (30s)'}`);
      }
    };

    this.wsClient.connect();
    this.pollModeTimer = setInterval(updatePollMode, 5000);
    console.log('[Agent] WebSocket 客户端已启动');
  }

  private registerProcessSignals(): void {
    process.on('SIGINT', () => {
      this.stop({ exitProcess: true, exitCode: 0 });
    });
    process.on('SIGTERM', () => {
      this.stop({ exitProcess: true, exitCode: 0 });
    });
  }
}
