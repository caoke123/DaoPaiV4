/**
 * ⚠️ LEGACY 模块 — bnsy-operator-next 标记为待替换
 *
 * 本文件为从生产项目 bnsy-operator/ 复制而来的 BrowserPool 实现，
 * 内部通过 chromium.connectOverCDP() 连接 EasyBR 指纹浏览器。
 *
 * bnsy-operator-next 的架构方向是使用 Playwright 原生管理浏览器窗口
 * （chromium.launchPersistentContext()），不再依赖 EasyBR。
 *
 * Phase 1 将新增 PlaywrightRuntime 替换本模块。
 * 在替换完成前，本文件保留不删，但新增代码不得依赖此处的 EasyBR API。
 */
import { chromium, type Browser, type Page } from 'playwright';
import { EasyBRClient, type OpenedWindow } from '../easybr/EasyBRClient';
import { PopupManager } from './PopupManager';
import { PageStateManager } from './PageStateManager';
import { SessionManager } from './SessionManager';
import { DatabaseManager, type WindowInfo, type WindowRole, type Site } from '../db/Database';
import { findCredential } from '../config/credentials';
import { SettingsManager } from '../config/SettingsManager';
import { HealthMonitor, type LivenessResult, type HealthCheckTarget } from './runtime/HealthMonitor';
import { ReconnectPolicy } from './runtime/ReconnectPolicy';
import { WindowLockManager } from './WindowLockManager';
export type { LivenessResult };

const TARGET_DOMAIN = 'bnsy.benniaosuyun.com';

const TARGET_DASHBOARD = `https://${TARGET_DOMAIN}/dashboard`;

class SemaphoreTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(`信号量等待超时 (${waitedMs / 1000}s)`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export type WindowRuntimeState = 'offline' | 'connecting' | 'login_required' | 'connected' | 'ready' | 'busy' | 'degraded';

export interface WindowRuntimeStateEntry {
  windowId: string;
  state: WindowRuntimeState;
  isConnected: boolean;
  isP0Verified: boolean;
  isLoginRequired: boolean;
  isBusy: boolean;
  isConnecting: boolean;
  isDegraded: boolean;
  updatedAt: number;
}

type WindowLease = {
  windowId: string;
  taskId: string;
  staffName?: string;
  taskType?: string;
  acquiredAt: number;
  lastRenewedAt: number;
};

export interface WindowLeaseHandle {
  readonly windowId: string;
  readonly taskId: string;
  release(reason?: string): void;
  renew(): void;
}

export class SimpleSemaphore {
  private current = 0;
  private waitQueue: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly max: number) {}

  async acquire(timeoutMs: number): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex(w => w.timer === timer);
        if (idx >= 0) {
          this.waitQueue.splice(idx, 1);
        }
        reject(new SemaphoreTimeoutError(timeoutMs));
      }, timeoutMs);

      this.waitQueue.push({
        resolve: () => {
          clearTimeout(timer);
          this.current++;
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next.resolve();
    }
  }

  get queueLength(): number {
    return this.waitQueue.length;
  }

  get available(): number {
    return Math.max(0, this.max - this.current);
  }
}

interface ConnectedBrowser {
  browser: Browser;
  page: Page;
  windowInfo: WindowInfo;
}

export interface ReadyCheckResult {
  ready: boolean;
  failedCheck: string;
  reason: string;
  pageUrl?: string;
}

export interface BrowserConnection {
  page: Page;
  browser: Browser;
  windowId: string;
  windowInfo: WindowInfo;
  staffName?: string;
}

type ConnectResult = { browser: Browser; page: Page };

export class BrowserPool {
  private static instance: BrowserPool | null = null;
  private connections: Map<string, ConnectedBrowser> = new Map();
  private db: DatabaseManager;
  private reconnectPolicy: ReconnectPolicy;
  private initializing = false;
  private connectingWindows: Set<string> = new Set();
  private manuallyClosed: Set<string> = new Set();

  private openBrowerSemaphore = new SimpleSemaphore(2);
  private static readonly SEMAPHORE_TIMEOUT_MS = 60_000;

  private connectingPromises = new Map<string, Promise<ConnectResult>>();

  private p0Verified: Set<string> = new Set();
  private loginRequiredWindows: Set<string> = new Set();
  private windowBusy: Map<string, number> = new Map();
  private activeWindowLeases: Map<string, WindowLease> = new Map();

  private runtimeStates: Map<string, WindowRuntimeStateEntry> = new Map();
  private healthMonitor: HealthMonitor;

  private constructor() {
    this.db = DatabaseManager.getInstance();
    this.reconnectPolicy = new ReconnectPolicy();
    this.healthMonitor = new HealthMonitor({
      getTargets: (): HealthCheckTarget[] => {
        const targets: HealthCheckTarget[] = [];
        for (const [windowId, conn] of this.connections) {
          targets.push({ windowId, browser: conn.browser, page: conn.page, windowName: conn.windowInfo.name });
        }
        return targets;
      },
      shouldSkipCycle: () => this.initializing,
      onHealthy: (windowId: string, isLoginPage: boolean) => {
        const conn = this.connections.get(windowId);
        if (!conn) return;
        conn.windowInfo.is_connected = 1;
        conn.windowInfo.updated_at = new Date().toISOString();
        this.db.upsertWindow(conn.windowInfo);
        this.healthMonitor.clearDegraded(windowId);
        if (isLoginPage) {
          this._setLoginRequired(windowId);
        } else {
          this._clearLoginRequired(windowId);
        }
      },
      onDegraded: (windowId: string, _count: number, _error: string) => {
        this.refreshRuntimeState(windowId);
      },
      onDegradedReconnect: (windowId: string) => {
        this._resetForReconnect(windowId);
      },
      onDead: (windowId: string, _error: string) => {
        const conn = this.connections.get(windowId);
        if (!conn) return;
        console.log(`[${new Date().toISOString()}][BrowserPool]   调用 cleanupDeadConnection 执行完整清理（含 p0Verified/心跳/锁）`);
        this.cleanupDeadConnection(windowId, conn);
      },
      afterCheckCycle: async () => {
        // D-0B: V3 Playwright 模式下不再扫描 EasyBR 新窗口
        // PlaywrightRuntime 管理所有窗口生命周期，BrowserPool 仅保留 CDP 连接能力
      },
    }, TARGET_DOMAIN);
  }

  static getInstance(): BrowserPool {
    if (!BrowserPool.instance) {
      BrowserPool.instance = new BrowserPool();
    }
    return BrowserPool.instance;
  }

  getConnectedCount(): number {
    let count = 0;
    for (const state of this.runtimeStates.values()) {
      if (state.state === 'login_required' || state.state === 'connected' || state.state === 'ready' || state.state === 'busy') {
        count++;
      }
    }
    return count;
  }

