// bnsy-operator-next 后端入口
// 启动 Express 服务，初始化 Database，初始化 BrowserPool，注册路由
//
// Phase K-3A: 窗口 CDP endpoint 暴露（ENABLE_WINDOW_CDP_ENDPOINT）
//
// Phase H: 完善优雅停机
//   - isShuttingDown 标志位 → 中间件拦截新请求（白名单放行健康检查）
//   - SIGINT / SIGTERM → cancelAllRunningTasks → 等待写入 → 断开浏览器 → 退出
//   - 10 秒硬兜底 → 防止进程僵死
//   - 移除无效的 60s cleanupRunningTasks 定时器

// ── 加载 .env 环境变量（Node 22+ 内置支持，.env 不存在时静默跳过）──
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
try {
  const envPath = join(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log('[ENV] .env loaded');
} catch {
  // .env 不存在，使用硬编码默认值
}

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'path';
import { BrowserPool } from './browser/BrowserPool';
import { SessionManager } from './browser/SessionManager';
import { WindowLockManager } from './browser/WindowLockManager';
import { Database } from './db/Database';
import { PgDatabase } from './db/PgDatabase';
import { runMigrations } from './db/migrations';
import { SettingsManager } from './config/SettingsManager';
import { AssignmentEngine } from './modules/assignment-engine/AssignmentEngine';
import { router } from './api/routes';
import { requestContext } from './api/middleware/requestContext';
import { authMiddleware, requireUserIfAuthRequired } from './auth';
import { authRouter } from './auth/authRoutes';
import { agentRouter } from './agent/agentRoutes';
import { windowRuntimeRouter } from './api/windowRuntimeRoutes';
import { pocRouter, PlaywrightRuntime } from './playwright-runtime';
import { pocAdapterRouter, adapterTestRouter } from './window-adapter';
import { taskEventBus } from './utils/TaskEventBus';
import { taskLogManager } from './utils/TaskLogManager';
import { getAgentWebSocket } from './agent/AgentWebSocket';

// 服务端口（DaoPai V4: 3400，与 V3 3300 完全隔离；可通过 .env 的 PORT 覆盖）
const PORT = parseInt(process.env.PORT || '3400', 10);

/** Backend process startup timestamp — exposed via /api/version and startup log */
const backendStartedAt = new Date().toISOString();

function getRuntimeGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: join(__dirname, '..'), encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getRuntimeBuildId(): string {
  // Use git hash as build ID in dev; in CI this would be overridden by env
  return process.env.BUILD_ID || getRuntimeGitHash();
}

function logBackendRuntimeProof(): void {
  console.log('[Backend][Version] ─────────────────────────────────────────');
  console.log(`[Backend][Version]   gitCommit   = ${getRuntimeGitHash()}`);
  console.log(`[Backend][Version]   buildId     = ${getRuntimeBuildId()}`);
  console.log(`[Backend][Version]   startedAt   = ${backendStartedAt}`);
  console.log(`[Backend][Version]   NODE_ENV    = ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Backend][Version]   PORT        = ${PORT}`);
  console.log('[Backend][Version] ─────────────────────────────────────────');
}

// Export version info for use by routes
export { getRuntimeGitHash, getRuntimeBuildId, backendStartedAt };

/** Phase H: 优雅停机标志位 — 收到信号后设为 true，中间件据此拒绝新请求 */
let isShuttingDown = false;

/** Phase H: 优雅停机超时（毫秒） — 超过此时间则 force exit */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Phase H: 优雅停机中间件
 *
 * 在所有业务路由之前拦截请求：
 *   - 如果 isShuttingDown === true 且请求路径不是健康检查/状态接口 → 返回 503
 *   - 健康检查白名单：/api/status /health — 保证停机期间监控不受影响
 */
function shutdownGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isShuttingDown) {
    return next();
  }

  // 白名单：健康检查和状态页面不受拦截
  if (req.path === '/api/status' || req.path === '/health') {
    return next();
  }

  // 也放行静态资源（前端页面），让用户看到 503 而不是空白页
  if (!req.path.startsWith('/api')) {
    return next();
  }

  console.log(`[Shutdown] 拒绝新请求: ${req.method} ${req.path}`);
  res.status(503).json({
    error: 'Service is shutting down',
    code: 'SHUTTING_DOWN',
    message: '服务正在重启中，请稍后刷新页面',
  });
}

