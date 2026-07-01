/**
 * 配置加载与校验
 *
 * 读取 agent.json，校验必填字段，输出 AgentConfig。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfig, BrowserConfig, BnsyConfig } from './types';

const CONFIG_FILE = path.resolve(__dirname, '..', 'agent.json');
const CONFIG_EXAMPLE = path.resolve(__dirname, '..', 'agent.example.json');

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
  if (!raw.cloudBaseUrl || typeof raw.cloudBaseUrl !== 'string') {
    console.error('错误：缺少 cloudBaseUrl，请检查 agent.json');
    process.exit(1);
  }

  if (!raw.agentToken || typeof raw.agentToken !== 'string' || raw.agentToken === '请填入执行电脑授权码') {
    console.error('错误：缺少执行电脑授权码，请检查 agent.json');
    console.error('请从 Cloud 管理后台获取执行电脑授权码，并填入 agent.json 的 agentToken 字段');
    process.exit(1);
  }

  // 4. 合并默认值
  const browser = loadBrowserConfig(raw.browser);
  const bnsy = loadBnsyConfig(raw.bnsy);

  const config: AgentConfig = {
    cloudBaseUrl: raw.cloudBaseUrl as string,
    agentToken: raw.agentToken as string,
    workstationName: (raw.workstationName as string) || '未命名执行电脑',
    siteId: (raw.siteId as string) || null,
    settingsPath: (raw.settingsPath as string) || undefined,
    browser,
    bnsy,
    logLevel: validateLogLevel(raw.logLevel),
    heartbeatIntervalMs: validatePositiveInt(raw.heartbeatIntervalMs, DEFAULTS.heartbeatIntervalMs!, '心跳间隔'),
    taskPollIntervalMs: validatePositiveInt(raw.taskPollIntervalMs, DEFAULTS.taskPollIntervalMs!, '任务轮询间隔'),
  };

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
    console.error('示例：E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe');
    process.exit(1);
  }

  const userDataDir = (b.userDataDir as string) || '';
  if (!userDataDir) {
    console.error('错误：缺少 browser.userDataDir，请检查 agent.json');
    console.error('示例：E:/网站开发/DaoPaiV3/runtime/chrome-profile');
    process.exit(1);
  }

  return {
    executablePath,
    userDataDir,
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