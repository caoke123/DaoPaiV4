/**
 * BrowserManager — Agent 浏览器管理器
 *
 * Phase 5-C-1: 封装便携版 Chrome 的启动、CDP 连接、页面管理、健康检查与关闭。
 * Phase 5-C-5 修复版：集成 ChromeProfileSanitizer、BrowserProcessRegistry、ChromeProcessGuard。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 禁止 taskkill /IM chrome.exe
 *   - 关闭前必须校验 PID 归属
 */

import * as fs from 'fs';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { BrowserConfig } from '../types';
import type { Browser, Page } from 'playwright-core';
import { sanitizeChromeProfile } from './ChromeProfileSanitizer';
import { saveSession, readSession, clearSession } from './BrowserProcessRegistry';
import { checkPort, canKillProcess, killProcess } from './ChromeProcessGuard';

export interface BrowserHealthResult {
  connected: boolean;
  userAgent: string;
  pageUrl: string;
  title: string;
}

export class BrowserManager {
  private config: BrowserConfig;
  private chromeProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  // ══════════════════════════════════════════════════════════
  // 1. start() — 启动便携版 Chrome（含安全前置检查）
  // ══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const { executablePath, userDataDir, debugPort } = this.config;

    // 1a. 检查 chrome.exe 是否存在
    if (!fs.existsSync(executablePath)) {
      throw new Error(`未找到项目内便携版 Chrome，请检查路径：${executablePath}`);
    }

    // 1b. ChromeProcessGuard: 检查端口归属
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
      console.log(`  [ChromeProcessGuard] 端口 ${debugPort} 由 V3 Chrome 占用 (PID: ${portCheck.pid})，将复用`);
    } else {
      console.log(`  [ChromeProcessGuard] ${portCheck.message}`);
    }

    // 1c. ChromeProfileSanitizer: 清理 Profile 防止原生弹窗
    console.log('  [ChromeProfileSanitizer] 清理 Profile...');
    await sanitizeChromeProfile(userDataDir);

    // 1d. 创建独立用户目录
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // 1e. 启动 Chrome（完整压制原生弹窗的启动参数）
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
      'about:blank',
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

    console.log(`  便携版 Chrome 启动成功，PID: ${pid}`);
    console.log(`  调试端口：${debugPort}`);
    console.log(`  用户目录：${userDataDir}`);
  }

  // ══════════════════════════════════════════════════════════
  // 2. connect() — 等待 CDP 就绪并连接
  // ══════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    const { debugPort } = this.config;
    const cdp = `http://127.0.0.1:${debugPort}`;

    // 等待 CDP 就绪（最多 10 秒）
    await this.waitForCdp(cdp, 10_000);

    // 通过 Playwright connectOverCDP 连接
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.connectOverCDP(cdp);
    console.log('  Playwright CDP 连接成功');
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
  // 3. getOrCreatePage() — 获取或创建页面
  // ══════════════════════════════════════════════════════════

  async getOrCreatePage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }

    const context = this.browser.contexts()[0] || this.browser.newContext();
    const pages = context.pages();
    this.page = pages.length > 0 ? pages[0] : await context.newPage();

    // 默认打开 about:blank
    await this.page.goto('about:blank', { waitUntil: 'domcontentloaded' });

    return this.page;
  }

  /** 获取当前页面（不创建新页面） */
  getPage(): Page | null {
    return this.page;
  }

  /** 获取 Browser 实例 */
  getBrowser(): Browser | null {
    return this.browser;
  }

  // ══════════════════════════════════════════════════════════
  // 3b. openPage() — 打开指定 URL
  // ══════════════════════════════════════════════════════════

  async openPage(url: string): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }

    const context = this.browser.contexts()[0] || this.browser.newContext();
    const pages = context.pages();
    this.page = pages.length > 0 ? pages[0] : await context.newPage();

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    return this.page;
  }

  // ══════════════════════════════════════════════════════════
  // 3c. getCurrentPageInfo() — 获取当前页面信息
  // ══════════════════════════════════════════════════════════

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

  // ══════════════════════════════════════════════════════════
  // 4. healthCheck() — 基础健康检查
  // ══════════════════════════════════════════════════════════

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
  // 5. close() — 安全关闭连接和 Chrome 进程
  // ══════════════════════════════════════════════════════════

  async close(): Promise<void> {
    const { debugPort } = this.config;

    // 5a. 关闭 Playwright CDP 连接
    if (this.browser) {
      try {
        await this.browser.close();
        console.log('  Playwright 连接已关闭');
      } catch {
        // 忽略关闭错误
      }
      this.browser = null;
      this.page = null;
    }

    // 5b. 通过端口查找实际 Chrome PID（spawn PID 可能已退出，实际窗口 PID 不同）
    console.log('  [ChromeProcessGuard] 通过端口查找实际 Chrome PID...');
    const portCheck = checkPort(debugPort);

    if (!portCheck.occupied || !portCheck.pid) {
      console.log('  端口已释放，Chrome 已退出');
      clearSession();
      this.chromeProcess = null;
      return;
    }

    const actualPid = portCheck.pid;
    console.log(`  实际 Chrome PID: ${actualPid}`);

    // 5c. 校验是否是 V3 Chrome
    if (!portCheck.isV3Chrome) {
      console.log(`  [ChromeProcessGuard] ${portCheck.message}`);
      console.log('  拒绝关闭，请手动处理残留的 Chrome 进程');
      clearSession();
      return;
    }

    // 5d. 等待 Chrome 自然退出（给 CDP close 一点时间生效）
    console.log('  等待 Chrome 自然退出...');
    await new Promise((r) => setTimeout(r, 2000));

    // 5e. 再次检查端口是否释放
    const recheck = checkPort(debugPort);
    if (!recheck.occupied) {
      console.log('  Chrome 已自然退出，窗口已关闭');
      clearSession();
      this.chromeProcess = null;
      return;
    }

    // 5f. 仍未退出，强制关闭
    console.log(`  [ChromeProcessGuard] 强制关闭 V3 Chrome (PID: ${actualPid})...`);
    const killResult = killProcess(actualPid);
    if (killResult.success) {
      console.log(`  ${killResult.message}`);
    } else {
      console.warn(`  ${killResult.message}`);
    }

    // 5g. 清理注册表
    clearSession();
    this.chromeProcess = null;
  }
}