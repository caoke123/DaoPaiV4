/**
 * Playwright POC 验证路由
 *
 * 独立于正式任务路由（routes.ts），不影响 AssignmentEngine / Handlers。
 * 仅用于 Phase 1 POC 验证 Playwright 原生窗口运行时能力。
 *
 * 路由前缀: /api/playwright-poc
 *
 * Phase 1-A 补丁：
 *   - 所有窗口操作统一使用 runtimeKey（tenantId:siteId:windowId）
 *   - GET 单个窗口用 query param: ?tenantId=&siteId=&windowId=
 *   - POST 操作用 body: { tenantId?, siteId?, windowId }
 *   - 返回结果包含 runtimeKey 和 userDataDir
 */
import { Router, type Request, type Response } from 'express';
import { PlaywrightRuntime } from './PlaywrightRuntime';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_SITE_ID,
  buildRuntimeKey,
  type PlaywrightWindowOptions,
} from './types';

export const pocRouter = Router();

const runtime = PlaywrightRuntime.getInstance();

/** 从 query 或 body 解析三元组，应用默认值 */
function resolveTriple(source: { tenantId?: string; siteId?: string; windowId?: string }): {
  tenantId: string;
  siteId: string;
  windowId: string;
  runtimeKey: string;
} | { error: string } {
  const { tenantId, siteId, windowId } = source;
  if (!windowId || typeof windowId !== 'string') {
    return { error: '缺少 windowId' };
  }
  const t = tenantId || DEFAULT_TENANT_ID;
  const s = siteId || DEFAULT_SITE_ID;
  return { tenantId: t, siteId: s, windowId, runtimeKey: buildRuntimeKey(t, s, windowId) };
}

// ── 健康检查 ──
pocRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    module: 'playwright-poc',
    activeWindows: runtime.getActiveCount(),
    timestamp: Date.now(),
  });
});

// ── 启动窗口 ──
// Body: { tenantId?, siteId?, windowId, windowName?, staffName?, siteName?, headless?, autoLogin?, credential?, initialUrl? }
pocRouter.post('/launch', async (req: Request, res: Response) => {
  const body = req.body || {};
  const triple = resolveTriple(body);
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }

  const opts: PlaywrightWindowOptions = {
    tenantId: triple.tenantId,
    siteId: triple.siteId,
    windowId: triple.windowId,
    windowName: body.windowName,
    staffName: body.staffName,
    siteName: body.siteName,
    headless: body.headless ?? false,
    autoLogin: body.autoLogin ?? false,
    credential: body.credential,
    initialUrl: body.initialUrl,
  };

  const result = await runtime.launchWindow(opts);
  if (result.success) {
    res.json({
      success: true,
      runtimeKey: triple.runtimeKey,
      state: runtime.getWindowStateJSON(triple.runtimeKey),
    });
  } else {
    res.status(500).json({
      success: false,
      runtimeKey: triple.runtimeKey,
      error: result.error,
    });
  }
});

// ── 列出所有窗口 ──
pocRouter.get('/windows', (_req: Request, res: Response) => {
  const windows = runtime.listWindowsJSON();
  res.json({
    windows,
    activeCount: runtime.getActiveCount(),
    totalCount: windows.length,
  });
});

// ── 获取指定窗口状态（query param） ──
// GET /window?tenantId=&siteId=&windowId=&refresh=true
// Phase 1-C: refresh=true 时实时检测并更新缓存状态
pocRouter.get('/window', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.query as any);
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }

  // Phase 1-C: refresh=true 时实时检测 page 状态并更新缓存
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
  if (refresh) {
    const result = await runtime.refreshState(triple.runtimeKey);
    if (result.notFound) {
      res.status(404).json({ error: `窗口 ${triple.runtimeKey} 不存在或未启动` });
      return;
    }
    res.json({ state: result.state, refreshed: true });
    return;
  }

  // 默认返回缓存状态（不触发实时检测，响应更快）
  const state = runtime.getWindowStateJSON(triple.runtimeKey);
  if (!state) {
    res.status(404).json({ error: `窗口 ${triple.runtimeKey} 不存在` });
    return;
  }
  res.json({ state });
});

// ── 关闭指定窗口（幂等） ──
// Body: { tenantId?, siteId?, windowId }
// Phase 1-C: 已关闭窗口再次 close 返回 { success: true, alreadyClosed: true }
pocRouter.post('/window/close', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.body || {});
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const result = await runtime.closeWindow(triple.runtimeKey);
  res.json(result);
});

