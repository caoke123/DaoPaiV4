/**
 * AgentWebSocket — Agent WebSocket 实时通信通道 (Deploy-0D-S2)
 *
 * 职责：
 *   1. 接受 Agent WebSocket 连接（/agent/ws）
 *   2. 维护在线 Agent 注册表（key: tenantId + workstationId）
 *   3. Cloud 推送 window_command 给在线 Agent
 *   4. 接收 Agent 的 ack/running/status/done/failed 消息
 *   5. 广播事件给 Frontend SSE
 *
 * 约束：
 *   - WebSocket 仅作为实时通知通道，不绕过 window_commands 持久化
 *   - Agent 离线时命令保持 pending，等待轮询补偿
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'http';
import { logTrace, warnTrace } from '../utils/trace';

// ══════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════

export interface AgentConnection {
  connectionId: string;
  tenantId: string;
  workstationId: string;
  ws: WebSocket;
  connectedAt: number;
  lastPingAt: number;
  agentVersion: string;
}

export interface WindowCommandPayload {
  id: string;
  type: 'open_window' | 'close_window' | 'restart_window' | 'refresh_status';
  tenantId: string;
  siteId: string;
  workstationId: string;
  windowId: string;
  staffName: string;
}

export interface TaskAvailablePayload {
  id: string;
  type: string;
  tenantId: string;
  workstationId: string;
  siteId: string;
}

export interface CommandStatusEvent {
  type: 'command_claimed' | 'command_running' | 'command_done' | 'command_failed';
  commandId: string;
  windowId?: string;
  staffName?: string;
  siteId?: string;
  error?: string;
  result?: Record<string, unknown>;
  at: string;
}

export interface WindowStatusEvent {
  type: 'window_status_updated';
  siteId: string;
  windowId: string;
  staffName: string;
  status: string;
  statusText: string;
  at: string;
}

export interface AgentEvent {
  type: 'agent_connected' | 'agent_disconnected';
  tenantId: string;
  workstationId: string;
  connectedAt?: string;
  at: string;
}

// ══════════════════════════════════════════════════════════
// SSE Broadcaster — 供 routes 注册
// ══════════════════════════════════════════════════════════

const sseClients = new Map<string, Set<(data: string) => void>>();
let sseIdCounter = 0;

export function addSseClient(siteId: string, send: (data: string) => void): number {
  if (!sseClients.has(siteId)) sseClients.set(siteId, new Set());
  const id = ++sseIdCounter;
  sseClients.get(siteId)!.add(send);
  return id;
}

export function removeSseClient(siteId: string, send: (data: string) => void): void {
  sseClients.get(siteId)?.delete(send);
}

export function broadcastSse(siteId: string, event: string, data: Record<string, unknown>): void {
  const clients = sseClients.get(siteId);
  if (!clients || clients.size === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of clients) {
    try { send(msg); } catch { /* ignore closed client */ }
  }
}

// ══════════════════════════════════════════════════════════
// AgentWebSocket
// ══════════════════════════════════════════════════════════

export class AgentWebSocket {
  private wss: WebSocketServer | null = null;
  /** key: `${tenantId}::${workstationId}` */
  private agents = new Map<string, AgentConnection>();

