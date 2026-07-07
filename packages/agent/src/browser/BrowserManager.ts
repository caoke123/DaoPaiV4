/**
 * BrowserManager — Agent 浏览器管理器
 *
 * Phase 5-C-1: 封装便携版 Chrome 的启动、CDP 连接、页面管理、健康检查与关闭。
 * Phase 5-C-5 追加修复：进程级确认关闭策略。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 禁止 taskkill /IM chrome.exe
 *   - 关闭前必须校验 PID 归属（executablePath + userDataDir）
 *   - 始终只保留一个标签页
 *   - 关闭成功标准：根 PID 已退出 + V3 userDataDir 无残留 chrome.exe
 */

import * as fs from 'fs';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { BrowserConfig } from '../types';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sanitizeChromeProfile } from './ChromeProfileSanitizer';
import {
  saveSession, readSession, clearSession, markCloseFailed,
} from './BrowserProcessRegistry';
import { isSystemChromePath, getChromeKind } from '../config';
import {
  checkPort,
  isProcessAlive,
  waitForProcessExit,
  findV3ChromeProcesses,
  killV3ChromeByPid,
} from './ChromeProcessGuard';

export interface BrowserHealthResult {
  connected: boolean;
  userAgent: string;
  pageUrl: string;
  title: string;
}

export interface CloseResult {
  success: boolean;
  pidBeforeClose: number | null;
  pidExistedAfterCdpClose: boolean;
  taskkillExecuted: boolean;
  pidExited: boolean;
  v3ResidualCount: number;
  message: string;
}

export class BrowserManager {
  private config: BrowserConfig;
  private chromeProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private closing = false;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  // ══════════════════════════════════════════════════════════
  // 1. start() — 启动便携版 Chrome（含安全前置检查）
  // ══════════════════════════════════════════════════════════

  /** Fix-2 R3: 暴露 Chrome 进程 PID，供外部精确使用（不依赖 session 文件） */
  getPid(): number | null {
    return this.chromeProcess?.pid || null;
  }

  /** Fix-2 R3: 暴露 Chrome 进程引用 */
  getProcess(): ChildProcess | null {
    return this.chromeProcess;
  }

  async start(): Promise<void> {
    const { executablePath, userDataDir, debugPort } = this.config;

    // 1a. 检查 chrome.exe 是否存在
    if (!fs.existsSync(executablePath)) {
      throw new Error(`未找到项目内便携版 Chrome，请检查路径：${executablePath}`);
    }

    // 1b. 启动前先清理上次残留的 V3 Chrome（根据 registry 或端口扫描）
    await this.cleanupStaleV3Chrome();

    // 1c. ChromeProfileSanitizer: 清理 Profile 防止原生弹窗
    console.log('  [ChromeProfileSanitizer] 清理 Profile...');
    await sanitizeChromeProfile(userDataDir);

    // 1d. 创建独立用户目录
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // 1e. 启动 Chrome（完整压制原生弹窗的启动参数，末尾不加 about:blank 避免多余标签）
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--disable-save-password-bubble',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-features=Translate,PasswordManagerOnboarding,AutofillServerCommunication,AutofillAddressSavePrompt,AutofillCreditCardUpload,OptimizationHints',
      '--password-store=basic',
      '--use-mock-keychain',
    ];

    this.chromeProcess = spawn(executablePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    this.chromeProcess.on('error', (err) => {
      throw new Error(`Chrome 进程启动失败：${err.message}`);
    });

    const pid = this.chromeProcess.pid;
    if (!pid) {
      throw new Error('Chrome 进程启动后无法获取 PID');
    }

    // 1f. BrowserProcessRegistry: 记录 V3 Chrome 身份
    saveSession(pid, debugPort, executablePath, userDataDir);

    const kind = getChromeKind(executablePath);
    console.log(`  Chrome 启动成功，PID: ${pid}, chromeKind: ${kind}`);
    console.log(`  chromePath: ${executablePath}`);
    console.log(`  调试端口：${debugPort}`);
    console.log(`  用户目录：${userDataDir}`);
  }