// ── 关闭所有窗口（POC 专用） ──
pocRouter.post('/close-all', async (_req: Request, res: Response) => {
  // ⚠️ POC 专用：仅用于 POC 验证和测试清理。
  // 正式阶段应按 tenantId 维度关闭，避免跨租户误关。
  await runtime.closeAll();
  res.json({ success: true, activeCount: runtime.getActiveCount() });
});

// ── 手动触发登录 ──
// Body: { tenantId?, siteId?, windowId, account, password }
pocRouter.post('/window/login', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.body || {});
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const { account, password } = req.body || {};
  if (!account || !password) {
    res.status(400).json({ error: '缺少 account 或 password' });
    return;
  }

  const result = await runtime.manualLogin(triple.runtimeKey, { account, password });
  res.json({ ...result, runtimeKey: triple.runtimeKey });
});

// ── 探测登录页表单（不执行登录） ──
// GET /window/login-probe?tenantId=&siteId=&windowId=
pocRouter.get('/window/login-probe', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.query as any);
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const page = runtime.getPage(triple.runtimeKey);
  if (!page) {
    res.status(404).json({ error: `窗口 ${triple.runtimeKey} 不存在或未启动` });
    return;
  }

  const { PlaywrightLoginVerifier } = await import('./PlaywrightLoginVerifier');
  const verifier = new PlaywrightLoginVerifier();
  const isLoginPage = await verifier.isLoginPage(page);
  const isLoggedIn = await verifier.isLoggedIn(page);
  const formInfo = isLoginPage ? await verifier.probeLoginForm(page) : null;

  res.json({
    runtimeKey: triple.runtimeKey,
    currentUrl: page.url(),
    isLoginPage,
    isLoggedIn,
    loginForm: formInfo,
  });
});

// ── 会话调试信息（Phase 1-C 新增） ──
// GET /window/session-debug?tenantId=&siteId=&windowId=
// 采集 JWT token 分析 + Cookie 分析 + 登录状态，用于诊断登录态失效原因
pocRouter.get('/window/session-debug', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.query as any);
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const debug = await runtime.getSessionDebug(triple.runtimeKey);
  if ('error' in debug) {
    res.status(404).json(debug);
    return;
  }
  res.json(debug);
});

// ── 导航到指定 URL（Phase 1-C 新增，POC 专用） ──
// POST /window/navigate
// Body: { tenantId?, siteId?, windowId, url, waitUntil? }
// 用于场景 B 模拟任务过程中的页面跳转，不关闭 context。
pocRouter.post('/window/navigate', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.body || {});
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const { url, waitUntil } = req.body || {};
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: '缺少 url' });
    return;
  }
  const page = runtime.getPage(triple.runtimeKey);
  if (!page) {
    res.status(404).json({ error: `窗口 ${triple.runtimeKey} 不存在或未启动` });
    return;
  }
  try {
    await page.goto(url, { waitUntil: waitUntil || 'domcontentloaded', timeout: 30000 });
    // 等待 SPA 路由稳定
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
    const finalUrl = page.url();
    const { PlaywrightLoginVerifier } = await import('./PlaywrightLoginVerifier');
    const verifier = new PlaywrightLoginVerifier();
    const isLoginPage = await verifier.isLoginPage(page);
    const isLoggedIn = await verifier.isLoggedIn(page);
    res.json({
      success: true,
      runtimeKey: triple.runtimeKey,
      finalUrl,
      isLoginPage,
      isLoggedIn,
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      runtimeKey: triple.runtimeKey,
      error: (e as Error).message,
    });
  }
});

// ── P0 就绪检查（Phase 2-D-Run 三次修正新增） ──
// POST /window/p0-check
// Body: { tenantId?, siteId?, windowId }
// 复用原项目 BrowserPool.verifyReady（7 项检查）+ ensureNoPopup（PopupManager.dismissAll）
// 仅用于测试脚本在 sign 任务前执行 P0 检查，不影响正式业务代码。
pocRouter.post('/window/p0-check', async (req: Request, res: Response) => {
  const triple = resolveTriple(req.body || {});
  if ('error' in triple) {
    res.status(400).json({ error: triple.error });
    return;
  }
  const page = runtime.getPage(triple.runtimeKey);
  if (!page) {
    res.status(404).json({ error: `窗口 ${triple.runtimeKey} 不存在或未启动` });
    return;
  }
  try {
    const { P0Verifier } = await import('./P0Verifier');
    const verifier = new P0Verifier();
    const report = await verifier.runFullCheck(page, triple.windowId);
    res.json({
      success: true,
      runtimeKey: triple.runtimeKey,
      report,
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      runtimeKey: triple.runtimeKey,
      error: (e as Error).message,
    });
  }
});
