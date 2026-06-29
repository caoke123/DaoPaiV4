/**
 * Window Adapter POC 调试路由 — Phase 2-A
 *
 * 独立于正式任务路由（routes.ts），不影响 AssignmentEngine / Handlers。
 * 仅用于验证 WindowAdapter 的 ensure-ready / mark-busy / mark-ready / close 行为。
 *
 * 路由前缀: /api/window-adapter-poc
 *
 * 所有接口统一使用三元组 { tenantId, siteId, windowId }，
 * 禁止只传 windowId。
 */
import { Router, type Request, type Response } from 'express';
import { WindowAdapterRegistry } from './WindowAdapterRegistry';
import { DEFAULT_TENANT_ID, DEFAULT_SITE_ID, buildRuntimeKey } from '../playwright-runtime/types';
import type { WindowAdapterOptions } from './types';

export const pocAdapterRouter = Router();

const registry = WindowAdapterRegistry.getInstance();

/**
 * 从 body 或 query 解析 WindowAdapterOptions，应用默认值
 *
 * 强制要求 tenantId + siteId + windowId，禁止只传 windowId。
 */
function resolveOptions(source: {
  tenantId?: string;
  siteId?: string;
  windowId?: string;
  staffName?: string;
  siteName?: string;
  windowName?: string;
}): { options: WindowAdapterOptions } | { error: string } {
  const { tenantId, siteId, windowId, staffName, siteName, windowName } = source;
  if (!windowId || typeof windowId !== 'string') {
    return { error: '缺少 windowId（必须提供 tenantId + siteId + windowId 三元组）' };
  }
  return {
    options: {
      tenantId: tenantId || DEFAULT_TENANT_ID,
      siteId: siteId || DEFAULT_SITE_ID,
      windowId,
      staffName,
      siteName,
      windowName,
    },
  };
}

// ── 健康检查 ──
pocAdapterRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    module: 'window-adapter-poc',
    defaultAdapter: registry.getDefaultName(),
    registeredAdapters: registry.listNames(),
    timestamp: Date.now(),
  });
});

// ── 确保窗口就绪 ──
// POST /ensure-ready
// Body: { tenantId?, siteId?, windowId, staffName?, siteName?, windowName? }
pocAdapterRouter.post('/ensure-ready', async (req: Request, res: Response) => {
  const parsed = resolveOptions(req.body || {});
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await registry.getAdapter().ensureWindowReady(parsed.options);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, runtimeKey: '' });
  }
});

// ── 标记 busy ──
// POST /mark-busy
// Body: { tenantId?, siteId?, windowId }
pocAdapterRouter.post('/mark-busy', async (req: Request, res: Response) => {
  const parsed = resolveOptions(req.body || {});
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const runtimeKey = buildRuntimeKey(parsed.options.tenantId, parsed.options.siteId, parsed.options.windowId);
  try {
    const result = await registry.getAdapter().markBusy(runtimeKey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, runtimeKey });
  }
});

// ── 标记 ready（不关闭 context）──
// POST /mark-ready
// Body: { tenantId?, siteId?, windowId }
pocAdapterRouter.post('/mark-ready', async (req: Request, res: Response) => {
  const parsed = resolveOptions(req.body || {});
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const runtimeKey = buildRuntimeKey(parsed.options.tenantId, parsed.options.siteId, parsed.options.windowId);
  try {
    const result = await registry.getAdapter().markReady(runtimeKey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, runtimeKey });
  }
});

// ── 查询状态（实时刷新）──
// GET /status?tenantId=&siteId=&windowId=
pocAdapterRouter.get('/status', async (req: Request, res: Response) => {
  const parsed = resolveOptions(req.query as any);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await registry.getAdapter().refreshStatus(parsed.options);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, runtimeKey: '' });
  }
});

// ── 关闭窗口（幂等）──
// POST /close
// Body: { tenantId?, siteId?, windowId }
pocAdapterRouter.post('/close', async (req: Request, res: Response) => {
  const parsed = resolveOptions(req.body || {});
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const result = await registry.getAdapter().closeWindow(parsed.options);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, runtimeKey: '' });
  }
});
