// ArrivalHandler — 到件扫描业务处理器
// Phase D-1: 包装 ArriveScanBatch.execute()，仅保留业务逻辑
//
// 来源：src/operations/ArriveScanBatch.ts → execute()
// 迁移原则：只迁移业务逻辑，lock/createTask/updateTask/getStaffConnection 交给 Engine
import { execute as arriveExecute } from '../../../operations/ArriveScanBatch';
import type { TaskHandler } from './TaskHandler';
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/**
 * 到件扫描 Handler
 *
 * 业务流程（由 arriveExecute 负责）：
 *   按 200 条/批拆分 → 逐批：PageStateManager 检查 → 填入 textarea → 选上一站 →
 *   查询 → 设 200/页 → 全选 → 批量到件 → toast 四态判定
 */
export class ArrivalHandler implements TaskHandler {
  async executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult> {
    const results = await arriveExecute(
      ctx.page,
      assignment.waybillNos,
      onProgress,
      taskContext.taskId,
      ctx.windowId,
      ctx.staffName,
      taskContext.dryRunMode,
    );

    const failed = results.filter(r => !r.success).length;
    return {
      success: failed === 0,
      processed: results.length,
      failed,
    };
  }
}
