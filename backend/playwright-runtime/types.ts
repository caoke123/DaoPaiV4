/**
 * Playwright 原生窗口运行时 — 类型定义
 *
 * bnsy-operator-next Phase 1 POC
 * 验证不依赖 EasyBR 的浏览器窗口管理能力。
 *
 * 隔离设计（Phase 1-A 补丁）：
 *   - userDataDir: runtime/profiles/{tenantId}/{siteId}/{windowId}/
 *   - runtimeKey:  `${tenantId}:${siteId}:${windowId}`
 *   - 所有 open/close/status/login 操作统一使用 runtimeKey
 */
import type { BrowserContext, Page } from 'playwright';

// ── 目标业务系统常量 ──

export const TARGET_DOMAIN = 'bnsy.benniaosuyun.com';
export const TARGET_DASHBOARD = `https://${TARGET_DOMAIN}/dashboard`;
export const TARGET_LOGIN_PAGE_HINTS = ['/login', 'Login'];

// ── 默认租户/站点（POC 阶段使用，Phase 2 会员系统接入后由认证上下文提供） ──

export const DEFAULT_TENANT_ID = 'tenant-default';
export const DEFAULT_SITE_ID = 'site-default';

/**
 * 构建 runtimeKey — 统一的窗口标识
 *
 * 格式: `${tenantId}:${siteId}:${windowId}`
 *
 * 用途：
 *   - PlaywrightWindowStateStore 内部 Map key
 *   - 所有 open/close/status/login 操作的唯一标识
 *   - 确保不同 tenant/site 下同名 windowId 不会误关
 */
export function buildRuntimeKey(tenantId: string, siteId: string, windowId: string): string {
  return `${tenantId}:${siteId}:${windowId}`;
}

/**
 * 解析 runtimeKey 回三元组
 */
export function parseRuntimeKey(runtimeKey: string): { tenantId: string; siteId: string; windowId: string } {
  const parts = runtimeKey.split(':');
  if (parts.length < 3) {
    throw new Error(`非法 runtimeKey: ${runtimeKey}，期望格式 tenantId:siteId:windowId`);
  }
  // windowId 本身可能含冒号，所以第 3 段之后全部归为 windowId
  return {
    tenantId: parts[0],
    siteId: parts[1],
    windowId: parts.slice(2).join(':'),
  };
}

// ── 启动选项 ──

export interface PlaywrightWindowOptions {
  /** 窗口唯一标识（建议使用 staffName 或 windowName 的 slug） */
  windowId: string;
  /** 租户 ID（默认 'tenant-default'，Phase 2 会员系统接入后必填） */
  tenantId?: string;
  /** 站点 ID（默认 'site-default'） */
  siteId?: string;
  /** 窗口显示名（用于日志） */
  windowName?: string;
  /** 员工姓名（用于从 SettingsManager 查找凭据） */
  staffName?: string;
  /** 站点名（用于从 SettingsManager 查找凭据，如 'tiannanda' / 'heyuan'） */
  siteName?: string;
  /** 是否无头模式（POC 默认 false，便于观察） */
  headless?: boolean;
  /** 是否尝试自动登录（检测到登录页时） */
  autoLogin?: boolean;
  /** 显式提供的凭据（优先级高于 SettingsManager） */
  credential?: PlaywrightCredential;
  /** 启动后初始导航 URL（默认 TARGET_DASHBOARD） */
  initialUrl?: string;
}

export interface PlaywrightCredential {
  account: string;
  password: string;
}

// ── 窗口状态 ──

export type PlaywrightWindowStatus =
  | 'launching'        // 正在启动
  | 'ready'            // 已就绪（已登录或在 dashboard）
  | 'busy'             // 任务执行中（Phase 1-C：任务完成后回到 ready，不关闭 context）
  | 'login_required'   // 需要登录
  | 'logging_in'       // 正在执行自动登录
  | 'closed'           // 已关闭
  | 'error';           // 错误

