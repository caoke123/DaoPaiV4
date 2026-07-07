/**
 * Adapter 测试任务路由 — Phase 2-B
 *
 * 独立的 POC 接口，不污染正式业务接口（/api/operations/*）。
 * 用于验证 PlaywrightWindowAdapter 能否通过任务链路获取 Playwright page。
 *
 * 路由前缀: /api/playwright-adapter-test
 *
 * 任务会写入 Database（任务中心可见）+ TaskLogManager（日志可见）+ TaskEventBus（SSE 推送）。
 * 但不走 AssignmentEngine.execute（不经过正式调度/锁/EasyBR 健康检测）。
 */
import { Router, type Request, type Response } from 'express';
import { DEFAULT_TENANT_ID, DEFAULT_SITE_ID } from '../playwright-runtime/types';
import { Database } from '../db/Database';
import { taskLogManager } from '../utils/TaskLogManager';
import { AdapterTestHandler } from './AdapterTestHandler';
import type { WindowAdapterOptions } from './types';

export const adapterTestRouter = Router();

/**
 * POST /api/playwright-adapter-test
 *
 * 提交 adapter 测试任务（异步执行，立即返回 taskId）
 *
 * Body:
 *   {
 *     "tenantId": "tenant-default",
 *     "siteId": "site-default",
 *     "windowId": "window-test-001",
 *     "staffName": "测试员工"
 *   }
 *
 * Response:
 *   {
 *     "taskId": "uuid",
 *     "status": "pending",
 *     "runtimeKey": "tenant-default:site-default:window-test-001"
 *   }
 */
adapterTestRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body || {};
  const tenantId = body.tenantId || DEFAULT_TENANT_ID;
  const siteId = body.siteId || DEFAULT_SITE_ID;
  const windowId = body.windowId;
  const staffName = body.staffName;
  const siteName = body.siteName;
  const windowName = body.windowName;

  // 参数校验：强制三元组
  if (!windowId || typeof windowId !== 'string') {
    res.status(400).json({
      error: '缺少 windowId（必须提供 tenantId + siteId + windowId 三元组）',
    });
    return;
  }

  const options: WindowAdapterOptions = {
    tenantId,
    siteId,
    windowId,
    staffName,
    siteName,
    windowName,
  };

  const runtimeKey = `${tenantId}:${siteId}:${windowId}`;
  const db = Database.getInstance();

  // 1. 创建任务记录（任务中心可见）
  //    type 使用 'adapter_test'，与正式业务类型区分
  const inputData = JSON.stringify({
    tenantId,
    siteId,
    windowId,
    staffName: staffName || null,
    runtimeKey,
  });

  const taskId = db.createTask({
    type: 'adapter_test',
    site: siteId,
    status: 'pending',
    total_count: 1,
    done_count: 0,
    fail_count: 0,
    input_data: inputData,
    finished_at: undefined,
  } as any);

  // 2. 写初始日志
  taskLogManager.addLog(
    taskId,
    'info',
    `Adapter 测试任务已提交: runtimeKey=${runtimeKey}, staffName=${staffName || 'N/A'}`,
    'api',
    { staffName, windowId },
  );

  // 3. 异步执行（不阻塞 HTTP 响应，与正式任务提交模式一致）
  const handler = new AdapterTestHandler();
  void handler.execute({ ...options, taskId }).catch((e) => {
    // 兜底：handler 内部已有 try/catch，这里防万一
    taskLogManager.addLog(
      taskId,
      'error',
      `Adapter 测试任务未捕获异常: ${(e as Error).message}`,
      'api',
      { staffName, windowId },
    );
    console.error(`[AdapterTestRoute] 未捕获异常:`, e);
  });

  // 4. 立即返回 taskId
  res.json({
    taskId,
    status: 'pending',
    runtimeKey,
    message: '测试任务已提交，可通过 /api/operations/' + taskId + ' 查看进度',
  });
});

/**
 * GET /api/playwright-adapter-test/health
 *
 * 健康检查
 */
adapterTestRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    module: 'playwright-adapter-test',
    handler: 'AdapterTestHandler',
    timestamp: Date.now(),
  });
});
