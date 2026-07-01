/**
 * ArrivalExecutor — 到件扫描 Agent 执行器
 *
 * Phase 5-B: 模拟 dryRun，不启动浏览器
 * Phase 5-E: 接入浏览器 DRY-RUN（payload.browserDryRun=true 时）
 * Phase 5-G-3: 使用 AgentLogger 缓冲日志，定时/定量 flush，减少日志真空期
 *
 * 硬性约束：
 *   - dryRun 必须为 true，否则拒绝执行
 *   - browserDryRun=true 时执行浏览器页面操作，但禁止点击最终提交
 *   - 不修改 /api/operations/arrive、BrowserPool、AssignmentEngine、ArrivalHandler
 *   - 不触碰 V2
 */

import type { AxiosInstance } from 'axios';
import {
  reportProgress,
  completeTask,
  failTask,
} from '../httpClient';
import { createAgentLogger } from '../logger/AgentLogger';
import type { AgentSettingsLoader } from '../AgentSettingsLoader';
import { BrowserManager } from '../browser/BrowserManager';
import { ensureBnsyLoggedIn } from '../browser/BnsySessionManager';
import { runArrivalBrowserDryRun } from '../browser/ArrivalBrowserDryRun';
import type { AgentConfig } from '../types';

interface ArrivalTask {
  taskId: string;
  siteId: string;
  payload: {
    waybills: string[];
    assignments?: Array<{ waybillNos?: string[] }>;
    options?: {
      batchSize?: number;
      prevStation?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    browserDryRun?: boolean;
  };
}

/**
 * 执行 Arrival 到件扫描任务
 *
 * 内部判断：
 *   - payload.browserDryRun === true → 浏览器 DRY-RUN
 *   - 否则 → 模拟 DRY-RUN（Phase 5-B 兼容）
 */
export async function executeArrivalDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills ||
    (payload.assignments || []).flatMap(a => a.waybillNos || []);
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[ArrivalExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, '只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  // 根据 browserDryRun 分支
  if (payload.browserDryRun === true) {
    await executeBrowserDryRun(task, client, settingsLoader, config);
  } else {
    await executeSimulatedDryRun(task, client, settingsLoader);
  }
}

// ══════════════════════════════════════════════════════════
// 浏览器 DRY-RUN（Phase 5-E）
// ══════════════════════════════════════════════════════════

async function executeBrowserDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills ||
    (payload.assignments || []).flatMap(a => a.waybillNos || []);
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const prevStation = payload.options?.prevStation || '天津分拨中心';

