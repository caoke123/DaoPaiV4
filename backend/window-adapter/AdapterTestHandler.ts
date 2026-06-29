/**
 * AdapterTestHandler — Phase 2-B 测试任务 Handler
 *
 * 这不是正式业务 Handler（不实现 TaskHandler 接口，不走 AssignmentEngine.execute）。
 * 它是一条独立的测试任务链路，用于验证：
 *   1. 任务可以通过 PlaywrightWindowAdapter 获取窗口状态
 *   2. 未登录时返回 login_required，并写入任务日志
 *   3. 登录后可以获取 page
 *   4. 任务开始时 markBusy
 *   5. 任务结束时 markReady
 *   6. markReady 后不关闭窗口
 *   7. 任务日志正常写入
 *   8. 任务中心可以看到测试任务
 *
 * 隔离约束：
 *   - 不 import EasyBRClient
 *   - 不调用 connectOverCDP
 *   - 不修改 ArrivalHandler / DispatchHandler / IntegratedHandler / SignHandler
 *   - 不走 AssignmentEngine 的正式调度链路
 */
import type { Page } from 'playwright';
import { WindowAdapterRegistry } from './WindowAdapterRegistry';
import type { WindowAdapterOptions, WindowReadyResult, MarkResult } from './types';
import { buildRuntimeKey } from '../playwright-runtime/types';
import { taskLogManager } from '../utils/TaskLogManager';
import { taskEventBus } from '../utils/TaskEventBus';
import { Database } from '../db/Database';

/** 测试任务执行结果 */
export interface AdapterTestResult {
  taskId: string;
  runtimeKey: string;
  success: boolean;
  /** 任务开始前的窗口状态 */
  statusBefore: string;
  /** 任务结束后的窗口状态 */
  statusAfter: string;
  currentUrl?: string;
  pageTitle?: string;
  markBusyResult?: MarkResult;
  markReadyResult?: MarkResult;
  message: string;
}

/** 测试任务执行选项 */
export interface AdapterTestExecuteOptions extends WindowAdapterOptions {
  taskId: string;
}

export class AdapterTestHandler {
  /**
   * 执行 adapter 测试任务
   *
   * 流程：
   *   1. ensureWindowReady → 获取窗口状态
   *   2. login_required → 写日志，标记任务 failed，不执行页面操作
   *   3. busy → 写日志，不抢占
   *   4. ready → getWorkerPage → markBusy → 最小页面验证 → markReady
   *   5. 任务结束，窗口保持打开
   *
   * markReady 时序保证：在 return 之前执行，确保返回值包含 markReady 结果。
   * 异常路径也尝试 markReady（除非 markBusy 未成功）。
   */
  async execute(options: AdapterTestExecuteOptions): Promise<AdapterTestResult> {
    const { taskId, tenantId, siteId, windowId } = options;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);
    const adapter = WindowAdapterRegistry.getInstance().getAdapter();
    const db = Database.getInstance();

    /** 写日志辅助函数（自动写入 taskLogManager，EventBus 已通过 setLogCallback 订阅） */
    const log = (level: 'info' | 'warning' | 'error', msg: string) => {
      taskLogManager.addLog(taskId, level, msg, 'AdapterTestHandler', {
        staffName: options.staffName,
        windowId,
      });
      console.log(`[AdapterTest/${runtimeKey}] ${level.toUpperCase()}: ${msg}`);
    };

    /** 标记任务终态 + 推送 TASK_FINISHED 事件 */
    const finalizeTask = (status: 'done' | 'failed', successCount: number, failedCount: number) => {
      db.updateTask(taskId, {
        status,
        done_count: successCount,
        fail_count: failedCount,
        finished_at: new Date().toISOString(),
      });
      taskEventBus.emit({
        type: 'TASK_FINISHED',
        taskId,
        status,
        successCount,
        failedCount,
        finishedAt: Date.now(),
      });
    };

    // ── 0. 标记任务 running ──
    db.updateTask(taskId, { status: 'running' });
    log('info', `Adapter 测试任务开始: runtimeKey=${runtimeKey}, staffName=${options.staffName || 'N/A'}`);

    let statusBefore = 'unknown';
    let markBusyResult: MarkResult | undefined;
    let markReadyResult: MarkResult | undefined;
    let currentUrl: string | undefined;
    let pageTitle: string | undefined;

