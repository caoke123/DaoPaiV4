/**
 * Agent 路由
 *
 * /agent/* 接口使用执行电脑授权码鉴权，与用户 JWT 完全分离。
 *
 * Phase 4-C 协议定义见 docs/V3_PHASE4C_AGENT_API_PROTOCOL.md
 * Phase 4-E: /agent/me, /agent/heartbeat
 * Phase 4-F: /agent/tasks/pull, /agent/tasks/:id/progress, /agent/tasks/:id/logs,
 *            /agent/tasks/:id/complete, /agent/tasks/:id/fail
 * Phase 5-G-2: 使用 TaskLogService 统一日志写入，写 PG 后 emit EventBus 打通 SSE；
 *              complete/fail 顺序调整为先写最终日志再更新任务状态，避免日志丢失竞态。
 */

import { Router, type Request, type Response } from 'express';
import { requireAgent } from '../auth/agentAuth';
import { PgDatabase } from '../db/PgDatabase';
import { taskLogService } from '../services/TaskLogService';
import { TaskEngineRunner } from '../services/TaskEngineRunner';
import { PlaywrightRuntime } from '../playwright-runtime/PlaywrightRuntime';
import { logTrace, warnTrace } from '../utils/trace';
import { broadcastSse } from './AgentWebSocket';

export const agentRouter = Router();

// ── In-memory cache of latest agent version info (keyed by workstationId) ──
// Used by /api/version to show connected agent version fingerprint.
const agentVersionCache = new Map<string, Record<string, unknown>>();

export function setLatestAgentVersionInfo(workstationId: string, info: Record<string, unknown>): void {
  agentVersionCache.set(workstationId, info);
}

export function getLatestAgentVersionInfo(): Record<string, unknown> | null {
  // Return the first (and typically only) agent entry
  const entries = [...agentVersionCache.values()];
  if (entries.length === 0) return null;
  // Return the most recently updated entry
  return entries.sort((a, b) =>
    String(b.lastHeartbeatAt || '').localeCompare(String(a.lastHeartbeatAt || ''))
  )[0];
}

// ── 所有 /agent/* 路由都需要 Agent Token 鉴权 ──
agentRouter.use(requireAgent);

/** 辅助：获取并验证 principal */
function getAgentPrincipal(req: Request) {
  const p = req.principal;
  if (!p || p.type !== 'agent') {
    throw { status: 401, code: 'AGENT_TOKEN_INVALID', message: '鉴权失败' };
  }
  return { tenantId: p.tenantId, workstationId: p.workstationId, siteId: p.siteId };
}

