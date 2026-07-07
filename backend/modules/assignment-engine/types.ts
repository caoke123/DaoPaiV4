// AssignmentEngine — 统一任务执行引擎类型定义
// Phase D-1: 所有任务类型（arrival/dispatch/integrated）共用统一数据模型
// Phase 2-D: WorkerContext 新增可选 runtimeKey/runtimeMode；新增 WorkerConnectionHandle
import type { Page } from 'playwright';
import type { OperationResult } from '../../operations/BaseOperation';
import type { Site } from '../../db/Database';
import type { LogContext } from '../../utils/TaskLogManager';
import type { WindowRuntimeMode } from '../../config/runtimeMode';

/**
 * 任务分配：每个 Worker 一组运单
 * - Arrival: 单个 Worker 承载所有运单（方案B 自动选择）
 * - Dispatch/Integrated: 多个 Worker 并发，每个 Worker 一组运单
 * - Sign: 每个 Worker 独立配置 pageSize（条数/页）
 */
export interface Assignment {
  staffName: string;
  waybillNos: string[];
  /** init_window 任务专用：目标窗口 ID */
  windowId?: string;
  /** sign 任务专用：签收人类型 */
  signer?: string;
  /** sign 任务专用：每页条数（30/50/100/200），默认 100 */
  pageSize?: 30 | 50 | 100 | 200;
  /** Phase 2-B: 指定模式 — 入参透传 */
  executionMode?: 'default' | 'designated';
  /** Phase 2-B: 指定模式 — 目标派件员姓名 */
  targetCourierName?: string;
  /** Phase 2-B: 指定模式 — 目标派件员账号 */
  targetCourierAccount?: string;
  /** Phase 2-B: 指定模式签收 — 签收人（仅签收页面使用） */
  signerPerson?: '本人' | '家人' | '家门口' | '代收点';
}

/**
 * Worker 执行上下文（Engine 注入）
 * 包含 Worker Window 的页面访问能力 + 带上下文的日志函数
 *
 * Phase 2-D: 新增可选字段 runtimeKey / runtimeMode
 *   - runtimeKey：用于日志诊断（playwright 模式下为 tenantId:siteId:windowId）
 *   - runtimeMode：用于调试和回滚（'legacy_easybr' | 'playwright'）
 *   - 向后兼容：legacy 路径可不填，Handler 不应感知这两个字段
 */
export interface WorkerContext {
  staffName: string;
  windowId: string;
  page: Page;
  /** 带 staffName+windowId 上下文的日志函数（staffLog 闭包模式） */
  log: LogFn;
  /** Phase 2-D: 运行时键（仅日志诊断用，不参与业务逻辑） */
  runtimeKey?: string;
  /** Phase 2-D: 运行时模式（仅调试和回滚用，Handler 不应感知） */
  runtimeMode?: WindowRuntimeMode;
}

/**
 * Worker 连接句柄 — Phase 2-D
 *
 * 由 Engine 的 resolveWorkerConnection 返回，统一封装两条路径（legacy/playwright）
 * 的窗口连接获取与释放逻辑。
 *
 * 设计原则：
 *   - page/windowId 必填：Handler 通过 WorkerContext.page 访问页面
 *   - runtimeKey/runtimeMode 可选：用于日志诊断
 *   - release 必填：finally 中调用，释放 lock + markReady（playwright）或 lease（legacy）
 *   - renew 可选：busy 续租定时器调用
 *
 * 调用顺序约束（playwright 模式）：
 *   - 获取：ensureWindowReady → lockManager.acquire → adapter.markBusy → getWorkerPage
 *   - 释放（finally）：adapter.markReady → lockManager.release
 *   - markReady 必须在 release lock 之前
 *   - markReady 失败仅记录日志，不阻断 release lock
 */
export interface WorkerConnectionHandle {
  /** Worker 页面（注入 WorkerContext.page） */
  page: Page;
  /** 窗口 ID（注入 WorkerContext.windowId） */
  windowId: string;
  /** 运行时键（playwright 模式下为 tenantId:siteId:windowId，legacy 可不填） */
  runtimeKey?: string;
  /** 运行时模式 */
  runtimeMode: WindowRuntimeMode;
  /** 释放连接（finally 中调用）：先 markReady 后 release lock（playwright）；lease.release（legacy） */
  release: () => Promise<void>;
  /** 续租（busy 续租定时器调用，可选） */
  renew?: () => Promise<void>;
}

/**
 * 任务上下文（全局，跨 Worker 共享）
 *
 * Phase E-1: 新增 'sign' 任务类型
 * Phase 9-dryrun: 新增 dryRunMode 全局试运行模式
 * Phase 5-I-1: dryRunMode 改为任务级优先（inputData.browserDryRun），全局 SettingsManager 仅兜底
 */
export interface TaskContext {
  taskId: string;
  site: Site;
  taskType: 'arrival' | 'dispatch' | 'sign' | 'integrated' | 'init_window';
  /** 试运行模式：true=跳过最终提交按钮，false=真实执行；由 Engine 通过 resolveTaskDryRun 解析（任务级优先，全局兜底） */
  dryRunMode: boolean;
}

/**
 * 单个 Assignment 执行结果摘要
 */
export interface TaskResult {
  success: boolean;
  processed: number;
  failed: number;
}

/**
 * 日志函数类型（与 operations 模块 LogFn 结构一致）
 */
export type LogFn = (level: 'info' | 'warning' | 'error', msg: string, context?: LogContext) => void;

/**
 * 进度回调类型
 * - done: 本次新增结果数（Engine 以 allResults.length 为全局 done_count，此值仅用于日志）
 * - results: 本次新增的运单结果
 */
export type ProgressFn = (done: number, results: OperationResult[]) => void;