  /**
   * 启动前清理上次残留的 V3 Chrome
   * 根据 registry session 和 V3 残留进程扫描
   */
  private async cleanupStaleV3Chrome(): Promise<void> {
    const { debugPort, userDataDir } = this.config;

    // 1. 检查 registry 中是否有上次未关闭的 session
    const session = readSession();
    if (session && session.lastCloseFailed) {
      console.log(`  [ChromeProcessGuard] 检测到上次关闭失败: ${session.lastCloseError}`);
      console.log(`  [ChromeProcessGuard] 清理残留 V3 Chrome (PID: ${session.pid})...`);
      if (await isProcessAlive(session.pid)) {
        const killResult = await killV3ChromeByPid(session.pid);
        console.log(`  ${killResult.message}`);
        await waitForProcessExit(session.pid, 5000);
      }
      clearSession();
    } else if (session) {
      // 旧 session 存在但无失败标记，也清理
      if (await isProcessAlive(session.pid)) {
        console.log(`  [ChromeProcessGuard] 清理旧 V3 Chrome (PID: ${session.pid})...`);
        const killResult = await killV3ChromeByPid(session.pid);
        console.log(`  ${killResult.message}`);
        await waitForProcessExit(session.pid, 5000);
      }
      clearSession();
    }

    // 2. 扫描 V3 Chrome 残留进程
    const residuals = findV3ChromeProcesses(userDataDir);
    if (residuals.length > 0) {
      console.log(`  [ChromeProcessGuard] 发现 ${residuals.length} 个 V3 Chrome 残留进程，清理...`);
      for (const r of residuals) {
        const killResult = await killV3ChromeByPid(r.pid);
        console.log(`  ${killResult.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 3. 检查端口归属
    console.log('  [ChromeProcessGuard] 检查端口归属...');
    const portCheck = checkPort(debugPort);
    if (portCheck.occupied && !portCheck.isV3Chrome) {
      throw new Error(
        `端口 ${debugPort} 被非 V3 Chrome 占用，禁止连接。\n` +
        `  占用进程 PID: ${portCheck.pid}\n` +
        `  占用进程路径: ${portCheck.executablePath}\n` +
        `  请先关闭占用端口的 Chrome 进程后重试。`
      );
    }
    if (portCheck.occupied && portCheck.isV3Chrome) {
      console.log(`  [ChromeProcessGuard] 端口 ${debugPort} 由 V3 Chrome 占用 (PID: ${portCheck.pid})，将先关闭旧实例`);
      const killOld = await killV3ChromeByPid(portCheck.pid!);
      if (killOld.success) {
        console.log(`  ${killOld.message}`);
        await waitForProcessExit(portCheck.pid!, 5000);
      } else {
        throw new Error(`无法关闭旧 V3 Chrome 实例: ${killOld.message}`);
      }
    } else {
      console.log(`  [ChromeProcessGuard] ${portCheck.message}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // 2. connect() — 等待 CDP 就绪、连接、清理多余标签，只保留一个
  // ══════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    const { debugPort } = this.config;
    const cdp = `http://127.0.0.1:${debugPort}`;

    // 等待 CDP 就绪（最多 15 秒）
    await this.waitForCdp(cdp, 15_000);

    // 通过 Playwright connectOverCDP 连接
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.connectOverCDP(cdp);
    console.log('  Playwright CDP 连接成功');

    // 清理多余标签页，只保留一个空白页
    await this.pruneToSingleTab();
  }

  /**
   * 关闭所有多余标签页，只保留一个空白标签页
   */
  private async pruneToSingleTab(): Promise<void> {
    if (!this.browser) return;

    const context = this.browser.contexts()[0] || await this.browser.newContext();
    const pages = context.pages();

    console.log(`  当前标签页数量: ${pages.length}`);

    // 先创建一个新的空白页，再关闭其他所有页
    const keepPage = await context.newPage();
    await keepPage.goto('about:blank', { waitUntil: 'domcontentloaded' });

    for (const p of pages) {
      try {
        await p.close({ runBeforeUnload: false });
      } catch {
        // 忽略关闭错误
      }
    }

    this.page = keepPage;
    console.log('  已清理为单标签页');
  }

  private async waitForCdp(cdpUrl: string, maxWaitMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const raw = await this.httpGet(`${cdpUrl}/json/version`);
        const info = JSON.parse(raw);
        console.log(`  CDP 就绪，Browser: ${info.Browser}`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`CDP 连接超时（${maxWaitMs}ms），请检查 Chrome 是否正常启动`);
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  // 3. 页面管理
  // ══════════════════════════════════════════════════════════

  async getOrCreatePage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }
    if (!this.page) {
      const context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = await context.newPage();
    }
    return this.page;
  }

  getPage(): Page | null {
    return this.page;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  async openPage(url: string): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }
    if (!this.page) {
      const context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = await context.newPage();
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.page;
  }

  async getCurrentPageInfo(): Promise<{ url: string; title: string; bodyText: string }> {
    if (!this.page) {
      throw new Error('页面未初始化，请先调用 openPage() 或 getOrCreatePage()');
    }
    const url = this.page.url();
    const title = await this.page.title();
    const bodyText = await this.page.evaluate(() => {
      const body = document.body;
      return body ? body.innerText.substring(0, 500) : '';
    });
    return { url, title, bodyText };
  }

  async healthCheck(): Promise<BrowserHealthResult> {
    if (!this.page) {
      return { connected: false, userAgent: '', pageUrl: '', title: '' };
    }
    try {
      const userAgent = await this.page.evaluate(() => navigator.userAgent);
      const title = await this.page.evaluate(() => document.title);
      const pageUrl = this.page.url();
      return { connected: true, userAgent, pageUrl, title };
    } catch {
      return { connected: false, userAgent: '', pageUrl: '', title: '' };
    }
  }

  // ══════════════════════════════════════════════════════════
  // 4. connectExisting() — Phase K-3A-2: 通过 CDP 接管已有 READY 窗口
  // ══════════════════════════════════════════════════════════

  /**
   * 通过 CDP 连接已有 Backend READY 窗口
   *
   * 不启动新 browser 进程，不调用 launch / start。
   * 复用已有 context / page，优先选择非 about:blank 的业务页。
   *
   * 禁止用于 Phase K Agent business execution 之外的场景。
   */
  static async connectExisting(cdpEndpoint: string): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
  }> {
    const maskedEndpoint = cdpEndpoint.replace(/:\/\/.*?:/, '://***:');
    console.log(`[Agent][Browser] connectExisting start cdpEndpoint=${maskedEndpoint}`);

    const { chromium } = await import('playwright-core');
    let browser: Browser;

    try {
      browser = await chromium.connectOverCDP(cdpEndpoint);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[Agent][Browser] connectExisting failed reason=${msg}`);
      throw new Error(`CDP_CONNECT_FAILED: ${msg}`);
    }

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    const allPages = context.pages();
    console.log(`[Agent][Browser] connectExisting success pages=${allPages.length}`);

    // 优先选择非 about:blank 的业务页
    let targetPage: Page | null = null;

    if (allPages.length > 0) {
      // 优先选择笨鸟业务域名页面
      for (const p of allPages) {
        try {
          const url = p.url();
          if (url && !url.startsWith('about:') && url.includes('benniaosuyun.com')) {
            targetPage = p;
            break;
          }
        } catch {
          // 忽略不可达页面
        }
      }
      // 回退到第一个非 about:blank 页面
      if (!targetPage) {
        for (const p of allPages) {
          try {
            const url = p.url();
            if (url && !url.startsWith('about:')) {
              targetPage = p;
              break;
            }
          } catch {
            // 忽略
          }
        }
      }
      // 最后使用第一个页面
      if (!targetPage) {
        targetPage = allPages[0];
      }
    } else {
      // 没有页面则创建（仍在同一个 CDP browser 内）
      targetPage = await context.newPage();
    }

    return { browser, context, page: targetPage };
  }

  // ══════════════════════════════════════════════════════════
  // 5. close() — 进程级确认关闭策略
  // ══════════════════════════════════════════════════════════

  async close(): Promise<CloseResult> {
    const { userDataDir } = this.config;
    const result: CloseResult = {
      success: false,
      pidBeforeClose: null,
      pidExistedAfterCdpClose: false,
      taskkillExecuted: false,
      pidExited: false,
      v3ResidualCount: 0,
      message: '',
    };

    // 防止重复关闭
    if (this.closing) {
      result.message = '已在关闭中，跳过重复调用';
      return result;
    }
    this.closing = true;

    // 5a. 读取 registry 中的 PID
    const session = readSession();
    const registryPid = session?.pid || null;
    const spawnPid = this.chromeProcess?.pid || null;
    const pidBeforeClose = registryPid || spawnPid;
    result.pidBeforeClose = pidBeforeClose;

    console.log(`  [close] registry PID: ${registryPid}, spawn PID: ${spawnPid}`);

    // 5b. 尝试 browser.close()（CDP Browser.close）
    let browserCloseCalled = false;
    if (this.browser) {
      try {
        await this.browser.close();
        browserCloseCalled = true;
        console.log('  [close] browser.close() 已调用');
      } catch {
        console.log('  [close] browser.close() 失败，忽略');
      }
      this.browser = null;
      this.page = null;
    }

    // 5c. 等待根进程 PID 退出，最多 5 秒
    if (pidBeforeClose) {
      console.log(`  [close] 等待 PID ${pidBeforeClose} 退出（最多 5 秒）...`);
      const exited = await waitForProcessExit(pidBeforeClose, 5000);
      result.pidExistedAfterCdpClose = !exited;

      if (exited) {
        console.log(`  [close] PID ${pidBeforeClose} 已退出`);
        result.pidExited = true;
      } else {
        // 5d. PID 仍存在，校验并 taskkill
        console.log(`  [close] PID ${pidBeforeClose} 仍存在，校验并强制关闭...`);
        result.taskkillExecuted = true;
        const killResult = await killV3ChromeByPid(pidBeforeClose);
        console.log(`  [close] ${killResult.message}`);

        // 5e. 再等待 PID 退出，最多 5 秒
        const exitedAfterKill = await waitForProcessExit(pidBeforeClose, 5000);
        result.pidExited = exitedAfterKill;
        if (exitedAfterKill) {
          console.log(`  [close] PID ${pidBeforeClose} 已被关闭`);
        } else {
          console.warn(`  [close] PID ${pidBeforeClose} 仍然存活`);
        }
      }
    }

    this.chromeProcess = null;

    // 5f. 扫描是否仍存在 commandLine 包含 V3 userDataDir 的 chrome.exe
    const residuals = findV3ChromeProcesses(userDataDir);
    result.v3ResidualCount = residuals.length;

    if (residuals.length > 0) {
      console.warn(`  [close] 仍有 ${residuals.length} 个 V3 Chrome 残留进程:`);
      for (const r of residuals) {
        console.warn(`    PID: ${r.pid}, 路径: ${r.executablePath}`);
      }

      // 尝试清理残留
      for (const r of residuals) {
        const killResult = await killV3ChromeByPid(r.pid);
        console.log(`  [close] ${killResult.message}`);
      }
      await new Promise((r) => setTimeout(r, 1000));

      // 再次扫描
      const stillResiduals = findV3ChromeProcesses(userDataDir);
      result.v3ResidualCount = stillResiduals.length;

      if (stillResiduals.length > 0) {
        result.success = false;
        result.message = `关闭失败：仍有 ${stillResiduals.length} 个 V3 Chrome 残留进程`;
        console.warn(`  [close] ${result.message}`);
        markCloseFailed(result.message);
        this.closing = false;
        return result;
      }
    }

    // 5g. 确认关闭成功
    result.success = true;
    result.message = 'Chrome 已关闭，无 V3 残留进程';
    console.log(`  [close] ${result.message}`);

    clearSession();
    this.closing = false;
    return result;
  }
}