/**
 * Phase H: 实用主义优雅停机
 *
 * 流程图：
 *   SIGINT/SIGTERM
 *     → isShuttingDown = true（拦截新请求）
 *     → cancelAllRunningTasks()（每个 Handler 收到 AbortError → 锁释放）
 *     → 等待批次数据写入完成（或 10s）
 *     → BrowserPool.closeAll()（断开所有 CDP 连接）
 *     → SessionManager.stopAllHeartbeats()
 *     → Database.close()（写入 db.json）
 *     → process.exit(0)
 *   // 10 秒超时 → process.exit(1) 强制退出
 */
function setupShutdownHandlers(): void {
  const performShutdown = async (signal: string) => {
    // 防止重复触发
    if (isShuttingDown) {
      console.log(`[Shutdown] 重复信号 ${signal}，已在进行中，忽略`);
      return;
    }

    console.log(`\n[Shutdown] ═══════════════════════════════════════════`);
    console.log(`[Shutdown] 收到 ${signal} 信号，开始优雅停机...`);
    console.log(`[Shutdown] ═══════════════════════════════════════════`);

    // Step 1: 拒绝新请求
    isShuttingDown = true;
    console.log(`[Shutdown] 已设置 isShuttingDown，新请求将被拒绝 (503)`);

    // Step 2: 取消所有运行中任务 → Handler 收到 AbortError → 锁释放
    console.log(`[Shutdown] 正在取消所有运行中任务...`);
    const engine = AssignmentEngine.getInstance();
    // Phase 2-C: await PG 终态写入完成（不再 fire-and-forget）
    const cancelledTaskIds = await engine.cancelAllRunningTasks();
    console.log(`[Shutdown] 已取消 ${cancelledTaskIds.length} 个运行中任务`);

    // Step 3: 等待 2 秒让 Handler 的 finally 块执行完毕（锁释放 + 批次写入完成）
    console.log(`[Shutdown] 等待 Handler 清理完成 (2s)...`);
    await new Promise(resolve => setTimeout(resolve, 2_000));

    // Step 4: 断开所有浏览器连接 + 释放所有资源（限时 8 秒，共 10 秒总限）
    console.log(`[Shutdown] 正在断开所有浏览器连接...`);

    try {
      await Promise.race([
        (async () => {
          // 停止健康巡检
          const pool = BrowserPool.getInstance();
          pool.stopHealthMonitor();
          console.log(`[Shutdown] 已停止健康巡检`);

          // 停止所有心跳
          SessionManager.getInstance().stopAllHeartbeats();
          console.log(`[Shutdown] 已停止所有窗口心跳`);

          // 断开所有 CDP 连接
          await pool.closeAll();
          console.log(`[Shutdown] 已断开所有浏览器连接`);

          // 关闭所有 Playwright 原生窗口（Phase 1 POC）
          await PlaywrightRuntime.getInstance().closeAll();
          console.log(`[Shutdown] 已关闭所有 Playwright 原生窗口`);

          // 写回 db.json
          const db = Database.getInstance();
          db.close();
          console.log(`[Shutdown] 已关闭数据库连接`);

          console.log(`[Shutdown] ═══════════════════════════════════════════`);
          console.log(`[Shutdown] 优雅停机完成`);
          console.log(`[Shutdown] ═══════════════════════════════════════════\n`);
          process.exit(0);
        })(),
        new Promise<void>(resolve => setTimeout(() => {
          console.error(`[Shutdown] ═══════════════════════════════════════════`);
          console.error(`[Shutdown] 超时 (${SHUTDOWN_TIMEOUT_MS / 1000}s)，强制退出！`);
          console.error(`[Shutdown] 可能的原因：浏览器连接卡死、网络超时`);
          console.error(`[Shutdown] ═══════════════════════════════════════════\n`);
          resolve(); // resolve 后退出，不依赖 process.exit 的位置
        }, SHUTDOWN_TIMEOUT_MS - 2_000)), // 减去前面等待的 2 秒
      ]);
    } catch (err) {
      console.error(`[Shutdown] 停机过程出错:`, (err as Error).message);
    }

    // 兜底：如果 10 秒内没退出（Promise.race 的 resolve 分支），强制退出
    process.exit(1);
  };

  process.on('SIGINT', () => performShutdown('SIGINT'));
  process.on('SIGTERM', () => performShutdown('SIGTERM'));
}

