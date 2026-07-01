// Express API 路由定义
// 提供窗口状态查询、任务提交、任务进度查询等接口
//
// Phase 2-C: 任务主链路 PG 单写收敛
//   - 任务创建以 pgDb.insertTask 为 PRIMARY（失败 → 500）
//   - db.createTask 降级为 legacy mirror（best-effort try/catch）
//   - 移除 fire-and-forget PG 写法
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { BrowserPool } from '../browser/BrowserPool';
import { Database, type Site, type TaskType } from '../db/Database';
import { EasyBRClient } from '../easybr/EasyBRClient';
import { taskLogManager } from '../utils/TaskLogManager';
import { taskEventBus, type TaskEvent } from '../utils/TaskEventBus';
import { RuntimeMetrics } from '../runtime/RuntimeMetrics';
import { runtimeStatus } from '../browser/runtime/RuntimeStatus';
import { SettingsManager } from '../config/SettingsManager';
import { isLoginCapableWindow } from '../config/SettingsManager';
import { PgDatabase } from '../db/PgDatabase';
import { getTenantId, getWorkstationId } from './middleware/requestContext';
import { taskLogService } from '../services/TaskLogService';
// Phase D-1: 统一任务执行引擎
import { AssignmentEngine, ArrivalHandler, DispatchHandler, IntegratedHandler, SignHandler, InitWindowHandler, type Assignment } from '../modules/assignment-engine';
// 类型仅用于请求体校验（业务执行已交给 Engine）

// ── 任务提交速率保护（保护 EasyBR 稳定性）────────────────
// 简单令牌桶：每秒最多 1 个任务提交请求
// 超过速率返回 429 Too Many Requests，前端应提示用户稍后再试
let lastTaskSubmitTime = 0;
const TASK_SUBMIT_INTERVAL_MS = 1000; // 最小提交间隔 1 秒

/** 检查任务提交速率，返回 { allowed: boolean; waitMs: number } */
function checkTaskRate(): { allowed: boolean; waitMs: number } {
  const now = Date.now();
  const elapsed = now - lastTaskSubmitTime;
  if (elapsed >= TASK_SUBMIT_INTERVAL_MS) {
    lastTaskSubmitTime = now;
    return { allowed: true, waitMs: 0 };
  }
  return { allowed: false, waitMs: TASK_SUBMIT_INTERVAL_MS - elapsed };
}
import type { DispatchAssignment } from '../operations/DispatchScan';
import type { IntegratedAssignment } from '../operations/IntegratedScan';
import type { SignAssignment } from '../operations/SignScan';

/**
 * 将前端传入的 site 标识统一转换为内部 Site code（'tiannanda' | 'heyuan'）。
 * 前端传 settings.json 的 site.id（如 "site-1782121346155"），
 * BrowserPool 连接对象中 windowInfo.site 是内部 Site code（如 'tiannanda'）。
 * 若不做转换，getStaffConnection 会因 site 不匹配而找不到窗口。
 */
function normalizeSiteToCode(
  siteInput: string,
  config: { sites: { id: string; name: string }[] },
  routeName: string,
): Site {
  // 已是内部 Site code，直接返回
  if (siteInput === 'tiannanda' || siteInput === 'heyuan') {
    return siteInput;
  }
  // 按 site.id 查找 settings.json 中的站点配置
  const site = config.sites.find(s => s.id === siteInput);
  if (site) {
    let code: Site;
    if (site.name.includes('天南大')) {
      code = 'tiannanda';
    } else if (site.name.includes('和苑')) {
      code = 'heyuan';
    } else {
      throw new Error(`无法识别站点名称：${site.name}（site.id=${siteInput}），请检查 settings.json 站点配置`);
    }
    console.log(`[site-normalize] input=${siteInput} normalized=${code} route=${routeName}`);
    return code;
  }
  throw new Error(`无法识别站点：${siteInput}，请检查 settings.json 站点配置`);
}

// 创建路由
export const router = Router();

// ── 窗口状态接口 ──────────────────────────────────────

/** GET /api/status — 所有窗口连接状态（只读，不触发refresh） */
// ── Phase 3-D-2: Runtime 可用性检查（执行接口保护）──

function requireRuntimeAvailable(res: Response): boolean {
  if (!runtimeStatus.isAvailable()) {
    const state = runtimeStatus.getState();
    res.status(503).json({
      error: 'BROWSER_RUNTIME_UNAVAILABLE',
      message: '本地浏览器运行时未就绪，请启动本地执行端后重试',
      runtime: state.health,
      runtimeError: state.error,
    });
    return false;
  }
  return true;
}

router.get('/api/status', async (_req: Request, res: Response) => {
  const runtime = runtimeStatus.getSummary();
  const authRequired = process.env.AUTH_REQUIRED === 'true';
  try {
    const pool = BrowserPool.getInstance();
    const windows = pool.listWindows();
    res.json({
      alive: true,
      authRequired,
      runtime: runtime.runtime,
      runtimeError: runtime.runtimeError,
      total: windows.length,
      connected: windows.filter(w => w.is_connected).length,
      windows: windows.map(w => ({
        id: w.id,
        name: w.name,
        role: w.role,
        site: w.site,
        staffName: w.staff_name,
        isConnected: !!w.is_connected,
        cdpPort: w.cdp_port,
      })),
      runtimeMetrics: RuntimeMetrics.getInstance().snapshot(),
    });
  } catch (e) {
    // BrowserPool 不可用也返回 alive=true，runtime 状态显示 unavailable
    res.json({
      alive: true,
      authRequired,
      runtime: runtime.runtime,
      runtimeError: runtime.runtimeError,
      total: 0,
      connected: 0,
      windows: [],
      error: (e as Error).message,
    });
  }
});

