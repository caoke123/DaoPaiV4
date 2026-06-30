/**
 * DaoPai 本地执行端 — 启动入口
 *
 * 当前阶段：任务管道最小闭环（Phase 4-F），不接真实浏览器。
 * 后续 Phase 4-E+ 才接真实浏览器执行。
 */

import { loadConfig } from './config';
import { initLogger, logger, safeLog } from './logger';
import { startupCheck } from './startupCheck';
import {
  createHttpClient,
  getAgentMe,
  sendHeartbeat,
  pullTask,
  reportProgress,
  uploadLogs,
  completeTask,
  failTask,
} from './httpClient';
import type { AxiosInstance } from 'axios';
import type { AgentConfig } from './types';

let shuttingDown = false;
let runningTaskId: string | null = null;

async function executeAgentTestTask(
  client: AxiosInstance,
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
    // 1. 上报开始日志
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始测试任务：${message}`,
      timestamp: new Date().toISOString(),
    }]);

    // 2. 上报 running 10%
    await reportProgress(client, taskId, 'running', 10);
    console.log('进度：10%');
    logger.info(`任务 ${taskId} 进度：10%`);

    // 3. 模拟执行
    await new Promise(resolve => setTimeout(resolve, durationMs / 2));

    // 4. 上报 50%
    await reportProgress(client, taskId, 'running', 50);
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '测试任务执行中...',
      timestamp: new Date().toISOString(),
    }]);
    console.log('进度：50%');
    logger.info(`任务 ${taskId} 进度：50%`);

    // 5. 继续模拟
    await new Promise(resolve => setTimeout(resolve, durationMs / 2));

    // 6. 上报 100%
    await reportProgress(client, taskId, 'running', 100);
    console.log('进度：100%');
    logger.info(`任务 ${taskId} 进度：100%`);

    // 7. 上报完成日志
    await uploadLogs(client, taskId, [{
      level: 'success',
      message: '测试任务完成',
      timestamp: new Date().toISOString(),
    }]);

    // 8. complete
    await completeTask(client, taskId);
    console.log('测试任务完成，已回传 Cloud');
    logger.info(`任务 ${taskId} 已完成`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`任务 ${taskId} 执行失败：${msg}`);
    console.error(`任务执行失败：${msg}`);

    try {
      await failTask(client, taskId, msg);
      logger.info(`任务 ${taskId} 已标记为 failed`);
    } catch {
      logger.error(`任务 ${taskId} 标记失败时出错`);
    }
  }
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai 本地执行端 v0.1.0');
  console.log('  当前阶段：任务管道最小闭环，模拟执行');
  console.log('========================================');
  console.log('');

  // 1. 加载配置
  const config = loadConfig();

  // 2. 初始化日志系统
  initLogger(config.logLevel);

  logger.info('DaoPai 本地执行端启动中...');
  logger.info(`Cloud 地址：${config.cloudBaseUrl}`);
  logger.info(`执行电脑：${config.workstationName}`);

  // 3. 启动检查
  console.log('正在执行启动检查...\n');
  const result = await startupCheck(config);

  if (!result.ok) {
    logger.error('启动检查未通过，本地执行端退出');
    process.exit(1);
  }

  // 4. 创建 HTTP 客户端
  const client = createHttpClient(config);

  // 5. 验证授权码
  try {
    const me = await getAgentMe(client);
    console.log(`执行电脑：${me.name}`);
    console.log(`快递公司：${me.tenantName}`);
    console.log(`所属网点：${me.siteName || '未绑定'}`);
    logger.info(`授权码验证成功，执行电脑：${me.name}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`授权码验证失败：${msg}`);
    console.error(`错误：${msg}`);
    process.exit(1);
  }

  console.log('');
  console.log('心跳循环已启动，每 15 秒上报一次...');
  console.log('按 Ctrl+C 停止\n');
  logger.info('心跳循环已启动');

  // 6. 心跳 + 任务轮询主循环
  const tick = async () => {
    if (shuttingDown) return;

    try {
      // 发送心跳（如果正在执行任务，告知 Cloud）
      const resp = await sendHeartbeat(client, {
        agentVersion: '0.1.0',
        machineFingerprint: 'placeholder',
        browserStatus: 'unknown',
        localStatus: {
          runningTaskId,
          pendingLogCount: 0,
          diskFreeMb: 0,
        },
      });

      // 如果有任务且当前没有在执行，拉取任务
      if (resp.hasTask && !runningTaskId) {
        try {
          const pullResp = await pullTask(client);
          if (pullResp.hasTask && pullResp.task) {
            const task = pullResp.task;

            // 只处理 agent_test 类型
            if (task.type === 'agent_test') {
              runningTaskId = task.taskId;
              await executeAgentTestTask(client, task.taskId, task.payload);
              runningTaskId = null;
            }
          }
        } catch (err) {
          const msg = (err as Error).message;
          safeLog('warn', `任务拉取失败：${msg}`, config.agentToken);
          runningTaskId = null;
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('401') || msg.includes('403') || msg.includes('授权码') || msg.includes('已停用')) {
        logger.error(`心跳失败（鉴权错误）：${msg}`);
        console.error(`心跳失败：${msg}`);
        shuttingDown = true;
        return;
      }
      safeLog('warn', `心跳失败：${msg}`, config.agentToken);
    }
  };

  // 立即执行第一次
  await tick();

  // 定时循环
  const timer = setInterval(() => tick(), config.heartbeatIntervalMs);

  // 优雅退出
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在停止本地执行端...');
    clearInterval(timer);
    logger.info('本地执行端已停止');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('本地执行端启动失败：', err.message);
  process.exit(1);
});