/**
 * LocalWindowRuntime — 本地窗口运行时 (Phase Deploy-0D / Fix-2)
 *
 * 负责在 Agent 本地执行窗口命令：
 *   - open_window: 启动便携 Chrome + 自动登录 + P0 检测 + 弹窗清理 + READY 判断
 *   - close_window: 按 windowId 精准关闭指定窗口
 *   - restart_window: 关闭 + 重新打开
 *   - refresh_status: 检测当前状态
 *
 * Fix-2 (R3) 新增：
 *   - onPhase 回调 — 阶段式状态上报（starting / logging_in / ready）
 *   - 复用 ensureBnsyLoggedIn 完成登录 + P0 + 弹窗清理
 *   - 耗时日志输出关键节点耗时
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserManager } from '../browser/BrowserManager';
import {
  waitForProcessExit,
} from '../browser/ChromeProcessGuard';
import { collectWindowStatus, type WindowStatusResult } from './WindowStatusCollector';
import { getConfig, getLocalRoot } from '../config';
import { getChromeKind } from '../config';
import { AgentSettingsLoader } from '../AgentSettingsLoader';
import {
  registerWindow,
  unregisterWindow,
  findWindow,
  type WindowRegistryEntry,
} from './LocalWindowRegistry';
import { isWindowBusy as readWindowBusy } from './WindowBusyRegistry';
import type { BrowserConfig } from '../types';
import { logTrace, warnTrace } from '../trace';

/** 窗口运行时配置 */
export interface LocalWindowConfig {
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
  /** M5-2A: 关联的上层命令 ID，用于 trace 关联 */
  commandId?: string;
}

/** 窗口执行结果 */
export interface LocalWindowResult {
  success: boolean;
  cdpEndpoint?: string;
  profilePath?: string;
  chromePid?: number;
  debugPort?: number;
  error?: string;
  /** 标记是否需要人工登录 */
  loginRequired?: boolean;
  /** 标记 Dashboard 是否就绪 */
  isDashboardReady?: boolean;
}

/** 窗口状态信息 */
export interface WindowStateInfo {
  isReady: boolean;
  isBusy: boolean;
  cdpEndpoint?: string;
}

/**
 * 窗口生命周期阶段 (M5-2: 扩展为粒度化分段上报)
 * backward compat: 'starting' → opening, 'logging_in' → login_checking, 'error' → failed
 */
export type WindowPhase =
  | 'opening' | 'process_started' | 'cdp_connecting' | 'cdp_connected'
  | 'login_checking' | 'p0_checking' | 'popup_cleaning'
  | 'login_required' | 'ready_checking' | 'ready' | 'failed'
  | 'starting' | 'logging_in' | 'error'; // backward compat aliases

/** 阶段回调 */
export type WindowPhaseCallback = (phase: WindowPhase, detail: string) => void;

/**
 * 计算窗口的 profile 路径
 * 格式: {localRoot}/profiles/{tenantId}/{siteId}/{windowId}
 */
function computeProfilePath(config: LocalWindowConfig): string {
  const localRoot = getLocalRoot();
  return path.resolve(localRoot, 'profiles', config.tenantId, config.siteId, config.windowId);
}

/**
 * 计算 Chrome 可执行文件路径
 */
function computeChromePath(): string {
  let resolvedPath: string;
  let resolvedKind: string;
  try {
    const cfg = getConfig();
    if (cfg.browser?.executablePath && fs.existsSync(cfg.browser.executablePath)) {
      resolvedPath = cfg.browser.executablePath;
      resolvedKind = getChromeKind(cfg.browser.executablePath);
    } else {
      resolvedPath = path.resolve(getLocalRoot(), 'Chrome', 'App', 'chrome.exe');
      resolvedKind = getChromeKind(resolvedPath);
    }
  } catch {
    resolvedPath = path.resolve(getLocalRoot(), 'Chrome', 'App', 'chrome.exe');
    resolvedKind = getChromeKind(resolvedPath);
  }
  console.log(`[LocalWindowRuntime] chromePath=${resolvedPath} chromeKind=${resolvedKind}`);
  logTrace('window-runtime', 'chrome_path_resolved', {
    chromePath: resolvedPath, chromeKind: resolvedKind,
  });
  return resolvedPath;
}