  async initialize(): Promise<void> {
    if (this.initializing) {
      console.log('[BrowserPool] 初始化已在执行中，跳过');
      return;
    }
    this.initializing = true;
    try {
    console.log('[BrowserPool] 开始初始化 (EasyBR API 驱动，仅连接已打开窗口)...');
    const eb = EasyBRClient.getInstance();

    let settingsWindowNames = new Set<string>();
    try {
      const { SettingsManager } = require('../config/SettingsManager');
      const sm = SettingsManager.getInstance();
      const config = await sm.getConfig();
      if (config.initialized) {
        for (const site of config.sites) {
          for (const w of site.windows) {
            settingsWindowNames.add(w.windowName);
            if (w.employeeName) settingsWindowNames.add(w.employeeName);
          }
        }
      }
    } catch { /* SettingsManager 可能尚未初始化，跳过 */ }

    const browserConfigs = await eb.getBrowerList();
    console.log(`[BrowserPool] EasyBR 共 ${browserConfigs.size} 个浏览器配置`);

    const bnsyConfigs = new Map<string, string>();
    for (const [id, name] of browserConfigs) {
      if (settingsWindowNames.size > 0) {
        for (const sn of settingsWindowNames) {
          if (name.includes(sn) || sn.includes(name)) {
            bnsyConfigs.set(id, name);
            break;
          }
        }
      }
    }
    console.log(`[BrowserPool] 目标窗口(来自设置): ${bnsyConfigs.size} 个`);

    const openedWindows = await eb.openedList();
    const openWindows = openedWindows.filter(w => w.isopen);
    console.log(`[BrowserPool] openedList: ${openWindows.length} 个已打开窗口`);

    for (const win of openWindows) {
      const browername = browserConfigs.get(win.browerid);
      if (!browername) {
        console.warn(`[BrowserPool] browerid ${win.browerid} 未找到配置，跳过`);
        continue;
      }

      if (settingsWindowNames.size > 0) {
        let matched = false;
        for (const sn of settingsWindowNames) {
          if (browername.includes(sn) || sn.includes(browername)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          console.log(`[BrowserPool] 窗口 "${browername}" 不在设置中心配置中，跳过连接`);
          continue;
        }
      }

      const { role, site, staffName } = this.parseWindowName(browername);

      this._setConnecting(win.browerid);

      try {
        console.log(`[BrowserPool] 正在连接窗口 "${browername}"...`);
        const { browser, page } = await this.connectAndSetupWindow(win.browerid, browername);

        const windowInfo: WindowInfo = {
          id: win.browerid,
          name: browername,
          cdp_port: 0,
          role,
          site,
          staff_name: staffName,
          is_connected: 1,
          updated_at: new Date().toISOString(),
        };

        this.db.upsertWindow(windowInfo);
        this._setConnected(win.browerid, { browser, page, windowInfo });
        this.registerDisconnectHandler(win.browerid);
        SessionManager.getInstance().startHeartbeat(win.browerid, page);

        console.log(`[BrowserPool] ✓ 已连接窗口: ${browername} (${role}${staffName ? '/' + staffName : ''})`);
      } catch (e) {
        console.error(`[BrowserPool] 连接窗口 "${browername}" 失败:`, (e as Error).message);
        this.db.upsertWindow({
          id: win.browerid,
          name: browername,
          cdp_port: 0,
          role,
          site,
          staff_name: staffName,
          is_connected: 0,
          updated_at: new Date().toISOString(),
        });
        this._clearReady(win.browerid);
        this._clearLoginRequired(win.browerid);
      } finally {
        this._clearConnecting(win.browerid);
      }
    }

    console.log(`[BrowserPool] 初始化完成，已连接 ${this.connections.size} 个窗口`);

      this.syncBrowserIdsToSettings().catch((e) => {
        console.warn('[BrowserPool] syncBrowserIdsToSettings 失败:', (e as Error).message);
      });
    } catch (initErr) {
      console.error('[BrowserPool] 初始化失败:', (initErr as Error).message);
    } finally {
      this.initializing = false;
    }
  }

  private async getEasyBrBrowserList(): Promise<Map<string, string>> {
    return EasyBRClient.getInstance().getBrowerList();
  }

  async checkLiveness(conn: { browser: Browser; page: Page; windowInfo?: { name: string } }): Promise<LivenessResult> {
    return this.healthMonitor.checkLiveness({
      windowId: '',
      browser: conn.browser,
      page: conn.page,
      windowName: conn.windowInfo?.name || '',
    });
  }

  startHealthMonitor(intervalMs: number = 30000): void {
    this.healthMonitor.start(intervalMs);
  }

  stopHealthMonitor(): void {
    this.healthMonitor.stop();
  }

  private async verifyReady(windowId: string, page: Page, windowName: string): Promise<ReadyCheckResult> {
    const fail = (failedCheck: string, reason: string, pageUrl?: string): ReadyCheckResult => {
      console.warn(`[verifyReady] "${windowName}" 未通过 [${failedCheck}]: ${reason}`);
      return { ready: false, failedCheck, reason, pageUrl };
    };

    try {
      await Promise.race([
        page.evaluate(() => 1),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('evaluate_timeout')), 3000)),
      ]);
    } catch (e) {
      return fail('cdp_evaluate', `CDP页面执行失败: ${(e as Error).message}`);
    }

    let url: string;
    try {
      url = page.url();
    } catch (e) {
      return fail('url_access', `无法获取page.url(): ${(e as Error).message}`);
    }

    if (!url.includes(TARGET_DOMAIN)) {
      return fail('url_domain', `URL不在目标域名(${TARGET_DOMAIN}): ${url}`, url);
    }

    if (url.includes('/login') || url.includes('Login')) {
      this.loginRequiredWindows.add(windowId);
      this.p0Verified.delete(windowId);
      return fail('url_login', `URL仍在登录页: ${url}`, url);
    }

    this.loginRequiredWindows.delete(windowId);

    if (!url.includes('/dashboard')) {
      return fail('url_dashboard', `URL不在Dashboard页面: ${url}`, url);
    }

    let hasCoreDom = false;
    try {
      hasCoreDom = await Promise.race([
        page.evaluate(() => {
          return !!document.querySelector('.el-menu')
            || !!document.querySelector('.app-container')
            || !!document.querySelector('.sidebar');
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dom_timeout')), 3000)),
      ]);
    } catch (e) {
      return fail('dom_timeout', `核心DOM检查超时: ${(e as Error).message}`, url);
    }
    if (!hasCoreDom) {
      return fail('dom_missing', '核心业务DOM不存在（.el-menu/.app-container/.sidebar均未找到），Dashboard可能未完全加载', url);
    }

    let hasBlockingPopup = false;
    try {
      hasBlockingPopup = await Promise.race([
        page.evaluate(() => {
          const blockers = document.querySelectorAll(
            '.el-dialog__wrapper, .el-message-box__wrapper',
          );
          for (const el of Array.from(blockers)) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              return true;
            }
          }
          return false;
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('popup_check_timeout')), 3000)),
      ]);
    } catch (e) {
      console.warn(`[verifyReady] "${windowName}" 弹窗检查超时，跳过: ${(e as Error).message}`);
      hasBlockingPopup = false;
    }
    if (hasBlockingPopup) {
      return fail('popup_blocking', '存在阻塞弹窗（.el-dialog__wrapper/.el-message-box__wrapper可见）', url);
    }

    this.loginRequiredWindows.delete(windowId);
    console.log(`[verifyReady] "${windowName}" ✓ READY验证通过 (${url})`);
    return { ready: true, failedCheck: '', reason: 'ok', pageUrl: url };
  }

  private cleanupDeadConnection(windowId: string, expectedConn: ConnectedBrowser): void {
    const name = expectedConn.windowInfo.name;
    const ts = new Date().toISOString();

    if (this.connections.get(windowId) !== expectedConn) {
      console.warn(
        `[${ts}][BrowserPool] cleanupDeadConnection 跳过过期连接 (已被替换): ${name} (${windowId})`,
      );
      return;
    }

    console.log(`[${ts}][BrowserPool] 🔴 清理死连接: ${name} (${windowId})`);
    console.log(`[${ts}][BrowserPool]   清理前状态: connections=${this.connections.size} p0Verified=${this.p0Verified.size} windowBusy=${this.windowBusy.size}`);

    this.connections.delete(windowId);

    try {
      expectedConn.windowInfo.is_connected = 0;
      expectedConn.windowInfo.updated_at = new Date().toISOString();
      this.db.upsertWindow(expectedConn.windowInfo);
    } catch (e) {
      const errMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      console.warn(`[${ts}][BrowserPool] 更新 DB 状态失败 (窗口: ${name}):`, errMsg);
    }

    try {
      SessionManager.getInstance().stopHeartbeat(windowId);
    } catch (e) {
      const errMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      console.warn(`[${ts}][BrowserPool] 停止心跳失败 (窗口: ${name}):`, errMsg);
    }

    try {
      WindowLockManager.getInstance().release(windowId);
    } catch (e) {
      const errMsg = typeof e === 'object' && e !== null && 'message' in e ? (e as Error).message : String(e);
      console.warn(`[${ts}][BrowserPool] 释放窗口锁失败 (窗口: ${name}):`, errMsg);
    }

    this.p0Verified.delete(windowId);
    this.loginRequiredWindows.delete(windowId);
    this.windowBusy.delete(windowId);
    this.activeWindowLeases.delete(windowId);
    this.healthMonitor.clearDegraded(windowId);

    this.reconnectPolicy.recordDisconnect(windowId);

    console.log(`[${ts}][BrowserPool]   清理后状态: connections=${this.connections.size} p0Verified=${this.p0Verified.size} windowBusy=${this.windowBusy.size}`);
    this.refreshRuntimeState(windowId);
  }

  registerDisconnectHandler(windowId: string): void {
    const conn = this.connections.get(windowId);
    if (!conn) return;

    if ((conn as any)._disconnectRegistered) return;
    (conn as any)._disconnectRegistered = true;

    conn.browser.on('disconnected', () => {
      this.cleanupDeadConnection(windowId, conn);
    });
  }

  private async openBrowerWithRetry(browerid: string): Promise<{ ws: string; http: string }> {
    const eb = EasyBRClient.getInstance();
    const sema = this.openBrowerSemaphore;

    console.log(
      `[BrowserPool] 窗口(id:${browerid.slice(0, 8)}) 正在排队等待启动配额... (当前排队: ${sema.queueLength}, 可用: ${sema.available})`,
    );
    await sema.acquire(BrowserPool.SEMAPHORE_TIMEOUT_MS);
    console.log(
      `[BrowserPool] 窗口(id:${browerid.slice(0, 8)}) 已获得启动配额，开始调用 EasyBR openBrower... (可用: ${sema.available})`,
    );

    try {
      return await eb.openBrower(browerid);
    } catch (firstErr) {
      console.warn(
        `[BrowserPool] 窗口(id:${browerid.slice(0, 8)}) openBrower 首次失败，2s 后退避重试: ${(firstErr as Error).message}`,
      );
      await new Promise(resolve => setTimeout(resolve, 2_000));
      return await eb.openBrower(browerid);
    } finally {
      sema.release();
      console.log(
        `[BrowserPool] 窗口(id:${browerid.slice(0, 8)}) 已释放启动配额 (可用: ${sema.available})`,
      );
    }
  }

  private async connectCdpWithBackoff(
    httpEndpoint: string,
    browerid: string,
    browername: string,
  ): Promise<string> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 3000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(
          `[BrowserPool] ws 为空，尝试直连 CDP (第${attempt}/${MAX_RETRIES}次): ${httpEndpoint}`,
        );
        const browser = await chromium.connectOverCDP(httpEndpoint, { timeout: 10000 });
        const wsUrl = (browser as any)._connection?._url || httpEndpoint;
        await browser.close().catch(() => {});
        console.log(`[BrowserPool] ✓ CDP 端口就绪: ${wsUrl}`);
        return wsUrl;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[BrowserPool] CDP 直连失败 (第${attempt}/${MAX_RETRIES}次, 窗口=${browername}): ${errMsg}`,
        );
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    console.log(`[BrowserPool] 退避重试耗尽，尝试关闭并重开窗口以切换 CDP 模式: ${browername}`);
    try {
      const eb = EasyBRClient.getInstance();
      await eb.closeBrower(browerid);
      await new Promise(r => setTimeout(r, 2000));
      const retryResult = await eb.openBrower(browerid);
      if (retryResult.ws) {
        console.log(`[BrowserPool] ✓ 重开后获得 CDP WebSocket: ${retryResult.ws}`);
        return retryResult.ws;
      }
      if (retryResult.http) {
        console.log(`[BrowserPool] 重开后仍无 ws，最后一次尝试直连: ${retryResult.http}`);
        const browser = await chromium.connectOverCDP(retryResult.http, { timeout: 10000 });
        const wsUrl = (browser as any)._connection?._url || retryResult.http;
        await browser.close().catch(() => {});
        return wsUrl;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[BrowserPool] 关闭重开失败 (窗口=${browername}): ${errMsg}`);
    }

    throw new Error(
      `CDP 不可达 (窗口=${browername}, 已重试 ${MAX_RETRIES} 次 + 关闭重开, 端点=${httpEndpoint})`,
    );
  }

  private async connectWsCdpWithBackoff(
    wsEndpoint: string,
    browerid: string,
    browername: string,
  ): Promise<Browser> {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 3000;
    const CONNECT_TIMEOUT_MS = 10000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: CONNECT_TIMEOUT_MS });
        console.log(`[CDP] ws connect success browserId=${browerid.slice(0, 8)}... attempt=${attempt}/${MAX_ATTEMPTS} name=${browername}`);
        return browser;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        if (attempt === MAX_ATTEMPTS) {
          console.error(`[CDP] ws connect failed browserId=${browerid.slice(0, 8)}... attempts=${MAX_ATTEMPTS} name=${browername} error=${errMsg}`);
          throw e;
        }
        console.warn(`[CDP] ws connect retry ${attempt}/${MAX_ATTEMPTS} browserId=${browerid.slice(0, 8)}... name=${browername} error=${errMsg}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    throw new Error(`ws CDP connect failed browserId=${browerid.slice(0, 8)}... name=${browername}`);
  }

  private async connectAndSetupWindow(
    browerid: string,
    browername: string,
  ): Promise<ConnectResult> {
    const existingConn = this.connections.get(browerid);
    if (existingConn) {
      try {
        await Promise.race([
          existingConn.page.evaluate(() => 1),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale')), 3000)),
        ]);
        const readyCheck = await this.verifyReady(browerid, existingConn.page, browername);
        if (readyCheck.ready) {
          console.log(`[BrowserPool] 复用已有连接 "${browername}"，READY验证通过`);
          this._setReady(browerid);
          return { browser: existingConn.browser, page: existingConn.page };
        } else {
          console.warn(`[BrowserPool] 复用连接 "${browername}" READY验证失败(${readyCheck.failedCheck}): ${readyCheck.reason}，清理后重连`);
          this._resetForReconnect(browerid);
        }
      } catch {
        console.log(`[BrowserPool] 已有连接 "${browername}" 已失效，重新连接...`);
        this._resetForReconnect(browerid);
      }
    }

    const existingPromise = this.connectingPromises.get(browerid);
    if (existingPromise) {
      console.log(
        `[BrowserPool] 窗口 "${browername}" (id:${browerid.slice(0, 8)}) 正在连接中，复用已有 Promise`,
      );
      return existingPromise;
    }

    const connectPromise = this.doConnectAndSetup(browerid, browername);
    this.connectingPromises.set(browerid, connectPromise);

    try {
      return await connectPromise;
    } finally {
      this.connectingPromises.delete(browerid);
    }
  }

  private async doConnectAndSetup(
    browerid: string,
    browername: string,
  ): Promise<ConnectResult> {
    const CONNECT_SOFT_WARN_MS = 30_000;
    const CONNECT_SOFT_WARN2_MS = 60_000;

    const connect = async (): Promise<ConnectResult> => {
    const { ws, http } = await this.openBrowerWithRetry(browerid);

    let browser: Browser;
    if (ws) {
      browser = await this.connectWsCdpWithBackoff(ws, browerid, browername);
    } else if (http) {
      const cdpEndpoint = await this.connectCdpWithBackoff(http, browerid, browername);
      browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 10000 });
    } else {
      throw new Error(`openBrower 返回空 ws 和空 http，无法连接`);
    }
    const ctx = browser.contexts()[0];
    const allPages = ctx.pages();
    console.log(`[BrowserPool] CDP 连接成功: ${browername}，共 ${allPages.length} 个标签页`);
    for (const p of allPages) {
      console.log(`[BrowserPool]   - ${p.url()}`);
    }

    let page = allPages.find(p => p.url().includes(TARGET_DOMAIN) && (p.url().includes('/login') || p.url().includes('Login')));
    if (!page) {
      page = allPages.find(p => p.url().includes(TARGET_DOMAIN));
    }
    if (!page) {
      console.log(`[BrowserPool] 窗口 "${browername}" 未打开 bnsy 系统，自动打开...`);
      page = await ctx.newPage();
      await page.goto(TARGET_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('.app-container, .el-menu, .login-container', { timeout: 10000 }).catch(() => {});
    }
    console.log(`[BrowserPool] 选中页面 URL: ${page.url()}`);

    PopupManager.getInstance().register(page);
    await this.checkAndAutoLogin(browerid, page, browername);

    const P0_ROUNDS = 3;
    const P0_INTERVAL_MS = 5000;
    for (let round = 1; round <= P0_ROUNDS; round++) {
      console.log(`[BrowserPool] P0 检查第 ${round}/${P0_ROUNDS} 轮: ${browername}`);

      await this.cleanupRedundantPages(browser, page, browername);
      await this.ensureNoPopup(page, browername);
      await this.ensureSidebarExpanded(page, browername);

      if (round < P0_ROUNDS) {
        console.log(`[BrowserPool] P0 第 ${round} 轮完成，等待 ${P0_INTERVAL_MS / 1000}s 后继续下一轮...`);
        await new Promise(r => setTimeout(r, P0_INTERVAL_MS));
      }
    }
    console.log(`[BrowserPool] ✓ P0 多轮检查完成 (${P0_ROUNDS} 轮): ${browername}`);

    await this.maximizeThenMinimize(browser, page, browername);

    const readyCheck = await this.verifyReady(browerid, page, browername);
    if (readyCheck.ready) {
      this._setReady(browerid);
      const tsP0 = new Date().toISOString();
      console.log(`[${tsP0}][BrowserPool] ✓ READY验证通过: ${browername} (${browerid.slice(0, 8)})`);
    } else {
      this._clearReady(browerid);
      console.warn(`[BrowserPool] ⚠ READY验证失败: ${browername} [${readyCheck.failedCheck}] ${readyCheck.reason}`);
    }

    return { browser, page };
    };

    const connectPromise = connect();

    const warn1Timer = setTimeout(() => {
      console.warn(`[BrowserPool] ⚠ 窗口 "${browername}" 连接已耗时超过 ${CONNECT_SOFT_WARN_MS / 1000}s，继续等待...`);
    }, CONNECT_SOFT_WARN_MS);

    const warn2Timer = setTimeout(() => {
      console.warn(`[BrowserPool] ⚠ 窗口 "${browername}" 连接已耗时超过 ${CONNECT_SOFT_WARN2_MS / 1000}s，请检查 EasyBR 和网络状态...`);
    }, CONNECT_SOFT_WARN2_MS);

    try {
      return await connectPromise;
    } finally {
      clearTimeout(warn1Timer);
      clearTimeout(warn2Timer);
    }
  }

  private async cleanupRedundantPages(browser: Browser, keepPage: Page, windowName: string): Promise<void> {
    const TARGET_DOMAIN = 'bnsy.benniaosuyun.com';
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctx = browser.contexts()[0];
        const allPages = ctx.pages();
        let closedCount = 0;

        for (const p of allPages) {
          if (p === keepPage) continue;

          const url = p.url();
          if (url.includes('localhost:3001/help/') || url.includes('127.0.0.1:3001/help/')) {
            continue;
          }

          console.log(`[BrowserPool] 窗口 "${windowName}" 关闭多余标签页: ${url}`);
          await p.close().catch((e) => {
            console.warn(`[BrowserPool]   关闭失败: ${(e as Error).message}`);
          });
          closedCount++;
        }

        if (closedCount > 0) {
          console.log(`[BrowserPool] 窗口 "${windowName}" 已清理 ${closedCount} 个多余标签页 (第${attempt}次)`);
        }

        const remainingPages = ctx.pages();
        const bnsyPages = remainingPages.filter(p => p.url().includes(TARGET_DOMAIN));
        const helpPages = remainingPages.filter(p => p.url().includes('localhost:3001/help/') || p.url().includes('127.0.0.1:3001/help/'));

        if (bnsyPages.length === 1 && helpPages.length <= 1) {
          console.log(`[BrowserPool] ✓ 窗口 "${windowName}" 页面清理验证通过: ${bnsyPages.length} bnsy + ${helpPages.length} help`);
          return;
        }

        console.warn(`[BrowserPool] 窗口 "${windowName}" 页面清理验证失败: ${bnsyPages.length} bnsy + ${helpPages.length} help，重试 ${attempt}/${MAX_RETRIES}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (e) {
        console.warn(`[BrowserPool] 清理多余标签页失败 (${windowName}, 第${attempt}次):`, (e as Error).message);
      }
    }

    console.error(`[BrowserPool] ✗ 窗口 "${windowName}" 页面清理 ${MAX_RETRIES} 次仍未通过验证！`);
  }

  private async ensureNoPopup(page: Page, windowName: string, maxRounds = 5): Promise<void> {
    const popupMgr = PopupManager.getInstance();

    for (let round = 1; round <= maxRounds; round++) {
      await Promise.race([
        popupMgr.dismissAll(page, { timeout: 5000, maxRounds: 3, verifyAfter: false }),
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);

      const visibleDialogs = await page.$$('.el-dialog__wrapper, .pay-dialog, .el-message-box').catch(() => []);
      let hasVisible = false;
      for (const d of visibleDialogs) {
        const visible = await d.isVisible().catch(() => false);
        if (visible) { hasVisible = true; break; }
      }

      if (!hasVisible) {
        if (round > 1) {
          console.log(`[BrowserPool] ✓ 窗口 "${windowName}" 弹窗已清除 (第${round}轮验证通过)`);
        }
        return;
      }

      console.warn(`[BrowserPool] 窗口 "${windowName}" 仍有可见弹窗，重试清除 ${round}/${maxRounds}`);
      await new Promise(r => setTimeout(r, 500));
    }

    console.error(`[BrowserPool] ✗ 窗口 "${windowName}" 弹窗清除 ${maxRounds} 轮仍有残留！`);
  }

  private async ensureSidebarExpanded(page: Page, windowName: string): Promise<void> {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await PageStateManager.getInstance().ensureSidebarExpanded(page);
        if (result.expanded) {
          if (result.wasCollapsed) {
            console.log(`[BrowserPool] ✓ 窗口 "${windowName}" 侧边栏已展开 (第${attempt}次)`);
          }
          return;
        }
        console.warn(`[BrowserPool] 窗口 "${windowName}" 侧边栏展开失败 (第${attempt}次)，重试...`);
      } catch (e) {
        console.warn(`[BrowserPool] 窗口 "${windowName}" 侧边栏检查异常 (第${attempt}次):`, (e as Error).message);
      }
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.error(`[BrowserPool] ✗ 窗口 "${windowName}" 侧边栏 ${MAX_RETRIES} 次仍未展开！`);
  }

  private async maximizeThenMinimize(browser: Browser, page: Page, windowName: string): Promise<void> {
    const cdpSession = await page.context().newCDPSession(page);
    try {
      const { windowId } = await cdpSession.send('Browser.getWindowForTarget' as any) as any;

      await cdpSession.send('Browser.setWindowBounds' as any, {
        windowId,
        bounds: { windowState: 'normal' },
      });
      await new Promise(r => setTimeout(r, 300));

      await cdpSession.send('Browser.setWindowBounds' as any, {
        windowId,
        bounds: { windowState: 'maximized' },
      });
      await new Promise(r => setTimeout(r, 500));
      console.log(`[BrowserPool] ✓ 窗口 "${windowName}" 已最大化`);

      await cdpSession.send('Browser.setWindowBounds' as any, {
        windowId,
        bounds: { windowState: 'minimized' },
      });
      await new Promise(r => setTimeout(r, 300));
      console.log(`[BrowserPool] ✓ 窗口 "${windowName}" 已最小化`);
    } catch (e) {
      console.warn(`[BrowserPool] 窗口 "${windowName}" 最大化/最小化失败:`, (e as Error).message);
    } finally {
      await cdpSession.detach().catch((detachErr: Error) => {
        console.warn(`[BrowserPool] 窗口 "${windowName}" CDP session detach 失败:`, detachErr.message);
      });
    }
  }

  /**
   * 解析自动登录凭据：优先 settings.json（按 easybrBrowserId 匹配），fallback 到 credentials.ts（按 staffName 匹配）
   */
  async resolveLoginCredential(
    windowId: string,
    windowName: string,
  ): Promise<{
    cred: { account: string; password: string } | undefined;
    source: 'settings' | 'credentials' | 'none';
    diagnostics: {
      staffName: string | null;
      site: Site;
      settingsFound: boolean;
      settingsHasUser: boolean;
      settingsHasPass: boolean;
      fallbackFound: boolean;
    };
  }> {
    const { site: parsedSite, staffName } = this.parseWindowName(windowName);

    let cred: { account: string; password: string } | undefined;
    let source: 'settings' | 'credentials' | 'none' = 'none';
    let settingsFound = false;
    let settingsHasUser = false;
    let settingsHasPass = false;

    try {
      const sm = SettingsManager.getInstance();
      const config = await sm.getConfig();
      for (const s of config.sites) {
        for (const w of s.windows) {
          if (w.easybrBrowserId === windowId) {
            settingsFound = true;
            settingsHasUser = !!w.username;
            settingsHasPass = !!w.password;
            if (w.username && w.password) {
              cred = { account: w.username, password: w.password };
              source = 'settings';
            }
            break;
          }
        }
        if (cred) break;
      }
    } catch (e) {
      console.warn(`[BrowserPool/Login] 读取 settings.json 凭据失败: ${(e as Error).message}`);
    }

    let fallbackFound = false;
    if (!cred && staffName) {
      const fallback = findCredential(staffName);
      if (fallback) {
        cred = { account: fallback.account, password: fallback.password };
        source = 'credentials';
        fallbackFound = true;
      }
    }

    return {
      cred,
      source,
      diagnostics: {
        staffName,
        site: parsedSite,
        settingsFound,
        settingsHasUser,
        settingsHasPass,
        fallbackFound,
      },
    };
  }

  private async checkAndAutoLogin(windowId: string, page: Page, windowName: string): Promise<void> {
    const currentUrl = page.url();
    const isOnLoginPage = currentUrl.includes('/login') || currentUrl.includes('Login');
    let loginSucceeded = false;

    if (isOnLoginPage) {
    this._setLoginRequired(windowId);

    const { cred, source, diagnostics } = await this.resolveLoginCredential(windowId, windowName);
    const { staffName, site: parsedSite, settingsFound, settingsHasUser, settingsHasPass, fallbackFound } = diagnostics;

    if (!cred) {
      console.warn(`[BrowserPool/Login] 未找到自动登录凭据: browserId=${windowId.slice(0, 8)}..., windowName="${windowName}", staffName=${staffName || 'null'}, site=${parsedSite}, settingsFound=${settingsFound}, hasUsername=${settingsHasUser}, hasPassword=${settingsHasPass}, fallbackCredential=${fallbackFound}`);
      return;
    }

    if (source === 'settings') {
      console.log(`[BrowserPool/Login] 使用 settings.json 凭据自动登录: staffName=${staffName || 'unknown'}, browserId=${windowId.slice(0, 8)}...`);
    } else {
      console.log(`[BrowserPool/Login] 使用 credentials.ts 兜底凭据登录: staffName=${staffName}, account=${cred.account}`);
    }

    await page.waitForSelector('input[placeholder="请输入账号"]', { timeout: 10000 }).catch(() => {});

    await Promise.race([
      PopupManager.getInstance().dismissAll(page, { timeout: 5000, maxRounds: 3, verifyAfter: false }),
      new Promise<void>(resolve => setTimeout(resolve, 5000)),
    ]);

    const accountInput = await page.$('input[placeholder="请输入账号"]').catch(() => null);
    const passwordInput = await page.$('input[placeholder="请输入密码"]').catch(() => null);

    if (!accountInput || !passwordInput) {
      console.warn(`[BrowserPool] 窗口 "${windowName}" 未找到账号/密码输入框，保持待登录状态`);
      return;
    }

    await accountInput.click({ clickCount: 3 }).catch(() => {});
    await accountInput.fill(cred.account);
    await passwordInput.click({ clickCount: 3 }).catch(() => {});
    await passwordInput.fill(cred.password);
    console.log(`[BrowserPool] 窗口 "${windowName}" 已填入账号密码`);

    await Promise.race([
      PopupManager.getInstance().dismissAll(page, { timeout: 3000, maxRounds: 2, verifyAfter: false }),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);

    let loginBtn = await page.$('button.submitBtn').catch(() => null);
    if (!loginBtn) loginBtn = await page.$('button.el-button--primary').catch(() => null);
    if (!loginBtn) loginBtn = await page.$('button:has-text("登录")').catch(() => null);
    if (!loginBtn) loginBtn = await page.$('button:has-text("立即登录")').catch(() => null);
    if (!loginBtn) loginBtn = await page.$('button[type="submit"]').catch(() => null);

    if (!loginBtn) {
      console.warn(`[BrowserPool] 窗口 "${windowName}" 未找到登录按钮，保持待登录状态`);
      return;
    }

    await loginBtn.click();
    console.log(`[BrowserPool] 窗口 "${windowName}" 已点击登录按钮，等待跳转...`);

    const popupMgr = PopupManager.getInstance();
    const jumpStart = Date.now();
    const jumpTimeout = 20000;

    try {
      await Promise.race([
        page.waitForFunction(
          () => !window.location.href.includes('/login') && !window.location.href.includes('Login'),
          { timeout: jumpTimeout }
        ).then(() => { loginSucceeded = true; }),
        (async () => {
          while (Date.now() - jumpStart < jumpTimeout) {
            await page.waitForTimeout(2000).catch(() => {});
            await popupMgr.dismissAll(page, { timeout: 3000, maxRounds: 2, verifyAfter: false }).catch(() => {});
          }
        })(),
      ]);
    } catch {
    }

    if (loginSucceeded) {
      console.log(`[BrowserPool] 窗口 "${windowName}" 登录成功，当前 URL: ${page.url()}`);
      this._clearLoginRequired(windowId);
    } else {
      console.warn(`[BrowserPool] 窗口 "${windowName}" 登录后未跳转，保持待登录状态，当前 URL: ${page.url()}`);
      return;
    }
    } else {
      this._clearLoginRequired(windowId);
    }

    const afterLoginUrl = page.url();
    if (!afterLoginUrl.includes('/dashboard')) {
      console.log(`[BrowserPool] 窗口 "${windowName}" 当前在 ${afterLoginUrl}，导航到 /dashboard...`);
      await page.goto(TARGET_DASHBOARD, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
        console.warn(`[BrowserPool] 导航到 /dashboard 失败: ${(e as Error).message}`);
      });
    }

    await Promise.race([
      PopupManager.getInstance().dismissAll(page, { timeout: 8000, maxRounds: 5, verifyAfter: true }),
      new Promise<void>(resolve => setTimeout(resolve, 10000)),
    ]);

    const finalUrl = page.url();
    console.log(`[BrowserPool] 窗口 "${windowName}" 初始化导航完成，最终 URL: ${finalUrl}`);
  }

  private parseWindowName(name: string): { role: WindowRole; site: Site; staffName: string | null } {
    const ADMIN_KEYWORDS = ['管理', 'admin', '管理员'];

    if (name.includes('-')) {
      const [sitePart, ...nameParts] = name.split('-');
      const staffName = nameParts.join('-').trim();
      const site: Site = sitePart.includes('天南大') ? 'tiannanda' : 'heyuan';

      const isAdmin = ADMIN_KEYWORDS.some(k => staffName.includes(k) || name.includes(k));
      if (isAdmin) {
        return { role: 'admin', site, staffName: null };
      }
      return { role: 'staff', site, staffName };
    } else {
      const site: Site = name.includes('天南大') ? 'tiannanda' : 'heyuan';
      return { role: 'admin', site, staffName: null };
    }
  }

  async ensureWindowReady(windowId: string): Promise<void> {
    const conn = this.connections.get(windowId);
    if (!conn) {
      throw new Error(`窗口 ${windowId} 未连接，无法执行 P0 检查`);
    }
    const name = conn.windowInfo.name;
    console.log(`[BrowserPool] P0 前置检查: ${name}`);

    await this.cleanupRedundantPages(conn.browser, conn.page, name);
    await this.ensureNoPopup(conn.page, name);
    await this.ensureSidebarExpanded(conn.page, name);

    console.log(`[BrowserPool] ✓ P0 前置检查完成: ${name}`);
  }

  async getStaffPage(staffName: string, site?: Site): Promise<Page> {
    return (await this.getStaffConnection(staffName, site)).page;
  }

  async getStaffConnection(staffName: string, site?: Site): Promise<BrowserConnection> {
    for (const [, conn] of this.connections) {
      if (conn.windowInfo.role === 'staff' && conn.windowInfo.staff_name === staffName) {
        if (site && conn.windowInfo.site !== site) {
          continue;
        }
        if (conn.windowInfo.is_connected !== 1) {
          console.warn(`[BrowserPool] getStaffConnection 跳过断线窗口: ${staffName} (${conn.windowInfo.id})`);
          continue;
        }
        if (!this.p0Verified.has(conn.windowInfo.id)) {
          console.warn(`[BrowserPool] getStaffConnection 跳过未 P0 就绪窗口: ${staffName} (${conn.windowInfo.id})`);
          continue;
        }
        try {
          await conn.page.evaluate(() => 1);
        } catch (e) {
          console.warn(`[BrowserPool] getStaffConnection 窗口页面不可用: ${staffName} (${(e as Error).message})`);
          continue;
        }
        return {
          page: conn.page,
          browser: conn.browser,
          windowId: conn.windowInfo.id,
          windowInfo: conn.windowInfo,
          staffName,
        };
      }
    }
    const siteHint = site ? ` (site=${site})` : '';
    throw new Error(`未找到员工 "${staffName}"${siteHint} 的窗口，请确认 EasyBR 已开启该员工窗口`);
  }

  listWindows(): WindowInfo[] {
    const connected = Array.from(this.connections.values()).map(c => c.windowInfo);
    const connectedIds = new Set(connected.map(w => w.id));

    const dbWindows = this.db.listWindows();
    for (const w of dbWindows) {
      if (!connectedIds.has(w.id)) {
        connected.push(w);
      }
    }
    return connected;
  }

  async discoverAndReconnectWindows(): Promise<void> {
    if (this.initializing) {
      return;
    }

    try {
      const eb = EasyBRClient.getInstance();
      const openedWindows = await eb.openedList();
      const browserConfigs = await eb.getBrowerList();

      const ts0 = new Date().toISOString();
      const openIds = openedWindows.filter(w => w.isopen).map(w => w.browerid);
      console.log(`[${ts0}][BrowserPool] refresh Step2: openedList=${openIds.length}个, browserConfigs=${browserConfigs.size}个, connections=${this.connections.size}, p0Verified=${this.p0Verified.size}`);
      for (const ow of openedWindows) {
        const name = browserConfigs.get(ow.browerid) || ow.browername || '?';
        console.log(`[${ts0}][BrowserPool]   openedList 完整: browerid="${ow.browerid}" name="${name}" isopen=${ow.isopen}`);
      }

      let settingsWindowNames = new Set<string>();
      try {
        const { SettingsManager } = require('../config/SettingsManager');
        const sm = SettingsManager.getInstance();
        const config = await sm.getConfig();
        if (config.initialized) {
          for (const site of config.sites) {
            for (const w of site.windows) {
              settingsWindowNames.add(w.windowName);
              if (w.employeeName) settingsWindowNames.add(w.employeeName);
            }
          }
        }
      } catch { /* 忽略 */ }

      // ★ 每轮最多重连 2 个窗口，防止重连风暴阻塞健康巡检
      const MAX_RECONNECT_PER_CYCLE = 2;
      let reconnectedThisCycle = 0;

      for (const win of openedWindows) {
        if (!win.isopen) continue;

        if (this.manuallyClosed.has(win.browerid)) {
          continue;
        }

        const browername = browserConfigs.get(win.browerid);
        if (!browername) continue;

        if (settingsWindowNames.size > 0) {
          let matched = false;
          for (const sn of settingsWindowNames) {
            if (browername.includes(sn) || sn.includes(browername)) {
              matched = true;
              break;
            }
          }
          if (!matched) continue;
        }

        const existingConn = this.connections.get(win.browerid);
        if (existingConn) {
          if (existingConn.windowInfo.is_connected === 1) continue;
          // 残留死连接：完整清理后重连
          this._resetForReconnect(win.browerid);
          await existingConn.browser.close().catch(() => {});
        }

        if (!this.reconnectPolicy.canReconnect(win.browerid)) {
          continue;
        }

        if (this.connectingWindows.has(win.browerid)) {
          continue;
        }

        if (reconnectedThisCycle >= MAX_RECONNECT_PER_CYCLE) {
          continue;
        }
        reconnectedThisCycle++;

        this._setConnecting(win.browerid);

        console.log(`[BrowserPool] 发现新窗口 "${browername}"，尝试连接...`);
        try {
          const { browser, page } = await this.connectAndSetupWindow(win.browerid, browername);

          this.reconnectPolicy.recordSuccess(win.browerid);

          const { role, site, staffName } = this.parseWindowName(browername);
          const windowInfo: WindowInfo = {
            id: win.browerid,
            name: browername,
            cdp_port: 0,
            role,
            site,
            staff_name: staffName,
            is_connected: 1,
            updated_at: new Date().toISOString(),
          };
          this.db.upsertWindow(windowInfo);
          this._setConnected(win.browerid, { browser, page, windowInfo });
          this.registerDisconnectHandler(win.browerid);
          SessionManager.getInstance().startHeartbeat(win.browerid, page);
          const ts2 = new Date().toISOString();
          console.log(`[${ts2}][BrowserPool] ✓ 新窗口已连接: ${browername} (${win.browerid.slice(0, 8)})`);
          console.log(`[${ts2}][BrowserPool]   写入后: connections=${this.connections.size} p0Verified=${this.p0Verified.size} windowBusy=${this.windowBusy.size}`);
          console.log(`[${ts2}][BrowserPool]   p0Verified 包含此窗口: ${this.p0Verified.has(win.browerid)}`);
        } catch (e) {
          console.warn(`[BrowserPool] 连接新窗口 "${browername}" 失败:`, (e as Error).message);
          this._clearReady(win.browerid);
          this._clearLoginRequired(win.browerid);
          this.windowBusy.delete(win.browerid);
          const record = this.reconnectPolicy.recordFailure(win.browerid);
          console.log(`[BrowserPool]   → 第${record.failureCount}次失败，冷却 ${(record.cooldownMs / 1000).toFixed(0)}s 后重试`);
        } finally {
          this._clearConnecting(win.browerid);
        }
      }
    } catch (e) {
      console.warn('[BrowserPool] 扫描新窗口失败:', (e as Error).message);
    }
  }

  async dismissAllPopups(): Promise<void> {
    const popupMgr = PopupManager.getInstance();
    for (const [, conn] of this.connections) {
      if (conn.windowInfo.is_connected !== 1) continue;
      await Promise.race([
        popupMgr.backgroundCleanup(conn.page),
        new Promise<void>(resolve => setTimeout(resolve, 3000)),
      ]).catch(() => {});
    }
  }

  listStaffWindows(site: Site): WindowInfo[] {
    return this.listWindows().filter(w => w.role === 'staff' && w.site === site);
  }

  isWindowP0Verified(windowId: string): boolean { return this.p0Verified.has(windowId); }

  getDegradedCount(windowId: string): number { return this.healthMonitor.getDegradedCount(windowId); }

  isWindowDegraded(windowId: string): boolean { return this.healthMonitor.isWindowDegraded(windowId); }

  getRuntimeState(windowId: string): WindowRuntimeStateEntry {
    return this.runtimeStates.get(windowId) ?? {
      windowId,
      state: 'offline',
      isConnected: false,
      isP0Verified: false,
      isLoginRequired: false,
      isBusy: false,
      isConnecting: false,
      isDegraded: false,
      updatedAt: 0,
    };
  }

  getWindowDiagnostics(windowId: string): Record<string, unknown> {
    const rt = this.getRuntimeState(windowId);
    const decision = this.reconnectPolicy.getDecision(windowId);
    const degradedCount = this.healthMonitor.getDegradedCount(windowId);
    const busySince = this.windowBusy.get(windowId) ?? 0;
    const isManuallyClosed = this.manuallyClosed.has(windowId);
    const conn = this.connections.get(windowId);

    return {
      windowId,
      runtimeState: rt.state,
      isConnected: rt.isConnected,
      isP0Verified: rt.isP0Verified,
      isBusy: rt.isBusy,
      isConnecting: rt.isConnecting,
      isDegraded: rt.isDegraded,
      updatedAt: new Date(rt.updatedAt).toISOString(),
      failureCount: decision.failureCount,
      cooldownUntil: decision.cooldownUntil > 0 ? new Date(decision.cooldownUntil).toISOString() : null,
      cooldownRemainingMs: decision.cooldownRemainingMs,
      degradedCount,
      busySince: busySince > 0 ? new Date(busySince).toISOString() : null,
      busyDurationMs: busySince > 0 ? Date.now() - busySince : 0,
      isManuallyClosed,
      windowName: conn?.windowInfo.name || null,
    };
  }

  isWindowBusy(windowId: string): boolean { return this.windowBusy.has(windowId); }

  isWindowConnecting(windowId: string): boolean { return this.connectingWindows.has(windowId); }

  isWindowConnected(windowId: string): boolean {
    const conn = this.connections.get(windowId);
    return conn !== undefined && conn.windowInfo.is_connected === 1;
  }

  getWindowState(windowId: string): 'offline' | 'connected' | 'ready' | 'busy' {
    if (!this.isWindowConnected(windowId)) return 'offline';
    if (this.windowBusy.has(windowId)) return 'busy';
    if (this.p0Verified.has(windowId)) return 'ready';
    return 'connected';
  }

  getOnlineWorkers(site?: Site): WindowInfo[] {
    const poolWorkers: WindowInfo[] = [];

    for (const [, conn] of this.connections) {
      const info = conn.windowInfo;
      if (
        info.is_connected === 1
        && info.staff_name
        && this.p0Verified.has(info.id)
        && !this.windowBusy.has(info.id)
        && (!site || info.site === site)
      ) {
        poolWorkers.push(info);
      }
    }

    if (poolWorkers.length > 0) {
      return poolWorkers;
    }

    const dbWorkers = this.db.listWindows().filter(
      (w) => w.is_connected === 1 && w.staff_name && (!site || w.site === site),
    );
    if (dbWorkers.length > 0 && this.connections.size > 0) {
      console.warn(
        `[BrowserPool] 内存中有 ${this.connections.size} 个连接但无 P0 就绪 Worker，回退 DB 查询 (${dbWorkers.length} 个)${site ? `, site=${site}` : ''}`,
      );
    }
    return dbWorkers;
  }

  private refreshRuntimeState(windowId: string): void {
    const conn = this.connections.has(windowId);
    const isBusy = this.windowBusy.has(windowId);
    const isReady = this.p0Verified.has(windowId);
    const isLoginRequired = this.loginRequiredWindows.has(windowId);
    const isConnecting = this.connectingWindows.has(windowId);
    const isDegraded = this.healthMonitor.isWindowDegraded(windowId);

    let state: WindowRuntimeState;
    if (!conn) {
      if (isConnecting) {
        state = 'connecting';
      } else if (isReady) {
        state = 'connecting';
      } else if (isDegraded) {
        state = 'degraded';
      } else {
        state = 'offline';
      }
    } else if (isBusy) {
      state = 'busy';
    } else if (isReady) {
      state = 'ready';
    } else if (isLoginRequired) {
      state = 'login_required';
    } else {
      state = 'connected';
    }

    this.runtimeStates.set(windowId, {
      windowId,
      state,
      isConnected: conn,
      isP0Verified: isReady,
      isLoginRequired,
      isBusy,
      isConnecting,
      isDegraded,
      updatedAt: Date.now(),
    });
  }

  private _setConnecting(windowId: string): void {
    this.connectingWindows.add(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _clearConnecting(windowId: string): void {
    this.connectingWindows.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _setReady(windowId: string): void {
    this.p0Verified.add(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _clearReady(windowId: string): void {
    this.p0Verified.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _setLoginRequired(windowId: string): void {
    this.loginRequiredWindows.add(windowId);
    this.p0Verified.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _clearLoginRequired(windowId: string): void {
    this.loginRequiredWindows.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _setConnected(windowId: string, conn: ConnectedBrowser): void {
    this.connections.set(windowId, conn);
    this.refreshRuntimeState(windowId);
  }
  private _clearConnected(windowId: string): void {
    this.connections.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _clearWindowRuntime(windowId: string): void {
    this.connectingWindows.delete(windowId);
    this.p0Verified.delete(windowId);
    this.loginRequiredWindows.delete(windowId);
    this.connections.delete(windowId);
    this.refreshRuntimeState(windowId);
  }
  private _resetForReconnect(windowId: string): void {
    this.connections.delete(windowId);
    this.p0Verified.delete(windowId);
    this.loginRequiredWindows.delete(windowId);
    this.windowBusy.delete(windowId);
    this.connectingWindows.delete(windowId);
    this.healthMonitor.clearDegraded(windowId);
    try {
      SessionManager.getInstance().stopHeartbeat(windowId);
    } catch (e) {
      console.warn(`[BrowserPool] _resetForReconnect 停止心跳失败: ${(e as Error).message}`);
    }
    try {
      const { WindowLockManager } = require('./WindowLockManager');
      WindowLockManager.getInstance().release(windowId);
    } catch (e) {
      console.warn(`[BrowserPool] _resetForReconnect 释放锁失败: ${(e as Error).message}`);
    }
    this.refreshRuntimeState(windowId);
  }

  markWindowBusy(windowId: string): void {
    this.windowBusy.set(windowId, Date.now());
    console.log(`[BrowserPool] 🔴 窗口标记为忙碌: ${windowId.slice(0, 12)}`);
    this.refreshRuntimeState(windowId);
  }

  markWindowIdle(windowId: string): void {
    this.windowBusy.delete(windowId);
    console.log(`[BrowserPool] 🟢 窗口标记为空闲: ${windowId.slice(0, 12)}`);
    this.refreshRuntimeState(windowId);
  }

  refreshBusyLease(windowId: string): void {
    if (this.windowBusy.has(windowId)) {
      this.windowBusy.set(windowId, Date.now());
    }
  }

  getOverdueBusy(thresholdMs: number): string[] {
    const now = Date.now();
    const overdue: string[] = [];
    for (const [windowId, startedAt] of this.windowBusy) {
      if (now - startedAt > thresholdMs) {
        overdue.push(windowId);
      }
    }
    return overdue;
  }

  async acquireWindowLease(options: {
    windowId: string;
    taskId: string;
    staffName?: string;
    taskType?: string;
  }): Promise<WindowLeaseHandle> {
    const { windowId, taskId, staffName, taskType } = options;
    const lockManager = WindowLockManager.getInstance();
    await lockManager.acquire(windowId, taskId);

    let leaseSet = false;
    try {
      const now = Date.now();
      const lease: WindowLease = {
        windowId,
        taskId,
        staffName,
        taskType,
        acquiredAt: now,
        lastRenewedAt: now,
      };
      this.windowBusy.set(windowId, now);
      this.activeWindowLeases.set(windowId, lease);
      leaseSet = true;
      this.refreshRuntimeState(windowId);
      console.log(`[BrowserPool] 📋 Lease acquired: window=${windowId.slice(0, 12)} task=${taskId} type=${taskType ?? 'unknown'}`);
    } catch (e) {
      if (leaseSet) {
        this.windowBusy.delete(windowId);
        this.activeWindowLeases.delete(windowId);
      }
      lockManager.release(windowId, taskId);
      throw e;
    }

    const self = this;
    return {
      windowId,
      taskId,
      release(reason?: string) {
        self.releaseWindowLease(windowId, taskId, reason);
      },
      renew() {
        self.renewWindowLease(windowId, taskId);
      },
    };
  }

  releaseWindowLease(windowId: string, taskId: string, reason?: string): void {
    const lease = this.activeWindowLeases.get(windowId);
    const lockManager = WindowLockManager.getInstance();

    if (!lease) {
      try {
        lockManager.release(windowId, taskId);
      } catch (e) {
        console.warn(`[BrowserPool] Lease release lock error (${windowId.slice(0, 12)}):`, (e as Error).message);
      }
      return;
    }

    if (lease.taskId !== taskId) {
      console.log(
        `[BrowserPool] ⚠️ Lease release skipped (taskId mismatch): window=${windowId.slice(0, 12)} caller=${taskId} holder=${lease.taskId}`,
      );
      return;
    }

    this.activeWindowLeases.delete(windowId);
    this.windowBusy.delete(windowId);

    try {
      lockManager.release(windowId, taskId);
    } catch (e) {
      console.warn(`[BrowserPool] Lease release lock error (${windowId.slice(0, 12)}):`, (e as Error).message);
    }

    this.refreshRuntimeState(windowId);
    if (reason) {
      console.log(`[BrowserPool] 📋 Lease released: window=${windowId.slice(0, 12)} task=${taskId} reason=${reason}`);
    }
  }

  renewWindowLease(windowId: string, taskId: string): void {
    const now = Date.now();
    const lease = this.activeWindowLeases.get(windowId);

    if (lease && lease.taskId === taskId) {
      lease.lastRenewedAt = now;
      this.windowBusy.set(windowId, now);
      return;
    }

    if (this.windowBusy.has(windowId)) {
      this.windowBusy.set(windowId, now);
    }
  }

  forceReleaseWindowLease(windowId: string, reason?: string): void {
    const lease = this.activeWindowLeases.get(windowId);
    this.activeWindowLeases.delete(windowId);
    this.windowBusy.delete(windowId);

    try {
      WindowLockManager.getInstance().release(windowId);
    } catch (e) {
      console.warn(`[BrowserPool] forceRelease lock error (${windowId.slice(0, 12)}):`, (e as Error).message);
    }

    this.refreshRuntimeState(windowId);
    if (reason) {
      console.log(
        `[BrowserPool] 📋 Lease force-released: window=${windowId.slice(0, 12)} holder=${lease?.taskId ?? 'none'} reason=${reason}`,
      );
    }
  }

  getActiveWindowLease(windowId: string): Readonly<WindowLease> | null {
    const lease = this.activeWindowLeases.get(windowId);
    if (!lease) return null;
    return Object.freeze({ ...lease });
  }

  isWindowLeased(windowId: string): boolean {
    return this.windowBusy.has(windowId);
  }

  async findBrowserIdByWindowName(windowName: string): Promise<string | null> {
    const configs = await this.getEasyBrBrowserList();
    for (const [id, name] of configs) {
      if (name === windowName || name.includes(windowName)) return id;
    }
    return null;
  }

  async syncBrowserIdsToSettings(): Promise<{ synced: number; failed: string[] }> {
    const eb = EasyBRClient.getInstance();
    const browserConfigs = await eb.getBrowerList();
    const nameToId = new Map(browserConfigs);

    const { SettingsManager } = require('../config/SettingsManager');
    const sm = SettingsManager.getInstance();
    const config = await sm.getConfig();

    if (!config.initialized) return { synced: 0, failed: [] };

    let synced = 0;
    const failed: string[] = [];

    for (const site of config.sites) {
      let changed = false;
      for (const w of site.windows) {
        if ((w as any).easybrBrowserId) continue;

        let browserId: string | null = null;

        browserId = nameToId.get(w.windowName) || null;

        if (!browserId && w.employeeName) {
          browserId = nameToId.get(`${site.name}-${w.employeeName}`) || null;
        }

        if (!browserId && w.employeeName) {
          browserId = nameToId.get(w.employeeName) || null;
        }

        if (browserId) {
          (w as any).easybrBrowserId = browserId;
          changed = true;
          synced++;
          console.log(`[BrowserPool] sync: ${w.employeeName || w.windowName} → ${browserId.slice(0, 8)}`);
        } else {
          failed.push(w.employeeName || w.windowName);
          console.warn(`[BrowserPool] sync: ${w.employeeName || w.windowName} 未匹配`);
        }
      }
      if (changed) {
        await sm.updateConfig(config.sites);
      }
    }

    console.log(`[BrowserPool] syncBrowserIdsToSettings 完成: ${synced} 已补全, ${failed.length} 未匹配`);
    return { synced, failed };
  }

  async reconnect(windowId: string): Promise<void> {
    const oldConn = this.connections.get(windowId);
    if (oldConn) {
      this._resetForReconnect(windowId);
      await oldConn.browser.close().catch(() => {});
    }
    await this.discoverAndReconnectWindows();
  }

  async closeAll(): Promise<void> {
    this.stopHealthMonitor();
    SessionManager.getInstance().stopAllHeartbeats();
    for (const [, conn] of this.connections) {
      await conn.browser.close().catch(() => {});
    }
    this.connections.clear();
    this.p0Verified.clear();
    this.loginRequiredWindows.clear();
    this.windowBusy.clear();
    this.activeWindowLeases.clear();
    this.connectingWindows.clear();
    this.manuallyClosed.clear();
    this.connectingPromises.clear();
    this.runtimeStates.clear();
    this.reconnectPolicy.clearAll();
    this.healthMonitor.clearAllDegraded();
    try {
      const { WindowLockManager } = require('./WindowLockManager');
      for (const lock of WindowLockManager.getInstance().getSnapshot()) {
        WindowLockManager.getInstance().release(lock.windowId);
      }
    } catch { /* ignore */ }
    console.log('[BrowserPool] 所有连接已关闭，运行时状态已清理');
  }

  async cleanupWindowPages(windowId: string): Promise<{ closed: number; remaining: number }> {
    const conn = this.connections.get(windowId);
    if (!conn) {
      throw new Error(`窗口 ${windowId} 未连接，无法清理`);
    }
    const before = conn.browser.contexts()[0].pages().length;
    await this.cleanupRedundantPages(conn.browser, conn.page, conn.windowInfo.name);
    const after = conn.browser.contexts()[0].pages().length;
    return { closed: before - after, remaining: after };
  }

  async ensureWindowOpen(windowId: string): Promise<{
    isConnected: boolean;
    ready: boolean;
    status: 'already_ready' | 'opened' | 'connected' | 'login_required' | 'not_ready' | 'failed';
    message?: string;
  }> {
    const existingConn = this.connections.get(windowId);

    if (existingConn && existingConn.windowInfo.is_connected === 1 && this.p0Verified.has(windowId)) {
      try {
        await Promise.race([
          existingConn.page.evaluate(() => 1),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale')), 3000)),
        ]);
        return { isConnected: true, ready: true, status: 'already_ready', message: '窗口已就绪' };
      } catch {
        console.log(`[BrowserPool/ensureWindowOpen] 窗口 ${existingConn.windowInfo.name} 连接已失效，清理后重连`);
        this.connections.delete(windowId);
        this.p0Verified.delete(windowId);
        this.windowBusy.delete(windowId);
        try { SessionManager.getInstance().stopHeartbeat(windowId); } catch { /* ignore */ }
        try { const { WindowLockManager } = require('./WindowLockManager'); WindowLockManager.getInstance().release(windowId); } catch { /* ignore */ }
      }
    }

    const existingPromise = this.connectingPromises.get(windowId);
    if (existingPromise) {
      try {
        const { page } = await existingPromise;
        const browername = this.connections.get(windowId)?.windowInfo.name || windowId;
        const readyCheck = await this.verifyReady(windowId, page, browername);
        if (readyCheck.ready) {
          this._setReady(windowId);
          return { isConnected: true, ready: true, status: 'opened', message: '窗口已连接就绪' };
        }
        if (this.loginRequiredWindows.has(windowId)) {
          return { isConnected: true, ready: false, status: 'login_required', message: readyCheck.reason };
        }
        return { isConnected: true, ready: false, status: 'not_ready', message: readyCheck.reason };
      } catch (e) {
        return { isConnected: false, ready: false, status: 'failed', message: (e as Error).message };
      }
    }

    const connAfterStale = this.connections.get(windowId);
    if (connAfterStale && connAfterStale.windowInfo.is_connected === 1) {
      const browername = connAfterStale.windowInfo.name;
      let pageAlive = false;
      try {
        await Promise.race([
          connAfterStale.page.evaluate(() => 1),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('page_dead')), 3000)),
        ]);
        pageAlive = true;
      } catch {
        pageAlive = false;
      }

      if (!pageAlive) {
        console.log(`[BrowserPool/ensureWindowOpen] 窗口 ${browername} 页面不可用，清理CDP引用后重连（不关闭浏览器进程）`);
        this.connections.delete(windowId);
        this.p0Verified.delete(windowId);
        this.loginRequiredWindows.delete(windowId);
        this.windowBusy.delete(windowId);
        try { SessionManager.getInstance().stopHeartbeat(windowId); } catch { /* ignore */ }
        try { const { WindowLockManager } = require('./WindowLockManager'); WindowLockManager.getInstance().release(windowId); } catch { /* ignore */ }
        this.refreshRuntimeState(windowId);
      } else {
        const currentUrl = connAfterStale.page.url();
        const isOnLoginPage = currentUrl.includes('/login') || currentUrl.includes('Login');

        if (isOnLoginPage) {
          this._setLoginRequired(windowId);
          try {
            await this.checkAndAutoLogin(windowId, connAfterStale.page, browername);
          } catch (e) {
            console.warn(`[ensureWindowOpen] 自动登录异常 (${browername}):`, (e as Error).message);
          }
        } else {
          this.loginRequiredWindows.delete(windowId);
        }

        const readyCheck = await this.verifyReady(windowId, connAfterStale.page, browername);
        if (readyCheck.ready) {
          this._setReady(windowId);
          return { isConnected: true, ready: true, status: 'connected', message: '窗口已连接并验证就绪' };
        }
        if (this.loginRequiredWindows.has(windowId)) {
          return { isConnected: true, ready: false, status: 'login_required', message: readyCheck.reason };
        }
        return { isConnected: true, ready: false, status: 'not_ready', message: readyCheck.reason };
      }
    }

    const eb = EasyBRClient.getInstance();
    this.manuallyClosed.delete(windowId);
    this._setConnecting(windowId);

    const allWindows = this.listWindows();
    const win = allWindows.find(w => w.id === windowId);
    let browername = win?.name || windowId;

    if (!win) {
      try {
        const configs = await eb.getBrowerList();
        const name = configs.get(windowId);
        if (name) browername = name;
        if (!name) {
          this._clearConnecting(windowId);
          return { isConnected: false, ready: false, status: 'failed', message: `窗口 ${windowId} 未在 EasyBR 配置中找到` };
        }
      } catch (e) {
        this._clearConnecting(windowId);
        return { isConnected: false, ready: false, status: 'failed', message: `获取EasyBR配置失败: ${(e as Error).message}` };
      }
    }

    try {
      const { browser, page } = await this.connectAndSetupWindow(windowId, browername);

      const { role, site, staffName } = this.parseWindowName(browername);
      const windowInfo: WindowInfo = {
        id: windowId,
        name: browername,
        cdp_port: 0,
        role,
        site,
        staff_name: staffName,
        is_connected: 1,
        updated_at: new Date().toISOString(),
      };

      this.db.upsertWindow(windowInfo);
      this._setConnected(windowId, { browser, page, windowInfo });
      this.registerDisconnectHandler(windowId);
      SessionManager.getInstance().startHeartbeat(windowId, page);

      const isReady = this.p0Verified.has(windowId);
      if (isReady) {
        console.log(`[BrowserPool/ensureWindowOpen] ✓ 窗口已打开并就绪: ${browername}`);
        return { isConnected: true, ready: true, status: 'opened', message: '窗口已打开并就绪' };
      }
      if (this.loginRequiredWindows.has(windowId)) {
        console.log(`[BrowserPool/ensureWindowOpen] 窗口已打开但需登录: ${browername}`);
        return { isConnected: true, ready: false, status: 'login_required', message: '窗口已打开，需要登录' };
      }
      console.log(`[BrowserPool/ensureWindowOpen] 窗口已连接但未完全就绪: ${browername}`);
      return { isConnected: true, ready: false, status: 'not_ready', message: '窗口已连接但未完全就绪' };
    } catch (e) {
      console.error(`[BrowserPool/ensureWindowOpen] 打开窗口 "${browername}" 失败:`, (e as Error).message);
      this._clearReady(windowId);
      this._clearLoginRequired(windowId);
      return { isConnected: false, ready: false, status: 'failed', message: (e as Error).message };
    } finally {
      this._clearConnecting(windowId);
    }
  }

  async toggleWindow(windowId: string): Promise<{ isConnected: boolean }> {
    // ★ 交付前安全加固：运行中窗口禁止 toggle / 关闭 / 重启
    // 防止用户手动切换窗口时杀死正在执行任务的浏览器，造成任务中断和锁状态错乱
    //
    // 豁免：init_window 任务类型 — InitWindowHandler 设计就是在 acquireWindowLease
    // 保护下调用 toggleWindow 完成窗口初始化（CDP 连接 + 登录 + 弹窗清除），
    // 这是窗口启动的合法路径，必须放行。
    const lease = this.activeWindowLeases.get(windowId);
    const isInitWindow = lease?.taskType === 'init_window';
    if (!isInitWindow && (this.activeWindowLeases.has(windowId) || this.windowBusy.has(windowId))) {
      const errMsg = lease
        ? `窗口正在执行任务（taskId=${lease.taskId}），无法关闭或切换`
        : `窗口处于 busy 状态，无法关闭或切换`;
      console.warn(`[BrowserPool] ⚠️ 拒绝 toggle: windowId=${windowId} 原因=${errMsg}`);
      throw new Error(errMsg);
    }

    const conn = this.connections.get(windowId);
    if (conn && conn.windowInfo.is_connected === 1) {
      const name = conn.windowInfo.name;
      console.log(`[BrowserPool] ❌ 关闭窗口: ${name}`);

      try {
        await Promise.race([
          PopupManager.getInstance().dismissAll(conn.page, { timeout: 5000, maxRounds: 3, verifyAfter: false }),
          new Promise<void>(resolve => setTimeout(resolve, 5000)),
        ]);
        console.log(`[BrowserPool]   弹窗已清除: ${name}`);
      } catch (e) {
        console.warn(`[BrowserPool]   弹窗清除失败 (${name}):`, (e as Error).message);
      }

      try {
        await EasyBRClient.getInstance().closeBrower(windowId);
      } catch (e) {
        console.warn(`[BrowserPool] EasyBR closeBrower 失败 (${name}):`, (e as Error).message);
      }

      await conn.browser.close().catch(() => {});
      this.connections.delete(windowId);

      conn.windowInfo.is_connected = 0;
      conn.windowInfo.updated_at = new Date().toISOString();
      this.db.upsertWindow(conn.windowInfo);

      this.manuallyClosed.add(windowId);

      this.windowBusy.delete(windowId);
      try {
        const { WindowLockManager } = require('./WindowLockManager');
        WindowLockManager.getInstance().release(windowId);
      } catch { /* ignore */ }
      console.log(`[BrowserPool]   已清理 p0/loginRequired/busy/connecting/lock`);
      this._clearWindowRuntime(windowId);

      return { isConnected: false };
    }

    const eb = EasyBRClient.getInstance();

    this.manuallyClosed.delete(windowId);

    this._setConnecting(windowId);

    const allWindows = this.listWindows();
    const win = allWindows.find(w => w.id === windowId);
    let browername = win?.name || windowId;

    if (!win) {
      const configs = await eb.getBrowerList();
      const name = configs.get(windowId);
      if (name) browername = name;
      if (!name) throw new Error(`窗口 ${windowId} 未在 EasyBR 配置中找到`);
    }

    console.log(`[BrowserPool] 🔄 打开窗口: ${browername}`);
    try {
      const { browser, page } = await this.connectAndSetupWindow(windowId, browername);

      const { role, site, staffName } = this.parseWindowName(browername);
      const windowInfo: WindowInfo = {
        id: windowId,
        name: browername,
        cdp_port: 0,
        role,
        site,
        staff_name: staffName,
        is_connected: 1,
        updated_at: new Date().toISOString(),
      };

      this.db.upsertWindow(windowInfo);
      this._setConnected(windowId, { browser, page, windowInfo });
      this.registerDisconnectHandler(windowId);
      SessionManager.getInstance().startHeartbeat(windowId, page);

      console.log(`[BrowserPool] ✓ 窗口已打开并连接: ${browername}`);
      return { isConnected: true };
    } catch (e) {
      console.error(`[BrowserPool] 打开窗口 "${browername}" 失败:`, (e as Error).message);
      this._clearReady(windowId);
      this._clearLoginRequired(windowId);
      throw e;
    } finally {
      this._clearConnecting(windowId);
    }
  }
}
