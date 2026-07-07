/**
 * BrowserProcessRegistry — Chrome 进程注册表
 *
 * Phase 5-C-5 追加修复：进程级确认关闭策略。
 *
 * 写入 runtime/browser-session.json，字段：
 *   - instanceId: V3 Agent 实例标识
 *   - pid: Chrome 进程 ID（spawn 返回的根进程）
 *   - debugPort: CDP 调试端口
 *   - executablePath: Chrome 可执行文件路径
 *   - userDataDir: 用户数据目录
 *   - startedAt: 启动时间
 *   - lastCloseFailed: 上次关闭是否失败
 *   - lastCloseError: 上次关闭失败原因
 *
 * 关闭策略：
 *   - 只有根 PID 已退出 + V3 userDataDir 无残留 chrome.exe，才 clearSession()
 *   - 关闭失败时保留 session 文件，写入 lastCloseFailed=true
 *   - 下次启动时先根据 registry 清理旧 V3 Chrome
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isSystemChromePath } from '../config';

export interface SessionRecord {
  instanceId: string;
  pid: number;
  debugPort: number;
  executablePath: string;
  userDataDir: string;
  startedAt: string;
  lastCloseFailed?: boolean;
  lastCloseError?: string;
}

const SESSION_FILE = path.resolve(
  __dirname, '..', '..', '..', '..', 'runtime', 'browser-session.json',
);

function generateInstanceId(): string {
  return `v3-agent-${crypto.randomBytes(4).toString('hex')}`;
}

export function saveSession(
  pid: number,
  debugPort: number,
  executablePath: string,
  userDataDir: string,
): SessionRecord {
  const runtimeDir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  const record: SessionRecord = {
    instanceId: generateInstanceId(),
    pid,
    debugPort,
    executablePath,
    userDataDir,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`  [BrowserProcessRegistry] 已记录 V3 Chrome 会话: PID=${pid}, 端口=${debugPort}`);
  return record;
}

export function readSession(): SessionRecord | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    const record = JSON.parse(raw) as SessionRecord;

    // M5-1: 如果 session 中记录了系统 Chrome 路径，标记为不可信
    if (record.executablePath && isSystemChromePath(record.executablePath)) {
      console.warn(
        `[BrowserProcessRegistry] ⚠️ browser-session.json 记录了系统 Chrome: ${record.executablePath}\n` +
        `  该 session 已被标记为 ignored（系统 Chrome 不允许作为 DaoPai V4 会话）。`,
      );
      // Mark as ignored — don't delete the file to avoid data loss,
      // but also don't trust this session for process recovery
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

/**
 * 标记本次关闭失败，保留 session 文件供下次启动清理
 */
export function markCloseFailed(error: string): void {
  try {
    const existing = readSession();
    if (!existing) return;

    existing.lastCloseFailed = true;
    existing.lastCloseError = error;

    fs.writeFileSync(SESSION_FILE, JSON.stringify(existing, null, 2), 'utf-8');
    console.log(`  [BrowserProcessRegistry] 关闭失败已记录: ${error}`);
  } catch {
    // 忽略写入失败
  }
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    // 忽略清理失败
  }
}
