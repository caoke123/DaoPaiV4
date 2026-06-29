// window-status.ts — 统一前端窗口状态 Helper（Phase 4-I-1）
// 职责：
//   1. 统一计算 displayStatus（Header 与执行节点共用）
//   2. 统一判断是否 really ready（P0 守卫，不放宽）
//   3. 统一判断是否可选择执行 / 是否可关闭
//   4. 统一返回状态文案和样式语义
//
// 核心原则：
//   - 后端终态优先：ready/busy/login_required/degraded/failed 不能被前端临时态覆盖
//   - 前端临时态（initializing）只覆盖 offline/connecting/connected
//   - READY 不能伪造：必须来自后端 + 通过 P0 守卫

import type {
  SiteWindowState,
  PlaywrightSiteWindowState,
} from '../api/client';

// ─────────────────────────────────────────────
// 1. 统一 displayStatus 枚举
// ─────────────────────────────────────────────

export type DisplayStatus =
  | 'offline'
  | 'initializing'
  | 'connecting'
  | 'ready'
  | 'busy'
  | 'login_required'
  | 'degraded'
  | 'failed';

// ─────────────────────────────────────────────
// 2. 窗口唯一 Key
// ─────────────────────────────────────────────

/**
 * 生成窗口统一 key：siteId + ":" + employeeName
 * 用于前端本地状态（initializingTasks 等）的索引。
 * Phase 4-I-1 暂兼容旧 windowName key，后续阶段收敛到此规则。
 */
export function getWindowKey(siteId: string, employeeName: string): string {
  return `${siteId}:${employeeName}`;
}

// ─────────────────────────────────────────────
// 3. READY 守卫（从 Header.tsx 迁移，不放宽）
// ─────────────────────────────────────────────

/**
 * Playwright 模式下的真实 READY 判断（10 项条件收严）。
 * 直接迁移自 Header.tsx L28-38，未做任何放宽。
 *
 * 条件：
 *   1. status === 'ready'
 *   2. p0Passed === true
 *   3. pageCount === 1
 *   4. url 非空
 *   5. url !== 'about:blank'
 *   6. url 包含 'bnsy.benniaosuyun.com'
 *   7. url 不包含 '/login'
 */
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

export interface WindowDisplayOptions {
  /** 是否为 playwright 模式（影响 P0 守卫降级） */
  isPlaywright: boolean;
  /** 该窗口是否处于前端本地 initializing 标记中（用户刚点击启动） */
  isInitializing: boolean;
}

/**
 * 统一计算窗口的 displayStatus。
 *
 * 优先级：
 *   1. busy — 最高，执行中禁止任何覆盖
 *   2. 后端终态（ready/login_required/failed/degraded）— initializing 不覆盖
 *      - ready 经 isPlaywrightReallyReady 守卫，未通过降级为 degraded/login_required
 *   3. initializing — 仅在后端为过渡态（offline/connecting/connected）时生效
 *   4. connecting / connected → connecting
 *   5. offline
 */
export function getWindowDisplayStatus(
  w: SiteWindowState,
  options: WindowDisplayOptions,
): DisplayStatus {
  const { isPlaywright, isInitializing } = options;

  // 1. busy 最高优先级 — 执行中不允许任何覆盖
  if (w.status === 'busy') return 'busy';

  // 2. 后端终态优先 — initializing 仅在后端为过渡态时生效
  const backendTerminal =
    w.status === 'ready' ||
    w.status === 'login_required' ||
    w.status === 'failed' ||
    w.status === 'degraded';

  if (isInitializing && !backendTerminal) {
    return 'initializing';
  }

  // 3. 后端 ready → P0 守卫降级检查
  if (w.status === 'ready') {
    if (isPlaywright) {
      const pw = w as PlaywrightSiteWindowState;
      if (!isPlaywrightReallyReady(pw)) {
        const url = pw.currentUrl ?? pw.activePageUrl ?? '';
        if (url.includes('/login') || pw.p0FailedCheck === 'url_login') {
          return 'login_required';
        }
        return 'degraded';
      }
    }
    return 'ready';
  }

  // 4. connecting / connected → connecting（统一显示）
  if (w.status === 'connecting' || w.status === 'connected') {
    return 'connecting';
  }

  // 5. login_required / degraded / failed 原样返回
  if (w.status === 'login_required') return 'login_required';
  if (w.status === 'degraded') return 'degraded';
  if (w.status === 'failed') return 'failed';

  // 6. offline
  return 'offline';
}

