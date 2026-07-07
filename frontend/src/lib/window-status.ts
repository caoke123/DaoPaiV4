/**
 * DaoPai V4 前端窗口状态定义
 *
 * M5-2: 扩展 DisplayStatus 以支持 Agent 启动中间状态，
 *       同时保持向后兼容的旧 API。
 */

import type {
  SiteWindowState,
  PlaywrightSiteWindowState,
} from '../api/client';

// ─────────────────────────────────────────────
// 1. 统一 displayStatus 枚举 (M5-2 扩展)
// ─────────────────────────────────────────────

export type DisplayStatus =
  | 'offline'
  | 'opening'
  | 'process_started'
  | 'cdp_connecting'
  | 'cdp_connected'
  | 'login_checking'
  | 'login_required'
  | 'p0_checking'
  | 'popup_cleaning'
  | 'ready_checking'
  | 'ready'
  | 'busy'
  | 'closing'
  | 'closed'
  | 'failed'
  // backward compat
  | 'initializing'
  | 'connecting'
  | 'degraded'
  | 'restarting'
  | 'starting';

/**
 * M5-2: 中间状态集合 — 这些状态表示窗口正在启动中，不应该被轮询覆盖回 offline
 */
export const INTERMEDIATE_STATUSES: ReadonlySet<DisplayStatus> = new Set([
  'opening', 'process_started', 'cdp_connecting', 'cdp_connected',
  'login_checking', 'p0_checking', 'popup_cleaning', 'ready_checking',
  'initializing', 'connecting', 'restarting', 'starting',
]);

// ─────────────────────────────────────────────
// 2. 窗口唯一 Key
// ─────────────────────────────────────────────

export function getWindowKey(siteId: string, employeeName: string): string {
  return `${siteId}:${employeeName}`;
}

// ─────────────────────────────────────────────
// 3. READY 守卫
// ─────────────────────────────────────────────

export function isPlaywrightReallyReady(sw: PlaywrightSiteWindowState): boolean {
  if (sw.status !== 'ready') return false;
  if (sw.p0Passed !== true) return false;
  if (sw.pageCount !== 1) return false;
  const url = sw.currentUrl ?? sw.activePageUrl ?? '';
  if (!url) return false;
  if (url === 'about:blank') return false;
  if (!url.includes('bnsy.benniaosuyun.com')) return false;
  if (url.includes('/login')) return false;
  return true;
}

// ─────────────────────────────────────────────
// 4. 统一 displayStatus 计算
// ─────────────────────────────────────────────

export type OptimisticDisplayStatus = Exclude<DisplayStatus, 'offline'>;

export interface WindowDisplayOptions {
  isPlaywright: boolean;
  isInitializing: boolean;
  optimisticStatus?: OptimisticDisplayStatus | null;
}

/**
 * M5-2: 双签名 — 支持旧 (w, options) 和新 (cloudStatusString) 两种调用。
 */
export function getWindowDisplayStatus(
  wOrStatus: SiteWindowState | string | undefined | null,
  options?: WindowDisplayOptions,
): DisplayStatus {
  // New signature: string-based
  if (typeof wOrStatus === 'string' || wOrStatus == null) {
    const cloudStatus = wOrStatus;
    if (!cloudStatus) return 'offline';
    const known = new Set<string>([
      'offline', 'opening', 'process_started', 'cdp_connecting', 'cdp_connected',
      'login_checking', 'login_required', 'p0_checking', 'popup_cleaning',
      'ready_checking', 'ready', 'busy', 'closing', 'closed', 'failed',
      'initializing', 'connecting', 'degraded', 'starting',
    ]);
    if (known.has(cloudStatus)) return cloudStatus as DisplayStatus;
    if (cloudStatus === 'logging_in' || cloudStatus === 'connected') return 'cdp_connecting';
    if (cloudStatus === 'error') return 'failed';
    return 'offline';
  }

  // Old signature: (SiteWindowState, WindowDisplayOptions)
  const w = wOrStatus;
  const { isPlaywright, isInitializing } = options!;

  if (w.status === 'busy') return 'busy';

  const backendTerminal =
    w.status === 'ready' ||
    w.status === 'login_required' ||
    w.status === 'failed' ||
    w.status === 'degraded';

  if (isInitializing && !backendTerminal) return 'initializing';

  if (w.status === 'ready') {
    if (isPlaywright) {
      const pw = w as PlaywrightSiteWindowState;
      if (!isPlaywrightReallyReady(pw)) {
        const url = pw.currentUrl ?? pw.activePageUrl ?? '';
        if (url.includes('/login') || (pw as any).p0FailedCheck === 'url_login') {
          return 'login_required';
        }
        return 'degraded';
      }
    }
    return 'ready';
  }

  if (w.status === 'connecting' || w.status === 'connected' || w.status === 'cdp_connecting' || w.status === 'cdp_connected') {
    return 'cdp_connecting';
  }

  if (w.status === 'login_required') return 'login_required';
  if (w.status === 'degraded') return 'degraded';
  if (w.status === 'failed') return 'failed';

  // M5-2: intermediate statuses pass through
  const intermediate = new Set([
    'opening', 'process_started', 'login_checking', 'p0_checking',
    'popup_cleaning', 'ready_checking', 'starting', 'initializing',
  ]);
  if (intermediate.has(w.status)) return w.status as DisplayStatus;

  return 'offline';
}

