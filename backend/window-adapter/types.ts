/**
 * Window Adapter 类型定义 — Phase 2-A
 *
 * 适配层位于上层业务（未来 Handlers）与底层 PlaywrightRuntime 之间。
 * 上层只依赖本文件中的类型，不直接 import playwright-runtime 的内部类型。
 *
 * 设计原则：
 *   - options 必须包含 tenantId + siteId + windowId（禁止只传 windowId）
 *   - 状态码与 PlaywrightWindowStatus 对齐，但对外收敛为更稳定的子集
 *   - 不暴露 Page 的细节给 HTTP 层（POC 路由只返回状态，不返回 page 对象）
 */
import type { Page } from 'playwright';

/**
 * 适配层对外暴露的窗口状态码
 *
 * 与 PlaywrightWindowStatus 的映射：
 *   launching / logging_in → 'opening'
 *   ready                  → 'ready'
 *   busy                   → 'busy'
 *   login_required         → 'login_required'
 *   closed                 → 'closed'
 *   error                  → 'failed'
 */
export type AdapterWindowStatus =
  | 'ready'
  | 'login_required'
  | 'opening'
  | 'busy'
  | 'failed'
  | 'closed';

/**
 * 所有适配层操作的统一入参
 *
 * 必须包含 tenantId + siteId + windowId，禁止只传 windowId。
 * 这是为了避免不同租户/站点下同名 windowId 误操作。
 */
export interface WindowAdapterOptions {
  tenantId: string;
  siteId: string;
  windowId: string;
  /** 员工姓名（用于日志和凭据查找，可选） */
  staffName?: string;
  /** 站点名（用于凭据查找，可选） */
  siteName?: string;
  /** 窗口显示名（用于日志，可选） */
  windowName?: string;
}

/**
 * ensureWindowReady 返回结果
 *
 * - 如果窗口不存在，会自动启动
 * - 如果窗口存在但状态不是 ready/busy，会返回当前状态
 * - 只有 status='ready' 时才表示可以执行任务
 */
export interface WindowReadyResult {
  runtimeKey: string;
  status: AdapterWindowStatus;
  userDataDir: string;
  /** 窗口是否刚刚被启动（首次创建） */
  launched: boolean;
  /** 当前 URL */
  currentUrl?: string;
  /** 是否已登录 */
  isLoggedIn?: boolean;
  /** 状态说明（如 login_required 时给出提示） */
  message?: string;
}

/**
 * getWorkerPage 返回结果
 *
 * 只有 status='ready' 或 'busy' 时才会返回 page。
 * 其他状态 page 为 undefined。
 *
 * 注意：page 不可序列化，仅用于进程内调用，不通过 HTTP 返回。
 */
export interface WorkerPageResult {
  runtimeKey: string;
  status: AdapterWindowStatus;
  page?: Page;
  currentUrl?: string;
  isLoggedIn?: boolean;
  /** 如果不可用，说明原因 */
  message?: string;
}

/**
 * refreshStatus 返回结果
 */
export interface WindowStatusResult {
  runtimeKey: string;
  status: AdapterWindowStatus;
  userDataDir: string;
  currentUrl?: string;
  isLoggedIn?: boolean;
  isLoginPage?: boolean;
  lastUpdated?: number;
}

/**
 * 适配层 closeWindow 返回结果
 *
 * 与 PlaywrightRuntime.CloseResult 对齐，但 status 收敛为 AdapterWindowStatus。
 */
export interface AdapterCloseResult {
  success: boolean;
  /** 是否本就是已关闭状态（幂等场景） */
  alreadyClosed?: boolean;
  status: AdapterWindowStatus;
  runtimeKey: string;
}

/**
 * markBusy / markReady 返回结果
 */
export interface MarkResult {
  success: boolean;
  runtimeKey: string;
  status: AdapterWindowStatus;
  message?: string;
}