/**
 * 计算窗口的 debug 端口
 */
function computeDebugPort(windowId: string): number {
  const basePort = 31000;
  let hash = 0;
  for (let i = 0; i < windowId.length; i++) {
    hash = ((hash << 5) - hash) + windowId.charCodeAt(i);
    hash |= 0;
  }
  return basePort + (Math.abs(hash) % 100);
}

/**
 * 检查窗口是否 busy
 */
export function isWindowBusy(windowId: string): { busy: boolean; reason?: string } {
  return readWindowBusy(windowId);
}

/**
 * 执行 open_window 命令 (Fix-2 R3: 阶段式上报 + P0 检测 + 弹窗清理)
 *
 * 流程：
 *   1. 计算路径 → 校验 chrome.exe
 *   2. 启动 Chrome → onPhase('starting')
 *   3. 连接 CDP → 导航到 BNSY
 *   4. 获取凭据 → 调用 ensureBnsyLoggedIn（含登录 + P0 + 弹窗清理）
 *   5. 上报最终状态
 */
export async function executeOpenWindow(
  config: LocalWindowConfig,
  onPhase?: WindowPhaseCallback,
): Promise<LocalWindowResult> {
  const profilePath = computeProfilePath(config);
  const chromePath = computeChromePath();
  const debugPort = computeDebugPort(config.windowId);

  const tTotal = Date.now();
  logTrace('window-runtime', 'open_start', {
    tenantId: config.tenantId,
    siteId: config.siteId,
    workstationId: config.workstationId,
    windowId: config.windowId,
    staffName: config.staffName,
    commandId: config.commandId,
    debugPort,
  });

  console.log(`[LocalRuntime] open_window: tenantId=${config.tenantId} siteId=${config.siteId} windowId=${config.windowId}`);
  console.log(`[LocalRuntime]   chromePath=${chromePath}`);
  console.log(`[LocalRuntime]   profilePath=${profilePath}`);
  console.log(`[LocalRuntime]   debugPort=${debugPort}`);

  // 检查 chrome.exe
  if (!fs.existsSync(chromePath)) {
    return {
      success: false, debugPort, profilePath,
      error: `Portable Chrome 未找到: ${chromePath}`,
    };
  }

  // 确保 profile 目录
  if (!fs.existsSync(profilePath)) {
    fs.mkdirSync(profilePath, { recursive: true });
  }

  const browserConfig: BrowserConfig = {
    executablePath: chromePath,
    userDataDir: profilePath,
    debugPort,
    headless: false,
  };

  const manager = new BrowserManager(browserConfig);

  try {
    // ── Phase 1: 启动 Chrome ──
    onPhase?.('opening', '正在启动');
    const tChromeSpawn = Date.now();
    logTrace('window-runtime', 'open_chrome_spawn_start', {
      windowId: config.windowId, commandId: config.commandId, debugPort,
    });
    await manager.start();
    const chromeSpawnMs = Date.now() - tChromeSpawn;
    console.log(`[LocalRuntime]   ⏱ Chrome spawn 耗时: ${chromeSpawnMs}ms (进程已 fork)`);
    onPhase?.('process_started', 'Chrome 已启动');
    logTrace('window-runtime', 'open_chrome_spawned', {
      windowId: config.windowId, commandId: config.commandId,
      chromeSpawnMs,
      debugPort,
    });

    // ── Phase 2: 连接 CDP ──
    // M5-2A: cdpMs 包含 Chrome 进程启动 + 端口监听就绪 + Playwright connectOverCDP
    // 实际 Chrome 启动耗时 = cdpMs（因为 waitForCdp 等待 /json/version 可响应）
    onPhase?.('cdp_connecting', '正在连接 CDP');
    logTrace('window-runtime', 'open_cdp_wait_start', {
      windowId: config.windowId, commandId: config.commandId, debugPort,
      chromeSpawnMs,
    });
    const tCdp = Date.now();
    await manager.connect();
    const cdpMs = Date.now() - tCdp;
    // totalFromSpawn = chromeSpawnMs + cdpMs，其中 cdpMs 含 Chrome 进程启动 + CDP 握手
    console.log(`[LocalRuntime]   ⏱ CDP 就绪总耗时: ${cdpMs}ms (含 Chrome 启动 + 端口等待 + CDP 握手)`);
    onPhase?.('cdp_connected', 'CDP 已连接');
    logTrace('window-runtime', 'open_cdp_connected', {
      windowId: config.windowId, commandId: config.commandId,
      cdpMs,
      chromeSpawnMs,
      totalFromSpawnMs: chromeSpawnMs + cdpMs,
      debugPort,
    });

    // ── Phase 3: 导航到 BNSY ──
    const targetUrl = process.env.DAOPAI_TARGET_DASHBOARD || 'https://bnsy.benniaosuyun.com/';
    try {
      await manager.openPage(targetUrl);
      console.log(`[LocalRuntime]   导航到: ${targetUrl}`);
    } catch (navErr) {
      console.warn(`[LocalRuntime]   导航到首页时出现问题: ${(navErr as Error).message}`);
    }

    // 等待页面可交互（替代固定 3s 等待）
    try {
      const page = manager.getPage();
      if (page) {
        // 等待 body 或登录表单渲染完成
        await page.waitForSelector('body', { timeout: 8000 });
        // P14-Fix: 减半 SPA 初始化等待（800ms→300ms），浏览器默认页面已就绪
        await new Promise(r => setTimeout(r, 300));
      } else {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch {
      console.warn('[LocalRuntime]   页面加载等待超时，继续流程');
    }

    // ── Phase 4: 获取凭据并执行自动登录 ──
    let loginRequired = false;
    let isDashboardReady = false;

    try {
      const settingsLoader = new AgentSettingsLoader();
      const credential = await settingsLoader.getLoginCredentialForStaff(
        config.siteId,
        config.staffName,
      );

      if (credential) {
        console.log(`[LocalRuntime]   找到凭据: account=${credential.loginAccount} employee=${credential.employeeName}`);
        console.log(`[LocalRuntime]   密码: 已脱敏`);

        onPhase?.('login_checking', '正在自动登录');
        logTrace('window-runtime', 'open_login_start', {
          windowId: config.windowId, commandId: config.commandId,
          staffName: config.staffName,
        });

        // 动态导入 ensureBnsyLoggedIn（含登录 + P0 + 弹窗清理全流程）
        const { ensureBnsyLoggedIn } =
          await import('../browser/BnsySessionManager');

        const page = manager.getPage();
        if (page) {
          const tLogin = Date.now();
          const sessionResult = await ensureBnsyLoggedIn(page, credential);
          const loginMs = Date.now() - tLogin;
          console.log(`[LocalRuntime]   ⏱ 登录+P0 总耗时: ${loginMs}ms`);
          console.log(`[LocalRuntime]   登录结果: success=${sessionResult.success} status=${sessionResult.dashboard.status} message=${sessionResult.message}`);
          logTrace('window-runtime', 'open_login_result', {
            windowId: config.windowId, commandId: config.commandId,
            staffName: config.staffName,
            loginMs,
            success: sessionResult.success,
            dashboardStatus: sessionResult.dashboard.status,
          });

          if (sessionResult.success && sessionResult.dashboard.status === 'READY') {
            console.log(`[LocalRuntime]   Dashboard 就绪，可执行任务`);
            isDashboardReady = true;
            // M5-2C: 不在 login flow 中立即发布 ready — 等 popup_cleaning + ready_checking
            // 完成后再统一发布最终状态（见下方最终状态判定区）
          } else {
            console.warn(`[LocalRuntime]   Dashboard 未就绪: ${sessionResult.dashboard.status} - ${sessionResult.message}`);
            loginRequired = sessionResult.dashboard.status === 'LOGIN_REQUIRED' || sessionResult.dashboard.status === 'LOGIN_FAILED';
            if (loginRequired) {
              onPhase?.('login_required', '待登录');
            } else if (sessionResult.dashboard.status === 'BLOCKED_POPUP') {
              onPhase?.('login_required', '弹窗阻塞，待手动处理');
              loginRequired = true;
            } else {
              onPhase?.('starting', '等待页面就绪');
            }
          }
        } else {
          console.warn(`[LocalRuntime]   page 不可用，跳过登录`);
          loginRequired = true;
        }
      } else {
        console.warn(`[LocalRuntime]   未找到员工 ${config.staffName} 的登录凭据`);
        loginRequired = true;
      }
    } catch (loginErr) {
      const loginMsg = (loginErr as Error).message;
      const safeMsg = loginMsg.includes('password') || loginMsg.includes('密码')
        ? '登录操作异常（已脱敏）'
        : loginMsg;
      console.error(`[LocalRuntime]   自动登录异常: ${safeMsg}`);
      loginRequired = true;
      // 不设 onPhase error — 这仍然是可恢复的 login_required
    }

    // ── Phase 5: 最终状态检测 ──
    onPhase?.('popup_cleaning', '清理弹窗');
    // P15-Fix: 状态检测前尝试清理弹窗（登录后可能出现）
    try {
      const page = manager.getPage();
      if (page) {
        const { cleanBlockingPopups } = await import('../browser/BnsySessionManager');
        const tPopup = Date.now();
        const cleanResult = await cleanBlockingPopups(page);
        logTrace('window-runtime', 'open_popup_cleanup_done', {
          windowId: config.windowId, commandId: config.commandId,
          cleaned: cleanResult.cleaned,
          actionCount: cleanResult.actions.length,
          durationMs: Date.now() - tPopup,
        });
        if (cleanResult.cleaned) {
          console.log(`[LocalRuntime]   弹窗清理: ${cleanResult.actions.join('; ')}`);
        }
      }
    } catch {}

    onPhase?.('ready_checking', '检查页面状态');
    const tReadyGuard = Date.now();
    const finalStatus = await collectWindowStatus({ debugPort, profilePath, pid: manager.getPid() ?? undefined });
    logTrace('window-runtime', 'open_ready_guard_done', {
      windowId: config.windowId, commandId: config.commandId,
      isDashboardReady: finalStatus.isDashboardReady,
      isLoginPage: finalStatus.isLoginPage,
      durationMs: Date.now() - tReadyGuard,
    });
    if (!isDashboardReady && finalStatus.isDashboardReady && !finalStatus.isLoginPage) {
      isDashboardReady = true;
    }

    // M5-2C: 最终状态判定 — ready 必须是启动成功链路的最后一个状态。
    // 所有中间阶段（popup_cleaning / ready_checking）完成后才发布最终状态，
    // 确保 SSE 顺序为 opening → ... → popup_cleaning → ready_checking → ready
    if (isDashboardReady) {
      onPhase?.('ready', '就绪');
    } else if (loginRequired) {
      onPhase?.('login_required', '待登录');
    } else {
      onPhase?.('failed', 'Dashboard 未就绪');
    }

    // ── 注册到本地 registry ──
    // Fix-2 R3: 直接从 BrowserManager 获取真实 PID，不依赖 session 文件
    const chromePid = manager.getPid() || finalStatus.chromePid || undefined;
    const cdpEndpoint = finalStatus.cdpEndpoint || `http://127.0.0.1:${debugPort}`;

    // P3-Fix: 无 PID 时也注册窗口，至少保存 cdpEndpoint/debugPort/profilePath
    // 避免后续关窗走昂贵的 WMI 进程扫描路径
    registerWindow({
      tenantId: config.tenantId, siteId: config.siteId,
      workstationId: config.workstationId, windowId: config.windowId,
      staffName: config.staffName, chromePid: chromePid || null, cdpEndpoint,
      debugPort, profilePath, launchedAt: Date.now(),
    });

    const totalMs = Date.now() - tTotal;
    console.log(`[LocalRuntime]   ⏱ 总耗时: ${totalMs}ms (spawn=${chromeSpawnMs}ms CDP=${cdpMs}ms)`);
    logTrace('window-runtime', 'open_done', {
      tenantId: config.tenantId,
      siteId: config.siteId,
      windowId: config.windowId,
      staffName: config.staffName,
      commandId: config.commandId,
      totalMs,
      chromeSpawnMs,
      cdpMs,
      loginRequired,
      isDashboardReady,
      chromePid: chromePid || undefined,
    });

    return {
      success: true,
      cdpEndpoint, profilePath, chromePid, debugPort,
      loginRequired,
      isDashboardReady,
      error: isDashboardReady ? undefined : (loginRequired ? '需要登录' : 'Dashboard 未就绪'),
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[LocalRuntime] open_window 失败 (${Date.now() - tTotal}ms): ${msg}`);
    warnTrace('window-runtime', 'open_failed', {
      tenantId: config.tenantId,
      siteId: config.siteId,
      windowId: config.windowId,
      staffName: config.staffName,
      commandId: config.commandId,
      totalMs: Date.now() - tTotal,
      error: msg,
    });
    onPhase?.('error', msg);
    return {
      success: false, debugPort, profilePath, error: msg,
    };
  }
}

/**
 * 执行 close_window 命令 (Fix-2: 精准关闭)
 */
export async function executeCloseWindow(
  config: LocalWindowConfig,
  isWindowBusyCheck: boolean = false,
): Promise<LocalWindowResult> {
  const profilePath = computeProfilePath(config);
  const t0 = Date.now();
  logTrace('window-runtime', 'close_start', {
    tenantId: config.tenantId,
    siteId: config.siteId,
    windowId: config.windowId,
    staffName: config.staffName,
  });

  console.log(`[LocalRuntime] close_window: windowId=${config.windowId} staffName=${config.staffName}`);
  console.log(`[LocalRuntime]   profilePath=${profilePath}`);

  if (isWindowBusyCheck) {
    warnTrace('window-runtime', 'close_blocked_busy', {
      windowId: config.windowId,
      staffName: config.staffName,
    });
    return { success: false, profilePath, error: '当前窗口正在执行任务，不能关闭' };
  }

  // 1. 优先从 registry 查找
  const entry = findWindow(config.windowId);
  let targetPid = entry?.chromePid || null;
  let targetCdp = entry?.cdpEndpoint || null;

  console.log(`[LocalRuntime]   registry: pid=${targetPid} cdp=${targetCdp}`);

  // 2. 尝试 CDP Browser.close() — 超时 2s 即降级到 PID kill
  if (targetCdp) {
    try {
      const httpGet = (url: string, timeoutMs: number = 2000): Promise<string> =>
        new Promise((resolve, reject) => {
          const http = require('node:http');
          const req = http.get(url, { timeout: timeoutMs }, (res: any) => {
            let data = '';
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });

      console.log(`[LocalRuntime]   尝试 CDP Browser.close() (超时 2s)`);
      const versionRaw = await httpGet(`${targetCdp}/json/version`, 2000);
      const versionInfo = JSON.parse(versionRaw);
      const wsUrl = versionInfo.webSocketDebuggerUrl;

      if (wsUrl) {
        const closeId = wsUrl.split('/').pop();
        await httpGet(`${targetCdp}/json/close/${closeId}`, 2000).catch(() => {});
        // Brief wait for graceful exit, then fall through to PID kill
        await new Promise(r => setTimeout(r, 500));
        if (targetPid) {
          // P8-Fix: CDP close 后 Chrome 通常 ≤500ms 内退出，1s 兜底足够
          await waitForProcessExit(targetPid, 1000);
        }
      }
    } catch (cdpErr) {
      console.warn(`[LocalRuntime]   CDP close 失败（${(cdpErr as Error).message}），降级 PID kill`);
      warnTrace('window-runtime', 'close_cdp_fallback', {
        windowId: config.windowId,
        error: (cdpErr as Error).message,
      });
    }
  }

  // 3. 按 registry PID 精准杀进程树（taskkill /T 连子进程一起清理）
  //    不再用 findV3ChromeProcesses 扫描（避免遍历僵尸子进程浪费时间）
  if (!targetPid) {
    // M5-2D: Registry miss — window was started by a previous Agent instance or
    // the registry entry was lost. Do NOT scan globally for Chrome processes.
    // Return clear failure so the caller knows the window couldn't be closed.
    const msg = `registry missing pid/cdpEndpoint for windowId=${config.windowId}`;
    console.warn(`[LocalRuntime]   ${msg} — 禁止全局扫描 Chrome 进程`);
    logTrace('window-runtime', 'close_failed_no_registry', {
      tenantId: config.tenantId,
      siteId: config.siteId,
      windowId: config.windowId,
      staffName: config.staffName,
      error: msg,
    });
    return {
      success: false,
      profilePath,
      error: `无法关闭窗口: ${msg}。请确认 Agent 已重启后重新打开窗口。`,
    };
  }

  // 3.1 按 registry PID 精准杀进程树
  console.log(`[LocalRuntime]   关闭 Chrome 进程树 (PID: ${targetPid})`);
  try {
    const { execSync } = require('node:child_process');
    execSync(`taskkill /F /PID ${targetPid} /T`, { timeout: 5000 });
    await waitForProcessExit(targetPid, 3000);
    console.log(`[LocalRuntime]   进程树已清理 (PID: ${targetPid})`);
  } catch (err: any) {
    const msg = (err as Error).message || '';
    if (msg.includes('not found') || msg.includes('没有找到')) {
      console.log(`[LocalRuntime]   PID ${targetPid} 已不存在（已自然退出）`);
    } else {
      console.warn(`[LocalRuntime]   taskkill 警告: ${msg.split('\n')[0]}`);
    }
  }

  // 3.2 清理 profile lock 文件
  try {
    const lockFiles = [
      path.join(profilePath, 'SingletonLock'),
      path.join(profilePath, 'SingletonSocket'),
      path.join(profilePath, 'SingletonCookie'),
      path.join(profilePath, 'lockfile'),
    ];
    for (const lockFile of lockFiles) {
      try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch {}
    }
  } catch {}

  unregisterWindow(config.windowId);
  logTrace('window-runtime', 'close_done', {
    tenantId: config.tenantId,
    siteId: config.siteId,
    windowId: config.windowId,
    staffName: config.staffName,
    durationMs: Date.now() - t0,
    chromePid: targetPid || undefined,
  });

  return { success: true, profilePath, chromePid: targetPid || undefined };
}

/**
 * 执行 restart_window 命令
 */
export async function executeRestartWindow(
  config: LocalWindowConfig,
  isWindowBusyCheck: boolean = false,
): Promise<LocalWindowResult> {
  console.log(`[LocalRuntime] restart_window: windowId=${config.windowId}`);
  logTrace('window-runtime', 'restart_start', {
    tenantId: config.tenantId,
    siteId: config.siteId,
    windowId: config.windowId,
    staffName: config.staffName,
  });

  const closeResult = await executeCloseWindow(config, isWindowBusyCheck);
  if (!closeResult.success) {
    return { ...closeResult, error: `关闭窗口失败: ${closeResult.error}` };
  }

  await new Promise(r => setTimeout(r, 1000));
  return executeOpenWindow(config);
}

/**
 * 执行 refresh_status 命令
 */
export async function executeRefreshStatus(
  config: LocalWindowConfig,
): Promise<{ statusResult: WindowStatusResult } & LocalWindowResult> {
  const profilePath = computeProfilePath(config);
  const debugPort = computeDebugPort(config.windowId);

  console.log(`[LocalRuntime] refresh_status: windowId=${config.windowId} debugPort=${debugPort}`);
  logTrace('window-runtime', 'refresh_start', {
    tenantId: config.tenantId,
    siteId: config.siteId,
    windowId: config.windowId,
    staffName: config.staffName,
    debugPort,
  });

  const statusResult = await collectWindowStatus({ debugPort, profilePath });
  logTrace('window-runtime', 'refresh_done', {
    windowId: config.windowId,
    statusProcessAlive: statusResult.isProcessAlive,
    statusCdpReady: statusResult.isCdpReady,
    statusDashboardReady: statusResult.isDashboardReady,
    statusLoginPage: statusResult.isLoginPage,
  });

  return {
    success: statusResult.isProcessAlive,
    cdpEndpoint: statusResult.cdpEndpoint ?? undefined,
    profilePath, debugPort, statusResult,
    error: statusResult.lastError || undefined,
  };
}