  const loginUrl = config?.bnsy?.loginUrl || 'https://bnsy.benniaosuyun.com/login';
  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile',
    debugPort: 9223,
    headless: false,
  };

  const logger = createAgentLogger(client, taskId);
  let manager: BrowserManager | null = null;

  try {
    // 1. 上报开始日志 + progress 5%
    console.log(`[ArrivalExecutor] 开始到件扫描浏览器 DRY-RUN，任务: ${taskId}`);
    logger.info(`开始到件扫描浏览器 DRY-RUN，网点：${siteName}，运单数：${waybills.length}`);
    logger.info(`参数校验完成，上一站：${prevStation}`);
    await reportProgress(client, taskId, 'running', 5);

    // 2. 启动浏览器
    console.log('[ArrivalExecutor] 启动项目内便携版 Chrome...');
    logger.info('正在启动项目内便携版 Chrome...');
    await logger.flush();

    manager = new BrowserManager(browserConfig);
    await manager.start();
    logger.success('Chrome 启动成功');
    logger.info('正在连接 Chrome DevTools...');
    await manager.connect();
    logger.success('Chrome DevTools 连接成功');

    // 3. 打开登录页
    console.log('[ArrivalExecutor] 打开登录页...');
    logger.info(`正在打开登录页：${loginUrl}`);
    await logger.flush();

    const page = await manager.openPage(loginUrl);
    logger.info('等待页面加载（5秒）...');
    await page.waitForTimeout(5000);

    // 4. 确保登录
    const credential = await settingsLoader.getLoginCredentialForSite(siteId);
    if (!credential) {
      throw new Error('无法读取员工凭据');
    }

    logger.info('正在检查登录状态...');
    const loginResult = await ensureBnsyLoggedIn(page, credential);
    logger.info(`登录状态检查完成：${loginResult.message}`);

    // 5. Dashboard P0 必须 READY
    if (!loginResult.success || loginResult.dashboard.status !== 'READY') {
      throw new Error(`Dashboard P0 不是 READY（状态: ${loginResult.dashboard.status}）`);
    }

    logger.info('账号输入校验通过');
    logger.info('密码输入校验通过');
    logger.success('Dashboard P0 READY');
    await reportProgress(client, taskId, 'running', 30);

    // 6. 执行到件页面 DRY-RUN
    console.log('[ArrivalExecutor] 进入到件扫描页面...');
    logger.info('正在进入到件扫描页面...');
    await logger.flush();

    const dryRunResult = await runArrivalBrowserDryRun(page, {
      siteId,
      siteName,
      waybills,
      options: { prevStation },
    });

    // 7. 上报校验日志
    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(msg);
      }
    }

    logger.info(`输入运单：${dryRunResult.inputCount} 条`);

    if (dryRunResult.queried) {
      logger.info('已点击查询按钮');
    }

    logger.info('已阻止最终提交（未点击批量到件/确认到件/提交按钮）');

    // 8. 检查结果
    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    // 9. 上报 progress 90%
    await reportProgress(client, taskId, 'running', 90);
    console.log('[ArrivalExecutor] 页面 DRY-RUN 完成');
    logger.success('到件扫描浏览器 DRY-RUN 完成，未点击最终提交');

    // 先 flush 日志，再关闭浏览器
    await logger.flush();

    // 10. 关闭浏览器
    if (manager) {
      console.log('[ArrivalExecutor] 关闭 V3 Chrome...');
      logger.info('正在关闭 V3 Chrome...');
      const closeResult = await manager.close();
      manager = null;
      logger.info(`V3 Chrome 已关闭：${closeResult.message}`);
    }

    // 11. complete — flush 所有日志后再完成
    await logger.flush();
    const summary = {
      mode: 'browserDryRun',
      total: dryRunResult.inputCount,
      queried: dryRunResult.queried,
      finalSubmitClicked: false,
      pageUrl: dryRunResult.pageUrl,
      message: '到件扫描浏览器 DRY-RUN 完成，未点击最终提交',
    };

    const results = waybills.map(wb => ({
      waybillNo: wb,
      status: 'dry_run',
      message: '已输入并查询，未提交到件',
    }));

    await completeTask(client, taskId, summary, results);
    console.log('[ArrivalExecutor] 任务完成，已回传 Cloud');

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[ArrivalExecutor] 任务 ${taskId} 执行失败：${msg}`);

    logger.error(`任务执行失败：${msg}`);
    await logger.flush();

    // 关闭浏览器（如果还开着）
    if (manager) {
      try {
        logger.info('正在关闭 V3 Chrome...');
        await logger.flush();
        await manager.close();
        manager = null;
        logger.info('V3 Chrome 已关闭');
      } catch (closeErr) {
        console.error(`[ArrivalExecutor] Chrome 关闭失败：${(closeErr as Error).message}`);
      }
    }

    try {
      await logger.close();
      await failTask(client, taskId, msg);
    } catch {
      // 忽略 fail 失败
    }
    return;

  } finally {
    await logger.close();
  }
}

// ══════════════════════════════════════════════════════════
// 模拟 DRY-RUN（Phase 5-B 兼容，不启动浏览器）
// ══════════════════════════════════════════════════════════

async function executeSimulatedDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills ||
    (payload.assignments || []).flatMap(a => a.waybillNos || []);
  const batchSize = payload.options?.batchSize || 200;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  const totalWaybills = waybills.length;
  console.log(`[ArrivalExecutor] 发现到件扫描任务：${taskId}`);
  console.log(`[ArrivalExecutor] 网点：${siteName}，运单数：${totalWaybills}`);
  console.log(`[ArrivalExecutor] 模式：模拟 DRY-RUN（不启动浏览器）`);

  const logger = createAgentLogger(client, taskId);

  try {
    logger.info(`开始到件扫描 DRY-RUN，网点：${siteName}，运单数：${totalWaybills}`);
    logger.info(`模式：模拟 DRY-RUN（不启动浏览器）`);
    logger.info(`参数：batchSize=${batchSize}`);
    await reportProgress(client, taskId, 'running', 10);
    console.log(`进度：10%`);

    const totalBatches = Math.ceil(totalWaybills / batchSize);
    let processed = 0;

    for (let batch = 0; batch < totalBatches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, totalWaybills);
      const batchWaybills = waybills.slice(start, end);

      logger.info(`开始处理第 ${batch + 1}/${totalBatches} 批（${start + 1}-${end}）`);

      for (const waybillNo of batchWaybills) {
        processed++;
        console.log(`模拟处理运单：${waybillNo}`);

        if (processed % 5 === 0 || processed === totalWaybills) {
          logger.info(`DRY-RUN 模拟处理运单 ${processed}/${totalWaybills}`);
        }

        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const progress = Math.floor(10 + ((batch + 1) / totalBatches) * 85);
      await reportProgress(client, taskId, 'running', progress);
      logger.info(`第 ${batch + 1}/${totalBatches} 批处理完成，进度 ${progress}%`);
      console.log(`进度：${progress}% (第 ${batch + 1}/${totalBatches} 批)`);
    }

    await reportProgress(client, taskId, 'running', 100);
    console.log(`进度：100%`);

    logger.success(`到件扫描 DRY-RUN 完成，共处理 ${totalWaybills} 条运单`);
    await logger.flush();

    await completeTask(client, taskId);
    console.log('到件扫描 DRY-RUN 完成，已回传 Cloud');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`到件扫描任务 ${taskId} 执行失败：${msg}`);

    logger.error(`任务执行失败：${msg}`);
    await logger.flush();

    try {
      await logger.close();
      await failTask(client, taskId, msg);
    } catch {
      // 忽略 fail 失败
    }
    return;
  } finally {
    await logger.close();
  }
}