/** GET /agent/me — 验证授权码，返回执行电脑信息 */
agentRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const pg = PgDatabase.getInstance();
    const ws = await pg.getWorkstationById(tenantId, workstationId);

    if (!ws) {
      return res.status(404).json({ ok: false, code: 'TASK_NOT_FOUND', message: '执行电脑不存在', timestamp: new Date().toISOString() });
    }

    const tenant = await pg.getTenantById(tenantId);
    let siteName = null;
    if (ws.siteId) {
      const sites = await pg.getSitesByTenant(tenantId);
      const site = sites.find(s => s.id === ws.siteId);
      siteName = site?.name || null;
    }

    await pg.touchAgentToken(workstationId);

    res.json({
      ok: true,
      data: {
        workstationId: ws.id,
        name: ws.name,
        tenantId: ws.tenantId,
        tenantName: tenant?.name || '默认快递公司',
        siteId: ws.siteId,
        siteName: siteName,
        status: ws.status,
        onlineStatus: ws.onlineStatus,
        browserStatus: ws.browserStatus,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[GET /agent/me] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/heartbeat — 心跳上报 */
agentRouter.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const { agentVersion, machineFingerprint, browserStatus, gitCommit, buildId, startedAt, chromePath, chromeKind } = req.body || {};
    const t0 = Date.now();

    const pg = PgDatabase.getInstance();
    await pg.updateWorkstationHeartbeat({
      workstationId,
      tenantId,
      browserStatus: browserStatus || 'unknown',
      agentVersion: agentVersion || 'unknown',
      machineFingerprint: machineFingerprint || 'unknown',
      lastIp: req.ip || req.socket.remoteAddress || 'unknown',
    });

    // Cache agent version info in memory for /api/version
    setLatestAgentVersionInfo(workstationId, {
      workstationId,
      tenantId,
      agentVersion: agentVersion || 'unknown',
      gitCommit: gitCommit || 'unknown',
      buildId: buildId || 'unknown',
      startedAt: startedAt || 'unknown',
      chromePath: chromePath || 'unknown',
      chromeKind: chromeKind || 'unknown',
      lastHeartbeatAt: new Date().toISOString(),
    });

    await pg.touchAgentToken(workstationId);

    // Phase 4-F: 检查是否有待执行任务
    const hasTask = await pg.hasPendingTask(tenantId);
    logTrace('agent-heartbeat', 'heartbeat_processed', {
      tenantId,
      workstationId,
      hasTask,
      durationMs: Date.now() - t0,
      agentVersion: agentVersion || 'unknown',
      browserStatus: browserStatus || 'unknown',
      machineFingerprint: machineFingerprint || 'unknown',
    });

    res.json({
      ok: true,
      data: {
        serverTime: new Date().toISOString(),
        workstationStatus: 'active',
        hasTask,
        nextPollAfterMs: hasTask ? 2000 : 15000,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/heartbeat] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

// ── Phase 4-F: 任务管道 ──

/** POST /agent/tasks/pull — 拉取一个待执行任务 */
agentRouter.post('/tasks/pull', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const t0 = Date.now();

    const pg = PgDatabase.getInstance();
    const task = await pg.pullPendingTask(tenantId, workstationId);

    if (!task) {
      logTrace('agent-task', 'task_pull_empty', {
        tenantId,
        workstationId,
        durationMs: Date.now() - t0,
      });
      return res.json({
        ok: true,
        data: { hasTask: false, task: null, nextPollAfterMs: 5000 },
        timestamp: new Date().toISOString(),
      });
    }

    logTrace('agent-task', 'task_pulled', {
      tenantId,
      workstationId,
      taskId: task.id,
      taskType: task.type,
      siteId: task.siteId,
      durationMs: Date.now() - t0,
    });

    res.json({
      ok: true,
      data: {
        hasTask: true,
        task: {
          taskId: task.id,
          type: task.type,
          siteId: task.siteId,
          siteName: task.siteId,
          status: task.status,
          payload: task.inputData || {},
          createdAt: task.createdAt,
        },
        nextPollAfterMs: 5000,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/pull] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/tasks/:id/run-engine — 使用业务页员工窗口执行已拉取任务 */
agentRouter.post('/tasks/:id/run-engine', async (req: Request, res: Response) => {
  try {
    console.warn('[兼容路径] /agent/tasks/:id/run-engine 仍保留给未迁移任务类型使用。正式方向是 Agent 本地执行；Arrival 已从 Phase K-2A 开始迁移，Dispatch 已从 Phase K-2B 开始迁移，Sign/Integrated 已从 Phase K-2D 开始迁移。');
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    const pg = PgDatabase.getInstance();
    const task = await pg.getTaskById(tenantId, taskId);
    if (!task) {
      return res.status(404).json({
        ok: false,
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
        timestamp: new Date().toISOString(),
      });
    }
    if (task.type === 'arrival' || task.type === 'arrive') {
      return res.status(409).json({
        ok: false,
        code: 'TASK_TYPE_MIGRATED_TO_AGENT',
        message: 'Arrival 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行',
        timestamp: new Date().toISOString(),
      });
    }
    if (task.type === 'dispatch') {
      return res.status(409).json({
        ok: false,
        code: 'TASK_TYPE_MIGRATED_TO_AGENT',
        message: 'Dispatch 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行',
        timestamp: new Date().toISOString(),
      });
    }
    if (task.type === 'sign') {
      return res.status(409).json({
        ok: false,
        code: 'TASK_TYPE_MIGRATED_TO_AGENT',
        message: 'Sign 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行',
        timestamp: new Date().toISOString(),
      });
    }
    if (task.type === 'integrated') {
      return res.status(409).json({
        ok: false,
        code: 'TASK_TYPE_MIGRATED_TO_AGENT',
        message: 'Integrated 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行',
        timestamp: new Date().toISOString(),
      });
    }
    const result = await TaskEngineRunner.runTask({
      taskId,
      tenantId,
      workstationId,
      source: 'agent-engine',
    });

    res.json({
      ok: true,
      data: { accepted: result.accepted, skipped: result.skipped === true, reason: result.reason, taskId },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/:id/run-engine] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: e.message || '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/tasks/:id/progress — 上报任务进度 */
agentRouter.post('/tasks/:id/progress', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    const { status, progress, currentAction, processedCount, totalCount } = req.body || {};

    // 校验
    if (!status || !['assigned', 'running'].includes(status)) {
      return res.status(400).json({
        ok: false, code: 'TASK_STATUS_CONFLICT',
        message: 'status 只允许 assigned / running',
        timestamp: new Date().toISOString(),
      });
    }

    const pg = PgDatabase.getInstance();
    await pg.updateTaskProgress(taskId, tenantId, workstationId, Math.min(100, Math.max(0, progress || 0)), status);

    res.json({
      ok: true,
      data: { accepted: true },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/:id/progress] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/tasks/:id/logs — 批量上报日志（Phase 5-G-2: 改用 TaskLogService） */
agentRouter.post('/tasks/:id/logs', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    const { logs } = req.body || {};

    if (!logs || !Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({
        ok: false, code: 'TASK_PAYLOAD_INVALID',
        message: 'logs 字段不能为空',
        timestamp: new Date().toISOString(),
      });
    }

    if (logs.length > 100) {
      return res.status(400).json({
        ok: false, code: 'LOGS_BATCH_TOO_LARGE',
        message: '一次最多上报 100 条日志',
        timestamp: new Date().toISOString(),
      });
    }

    logTrace('agent-task', 'logs_received', {
      tenantId,
      workstationId,
      taskId,
      logCount: logs.length,
      firstMessage: typeof logs[0]?.message === 'string' ? logs[0].message.slice(0, 120) : null,
    });

    await taskLogService.appendLogs(
      taskId,
      logs.map((entry: any) => ({
        level: entry.level,
        message: entry.message,
        timestamp: entry.timestamp,
        staffName: entry.staffName,
        windowId: entry.windowId,
      })),
      {
        tenantId,
        workstationId,
        source: 'agent',
      }
    );

    res.json({
      ok: true,
      data: { accepted: true, count: logs.length },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/:id/logs] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/tasks/:id/complete — 任务正常完成（Phase 5-G-2: 先写日志，再更新状态） */
agentRouter.post('/tasks/:id/complete', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    const { summary, results } = req.body || {};
    logTrace('agent-task', 'task_complete_received', {
      tenantId,
      workstationId,
      taskId,
      resultCount: Array.isArray(results) ? results.length : 0,
      hasSummary: !!summary,
    });

    const pg = PgDatabase.getInstance();

    // Phase 5-G-2: 先写最终 summary/results 日志，再更新状态为 done，
    // 避免前端在状态更新后停止轮询导致最后一批日志丢失。
    const finalLogs: Array<{ level: 'info' | 'success' | 'warning' | 'error'; message: string; timestamp: number }> = [];
    const now = Date.now();

    if (summary) {
      finalLogs.push({
        level: 'info',
        timestamp: now,
        message: `任务完成摘要：${JSON.stringify(summary)}`,
      });
    }
    if (results && Array.isArray(results)) {
      finalLogs.push({
        level: 'info',
        timestamp: now + 1,
        message: `任务完成结果：${JSON.stringify(results)}`,
      });
    }
    finalLogs.push({
      level: 'success',
      timestamp: now + 2,
      message: '任务执行完成',
    });

    if (finalLogs.length > 0) {
      try {
        await taskLogService.appendLogs(
          taskId,
          finalLogs,
          {
            tenantId,
            workstationId,
            source: 'agent',
          }
        );
      } catch (logErr) {
        console.error('[POST /agent/tasks/:id/complete] 写入完成日志失败:', (logErr as Error).message);
      }
    }

    const normalizedResults = results && Array.isArray(results)
      ? results.map((r: any) => ({
        waybillNo: String(r.waybillNo || ''),
        staffName: r.staffName ? String(r.staffName) : undefined,
        success: r.status !== 'failed' && r.success !== false,
        message: String(r.message || ''),
        timestamp: r.timestamp ? Number(new Date(r.timestamp).getTime()) : Date.now(),
        status: r.status === 'failed' ? 'FAILED' as const : 'DRY_RUN_SKIPPED' as const,
      })).filter((r: any) => r.waybillNo)
      : [];
    const doneCount = normalizedResults.filter((r: any) => r.status !== 'FAILED').length;
    const failCount = normalizedResults.filter((r: any) => r.status === 'FAILED').length;
    const finalStatus = normalizedResults.length > 0 && doneCount === 0 && failCount > 0 ? 'failed' as const : 'done' as const;

    if (normalizedResults.length > 0) {
      try {
        await pg.insertWaybillResults(
          taskId,
          1,
          normalizedResults,
          tenantId,
        );
      } catch (resultErr) {
        console.error('[POST /agent/tasks/:id/complete] 写入运单结果失败:', (resultErr as Error).message);
      }
    }

    // 日志和结果写入完成后再更新任务状态
    const updated = await pg.completeAgentTask(
      taskId,
      tenantId,
      workstationId,
      normalizedResults.length > 0 ? { doneCount, failCount, finalStatus } : undefined,
    );

    if (!updated) {
      return res.status(409).json({
        ok: false, code: 'TASK_ALREADY_FINISHED',
        message: '任务已完成或已失败，不能重复完成',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      data: { accepted: true },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/:id/complete] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/** POST /agent/tasks/:id/fail — 任务失败（Phase 5-G-2: 先写错误日志，再更新状态） */
agentRouter.post('/tasks/:id/fail', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    const { error } = req.body || {};

    const pg = PgDatabase.getInstance();

    // Phase 5-G-2: 先写错误日志，再更新状态为 failed
    const errorMsg = error?.message || '任务执行失败';
    const errorCode = error?.code || 'UNKNOWN_ERROR';
    const now = Date.now();
    warnTrace('agent-task', 'task_fail_received', {
      tenantId,
      workstationId,
      taskId,
      errorCode,
      errorMessage: String(errorMsg).slice(0, 200),
    });

    try {
      await taskLogService.appendLogs(
        taskId,
        [
          {
            level: 'error',
            timestamp: now,
            message: `任务失败：${errorMsg}`,
          },
          {
            level: 'error',
            timestamp: now + 1,
            message: `错误码：${errorCode}`,
          },
        ],
        {
          tenantId,
          workstationId,
          source: 'agent',
        }
      );
    } catch (logErr) {
      console.error('[POST /agent/tasks/:id/fail] 写入失败日志失败:', (logErr as Error).message);
    }

    // 日志写入后再更新任务状态
    const updated = await pg.failAgentTask(taskId, tenantId, workstationId);

    if (!updated) {
      return res.status(409).json({
        ok: false, code: 'TASK_ALREADY_FINISHED',
        message: '任务已完成或已失败，不能重复失败',
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      data: { accepted: true },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/tasks/:id/fail] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

// ── Phase Deploy-0C: Agent 窗口状态上报 ──

/**
 * POST /agent/windows/status — Agent 上报本机窗口状态
 *
 * 每个窗口 (tenantId + siteId + workstationId + windowId) 唯一定位。
 * upsert 到 PostgreSQL window_status 表。
 * 失败不影响任务执行，后端只打 warn。
 */
agentRouter.post('/windows/status', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const body = req.body;

    if (!body || typeof body !== 'object' || !Array.isArray(body.siteWindows)) {
      return res.status(400).json({
        ok: false,
        message: '请传入 { siteWindows: [...] } 数组',
        timestamp: new Date().toISOString(),
      });
    }

    const windows: any[] = body.siteWindows;
    if (windows.length === 0) {
      return res.json({
        ok: true,
        data: { upserted: 0 },
        timestamp: new Date().toISOString(),
      });
    }

    if (windows.length > 50) {
      return res.status(400).json({
        ok: false,
        code: 'BATCH_TOO_LARGE',
        message: '一次最多上报 50 个窗口状态',
        timestamp: new Date().toISOString(),
      });
    }

    const pg = PgDatabase.getInstance();

    for (const w of windows) {
      if (!w.siteId || !w.windowId) {
        console.warn('[POST /agent/windows/status] 跳过缺少 siteId/windowId 的条目');
        continue;
      }

      const tUpsert = Date.now();
      // M5-2 trace: status upsert start
      logTrace('window-status', 'window_status_upsert_start', {
        windowId: String(w.windowId),
        siteId: String(w.siteId),
        status: String(w.status || 'offline'),
        commandId: w.commandId ? String(w.commandId) : undefined,
      });

      await pg.upsertWindowStatus({
        tenantId,
        siteId: String(w.siteId),
        workstationId: String(workstationId),
        windowId: String(w.windowId),
        staffName: String(w.staffName || w.windowId),
        status: String(w.status || 'offline'),
        statusText: String(w.statusText || ''),
        currentUrl: w.currentUrl ? String(w.currentUrl) : undefined,
        isProcessAlive: Boolean(w.isProcessAlive),
        isCdpReady: Boolean(w.isCdpReady),
        isDashboardReady: Boolean(w.isDashboardReady),
        isLoginPage: Boolean(w.isLoginPage),
        lastError: w.lastError ? String(w.lastError) : null,
        cdpEndpoint: w.cdpEndpoint ? String(w.cdpEndpoint) : null,
        profilePath: w.profilePath ? String(w.profilePath) : null,
        chromePid: typeof w.chromePid === 'number' ? w.chromePid : null,
      });

      // M5-2 trace: status upsert done
      logTrace('window-status', 'window_status_upsert_done', {
        windowId: String(w.windowId),
        status: String(w.status || 'offline'),
        commandId: w.commandId ? String(w.commandId) : undefined,
        durationMs: Date.now() - tUpsert,
      });

      // P5-Fix: status 写入 PG 后立即通过 SSE 推送前端，不等 5s 轮询
      const ssePayload = {
        windowId: String(w.windowId),
        status: String(w.status || 'offline'),
        statusText: String(w.statusText || ''),
        commandId: w.commandId ? String(w.commandId) : undefined,
        updatedAt: w.updatedAt || new Date().toISOString(),
        isDashboardReady: Boolean(w.isDashboardReady),
        isLoginPage: Boolean(w.isLoginPage),
      };
      broadcastSse(String(w.siteId), 'window_status_updated', ssePayload);

      // M5-2 trace: SSE broadcast done
      logTrace('window-status', 'window_status_sse_broadcast', {
        windowId: String(w.windowId),
        status: String(w.status || 'offline'),
        siteId: String(w.siteId),
      });
    }

    res.json({
      ok: true,
      data: { upserted: windows.length },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    // 状态上报失败不影响业务，只打 warn
    console.warn('[POST /agent/windows/status] 失败（非致命）:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '状态保存失败', timestamp: new Date().toISOString() });
  }
});

// ── Phase K-3A: Agent CDP 接管 READY 窗口查询接口 ──

/**
 * GET /agent/window-connections — 查询当前 tenant 下所有窗口的连接信息
 *
 * 用途：Agent pull 到 arrival task 后，先调此接口查找匹配 staffName 的 READY 窗口，
 *       若窗口 cdpAttachable=true 且 status=ready，则使用 chromium.connectOverCDP(cdpEndpoint)
 *       接管已有 Chrome，避免新开窗口 + 重登。
 *
 * Phase Deploy-0D: 优先从 Agent 上报的 window_status 表读取，fallback 到 PlaywrightRuntime。
 * 四个业务 Executor 无需修改，保持兼容。
 *
 * 查询参数（均可选）：
 *   - staffName: 按员工姓名精确过滤
 *   - status: 按窗口状态过滤（如 'ready' / 'busy' / 'login_required'）
 *   - siteId: 按站点过滤
 *
 * 返回结构：
 *   {
 *     ok: true,
 *     data: {
 *       windows: Array<{
 *         runtimeKey, windowId, staffName, windowName,
 *         tenantId, siteId, status, currentUrl, isLoggedIn,
 *         cdpPort, cdpEndpoint, cdpAttachable
 *       }>,
 *       total: number
 *     }
 *   }
 *
 * 安全约束：
 *   - 只返回当前 Agent tenantId 下的窗口（避免跨租户泄露）
 *   - cdpEndpoint 仅 127.0.0.1，不暴露公网
 *   - cdpAttachable=false 的窗口 Agent 应跳过（旧窗口或开关未启用）
 */
agentRouter.get('/window-connections', async (req: Request, res: Response) => {
  try {
    const { tenantId } = getAgentPrincipal(req);
    const { staffName, status, siteId } = req.query as { staffName?: string; status?: string; siteId?: string };

    const pg = PgDatabase.getInstance();

    // Phase Deploy-0D: 优先从 window_status 表读取 Agent 上报的 READY 窗口
    const statusWindows = await pg.getReadyWindowConnectionsFromStatus(tenantId, siteId);

    const statusMapped = statusWindows.map(w => ({
      runtimeKey: `${tenantId}:${w.siteId}:${w.windowId}`,
      windowId: w.windowId,
      staffName: w.staffName,
      windowName: w.staffName,
      tenantId,
      siteId: w.siteId,
      status: 'ready',
      currentUrl: null,
      isLoggedIn: true,
      cdpPort: null,
      cdpEndpoint: w.cdpEndpoint,
      cdpAttachable: true,
    }));

    // Fallback: PlaywrightRuntime 过渡窗口数据
    const runtime = PlaywrightRuntime.getInstance();
    const allWindows = runtime.listWindowsJSON();

    const filteredRuntime = allWindows.filter(w => {
      if (w.tenantId !== tenantId) return false;
      if (staffName && w.staffName !== staffName) return false;
      if (status && w.status !== status) return false;
      if (siteId && w.siteId !== siteId) return false;
      // 如果 window_status 已有同 windowId 的记录，不重复返回
      const statusWindowIds = new Set(statusWindows.map(sw => sw.windowId));
      if (statusWindowIds.has(w.windowId)) return false;
      return true;
    });

    const runtimeMapped = filteredRuntime.map(w => ({
      runtimeKey: w.runtimeKey,
      windowId: w.windowId,
      staffName: w.staffName ?? null,
      windowName: w.windowName ?? null,
      tenantId: w.tenantId,
      siteId: w.siteId,
      status: w.status,
      currentUrl: w.currentUrl ?? null,
      isLoggedIn: w.isLoggedIn ?? null,
      cdpPort: w.cdpPort ?? null,
      cdpEndpoint: w.cdpEndpoint ?? null,
      cdpAttachable: w.cdpAttachable ?? false,
    }));

    // 合并：window_status 优先，PlaywrightRuntime 补充
    const windows = [...statusMapped, ...runtimeMapped];

    // 按 staffName 过滤（兼容旧查询参数）
    const finalWindows = staffName
      ? windows.filter(w => w.staffName === staffName)
      : windows;

    res.json({
      ok: true,
      data: {
        windows: finalWindows,
        total: finalWindows.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[GET /agent/window-connections] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

// ── Phase Deploy-0D: Window Command Agent API ──

/**
 * POST /agent/windows/commands/pull — Agent 拉取待执行的窗口命令
 *
 * 原子 claim + return。只拉取本 workstation 的 pending 命令。
 * 与业务任务 pull 完全独立。
 */
agentRouter.post('/windows/commands/pull', async (req: Request, res: Response) => {
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const { limit } = req.body || {};
    const t0 = Date.now();

    const pullLimit = Math.min(limit && typeof limit === 'number' ? limit : 10, 20);

    const pg = PgDatabase.getInstance();
    const commands = await pg.claimPendingWindowCommands(tenantId, workstationId, pullLimit);
    logTrace('window-command', 'commands_claimed', {
      tenantId,
      workstationId,
      limit: pullLimit,
      claimedCount: commands.length,
      durationMs: Date.now() - t0,
    });

    res.json({
      ok: true,
      data: {
        commands: commands.map(c => ({
          commandId: c.id,
          tenantId: c.tenantId,
          siteId: c.siteId,
          workstationId: c.workstationId,
          windowId: c.windowId,
          staffName: c.staffName,
          type: c.type,
          params: c.params,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/windows/commands/pull] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/**
 * POST /agent/windows/commands/:commandId/running — Agent 上报命令开始执行
 */
agentRouter.post('/windows/commands/:commandId/running', async (req: Request, res: Response) => {
  try {
    const { commandId } = req.params;
    logTrace('window-command', 'command_running_received', {
      commandId,
    });

    const pg = PgDatabase.getInstance();
    await pg.markWindowCommandRunning(commandId);

    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/windows/commands/:commandId/running] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/**
 * POST /agent/windows/commands/:commandId/complete — Agent 上报命令执行完成
 */
agentRouter.post('/windows/commands/:commandId/complete', async (req: Request, res: Response) => {
  try {
    const { commandId } = req.params;
    const { result } = req.body || {};
    logTrace('window-command', 'command_complete_received', {
      commandId,
      hasResult: !!result,
    });

    const pg = PgDatabase.getInstance();
    await pg.completeWindowCommand(commandId, result);

    res.json({
      ok: true,
      data: { commandId, status: 'done' },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/windows/commands/:id/complete] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});

/**
 * POST /agent/windows/commands/:commandId/fail — Agent 上报命令执行失败
 */
agentRouter.post('/windows/commands/:commandId/fail', async (req: Request, res: Response) => {
  try {
    const { commandId } = req.params;
    const { error } = req.body || {};

    const errorMsg = error && typeof error === 'string' ? error : '命令执行失败';
    warnTrace('window-command', 'command_fail_received', {
      commandId,
      error: errorMsg.slice(0, 200),
    });

    const pg = PgDatabase.getInstance();
    await pg.failWindowCommand(commandId, errorMsg);

    res.json({
      ok: true,
      data: { commandId, status: 'failed' },
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ ok: false, code: e.code, message: e.message, timestamp: new Date().toISOString() });
    console.error('[POST /agent/windows/commands/:id/fail] 失败:', e.message);
    res.status(500).json({ ok: false, code: 'UNKNOWN_ERROR', message: '服务器内部错误', timestamp: new Date().toISOString() });
  }
});
