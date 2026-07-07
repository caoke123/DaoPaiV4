// AssignmentEngine 模块入口
// Phase D-1: 统一任务执行引擎
// Phase E-1: 新增 SignHandler
// Phase K-R1: 四业务 Handler（Arrival/Dispatch/Integrated/Sign）已归档到
//   backend/archive/cloud-engine/handlers/，主代码不再 export/import。
//   Cloud 引擎不得再执行四业务；四业务只能由 Local Agent 执行。
//   仍保留 InitWindowHandler 供 POST /api/windows/init 使用。
export { AssignmentEngine, type EngineExecuteOptions } from './AssignmentEngine';
export type { Assignment, WorkerContext, TaskContext, TaskResult, LogFn, ProgressFn } from './types';
export type { TaskHandler } from './handlers/TaskHandler';
export { InitWindowHandler } from './handlers/InitWindowHandler';
