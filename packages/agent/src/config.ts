/**
 * 配置加载与校验
 *
 * 读取 agent.json，校验必填字段，输出 AgentConfig。
 * M5-1A: localRoot 稳定解析 — 优先 ENV → 自动向上查找 → legacy 回退
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig, BrowserConfig, BnsyConfig, ChromeKind } from './types';

const CONFIG_FILE = path.resolve(__dirname, '..', 'agent.json');
const CONFIG_EXAMPLE = path.resolve(__dirname, '..', 'agent.example.json');

/** M5-1A: 记录 localRoot 是通过哪种方式解析到的 */
export type RootResolveMethod = 'env' | 'auto-search' | 'legacy-relative';

let _rootResolveMethod: RootResolveMethod = 'legacy-relative';

export function getRootResolveMethod(): RootResolveMethod {
  return _rootResolveMethod;
}

/** M5-1A: 在目录 dir 中查找 Chrome/App/chrome.exe */
function hasPortableChrome(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'Chrome', 'App', 'chrome.exe'));
}

/** M5-1A: 从 startDir 开始向上查找包含 Chrome/App/chrome.exe 的目录 */
function findLocalRootBySearch(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  for (let i = 0; i < 10; i++) {
    if (hasPortableChrome(current)) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

/** D-0B / M5-1A: Local root directory for DaoPai local runtime */
export function getLocalRoot(): string {
  // 1. ENV override (highest priority)
  const envRoot = process.env.DAOPAI_LOCAL_ROOT;
  if (envRoot && hasPortableChrome(envRoot)) {
    _rootResolveMethod = 'env';
    return envRoot;
  }
  if (envRoot) {
    console.warn(`[Config] DAOPAI_LOCAL_ROOT=${envRoot} 但该目录下未找到 Chrome/App/chrome.exe，将尝试自动搜索`);
  }

  // 2. Auto-search upward from __dirname or process.cwd()
  const found = findLocalRootBySearch(__dirname) || findLocalRootBySearch(process.cwd());
  if (found) {
    _rootResolveMethod = 'auto-search';
    return found;
  }

  // 3. Legacy fallback (kept for backward compatibility)
  const legacy = path.resolve(__dirname, '..', '..', '..');
  _rootResolveMethod = 'legacy-relative';
  console.warn(
    `[Config] 无法通过 ENV 或自动搜索定位 localRoot，使用 legacy 回退: ${legacy}\n` +
    `  建议设置环境变量 DAOPAI_LOCAL_ROOT 指向项目根目录。`,
  );
  return legacy;
}

/** D-0B: Export the loaded config for use by other modules (e.g. ChromeProcessGuard) */
let _cachedConfig: AgentConfig | null = null;

export function getConfig(): AgentConfig {
  if (!_cachedConfig) {
    _cachedConfig = loadConfig();
  }
  return _cachedConfig;
}

/** 默认配置 */
const DEFAULTS: Partial<AgentConfig> = {
  logLevel: 'info',
  heartbeatIntervalMs: 1000,
  taskPollIntervalMs: 1000,
};

/**
 * 加载并校验配置文件
 */
export function loadConfig(): AgentConfig {
  // 1. 检查配置文件是否存在
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('错误：缺少配置文件 agent.json');
    console.error(`请复制 ${CONFIG_EXAMPLE} 为 ${CONFIG_FILE}`);
    console.error('并填入执行电脑授权码');
    process.exit(1);
  }

  // 2. 读取并解析 JSON
  let raw: Record<string, unknown>;
  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    console.error('错误：agent.json 格式不正确，请检查 JSON 语法');
    console.error((err as Error).message);
    process.exit(1);
  }

  // 3. 校验必填字段
  const cloudBaseUrl = typeof raw.cloudBaseUrl === 'string'
    ? raw.cloudBaseUrl
    : (typeof raw.cloudApiUrl === 'string' ? raw.cloudApiUrl : '');

  if (!cloudBaseUrl) {
    console.error('错误：缺少 cloudBaseUrl/cloudApiUrl，请检查 agent.json');
    process.exit(1);
  }

  if (!raw.agentToken || typeof raw.agentToken !== 'string' || raw.agentToken === '请填入执行电脑授权码' || raw.agentToken === 'agent_token_xxx') {
    console.error('错误：缺少执行电脑授权码，请检查 agent.json');
    console.error('请从 Cloud 管理后台获取执行电脑授权码，并填入 agent.json 的 agentToken 字段');
    process.exit(1);
  }

  // 4. 合并默认值
  const browser = loadBrowserConfig(raw.browser);
  const bnsy = loadBnsyConfig(raw.bnsy);

  const config: AgentConfig = {
    cloudBaseUrl,
    cloudApiUrl: typeof raw.cloudApiUrl === 'string' ? raw.cloudApiUrl : cloudBaseUrl,
    tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : undefined,
    workstationId: typeof raw.workstationId === 'string' ? raw.workstationId : undefined,
    agentToken: raw.agentToken as string,
    workstationName: (raw.workstationName as string) || '未命名执行电脑',
    siteId: (raw.siteId as string) || null,
    settingsPath: (raw.settingsPath as string) || undefined,
    browser,
    bnsy,
    logLevel: validateLogLevel(raw.logLevel),
    heartbeatIntervalMs: validatePositiveInt(raw.heartbeatIntervalMs, DEFAULTS.heartbeatIntervalMs!, '心跳间隔'),
    taskPollIntervalMs: validatePositiveInt(raw.taskPollIntervalMs ?? raw.pollIntervalMs, DEFAULTS.taskPollIntervalMs!, '任务轮询间隔'),
  };

  _cachedConfig = config;
  return config;
}

