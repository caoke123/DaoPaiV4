// 操作基类
// 定义操作结果接口和通用执行流程，所有操作模块（到件/派件/签收）继承此类

/**
 * 单条操作结果
 */
export interface OperationResult {
  waybillNo: string;      // 运单号
  success: boolean;       // 是否成功
  message: string;        // 结果消息（成功提示/失败原因/异常信息）
  timestamp: number;      // 操作时间戳（毫秒）
  /** C1-2/C1-3: 详细状态，区分 SUCCESS/PARTIAL/FAILED/UNKNOWN_NEEDS_MANUAL_CHECK */
  status?: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNKNOWN_NEEDS_MANUAL_CHECK' | 'DRY_RUN_SKIPPED' | 'SAFETY_GATE_SKIPPED';
  /** 派件扫描：归属员工姓名（到件扫描不使用） */
  staffName?: string;
  /** Phase 9-dryrun: 是否为试运行模式跳过真实提交 */
  dryRun?: boolean;
  /** Phase 9-dryrun: 是否跳过了最终提交按钮 */
  skippedFinalSubmit?: boolean;
}

/**
 * 任务进度
 */
export interface TaskProgress {
  taskId: string;                              // 任务 ID
  status: 'pending' | 'running' | 'done' | 'failed';  // 任务状态
  total: number;                               // 总单数
  done: number;                                // 已完成数
  failCount: number;                           // 失败数
  results: OperationResult[];                  // 所有单号的操作结果
}

/**
 * 操作输入参数（含 dry-run 选项）
 */
export interface OperationInput {
  dryRun?: boolean;        // 试运行模式：只做导航和填入，不点击提交按钮
  onProgress?: (done: number, total: number, current: OperationResult) => void; // 进度回调
}

/**
 * 操作基类
 * 子类需实现 execute 方法，完成具体的页面操作
 */
export abstract class BaseOperation {
  /** 操作类型标识 */
  abstract readonly type: string;

  /**
   * 执行操作
   * @param input 操作输入参数
   * @returns 所有单号的操作结果列表
   */
  abstract execute(input: OperationInput): Promise<OperationResult[]>;

  /**
   * 记录单条操作结果并触发进度回调
   */
  protected reportProgress(
    results: OperationResult[],
    total: number,
    input: OperationInput,
    result: OperationResult
  ): void {
    results.push(result);
    if (input.onProgress) {
      input.onProgress(results.length, total, result);
    }
  }
}
