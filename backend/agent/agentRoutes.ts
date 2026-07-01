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
import { AssignmentEngine, ArrivalHandler, DispatchHandler, IntegratedHandler, SignHandler, type Assignment } from '../modules/assignment-engine';
import type { Site } from '../db/Database';

export const agentRouter = Router();

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

function getEngineHandler(taskType: string) {
  switch (taskType) {
    case 'arrival':
    case 'arrive':
      return { taskType: 'arrival' as const, handler: new ArrivalHandler() };
    case 'dispatch':
      return { taskType: 'dispatch' as const, handler: new DispatchHandler() };
    case 'integrated':
      return { taskType: 'integrated' as const, handler: new IntegratedHandler() };
    case 'sign':
      return { taskType: 'sign' as const, handler: new SignHandler() };
    default:
      return null;
  }
}

function normalizeTaskAssignments(inputData: unknown): { assignments: Assignment[]; waybillNos?: string[] } {
  const payload = (inputData && typeof inputData === 'object') ? inputData as Record<string, any> : {};
  const rawAssignments = Array.isArray(payload.assignments) ? payload.assignments : [];
  const assignments = rawAssignments
    .filter(a => a && typeof a.staffName === 'string')
    .map(a => ({
      ...a,
      staffName: String(a.staffName),
      waybillNos: Array.isArray(a.waybillNos) ? a.waybillNos.map(String) : [],
    }));
  const waybillNos = Array.isArray(payload.waybillNos) ? payload.waybillNos.map(String) : undefined;
  return { assignments, waybillNos };
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
    const { agentVersion, machineFingerprint, browserStatus } = req.body || {};

    const pg = PgDatabase.getInstance();
    await pg.updateWorkstationHeartbeat({
      workstationId,
      tenantId,
      browserStatus: browserStatus || 'unknown',
      agentVersion: agentVersion || 'unknown',
      machineFingerprint: machineFingerprint || 'unknown',
      lastIp: req.ip || req.socket.remoteAddress || 'unknown',
    });

    await pg.touchAgentToken(workstationId);

    // Phase 4-F: 检查是否有待执行任务
    const hasTask = await pg.hasPendingTask(tenantId);

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

    const pg = PgDatabase.getInstance();
    const task = await pg.pullPendingTask(tenantId, workstationId);

    if (!task) {
      return res.json({
        ok: true,
        data: { hasTask: false, task: null, nextPollAfterMs: 5000 },
        timestamp: new Date().toISOString(),
      });
    }

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
  const tEntry = Date.now();
  try {
    const { tenantId, workstationId } = getAgentPrincipal(req);
    const taskId = req.params.id;
    console.log(`[run-engine] T5 收到请求: taskId=${taskId} t=${tEntry}`);

    const pg = PgDatabase.getInstance();
    const task = await pg.getTaskById(tenantId, taskId);
    console.log(`[run-engine] getTaskById 耗时 ${Date.now() - tEntry}ms taskId=${taskId}`);

    if (!task) {
      return res.status(404).json({
        ok: false,
        code: 'TASK_NOT_FOUND',
        message: '任务不存在',
        timestamp: new Date().toISOString(),
      });
    }

    const selected = getEngineHandler(task.type);
    if (!selected) {
      return res.status(400).json({
        ok: false,
        code: 'TASK_TYPE_UNSUPPORTED',
        message: `不支持的业务任务类型：${task.type}`,
        timestamp: new Date().toISOString(),
      });
    }

    const { assignments, waybillNos } = normalizeTaskAssignments(task.inputData);
    const assignmentPreview = assignments.map(a => ({
      staffName: a.staffName,
      siteId: (a as any).siteId,
      windowId: a.windowId,
      browserId: (a as any).browserId,
      runtimeKey: (a as any).runtimeKey,
      waybillCount: a.waybillNos.length,
    }));

    console.log('[AgentRoute][run-engine payload]', {
      taskId,
      type: task.type,
      site: task.site,
      status: task.status,
      assignmentCount: assignments.length,
      assignmentsPreview: assignmentPreview,
      hasWaybillFallback: !!waybillNos?.length,
    });

    await taskLogService.appendLogs(taskId, [
      {
        level: 'info',
        message: `Agent 已接管业务页任务，准备按员工窗口执行：员工数=${assignments.length || '(自动)'}，类型=${selected.taskType}`,
      },
      ...assignments.map(a => ({
        level: 'info' as const,
        staffName: a.staffName,
        windowId: a.windowId,
        message: `准备执行员工：${a.staffName}，单号数：${a.waybillNos.length}` +
          ((a as any).runtimeKey ? `，runtimeKey=${(a as any).runtimeKey}` : ''),
      })),
    ], {
      tenantId,
      workstationId,
      source: 'agent-engine',
    });

    console.time(`Engine-execute-${taskId}`);
    console.log(`[run-engine] T6 Engine.execute 开始: taskId=${taskId} 距入口 ${Date.now() - tEntry}ms`);

    await AssignmentEngine.getInstance().execute({
      taskId,
      site: task.site as Site,
      taskType: selected.taskType,
      assignments,
      waybillNos,
      handler: selected.handler,
    });

    console.timeEnd(`Engine-execute-${taskId}`);
    console.log(`[run-engine] Engine.execute 完成: taskId=${taskId} 总耗时 ${Date.now() - tEntry}ms`);

    res.json({
      ok: true,
      data: { accepted: true, taskId },
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

    // 日志写入完成后再更新任务状态
    const updated = await pg.completeAgentTask(taskId, tenantId, workstationId);

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
