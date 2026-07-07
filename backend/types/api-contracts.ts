/**
 * api-contracts.ts — 全栈 API 契约的单一真理来源 (Single Source of Truth)
 *
 * 目的：
 *   - 解决《全栈数据资产盘点报告》中发现的 5 处前后端类型不一致
 *   - 消灭 TaskLogEntry 的 3 层断裂问题（后端内存 / API 传输 / 前端 UI）
 *   - 为 PostgreSQL 换代提供准确的实体字典
 *
 * 使用规则：
 *   - 后端所有 routes.ts 返回类型必须引用此文件
 *   - 前端 client.ts 必须 1:1 对齐此文件的类型定义（由于前后端物理隔离，复制并注释 "MUST SYNC"）
 *   - 任何字段新增/变更 → 先改此文件 → 再改 routes.ts → 再改 client.ts
 *
 * 版本：v1.0 (2026-06-22)
 */

// ══════════════════════════════════════════════════════════════
// 一、基础枚举与字面量类型
// ══════════════════════════════════════════════════════════════

/** 任务生命周期状态 */
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务类型 */
export type TaskType = 'arrive' | 'arrival' | 'dispatch' | 'sign' | 'integrated' | 'init_window' | 'agent_test';

/** 窗口角色 */
export type WindowRole = 'admin' | 'staff';

/** 日志级别 */
export type LogLevel = 'info' | 'success' | 'warning' | 'error';

/** 运单结果详细状态 */
export type WaybillResultStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNKNOWN_NEEDS_MANUAL_CHECK' | 'DRY_RUN_SKIPPED' | 'SAFETY_GATE_SKIPPED';

// ══════════════════════════════════════════════════════════════
// 二、核心业务实体
// ══════════════════════════════════════════════════════════════

/**
 * 网点
 *
 * 对应 PG 表: sites
 * 注意：此类型为动态定义。后端 routes.ts 中 `site` 参数校验不应使用硬编码字面量，
 * 而应查询数据库或 SettingsManager 获取可用网点列表。
 */
