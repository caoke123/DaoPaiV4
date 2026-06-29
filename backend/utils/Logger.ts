// 日志工具模块
// 操作结果以 JSONL 格式追加写入 ./runtime/logs/operations.jsonl
// bnsy-operator-next: runtime/logs 与生产项目 logs/ 完全隔离
import fs from 'fs-extra';
import path from 'path';

// 日志目录（bnsy-operator-next 专属 runtime/logs）
const LOG_DIR = path.join(process.cwd(), 'runtime', 'logs');

// 操作日志文件路径
const OPERATIONS_LOG = path.join(LOG_DIR, 'operations.jsonl');

// 日志条目结构
export interface LogEntry {
  timestamp: string;
  taskId: string;
  type: string;
  site: string;
  waybillNo: string;
  success: boolean;
  message: string;
}

/**
 * 追加写入操作日志（JSONL 格式）
 */
export async function appendOperationLog(entry: LogEntry): Promise<void> {
  await fs.ensureDir(LOG_DIR);
  await fs.appendFile(OPERATIONS_LOG, JSON.stringify(entry) + '\n', 'utf8');
}

/**
 * 批量追加写入操作日志
 */
export async function appendOperationLogBatch(entries: LogEntry[]): Promise<void> {
  await fs.ensureDir(LOG_DIR);
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(OPERATIONS_LOG, lines, 'utf8');
}

/**
 * 普通日志输出（带时间戳）
 */
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toISOString();
  const prefix = level === 'info' ? 'ℹ' : level === 'warn' ? '⚠' : '✗';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}