    try {
      // ── 1. ensureWindowReady ──
      log('info', '步骤 1/5: 调用 adapter.ensureWindowReady...');
      const readyResult: WindowReadyResult = await adapter.ensureWindowReady(options);
      statusBefore = readyResult.status;
      log('info', `ensureWindowReady 结果: status=${readyResult.status}, launched=${readyResult.launched}, userDataDir=${readyResult.userDataDir}, isLoggedIn=${readyResult.isLoggedIn}`);

      // ── 2. login_required → 阻断，不执行页面操作 ──
      if (readyResult.status === 'login_required') {
        log('warning', '窗口需要登录，不执行页面操作。请手动登录后重试。');
        finalizeTask('failed', 0, 1);
        return {
          taskId, runtimeKey, success: false,
          statusBefore, statusAfter: 'login_required',
          message: '窗口需要登录，任务未执行页面操作',
        };
      }

      // ── 3. busy → 不抢占 ──
      if (readyResult.status === 'busy') {
        log('warning', '窗口当前为 busy 状态，被其他任务占用，不抢占。');
        finalizeTask('failed', 0, 1);
        return {
          taskId, runtimeKey, success: false,
          statusBefore, statusAfter: 'busy',
          message: '窗口忙，任务未执行（不抢占）',
        };
      }

      // ── 4. 非 ready 状态（opening/failed/closed）→ 阻断 ──
      if (readyResult.status !== 'ready') {
        log('error', `窗口状态为 ${readyResult.status}，无法执行测试任务。`);
        finalizeTask('failed', 0, 1);
        return {
          taskId, runtimeKey, success: false,
          statusBefore, statusAfter: readyResult.status,
          message: `窗口状态 ${readyResult.status}，任务未执行`,
        };
      }

      // ── 5. ready → 获取 page ──
      log('info', '步骤 2/5: 调用 adapter.getWorkerPage...');
      const pageResult = await adapter.getWorkerPage(options);
      const page: Page | undefined = pageResult.page;
      if (!page) {
        log('error', `无法获取 page: status=${pageResult.status}, message=${pageResult.message || 'N/A'}`);
        finalizeTask('failed', 0, 1);
        return {
          taskId, runtimeKey, success: false,
          statusBefore, statusAfter: readyResult.status,
          message: `无法获取 page: ${pageResult.message || pageResult.status}`,
        };
      }

      // ── 6. markBusy ──
      log('info', '步骤 3/5: 调用 adapter.markBusy...');
      markBusyResult = await adapter.markBusy(runtimeKey);
      log('info', `markBusy 结果: success=${markBusyResult.success}, status=${markBusyResult.status}`);

      if (!markBusyResult.success) {
        log('error', `markBusy 失败: ${markBusyResult.message || 'N/A'}`);
        finalizeTask('failed', 0, 1);
        return {
          taskId, runtimeKey, success: false,
          statusBefore, statusAfter: markBusyResult.status,
          markBusyResult,
          message: `markBusy 失败: ${markBusyResult.message}`,
        };
      }

      // ── 7. 最小页面验证（不做真实业务操作） ──
      log('info', '步骤 4/5: 执行最小页面验证（url + title）...');
      try {
        currentUrl = page.url();
        pageTitle = await page.title();
        log('info', `页面验证: url=${currentUrl}, title=${pageTitle}`);
      } catch (e) {
        log('warning', `页面验证部分失败（不影响任务完成）: ${(e as Error).message}`);
        currentUrl = '(获取失败)';
        pageTitle = '(获取失败)';
      }

      // ── 8. markReady（在 return 之前执行，确保返回值包含结果） ──
      log('info', '步骤 5/5: 调用 adapter.markReady（不关闭窗口）...');
      try {
        markReadyResult = await adapter.markReady(runtimeKey);
        log('info', `markReady 结果: success=${markReadyResult.success}, status=${markReadyResult.status}`);
      } catch (e) {
        log('warning', `markReady 异常（窗口可能已关闭）: ${(e as Error).message}`);
        markReadyResult = {
          success: false,
          runtimeKey,
          status: 'failed',
          message: `markReady 异常: ${(e as Error).message}`,
        };
      }

      // ── 9. 任务成功 ──
      const statusAfter = markReadyResult.success ? markReadyResult.status : 'failed';
      finalizeTask('done', 1, 0);
      log('info', 'Adapter 测试任务成功完成（窗口保持打开）');

      return {
        taskId, runtimeKey, success: true,
        statusBefore, statusAfter,
        currentUrl, pageTitle,
        markBusyResult, markReadyResult,
        message: '测试任务成功完成',
      };

    } catch (err) {
      const errMsg = (err as Error).message;
      log('error', `测试任务异常: ${errMsg}`);

      // 异常路径也尝试 markReady（除非 markBusy 未成功）
      if (markBusyResult?.success) {
        log('info', '异常路径: 尝试 markReady 恢复窗口状态...');
        try {
          markReadyResult = await adapter.markReady(runtimeKey);
          log('info', `markReady 结果: success=${markReadyResult.success}, status=${markReadyResult.status}`);
        } catch (e) {
          log('warning', `异常路径 markReady 失败: ${(e as Error).message}`);
          markReadyResult = {
            success: false,
            runtimeKey,
            status: 'failed',
            message: `markReady 异常: ${(e as Error).message}`,
          };
        }
      }

      finalizeTask('failed', 0, 1);
      return {
        taskId, runtimeKey, success: false,
        statusBefore, statusAfter: markReadyResult?.status || 'failed',
        markBusyResult, markReadyResult,
        message: `测试任务异常: ${errMsg}`,
      };
    }
  }
}