export interface Site {
  /** 网点唯一标识，如 "tiannanda"、"heyuan" */
  id: string;
  /** 网点显示名称，如 "天南大网点"、"和苑网点" */
  name: string;
  /** 网点代码（可选），如 "TJ-ND" */
  code?: string;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * EasyBR 窗口信息
 *
 * 对应 PG 表: windows
 * 同时存在于内存 (BrowserPool.connections) 和持久化存储 (Database.windows 表) 中。
 * 内存中的 Browser/Page 引用不可序列化，但 id/name/role 等元数据持久化。
 */
export interface WindowInfo {
  /** EasyBR browerid（窗口唯一标识） */
  id: string;
  /** EasyBR 窗口名称 */
  name: string;
  /** CDP 调试端口（当前固定为 0，保留字段） */
  cdpPort: number;
  /** 窗口角色：管理员窗口 / 员工窗口 */
  role: WindowRole;
  /** 所属网点 ID */
  site: string;
  /** 登录的员工姓名（仅员工窗口有值，管理员窗口为 null） */
  staffName: string | null;
  /** 当前连接状态 */
  isConnected: boolean;
  /** 是否启用（用户手动 toggle 的状态，重启后可恢复） */
  enabled: boolean;
}

/**
 * 任务
 *
 * 对应 PG 表: tasks
 * Phase I 已废除 result_data 列（不再被 Engine 写入），PG 时代不建此列。
 */
export interface Task {
  /** UUID v4 任务唯一 ID */
  id: string;
  /** 任务类型 */
  type: TaskType;
  /** 所属网点 */
  site: string;
  /** 任务生命周期状态 */
  status: TaskStatus;
  /** 运单总数 */
  totalCount: number;
  /** 已处理运单数（成功 + 失败） */
  doneCount: number;
  /** 失败运单数 */
  failCount: number;
  /** 原始请求参数 (JSON 字符串，PG 中改为 JSONB) */
  inputData?: string;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 完成时间 (ISO 8601)，任务未结束时为 null */
  finishedAt?: string | null;
}

/**
 * 运单操作结果
 *
 * 对应 PG 表: waybill_results
 * 原 OperationResult 的重命名版本，增加了 task_id 和 batch_seq（后端内部使用，API 不暴露）。
 */
export interface WaybillResult {
  /** 运单号 */
  waybillNo: string;
  /** 处理该运单的员工姓名（到件扫描可能为 undefined） */
  staffName?: string;
  /** 是否成功 */
  success: boolean;
  /** 结果描述（成功提示 / 失败原因 / 异常信息） */
  message: string;
  /** 操作时间戳 (毫秒) */
  timestamp: number;
  /** 详细状态：SUCCESS / PARTIAL / FAILED / UNKNOWN_NEEDS_MANUAL_CHECK */
  status?: WaybillResultStatus;
}

/**
 * 任务执行日志条目（后端内存 → API 传输 → 前端接收）
 *
 * 这是统一后的唯一 TaskLogEntry 定义，取代了此前的 3 层断裂：
 *   - TaskLogManager.TaskLogEntry (内存)
 *   - client.ts TaskLogEntry (API 传输)
 *   - TaskLogPanel.TaskLogEntry (UI 渲染)
 *
 * 前端 UI 层需要额外字段时，通过转换函数从本类型派生，不额外定义类型。
 */
export interface TaskLogEntry {
  /** 日志唯一 ID */
  id: string;
  /** 所属任务 ID */
  taskId: string;
  /** 日志时间戳 (毫秒) */
  timestamp: number;
  /** 日志级别 */
  level: LogLevel;
  /** 日志内容 */
  message: string;
  /** 来源模块 (如 "Engine", "api", "DispatchHandler") */
  source: string;
  /** 结构化窗口追踪：员工姓名（管理员窗口为 undefined） */
  staffName?: string;
  /** 结构化窗口追踪：窗口 ID */
  windowId?: string;
  /** Phase 2-D: 产生该日志的工作站 ID */
  workstationId?: string;
}

// ══════════════════════════════════════════════════════════════
// 三、API 请求/响应契约
// ══════════════════════════════════════════════════════════════

/**
 * GET /api/status 响应
 *
 * 修复点：StatusResponse 现包含 runtimeMetrics 字段（此前前端缺失）。
 */
export interface StatusResponse {
  /** EasyBR 窗口总数 */
  total: number;
  /** 已连接窗口数 */
  connected: number;
  /** 各窗口连接详情 */
  windows: WindowInfo[];
  /** 运行时指标快照（服务重启后归零） */
  runtimeMetrics: RuntimeMetricsSnapshot;
}

/**
 * GET /api/operations/:taskId 响应
 *
 * 修复点：
 *   - status 现包含 'cancelled'（此前前端 TaskProgress 缺失）
 *   - results 字段为 WaybillResult[]（此前 OperationResult 缺少 status + staffName）
 */
export interface TaskProgressResponse {
  /** 任务 ID */
  taskId: string;
  /** 任务状态（含 cancelled） */
  status: TaskStatus;
  /** 运单总数 */
  total: number;
  /** 已处理运单数 */
  done: number;
  /** 失败运单数 */
  failCount: number;
  /** 运单操作结果列表 */
  results: WaybillResult[];
}

/**
 * GET /api/operations 响应（任务列表）
 *
 * 修复点：total 现为符合过滤条件的真实任务总数（此前仅返回当前页长度，语义错误）。
 */
export interface TaskListResponse {
  /** 当前页码 */
  page: number;
  /** 每页数量 */
  limit: number;
  /** 符合条件的任务总数（非当前页数量） */
  total: number;
  /** 当前页任务列表 */
  tasks: Task[];
}

/**
 * POST /api/operations/* 任务提交响应
 */
export interface TaskSubmitResponse {
  /** 任务 ID */
  taskId: string;
  /** 初始状态（始终为 'pending'） */
  status: 'pending';
}

/**
 * 系统设置 — 网点窗口凭据
 */
export interface SiteWindowCredential {
  /** 窗口名称，如 "CDP-1" */
  windowName: string;
  /** 员工姓名 */
  employeeName: string;
  /** 登录账号 */
  username: string;
  /** 登录密码（API 传输为明文，后端存储为 Base64 编码） */
  password: string;
}

/**
 * 系统设置 — 网点配置
 */
export interface SiteConfig {
  /** 网点唯一 ID */
  id: string;
  /** 网点显示名称 */
  name: string;
  /** 该网点下的员工窗口列表 */
  windows: SiteWindowCredential[];
}

/**
 * GET /api/settings/config 响应
 */
export interface SettingsConfigResponse {
  /** 系统是否已初始化 */
  initialized: boolean;
  /** 网点列表 */
  sites: SiteConfig[];
}

// ══════════════════════════════════════════════════════════════
// 四、运行时指标
// ══════════════════════════════════════════════════════════════

/**
 * 运行时指标快照
 *
 * 由 RuntimeMetrics.snapshot() 生成，通过 /api/status 暴露。
 * 服务重启后所有计数器归零。
 */
export interface RuntimeMetricsSnapshot {
  /** 弹窗清除次数 */
  popupDismissCount: number;
  /** Session 自动恢复尝试次数 */
  sessionRecoverCount: number;
  /** Session 自动恢复成功次数 */
  sessionRecoverSuccessCount: number;
  /** Session 自动恢复失败次数 */
  sessionRecoverFailCount: number;
  /** 导航自动修复次数 */
  navigationFixCount: number;
  /** 运单成功累计数 */
  taskSuccessCount: number;
  /** 运单失败累计数 */
  taskFailCount: number;
  /** 服务启动时间 (ISO 8601) */
  startTime: string;
  /** 快照生成时间 (ISO 8601) */
  snapshotTime: string;
  /** 运行时长 (毫秒) */
  uptimeMs: number;
}