function validateLogLevel(value: unknown): AgentConfig['logLevel'] {
  const valid = ['debug', 'info', 'warn', 'error'];
  if (typeof value === 'string' && valid.includes(value)) {
    return value as AgentConfig['logLevel'];
  }
  return 'info';
}

function validatePositiveInt(value: unknown, defaultVal: number, name: string): number {
  if (typeof value === 'number' && value > 0 && Number.isInteger(value)) {
    return value;
  }
  console.warn(`警告：${name} 配置无效，使用默认值 ${defaultVal}ms`);
  return defaultVal;
}

/**
 * M5-1: Check if a given executablePath points to a system Chrome installation.
 * System Chrome paths include:
 *   - C:/Program Files/Google/Chrome/Application/chrome.exe
 *   - C:/Program Files (x86)/Google/Chrome/Application/chrome.exe
 *   - ~/AppData/Local/Google/Chrome/Application/chrome.exe
 */
const SYSTEM_CHROME_PATTERNS = [
  /\\Program Files\\Google\\Chrome\\Application\\chrome\.exe$/i,
  /\\Program Files \(x86\)\\Google\\Chrome\\Application\\chrome\.exe$/i,
  /\\AppData\\Local\\Google\\Chrome\\Application\\chrome\.exe$/i,
];

export function isSystemChromePath(p: string): boolean {
  if (!p) return false;
  const normalized = path.resolve(p);
  return SYSTEM_CHROME_PATTERNS.some((re) => re.test(normalized));
}

/**
 * M5-1: Determine the chromeKind from the resolved executable path.
 */
export function getChromeKind(executablePath: string): ChromeKind {
  if (!executablePath) return 'unknown';
  if (isSystemChromePath(executablePath)) return 'system';
  if (!fs.existsSync(executablePath)) return 'unknown';
  return 'portable';
}

/**
 * M5-1: Validate that the Chrome executable is not a system Chrome.
 * In production mode, system Chrome is forbidden.
 * In dev mode, it's allowed only if devAllowSystemChrome=true is explicitly set.
 */
export function validateChromePath(executablePath: string): void {
  if (!isSystemChromePath(executablePath)) return;

  const isDev = process.env.NODE_ENV !== 'production';
  const devAllow = process.env.DEV_ALLOW_SYSTEM_CHROME === 'true';
  const agentAllow = process.env.AGENT_ALLOW_SYSTEM_CHROME === 'true';

  if ((isDev && devAllow) || agentAllow) {
    console.warn(
      `[Config][Chrome] ⚠️  开发模式允许系统 Chrome（devAllowSystemChrome=true）\n` +
      `  chromePath = ${executablePath}\n` +
      `  此配置仅用于开发调试，生产环境将拒绝启动。`,
    );
    return;
  }

  console.error(
    `[Config][Chrome] ❌ 系统 Chrome 不能作为 DaoPai V4 Agent 默认浏览器。\n` +
    `  检测到路径: ${executablePath}\n` +
    `  请配置项目内便携版 Chrome 路径，例如: {localRoot}/Chrome/App/chrome.exe\n` +
    `  如果确需在开发模式下临时使用系统 Chrome，请设置环境变量 DEV_ALLOW_SYSTEM_CHROME=true`,
  );
  process.exit(1);
}

function loadBrowserConfig(raw: unknown): BrowserConfig {
  const defaults: BrowserConfig = {
    executablePath: '',
    userDataDir: '',
    debugPort: 9223,
    headless: false,
  };

  if (!raw || typeof raw !== 'object') {
    console.error('错误：缺少 browser 配置，请检查 agent.json');
    console.error('请确保 agent.json 中有 browser.executablePath 和 browser.userDataDir');
    process.exit(1);
  }

  const b = raw as Record<string, unknown>;

  const executablePath = (b.executablePath as string) || '';
  if (!executablePath) {
    console.error('错误：缺少 browser.executablePath，请检查 agent.json');
    console.error('示例：chrome/chrome.exe');
    process.exit(1);
  }

  const userDataDir = (b.userDataDir as string) || '';
  if (!userDataDir) {
    console.error('错误：缺少 browser.userDataDir，请检查 agent.json');
    console.error('示例：profiles/default');
    process.exit(1);
  }

  // D-0B: resolve relative paths against local root
  const localRoot = process.env.DAOPAI_LOCAL_ROOT || path.resolve(__dirname, '..', '..', '..');
  const resolvePath = (p: string) => path.isAbsolute(p) ? p : path.resolve(localRoot, p);

  const resolvedExecutablePath = resolvePath(executablePath);

  // M5-1: 在生产模式下禁止系统 Chrome
  validateChromePath(resolvedExecutablePath);

  return {
    executablePath: resolvedExecutablePath,
    userDataDir: resolvePath(userDataDir),
    debugPort: typeof b.debugPort === 'number' && b.debugPort > 0 ? b.debugPort : defaults.debugPort,
    headless: typeof b.headless === 'boolean' ? b.headless : defaults.headless,
  };
}

function loadBnsyConfig(raw: unknown): BnsyConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const b = raw as Record<string, unknown>;
  const loginUrl = (b.loginUrl as string) || '';

  if (!loginUrl) {
    return undefined;
  }

  if (!loginUrl.startsWith('http://') && !loginUrl.startsWith('https://')) {
    console.warn('警告：bnsy.loginUrl 格式不正确，必须是 http/https 地址');
    return undefined;
  }

  return { loginUrl };
}
