/**
 * AgentWsClient — Agent WebSocket 实时通信客户端 (Deploy-0D-S2)
 *
 * 职责：
 *   1. 连接 Cloud /agent/ws
 *   2. 发送 hello (tenantId + workstationId + agentVersion)
 *   3. 定时心跳 (ping/pong)
 *   4. 接收 window_command 推送 → 触发回调
 *   5. 回传 ack/running/window_status/done/failed
 *   6. 断线自动重连
 *
 * 约束：
 *   - WebSocket 仅作实时通知通道，不绕过 window_commands 持久化
 *   - 收到 WS notification 后仍走现有 claim/pull 原子逻辑
 *   - 断线时 HTTPS poll 兜底
 */

import WebSocket from 'ws';
import { getConfig } from '../config';
import { logTrace, warnTrace } from '../trace';

export interface WsCommand {
  id: string;
  type: 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';
  siteId: string;
  windowId: string;
  staffName: string;
  tenantId: string;
  workstationId: string;
}

export type WsCommandHandler = (command: WsCommand) => void | Promise<void>;

export interface WsTaskAvailable {
  id: string;
  type: string;
  siteId: string;
  tenantId: string;
  workstationId: string;
}

export type WsTaskHandler = (task: WsTaskAvailable) => void | Promise<void>;

export interface AgentWsClientOptions {
  tenantId: string;
  workstationId: string;
  agentVersion: string;
  onCommand: WsCommandHandler;
  onTaskAvailable?: WsTaskHandler;
  /** Agent 重连后触发的补偿拉取回调 */
  onReconnect?: () => void | Promise<void>;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

export class AgentWsClient {
  private ws: WebSocket | null = null;
  private opts: AgentWsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private connected = false;
  private connectionId: string | null = null;

  constructor(opts: AgentWsClientOptions) {
    this.opts = opts;
  }

  /** 获取连接状态 */
  isConnected(): boolean {
    return this.connected;
  }

  /** 启动连接 */
  connect(): void {
    this.clearTimers();
    this.doConnect().catch(() => {});
  }

  /** 断开连接 */
  disconnect(): void {
    this.connected = false;
    this.clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'agent shutdown'); } catch {}
      this.ws = null;
    }
  }

  /** 发送消息 */
  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ══════════════════════════════════════════════════════════
  // Private
  // ══════════════════════════════════════════════════════════

  private async doConnect(): Promise<void> {
    const config = getConfig();
    const cloudUrl = config.cloudBaseUrl;
    const wsUrl = cloudUrl.replace(/^http/, 'ws') + '/agent/ws';

    console.log(`[AgentWS] 连接 ${wsUrl}`);
    logTrace('agent-ws', 'connect_start', { wsUrl });

    return new Promise<void>((resolve) => {
      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        console.warn(`[AgentWS] 连接失败: ${(err as Error).message}`);
        warnTrace('agent-ws', 'connect_failed', { wsUrl, error: (err as Error).message });
        this.scheduleReconnect();
        resolve();
        return;
      }

      this.ws.on('open', () => {
        console.log('[AgentWS] 已连接，发送 hello');
        logTrace('agent-ws', 'socket_open', {
          tenantId: this.opts.tenantId,
          workstationId: this.opts.workstationId,
        });
        // 发送 hello
        this.ws!.send(JSON.stringify({
          type: 'hello',
          tenantId: this.opts.tenantId,
          workstationId: this.opts.workstationId,
          agentVersion: this.opts.agentVersion,
        }));
      });

      this.ws.on('message', async (raw) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        switch (msg.type) {
          case 'hello_ack':
            this.connected = true;
            this.reconnectDelay = RECONNECT_BASE_MS;
            this.connectionId = (msg.connectionId as string) || null;
            console.log(`[AgentWS] hello ack: ${this.connectionId || 'ok'}`);
            logTrace('agent-ws', 'hello_ack', {
              tenantId: this.opts.tenantId,
              workstationId: this.opts.workstationId,
              connectionId: this.connectionId || undefined,
            });
            this.startPing();
            // reconnected → trigger pull compensation
            this.opts.onReconnect?.();
            break;

          case 'command_available':
            // WS 仅作通知：收到后 Agent 走 HTTP claim 原子逻辑获取命令
            const cmd = msg.command as WsCommand;
            if (cmd?.id && cmd?.type) {
              console.log(`[AgentWS] 收到 command_available: ${cmd.type} windowId=${cmd.windowId}`);
              logTrace('agent-ws', 'command_available', {
                commandId: cmd.id,
                tenantId: cmd.tenantId,
                workstationId: cmd.workstationId,
                siteId: cmd.siteId,
                windowId: cmd.windowId,
                staffName: cmd.staffName,
                type: cmd.type,
              });
              try {
                await this.opts.onCommand(cmd);
              } catch (err) {
                console.warn(`[AgentWS] 处理 command_available 异常: ${(err as Error).message}`);
                warnTrace('agent-ws', 'command_available_handler_failed', {
                  commandId: cmd.id,
                  error: (err as Error).message,
                });
              }
            }
            break;

          case 'task_available':
            const task = msg.task as WsTaskAvailable;
            if (task?.id && task?.type) {
              logTrace('agent-ws', 'task_available', {
                taskId: task.id,
                tenantId: task.tenantId,
                workstationId: task.workstationId,
                siteId: task.siteId,
                taskType: task.type,
              });
              try {
                await this.opts.onTaskAvailable?.(task);
              } catch (err) {
                warnTrace('agent-ws', 'task_available_handler_failed', {
                  taskId: task.id,
                  error: (err as Error).message,
                });
              }
            }
            break;

          default:
            // ping/pong 由 ws 内置处理
            break;
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[AgentWS] 断开: code=${code} reason=${reason}`);
        warnTrace('agent-ws', 'socket_closed', {
          code,
          reason: String(reason || ''),
          connectionId: this.connectionId || undefined,
        });
        this.connected = false;
        this.stopPing();
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.warn(`[AgentWS] 连接错误: ${err.message}`);
        warnTrace('agent-ws', 'socket_error', { error: err.message });
        // close 事件会触发 reconnect
      });

      resolve();
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(this.reconnectDelay, RECONNECT_MAX_MS);
    console.log(`[AgentWS] ${delay / 1000}s 后重连`);
    warnTrace('agent-ws', 'schedule_reconnect', { delayMs: delay });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