export interface PlaywrightWindowState {
  /** runtimeKey = tenantId:siteId:windowId */
  runtimeKey: string;
  tenantId: string;
  siteId: string;
  windowId: string;
  windowName?: string;
  staffName?: string;
  siteName?: string;
  status: PlaywrightWindowStatus;
  /** 当前页面 URL */
  currentUrl?: string;
  /** 是否在登录页 */
  isLoginPage?: boolean;
  /** 是否已登录 */
  isLoggedIn?: boolean;
  /** userDataDir 绝对路径（三层隔离: profiles/{tenantId}/{siteId}/{windowId}/） */
  userDataDir: string;
  /** 启动时间戳 */
  createdAt: number;
  /** 最后更新时间戳 */
  lastUpdated: number;
  /** 错误信息（status='error' 时） */
  error?: string;
  // ── Phase 4-B READY 守卫诊断字段 ──
  /** P0 检查是否通过（ready 状态必须为 true） */
  p0Passed?: boolean;
  /** P0 失败的检查项名（如 'url_domain' / 'dom_missing' / 'popup_blocking'） */
  p0FailedCheck?: string | null;
  /** P0 失败原因（人类可读） */
  p0FailedReason?: string | null;
  /** 当前 context 内标签页数量（ensureSingleBusinessPage 后应为 1） */
  pageCount?: number;
  /** 当前激活页 URL（与 currentUrl 可能不同：currentUrl 是 refreshState 时记录，activePageUrl 是 P0 检查时记录） */
  activePageUrl?: string;
  /** 最后一次 P0 检查时间戳 */
  p0CheckedAt?: number;
  // ── Phase K-3A: CDP endpoint 暴露（用于 Agent 接管 READY 窗口） ──
  /**
   * Chrome 远程调试端口（仅 127.0.0.1 监听）。
   * 启动时由 allocateCdpPort 按 runtimeKey 哈希到 9300-9399 范围分配。
   * 仅当 ENABLE_WINDOW_CDP_ENDPOINT=true 时分配；否则为 undefined。
   */
  cdpPort?: number;
  /**
   * CDP endpoint URL，格式 `http://127.0.0.1:${cdpPort}`。
   * Agent 使用 chromium.connectOverCDP(cdpEndpoint) 接管 READY 窗口。
   * 仅本机访问，不暴露公网。
   */
  cdpEndpoint?: string;
  /**
   * 是否可被 Agent CDP 接管。
   * - true: 启用了 ENABLE_WINDOW_CDP_ENDPOINT 且成功分配端口
   * - false: 开关关闭、端口分配失败、或旧窗口启动时未带 CDP 端口
   * Agent 应跳过 cdpAttachable=false 的窗口，避免误新开 Chrome。
   */
  cdpAttachable?: boolean;
  // ⚠️ context 和 page 不序列化，仅运行时持有
  context?: BrowserContext;
  page?: Page;
}

// ── 登录结果 ──

export type PlaywrightLoginReason =
  | 'already_logged_in'   // 本来就登录着
  | 'login_succeeded'     // 自动登录成功
  | 'no_credential'       // 未找到凭据
  | 'no_login_form'       // 检测到登录页但找不到表单
  | 'login_failed'        // 点击登录后未跳转
  | 'timeout'             // 等待跳转超时
  | 'not_on_login_page';  // 不在登录页

export interface PlaywrightLoginResult {
  success: boolean;
  reason: PlaywrightLoginReason;
  finalUrl?: string;
  message?: string;
}

// ── 启动结果 ──

export interface PlaywrightLaunchResult {
  success: boolean;
  state?: PlaywrightWindowState;
  error?: string;
}

// ── Phase 1-C：会话调试类型 ──

/** JWT 解析结果（脱敏，不包含完整 token） */
export interface JwtDebugInfo {
  /** token 是否存在 */
  found: boolean;
  /** localStorage 中存储 token 的 key 名 */
  storageKey?: string;
  /** 脱敏 token（前 12 位 + ... + 后 6 位） */
  tokenMasked?: string;
  /** JWT header（alg/typ） */
  header?: { alg?: string; typ?: string };
  /** JWT payload 关键字段 */
  payload?: {
    iat?: number;
    exp?: number;
    /** 其他业务字段（如 netWorkId） */
    [key: string]: unknown;
  };
  /** exp 对应的本地时间（ISO 字符串） */
  expLocalTime?: string;
  /** 当前本地时间（ISO 字符串） */
  nowLocalTime: string;
  /** 是否已过期 */
  expired: boolean;
  /** 距离过期还有多少秒（负数表示已过期） */
  remainingSeconds?: number;
  /** 解析错误 */
  parseError?: string;
}

/** 单个 Cookie 调试信息（脱敏，不包含 value） */
export interface CookieDebugInfo {
  name: string;
  domain: string;
  /** 是否 session cookie（无 expires 或 expires 为 0） */
  isSession: boolean;
  /** 是否有 expires */
  hasExpires: boolean;
  /** expires 对应的本地时间（ISO 字符串，session cookie 为 null） */
  expiresLocalTime?: string | null;
  /** 是否 httpOnly */
  httpOnly: boolean;
  /** 是否 secure */
  secure: boolean;
  /** 是否 sameSite */
  sameSite?: string;
}

/** Cookie 分析结果 */
export interface CookieAnalysisResult {
  /** 当前 domain 下 cookie 数量 */
  count: number;
  /** cookie 名称列表 */
  names: string[];
  /** 是否存在 session cookie */
  hasSessionCookie: boolean;
  /** 是否存在 persistent cookie */
  hasPersistentCookie: boolean;
  /** 详细列表（脱敏） */
  cookies: CookieDebugInfo[];
}

/** 会话调试综合信息 */
export interface SessionDebugInfo {
  runtimeKey: string;
  currentUrl: string;
  isLoginPage: boolean;
  isLoggedIn: boolean;
  /** localStorage 中 JWT token 分析 */
  jwt: JwtDebugInfo;
  /** 当前 domain 下 Cookie 分析 */
  cookies: CookieAnalysisResult;
  /** 采集时间戳 */
  collectedAt: number;
}

// ── Phase 1-C：close 幂等结果 ──

export interface CloseResult {
  success: boolean;
  /** 是否本就是已关闭状态（幂等场景） */
  alreadyClosed?: boolean;
  /** 关闭后的状态码 */
  status: PlaywrightWindowStatus;
  runtimeKey: string;
}
