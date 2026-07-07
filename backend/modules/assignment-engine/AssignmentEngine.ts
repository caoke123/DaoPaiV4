// AssignmentEngine — 统一任务执行引擎
// Phase D-1: 将 arrival/dispatch/integrated 三种任务的执行链路统一
//
// 职责（Engine 负责，Handler 不涉及）：
//   1. updateTask(running)
//   2. 获取 Worker Connection（getStaffConnection）
//   3. acquire 窗口锁（抢占式）
//   4. 创建 staffLog（带 staffName+windowId 上下文）
//   5. 调用 handler.executeWorker
//   6. release 窗口锁（finally 幂等释放）
//   7. updateTask(done/failed/cancelled)
//   8. RuntimeMetrics 汇总
//   9. 统一异常处理（WindowBusyError / 连接失败 / 业务异常）
//
// 并发模型：
//   - 所有任务类型均使用 Promise.all 并发执行多个 Assignment
//   - Arrival 通常只有 1 个 Assignment（方案B 自动选择 Worker）
//   - Dispatch/Integrated 可有多个 Assignment（多窗口并发）
//
// Phase G-3: 全局超时控制 + 取消机制
//   - 每个 Handler 有独立硬超时（handlerTimeoutMs，默认 30 分钟）
//   - AbortController 统一管理：外部取消 / 空闲超时 / 绝对上限均通过 abort() 终止 Handler
//   - 取消时锁在 executeAssignment.finally 中强制释放
//   - cancelControllers Map 在任务彻底结束后 delete，防止内存泄漏
//
// Phase I: 批次级增量结果持久化
//   - 废除 allResults 全量内存缓存 → 替换为 totalDone / totalFail 计数器
//   - 每批次结果通过 db.appendTaskResults 增量追加（不再全量 stringify）
//   - 简易 Promise 链（无第三方依赖）保证同一任务写入串行
//   - 任务完成时不再写 result_data，只标记 status
//
// 进度模型：
//   - Handler 通过 onProgress 回调上报每批新增结果
//   - Engine 用计数器 totalDone / totalFail 统计
//   - 每批次到达时：计数器 → db.updateTask(仅更新计数字段) + db.appendTaskResults(追加批次)
//   - Assignment 级失败（锁/连接）由 Engine 生成 failResults 并上报
import { BrowserPool, type WindowLeaseHandle } from '../../browser/BrowserPool';
import { WindowBusyError, WindowLockManager } from '../../browser/WindowLockManager';
import { Database, type Site, type WindowInfo } from '../../db/Database';
import { PgDatabase } from '../../db/PgDatabase';
import { SettingsManager } from '../../config/SettingsManager';
import { getRuntimeMode, shouldUsePlaywrightAdapter } from '../../config/runtimeMode';
import { taskLogManager } from '../../utils/TaskLogManager';
import { taskEventBus } from '../../utils/TaskEventBus';
import { RuntimeMetrics } from '../../runtime/RuntimeMetrics';
import { WindowAdapterRegistry } from '../../window-adapter/WindowAdapterRegistry';
import type { WindowAdapterOptions } from '../../window-adapter/types';
import { DEFAULT_TENANT_ID, buildRuntimeKey } from '../../playwright-runtime/types';
import type { OperationResult } from '../../operations/BaseOperation';
import type { Assignment, TaskContext, LogFn, ProgressFn, WorkerConnectionHandle } from './types';
import type { TaskHandler } from './handlers/TaskHandler';
import type { TaskLogEntry, WaybillResultStatus } from '../../types/api-contracts';
import type { Page } from 'playwright';
import { BusinessPageNavigator } from '../../browser/BusinessPageNavigator';

/** Engine 执行参数 */
export interface EngineExecuteOptions {
  taskId: string;
  site: Site;
  taskType: 'arrival' | 'dispatch' | 'sign' | 'integrated' | 'init_window';
  assignments: Assignment[];
  handler: TaskHandler;
  /** Phase G-3: 单个 Handler 硬超时（毫秒），默认 30 分钟。超时后 Handler 被终止，锁强制释放 */
  handlerTimeoutMs?: number;
  /** Phase 8.2: 旧兼容模式（arrival waybillNos），自动选 worker */
  waybillNos?: string[];
  /** Phase 5-I-1: 任务原始 inputData，用于解析任务级 dryRun */
  inputData?: unknown;
}

// ── 超时常量 ──────────────────────────────────────────

/** Phase G-3: 默认 Handler 硬超时 30 分钟 */
const DEFAULT_HANDLER_TIMEOUT_MS = 30 * 60 * 1000;

// Phase G-2: 空闲超时保护
// 设计思路：
//   主策略 — 空闲超时：进度持续更新 → 不限时；连续 90 秒无进度 → 判定卡死，终止
//   兜底策略 — 绝对上限：防止"进度一直在更新但永远跑不完"的极端死循环
//   首次进度宽限期：启动后 120 秒内首次心跳还没来 → 判定启动失败
const IDLE_TIMEOUT_MS = 90_000;           // 卡住 90 秒 → 终止
const CHECK_INTERVAL_MS = 5_000;          // 每 5 秒巡检一次
const FIRST_PROGRESS_GRACE_MS = 120_000;  // 首次进度宽限 120 秒

/** 绝对上限 — 正常任务不可能触达，仅防极端死循环 */
function getAbsoluteTimeout(taskType: string): number {
  switch (taskType) {
    case 'arrival':      return 900_000;   // 15 分钟
    case 'dispatch':     return 1_800_000; // 30 分钟
    case 'integrated':   return 1_800_000; // 30 分钟
    case 'sign':         return 300_000;   // 5 分钟
    case 'init_window':  return 120_000;   // 2 分钟（窗口初始化含登录）
    default:             return 900_000;
  }
}

// ── 辅助函数 ──────────────────────────────────────────

/**
 * 创建 AbortSignal 的 Promise，当 signal 被 abort 时 reject
 */
function createAbortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      const err = new Error('任务已取消');
      (err as any).name = 'AbortError';
      reject(err);
      return;
    }
    const onAbort = () => {
      const err = new Error('任务已取消');
      (err as any).name = 'AbortError';
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 创建超时 Promise：到达毫秒数后 reject
 * 返回 { promise, clear }，调用方负责在不需要时 clear 防止定时器泄漏
 */
function createTimeoutPromise(ms: number, label: string): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Handler 执行超时 (${label}, ${ms / 1000}s)`)), ms);
  });
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * 判断 error 是否为 AbortError（外部取消触发）
 */
function isAbortError(err: unknown): boolean {
  return (err as any)?.name === 'AbortError';
}

/**
 * AssignmentEngine 单例
 *
 * 使用方式：
 *   const engine = AssignmentEngine.getInstance();
 *   await engine.execute({ taskId, site, taskType, assignments, handler });
 *
 * 取消任务：
 *   engine.cancelTask(taskId); // → controller.abort() → handlers 终止 → 锁释放 → status='cancelled'
 */
export class AssignmentEngine {
  private static instance: AssignmentEngine | null = null;

  /**
   * Phase G-3: 取消控制器映射表
   * Key: taskId, Value: AbortController
   *
   * 【内存泄漏防护】：任务彻底结束（成功/失败/超时/取消）后，在 execute() 的 finally 块中 delete。
   */
  private cancelControllers = new Map<string, AbortController>();

  private constructor() {}

  static getInstance(): AssignmentEngine {
    if (!AssignmentEngine.instance) {
      AssignmentEngine.instance = new AssignmentEngine();
    }
    return AssignmentEngine.instance;
  }

  /** 获取当前活跃 worker 数（Engine 中正在运行的任务数） */
  getActiveWorkerCount(): number {
    return this.cancelControllers.size;
  }

  /**
   * Phase G-3: 取消指定任务
   *
   * 执行顺序（符合约束"先 abort，再写 DB"）：
   *   1. 查找 cancelControllers Map 中的 AbortController
   *   2. 调用 controller.abort() → 所有 Handler 收到 AbortError，终止执行
   *   3. 立即更新 DB 状态为 'cancelled'（早于 Engine catch 块，防止被覆盖为 'failed'）
   *   4. 从 Map 中 delete（防止后续重复取消）
   *
   * Phase 2-C: 改为 async，await PG 终态/日志写入完成（不再 fire-and-forget）。
   *   - abort() 仍同步执行（立即终止 Handler）
   *   - PG 写入失败时 throw（不再静默成功），路由层 catch 返回 500
   *
   * @param taskId 要取消的任务 ID
   * @returns true=成功取消，false=任务未在运行中（已完成或不存在）
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const controller = this.cancelControllers.get(taskId);
    if (!controller) {
      console.warn(`[Engine] cancelTask: 任务 ${taskId} 未在运行中，无法取消`);
      return false;
    }

    // Step 1: 先 abort（触发所有 executeAssignment 中的 AbortError）
    controller.abort();

    // Step 2: 再更新 DB 状态为 cancelled
    const db = Database.getInstance();
    const task = db.getTask(taskId);
    if (task && task.status === 'running') {
      const now = new Date().toISOString();
      // LEGACY MIRROR: db.updateTask（best-effort）
      try {
        db.updateTask(taskId, {
          status: 'cancelled',
          finished_at: now,
        });
      } catch (e) {
        console.warn(`[Engine][DB] cancelTask legacy mirror failed (task=${taskId}):`, (e as Error).message);
      }
      taskLogManager.addLog(taskId, 'warning', '任务已被手动取消', 'Engine');
      console.log(`[Engine] 任务 ${taskId} 已取消 (status: cancelled)`);

      // Phase 2-C-1: PG 主写 — CRITICAL await 终态 + 日志（失败 throw，不允许静默成功）
      const pgDb = PgDatabase.getInstance();
      try {
        await pgDb.updateTaskStatus(taskId, {
          status: 'cancelled',
          finishedAt: now,
        });
      } catch (err) {
        const errMsg = `[Engine][PG] 取消终态更新失败 (task=${taskId}): ${(err as Error).message}`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
      try {
        await pgDb.insertTaskLogs([{
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          taskId,
          timestamp: Date.now(),
          level: 'warning',
          message: '任务已被手动取消',
          source: 'Engine',
        }]);
      } catch (err) {
        const errMsg = `[Engine][PG] 取消日志写入失败 (task=${taskId}): ${(err as Error).message}`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
    }

    // Step 3: 从 Map 中移除（execute() finally 也会 delete，此处提前清理无害）
    this.cancelControllers.delete(taskId);
    return true;
  }

  /**
   * Phase H: 批量取消所有正在运行中的任务（优雅停机专用）
   *
   * 遍历 cancelControllers Map 中的所有 taskId，逐一调用 cancelTask()。
   * 每个 Handler 收到 AbortError 后释放锁 → finally 块执行 → 锁回收。
   *
   * Phase 2-C: 改为 async，await 每个 cancelTask 的 PG 写入完成。
   *
   * @returns 被取消的 taskId 列表
   */
  async cancelAllRunningTasks(): Promise<string[]> {
    const taskIds = Array.from(this.cancelControllers.keys());
    if (taskIds.length === 0) {
      console.log('[Engine] cancelAllRunningTasks: 没有运行中的任务');
      return [];
    }
    console.log(`[Engine] cancelAllRunningTasks: 正在取消 ${taskIds.length} 个运行中任务...`);
    for (const taskId of taskIds) {
      // 复用已有的 cancelTask，保证一致的 abort → DB 更新 → delete 流程
      await this.cancelTask(taskId);
    }
    console.log(`[Engine] cancelAllRunningTasks: 完成，已取消 ${taskIds.length} 个任务`);
    return taskIds;
  }

  /**
   * 执行任务（异步，不抛出 — 内部捕获所有异常并更新任务状态）
   *
   * 调用方（routes.ts）负责：
   *   - 请求体校验
   *   - createTask（同步返回 taskId）
   *   - 立即返回 { taskId, status: 'pending' }
   *   - 调用 engine.execute()（异步执行，不 await）
   */
  async execute(options: EngineExecuteOptions): Promise<void> {
    const tEngineStart = Date.now();
    const {
      taskId, site, taskType, assignments: initialAssignments, handler,
      handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
      waybillNos,
      inputData,
    } = options;
    console.log(`[Engine.execute] T6 开始: taskId=${taskId} type=${taskType} assignments=${initialAssignments.length} workers=${initialAssignments.map(a => a.staffName).join(',')}`);
    const db = Database.getInstance();
    const pool = BrowserPool.getInstance();

    // Phase 5-I-1: 任务级 dryRun 优先，全局 SettingsManager 仅兜底
    const { browserDryRun: resolvedDryRun, source: dryRunSource } = await SettingsManager.resolveTaskDryRun(inputData);
    const dryRunMode = resolvedDryRun;
    console.log(`[Engine.execute] [执行配置] browserDryRun=${dryRunMode}，来源=${dryRunSource}`);

    const taskContext: TaskContext = { taskId, site, taskType, dryRunMode };

    // PG 数据库（Phase 2-C: 主数据源 — 写入失败必须明确处理，不再 fire-and-forget）
    const pgDb = PgDatabase.getInstance();

    // Phase I: 废除 allResults 全量内存缓存，改用计数器
    let totalDone = 0;
    let totalFail = 0;

    // Phase I: 简易 Promise 链 — 保证同一任务的结果写入串行执行（不依赖第三方库）
    // 多 Assignment 并发 onProgress → 通过 writeChain 排队写入 → 避免竞态覆盖
    // Phase 2-C: PG 写入也链入 writeChain，确保 await writeChain 时 PG 写入也完成
    let writeChain: Promise<void> = Promise.resolve();

    // Phase 2-C: PG 写入错误跟踪标志
    //   - 批次结果/运单池写入失败时置位
    //   - 任务结束时检查此标志，若为 true 则任务标记为 failed（不能标记 done）
    //   - 使用 wrapper 对象避免 TS 控制流分析将闭包赋值窄化为 never
    const pgWriteState: { error: Error | null } = { error: null };

    // PG: 批次序号 + 日志缓冲（任务结束时冲刷）
    let pgBatchSeq = 0;
    const pgLogBuffer: TaskLogEntry[] = [];
    // BEST-EFFORT: 执行中日志批量冲刷（不阻塞任务，仅记录错误）
    const flushPgLogs = async (): Promise<void> => {
      if (pgLogBuffer.length === 0) return;
      const batch = pgLogBuffer.splice(0);
      try {
        await this.insertTaskLogsAndEmit(pgDb, batch);
      } catch (err) {
        console.error(`[Engine][PG] 日志批量写入失败 (task=${taskId}):`, (err as Error).message);
        // 日志写入失败不中断任务，但记录错误
      }
    };

    // Phase 5-G-4: 定期冲刷 PG 日志缓冲（每 2 秒），确保员工连接准备阶段日志实时可见
    const pgFlushTimer = setInterval(() => {
      flushPgLogs().catch(() => {});
    }, 2000);

    // Phase G-3: 创建 AbortController，存入 Map
    const abortController = new AbortController();
    this.cancelControllers.set(taskId, abortController);

    // Phase 8.2: 旧兼容模式 — waybillNos 模式下自动选择 Worker
    let assignments = initialAssignments;
    const totalCount = (assignments.length > 0
      ? assignments.reduce((s, a) => s + a.waybillNos.length, 0)
      : (waybillNos?.length || 0));

    /** 进度回调：更新计数器 + 增量追加批次结果 */
    const onProgress: ProgressFn = (_done, newResults) => {
      if (newResults.length === 0) return;

      // 1. 更新计数器（纯数字，O(1)）
      totalDone += newResults.length;
      const failInBatch = newResults.filter(r => !r.success).length;
      totalFail += failInBatch;

      // 2. LEGACY MIRROR: db.updateTask（best-effort，不阻塞进度上报）
      try {
        db.updateTask(taskId, { done_count: totalDone, fail_count: totalFail });
      } catch (e) {
        console.warn(`[Engine][DB] updateTask legacy mirror failed (task=${taskId}):`, (e as Error).message);
      }

      // 3. LEGACY MIRROR: db.appendTaskResults（via writeChain，best-effort）
      //    不 await — 不让磁盘 IO 阻塞进度上报
      writeChain = writeChain.then(() =>
        db.appendTaskResults(taskId, newResults),
      ).catch(() => {
        // appendTaskResults 内部已 try-catch，不会真进这里。兜底忽略。
      });

      // 4. ★ Phase 2-C: PG 主写 — 批次结果 + 运单池 UPSERT（链入 writeChain，await）
      //    不再 fire-and-forget；写入失败设置 pgWriteError，任务终态强制 failed
      pgBatchSeq++;
      const currentBatchSeq = pgBatchSeq;
      writeChain = writeChain.then(async () => {
        await pgDb.updateTaskStatus(taskId, {
          status: 'running',
          doneCount: totalDone,
          failCount: totalFail,
        });
        // 4a. 批次结果批量写入
        await pgDb.insertWaybillResults(taskId, currentBatchSeq, newResults);
        // 4b. 运单池 UPSERT：每条结果更新 waybill_pool 最新状态
        for (const r of newResults) {
          let rStatus: WaybillResultStatus;
          if (r.dryRun && r.skippedFinalSubmit) {
            rStatus = 'DRY_RUN_SKIPPED';
          } else {
            rStatus = r.status || (r.success ? 'SUCCESS' : 'FAILED');
          }
          await pgDb.upsertWaybillPool(
            r.waybillNo,
            site,
            rStatus,
            taskId,
          );
        }
        await flushPgLogs();
      }).catch(err => {
        console.error(`[Engine][PG] 批次结果写入失败 (task=${taskId}, batch=${currentBatchSeq}):`, (err as Error).message);
        // 记录 PG 写入错误，任务终态将强制为 failed
        if (!pgWriteState.error) pgWriteState.error = err as Error;
      });

      // 5. TC-05B: 通过 SSE 推送进度更新事件
      taskEventBus.emit({
        type: 'TASK_PROGRESS',
        taskId,
        done: totalDone,
        total: totalCount,
        success: totalDone - totalFail,
        failed: totalFail,
      });
    };

    try {
      // Phase 2-C: PG 主写 — status='running'（await，失败抛出 → 进入 catch 标记 failed）
      try {
        await pgDb.updateTaskStatus(taskId, { status: 'running' });
      } catch (e) {
        console.error(`[Engine][PG] 任务状态更新为 running 失败 (task=${taskId}):`, (e as Error).message);
        throw new Error(`PG 任务状态更新失败（running）: ${(e as Error).message}`);
      }
      // LEGACY MIRROR: db.updateTask（best-effort）
      try {
        db.updateTask(taskId, { status: 'running' });
      } catch (e) {
        console.warn(`[Engine][DB] updateTask(running) legacy mirror failed (task=${taskId}):`, (e as Error).message);
      }

      // Phase 5-I-1: 记录当前运行模式 + dryRun 来源
      const modeLabel = dryRunMode ? '试运行模式（跳过最终提交）' : '真实执行模式';
      const dryRunLogMsg = `当前运行模式：${modeLabel}，来源=${dryRunSource}`;
      taskLogManager.addLog(taskId, 'info', dryRunLogMsg, 'Engine');
      pgLogBuffer.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId, timestamp: Date.now(), level: 'info',
        message: dryRunLogMsg,
        source: 'Engine',
      });

      // Phase 2-D: 记录 Window Runtime Mode（每次任务都输出，便于回归确认）
      const runtimeMode = getRuntimeMode();
      const usePlaywrightForSign = shouldUsePlaywrightAdapter(taskType);
      const runtimeModeMsg = `runtimeMode=${runtimeMode} taskType=${taskType} usePlaywright=${usePlaywrightForSign}`;
      taskLogManager.addLog(taskId, 'info', runtimeModeMsg, 'Engine');
      pgLogBuffer.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId, timestamp: Date.now(), level: 'info',
        message: runtimeModeMsg,
        source: 'Engine',
      });
      console.log(`[Engine] ${runtimeModeMsg}`);

      // D-0B: EasyBR health check removed — all tasks now use V3 Playwright runtime mode

      // Phase 8.2: 旧兼容模式 — waybillNos 自动选择 Worker（统一进入 Engine 生命周期）
      if (assignments.length === 0 && waybillNos && waybillNos.length > 0) {
        const { staffName, windowId } = AssignmentEngine.selectOnlineWorker(site);
        taskLogManager.addLog(taskId, 'info', `自动选择 Worker: ${staffName} (windowId=${windowId}, site=${site})`, 'Engine');
        pgLogBuffer.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          taskId, timestamp: Date.now(), level: 'info',
          message: `自动选择 Worker: ${staffName} (windowId=${windowId}, site=${site})`,
          source: 'Engine',
        });
        assignments = [{ staffName, waybillNos }];
      }

      // Phase 2-C: 移除 pgDb.insertTask — 任务创建已由 routes.ts 以 PG 主写完成
      //   （原 fire-and-forget insertTask 会因 duplicate key 静默失败，现已删除）
      //   Engine 只需 updateTaskStatus(running)，已在 try 块开头完成。

      taskLogManager.addLog(taskId, 'info',
        `Engine 开始执行: type=${taskType}, 员工数=${assignments.length}, 单号数=${totalCount}, handlerTimeout=${handlerTimeoutMs / 1000}s`,
        'Engine',
      );
      pgLogBuffer.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId, timestamp: Date.now(), level: 'info',
        message: `Engine 开始执行: type=${taskType}, 员工数=${assignments.length}, 单号数=${totalCount}, handlerTimeout=${handlerTimeoutMs / 1000}s`,
        source: 'Engine',
      });

      // Phase G-2: 空闲超时保护
      const absoluteTimeout = getAbsoluteTimeout(taskType);
      let lastActivityTime = Date.now();
      let idleTimerId: ReturnType<typeof setInterval> | null = null;
      let hasFirstProgress = false;

      const heartbeat = () => {
        hasFirstProgress = true;
        lastActivityTime = Date.now();
      };

      // 包装 onProgress：每次进度回调 = 心跳
      const wrappedOnProgress: ProgressFn = (done, newResults) => {
        heartbeat();
        onProgress(done, newResults);
      };

      // ── init_window 专用路径：单窗口初始化，不走 Assignment 并发循环 ──
      if (taskType === 'init_window') {
        const windowId = assignments[0]?.windowId || assignments[0]?.waybillNos[0];
        if (!windowId) {
          throw new Error('init_window 任务缺少 windowId');
        }

        taskLogManager.addLog(taskId, 'info', `窗口初始化开始: windowId=${windowId}`, 'Engine');

        let lease: WindowLeaseHandle | null = null;
        let timeoutHandle: { promise: Promise<never>; clear: () => void } | null = null;
        try {
          // Phase 9.3: 使用 Lease Adapter 原子获取窗口锁+标记忙碌（防止与普通任务串窗）
          lease = await pool.acquireWindowLease({
            windowId,
            taskId,
            staffName: windowId,
            taskType: 'init_window',
          });

          // 带超时 + 取消的初始化执行
          timeoutHandle = createTimeoutPromise(handlerTimeoutMs, `init_window/${windowId}`);
          await Promise.race([
            handler.executeWorker(
              {
                staffName: windowId || '',
                windowId: windowId || '',
                page: null as any, // init_window handler 自行获取 page
                log: ((level: 'info' | 'warning' | 'error', msg: string) => {
                  taskLogManager.addLog(taskId, level, msg, 'InitWindow');
                  pgLogBuffer.push({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    taskId, timestamp: Date.now(), level, message: msg, source: 'InitWindow',
                  });
                }) as any,
              },
              assignments[0],
              { ...taskContext, taskType },
              wrappedOnProgress,
            ),
            timeoutHandle.promise,
            createAbortPromise(abortController.signal),
          ]);
        } catch (raceErr) {
          if (isAbortError(raceErr)) {
            const currentTask = db.getTask(taskId);
            if (currentTask && currentTask.status === 'cancelled') {
              // Phase 8.2: 补齐 TASK_FINISHED + flushPgLogs（finally 已释放 lease）
              // Phase 2-C: await emitTaskFinished（PG 日志写入）
              await this.emitTaskFinished(taskId, 'failed', 0, 0, pgLogBuffer);
              return;
            }
          }
          // 非取消异常：抛出到外层 catch 统一处理（finally 已释放 lease）
          throw raceErr;
        } finally {
          if (timeoutHandle) timeoutHandle.clear();
          if (lease) lease.release();
        }

        // Phase 2-C-1: await finalizeTask（PG 终态写入），失败时 try/catch 确保错误可见
        if (!abortController.signal.aborted) {
          try {
            await this.finalizeTask(
              taskId,
              'done',
              1,
              0,
              pgLogBuffer,
              `窗口初始化完成: windowId=${windowId}`,
              'info',
              'init_window 终态更新失败',
            );
          } catch (finalizeErr) {
            console.error(`[Engine] CRITICAL: init_window 终态 PG 写入失败，任务 ${taskId} 状态可能不一致:`, (finalizeErr as Error).message);
            throw finalizeErr;
          }
        } else {
          // 边缘情况：abort在handler完成后触发（cancelTask与handler完成竞态）
          // Phase 8.2: 补齐 TASK_FINISHED（事件 status 映射为 failed，DB 保持 cancelled）
          // Phase 2-C: await PG 终态写入（不再 fire-and-forget）
          const finalStatus = db.getTask(taskId)?.status === 'cancelled' ? 'cancelled' : 'failed';
          const nowIso = new Date().toISOString();
          // LEGACY MIRROR: db.updateTask（best-effort）
          try {
            db.updateTask(taskId, { status: finalStatus, done_count: 1, fail_count: 0, finished_at: nowIso });
          } catch (e) {
            console.warn(`[Engine][DB] init_window 终态 legacy mirror failed (task=${taskId}):`, (e as Error).message);
          }
          try {
            await pgDb.updateTaskStatus(taskId, {
              status: finalStatus,
              doneCount: 1,
              failCount: 0,
              finishedAt: nowIso,
            });
          } catch (err) {
            const errMsg = `[Engine][PG] init_window 终态更新失败 (task=${taskId}): ${(err as Error).message}`;
            console.error(errMsg);
            throw new Error(errMsg);
          }
          await this.emitTaskFinished(taskId, 'failed', 1, 0, pgLogBuffer);
        }

        return;
      }

      // Phase G-3: 所有 Assignment 并发执行，每个带独立硬超时 + AbortSignal
      const taskPromise = Promise.all(assignments.map(async (assignment) => {
        await this.executeAssignment(
          assignment,
          taskContext,
          handler,
          pool,
          wrappedOnProgress,
          handlerTimeoutMs,
          abortController.signal,
          pgLogBuffer,
          flushPgLogs,
        );
      }));

      // Phase G-2: 空闲超时 Promise（每 5 秒检查一次）
      const idlePromise = new Promise<never>((_, reject) => {
        idleTimerId = setInterval(() => {
          const elapsed = Date.now() - lastActivityTime;
          if (!hasFirstProgress && elapsed > FIRST_PROGRESS_GRACE_MS) {
            clearInterval(idleTimerId!);
            // Phase G-3: 先 abort 终止所有 Handler（触发锁释放），再 reject
            abortController.abort();
            reject(new Error('任务启动超时：120 秒内无首次进度'));
            return;
          }
          if (hasFirstProgress && elapsed > IDLE_TIMEOUT_MS) {
            clearInterval(idleTimerId!);
            // Phase G-3: 先 abort 终止所有 Handler（触发锁释放），再 reject
            abortController.abort();
            reject(new Error('任务卡死：连续 90 秒无进展'));
          }
        }, CHECK_INTERVAL_MS);
      });

      // Phase G-2: 绝对上限 Promise（兜底）— 定时器可清理防止泄漏
      let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
      const absolutePromise = new Promise<never>((_, reject) => {
        absoluteTimer = setTimeout(() => {
          abortController.abort();
          reject(new Error('任务已到达绝对上限'));
        }, absoluteTimeout);
      });

      // Phase G-3: Promise.race 竞速
      // 可能的结局：
      //   - taskPromise resolve → 所有 Assignment 正常完成 → 成功路径
      //   - idlePromise reject  → 空闲超时 → catch 处理
      //   - absolutePromise reject → 绝对上限 → catch 处理
      //   - 外部 cancelTask() 调用 abort() → 所有 Assignment 收到 AbortError
      //     → taskPromise resolve（executeAssignment 捕获 AbortError 后静默返回）
      //     → 但 signal.aborted === true，跳转到取消处理
      try {
        await Promise.race([taskPromise, idlePromise, absolutePromise]);
      } catch (raceErr) {
        // 检查是否已被外部 cancelTask() 取消
        const currentTask = db.getTask(taskId);
        if (currentTask && currentTask.status === 'cancelled') {
          // Phase 8.2: 等待写入完成 + 补齐 TASK_FINISHED + flushPgLogs
          try { await writeChain; } catch { /* 忽略 */ }
          // Phase 2-C: await emitTaskFinished（PG 日志写入）
          await this.emitTaskFinished(taskId, 'failed', totalDone - totalFail, totalFail, pgLogBuffer);
          return;
        }

        // 空闲超时 / 绝对上限 触发的 abort
        if (abortController.signal.aborted) {
          // 超时触发的 abort：此时锁已由 executeAssignment.finally 释放
          const currentTask2 = db.getTask(taskId);
          if (currentTask2 && currentTask2.status === 'cancelled') {
            // Phase 8.2: cancelTask() 先一步设置了 cancelled，补齐 TASK_FINISHED + flushPgLogs
            try { await writeChain; } catch { /* 忽略 */ }
            await this.emitTaskFinished(taskId, 'failed', totalDone - totalFail, totalFail, pgLogBuffer);
            return;
          }
          // 标记为 failed（超时导致）
          throw raceErr;
        }

        // 其他异常
        throw raceErr;
      } finally {
        if (idleTimerId) clearInterval(idleTimerId);
        if (absoluteTimer) clearTimeout(absoluteTimer);
      }

      // Phase I: 等待所有批次写入完成后再结束任务
      // Phase 2-C: writeChain 包含 PG 批次结果写入，await 确保全部完成
      await writeChain;

      // 成功路径：只有在 taskPromise resolve 且未被 abort 时到达
      // Phase G-3: 二次确认 — 如果在这期间被取消了，不执行成功逻辑
      if (abortController.signal.aborted) {
        const currentTask = db.getTask(taskId);
        if (currentTask && currentTask.status === 'cancelled') {
          // Phase 8.2: 被 cancelTask 取消，补齐 TASK_FINISHED + flushPgLogs
          await this.emitTaskFinished(taskId, 'failed', totalDone - totalFail, totalFail, pgLogBuffer);
          return;
        }
        // 超时触发的 abort 但 taskPromise 先 resolve 了（极边缘情况）
        throw new Error('任务被超时机制终止');
      }

      // Phase I: 汇总 + 更新任务状态（仅写计数器/状态，不写 result_data）
      const finalSuccessCount = totalDone - totalFail;

      // Phase G-3: 如果所有结果都是失败（硬超时/全部抛错），标记为 failed 而非 done
      const allFailed = totalDone > 0 && totalFail === totalDone;
      // Phase 2-C: PG 批次结果写入失败时，任务不能标记 done，强制 failed
      const pgErr: Error | null = pgWriteState.error;
      const finalStatus = (allFailed || pgErr) ? 'failed' : 'done';
      const finalMsg = pgErr
        ? `Engine 任务完成但 PG 写入失败，强制标记 failed: ${pgErr.message}`
        : `Engine 任务完成: 状态=${finalStatus}, 成功=${finalSuccessCount}, 失败=${totalFail}`;

      // Phase 2-C-1: await finalizeTask（PG 终态写入），失败时 try/catch 确保错误可见
      try {
        await this.finalizeTask(
          taskId,
          finalStatus,
          totalDone,
          totalFail,
          pgLogBuffer,
          finalMsg,
          pgErr ? 'error' : 'info',
          '任务终态更新失败',
        );
      } catch (finalizeErr) {
        // finalizeTask throw 意味着 PG 终态写入失败，任务状态可能不一致
        console.error(`[Engine] CRITICAL: 终态 PG 写入失败，任务 ${taskId} 状态可能不一致:`, (finalizeErr as Error).message);
        throw finalizeErr;
      }
    } catch (err) {
      // Phase I: 等待所有批次写入完成（即使失败也要保证已写入的数据持久化）
      try { await writeChain; } catch { /* 忽略 */ }

      // Phase G-3: 不覆盖 cancelled 状态
      const currentTask = db.getTask(taskId);
      if (currentTask && currentTask.status === 'cancelled') {
        // Phase 8.2: cancelTask() 已设置 cancelled，补齐 TASK_FINISHED + flushPgLogs
        await this.emitTaskFinished(taskId, 'failed', totalDone - totalFail, totalFail, pgLogBuffer);
        return;
      }

      const isLockError = err instanceof WindowBusyError;
      const errMsg = (err as Error).message;
      const isTimeout = errMsg.includes('卡死') || errMsg.includes('无进展')
        || errMsg.includes('绝对上限') || errMsg.includes('启动超时')
        || errMsg.includes('Handler 执行超时');
      const failureMsg = `Engine 任务失败: ${isTimeout ? '任务超时终止' : (isLockError ? '窗口被占用' : errMsg)}`;

      // Phase 2-C-1: await finalizeTask（PG 终态写入），catch 块中 wrap 防止二次抛错无处理
      try {
        await this.finalizeTask(
          taskId,
          'failed',
          totalDone,
          totalFail,
          pgLogBuffer,
          failureMsg,
          'error',
          '任务失败终态更新失败',
          err as Error,
        );
      } catch (finalizeErr) {
        console.error(`[Engine] CRITICAL: 终态 PG 写入失败，任务 ${taskId} 状态可能不一致:`, (finalizeErr as Error).message);
        throw finalizeErr;
      }
    } finally {
      // Phase G-3: 【内存泄漏防护】任务彻底结束后，从 Map 中移除
      this.cancelControllers.delete(taskId);
      // Phase 5-G-4: 清理 PG 日志定期冲刷定时器
      clearInterval(pgFlushTimer);
    }
  }

  /**
   * 执行单个 Assignment：获取连接 → 加锁 → 调用 handler（带硬超时+取消）→ 释放锁
   *
   * Phase G-3 改造：
   *   - handler.executeWorker() 包装在 Promise.race 中，包含：
   *     1. 硬超时（handlerTimeoutMs，默认 30 分钟）
   *     2. AbortSignal（外部取消 / 空闲超时 / 绝对上限触发）
   *   - AbortError 被捕获后静默返回（不创建 failResults，因为任务已取消）
   *   - 锁在 finally 中强制释放（无论何种终止方式）
   *
   * Assignment 级失败（锁/连接/业务异常）不抛出到 Engine 顶层，
   * 而是生成 failResults 并通过 onProgress 上报，保证其他 Assignment 不受影响。
   */
  private async executeAssignment(
    assignment: Assignment,
    taskContext: TaskContext,
    handler: TaskHandler,
    pool: BrowserPool,
    onProgress: ProgressFn,
    timeoutMs: number,
    signal: AbortSignal,
    pgLogBuffer: TaskLogEntry[],
    flushPgLogs: () => Promise<void>,
  ): Promise<void> {
    const { taskId } = taskContext;
    const { staffName } = assignment;
    const t0 = Date.now();

    // Phase 5-G-6: 辅助函数 — 向 pgLogBuffer 写入员工级日志（staffLog 尚未创建时使用）
    const pushStaffLog = (msg: string, level: 'info' | 'warning' | 'error' = 'info', windowId?: string) => {
      pgLogBuffer.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId, timestamp: Date.now(), level,
        message: msg,
        source: taskContext.taskType,
        staffName,
        ...(windowId ? { windowId } : {}),
      });
    };

    try {
      // Phase 5-G-6: 记录 assignment 接收 + 运单数
      pushStaffLog(`assignment received: waybillNos=${assignment.waybillNos.length}条, mode=${assignment.executionMode || 'default'}`);

      // Phase 5-G-5: 连接前先写日志并立即 flush，前端可见"正在连接员工窗口..."
      pushStaffLog(`开始获取窗口连接...`);
      await flushPgLogs();

      const connStart = Date.now();
      // ★ Phase 2-D: 统一通过 resolveWorkerConnection 获取窗口连接
      const conn = await this.resolveWorkerConnection({
        staffName,
        site: taskContext.site,
        taskId,
        taskType: taskContext.taskType,
        pool,
      });
      const connElapsed = Date.now() - connStart;

      // 2. 创建 staffLog（带 staffName+windowId 上下文）
      const staffLog: LogFn = (level, msg, context) => {
        taskLogManager.addLog(taskId, level, msg, `${taskContext.taskType}`,
          { staffName, windowId: conn.windowId, ...context },
        );
        pgLogBuffer.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          taskId,
          timestamp: Date.now(),
          level,
          message: msg,
          source: taskContext.taskType,
          staffName: staffName,
          windowId: conn.windowId,
        });
        const consoleMethod = level === 'warning' ? 'warn' : level;
        console[consoleMethod](`[${taskContext.taskType}][${staffName}] ${msg}`);
      };

      // Phase 5-G-6: 记录窗口连接耗时
      staffLog('info',
        `窗口连接已就绪，耗时 ${connElapsed}ms: runtimeMode=${conn.runtimeMode} windowId=${conn.windowId}` +
        (conn.runtimeKey ? ` runtimeKey=${conn.runtimeKey}` : ''),
      );

      // Phase 5-G-4: 连接阶段完成后立即冲刷日志到 PG，确保前端实时可见
      await flushPgLogs();

      // Phase 2-B: 指定模式日志摘要
      if (assignment.executionMode === 'designated') {
        const courierName = assignment.targetCourierName || assignment.staffName;
        const courierAccount = assignment.targetCourierAccount || '-';
        let designatedLog = `[指定模式] 执行窗口：${assignment.staffName} → 目标派件员：${courierName} / ${courierAccount}`;
        if (assignment.signerPerson) {
          designatedLog += `，签收人：${assignment.signerPerson}`;
        }
        staffLog('info', designatedLog);
      }

      // Phase 5-G-6: assignment 级超时定时器（90s，捕获 handler 内部卡死）
      let assignmentTimeoutId: ReturnType<typeof setTimeout> | null = null;
      const ASSIGNMENT_TIMEOUT_MS = 90_000;
      const assignmentTimeout = new Promise<never>((_, reject) => {
        assignmentTimeoutId = setTimeout(() => {
          reject(new Error(`执行超时：员工 ${staffName} 任务超过 ${ASSIGNMENT_TIMEOUT_MS / 1000}s 未完成`));
        }, ASSIGNMENT_TIMEOUT_MS);
      });

      // 3. busy 续租定时器 + handler 执行
      let busyRenewalTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutHandle: { promise: Promise<never>; clear: () => void } | null = null;
      try {
        busyRenewalTimer = setInterval(() => {
          const renewResult = conn.renew?.();
          if (renewResult instanceof Promise) {
            renewResult.catch(e =>
              staffLog('warning', `Lease renew 失败: ${(e as Error).message}`),
            );
          }
        }, 60_000);

        const workerCtx = {
          staffName,
          windowId: conn.windowId,
          page: conn.page,
          log: staffLog,
          runtimeKey: conn.runtimeKey,
          runtimeMode: conn.runtimeMode,
        };

        // Phase 5-G-5: 执行前先写日志并 flush
        staffLog('info', `开始执行业务操作...`);
        await flushPgLogs();

        const execStart = Date.now();

        // Phase G-3: Promise.race 竞速
        // Phase 5-G-6: 加入 assignment 级超时（90s）
        timeoutHandle = createTimeoutPromise(timeoutMs, `${taskContext.taskType}/${staffName}`);
        await Promise.race([
          handler.executeWorker(workerCtx, assignment, taskContext, onProgress),
          timeoutHandle.promise,
          createAbortPromise(signal),
          assignmentTimeout,
        ]);

        const execElapsed = Date.now() - execStart;

        // Phase 5-G-6: handler 正常完成后写最终成功日志
        staffLog('info', `执行业务操作完成，耗时 ${execElapsed}ms`);
        await flushPgLogs();
      } catch (raceErr) {
        // Phase G-3: AbortError → 任务被取消，静默返回
        if (isAbortError(raceErr)) {
          staffLog('warning', `[CANCELLED] 任务已取消, worker=${staffName}`);
          await flushPgLogs();
          return;
        }
        if (raceErr instanceof WindowBusyError) {
          staffLog('error', `[LOCK] window busy windowId=${conn.windowId} task=${taskId}`);
          await flushPgLogs();
        }
        // Phase 5-G-6: assignment 超时 → 写员工级失败日志
        const errMsg = (raceErr as Error).message;
        if (errMsg.includes('执行超时') || errMsg.includes('未完成')) {
          staffLog('error', `${errMsg}`);
          await flushPgLogs();
          // 为该员工所有运单生成失败结果
          const timeoutResults: OperationResult[] = assignment.waybillNos.map(no => ({
            waybillNo: no,
            staffName,
            success: false,
            message: errMsg,
            timestamp: Date.now(),
            status: 'FAILED' as const,
          }));
          onProgress(timeoutResults.length, timeoutResults);
          return; // 不向外抛出，避免影响其他 Assignment
        }
        throw raceErr;
      } finally {
        if (assignmentTimeoutId) clearTimeout(assignmentTimeoutId);
        if (busyRenewalTimer) clearInterval(busyRenewalTimer);
        if (timeoutHandle) timeoutHandle.clear();
        // Phase 5-G-8-4: 任务结束后恢复干净首页（在释放窗口锁之前）
        try {
          await BusinessPageNavigator.getInstance().restoreCleanHome(conn.page, {
            staffName,
            log: (level, msg) => staffLog(level, msg),
          });
        } catch (restoreErr) {
          staffLog('warning', `任务结束恢复首页异常: ${(restoreErr as Error).message}`);
        }
        try {
          await conn.release();
        } catch (releaseErr) {
          staffLog('warning', `连接释放失败: ${(releaseErr as Error).message}`);
        }
      }

      // Phase 5-G-6: 最终耗时日志
      const totalElapsed = Date.now() - t0;
      staffLog('info', `assignment 完成，总耗时 ${totalElapsed}ms`);
      await flushPgLogs();
    } catch (err) {
      // Phase G-3: 再检查一次 — 如果信号已 abort，不创建 failResults
      if (signal.aborted) {
        return;
      }

      const totalElapsed = Date.now() - t0;
      const isLockError = err instanceof WindowBusyError;
      const failResults: OperationResult[] = assignment.waybillNos.map(no => ({
        waybillNo: no,
        staffName,
        success: false,
        message: isLockError
          ? `窗口被其他任务占用: ${(err as Error).message}`
          : `员工窗口不可用: ${(err as Error).message}`,
        timestamp: Date.now(),
        status: 'FAILED',
      }));
      onProgress(failResults.length, failResults);
      // Phase 5-G-6: 写员工级失败日志（含耗时和失败原因）
      pushStaffLog(
        `assignment 失败，耗时 ${totalElapsed}ms: ${isLockError ? '窗口被占用' : '执行失败'} — ${(err as Error).message}`,
        'error',
      );
      await flushPgLogs();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Phase 2-D: Worker 连接获取（统一入口 + legacy/playwright 双路径）
  // ════════════════════════════════════════════════════════════════

  /**
   * Phase 2-D: 统一 Worker 连接获取入口
   *
   * 根据 taskType + WINDOW_RUNTIME_MODE 分发到 legacy 或 playwright 路径。
   *
   * 接入范围（Phase 2-D）：
   *   - playwright 模式 + taskType='sign' → 走 PlaywrightWindowAdapter
   *   - 其他所有情况 → 走 legacy BrowserPool（保持原逻辑）
   *
   * 返回统一的 WorkerConnectionHandle，executeAssignment 后续逻辑无感知 runtime mode。
   */
  private async resolveWorkerConnection(args: {
    staffName: string;
    site: Site;
    taskId: string;
    taskType: string;
    pool: BrowserPool;
  }): Promise<WorkerConnectionHandle> {
    const { staffName, site, taskId, taskType, pool } = args;
    const usePlaywright = shouldUsePlaywrightAdapter(taskType);

    if (usePlaywright) {
      console.log(`[Engine] resolveWorkerConnection: playwright path, staffName=${staffName}, taskType=${taskType}`);
      return await this.resolvePlaywrightWorkerConnection({ staffName, site, taskId, taskType });
    }

    console.log(`[Engine] resolveWorkerConnection: legacy path, staffName=${staffName}, taskType=${taskType}`);
    return await this.resolveLegacyWorkerConnection({ staffName, site, taskId, taskType, pool });
  }

  /**
   * Phase 2-D: legacy 路径 — 保持原 BrowserPool 逻辑
   *
   * 流程（与原 executeAssignment 完全一致）：
   *   1. pool.getStaffConnection(staffName, site)
   *   2. pool.acquireWindowLease({ windowId, taskId, ... })  ← 原子取锁 + 标记 busy
   *   3. pool.ensureWindowReady(windowId)                     ← P0 前置检查（锁内）
   *
   * 释放（release）：
   *   lease.release()  ← 原子释放 L1(lock) + L2(busy) + L3(lease)
   *
   * 续租（renew）：
   *   lease.renew()
   */
  private async resolveLegacyWorkerConnection(args: {
    staffName: string;
    site: Site;
    taskId: string;
    taskType: string;
    pool: BrowserPool;
  }): Promise<WorkerConnectionHandle> {
    const { staffName, site, taskId, taskType, pool } = args;

    // 1. 获取 Worker Connection（带站点隔离，不做 P0 清理，避免锁前 DOM 操作竞态）
    const conn = await pool.getStaffConnection(staffName, site);

    // 2. 获取窗口 Lease（Phase 9.2: 通过 BrowserPool Adapter 统一获取 lock+busy）
    const lease = await pool.acquireWindowLease({
      windowId: conn.windowId,
      taskId,
      staffName,
      taskType,
    });

    // 3. 锁获取成功后执行 P0 前置检查（避免锁前并发 DOM 操作）
    try {
      await pool.ensureWindowReady(conn.windowId);
    } catch (p0Err) {
      console.warn(`[Engine][legacy] P0 前置检查失败，继续执行: ${(p0Err as Error).message}`);
    }

    return {
      page: conn.page,
      windowId: conn.windowId,
      runtimeMode: 'playwright',
      release: async () => {
        try {
          lease.release();
        } catch (e) {
          console.warn(`[Engine][legacy] lease.release 失败: ${(e as Error).message}`);
        }
      },
      renew: async () => {
        try {
          lease.renew();
        } catch (e) {
          console.warn(`[Engine][legacy] lease.renew 失败: ${(e as Error).message}`);
        }
      },
    };
  }

  /**
   * Phase 2-D: playwright 路径 — 走 PlaywrightWindowAdapter + WindowLockManager
   *
   * 流程：
   *   1. adapter.ensureWindowReady(options)
   *      - login_required → 抛错（任务失败，不进入 Handler，不 markBusy）
   *      - busy → 抛 WindowBusyError（不抢占）
   *      - ready → 继续
   *   2. lockManager.acquire(windowId, taskId)
   *      - 失败 → 抛 WindowBusyError（不 markBusy）
   *   3. adapter.markBusy(runtimeKey)
   *      - 失败 → release lock，抛错
   *   4. adapter.getWorkerPage(options)
   *      - 失败 → markReady + release lock，抛错
   *   5. 返回 WorkerConnectionHandle
   *
   * 释放（release，finally 中调用）：
   *   1. adapter.markReady(runtimeKey)              ← 先恢复窗口状态
   *   2. lockManager.release(windowId, taskId)      ← 再释放锁
   *   markReady 失败仅记录日志，不阻断 release lock
   *
   * 续租（renew）：
   *   adapter.markBusy(runtimeKey)  ← 幂等重置 busy 时间戳
   *
   * windowId 映射规则：
   *   playwright 模式下使用 `staff-${staffName}` 作为 windowId
   *   userDataDir: runtime/profiles/{tenantId}/{siteId}/staff-{staffName}/
   */
  private async resolvePlaywrightWorkerConnection(args: {
    staffName: string;
    site: Site;
    taskId: string;
    taskType: string;
  }): Promise<WorkerConnectionHandle> {
    const { staffName, site, taskId, taskType } = args;

    // windowId 映射：使用 staff- 前缀避免与 legacy windowId 冲突
    const windowId = `staff-${staffName}`;
    const tenantId = DEFAULT_TENANT_ID;
    const siteId = String(site);
    const options: WindowAdapterOptions = {
      tenantId,
      siteId,
      windowId,
      staffName,
    };
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);

    const adapter = WindowAdapterRegistry.getInstance().getAdapter();
    const lockManager = WindowLockManager.getInstance();

    // 1. ensureWindowReady
    const readyResult = await adapter.ensureWindowReady(options);
    console.log(
      `[Engine][playwright] ensureWindowReady runtimeKey=${readyResult.runtimeKey}` +
      ` status=${readyResult.status} launched=${readyResult.launched}` +
      ` isLoggedIn=${readyResult.isLoggedIn ?? 'N/A'}`,
    );

    if (readyResult.status === 'login_required') {
      throw new Error(`窗口未登录，无法执行任务: runtimeKey=${runtimeKey}`);
    }
    if (readyResult.status === 'busy') {
      throw new WindowBusyError(windowId, 'unknown');
    }
    if (readyResult.status !== 'ready') {
      throw new Error(`窗口状态不可用: status=${readyResult.status} runtimeKey=${runtimeKey} message=${readyResult.message ?? ''}`);
    }

    // 2. lockManager.acquire
    await lockManager.acquire(windowId, taskId);
    let lockAcquired = true;

    // 3. adapter.markBusy
    let busyMarked = false;
    try {
      const markResult = await adapter.markBusy(runtimeKey);
      console.log(
        `[Engine][playwright] markBusy runtimeKey=${runtimeKey}` +
        ` success=${markResult.success} status=${markResult.status}`,
      );
      if (!markResult.success) {
        lockManager.release(windowId, taskId);
        lockAcquired = false;
        throw new Error(`markBusy 失败: ${markResult.message ?? 'unknown'} runtimeKey=${runtimeKey}`);
      }
      busyMarked = true;
    } catch (e) {
      if (lockAcquired) {
        lockManager.release(windowId, taskId);
        lockAcquired = false;
      }
      throw e;
    }

    // 4. adapter.getWorkerPage
    let page: Page;
    try {
      const pageResult = await adapter.getWorkerPage(options);
      console.log(
        `[Engine][playwright] getWorkerPage runtimeKey=${runtimeKey}` +
        ` status=${pageResult.status} hasPage=${!!pageResult.page}`,
      );
      if (!pageResult.page) {
        // 回滚：markReady + release lock
        if (busyMarked) {
          await adapter.markReady(runtimeKey).catch(err =>
            console.warn(`[Engine][playwright] getWorkerPage 回滚 markReady 失败: ${(err as Error).message}`),
          );
        }
        if (lockAcquired) {
          lockManager.release(windowId, taskId);
          lockAcquired = false;
        }
        throw new Error(`获取 page 失败: ${pageResult.message ?? 'unknown'} runtimeKey=${runtimeKey}`);
      }
      page = pageResult.page;
    } catch (e) {
      if (busyMarked) {
        await adapter.markReady(runtimeKey).catch(() => {});
      }
      if (lockAcquired) {
        lockManager.release(windowId, taskId);
      }
      throw e;
    }

    // 5. 返回 Handle
    return {
      page,
      windowId,
      runtimeKey,
      runtimeMode: 'playwright',
      release: async () => {
        // ★ 先 markReady，后 release lock
        // markReady 失败仅记录日志，不阻断 release lock
        try {
          const readyResult = await adapter.markReady(runtimeKey);
          if (!readyResult.success) {
            console.warn(
              `[Engine][playwright] markReady 失败（不阻断 release lock）:` +
              ` runtimeKey=${runtimeKey} message=${readyResult.message ?? 'unknown'}`,
            );
          } else {
            console.log(
              `[Engine][playwright] markReady 成功: runtimeKey=${runtimeKey} status=${readyResult.status}`,
            );
          }
        } catch (e) {
          console.warn(
            `[Engine][playwright] markReady 异常（不阻断 release lock）:` +
            ` runtimeKey=${runtimeKey} error=${(e as Error).message}`,
          );
        }
        try {
          lockManager.release(windowId, taskId);
          console.log(`[Engine][playwright] lockManager.release: windowId=${windowId} taskId=${taskId}`);
        } catch (e) {
          console.warn(
            `[Engine][playwright] lockManager.release 异常: windowId=${windowId} error=${(e as Error).message}`,
          );
        }
      },
      renew: async () => {
        // playwright 模式续租：幂等 markBusy 重置 busy 时间戳
        try {
          await adapter.markBusy(runtimeKey);
        } catch (e) {
          console.warn(
            `[Engine][playwright] renew markBusy 异常: runtimeKey=${runtimeKey} error=${(e as Error).message}`,
          );
        }
      },
    };
  }

  /**
   * Phase 8.1: 统一终态写入（DB + PG + 日志 + flush + Metrics + TASK_FINISHED）
   *
   * 收敛原来散落在成功路径(L589)、失败路径(L641)、init_window(L463)的重复代码。
   * fullSideEffects=false 时仅执行核心终态写入(DB+PG+log+flush)，
   * 不推送完成事件、不更新Metrics、不向PG日志缓冲push完成消息（用于init_window保持行为一致）。
   *
   * Phase 2-C: 改为 async，PG 终态写入必须 await（不再 fire-and-forget）。
   * Phase 2-C-1: PG 终态写入失败必须 throw，不允许静默成功。
   *   - updateTaskStatus: CRITICAL — 失败 throw，任务终态是主数据源
   *   - insertTaskLogs: CRITICAL — 失败 throw，最终日志是审计依据
   */
  private async finalizeTask(
    taskId: string,
    status: 'done' | 'failed',
    doneCount: number,
    failCount: number,
    pgLogBuffer: TaskLogEntry[],
    logMessage: string,
    logLevel: 'info' | 'error',
    pgErrorContext: string,
    err?: Error,
    fullSideEffects: boolean = true,
  ): Promise<void> {
    const db = Database.getInstance();
    const pgDb = PgDatabase.getInstance();
    const now = new Date().toISOString();
    const successCount = doneCount - failCount;

    // LEGACY MIRROR: db.updateTask（best-effort）
    try {
      db.updateTask(taskId, {
        status,
        done_count: doneCount,
        fail_count: failCount,
        finished_at: now,
      });
    } catch (e) {
      console.warn(`[Engine][DB] finalizeTask legacy mirror failed (task=${taskId}):`, (e as Error).message);
    }

    taskLogManager.addLog(taskId, logLevel, logMessage, 'Engine');

    if (fullSideEffects) {
      if (logLevel === 'error' && err) {
        console.error(`[Engine] 任务 ${taskId} 执行失败:`, err);
      }

      pgLogBuffer.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        timestamp: Date.now(),
        level: logLevel,
        message: logMessage,
        source: 'Engine',
      });
    }

    // Phase 2-C-1: PG 主写 — CRITICAL await updateTaskStatus（失败 throw，不允许静默成功）
    try {
      await pgDb.updateTaskStatus(taskId, {
        status,
        doneCount,
        failCount,
        finishedAt: now,
      });
    } catch (pgErr) {
      const errMsg = `[Engine][PG] ${pgErrorContext} (task=${taskId}): ${(pgErr as Error).message}`;
      console.error(errMsg);
      throw new Error(errMsg);
    }

    // Phase 2-C-1: PG 主写 — CRITICAL await insertTaskLogs（失败 throw，最终日志是审计依据）
    if (pgLogBuffer.length > 0) {
      const batch = pgLogBuffer.splice(0);
      try {
        await this.insertTaskLogsAndEmit(pgDb, batch);
      } catch (pgErr) {
        const errMsg = `[Engine][PG] 日志批量写入失败 (task=${taskId}): ${(pgErr as Error).message}`;
        console.error(errMsg);
        throw new Error(errMsg);
      }
    }

    if (fullSideEffects) {
      if (logLevel === 'info') {
        RuntimeMetrics.getInstance().taskSucceeded(successCount);
        RuntimeMetrics.getInstance().taskFailed(failCount);
      }

      taskEventBus.emit({
        type: 'TASK_FINISHED',
        taskId,
        status,
        successCount: Math.max(0, successCount),
        failedCount: failCount,
        finishedAt: Date.now(),
      });
    }
  }

  /**
   * Phase 8.2: 轻量终态收尾 — 仅 flush PG 日志 + 发送 TASK_FINISHED
   *
   * 用于 cancelled return 路径：cancelTask() 已经写入 DB/PG 的 cancelled 状态，
   * 本方法不覆盖 DB/PG，仅补齐缺失的 TASK_FINISHED 事件和 PG 日志冲刷，
   * 确保 SSE 连接正常关闭、生命周期完整。
   *
   * Phase 2-C: 改为 async，await PG 日志写入完成（不再 fire-and-forget）。
   * Phase 2-C-1: 日志写入失败进入 FATAL 记录（不 throw，避免在 cancel 路径中二次抛错）。
   */
  private async emitTaskFinished(
    taskId: string,
    status: 'done' | 'failed',
    successCount: number,
    failedCount: number,
    pgLogBuffer: TaskLogEntry[],
  ): Promise<void> {
    const pgDb = PgDatabase.getInstance();

    if (pgLogBuffer.length > 0) {
      const batch = pgLogBuffer.splice(0);
      try {
        await this.insertTaskLogsAndEmit(pgDb, batch);
      } catch (err) {
        console.error(`[Engine][PG] FATAL: 日志批量写入失败 (task=${taskId}):`, (err as Error).message);
      }
    }

    taskEventBus.emit({
      type: 'TASK_FINISHED',
      taskId,
      status,
      successCount: Math.max(0, successCount),
      failedCount,
      finishedAt: Date.now(),
    });
  }

  private async insertTaskLogsAndEmit(pgDb: PgDatabase, batch: TaskLogEntry[]): Promise<void> {
    if (batch.length === 0) return;
    await pgDb.insertTaskLogs(batch);
    for (const entry of batch) {
      taskEventBus.emit({
        type: 'TASK_LOG',
        taskId: entry.taskId,
        payload: entry,
      });
    }
  }

  /**
   * 方案B：自动选择第一个在线 Worker（供 Arrival 兼容模式使用）
   *
   * 数据源：统一从 BrowserPool.getOnlineWorkers() 查询（P0 就绪 + 非 busy），
   *  不再直接读取 DB 的 is_connected 字段（避免 DB/内存数据源不一致导致选中"幽灵窗口"）
   *
   * 返回：{ staffName, windowId } 或抛出错误（无可用 Worker）
   */
  static selectOnlineWorker(site: Site): { staffName: string; windowId: string; window: WindowInfo } {
    const pool = BrowserPool.getInstance();
    const onlineWorkers = pool.getOnlineWorkers(site);

    if (onlineWorkers.length === 0) {
      throw new Error(`站点 ${site} 没有可用的 Worker 窗口，请确认窗口已启动并 P0 就绪`);
    }
    const workerWin = onlineWorkers[0];
    return {
      staffName: workerWin.staff_name as string,
      windowId: workerWin.id,
      window: workerWin,
    };
  }

  /**
   * Phase G-1: 僵尸任务恢复
   *
   * 系统启动时调用，扫描所有 status='running' 的任务，
   * 自动修正为 status='failed'，避免任务永久停留 running 状态。
   *
   * 触发场景：Node 崩溃 / Windows 重启 / 停电 / 服务重启
   *
   * 兼容所有任务类型（Arrival/Dispatch/Integrated/Sign），禁止业务特判。
   *
   * Phase 2-C-1: 改为 async，优先写 PG（CRITICAL），JSON/SQLite 为 LEGACY MIRROR。
   *   调用方需确保 PG 已初始化后再调用本方法。
   *
   * @returns 恢复的任务数量
   */
  static async recoverRunningTasks(): Promise<number> {
    const db = Database.getInstance();
    const runningTasks = db.listTasksByStatus('running');

    if (runningTasks.length === 0) {
      console.log('[Engine] 启动恢复: 无僵尸任务');
      return 0;
    }

    console.log(`[Engine] 启动恢复: 发现 ${runningTasks.length} 个僵尸任务，开始修正`);

    // CRITICAL PG write: 优先写 PG（主数据源），JSON/SQLite 为 LEGACY MIRROR
    const pgDb = PgDatabase.getInstance();
    for (const task of runningTasks) {
      const now = new Date().toISOString();

      // LEGACY MIRROR: db.updateTask（best-effort）
      try {
        db.updateTask(task.id, {
          status: 'failed',
          finished_at: now,
        });
      } catch (e) {
        console.warn(`[Engine][DB] recoverRunningTasks legacy mirror failed (task=${task.id}):`, (e as Error).message);
      }

      taskLogManager.addLog(task.id, 'error',
        'Service restarted unexpectedly — 系统重启导致任务中断，已自动标记失败',
        'Engine',
      );

      // CRITICAL PG write: updateTaskStatus（失败 throw，不允许静默成功）
      try {
        await pgDb.updateTaskStatus(task.id, {
          status: 'failed',
          finishedAt: now,
        });
      } catch (pgErr) {
        const errMsg = `[Engine][PG] recoverRunningTasks 终态更新失败 (task=${task.id}): ${(pgErr as Error).message}`;
        console.error(errMsg);
        // 继续处理下一个任务，不因单个任务 PG 失败中断全部恢复
      }

      console.log(`[Engine]   ✓ 任务 ${task.id} (type=${task.type}) running → failed`);
    }

    console.log(`[Engine] 启动恢复完成: 共修正 ${runningTasks.length} 个僵尸任务`);
    return runningTasks.length;
  }
}
