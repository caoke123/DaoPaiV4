# DaoPai V3 Deploy-0D-S2 Agent 实时通信通道报告

## 1. 问题背景

Deploy-0D 已将 Header 窗口启动/关闭迁移为 Window Command 模式，但 Frontend/Cloud/Agent 之间依赖 HTTP 轮询：
- Agent 每 1s poll command（最坏 1s 延迟）
- Header 每 1s poll command status（最多 15s 超时）
- window_status 每 5s 刷新

总体验延迟 5～15s，不符合"点击即响应"的预期。

## 2. 修改文件列表

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/agent/AgentWebSocket.ts` | **新建** | WS 服务端 + Agent 在线注册表 + SSE 广播 |
| `backend/index.ts` | 修改 | `http.createServer` + WS attach |
| `backend/api/routes.ts` | 修改 | `agentOnline` 字段 + WS push + SSE 端点 |
| `packages/agent/src/ws/AgentWsClient.ts` | **新建** | WebSocket 客户端（hello/ping/重连/命令处理） |
| `packages/agent/src/index.ts` | 修改 | 集成 WS + 动态 poll（在线 30s，离线 1s） |
| `frontend/src/components/shared/WindowStateProvider.tsx` | 修改 | SSE EventSource + 实时状态更新 |
| `frontend/src/components/layout/Header.tsx` | 修改 | `agentOnline` 即时反馈 |
| `frontend/src/api/client.ts` | 修改 | `agentOnline` 类型 |
| `backend/package.json` | 修改 | 新增 `ws`, `@types/ws` |
| `packages/agent/package.json` | 修改 | 新增 `ws`, `@types/ws` |

## 3. Agent WebSocket 通道

### 3.1 连接流程

```
Agent 启动
  → ws://localhost:3300/agent/ws
  → 10s 内发送 hello { tenantId, workstationId, agentVersion }
  → Cloud 回复 hello_ack { connectionId }
  → 注册到在线表 key=`tenantId::workstationId`
  → 30s ping/pong 保活
```

### 3.2 Agent 在线注册表

[`AgentWebSocket`](file:///e:/网站开发/DaoPaiV3/backend/agent/AgentWebSocket.ts) 维护：
```typescript
key: `tenantId::workstationId` → {
  connectionId, tenantId, workstationId,
  ws, connectedAt, lastPingAt, agentVersion
}
```

- 同 key 的新连接会自动替换旧连接
- Agent 断线时从注册表移除并广播 `agent_disconnected`
- 10s 未收到 hello 自动断开

### 3.3 重连策略

Agent 客户端采用指数退避重连：1s → 2s → 4s → ... → 最高 30s

重连后立即触发 `onReconnect` 回调，补偿拉取 pending commands。

## 4. Cloud command 实时推送

### 4.1 命令创建 → 推送流程

```
Header POST /api/cloud/windows/commands
  ↓