/** GET /api/windows — 窗口列表（含角色、网点、连接状态） */
router.get('/api/windows', (_req: Request, res: Response) => {
  try {
    const pool = BrowserPool.getInstance();
    const windows = pool.listWindows();
    res.json(windows);
  } catch (e) {
    console.error('[GET /api/windows] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/diag/connections — 诊断：检查所有连接的存活状态 + URL + PID */
router.get('/api/diag/connections', async (_req: Request, res: Response) => {
  try {
    const pool = BrowserPool.getInstance();
    const poolAny = pool as any;
    const connections = poolAny.connections as Map<string, any>;
    const p0Verified = poolAny.p0Verified as Set<string>;
    const result: any[] = [];

    for (const [windowId, conn] of connections) {
      // ★ 步骤4: 复用 BrowserPool.checkLiveness（CDP连接 + URL + DOM 三层校验 + 失败重试缓冲）
      //   不再在此处维护独立的 liveness 检查逻辑，与 refreshConnectionStatus Step1 用同一份实现
      const liveness = await poolAny.checkLiveness(conn);
      const info: any = {
        windowId,
        name: conn.windowInfo?.name,
        is_connected_db: conn.windowInfo?.is_connected,
        p0Verified: p0Verified.has(windowId),
        alive: liveness.alive,
        tier: liveness.tier,                       // ★ P0-2
        degradedCount: poolAny.getDegradedCount?.(windowId) ?? 0, // ★ P0-2
        browser_isConnected: liveness.browserConnected,
        page_url: liveness.pageUrl,
        hasSidebar: liveness.hasSidebar,
        error: liveness.error,
        pid: null,
      };
      try {
        info.pid = (conn.browser as any).process?.()?.pid ?? null;
      } catch {
        info.pid = 'N/A';
      }
      result.push(info);
    }

    res.json({
      timestamp: new Date().toISOString(),
      connections_count: connections.size,
      p0Verified_count: p0Verified.size,
      connections: result,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/windows/:browerid/toggle — 切换窗口开关状态 */
router.post('/api/windows/:browerid/toggle', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const { browerid } = req.params;
  if (!browerid) {
    res.status(400).json({ error: '缺少 browerid 参数' });
    return;
  }
  try {
    const pool = BrowserPool.getInstance();
    const result = await pool.toggleWindow(browerid);
    res.json(result);
  } catch (e) {
    console.error(`[toggleWindow] ${browerid} 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/windows/:browerid/cleanup-pages — 清理多余标签页 */
router.post('/api/windows/:browerid/cleanup-pages', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const { browerid } = req.params;
  if (!browerid) {
    res.status(400).json({ error: '缺少 browerid 参数' });
    return;
  }
  try {
    const pool = BrowserPool.getInstance();
    const result = await pool.cleanupWindowPages(browerid);
    res.json(result);
  } catch (e) {
    console.error(`[cleanupWindowPages] ${browerid} 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/windows/:browerid/ensure-ready — P0 前置检查（任务前必须调用） */
router.post('/api/windows/:browerid/ensure-ready', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const { browerid } = req.params;
  if (!browerid) {
    res.status(400).json({ error: '缺少 browerid 参数' });
    return;
  }
  try {
    const pool = BrowserPool.getInstance();
    await pool.ensureWindowReady(browerid);
    res.json({ ready: true });
  } catch (e) {
    console.error(`[ensureWindowReady] ${browerid} 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message, ready: false });
  }
});

// ── 窗口初始化任务接口 ──────────────────────────────────

/** POST /api/windows/init — 提交窗口初始化任务 */
router.post('/api/windows/init', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  try {
    const { site_id, window_id } = req.body as { site_id: string; window_id: string };
    if (!site_id || !window_id) {
      return res.status(400).json({ error: '缺少 site_id 或 window_id' });
    }

    // ★ 启动前先行检测 EasyBR 健康状态
    const ebCheck = EasyBRClient.getInstance();
    const health = await ebCheck.checkHealth();
    if (!health.ok) {
      return res.status(503).json({ error: `本地浏览器运行时未就绪: ${health.message}。请先启动本地执行端` });
    }

    // 获取窗口信息（从数据库查找名称/员工）
    const db = Database.getInstance();
    const pg = PgDatabase.getInstance();
    const allWindows = db.listWindows();
    const win = allWindows.find(w => w.id === window_id);
    const staffName = win?.staff_name || window_id;

    // site 标准化：将 site.id 转换为内部 Site code
    const _config = await SettingsManager.getInstance().getConfig();
    const siteCode = normalizeSiteToCode(site_id, _config, 'init_window');

    // Phase 2-C: PG 主写 — 预生成 UUID，先写 PG（PRIMARY），失败直接 500
    const taskId = randomUUID();
    const inputData = { window_id, window_name: win?.name || window_id, site_id };
    try {
      await pg.insertTask({
        id: taskId,
        type: 'init_window',
        siteId: siteCode,
        status: 'pending',
        totalCount: 1,
        doneCount: 0,
        failCount: 0,
        inputData,
        workstationId: getWorkstationId(req),
      });
    } catch (e) {
      console.error('[PG] insertTask init_window failed:', (e as Error).message);
      return res.status(500).json({ error: `任务创建失败（PG写入异常）: ${(e as Error).message}` });
    }

    // LEGACY MIRROR: db.createTask（best-effort，不得掩盖 PG 失败）
    try {
      db.createTask({
        id: taskId,
        type: 'init_window' as TaskType,
        site: siteCode,
        status: 'pending',
        total_count: 1,
        done_count: 0,
        fail_count: 0,
        input_data: JSON.stringify(inputData),
      });
    } catch (e) {
      console.warn('[DB] createTask legacy mirror failed (init_window, non-blocking):', (e as Error).message);
    }

    taskLogManager.addLog(taskId, 'info',
      `窗口初始化任务已创建: site=${site_id}, window=${win?.name || window_id}`,
      'api',
    );

    // 提交给 Engine 异步执行
    const engine = AssignmentEngine.getInstance();
    const assignments: Assignment[] = [{
      staffName,
      waybillNos: [window_id],
      windowId: window_id,
    }];

    engine.execute({
      taskId,
      site: siteCode,
      taskType: 'init_window',
      assignments,
      handler: new InitWindowHandler(),
      handlerTimeoutMs: 120_000, // 2 分钟超时
    }).catch(err => {
      console.error(`[windows/init] 窗口初始化任务异常:`, err.message);
    });

    res.json({ taskId, status: 'pending', windowId: window_id });
  } catch (e) {
    console.error('[POST /api/windows/init] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/windows/status — 返回所有窗口的连接状态及最新 init_task_id（只读，不触发refresh） */
router.get('/api/windows/status', async (_req: Request, res: Response) => {
  try {
    const pool = BrowserPool.getInstance();
    const db = Database.getInstance();

    const allWindows = pool.listWindows();

    // 为每个窗口查找最近的 init_window 任务
    const windowsWithStatus = allWindows.map(w => {
      // 查找该窗口的最近 init_window 任务
      const tasks = db.listTasksByStatus('running').concat(
        db.listTasksByStatus('done'),
        db.listTasksByStatus('failed'),
        db.listTasksByStatus('cancelled'),
      );
      const initTask = tasks
        .filter(t => {
          if (!t.input_data) return false;
          try {
            const parsed = typeof t.input_data === 'string' ? JSON.parse(t.input_data) : t.input_data;
            return t.type === 'init_window' && parsed.window_id === w.id;
          } catch { return false; }
        })
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

      return {
        id: w.id,
        name: w.name,
        role: w.role,
        site: w.site,
        staffName: w.staff_name || null,
        isConnected: w.is_connected === 1,
        updatedAt: w.updated_at,
        latestInitTask: initTask ? {
          taskId: initTask.id,
          status: initTask.status,
          createdAt: initTask.created_at,
          finishedAt: initTask.finished_at || null,
        } : null,
      };
    });

    // 按网点分组
    const bySite: Record<string, typeof windowsWithStatus> = {};
    for (const w of windowsWithStatus) {
      if (!bySite[w.site]) bySite[w.site] = [];
      bySite[w.site].push(w);
    }

    res.json({
      windows: windowsWithStatus,
      bySite,
      totals: {
        total: allWindows.length,
        connected: allWindows.filter(w => w.is_connected === 1).length,
      },
    });
  } catch (e) {
    console.error('[GET /api/windows/status] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 站点窗口 4 态 API（对齐设置中心配置）────────────────────

/** GET /api/sites/:siteId/windows — 返回该网点在设置中心的窗口 × 4 态实时状态 */
router.get('/api/sites/:siteId/windows', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const sm = SettingsManager.getInstance();
    const pool = BrowserPool.getInstance();
    const config = await sm.getConfig();

    if (!config.initialized) {
      return res.json({ siteId, windows: [] });
    }

    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    // ★ 混合数据源：EasyBR 在线状态 + BrowserPool 连接/P0/busy 状态
    // EasyBR openedList 告知哪些窗口已拉起（即使 CDP 未连也显示"已连接"而非灰色）
    const eb = EasyBRClient.getInstance();
    const [browserConfigs, openedWindows] = await Promise.all([
      eb.getBrowerList().catch((e) => {
        console.warn(`[routes] EasyBR getBrowerList 调用失败:`, typeof e === 'object' && 'message' in e ? (e as Error).message : String(e));
        return new Map<string, string>();
      }),
      eb.openedList().catch((e) => {
        console.warn(`[routes] EasyBR openedList 调用失败:`, typeof e === 'object' && 'message' in e ? (e as Error).message : String(e));
        return [] as { browerid: string; isopen: boolean }[];
      }),
    ]);
    const openIds = new Set(openedWindows.filter(w => w.isopen).map(w => w.browerid));
    const nameToId = new Map<string, string>();
    for (const [id, name] of browserConfigs) {
      nameToId.set(name, id);
    }

    // ★ Phase 4-C: 只返回可登录员工（有密码），无密码员工不参与窗口状态管理
    const loginCapableWindows = site.windows.filter(isLoginCapableWindow);

    // ★ 运行时匹配缺失的 browserId（新添加的窗口没有 easybrBrowserId 时自动匹配）
    // 匹配逻辑与 launch-all / syncBrowserIdsToSettings 保持一致
    let configChanged = false;
    const resolvedWindows = loginCapableWindows.map(w => {
      let browserId = (w as any).easybrBrowserId || null;

      if (!browserId) {
        // 1) windowName 精确匹配
        browserId = nameToId.get(w.windowName) || null;
        // 2) siteName-employeeName 精确匹配（如 "天南大-张磊"）
        if (!browserId && w.employeeName) {
          browserId = nameToId.get(`${site.name}-${w.employeeName}`) || null;
        }
        // 3) employeeName 精确匹配
        if (!browserId && w.employeeName) {
          browserId = nameToId.get(w.employeeName) || null;
        }
        // 4) windowName 模糊匹配（includes）
        if (!browserId) {
          for (const [id, name] of browserConfigs) {
            if (w.windowName.includes(name) || name.includes(w.windowName)) {
              browserId = id;
              break;
            }
          }
        }
        // 5) employeeName 模糊匹配
        if (!browserId && w.employeeName) {
          for (const [id, name] of browserConfigs) {
            if (name.includes(w.employeeName)) {
              browserId = id;
              break;
            }
          }
        }

        // 匹配成功 → 回写到配置（持久化，下次无需再匹配）
        if (browserId) {
          (w as any).easybrBrowserId = browserId;
          configChanged = true;
          console.log(`[routes/getSiteWindows] 自动匹配 browserId: ${w.employeeName || w.windowName} → ${browserId.slice(0, 8)}`);
        }
      }

      return { ...w, _resolvedBrowserId: browserId };
    });

    // 如果有新匹配到的 browserId，异步持久化到 settings.json
    if (configChanged) {
      sm.updateConfig(config.sites).catch((e: Error) => {
        console.warn(`[routes/getSiteWindows] 回写 browserId 到配置失败:`, e.message);
      });
    }

    const windows = resolvedWindows.map(w => {
      const browserId = w._resolvedBrowserId;

      // 5) 判定状态
      let state: 'offline' | 'connecting' | 'login_required' | 'connected' | 'ready' | 'busy' | 'degraded';

      // ★ 第 4 批 SSOT：从 BrowserPool 的聚合运行时状态直接读取，不再自行推导
      if (browserId) {
        const rt = pool.getRuntimeState(browserId);
        state = rt.state;
      } else {
        state = 'offline';
      }

      const poolDegraded = browserId ? pool.isWindowDegraded(browserId) : false;

      // ★ 诊断日志：打印 RuntimeState 详情
      if (browserId) {
        const rt = pool.getRuntimeState(browserId);
        console.log(
          `[routes] 状态判定: ${w.employeeName} | browserId=${browserId.slice(0, 8)} | ` +
          `state=${rt.state} | connected=${rt.isConnected} | p0=${rt.isP0Verified} | loginRequired=${rt.isLoginRequired} | busy=${rt.isBusy} | connecting=${rt.isConnecting} | ` +
          `degraded=${rt.isDegraded} | updatedAt=${rt.updatedAt}`,
        );
      } else {
        console.log(
          `[routes] 状态判定: ${w.employeeName} | browserId=null (未匹配到EasyBR浏览器) | → OFFLINE`,
        );
      }

      return {
        windowName: w.windowName,
        employeeName: w.employeeName,
        browserId,
        status: state,
        isDegraded: poolDegraded,
        degradedCount: browserId ? pool.getDegradedCount(browserId) : 0,
      };
    });

    // ★ 步骤6: 附带 easybrHealth 字段（包含熔断器状态、openedList 异常、重连提示）
    const ebHealth = eb.getHealthStatus();
    const easybrHealth = {
      openedListAbnormal: ebHealth.openedListAbnormal,
      anomalyDurationMs: ebHealth.openedListAbnormalDurationMs,
      circuitBreakerOpen: ebHealth.circuitBreakerOpen,
      circuitBreakerRemainingMs: ebHealth.circuitBreakerRemainingMs,
      reconnectNeeded: ebHealth.reconnectNeeded,
      message: ebHealth.message,
    };

    res.json({
      siteId,
      siteName: site.name,
      windows,
      easybrHealth,
    });
  } catch (e) {
    console.error(`[GET /api/sites/${req.params.siteId}/windows] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/sites/:siteId/windows/launch-all — 一键启动该网点全部窗口 */
router.post('/api/sites/:siteId/windows/launch-all', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  try {
    const { siteId } = req.params;
    const sm = SettingsManager.getInstance();
    const pool = BrowserPool.getInstance();
    const config = await sm.getConfig();

    if (!config.initialized) {
      return res.status(400).json({ error: '系统尚未完成 PIN 初始化' });
    }

    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    const ebHealth = EasyBRClient.getInstance();
    const health = await ebHealth.checkHealth();
    if (!health.ok) {
      return res.status(503).json({ error: `本地浏览器运行时未就绪: ${health.message}。请先启动本地执行端` });
    }

    const eb = EasyBRClient.getInstance();
    const browserConfigs = await eb.getBrowerList().catch((e) => {
      console.warn(`[routes/launch-all] EasyBR getBrowerList 调用失败:`, typeof e === 'object' && 'message' in e ? (e as Error).message : String(e));
      return new Map<string, string>();
    });
    const nameToId = new Map<string, string>();
    for (const [id, name] of browserConfigs) {
      nameToId.set(name, id);
    }

    // ★ Phase 4-C: 只启动可登录员工（有密码），无密码员工不能作为执行窗口
    const loginCapableWindows = site.windows.filter(isLoginCapableWindow);
    const totalWindows = site.windows.length;
    const skippedNoPassword = site.windows.length - loginCapableWindows.length;
    if (skippedNoPassword > 0) {
      console.log(`[launch-all] 跳过 ${skippedNoPassword} 个无密码员工（仅目标派件员）`);
    }
    const toLaunch: { windowName: string; employeeName: string; browserId: string }[] = [];
    for (const w of loginCapableWindows) {
      let browserId = (w as any).easybrBrowserId || null;
      if (!browserId) {
        browserId = nameToId.get(w.windowName) || null;
      }
      if (!browserId) {
        for (const [id, name] of browserConfigs) {
          if (w.windowName.includes(name) || name.includes(w.windowName)) { browserId = id; break; }
        }
      }
      if (!browserId && w.employeeName) {
        for (const [id, name] of browserConfigs) {
          if (name.includes(w.employeeName)) { browserId = id; break; }
        }
      }
      if (!browserId) {
        console.warn(`[launch-all] 窗口 ${w.windowName}(${w.employeeName}) 未匹配到 EasyBR browserId，跳过`);
        continue;
      }
      toLaunch.push({ windowName: w.windowName, employeeName: w.employeeName, browserId });
    }

    if (toLaunch.length === 0) {
      return res.json({
        launched: 0, failed: 0, total: totalWindows, partial: 0,
        timeout: false, success: true,
        message: '所有窗口已就绪',
        windows: [],
      });
    }

    const timeoutMs = Math.min(15000 + Math.ceil(toLaunch.length / 2) * 25000, 120000);
    const startTime = Date.now();

    console.log(`[launch-all] start siteId=${siteId} total=${totalWindows} toLaunch=${toLaunch.length} timeoutMs=${timeoutMs}`);

    let completedCount = 0;
    const timeoutSymbol = Symbol('timeout');
    const partialResults: Array<{ windowName: string; staffName: string; browserId: string; status: string; ready: boolean; message?: string } | null> = toLaunch.map(() => null);
    const launchPromises = toLaunch.map(async (w, idx) => {
      const staffLabel = w.employeeName || w.windowName;
      console.log(`[launch-all] ensureWindowOpen start browserId=${w.browserId.slice(0, 8)}... staffName=${staffLabel}`);
      try {
        const result = await pool.ensureWindowOpen(w.browserId);
        completedCount++;
        console.log(`[launch-all] result staffName=${staffLabel} browserId=${w.browserId.slice(0, 8)}... status=${result.status} ready=${result.ready} message=${result.message || ''}`);
        let responseStatus: string;
        if (result.ready) {
          responseStatus = result.status === 'already_ready' ? 'already_ready' : 'ready';
        } else if (result.status === 'login_required') {
          responseStatus = 'login_required';
        } else if (result.status === 'not_ready' || result.status === 'connected') {
          responseStatus = 'not_ready';
        } else {
          responseStatus = 'failed';
        }
        const r = {
          windowName: w.windowName,
          staffName: staffLabel,
          browserId: w.browserId,
          status: responseStatus,
          ready: result.ready,
          message: result.message,
        };
        partialResults[idx] = r;
        return r;
      } catch (e) {
        completedCount++;
        const errMsg = (e as Error).message;
        console.error(`[launch-all] failed staffName=${staffLabel} browserId=${w.browserId.slice(0, 8)}... error=${errMsg}`);
        const r = { windowName: w.windowName, staffName: staffLabel, browserId: w.browserId, status: 'failed' as const, ready: false, message: errMsg };
        partialResults[idx] = r;
        return r;
      }
    });

    const withTimeout = await Promise.race([
      Promise.allSettled(launchPromises),
      new Promise<typeof timeoutSymbol>(resolve => setTimeout(() => resolve(timeoutSymbol), timeoutMs)),
    ]);

    if (withTimeout === timeoutSymbol) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      let timedOutReady = 0;
      let timedOutPartial = 0;
      let timedOutFailed = 0;
      const timedOutWindows = toLaunch.map((w, idx) => {
        const done = partialResults[idx];
        if (done) {
          if (done.status === 'ready' || done.status === 'already_ready') { timedOutReady++; }
          else if (done.status === 'failed') { timedOutFailed++; }
          else { timedOutPartial++; }
          return done;
        }
        timedOutPartial++;
        return {
          windowName: w.windowName, staffName: w.employeeName || w.windowName,
          browserId: w.browserId, status: 'launching', ready: false, message: '启动中，请稍后刷新',
        };
      });
      console.warn(`[launch-all] timeout siteId=${siteId} total=${toLaunch.length} completed=${completedCount} ready=${timedOutReady} failed=${timedOutFailed} timeoutMs=${timeoutMs} message=窗口仍在后台启动中`);
      return res.json({
        launched: timedOutReady, failed: timedOutFailed, total: totalWindows, partial: timedOutPartial,
        timeout: true, success: false,
        message: '窗口仍在后台启动中，请稍后查看状态',
        windows: timedOutWindows,
      });
    }

    const results = withTimeout as PromiseSettledResult<{ windowName: string; staffName: string; browserId: string; status: string; ready: boolean; message?: string }>[];
    let readyCount = 0;
    let failedCount = 0;
    let partialCount = 0;
    const windowsResult = results.map(r => {
      if (r.status === 'rejected') {
        failedCount++;
        return { windowName: '', staffName: '', browserId: '', status: 'failed' as const, ready: false, message: r.reason?.message || '未知错误' };
      }
      const v = r.value;
      if (v.status === 'ready' || v.status === 'already_ready') {
        readyCount++;
      } else if (v.status === 'failed') {
        failedCount++;
      } else {
        partialCount++;
      }
      return v;
    });

    const success = failedCount === 0 && readyCount > 0;
    let message: string;
    if (failedCount === 0 && partialCount === 0) {
      message = `窗口启动完成，${readyCount} 个窗口已就绪`;
    } else if (failedCount === 0) {
      message = `${readyCount} 个窗口已就绪，${partialCount} 个窗口仍在连接或需要登录，请稍后查看状态`;
    } else {
      message = `${readyCount} 个窗口已就绪，${partialCount} 个连接中，${failedCount} 个失败，请查看窗口状态或后端日志`;
    }

    console.log(`[launch-all] done siteId=${siteId} ready=${readyCount} partial=${partialCount} failed=${failedCount} total=${toLaunch.length}`);

    res.json({
      launched: readyCount,
      failed: failedCount,
      total: totalWindows,
      partial: partialCount,
      timeout: false,
      success,
      message,
      windows: windowsResult,
    });
  } catch (e) {
    console.error(`[POST /api/sites/${req.params.siteId}/windows/launch-all] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── EasyBR 浏览器控制接口 ──────────────────────────────

/** POST /api/easybr/open-browser — 直接调用 EasyBR 打开/聚焦指定浏览器窗口 */
router.post('/api/easybr/open-browser', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  try {
    const { browserId } = req.body as { browserId: string };
    if (!browserId) {
      return res.status(400).json({ error: '缺少 browserId 参数' });
    }
    const eb = EasyBRClient.getInstance();
    // ★ 先检测 EasyBR 健康
    const health = await eb.checkHealth();
    if (!health.ok) {
      return res.status(503).json({ error: `本地浏览器运行时未就绪: ${health.message}。请先启动本地执行端` });
    }
    const result = await eb.openBrower(browserId);
    res.json({ ok: true, ws: result.ws, http: result.http });
  } catch (e) {
    console.error('[POST /api/easybr/open-browser] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/easybr/reconnect — 手动重置 EasyBR 连接（用户重启 EasyBR 后调用，清除熔断器/缓存/异常状态） */
router.post('/api/easybr/reconnect', async (_req: Request, res: Response) => {
  try {
    const eb = EasyBRClient.getInstance();
    eb.resetConnection();
    // 立即尝试一次健康检查验证连接
    const health = await eb.checkHealth();
    res.json({ ok: health.ok, message: health.message });
  } catch (e) {
    console.error('[POST /api/easybr/reconnect] 失败:', (e as Error).message);
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ── 诊断接口（只读）──────────────────────────────────

/** GET /api/debug/window-state/:id — 获取窗口完整诊断信息（只读） */
router.get('/api/debug/window-state/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const pool = BrowserPool.getInstance();
    const diagnostics = pool.getWindowDiagnostics(id);
    res.json(diagnostics);
  } catch (e) {
    console.error('[GET /api/debug/window-state/:id] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/debug/windows — 获取所有窗口诊断信息（只读） */
router.get('/api/debug/windows', async (_req: Request, res: Response) => {
  try {
    const pool = BrowserPool.getInstance();
    const allWindows = pool.listWindows();
    const diagnostics = allWindows.map(w => pool.getWindowDiagnostics(w.id));
    res.json({ count: diagnostics.length, windows: diagnostics });
  } catch (e) {
    console.error('[GET /api/debug/windows] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── 系统设置接口 ──────────────────────────────────────

/** POST /api/settings/init — 首次初始化系统 PIN */
router.post('/api/settings/init', async (req: Request, res: Response) => {
  try {
    const { pin } = req.body as { pin: string };
    if (!pin || pin.length < 4) {
      return res.status(400).json({ error: 'PIN 码至少 4 位' });
    }
    const sm = SettingsManager.getInstance();
    await sm.init(pin);
    res.json({ ok: true, message: '系统初始化完成' });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('已初始化')) {
      return res.status(409).json({ error: msg });
    }
    console.error('[settings/init]', msg);
    res.status(500).json({ error: msg });
  }
});

/** POST /api/settings/verify-pin — 验证管理员 PIN */
router.post('/api/settings/verify-pin', async (req: Request, res: Response) => {
  try {
    const { pin } = req.body as { pin: string };
    if (!pin) {
      return res.status(400).json({ error: '缺少 PIN 码' });
    }
    const sm = SettingsManager.getInstance();
    const ok = await sm.verifyPin(pin);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'PIN 码错误' });
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('未初始化')) {
      return res.status(403).json({ error: msg });
    }
    console.error('[settings/verify-pin]', msg);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/settings/config — 获取系统配置 */
router.get('/api/settings/config', async (_req: Request, res: Response) => {
  try {
    const sm = SettingsManager.getInstance();
    const config = await sm.getConfig();
    res.json(config);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'NOT_INITIALIZED') {
      return res.status(404).json({ initialized: false, sites: [], error: '系统未初始化' });
    }
    console.error('[settings/config GET]', msg);
    res.status(500).json({ initialized: false, sites: [], error: msg });
  }
});

/** PUT /api/settings/config — 更新系统配置 */
router.put('/api/settings/config', async (req: Request, res: Response) => {
  try {
    const { sites } = req.body as { sites: unknown[] };
    if (!Array.isArray(sites)) {
      return res.status(400).json({ error: '参数 sites 必须是数组' });
    }
    const sm = SettingsManager.getInstance();
    const pg = PgDatabase.getInstance();
    await sm.updateConfig(sites as any);
    // 同步网点 id/name 到 PG sites 表（保证任务列表 JOIN 兜底也能拿到正确名称）
    try {
      await pg.syncSitesFromSettings(sites as any);
    } catch (syncErr) {
      console.warn('[settings/config PUT] 同步 sites 到 PG 失败（不影响主流程）:', (syncErr as Error).message);
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('未初始化')) {
      return res.status(403).json({ error: msg });
    }
    console.error('[settings/config PUT]', msg);
    res.status(500).json({ error: msg });
  }
});

// ── 任务操作接口 ──────────────────────────────────────

/**
 * ★ P0 安全加固：校验 assignments 中所有 staffName 是否属于指定 site
 *
 * 防止跨站点员工混入任务分配。settings.json 是员工归属的真理源。
 *
 * @returns ok=true 通过；ok=false 时 invalidStaff 为非法员工列表
 */
async function validateAssignmentsBelongToSite(
  site: string,
  assignments: Assignment[],
): Promise<{ ok: boolean; invalidStaff?: string[] }> {
  if (assignments.length === 0) return { ok: true };
  const sm = SettingsManager.getInstance();
  const invalidStaff: string[] = [];
  for (const a of assignments) {
    const belongs = await sm.isStaffBelongsToSite(site, a.staffName);
    if (!belongs) {
      invalidStaff.push(a.staffName);
    }
  }
  if (invalidStaff.length > 0) {
    return { ok: false, invalidStaff };
  }
  return { ok: true };
}

/** POST /api/operations/arrive — 提交到件任务
 *
 * 支持两种请求体（优先 assignments，向后兼容 waybillNos）：
 *   1. { site, assignments } — 多窗口并发（与 dispatch/integrated 一致）
 *   2. { site, waybillNos }  — 旧兼容模式，自动选择单个在线 Worker
 */
router.post('/api/operations/arrive', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const db = Database.getInstance();
  const pg = PgDatabase.getInstance();

  // 1. 请求体校验
  const { site, assignments, waybillNos, dryRunMode } = req.body as {
    site: string;
    assignments?: Assignment[];
    waybillNos?: string[];
    dryRunMode?: boolean;
  };

  if (!site) {
    return res.status(400).json({ error: '参数 site 不能为空' });
  }
  const _config = await SettingsManager.getInstance().getConfig();
  const _validSiteIds = _config.sites.map(s => s.id);
  if (!_validSiteIds.includes(site)) {
    return res.status(400).json({ error: `参数 site 无效，已配置站点: ${_validSiteIds.join(', ') || '无'}` });
  }

  // 优先 assignments；缺省时回退到 waybillNos 旧模式
  let finalAssignments: Assignment[];
  if (Array.isArray(assignments) && assignments.length > 0) {
    finalAssignments = assignments;
  } else if (Array.isArray(waybillNos) && waybillNos.length > 0) {
    // 旧模式：延迟到异步执行块再 selectOnlineWorker，此处仅占位标记
    finalAssignments = [];
  } else {
    return res.status(400).json({ error: '参数 assignments 或 waybillNos 必须提供其一且为非空数组' });
  }

  // ★ P0 安全加固：校验 assignments 员工归属，禁止跨站点员工混入
  if (finalAssignments.length > 0) {
    const check = await validateAssignmentsBelongToSite(site, finalAssignments);
    if (!check.ok) {
      const names = check.invalidStaff!.join('、');
      return res.status(400).json({ error: `员工 "${names}" 不属于当前网点，请切换网点后重新选择员工` });
    }
  }

  // ★ 速率保护：保护 EasyBR 稳定性，每秒最多 1 个任务
  const rate = checkTaskRate();
  if (!rate.allowed) {
    return res.status(429).json({ error: `请稍后再试 (${Math.ceil(rate.waitMs / 1000)}秒)`, retryAfter: Math.ceil(rate.waitMs / 1000) });
  }

  const totalCount = finalAssignments.length > 0
    ? finalAssignments.reduce((s, a) => s + a.waybillNos.length, 0)
    : waybillNos!.length;

  // 2. 创建任务记录
  // ★ 交付前加固：site 字段统一存 siteCode（如 'tiannanda'），与 PG 一致
  //   旧实现存 raw site.id（如 'site-1782121346155'），导致 SQLite 与 PG 不一致
  const siteCode = normalizeSiteToCode(site, _config, 'arrival');

  // Phase 2-C: PG 主写 — 预生成 UUID，先写 PG（PRIMARY），失败直接 500
  const taskId = randomUUID();
  const inputData = finalAssignments.length > 0
    ? { assignments, browserDryRun: dryRunMode === true, dryRun: dryRunMode === true }
    : { waybillNos, browserDryRun: dryRunMode === true, dryRun: dryRunMode === true };
  try {
    await pg.insertTask({
      id: taskId,
      type: 'arrival',
      siteId: siteCode,
      status: 'pending',
      totalCount,
      doneCount: 0,
      failCount: 0,
      inputData,
      workstationId: getWorkstationId(req),
    });
  } catch (e) {
    console.error('[PG] insertTask arrival failed:', (e as Error).message);
    return res.status(500).json({ error: `任务创建失败（PG写入异常）: ${(e as Error).message}` });
  }

  // LEGACY MIRROR: db.createTask（best-effort，不得掩盖 PG 失败）
  try {
    db.createTask({
      id: taskId,
      type: 'arrival',
      site: siteCode,
      status: 'pending',
      total_count: totalCount,
      done_count: 0,
      fail_count: 0,
      input_data: JSON.stringify(inputData),
    });
  } catch (e) {
    console.warn('[DB] createTask legacy mirror failed (arrive, non-blocking):', (e as Error).message);
  }

  const startLog = `任务开始: 到件扫描, 单号数=${totalCount}, 员工数=${finalAssignments.length || '(自动)'}`;
  taskLogManager.addLog(taskId, 'info', startLog, 'api');
  await taskLogService.appendLogs(taskId, [{ level: 'info', message: startLog }], {
    tenantId: getTenantId(req),
    workstationId: getWorkstationId(req),
    source: 'api',
  }).catch(e => console.warn('[PG] append start log arrival failed:', (e as Error).message));

  // 3. 立即返回（任务由 Agent 从 PG 拉取执行，不再由 AssignmentEngine 直接执行）
  res.json({ taskId, status: 'pending' });
});

/** POST /api/operations/dispatch — 提交派件任务（多员工并发） */
router.post('/api/operations/dispatch', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const db = Database.getInstance();
  const pg = PgDatabase.getInstance();

  // 1. 请求体校验
  const { site, assignments, executionMode: rawExecutionMode, dryRunMode } = req.body as {
    site: string;
    assignments: DispatchAssignment[];
    executionMode?: string;
    dryRunMode?: boolean;
  };
  const executionMode = rawExecutionMode || 'default';
  if (executionMode !== 'default' && executionMode !== 'designated') {
    return res.status(400).json({ error: '参数 executionMode 需为 default 或 designated' });
  }

  if (!site) {
    return res.status(400).json({ error: '参数 site 不能为空' });
  }
  const _config = await SettingsManager.getInstance().getConfig();
  const _validSiteIds = _config.sites.map(s => s.id);
  if (!_validSiteIds.includes(site)) {
    return res.status(400).json({ error: `参数 site 无效，已配置站点: ${_validSiteIds.join(', ') || '无'}` });
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: '参数 assignments 必须为非空数组' });
  }
  for (const a of assignments) {
    if (!a.staffName || !Array.isArray(a.waybillNos) || a.waybillNos.length === 0) {
      return res.status(400).json({ error: '每个 assignment 需含 staffName 和非空 waybillNos' });
    }
  }

  // ★ P0 安全加固：校验 assignments 员工归属，禁止跨站点员工混入
  const staffCheck = await validateAssignmentsBelongToSite(site, assignments);
  if (!staffCheck.ok) {
    const names = staffCheck.invalidStaff!.join('、');
    return res.status(400).json({ error: `员工 "${names}" 不属于当前网点，请切换网点后重新选择员工` });
  }

  // Phase 2-B: 指定模式校验
  if (executionMode === 'designated') {
    if (assignments.length !== 1) {
      return res.status(400).json({ error: '指定模式仅支持单个执行窗口' });
    }
    const a = assignments[0];
    if (!a.targetCourierName) {
      return res.status(400).json({ error: '指定模式必须选择目标派件员' });
    }
    if (!a.targetCourierAccount) {
      return res.status(400).json({ error: '指定模式目标派件员账号不能为空' });
    }
    // 校验目标派件员归属
    const targetCheck = await validateAssignmentsBelongToSite(site, [{ staffName: a.targetCourierName, waybillNos: [] } as Assignment]);
    if (!targetCheck.ok) {
      return res.status(400).json({ error: '目标派件员不属于当前网点' });
    }
  }

  const totalCount = assignments.reduce((s, a) => s + a.waybillNos.length, 0);

  // ★ 速率保护：保护 EasyBR 稳定性，每秒最多 1 个任务
  const rate = checkTaskRate();
  if (!rate.allowed) {
    return res.status(429).json({ error: `请稍后再试 (${Math.ceil(rate.waitMs / 1000)}秒)`, retryAfter: Math.ceil(rate.waitMs / 1000) });
  }

  // 2. 创建任务记录
  // ★ 交付前加固：site 字段统一存 siteCode（如 'tiannanda'），与 PG 一致
  const siteCode = normalizeSiteToCode(site, _config, 'dispatch');

  // Phase 2-C: PG 主写 — 预生成 UUID，先写 PG（PRIMARY），失败直接 500
  const taskId = randomUUID();
  const inputData = { executionMode, assignments, browserDryRun: dryRunMode === true, dryRun: dryRunMode === true };
  try {
    await pg.insertTask({
      id: taskId,
      type: 'dispatch',
      siteId: siteCode,
      status: 'pending',
      totalCount,
      doneCount: 0,
      failCount: 0,
      inputData,
      workstationId: getWorkstationId(req),
    });
  } catch (e) {
    console.error('[PG] insertTask dispatch failed:', (e as Error).message);
    return res.status(500).json({ error: `任务创建失败（PG写入异常）: ${(e as Error).message}` });
  }

  // LEGACY MIRROR: db.createTask（best-effort，不得掩盖 PG 失败）
  try {
    db.createTask({
      id: taskId,
      type: 'dispatch',
      site: siteCode,
      status: 'pending',
      total_count: totalCount,
      done_count: 0,
      fail_count: 0,
      input_data: JSON.stringify(inputData),
    });
  } catch (e) {
    console.warn('[DB] createTask legacy mirror failed (dispatch, non-blocking):', (e as Error).message);
  }

  const startLog = `任务开始: 派件扫描, 员工数=${assignments.length}, 单号数=${totalCount}`;
  taskLogManager.addLog(taskId, 'info', startLog, 'api');
  await taskLogService.appendLogs(taskId, [{ level: 'info', message: startLog }], {
    tenantId: getTenantId(req),
    workstationId: getWorkstationId(req),
    source: 'api',
  }).catch(e => console.warn('[PG] append start log dispatch failed:', (e as Error).message));

  // 3. 立即返回（任务由 Agent 从 PG 拉取执行，不再由 AssignmentEngine 直接执行）
  res.json({ taskId, status: 'pending' });
});

/** POST /api/operations/integrated — 提交到派一体任务（多员工并发） */
router.post('/api/operations/integrated', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const db = Database.getInstance();
  const pg = PgDatabase.getInstance();

  // 1. 请求体校验
  const { site, assignments, executionMode: rawExecutionMode, dryRunMode } = req.body as {
    site: string;
    assignments: IntegratedAssignment[];
    executionMode?: string;
    dryRunMode?: boolean;
  };
  const executionMode = rawExecutionMode || 'default';
  if (executionMode !== 'default' && executionMode !== 'designated') {
    return res.status(400).json({ error: '参数 executionMode 需为 default 或 designated' });
  }

  if (!site) {
    return res.status(400).json({ error: '参数 site 不能为空' });
  }
  const _config = await SettingsManager.getInstance().getConfig();
  const _validSiteIds = _config.sites.map(s => s.id);
  if (!_validSiteIds.includes(site)) {
    return res.status(400).json({ error: `参数 site 无效，已配置站点: ${_validSiteIds.join(', ') || '无'}` });
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: '参数 assignments 必须为非空数组' });
  }
  for (const a of assignments) {
    if (!a.staffName || !Array.isArray(a.waybillNos) || a.waybillNos.length === 0) {
      return res.status(400).json({ error: '每个 assignment 需含 staffName 和非空 waybillNos' });
    }
  }

  // ★ P0 安全加固：校验 assignments 员工归属，禁止跨站点员工混入
  const staffCheck = await validateAssignmentsBelongToSite(site, assignments);
  if (!staffCheck.ok) {
    const names = staffCheck.invalidStaff!.join('、');
    return res.status(400).json({ error: `员工 "${names}" 不属于当前网点，请切换网点后重新选择员工` });
  }

  // Phase 2-B: 指定模式校验
  if (executionMode === 'designated') {
    if (assignments.length !== 1) {
      return res.status(400).json({ error: '指定模式仅支持单个执行窗口' });
    }
    const a = assignments[0];
    if (!a.targetCourierName) {
      return res.status(400).json({ error: '指定模式必须选择目标派件员' });
    }
    if (!a.targetCourierAccount) {
      return res.status(400).json({ error: '指定模式目标派件员账号不能为空' });
    }
    // 校验目标派件员归属
    const targetCheck = await validateAssignmentsBelongToSite(site, [{ staffName: a.targetCourierName, waybillNos: [] } as Assignment]);
    if (!targetCheck.ok) {
      return res.status(400).json({ error: '目标派件员不属于当前网点' });
    }
  }

  const totalCount = assignments.reduce((s, a) => s + a.waybillNos.length, 0);

  // ★ 速率保护：保护 EasyBR 稳定性，每秒最多 1 个任务
  const rate = checkTaskRate();
  if (!rate.allowed) {
    return res.status(429).json({ error: `请稍后再试 (${Math.ceil(rate.waitMs / 1000)}秒)`, retryAfter: Math.ceil(rate.waitMs / 1000) });
  }

  // 2. 创建任务记录
  // ★ 交付前加固：site 字段统一存 siteCode（如 'tiannanda'），与 PG 一致
  const siteCode = normalizeSiteToCode(site, _config, 'integrated');

  // Phase 2-C: PG 主写 — 预生成 UUID，先写 PG（PRIMARY），失败直接 500
  const taskId = randomUUID();
  const inputData = { executionMode, assignments, browserDryRun: dryRunMode === true, dryRun: dryRunMode === true };
  try {
    await pg.insertTask({
      id: taskId,
      type: 'integrated',
      siteId: siteCode,
      status: 'pending',
      totalCount,
      doneCount: 0,
      failCount: 0,
      inputData,
      workstationId: getWorkstationId(req),
    });
  } catch (e) {
    console.error('[PG] insertTask integrated failed:', (e as Error).message);
    return res.status(500).json({ error: `任务创建失败（PG写入异常）: ${(e as Error).message}` });
  }

  // LEGACY MIRROR: db.createTask（best-effort，不得掩盖 PG 失败）
  try {
    db.createTask({
      id: taskId,
      type: 'integrated',
      site: siteCode,
      status: 'pending',
      total_count: totalCount,
      done_count: 0,
      fail_count: 0,
      input_data: JSON.stringify(inputData),
    });
  } catch (e) {
    console.warn('[DB] createTask legacy mirror failed (integrated, non-blocking):', (e as Error).message);
  }

  const startLog = `任务开始: 到派一体扫描, 员工数=${assignments.length}, 单号数=${totalCount}`;
  taskLogManager.addLog(taskId, 'info', startLog, 'api');
  await taskLogService.appendLogs(taskId, [{ level: 'info', message: startLog }], {
    tenantId: getTenantId(req),
    workstationId: getWorkstationId(req),
    source: 'api',
  }).catch(e => console.warn('[PG] append start log integrated failed:', (e as Error).message));

  // 3. 立即返回（任务由 Agent 从 PG 拉取执行，不再由 AssignmentEngine 直接执行）
  res.json({ taskId, status: 'pending' });
});

/** POST /api/operations/sign — 提交签收任务（Phase E-1: 预览模式，多员工并发） */
router.post('/api/operations/sign', async (req: Request, res: Response) => {
  if (!requireRuntimeAvailable(res)) return;
  const db = Database.getInstance();
  const pg = PgDatabase.getInstance();

  // 1. 请求体校验
  const { site, assignments, executionMode: rawExecutionMode, dryRunMode } = req.body as {
    site: string;
    assignments: SignAssignment[];
    executionMode?: string;
    dryRunMode?: boolean;
  };
  const executionMode = rawExecutionMode || 'default';
  if (executionMode !== 'default' && executionMode !== 'designated') {
    return res.status(400).json({ error: '参数 executionMode 需为 default 或 designated' });
  }

  if (!site) {
    return res.status(400).json({ error: '参数 site 不能为空' });
  }
  const _config = await SettingsManager.getInstance().getConfig();
  const _validSiteIds = _config.sites.map(s => s.id);
  if (!_validSiteIds.includes(site)) {
    return res.status(400).json({ error: `参数 site 无效，已配置站点: ${_validSiteIds.join(', ') || '无'}` });
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res.status(400).json({ error: '参数 assignments 必须为非空数组' });
  }
  for (const a of assignments) {
    if (!a.staffName) {
      return res.status(400).json({ error: '每个 assignment 需含 staffName' });
    }
  }

  // ★ P0 安全加固：校验 assignments 员工归属，禁止跨站点员工混入
  const signStaffCheck = await validateAssignmentsBelongToSite(site, assignments);
  if (!signStaffCheck.ok) {
    const names = signStaffCheck.invalidStaff!.join('、');
    return res.status(400).json({ error: `员工 "${names}" 不属于当前网点，请切换网点后重新选择员工` });
  }

  // Phase 2-B: 指定模式校验
  if (executionMode === 'designated') {
    if (assignments.length !== 1) {
      return res.status(400).json({ error: '指定模式仅支持单个执行窗口' });
    }
    const a = assignments[0];
    if (!a.targetCourierName) {
      return res.status(400).json({ error: '指定模式必须选择目标派件员' });
    }
    if (!a.targetCourierAccount) {
      return res.status(400).json({ error: '指定模式目标派件员账号不能为空' });
    }
    // 校验目标派件员归属
    const targetCheck = await validateAssignmentsBelongToSite(site, [{ staffName: a.targetCourierName, waybillNos: [] } as Assignment]);
    if (!targetCheck.ok) {
      return res.status(400).json({ error: '目标派件员不属于当前网点' });
    }
  }

  // Phase E-1: 签收为预览模式，每个员工 1 个占位运单（用于 Engine 进度统计）
  const totalCount = assignments.length;

  // ★ 速率保护：保护 EasyBR 稳定性，每秒最多 1 个任务
  const rate = checkTaskRate();
  if (!rate.allowed) {
    return res.status(429).json({ error: `请稍后再试 (${Math.ceil(rate.waitMs / 1000)}秒)`, retryAfter: Math.ceil(rate.waitMs / 1000) });
  }

  // 2. 创建任务记录
  // ★ 交付前加固：site 字段统一存 siteCode（如 'tiannanda'），与 PG 一致
  const siteCode = normalizeSiteToCode(site, _config, 'sign');

  // Phase 2-C: PG 主写 — 预生成 UUID，先写 PG（PRIMARY），失败直接 500
  const taskId = randomUUID();
  const inputData = { executionMode, assignments, browserDryRun: dryRunMode === true, dryRun: dryRunMode === true };
  try {
    await pg.insertTask({
      id: taskId,
      type: 'sign',
      siteId: siteCode,
      status: 'pending',
      totalCount,
      doneCount: 0,
      failCount: 0,
      inputData,
      workstationId: getWorkstationId(req),
    });
  } catch (e) {
    console.error('[PG] insertTask sign failed:', (e as Error).message);
    return res.status(500).json({ error: `任务创建失败（PG写入异常）: ${(e as Error).message}` });
  }

  // LEGACY MIRROR: db.createTask（best-effort，不得掩盖 PG 失败）
  try {
    db.createTask({
      id: taskId,
      type: 'sign',
      site: siteCode,
      status: 'pending',
      total_count: totalCount,
      done_count: 0,
      fail_count: 0,
      input_data: JSON.stringify(inputData),
    });
  } catch (e) {
    console.warn('[DB] createTask legacy mirror failed (sign, non-blocking):', (e as Error).message);
  }

  const startLog = `任务开始: 签收录入(预览模式), 员工数=${assignments.length}`;
  const dryRunLog = `SIGN_DRY_RUN=true，将停止在签收确认弹窗，禁止真实签收`;
  taskLogManager.addLog(taskId, 'info', startLog, 'api');
  taskLogManager.addLog(taskId, 'info', dryRunLog, 'api');
  await taskLogService.appendLogs(taskId, [
    { level: 'info', message: startLog },
    { level: 'info', message: dryRunLog },
  ], {
    tenantId: getTenantId(req),
    workstationId: getWorkstationId(req),
    source: 'api',
  }).catch(e => console.warn('[PG] append start log sign failed:', (e as Error).message));

  // 3. 立即返回（任务由 Agent 从 PG 拉取执行，不再由 AssignmentEngine 直接执行）
  res.json({ taskId, status: 'pending' });
});

/** GET /api/operations/stats — 服务端聚合统计 + 系统状态（必须在 /:taskId 之前注册） */
router.get('/api/operations/stats', async (req: Request, res: Response) => {
  try {
    // Phase 3-D-2: BrowserPool 不可用时仍返回有效统计
    let onlineWindows = 0;
    let easybrConnected = false;
    try {
      const bp = BrowserPool.getInstance();
      onlineWindows = bp.getConnectedCount();
      easybrConnected = onlineWindows > 0;
    } catch (bpErr) {
      console.warn('[GET /api/operations/stats] BrowserPool 不可用:', (bpErr as Error).message);
    }
    const engine = AssignmentEngine.getInstance();
    const activeWorkers = engine.getActiveWorkerCount();

    // ★ 交付前加固：PG 不可用时降级到本地 SQLite 统计，不再返回 500
    //   优先级：PG → SQLite Database → 空统计
    let stats: {
      total: number;
      running: number;
      done: number;
      failed: number;
      cancelled: number;
      pending: number;
    };
    let degraded = false;
    let statsSource: 'pg' | 'fallback' | 'empty' = 'pg';
    let statsWarning: string | undefined;

    try {
      const pg = PgDatabase.getInstance();
      stats = await pg.getTaskStats(getTenantId(req));
    } catch (pgErr) {
      // PG 不可用，降级到本地 SQLite 统计
      console.error('[GET /api/operations/stats] PG 不可用，降级到本地统计:', (pgErr as Error).message);
      degraded = true;
      statsSource = 'fallback';
      statsWarning = 'PostgreSQL 不可用，当前统计为降级数据';
      try {
        const db = Database.getInstance();
        const running = db.listTasksByStatus('running').length;
        const done = db.listTasksByStatus('done').length;
        const failed = db.listTasksByStatus('failed').length;
        const cancelled = db.listTasksByStatus('cancelled').length;
        const pending = db.listTasksByStatus('pending').length;
        stats = {
          total: running + done + failed + cancelled + pending,
          running, done, failed, cancelled, pending,
        };
      } catch (dbErr) {
        // SQLite 也不可用，返回空统计（不让前端崩溃）
        console.error('[GET /api/operations/stats] 本地统计也不可用:', (dbErr as Error).message);
        statsSource = 'empty';
        stats = { total: 0, running: 0, done: 0, failed: 0, cancelled: 0, pending: 0 };
      }
    }

    // 一致性校验：runningTasks > activeWorkers 时返回 warning
    const warning =
      stats.running > 0 && stats.running > activeWorkers
        ? '发现异常运行任务，请检查任务状态。'
        : statsWarning;

    res.json({
      tasks: stats,
      system: {
        easybrConnected,
        onlineWindows,
        activeWorkers,
        runningTasks: stats.running,
      },
      warning,
      degraded,
      source: statsSource,
    });
  } catch (e) {
    console.error('[GET /api/operations/stats] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/operations/:taskId — 查询任务进度和结果 */
router.get('/api/operations/:taskId', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const db = Database.getInstance();
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    // C6: result_data 可能损坏，安全解析
    let results: unknown[] = [];
    if (task.result_data) {
      try {
        results = JSON.parse(task.result_data);
      } catch {
        console.warn(`[GET /api/operations/:taskId] result_data 解析失败，返回空数组: taskId=${taskId}`);
        results = [];
      }
    }

    res.json({
      taskId: task.id,
      status: task.status,
      total: task.total_count,
      done: task.done_count,
      failCount: task.fail_count,
      results,
    });
  } catch (e) {
    console.error('[GET /api/operations/:taskId] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/operations/:taskId/logs — 查询任务执行日志 */
router.get('/api/operations/:taskId/logs', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const logs = taskLogManager.getRecentLogs(taskId, limit);
    res.json({ taskId, logs });
  } catch (e) {
    console.error('[GET /api/operations/:taskId/logs] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * TC-05B: GET /api/operations/:taskId/events — SSE 实时事件流
 *
 * 推送事件类型：
 *   - TASK_LOG: 新日志条目
 *   - TASK_PROGRESS: 批次进度更新
 *   - TASK_FINISHED: 任务完成（立即推送，无需轮询）
 *
 * 连接建立时先推送已有日志历史（最近100条），然后实时推送新事件。
 * 收到 TASK_FINISHED 后发送 end 事件并关闭连接。
 */
router.get('/api/operations/:taskId/events', (req: Request, res: Response) => {
  const { taskId } = req.params;

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
  });

  // 心跳定时器（30秒一次，防止连接被代理/防火墙超时断开）
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  // 发送 SSE 事件的辅助函数
  const sendEvent = (event: TaskEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 连接建立后立即推送历史日志（让前端快速恢复状态）
  const existingLogs = taskLogManager.getRecentLogs(taskId, 100);
  if (existingLogs.length > 0) {
    for (const log of existingLogs) {
      sendEvent({ type: 'TASK_LOG', taskId, payload: log });
    }
  }

  // 检查任务是否已完成（如果连接时任务已经结束，立即推送完成事件）
  const db = Database.getInstance();
  const existingTask = db.getTask(taskId);
  if (existingTask && (existingTask.status === 'done' || existingTask.status === 'failed' || existingTask.status === 'cancelled')) {
    const successCount = (existingTask.done_count || 0) - (existingTask.fail_count || 0);
    sendEvent({
      type: 'TASK_FINISHED',
      taskId,
      status: existingTask.status === 'done' ? 'done' : 'failed',
      successCount: Math.max(0, successCount),
      failedCount: existingTask.fail_count || 0,
      finishedAt: existingTask.finished_at ? new Date(existingTask.finished_at).getTime() : Date.now(),
    });
    res.write('event: end\ndata: {}\n\n');
    clearInterval(heartbeat);
    res.end();
    return;
  }

  // 订阅 EventBus 实时事件
  const unsubscribe = taskEventBus.on(taskId, (event: TaskEvent) => {
    try {
      sendEvent(event);

      // 任务完成/失败后，发送 end 事件并关闭连接
      if (event.type === 'TASK_FINISHED') {
        res.write('event: end\ndata: {}\n\n');
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      }
    } catch (e) {
      // 连接可能已断开，忽略写入错误
      clearInterval(heartbeat);
      unsubscribe();
    }
  });

  // 客户端断开连接时清理
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });

  req.on('error', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ── 任务详情 API（基于 PgDatabase）─────────────────────

/** GET /api/tasks/:id/status — 查询任务最新状态（从 PG，供前端实时轮询） */
router.get('/api/tasks/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const pgDb = PgDatabase.getInstance();
    const task = await pgDb.getTaskById(getTenantId(req), id);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }
    res.json({
      taskId: task.id,
      status: task.status,
      type: task.type,
      totalCount: task.totalCount,
      doneCount: task.doneCount,
      failCount: task.failCount,
    });
  } catch (e) {
    console.error('[GET /api/tasks/:id/status] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/tasks/:id/logs — 查询任务执行日志（从 PG task_logs 表，Phase 5-G-2: 默认 limit 500） */
router.get('/api/tasks/:id/logs', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 500;
    const offset = parseInt(req.query.offset as string) || 0;

    const pgDb = PgDatabase.getInstance();
    const result = await pgDb.getTaskLogs(getTenantId(req), id, limit, offset);

    res.json({ taskId: id, logs: result.logs, total: result.total });
  } catch (e) {
    console.error('[GET /api/tasks/:id/logs] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/tasks/:id/waybills — 查询任务运单明细（从 PG waybill_results 表） */
router.get('/api/tasks/:id/waybills', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const statusFilter = req.query.status as string | undefined;
    const staffFilter = req.query.staffName as string | undefined;

    const pgDb = PgDatabase.getInstance();
    const result = await pgDb.getTaskWaybills(getTenantId(req), id, statusFilter, staffFilter);

    res.json({ taskId: id, waybills: result.waybills, total: result.total });
  } catch (e) {
    console.error('[GET /api/tasks/:id/waybills] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/tasks/:id/staff — 任务执行人员统计 */
router.get('/api/tasks/:id/staff', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const pgDb = PgDatabase.getInstance();
    const workers = await pgDb.getTaskStaffSummary(getTenantId(req), id);

    res.json({ taskId: id, workers });
  } catch (e) {
    console.error('[GET /api/tasks/:id/staff] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/tasks/:id/summary — 任务摘要聚合查询（任务信息 + 运单统计） */
router.get('/api/tasks/:id/summary', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const pgDb = PgDatabase.getInstance();
    const summary = await pgDb.getTaskSummary(getTenantId(req), id);

    if (!summary) {
      return res.status(404).json({ error: '任务不存在' });
    }

    res.json(summary);
  } catch (e) {
    console.error('[GET /api/tasks/:id/summary] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/tasks/cleanup — 清理指定天数前已结束的历史任务（默认30天） */
router.post('/api/tasks/cleanup', async (req: Request, res: Response) => {
  try {
    const days = (req.body?.days && typeof req.body.days === 'number') ? req.body.days : 30;
    const pgDb = PgDatabase.getInstance();
    const result = await pgDb.cleanupOldTasks(getTenantId(req), days);
    res.json(result);
  } catch (e) {
    console.error('[POST /api/tasks/cleanup] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/settings/data-retention — 获取数据保留配置 */
router.get('/api/settings/data-retention', async (_req: Request, res: Response) => {
  try {
    const sm = SettingsManager.getInstance();
    const config = await sm.getDataRetention();
    res.json(config);
  } catch (e) {
    console.error('[GET /api/settings/data-retention] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** PUT /api/settings/data-retention — 更新数据保留配置 */
router.put('/api/settings/data-retention', async (req: Request, res: Response) => {
  try {
    const { retentionDays, cleanupFrequency } = req.body;
    if (typeof retentionDays !== 'number' || !['weekly', 'monthly', 'off'].includes(cleanupFrequency)) {
      return res.status(400).json({ error: '参数无效：retentionDays 必须为数字，cleanupFrequency 必须为 weekly/monthly/off' });
    }
    if (![-1, 30, 60, 90, 180].includes(retentionDays)) {
      return res.status(400).json({ error: 'retentionDays 必须为 -1/30/60/90/180' });
    }
    const sm = SettingsManager.getInstance();
    await sm.updateDataRetention({ retentionDays, cleanupFrequency });
    res.json({ success: true });
  } catch (e) {
    console.error('[PUT /api/settings/data-retention] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/runtime/mode — 获取当前运行模式 */
router.get('/api/runtime/mode', async (_req: Request, res: Response) => {
  try {
    const sm = SettingsManager.getInstance();
    const dryRunMode = await sm.getDryRunMode();
    res.json({ dryRunMode, mode: dryRunMode ? 'dry-run' : 'real' });
  } catch (e) {
    console.error('[GET /api/runtime/mode] 失败:', (e as Error).message);
    res.json({ dryRunMode: true, mode: 'dry-run' });
  }
});

/** POST /api/runtime/mode — 设置运行模式 */
router.post('/api/runtime/mode', async (req: Request, res: Response) => {
  try {
    const { dryRunMode } = req.body;
    if (typeof dryRunMode !== 'boolean') {
      return res.status(400).json({ error: '参数无效：dryRunMode 必须为 boolean' });
    }
    const sm = SettingsManager.getInstance();
    await sm.setDryRunMode(dryRunMode);
    res.json({ success: true, dryRunMode, mode: dryRunMode ? 'dry-run' : 'real' });
  } catch (e) {
    console.error('[POST /api/runtime/mode] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/tasks/delete-stats — 统计选中任务关联的数据量 */
router.post('/api/tasks/delete-stats', async (req: Request, res: Response) => {
  try {
    const { taskIds } = req.body as { taskIds: string[] };
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.json({ taskCount: 0, waybillCount: 0, logCount: 0, typeBreakdown: {} });
    }
    const pgDb = PgDatabase.getInstance();
    const stats = await pgDb.countTaskDeleteStats(getTenantId(req), taskIds);
    res.json(stats);
  } catch (e) {
    console.error('[POST /api/tasks/delete-stats] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/tasks/batch-delete — 批量删除任务（自动跳过 running/pending） */
router.post('/api/tasks/batch-delete', async (req: Request, res: Response) => {
  try {
    const { taskIds } = req.body as { taskIds: string[] };
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds 不能为空' });
    }
    const pgDb = PgDatabase.getInstance();
    const result = await pgDb.deleteTasks(getTenantId(req), taskIds);
    res.json(result);
  } catch (e) {
    console.error('[POST /api/tasks/batch-delete] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// Phase G-3: POST /api/tasks/:taskId/cancel — 取消运行中的任务
// 触发 Engine.cancelTask() → abortController.abort() → Handler 终止 → 锁释放 → status='cancelled'
router.post('/api/tasks/:taskId/cancel', async (req: Request, res: Response) => {
  try {
    // 速率限制（与任务提交共用令牌桶）
    const rate = checkTaskRate();
    if (!rate.allowed) {
      return res.status(429).json({ error: `请稍后再试 (${Math.ceil(rate.waitMs / 1000)}秒)`, retryAfter: Math.ceil(rate.waitMs / 1000) });
    }
    const { taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ error: '缺少 taskId 参数' });
    }

    const db = Database.getInstance();
    const task = db.getTask(taskId);

    if (!task) {
      return res.status(404).json({ error: '任务不存在', taskId });
    }

    if (task.status === 'cancelled') {
      return res.json({ ok: true, message: '任务已经是 cancelled 状态', taskId, status: 'cancelled' });
    }

    if (task.status === 'done' || task.status === 'failed') {
      return res.status(409).json({
        error: '任务已结束，无法取消',
        taskId,
        currentStatus: task.status,
      });
    }

    if (task.status !== 'running') {
      return res.status(409).json({
        error: `任务状态为 ${task.status}，仅 running 状态的任务可以取消`,
        taskId,
        currentStatus: task.status,
      });
    }

    // 调用 Engine 取消任务（内部：abort → db.update('cancelled') → Map.delete）
    // Phase 2-C: await PG 终态写入完成（不再 fire-and-forget）
    const engine = AssignmentEngine.getInstance();
    const cancelled = await engine.cancelTask(taskId);

    if (!cancelled) {
      return res.status(500).json({
        error: '取消失败：任务未在 Engine 中运行（可能已完成）',
        taskId,
      });
    }

    // 异步获取取消后的任务状态确认
    const updatedTask = db.getTask(taskId);
    res.json({
      ok: true,
      message: '任务已取消',
      taskId,
      status: updatedTask?.status || 'cancelled',
    });
  } catch (err) {
    console.error('[API] 取消任务失败:', err);
    res.status(500).json({
      error: '取消任务时发生内部错误',
      detail: (err as Error).message,
    });
  }
});

/** GET /api/operations — 历史任务列表（主数据源：PgDatabase，全 PG 架构） */
router.get('/api/operations', async (req: Request, res: Response) => {
  try {
    const pg = PgDatabase.getInstance();
    const sm = SettingsManager.getInstance();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const type = req.query.type as string | undefined;
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    // 类型中文名映射（仅支持任务类型关键字搜索）
    const typeKeywordMap: Record<string, string> = {
      '到件': 'arrive', '到件扫描': 'arrive',
      '派件': 'dispatch', '派件扫描': 'dispatch',
      '签收': 'sign', '签收录入': 'sign',
      '集成': 'integrated', '综合': 'integrated',
      '窗口': 'init_window', '初始化': 'init_window',
    };

    // 确定类型过滤条件：search 优先尝试类型中文名映射
    let filterType: string | undefined = type;
    let filterSearch: string | undefined = search;
    if (!filterType && search) {
      const mapped = typeKeywordMap[search];
      if (mapped) {
        filterType = mapped;
        filterSearch = undefined; // 映射成功则不作为文本搜索
      }
    }

    // 网点 id → 显示名称 映射（真源：SettingsManager/data/settings.json，与设置中心/签收端/Header 同源）
    // ★ 交付前加固：同时按 site.id 和 siteCode 建索引
    //   - site.id（如 'site-1782121346155'）：settings.json 前端值
    //   - siteCode（如 'tiannanda'）：SQLite/PG 统一存储值
    //   这样无论任务记录存的是哪种格式，都能正确反查中文名
    let siteNameMap: Record<string, string> = {};
    try {
      const cfg = await sm.getConfig();
      for (const s of cfg.sites) {
        siteNameMap[s.id] = s.name;
        // 同时按 siteCode 建索引（与 normalizeSiteToCode 逻辑一致）
        if (s.name.includes('天南大')) {
          siteNameMap['tiannanda'] = s.name;
        } else if (s.name.includes('和苑')) {
          siteNameMap['heyuan'] = s.name;
        }
      }
    } catch {
      // 设置未初始化时不影响任务列表展示
    }

    const result = await pg.getTaskList(getTenantId(req), page, limit, filterType, status, filterSearch);

    const tasks = result.tasks.map((t) => ({
      ...t,
      siteName: siteNameMap[t.site] || t.siteName || t.site,
    }));

    res.json({ page, limit, total: result.total, tasks });
  } catch (e) {
    console.error('[GET /api/operations] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Phase 3-F: Cloud 组织信息只读接口 ────────────────────

/** GET /api/cloud/tenant — 当前租户信息（只读） */
router.get('/api/cloud/tenant', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const pg = PgDatabase.getInstance();
    const tenant = await pg.getTenantById(tenantId);

    if (!tenant) {
      return res.status(404).json({ error: '租户不存在' });
    }

    res.json(tenant);
  } catch (e) {
    console.error('[GET /api/cloud/tenant] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/cloud/sites — 当前租户下站点列表（只读） */
router.get('/api/cloud/sites', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const pg = PgDatabase.getInstance();
    const sites = await pg.getSitesByTenant(tenantId);

    res.json({ tenantId, sites });
  } catch (e) {
    console.error('[GET /api/cloud/sites] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/cloud/workstations — 当前租户下工作站列表（只读） */
router.get('/api/cloud/workstations', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const pg = PgDatabase.getInstance();
    const workstations = await pg.getWorkstationsByTenant(tenantId);

    res.json({ tenantId, workstations });
  } catch (e) {
    console.error('[GET /api/cloud/workstations] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** GET /api/cloud/users — 当前租户下用户列表（只读，不含 password_hash） */
router.get('/api/cloud/users', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const pg = PgDatabase.getInstance();
    const users = await pg.getUsersByTenant(tenantId);

    res.json({ tenantId, users });
  } catch (e) {
    console.error('[GET /api/cloud/users] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/cloud/agent-test-task — 创建 agent_test 测试任务（Phase 4-F 开发调试用） */
router.post('/api/cloud/agent-test-task', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { message, durationMs } = req.body || {};

    const pg = PgDatabase.getInstance();
    const taskId = await pg.insertTask({
      type: 'agent_test',
      siteId: 'unknown',
      status: 'pending',
      totalCount: 0,
      inputData: {
        message: message || 'Agent 测试任务',
        durationMs: durationMs || 3000,
      },
      tenantId,
    });

    res.json({ ok: true, taskId, message: '测试任务已创建' });
  } catch (e) {
    console.error('[POST /api/cloud/agent-test-task] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/cloud/agent-arrival-task — 创建 arrival Agent DRY-RUN 任务（Phase 5-B / 5-E） */
router.post('/api/cloud/agent-arrival-task', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { siteId, siteName, waybills, options, browserDryRun } = req.body || {};

    if (!siteId) {
      return res.status(400).json({ error: '缺少 siteId 参数' });
    }
    if (!waybills || !Array.isArray(waybills) || waybills.length === 0) {
      return res.status(400).json({ error: 'waybills 必须是非空数组' });
    }

    const pg = PgDatabase.getInstance();
    const taskId = await pg.insertTask({
      type: 'arrival',
      siteId,
      status: 'pending',
      totalCount: waybills.length,
      inputData: {
        waybills,
        options: options || {},
        siteName: siteName || siteId,
        dryRun: true,
        browserDryRun: browserDryRun === true,
      },
      tenantId,
    });

    res.json({ ok: true, taskId, message: 'Arrival DRY-RUN 任务已创建', waybillCount: waybills.length, browserDryRun: browserDryRun === true });
  } catch (e) {
    console.error('[POST /api/cloud/agent-arrival-task] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/cloud/agent-dispatch-task — 创建 dispatch Agent DRY-RUN 任务（Phase 5-B / 5-E） */
router.post('/api/cloud/agent-dispatch-task', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { siteId, siteName, waybills, options, browserDryRun, courierName } = req.body || {};

    if (!siteId) {
      return res.status(400).json({ error: '缺少 siteId 参数' });
    }
    if (!waybills || !Array.isArray(waybills) || waybills.length === 0) {
      return res.status(400).json({ error: 'waybills 必须是非空数组' });
    }

    const mergedOptions = { ...(options || {}), ...(courierName ? { courierName } : {}) };

    const pg = PgDatabase.getInstance();
    const taskId = await pg.insertTask({
      type: 'dispatch',
      siteId,
      status: 'pending',
      totalCount: waybills.length,
      inputData: {
        waybills,
        options: mergedOptions,
        siteName: siteName || siteId,
        dryRun: true,
        browserDryRun: browserDryRun === true,
      },
      tenantId,
    });

    res.json({ ok: true, taskId, message: 'Dispatch DRY-RUN 任务已创建', waybillCount: waybills.length, browserDryRun: browserDryRun === true });
  } catch (e) {
    console.error('[POST /api/cloud/agent-dispatch-task] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/cloud/agent-integrated-task — 创建 integrated Agent DRY-RUN 任务（Phase 5-B / 5-E） */
router.post('/api/cloud/agent-integrated-task', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { siteId, siteName, waybills, options, browserDryRun, courierName, courierEmployeeId, prevStation } = req.body || {};

    if (!siteId) {
      return res.status(400).json({ error: '缺少 siteId 参数' });
    }
    if (!waybills || !Array.isArray(waybills) || waybills.length === 0) {
      return res.status(400).json({ error: 'waybills 必须是非空数组' });
    }

    const mergedOptions = {
      ...(options || {}),
      ...(courierName ? { courierName } : {}),
      ...(courierEmployeeId ? { courierEmployeeId } : {}),
      ...(prevStation ? { prevStation } : {}),
    };

    const pg = PgDatabase.getInstance();
    const taskId = await pg.insertTask({
      type: 'integrated',
      siteId,
      status: 'pending',
      totalCount: waybills.length,
      inputData: {
        waybills,
        options: mergedOptions,
        siteName: siteName || siteId,
        dryRun: true,
        browserDryRun: browserDryRun === true,
      },
      tenantId,
    });

    res.json({ ok: true, taskId, message: 'Integrated DRY-RUN 任务已创建', waybillCount: waybills.length, browserDryRun: browserDryRun === true });
  } catch (e) {
    console.error('[POST /api/cloud/agent-integrated-task] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/** POST /api/cloud/agent-sign-task — 创建 sign Agent DRY-RUN 任务（Phase 5-B / 5-E） */
router.post('/api/cloud/agent-sign-task', async (req: Request, res: Response) => {
  try {
    const tenantId = getTenantId(req);
    const { siteId, siteName, waybills, options, browserDryRun, courierName } = req.body || {};

    if (!siteId) {
      return res.status(400).json({ error: '缺少 siteId 参数' });
    }
    if (!waybills || !Array.isArray(waybills) || waybills.length === 0) {
      return res.status(400).json({ error: 'waybills 必须是非空数组' });
    }

    const mergedOptions = { ...(options || {}), ...(courierName ? { courierName } : {}) };

    const pg = PgDatabase.getInstance();
    const taskId = await pg.insertTask({
      type: 'sign',
      siteId,
      status: 'pending',
      totalCount: waybills.length,
      inputData: {
        waybills,
        options: mergedOptions,
        siteName: siteName || siteId,
        dryRun: true,
        browserDryRun: browserDryRun === true,
      },
      tenantId,
    });

    res.json({ ok: true, taskId, message: 'Sign DRY-RUN 任务已创建', waybillCount: waybills.length, browserDryRun: browserDryRun === true });
  } catch (e) {
    console.error('[POST /api/cloud/agent-sign-task] 失败:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 启动时清理所有僵尸任务
 * 服务重启后调用：查询 DB 中所有 status='running' 的任务 → 更新为 failed → 记录 Service restarted unexpectedly
 * Phase H: 原空实现已替换为调用 AssignmentEngine.recoverRunningTasks()
 * Phase 2-C-1: recoverRunningTasks 已改为 async，本函数同步适配
 */
export async function cleanupRunningTasks(): Promise<number> {
  return AssignmentEngine.recoverRunningTasks();
}