logBackendRuntimeProof();

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  bnsy-operator-next DaoPai 网点操作中心');
  console.log('  (Playwright 原生 + 会员隔离 - 下一代)');
  console.log('═══════════════════════════════════════════\n');

  // 初始化数据库（必须在 BrowserPool 之前）
  // ★ P0 修复：必须用 getInstance() 而非 new Database()
  // new Database() 会创建独立实例 A，但 BrowserPool/AssignmentEngine/routes 都通过
  // Database.getInstance() 拿到的实例 B 是一个空 store。当 BrowserPool 调用
  // upsertWindow → saveJson() 时，空 store 覆盖 db.json，导致所有已持久化数据丢失。
  const db = Database.getInstance();
  db.init();
  console.log(`[Database] 启动模式：${process.env.NODE_ENV === 'production' ? 'SQLite' : 'JSON文件'}`);

  // TC-05B: 连接 TaskLogManager → TaskEventBus，日志写入时自动广播 TASK_LOG 事件
  taskLogManager.setLogCallback((entry) => {
    taskEventBus.emit({ type: 'TASK_LOG', taskId: entry.taskId, payload: entry });
  });

  // Phase G-1: 启动时僵尸任务恢复
  // 扫描所有 status='running' 的任务，自动标记为 failed
  // 兼容所有任务类型，禁止业务特判
  // Phase H: 同时清理超时锁 → 服务重启后窗口锁自动释放
  // Phase 2-C-1: 移至 PG init 之后执行（recoverRunningTasks 已改为 async，需要 PG 可用）
  //   → 见 app.listen 回调中的 async IIFE

  // Phase H: 启动时清理所有可能残留的窗口锁
  const lockManager = WindowLockManager.getInstance();
  const overdueLocks = lockManager.getOverdueLocks(0); // 0ms → 清理所有锁
  for (const lock of overdueLocks) {
    console.log(`[启动] 清理残留锁: windowId=${lock.windowId} taskId=${lock.taskId}`);
    lockManager.release(lock.windowId);
  }
  console.log(`[启动] 已清理 ${overdueLocks.length} 个残留窗口锁`);

  // 创建 Express 应用
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Phase H: 优雅停机中间件（必须在业务路由之前，但健康检查白名单放行）
  app.use(shutdownGuard);

  // Phase 3-A: 认证中间件（当前占位 — 注入 anonymous principal）
  // 未来此处解析 JWT / Agent Token → 注入真实 principal → 更新 req.tenantId/workstationId
  app.use(authMiddleware);

  // Phase 2-E: 请求上下文中间件（注入 req.tenantId / req.workstationId / req.requestId）
  // 当前默认值：tenant-default / ws-local-default，后续从 JWT / Agent Token 解析
  app.use(requestContext);

  // 注册 API 路由
  app.use(authRouter);   // Phase 3-B: Auth 路由（必须在 authMiddleware 之后，且必须在 requireUserIfAuthRequired 之前）

  // Phase 4-E: Agent 路由（使用执行电脑授权码鉴权，与用户 JWT 分离，必须在 requireUserIfAuthRequired 之前）
  app.use('/agent', agentRouter);

  // Phase 3-C: 业务 API 认证保护（AUTH_REQUIRED=false 时兼容 anonymous）
  // 必须在 authRouter 之后、router 之前，确保：
  //   - /api/auth/* 不受保护（authRouter 已先处理）
  //   - 业务 API 受 AUTH_REQUIRED 开关控制
  app.use(requireUserIfAuthRequired);

  app.use(router);

  // Phase 4-B: Window Runtime 适配路由（runtimeMode 感知 + playwright 窗口状态/启动）
  // 独立于 routes.ts 业务接口，仅用于 Header 在 playwright 模式下的状态展示
  app.use(windowRuntimeRouter);

  // Phase 1 POC: Playwright 原生窗口运行时路由（独立于正式任务路由）
  app.use('/api/playwright-poc', pocRouter);

  // Phase 2-A: Window Adapter 适配层路由（独立于正式任务路由）
  app.use('/api/window-adapter-poc', pocAdapterRouter);

  // Phase 2-B: Adapter 测试任务路由（独立 POC 接口，不污染正式业务接口）
  app.use('/api/playwright-adapter-test', adapterTestRouter);

  // 静态托管前端构建产物（生产环境）
  const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
  app.use(express.static(frontendDist));
  // SPA 回退：所有非 /api 请求返回 index.html
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
        if (err) next(err);
      });
    } else {
      // /api/* requests not matched by any route → 404
      res.status(404).json({ error: 'Not Found', code: 'NOT_FOUND', path: req.path });
    }
  });

  // C6: 全局错误处理中间件（必须放在所有路由注册之后）
  // 统一返回结构化 JSON，避免 Express 默认 HTML 错误页
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[全局错误处理]', err.message);
    // body-parser JSON 解析失败等（err.type 是 body-parser 特有属性）
    const errType = (err as Error & { type?: string }).type;
    if (errType === 'entity.parse.failed' || err.message.includes('JSON')) {
      return res.status(400).json({ error: '请求体 JSON 格式错误', code: 'BAD_JSON' });
    }
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  // Phase H: 注册优雅停机信号处理器
  setupShutdownHandlers();

  // 启动服务 (S2: 使用 http.Server 以支持 WebSocket)
  const server = http.createServer(app);
  getAgentWebSocket().attach(server);

  server.listen(PORT, () => {
    console.log(`\n[启动] Express 服务已启动: http://localhost:${PORT}`);
    console.log('[启动] 前端开发模式请另行启动 vite dev（cd frontend && npm run dev）\n');

    // 启动时执行数据库初始化 + migration + 网点同步
    // Phase 2-B: 新增 migration 执行步骤
    (async () => {
      try {
        const pg = PgDatabase.getInstance();

        // 1. 执行 init-schema.sql（幂等，CREATE IF NOT EXISTS）
        await pg.init();

        // 2. 执行 migrations（Phase 2-B: 多租户基础）
        try {
          const result = await runMigrations(pg.getPool());
          if (result.applied.length > 0) {
            console.log(`[启动] Migration 已应用: ${result.applied.join(', ')}`);
          }
        } catch (migErr) {
          console.warn('[启动] Migration 执行失败（不影响启动，但多租户列可能缺失）:', (migErr as Error).message);
        }

        // 3. 同步 settings.json 中的网点 id/name 到 PG sites 表
        const sm = SettingsManager.getInstance();
        const cfg = await sm.getConfig();
        if (cfg.sites.length > 0) {
          await pg.syncSitesFromSettings(cfg.sites);
          console.log(`[启动] 已同步 ${cfg.sites.length} 个网点到 PG sites 表`);
        }

        // 4. Phase 2-D: 确保默认工作站存在（migration 002 已插入，此处做运行时验证）
        const wsReady = await pg.ensureDefaultWorkstation();
        console.log(`[启动] 默认工作站 ws-local-default ${wsReady ? '已就绪' : '未找到（请检查 migration 002）'}`);

        // 5. Phase 3-B: 创建默认超级管理员（幂等，首次启动时创建）
        await pg.createBootstrapAdminIfMissing();

        // 6. Phase 2-C-1: 僵尸任务恢复（PG 已就绪，优先写 PG）
        const recovered = await AssignmentEngine.recoverRunningTasks();
        if (recovered > 0) {
          console.log(`[启动] 僵尸任务恢复完成: ${recovered} 个任务 running → failed`);
        }
      } catch (e) {
        console.warn('[启动] PG 初始化失败（不影响启动，JSON 模式仍可用）:', (e as Error).message);
      }
    })();
  });

  // M5-2A LEGACY ONLY:
  // BrowserPool.init() / EasyBR initialization has been REMOVED from V4 startup.
  // V4 window lifecycle: Agent WS commands → Portable Chrome (startup/close),
  //   SSE + playwright-windows endpoint (status), PlaywrightWindowAdapter (tasks).
  // V4 default path must not initialize BrowserPool/EasyBR.
  // Local Agent + Portable Chrome is the only official V4 window lifecycle path.

  // Phase G-2: 超时锁自动释放巡检（60 秒）
  // 发现窗口已锁定且超过 5 分钟，自动释放，避免任务异常退出导致窗口永久锁死
  const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
  setInterval(() => {
    if (isShuttingDown) return;
    const overdueLocks2 = lockManager.getOverdueLocks(LOCK_TIMEOUT_MS);
    for (const lock of overdueLocks2) {
      console.warn(
        `[LockWatchdog] 检测到超时锁，已自动释放 窗口: ${lock.windowId} taskId: ${lock.taskId} 锁定时长: ${((Date.now() - lock.acquiredAt) / 1000).toFixed(0)}s`,
      );
      lockManager.release(lock.windowId);
    }
  }, 60 * 1000);

  // 全局未捕获异常保护 - 防止 Playwright ProtocolError 等导致进程崩溃
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    // 不退出进程，防止 CDP dialog 等异步异常导致服务中断
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
    // 只有致命错误（如端口占用）才退出
    if (err.message.includes('EADDRINUSE')) {
      console.error('[uncaughtException] 端口已被占用，退出进程');
      process.exit(1);
    }
  });
}

main().catch(e => {
  console.error('[启动] 致命错误:', e);
  // 只有端口占用才退出，其他错误记录但不退出
  if (e && (e as any).message && (e as any).message.includes('EADDRINUSE')) {
    process.exit(1);
  }
  // 非致命错误不退出，Express 可能已启动
  console.error('[启动] 非致命错误，服务可能已部分启动');
});