// ─────────────────────────────────────────────
// 5. 可选择 / 可关闭判断
// ─────────────────────────────────────────────

/**
 * 是否可选择为执行窗口。
 * 只允许 ready 状态被选择，其他状态一律 false。
 */
export function canSelectAsExecutionWindow(displayStatus: DisplayStatus): boolean {
  return displayStatus === 'ready';
}

/**
 * 是否可关闭窗口。
 * 允许：ready / login_required / degraded / failed
 * 不允许：busy / initializing / connecting
 * offline 可不显示关闭按钮（由调用方判断）。
 */
export function canCloseWindow(displayStatus: DisplayStatus): boolean {
  switch (displayStatus) {
    case 'ready':
    case 'login_required':
    case 'degraded':
    case 'failed':
      return true;
    case 'busy':
    case 'initializing':
    case 'connecting':
      return false;
    case 'offline':
      return false;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────
// 6. 状态文案
// ─────────────────────────────────────────────

const STATUS_LABELS: Record<DisplayStatus, string> = {
  offline: '离线',
  initializing: '启动中',
  connecting: '启动中',
  ready: '就绪',
  busy: '执行中',
  login_required: '待登录',
  degraded: '不稳定',
  failed: '失败',
};

/**
 * 返回状态的中文文案。
 */
export function getWindowStatusLabel(displayStatus: DisplayStatus): string {
  return STATUS_LABELS[displayStatus] ?? displayStatus;
}

// ─────────────────────────────────────────────
// 7. 状态样式语义
// ─────────────────────────────────────────────

export type StatusTone =
  | 'gray'
  | 'blue'
  | 'green'
  | 'orange-moving'
  | 'yellow'
  | 'orange'
  | 'red';

const STATUS_TONES: Record<DisplayStatus, StatusTone> = {
  offline: 'gray',
  initializing: 'blue',
  connecting: 'blue',
  ready: 'green',
  busy: 'orange-moving',
  login_required: 'yellow',
  degraded: 'orange',
  failed: 'red',
};

/**
 * 返回状态的样式语义 tone。
 * 调用方根据 tone 映射到具体 CSS class。
 */
export function getWindowStatusTone(displayStatus: DisplayStatus): StatusTone {
  return STATUS_TONES[displayStatus] ?? 'gray';
}

// ─────────────────────────────────────────────
// 8. 执行节点 Badge 映射（简短英文标签）
// ─────────────────────────────────────────────

export interface NodeBadge {
  cls: string;
  label: string;
}

/**
 * 执行节点卡片的状态 Badge 映射。
 * 语义与 Header 一致，标签用简短英文。
 */
export function getNodeBadge(displayStatus: DisplayStatus): NodeBadge {
  switch (displayStatus) {
    case 'ready':
      return { cls: 'ready', label: 'READY' };
    case 'login_required':
      return { cls: 'login-req', label: 'LOGIN' };
    case 'connecting':
      return { cls: 'connected', label: 'INIT' };
    case 'initializing':
      return { cls: 'connected', label: 'INIT' };
    case 'busy':
      return { cls: 'busy', label: 'BUSY' };
    case 'degraded':
      return { cls: 'busy', label: 'WARN' };
    case 'failed':
      return { cls: 'busy', label: 'FAIL' };
    case 'offline':
    default:
      return { cls: 'offline-s', label: 'OFF' };
  }
}

/**
 * 执行节点卡片的 CSS class（用于 node-card 状态修饰）。
 */
export function getNodeCardClass(displayStatus: DisplayStatus, isSel: boolean): string {
  const classes = ['node-card'];
  if (isSel) classes.push('selected');
  if (displayStatus === 'offline') classes.push('offline-card');
  if (displayStatus === 'busy') classes.push('busy-card');
  if (displayStatus === 'degraded') classes.push('busy-card');
  if (displayStatus === 'failed') classes.push('busy-card');
  if (displayStatus === 'login_required') classes.push('login-required-card');
  return classes.join(' ');
}

/**
 * 执行节点卡片底部的状态文案（非选中状态）。
 * 选中状态的文案由调用方自行渲染（含 alloc 数量和样式）。
 */
export function getNodeStatusText(displayStatus: DisplayStatus): string {
  switch (displayStatus) {
    case 'ready':
      return '点击选择';
    case 'login_required':
      return '待登录';
    case 'connecting':
    case 'initializing':
      return '启动中...';
    case 'busy':
      return '执行中';
    case 'degraded':
      return '不稳定';
    case 'failed':
      return '失败';
    case 'offline':
    default:
      return '离线';
  }
}
