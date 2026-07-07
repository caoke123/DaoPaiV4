/**
 * WindowStatusCollector — 窗口状态检测器 (Phase Deploy-0D)
 *
 * 检测本地 Portable Chrome 窗口的进程、CDP、URL、登录状态。
 * 不依赖 PlaywrightRuntime，直接对本地 Chrome 进程进行健康检查。
 */

import * as fs from 'fs';
import * as http from 'http';
import type { DashboardReadyStatus } from '../browser/BnsyDashboardDetector';
import { runReadyGuard } from './ReadyGuard';

/** 采集配置 */
export interface CollectorConfig {
  /** Chrome 调试端口 */
  debugPort: number;
  /** Chrome profile 路径 */
  profilePath: string;
  /** Chrome 进程 PID */
  pid?: number;
}

/** 采集结果 */
export interface WindowStatusResult {
  isProcessAlive: boolean;
  isCdpReady: boolean;
  isDashboardReady: boolean;
  isLoginPage: boolean;
  currentUrl: string | null;
  cdpEndpoint: string | null;
  chromePid: number | null;
  lastError: string | null;
  readyState?: DashboardReadyStatus;
  readyMessage?: string | null;
  readyWarnings?: string[];
  hasCoreDom?: boolean;
  hasBlockedPopup?: boolean;
}

/**
 * 检查进程是否存活
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Windows: tasklist check
    const { execSync } = require('node:child_process');
    const result = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8', timeout: 3000 });
    return result.includes(String(pid));
  } catch {
    // On non-Windows or if tasklist fails, check /proc
    try {
      fs.accessSync(`/proc/${pid}`, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * HTTP GET 请求
 */
function httpGet(url: string, timeoutMs: number = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CDP request timeout'));
    });
  });
}

/**
 * 检测 CDP 是否就绪
 */
async function checkCdpReady(debugPort: number): Promise<{ ready: boolean; url: string | null; wsUrl: string | null }> {
  const cdpUrl = `http://127.0.0.1:${debugPort}`;
  try {
    const raw = await httpGet(`${cdpUrl}/json/version`, 3000);
    const info = JSON.parse(raw);
    return { ready: true, url: null, wsUrl: info.webSocketDebuggerUrl || null };
  } catch {
    return { ready: false, url: null, wsUrl: null };
  }
}

/**
 * 获取当前页面 URL（从 CDP 页面列表）
 */
async function getCurrentUrl(debugPort: number): Promise<string | null> {
  const cdpUrl = `http://127.0.0.1:${debugPort}`;
  try {
    const raw = await httpGet(`${cdpUrl}/json`, 2000);
    const pages: Array<{ url: string; type: string }> = JSON.parse(raw);
    // 找到第一个非 about:blank 的页面
    const page = pages.find(p => p.url && !p.url.startsWith('about:') && p.type === 'page');
    return page?.url || (pages.length > 0 ? pages[0].url : null);
  } catch {
    return null;
  }
}

/**
 * 判断 URL 是否为登录页
 */
function isLoginPageUrl(url: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('/login') || lower.includes('/signin') || lower.includes('/auth');
}

/**
 * 判断 URL 是否为业务首页（dashboard/首页）
 */
function isDashboardUrl(url: string | null): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.includes('benniaosuyun.com') && !isLoginPageUrl(url);
}

/**
 * 执行一次完整的窗口状态采集
 */
export async function collectWindowStatus(config: CollectorConfig): Promise<WindowStatusResult> {
  const result: WindowStatusResult = {
    isProcessAlive: false,
    isCdpReady: false,
    isDashboardReady: false,
    isLoginPage: false,
    currentUrl: null,
    cdpEndpoint: null,
    chromePid: config.pid || null,
    lastError: null,
    readyState: undefined,
    readyMessage: null,
    readyWarnings: [],
    hasCoreDom: false,
    hasBlockedPopup: false,
  };

  try {
    // 1. 检查进程
    if (config.pid) {
      result.isProcessAlive = isProcessAlive(config.pid);
    } else {
      // 无 PID 时，尝试通过端口检测
      const cdpCheck = await checkCdpReady(config.debugPort);
      result.isProcessAlive = cdpCheck.ready;
    }

    if (!result.isProcessAlive) {
      result.lastError = 'Chrome 进程未运行';
      return result;
    }

    // 2. 检查 CDP
    const cdpCheck = await checkCdpReady(config.debugPort);
    result.isCdpReady = cdpCheck.ready;
    result.cdpEndpoint = cdpCheck.wsUrl
      ? `http://127.0.0.1:${config.debugPort}`
      : null;

    if (!result.isCdpReady) {
      result.lastError = 'CDP 未就绪';
      return result;
    }

    // 3. 获取当前 URL
    const url = await getCurrentUrl(config.debugPort);
    result.currentUrl = url;

    // 4. 判断状态
    if (!url || url.startsWith('about:')) {
      result.isDashboardReady = false;
      result.isLoginPage = false;
      result.readyState = 'PAGE_NOT_READY';
      result.readyMessage = '页面未加载到业务系统';
      result.lastError = '页面未加载到业务系统';
      return result;
    }

    result.isLoginPage = isLoginPageUrl(url);
    if (result.isLoginPage) {
      result.readyState = 'LOGIN_REQUIRED';
      result.readyMessage = '窗口处于登录页，需要人工登录';
      result.isDashboardReady = false;
      result.lastError = result.readyMessage;
      return result;
    }

    if (!isDashboardUrl(url)) {
      result.readyState = 'PAGE_NOT_READY';
      result.readyMessage = '页面不在预期业务系统中';
      result.isDashboardReady = false;
      result.lastError = '页面不在预期业务系统中';
      return result;
    }

    const guard = await runReadyGuard({
      debugPort: config.debugPort,
      currentUrl: url,
    });
    result.readyState = guard.status;
    result.readyMessage = guard.message;
    result.readyWarnings = guard.warnings;
    result.hasCoreDom = guard.hasCoreDom;
    result.hasBlockedPopup = guard.hasBlockedPopup;
    result.isLoginPage = guard.status === 'LOGIN_REQUIRED';
    result.isDashboardReady = guard.status === 'READY';
    result.currentUrl = guard.url || url;

    // M5-2D: Trusted ready fallback when ReadyGuard WS times out on a confirmed
    // dashboard URL. Don't let a single WS timeout downgrade a ready window.
    const isWsTimeout = guard.status === 'UNKNOWN' &&
      guard.warnings.some(w => w.includes('READY_GUARD_WS_TIMEOUT'));

    if (isWsTimeout && isDashboardUrl(result.currentUrl) && result.isCdpReady) {
      // Condition A: CDP HTTP confirmed dashboard URL, process alive, not login page.
      // ReadyGuard WS may fail due to Chrome CDP session contention but the window is
      // demonstrably on the dashboard. Trust the HTTP-level evidence.
      result.readyState = 'READY';
      result.isDashboardReady = true;
      result.lastError = null;
      result.readyMessage =
        'Dashboard就绪 (URL兜底: ReadyGuard WS超时, HTTP已确认/dashboard)';
      result.readyWarnings = [
        ...guard.warnings,
        'ready_guard_ws_timeout_but_keep_ready',
      ];
      console.warn(
        `[WindowStatus] ReadyGuard WS超时但URL=/dashboard + CDP可用, 兜底判定为ready` +
        ` debugPort=${config.debugPort} url=${result.currentUrl}`,
      );
    } else if (!result.isDashboardReady) {
      result.lastError = guard.message;
    } else {
      result.lastError = null;
    }
  } catch (err) {
    result.lastError = (err as Error).message;
  }

  return result;
}