  /**
   * Attach WebSocket server to HTTP server.
   */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/agent/ws' });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    console.log('[AgentWS] WebSocket 服务已启动 (path=/agent/ws)');
  }

  /**
   * 检查 Agent 是否在线
   */
  isAgentOnline(tenantId: string, workstationId: string): boolean {
    return this.agents.has(`${tenantId}::${workstationId}`);
  }

  /**
   * 推送 window_command 给在线 Agent。
   * 返回 true 表示已推送，false 表示 Agent 不在线。
   */
  pushCommand(command: WindowCommandPayload): boolean {
    const key = `${command.tenantId}::${command.workstationId}`;
    const agent = this.agents.get(key);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) return false;

    try {
      logTrace('agent-ws', 'push_command_attempt', {
        commandId: command.id,
        tenantId: command.tenantId,
        workstationId: command.workstationId,
        siteId: command.siteId,
        windowId: command.windowId,
        type: command.type,
      });
      agent.ws.send(JSON.stringify({
        type: 'command_available',
        command: {
          id: command.id,
          type: command.type,
          siteId: command.siteId,
          windowId: command.windowId,
          staffName: command.staffName,
          tenantId: command.tenantId,
          workstationId: command.workstationId,
        },
      }));
      console.log(`[AgentWS] 推送 command ${command.id} (${command.type}) → ${key}`);
      logTrace('agent-ws', 'push_command_sent', {
        commandId: command.id,
        tenantId: command.tenantId,
        workstationId: command.workstationId,
        siteId: command.siteId,
        windowId: command.windowId,
        type: command.type,
        connectionId: agent.connectionId,
      });
      return true;
    } catch (err) {
      console.warn(`[AgentWS] 推送失败: ${(err as Error).message}`);
      warnTrace('agent-ws', 'push_command_failed', {
        commandId: command.id,
        tenantId: command.tenantId,
        workstationId: command.workstationId,
        siteId: command.siteId,
        windowId: command.windowId,
        type: command.type,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * 推送 task_available 给在线 Agent。
   * 返回 true 表示已推送，false 表示 Agent 不在线。
   */
  pushTaskAvailable(task: TaskAvailablePayload): boolean {
    const key = `${task.tenantId}::${task.workstationId}`;
    const agent = this.agents.get(key);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) return false;

    try {
      logTrace('agent-ws', 'push_task_attempt', {
        taskId: task.id,
        tenantId: task.tenantId,
        workstationId: task.workstationId,
        siteId: task.siteId,
        taskType: task.type,
      });
      agent.ws.send(JSON.stringify({
        type: 'task_available',
        task: {
          id: task.id,
          type: task.type,
          tenantId: task.tenantId,
          workstationId: task.workstationId,
          siteId: task.siteId,
        },
      }));
      logTrace('agent-ws', 'push_task_sent', {
        taskId: task.id,
        tenantId: task.tenantId,
        workstationId: task.workstationId,
        siteId: task.siteId,
        taskType: task.type,
        connectionId: agent.connectionId,
      });
      return true;
    } catch (err) {
      warnTrace('agent-ws', 'push_task_failed', {
        taskId: task.id,
        tenantId: task.tenantId,
        workstationId: task.workstationId,
        siteId: task.siteId,
        taskType: task.type,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * 获取在线 Agent 数量
   */
  getOnlineCount(): number {
    return this.agents.size;
  }

  // ══════════════════════════════════════════════════════════
  // Private
  // ══════════════════════════════════════════════════════════

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let agentKey: string | null = null;
    let connectionId: string | null = null;
    const HELLO_TIMEOUT_MS = 10_000;

    console.log('[AgentWS] 新连接');

    // Hello timeout: 10s 内必须收到 hello
    const helloTimer = setTimeout(() => {
      if (!agentKey) {
        console.warn('[AgentWS] hello 超时，断开连接');
        ws.close(4001, 'hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    ws.on('pong', () => {
      if (agentKey) {
        const agent = this.agents.get(agentKey);
        if (agent) agent.lastPingAt = Date.now();
      }
    });

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'hello': {
          clearTimeout(helloTimer);

          const tenantId = (msg.tenantId as string) || 'tenant-default';
          const workstationId = (msg.workstationId as string) || 'ws-local-default';
          const agentVersion = (msg.agentVersion as string) || '0.1.0';

          agentKey = `${tenantId}::${workstationId}`;
          connectionId = randomUUID();

          // 如果已有同 key 的旧连接，先断开
          const existing = this.agents.get(agentKey);
          if (existing) {
            try { existing.ws.close(4000, 'replaced by new connection'); } catch {}
          }

          const conn: AgentConnection = {
            connectionId,
            tenantId,
            workstationId,
            ws,
            connectedAt: Date.now(),
            lastPingAt: Date.now(),
            agentVersion,
          };
          this.agents.set(agentKey, conn);

          console.log(`[AgentWS] Agent 已注册: key=${agentKey} version=${agentVersion}`);
          logTrace('agent-ws', 'agent_connected', {
            tenantId,
            workstationId,
            connectionId,
            agentVersion,
          });

          // 回复 hello ack
          ws.send(JSON.stringify({ type: 'hello_ack', connectionId }));

          // 广播 agent_connected 事件
          broadcastSse('*' as any, 'agent_connected', {
            type: 'agent_connected',
            tenantId,
            workstationId,
            connectedAt: new Date(conn.connectedAt).toISOString(),
            at: new Date().toISOString(),
          });
          break;
        }

        case 'command_ack':
          // S2-Fix: ack 仅作为 Agent 收到命令的确认通知，不修改 DB 状态
          // 状态变更由 HTTP claimPendingWindowCommands 原子操作负责
          if (msg.commandId && agentKey) {
            const cmdId = msg.commandId as string;
            console.log(`[AgentWS] command_ack: ${cmdId}`);
            logTrace('agent-ws', 'command_ack', {
              commandId: cmdId,
              agentKey,
            });
            broadcastSse('*' as any, 'command_claimed', {
              type: 'command_claimed', commandId: cmdId, at: new Date().toISOString(),
            });
          }
          break;

        case 'command_running':
          if (msg.commandId && agentKey) {
            const cmdId = msg.commandId as string;
            console.log(`[AgentWS] command_running: ${cmdId}`);
            logTrace('agent-ws', 'command_running', {
              commandId: cmdId,
              agentKey,
            });
            broadcastSse('*' as any, 'command_running', {
              type: 'command_running', commandId: cmdId, at: new Date().toISOString(),
            });
          }
          break;

        case 'window_status':
          if (agentKey) {
            const wsMsg = msg as unknown as WindowStatusEvent & { siteId: string; windowId: string; staffName: string; status: string; statusText: string };
            console.log(`[AgentWS] window_status: ${wsMsg.windowId} → ${wsMsg.status}`);
            logTrace('agent-ws', 'window_status', {
              siteId: wsMsg.siteId,
              windowId: wsMsg.windowId,
              staffName: wsMsg.staffName,
              status: wsMsg.status,
            });
            broadcastSse(wsMsg.siteId, 'window_status_updated', {
              type: 'window_status_updated',
              siteId: wsMsg.siteId,
              windowId: wsMsg.windowId,
              staffName: wsMsg.staffName,
              status: wsMsg.status,
              statusText: wsMsg.statusText,
              at: new Date().toISOString(),
            });
          }
          break;

        case 'command_done':
          if (msg.commandId && agentKey) {
            const cmdId = msg.commandId as string;
            console.log(`[AgentWS] command_done: ${cmdId}`);
            logTrace('agent-ws', 'command_done', {
              commandId: cmdId,
              agentKey,
            });
            broadcastSse('*' as any, 'command_done', {
              type: 'command_done',
              commandId: cmdId,
              result: msg.result || {},
              at: new Date().toISOString(),
            });
          }
          break;

        case 'command_failed':
          if (msg.commandId && agentKey) {
            const cmdId = msg.commandId as string;
            console.log(`[AgentWS] command_failed: ${cmdId} error=${msg.error}`);
            warnTrace('agent-ws', 'command_failed', {
              commandId: cmdId,
              agentKey,
              error: String(msg.error || ''),
            });
            broadcastSse('*' as any, 'command_failed', {
              type: 'command_failed',
              commandId: cmdId,
              error: msg.error,
              at: new Date().toISOString(),
            });
          }
          break;

        default:
          console.debug(`[AgentWS] 未知消息类型: ${msg.type}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      if (agentKey) {
        const agent = this.agents.get(agentKey);
        this.agents.delete(agentKey);
        console.log(`[AgentWS] Agent 断开: ${agentKey}`);
        if (agent) {
          logTrace('agent-ws', 'agent_disconnected', {
            tenantId: agent.tenantId,
            workstationId: agent.workstationId,
            connectionId: agent.connectionId,
          });
          broadcastSse('*' as any, 'agent_disconnected', {
            type: 'agent_disconnected',
            tenantId: agent.tenantId,
            workstationId: agent.workstationId,
            at: new Date().toISOString(),
          });
        }
      }
    });

    ws.on('error', (err) => {
      console.warn(`[AgentWS] 连接错误 (${agentKey || 'unregistered'}): ${err.message}`);
      warnTrace('agent-ws', 'socket_error', {
        agentKey: agentKey || 'unregistered',
        error: err.message,
      });
    });
  }

}

/** 单例 */
let instance: AgentWebSocket | null = null;

export function getAgentWebSocket(): AgentWebSocket {
  if (!instance) instance = new AgentWebSocket();
  return instance;
}
