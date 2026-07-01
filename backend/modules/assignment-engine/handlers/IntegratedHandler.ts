// IntegratedHandler — 到派一体扫描业务处理器
// Phase D-1: 包装 IntegratedScan.executeOneStaff()，仅保留业务逻辑
//
// 来源：src/operations/IntegratedScan.ts → executeOneStaff()
// 迁移原则：与 DispatchHandler 相同 — 仅保留页面操作 + 到派一体业务逻辑
import { executeOneStaff } from '../../../operations/IntegratedScan';
import type { TaskHandler } from './TaskHandler';
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/**
 * 到派一体扫描 Handler
 *
 * 业务流程（由 executeOneStaff 负责）：
 *   按 200 条/批拆分 → 逐批：导航到件页 → reload → PageStateManager 检查 →
 *   选上一站 → 勾选到派一体 → 选派件员（弹窗）→ 逐个添加运单 →
 *   设 200/页 → 全选 → 上传 → toast 判定
 */
export class IntegratedHandler implements TaskHandler {
  async executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult> {
    const results = await executeOneStaff(ctx.page, assignment, ctx.log, taskContext.taskId, taskContext.dryRunMode, taskContext.site);

    // 上报进度（Engine 累积 allResults 并更新 db）
    onProgress(results.length, results);

    const failed = results.filter(r => !r.success).length;
    const successCount = results.length - failed;

    // Phase 5-G-6: 写员工级最终成功/失败汇总日志
    if (failed === 0) {
      ctx.log('info', `到派一体完成: 成功${successCount}条, 失败${failed}条`);
    } else {
      ctx.log('error', `到派一体完成: 成功${successCount}条, 失败${failed}条`);
    }

    return {
      success: failed === 0,
      processed: results.length,
      failed,
    };
  }
}
