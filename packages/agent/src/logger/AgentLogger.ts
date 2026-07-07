/**
 * AgentLogger — Agent 端任务日志缓冲器
 * Phase 5-G-3: 解决日志真空期问题，采用 buffer + 定时/定量 flush
 *
 * 特性：
 *   - info/success/warning/error 四级日志
 *   - 内部 buffer 缓存，定时 flush（默认 1000ms）
 *   - 累计达到 maxBatchSize（默认 5 条）立即 flush
 *   - complete/fail 前必须 flush/close，保证最后日志不丢
 *   - flush 失败不阻塞主任务，只 console.warn
 *   - close() 清理定时器并 flush 剩余日志
 */

import type { AxiosInstance } from 'axios';
import { uploadLogs } from '../httpClient';

export type AgentLogLevel = 'info' | 'success' | 'warning' | 'error';

export interface AgentLogEntry {
  level: AgentLogLevel;
  message: string;
  timestamp: string;
  staffName?: string;
  windowId?: string;
  siteId?: string;
}

export interface AgentLoggerOptions {
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

export class AgentLogger {
  private readonly client: AxiosInstance;
  private readonly taskId: string;
  private readonly buffer: AgentLogEntry[] = [];
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private closed = false;

  constructor(client: AxiosInstance, taskId: string, options: AgentLoggerOptions = {}) {
    this.client = client;
    this.taskId = taskId;
    this.flushIntervalMs = options.flushIntervalMs ?? 1000;
    this.maxBatchSize = options.maxBatchSize ?? 5;

    this.startTimer();
  }

  private startTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  private stopTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private addToBuffer(level: AgentLogLevel, message: string, meta?: { staffName?: string; windowId?: string; siteId?: string }): void {
    if (this.closed) return;
    this.buffer.push({
      level,
      message: message.substring(0, 2000),
      timestamp: new Date().toISOString(),
      staffName: meta?.staffName,
      windowId: meta?.windowId,
      siteId: meta?.siteId,
    });

    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  info(message: string, meta?: { staffName?: string; windowId?: string; siteId?: string }): void {
    this.addToBuffer('info', message, meta);
  }

  success(message: string, meta?: { staffName?: string; windowId?: string; siteId?: string }): void {
    this.addToBuffer('success', message, meta);
  }

  warning(message: string, meta?: { staffName?: string; windowId?: string; siteId?: string }): void {
    this.addToBuffer('warning', message, meta);
  }

  error(message: string, meta?: { staffName?: string; windowId?: string; siteId?: string }): void {
    this.addToBuffer('error', message, meta);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.closed || this.buffer.length === 0) return;
    await this.flushInternal();
  }

  private async flushInternal(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      await uploadLogs(this.client, this.taskId, batch);
    } catch (err) {
      console.warn(`[AgentLogger] flush logs failed for task ${this.taskId}:`, (err as Error).message);
      this.buffer.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.stopTimer();
    await this.flushInternal();
    this.closed = true;
  }
}

export function createAgentLogger(
  client: AxiosInstance,
  taskId: string,
  options?: AgentLoggerOptions,
): AgentLogger {
  return new AgentLogger(client, taskId, options);
}
