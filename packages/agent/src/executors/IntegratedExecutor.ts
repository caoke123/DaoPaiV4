/**
 * IntegratedExecutor — 到派一体 Agent 执行器
 *
 * 仅支持浏览器 DRY-RUN（browserDryRun=true），不提供模拟 dryRun 分支。
 * Phase 5-G-3: 使用 AgentLogger 缓冲日志，定时/定量 flush，减少日志真空期
 *
 * 硬性约束：
 *   - dryRun 必须不为 false，否则拒绝执行
 *   - browserDryRun 必须为 true，否则拒绝执行
 *   - waybills 不能为空
 *   - 浏览器页面操作禁止点击最终提交
 *   - 不修改 /api/operations/integrated、BrowserPool、AssignmentEngine、IntegratedHandler
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
import { runIntegratedBrowserDryRun } from '../browser/IntegratedBrowserDryRun';
import type { AgentConfig } from '../types';

interface IntegratedTask {
  taskId: string;
  siteId: string;
  payload: {
    waybills: string[];
    assignments?: Array<{ waybillNos?: string[] }>;
    options?: {
      prevStation?: string;
      courierName?: string;
      courierEmployeeId?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    browserDryRun?: boolean;
  };
}

/**
 * 执行 Integrated 到派一体任务（仅 browserDryRun 模式）
 *
 * 内部判断：
 *   - dryRun === false → 拒绝执行
 *   - browserDryRun !== true → 拒绝执行
 *   - waybills 为空 → 拒绝执行
 */
export async function executeIntegratedDryRun(
  task: IntegratedTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  // Phase 5-G-3-2: 兼容 assignments 结构（后端存储 assignments[].waybillNos）
  const waybills = payload.waybills ||
    (payload.assignments || []).flatMap(a => a.waybillNos || []);
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[IntegratedExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, '只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  // 校验 browserDryRun
  if (payload.browserDryRun !== true) {
    console.error(`[IntegratedExecutor] 任务 ${taskId} 未启用 browserDryRun，拒绝执行`);
    await failTask(client, taskId, '只支持 browserDryRun 模式');
    return;
  }

  // 校验 waybills 非空
  if (waybills.length === 0) {
    console.error(`[IntegratedExecutor] 任务 ${taskId} 运单列表为空，拒绝执行`);
    await failTask(client, taskId, '运单列表为空');
    return;
  }

  const prevStation = payload.options?.prevStation;
  const payloadCourierName = payload.options?.courierName;
  const payloadCourierEmployeeId = payload.options?.courierEmployeeId;
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
    console.log(`[IntegratedExecutor] 开始到派一体浏览器 DRY-RUN，任务: ${taskId}`);
    logger.info(`开始到派一体浏览器 DRY-RUN，网点：${siteName}，运单数：${waybills.length}`);
    logger.info('参数校验完成');
    if (prevStation) logger.info(`上一站：${prevStation}`);
    await reportProgress(client, taskId, 'running', 5);

    // 2. 启动浏览器
    console.log('[IntegratedExecutor] 启动项目内便携版 Chrome...');
    logger.info('正在启动项目内便携版 Chrome...');
    await logger.flush();

    manager = new BrowserManager(browserConfig);
    await manager.start();
    logger.success('Chrome 启动成功');
    logger.info('正在连接 Chrome DevTools...');
    await manager.connect();
    logger.success('Chrome DevTools 连接成功');

    // 3. 打开登录页
    console.log('[IntegratedExecutor] 打开登录页...');
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

    // 派件员信息：优先用 payload 传入值，缺失时用 settings.json 网点员工凭据兜底
    const courierName = payloadCourierName || credential.employeeName;
    const courierEmployeeId = payloadCourierEmployeeId || credential.loginAccount;

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
    logger.info(`派件员：${courierName} (${courierEmployeeId})`);
    await reportProgress(client, taskId, 'running', 30);

    // 6. 执行到派一体页面 DRY-RUN
    console.log('[IntegratedExecutor] 进入到派一体页面...');
    logger.info('正在进入到派一体页面...');
    await logger.flush();

    const dryRunResult = await runIntegratedBrowserDryRun(page, {
      siteId,
      siteName,
      waybills,
      options: { prevStation, courierName, courierEmployeeId },
    });

    // 7. 上报校验日志
    if (dryRunResult.validationLogs.length > 0) {
      logger.info(`校验结果：共 ${dryRunResult.validationLogs.length} 条校验日志`);
      for (const msg of dryRunResult.validationLogs) {
        logger.info(msg);
      }
    }

    logger.info(`输入运单：${dryRunResult.inputCount} 条`);

    if (dryRunResult.prevStationSelected) {
      logger.info('上一站选中');
    }

    if (dryRunResult.integratedCheckboxChecked) {
      logger.info('到派一体勾选');
    }

    if (dryRunResult.courierSelected) {
      logger.info('派件员选中');
    }

    logger.info('已阻止最终提交（未点击批量到派一体/确认/提交按钮）');

    // 8. 检查结果
    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    // 9. 上报 progress 90%
    await reportProgress(client, taskId, 'running', 90);
    console.log('[IntegratedExecutor] 页面 DRY-RUN 完成');
    logger.success('到派一体浏览器 DRY-RUN 完成，未点击最终提交');

    // 先 flush 日志，再关闭浏览器
    await logger.flush();

    // 10. 关闭浏览器
    if (manager) {
      console.log('[IntegratedExecutor] 关闭 V3 Chrome...');
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
      prevStationSelected: dryRunResult.prevStationSelected,
      integratedCheckboxChecked: dryRunResult.integratedCheckboxChecked,
      courierSelected: dryRunResult.courierSelected,
      finalSubmitClicked: false,
      pageUrl: dryRunResult.pageUrl,
      message: '到派一体浏览器 DRY-RUN 完成，未点击最终提交',
    };

    const results = waybills.map(wb => ({
      waybillNo: wb,
      status: 'dry_run',
      message: '已输入并选上一站/到派一体/派件员，未提交到派一体',
    }));

    await completeTask(client, taskId, summary, results);
    console.log('[IntegratedExecutor] 任务完成，已回传 Cloud');

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[IntegratedExecutor] 任务 ${taskId} 执行失败：${msg}`);

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
        console.error(`[IntegratedExecutor] Chrome 关闭失败：${(closeErr as Error).message}`);
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