1. 写入 window_commands 表 (pending)
2. 检查 Agent WS 是否在线
3. 在线 → 立即推送 command via WS
4. 响应中返回 agentOnline 字段
```

### 4.2 agentOnline 字段

[`routes.ts`](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) 的 `POST /api/cloud/windows/commands` 返回：
```json
{
  "commandId": "...",
  "status": "pending",
  "agentOnline": true,
  "message": "窗口命令 open_window 已创建，已推送至本地执行套件"
}
```

- `agentOnline=true` → 命令已实时推送给 Agent
- `agentOnline=false` → Agent 不在线，命令保持 pending

### 4.3 WS 推送消息格式

```json
{
  "type": "window_command",
  "command": {
    "id": "...", "type": "open_window",
    "tenantId": "...", "siteId": "...",
    "workstationId": "...", "windowId": "...",
    "staffName": "..."
  }
}
```

## 5. Agent 实时回传

### 5.1 Agent 收到 command 的处理

[`AgentWsClient.onCommand`](file:///e:/网站开发/DaoPaiV3/packages/agent/src/ws/AgentWsClient.ts) 收到 WS 通知后：
1. 发送 `command_ack` → Cloud 更新数据库 `claimed_at`
2. 触发一次 `pullWindowCommandsLoop` → 复用现有 claim 原子逻辑
3. 执行 open_window/close_window
4. 通过 WS 发送 `window_status` 阶段状态
5. 完成时发送 `command_done` / `command_failed`

### 5.2 Agent 回传消息类型

| 消息 | 方向 | 说明 |
|------|------|------|
| `hello` | Agent→Cloud | 注册（tenantId, workstationId, version） |
| `hello_ack` | Cloud→Agent | 确认连接 |
| `command_ack` | Agent→Cloud | 已收到命令，更新 claimed |
| `command_running` | Agent→Cloud | 开始执行 |
| `command_done` | Agent→Cloud | 执行完成 |
| `command_failed` | Agent→Cloud | 执行失败 |
| `window_status` | Agent→Cloud | 窗口阶段状态 |

## 6. Frontend 实时状态

### 6.1 SSE 订阅

[`WindowStateProvider`](file:///e:/网站开发/DaoPaiV3/frontend/src/components/shared/WindowStateProvider.tsx) 新增 SSE 订阅：

```
EventSource → GET /api/cloud/windows/events?siteId=xxx
```

监听事件：
- `agent_connected` → 刷新窗口状态
- `agent_disconnected` → 刷新窗口状态
- `command_claimed` → 刷新
- `command_running` → 刷新
- `command_done` → 刷新
- `command_failed` → 刷新
- `window_status_updated` → 直接更新 clientSide 状态（不刷新）

SSE 断线自动重连（浏览器原生支持 + 自定义 fallback）。

### 6.2 Header 即时反馈

Header 的 `handleInitWindow` / `handleCloseWindow` 使用 `agentOnline` 字段：
- `agentOnline=false` → 立即显示 "本地执行套件未连接"
- `agentOnline=true` → 显示 "命令已下发"

## 7. 轮询兜底

### 7.1 动态轮询频率

| WS 状态 | 轮询间隔 | 说明 |
|---------|---------|------|
| 在线 | **30s** | 兜底补偿，极少触发 |
| 离线 | **1s** | 快速轮询，保证响应 |

### 7.2 重连补偿

Agent 重连后立即拉取一次 pending commands（`onReconnect` 回调）。

### 7.3 现有保留项

- HTTP command poll 保留（兜底）
- HTTP window_status report 保留（每 5s）
- HTTP task pull 保留（不受影响）
- HTTP heartbeat 保留（不受影响）

## 8. 性能结果

| 指标 | 优化前 | 优化后（目标） |
|------|--------|---------------|
| 点击 → Header 反馈 | 200ms | ~200ms（无变化） |
| 点击 → Agent 收到 command | 0-1000ms (poll) | **0-100ms** (WS push) |
| Agent 收到 → Header 显示 claimed | 0-2000ms (poll) | **0-100ms** (SSE) |
| Agent 离线提示 | 10-15s | **立即**（agentOnline=false） |
| Command poll 频率（在线） | 1s | 30s（降低 30 倍资源消耗） |

## 9. 验证结果

### 9.1 TypeScript 检查

```
cd backend        && npx tsc --noEmit  → ✅ 0 errors
cd frontend       && npx tsc --noEmit  → ✅ 0 errors
cd packages/agent && npx tsc --noEmit  → ✅ 0 errors
```

### 9.2 待人工测试

#### A. Agent 连接测试
1. 启动 backend → 启动 Agent
2. Backend 日志显示 `[AgentWS] Agent 已注册: key=tenant-default::ws-local-default`
3. 停止 Agent → Backend 显示 `[AgentWS] Agent 断开`
4. Agent 重启 → 自动 reconnect

#### B. 启动窗口实时测试
1. Header 点击启动窗口
2. Command 创建响应含 `agentOnline: true`
3. Backend 日志显示推送成功
4. Agent 日志显示 `[AgentWS] 收到实时命令`
5. Header 快速显示 claimed/running/ready

#### C. 关闭窗口实时测试
1. Header 点击关闭窗口
2. Command 创建响应含 `agentOnline: true`
3. Agent WS 收到 + 执行 close
4. Header 实时显示 offline

#### D. Agent 离线测试
1. 停止 Agent
2. Header 点击启动窗口
3. 响应 `agentOnline: false`
4. Header 立即显示 "本地执行套件未连接"
5. Agent 重启 → 自动补偿拉取 pending command

#### E. 任务测试
1. `/agent/window-connections` 返回 ready 窗口
2. Executor 正常
3. 日志回传正常

## 10. 不变项确认

以下代码**零修改**：
- `ArrivalExecutor.ts` — 到件扫描执行器
- `DispatchExecutor.ts` — 派件扫描执行器
- `IntegratedExecutor.ts` — 到派一体执行器
- `SignExecutor.ts` — 签收录入执行器
- `dryRunMode` 逻辑
- `ENABLE_REAL_SUBMIT` 逻辑
- Task Center 日志策略
- EasyBR 清理结果

## 11. 遗留问题

- 自动登录、P0 检测、弹窗清理在 Deploy-0D-Fix-2 中已实现，本阶段未扩大修改
- close_window 精准关闭在 R3 中已修复，本阶段未扩大修改
- 窗口启动约 5s 的耗时（Chrome 启动 3.7s + CDP 连接 + 登录）仍需后续优化

## 12. 是否提交 Git

否，等待用户测试确认。
