// TaskHandler — 业务执行抽象
// Phase D-1: 每种任务类型实现此接口，Engine 通过统一接口调用
//
// 开闭原则：新增任务类型只需新增 Handler + registerHandler，无需修改 Engine
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/**
 * 任务处理器接口
 *
 * 职责：仅执行业务逻辑（页面操作 + 运单处理）
 * 禁止：lock / createTask / updateTask / getStaffConnection（由 Engine 负责）
 *
 * @param ctx         Worker 执行上下文（page + staffLog）
 * @param assignment  本次分配（staffName + waybillNos）
 * @param taskContext 任务上下文（taskId + site + taskType）
 * @param onProgress  进度回调（每批完成时调用，传入新增结果）
 * @returns           本 Assignment 的执行摘要
 */
export interface TaskHandler {
  executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult>;
}
