import { PgDatabase } from '../db/PgDatabase';
import { taskLogService } from './TaskLogService';

export type TaskEngineRunSource = 'local-api' | 'agent-engine';

/**
 * Phase K-R1: 四业务 Agent 专属任务类型清单
 *
 * 这四种任务类型只能由 Local Agent 执行，Cloud 引擎不得执行。
 * 任何尝试通过 TaskEngineRunner.runTask 执行这些类型的行为都必须被拒绝。
 */
const AGENT_ONLY_BUSINESS_TYPES = new Set(['arrival', 'arrive', 'dispatch', 'sign', 'integrated']);

/**
 * Phase K-R1: Cloud Engine 硬防护
 *
 * 当 task.type 属于 arrival / arrive / dispatch / sign / integrated 时，
 * 拒绝执行，不得 claim task，不得调用 AssignmentEngine，不得写 source='local-api' 的业务执行日志。
 *
 * 错误码：CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS
 */
function assertNotAgentOnlyBusiness(taskType: string): void {
  if (AGENT_ONLY_BUSINESS_TYPES.has(taskType)) {
    const err = new Error(
      `CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS: task type ${taskType} must be executed by Local Agent only`
    );
    (err as any).code = 'CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS';
    throw err;
  }
}

/**
 * Phase K-R1: TaskEngineRunner — Cloud Engine 硬防护层
 *
 * 改造说明：
 *   - 删除 4 个 Handler 的 import（ArrivalHandler/DispatchHandler/IntegratedHandler/SignHandler 已归档）
 *   - 删除 getEngineHandler 函数（永远返回 null 的死代码）
 *   - 删除 normalizeTaskAssignments 函数（Cloud 引擎不再执行业务，无需解析 assignments）
 *   - 删除 AssignmentEngine.execute 调用（Cloud 引擎不再调用 Engine 执行业务）
 *   - 保留 claimTaskForEngine 调用用于非四业务的兼容路径（实际上非四业务也由 route 直接调用 Engine）
 *
 * 当前行为：
 *   1. precheck 查询 task type
 *   2. 对四业务硬拒绝（throw CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS）
 *   3. 对非四业务返回 skipped=true（Cloud 引擎不再执行任何业务）
 *
 * 注意：
 *   - AssignmentEngine 模块本身仍保留，被 init_window / cancel / stats / recoverRunningTasks 使用
 *   - 非四业务（如 init_window）由各自 route 直接调用 AssignmentEngine.execute，不经此 Runner
 *   - run-engine 端点（agentRoutes.ts）保留为兼容路径，已有 409 保护 + 此处 precheck 二次防护
 */
export class TaskEngineRunner {
  static async runTask(args: {
    taskId: string;
    tenantId: string;
    workstationId: string;
    source: TaskEngineRunSource;
  }): Promise<{ accepted: boolean; skipped?: boolean; reason?: string }> {
    const { taskId, tenantId, workstationId, source } = args;
    const tEntry = Date.now();
    console.log(`[TaskEngineRunner] T5 runTask 收到: taskId=${taskId} source=${source} t=${tEntry}`);

    const pg = PgDatabase.getInstance();

    // Phase K-R1: 先查询 task 类型，对四业务硬拒绝（不得 claim task）
    const precheck = await pg.getTaskById(tenantId, taskId).catch(() => null);
    if (!precheck) {
      console.log(`[TaskEngineRunner] skip: taskId=${taskId} reason=任务不存在`);
      return { accepted: false, skipped: true, reason: '任务不存在' };
    }
    try {
      assertNotAgentOnlyBusiness(precheck.type);
    } catch (e) {
      const err = e as Error & { code?: string };
      console.error(`[TaskEngineRunner] ${err.message}`);
      // 写入失败日志，便于排查
      await taskLogService.appendLogs(taskId, [{
        level: 'error',
        message: `Cloud 引擎拒绝执行：${precheck.type} 已迁移到 Local Agent，Cloud 不得接管。错误码：${err.code}`,
      }], {
        tenantId,
        workstationId,
        source,
      }).catch(logErr => console.error('[TaskEngineRunner] 写拒绝日志失败:', (logErr as Error).message));
      throw err;
    }

    // Phase K-R1: 非四业务（如 init_window）由各自 route 直接调用 AssignmentEngine.execute，
    // 不经此 Runner。Cloud 引擎不再 claim task，不再执行任何业务。
    // run-engine 端点保留为兼容路径，但实际不会执行业务。
    console.log(`[TaskEngineRunner] skip: taskId=${taskId} type=${precheck.type} reason=Cloud 引擎不再执行业务，所有业务由 Local Agent 执行`);
    return {
      accepted: false,
      skipped: true,
      reason: `Cloud 引擎不再执行业务（task type=${precheck.type}）。四业务由 Local Agent 执行；非四业务由 route 直接调用 AssignmentEngine.execute。`,
    };
  }
}
