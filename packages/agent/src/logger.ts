/**
 * 日志系统
 *
 * 同时输出控制台和文件日志。
 * 不打印执行电脑授权码、员工账号密码等敏感信息。
 */

import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');
const MAX_LOG_LINES = 10000; // 日志文件最大行数

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFn = (message: string, ...args: unknown[]) => void;

let currentLevel: LogLevel = 'info';
const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 初始化日志目录 */
export function initLogger(level: LogLevel = 'info'): void {
  currentLevel = level;

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // 日志滚动：超过最大行数时截断
  if (fs.existsSync(LOG_FILE)) {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      const kept = lines.slice(-MAX_LOG_LINES / 2);
      fs.writeFileSync(LOG_FILE, kept.join('\n') + '\n');
    }
  }
}

function shouldLog(level: LogLevel): boolean {
  return levelOrder[level] >= levelOrder[currentLevel];
}

function formatMessage(level: LogLevel, message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] ${message}`;
}

function writeLog(level: LogLevel, message: string): void {
  if (!shouldLog(level)) return;

  const formatted = formatMessage(level, message);

  // 控制台输出
  switch (level) {
    case 'error': console.error(formatted); break;
    case 'warn':  console.warn(formatted); break;
    default:      console.log(formatted); break;
  }

  // 文件输出
  try {
    fs.appendFileSync(LOG_FILE, formatted + '\n');
  } catch {
    // 写文件失败时不影响程序运行
  }
}

export const logger: Record<LogLevel, LogFn> = {
  debug: (msg, ...args) => writeLog('debug', args.length ? `${msg} ${args.join(' ')}` : msg),
  info:  (msg, ...args) => writeLog('info',  args.length ? `${msg} ${args.join(' ')}` : msg),
  warn:  (msg, ...args) => writeLog('warn',  args.length ? `${msg} ${args.join(' ')}` : msg),
  error: (msg, ...args) => writeLog('error', args.length ? `${msg} ${args.join(' ')}` : msg),
};

/** 安全日志：自动过滤敏感信息 */
export function safeLog(level: LogLevel, message: string, agentToken: string): void {
  // 过滤执行电脑授权码
  const safe = message.replace(agentToken, '***');
  logger[level](safe);
}