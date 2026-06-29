// AssignmentEngine 模块入口
// Phase D-1: 统一任务执行引擎
// Phase E-1: 新增 SignHandler
export { AssignmentEngine, type EngineExecuteOptions } from './AssignmentEngine';
export type { Assignment, WorkerContext, TaskContext, TaskResult, LogFn, ProgressFn } from './types';
export type { TaskHandler } from './handlers/TaskHandler';
export { ArrivalHandler } from './handlers/ArrivalHandler';
export { DispatchHandler } from './handlers/DispatchHandler';
export { IntegratedHandler } from './handlers/IntegratedHandler';
export { SignHandler } from './handlers/SignHandler';
export { InitWindowHandler } from './handlers/InitWindowHandler';