// ─────────────────────────────────────────────
// 5. Helper: status → label (M5-2 extended)
// ─────────────────────────────────────────────

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  offline: '离线',
  opening: '启动中',
  process_started: '已启动',
  cdp_connecting: '连接中',
  cdp_connected: '已连接',
  login_checking: '检测登录',
  login_required: '待登录',
  p0_checking: 'P0检查中',
  popup_cleaning: '清理弹窗',
  ready_checking: '就绪检查',
  ready: '就绪',
  busy: '工作中',
  closing: '关闭中',
  closed: '已关闭',
  failed: '异常',
  initializing: '启动中',
  connecting: '连接中',
  degraded: '不稳定',
  restarting: '重启中',
  starting: '启动中',
};

export function getWindowStatusLabel(displayStatus: DisplayStatus): string {
  return STATUS_LABELS[displayStatus] ?? displayStatus;
}

// ─────────────────────────────────────────────
// 6. 状态样式语义 (tone)
// ─────────────────────────────────────────────

export type StatusTone = 'gray' | 'blue' | 'green' | 'orange-moving' | 'yellow' | 'orange' | 'red';

const STATUS_TONES: Record<DisplayStatus, StatusTone> = {
  offline: 'gray',
  opening: 'blue', process_started: 'blue', cdp_connecting: 'blue', cdp_connected: 'blue',
  login_checking: 'yellow', login_required: 'yellow',
  p0_checking: 'yellow', popup_cleaning: 'yellow', ready_checking: 'yellow',
  ready: 'green',
  busy: 'orange-moving',
  closing: 'gray', closed: 'gray',
  failed: 'red',
  initializing: 'blue', connecting: 'blue',
  degraded: 'orange',
  restarting: 'blue',
  starting: 'blue',
};

export function getWindowStatusTone(displayStatus: DisplayStatus): StatusTone {
  return STATUS_TONES[displayStatus] ?? 'gray';
}

// ─────────────────────────────────────────────
// 7. 可选择 / 可关闭判断 (M5-2 extended)
// ─────────────────────────────────────────────

export function canSelectAsExecutionWindow(displayStatus: DisplayStatus): boolean {
  return displayStatus === 'ready';
}

export function canCloseWindow(displayStatus: DisplayStatus): boolean {
  switch (displayStatus) {
    case 'ready': case 'login_required': case 'degraded': case 'failed':
    case 'closed': case 'closing':
      return true;
    case 'busy': case 'initializing': case 'connecting':
    case 'opening': case 'process_started': case 'cdp_connecting': case 'cdp_connected':
    case 'login_checking': case 'p0_checking': case 'popup_cleaning': case 'ready_checking':
      return false;
    case 'offline': return false;
    default: return false;
  }
}

// ─────────────────────────────────────────────
// 8. 执行节点 Badge / Card / Text
// ─────────────────────────────────────────────

export interface NodeBadge { cls: string; label: string; }

export function getNodeBadge(displayStatus: DisplayStatus): NodeBadge {
  switch (displayStatus) {
    case 'ready': return { cls: 'ready', label: 'READY' };
    case 'login_required': return { cls: 'login-req', label: 'LOGIN' };
    // M5-2C: All intermediate startup states → INIT (not default/OFF)
    case 'connecting': case 'cdp_connecting': case 'cdp_connected':
    case 'opening': case 'process_started':
    case 'login_checking': case 'p0_checking':
    case 'popup_cleaning': case 'ready_checking':
    case 'initializing': return { cls: 'connected', label: 'INIT' };
    case 'busy': return { cls: 'busy', label: 'BUSY' };
    case 'degraded': case 'failed': return { cls: 'busy', label: 'FAIL' };
    case 'closing': case 'closed': return { cls: 'offline-s', label: 'OFF' };
    case 'offline': default: return { cls: 'offline-s', label: 'OFF' };
  }
}

export function getNodeCardClass(displayStatus: DisplayStatus, isSel: boolean): string {
  const classes = ['node-card'];
  if (isSel) classes.push('selected');
  if (displayStatus === 'offline' || displayStatus === 'closed' || displayStatus === 'closing') classes.push('offline-card');
  if (displayStatus === 'busy') classes.push('busy-card');
  if (displayStatus === 'degraded') classes.push('busy-card');
  if (displayStatus === 'failed') classes.push('busy-card');
  if (displayStatus === 'login_required') classes.push('login-required-card');
  return classes.join(' ');
}

export function getNodeStatusText(displayStatus: DisplayStatus): string {
  switch (displayStatus) {
    case 'ready': return '点击选择';
    case 'login_required': return '待登录';
    case 'connecting': case 'cdp_connecting': case 'cdp_connected':
    case 'opening': case 'process_started':
    case 'initializing': return '启动中...';
    case 'login_checking': case 'p0_checking':
    case 'popup_cleaning': case 'ready_checking': return '就绪检查中...';
    case 'busy': return '执行中';
    case 'degraded': return '不稳定';
    case 'failed': return '失败';
    case 'closing': return '关闭中...';
    case 'closed': case 'offline': default: return '离线';
  }
}
