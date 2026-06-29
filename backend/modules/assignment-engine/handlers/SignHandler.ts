// SignHandler — 签收录入业务处理器
// Phase E-1: 包装 SignScan.executeSign()，实现统一 TaskHandler 接口
//
// 来源：src/operations/SignScan.ts → executeSign()
// 迁移原则：仅保留页面操作 + 签收业务逻辑
// 移除：Promise.all / lock / getStaffConnection / updateTask（交给 Engine）
//
// Phase 9-dryrun: 最终确认按钮受全局 dryRunMode 控制（从 TaskContext 传入）
import { executeSign } from '../../../operations/SignScan';
import type { TaskHandler } from './TaskHandler';
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/**
 * 签收录入 Handler
 *
 * 业务流程（由 executeSign 负责）：
 *   prepareSign() → 导航 + 设置日期 + 选派件员 + 搜索 + 分页 + 全选 + 批量签收 + 选签收人
 *   confirmSign() → safeConfirmSign() 保护，dryRunMode=true 时停止在确认弹窗前
 *
 * 返回：单条 OperationResult，表示预览阶段/真实签收是否成功
 */
export class SignHandler implements TaskHandler {
  async executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult> {
    const results = await executeSign(ctx.page, assignment, ctx.log, taskContext.taskId, taskContext.dryRunMode);

    // 上报进度（Engine 累积 allResults 并更新 db）
    onProgress(results.length, results);

    const failed = results.filter(r => !r.success).length;
    return {
      success: failed === 0,
      processed: results.length,
      failed,
    };
  }
}
