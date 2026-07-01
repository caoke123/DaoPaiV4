// DispatchHandler — 派件扫描业务处理器
// Phase D-1: 包装 DispatchScan.executeOneStaff()，仅保留业务逻辑
//
// 来源：src/operations/DispatchScan.ts → executeOneStaff()
// 迁移原则：仅保留页面操作 + 派件业务逻辑
// 移除：Promise.all / lock / getStaffConnection / updateTask（交给 Engine）
import { executeOneStaff } from '../../../operations/DispatchScan';
import type { TaskHandler } from './TaskHandler';
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/**
 * 派件扫描 Handler
 *
 * 业务流程（由 executeOneStaff 负责）：
 *   按 200 条/批拆分 → 逐批：导航派件页 → reload → PageStateManager 检查 →
 *   选派件员 → 逐个添加运单 → 设 200/页 → 全选 → [DRY-RUN]上传 → toast 判定
 */
export class DispatchHandler implements TaskHandler {
  async executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult> {
    // executeOneStaff 返回该员工所有运单的结果（含批次内重试）
    const results = await executeOneStaff(ctx.page, assignment, ctx.log, taskContext.taskId, taskContext.dryRunMode);

    // 上报进度（Engine 累积 allResults 并更新 db）
    onProgress(results.length, results);

    const failed = results.filter(r => !r.success).length;
    const successCount = results.length - failed;

    // Phase 5-G-6: 写员工级最终成功/失败汇总日志
    if (failed === 0) {
      ctx.log('info', `派件扫描完成: 成功${successCount}条, 失败${failed}条`);
    } else {
      ctx.log('error', `派件扫描完成: 成功${successCount}条, 失败${failed}条`);
    }

    return {
      success: failed === 0,
      processed: results.length,
      failed,
    };
  }
}
