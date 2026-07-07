# DaoPai 本地执行端

> 当前阶段：**Agent 常驻运行态**。Agent 已具备心跳、任务拉取、WebSocket 实时通知、窗口命令执行、窗口状态上报与本地业务执行器接管能力。

## 角色定位

本地执行端安装在员工电脑上，是 DaoPai V4 中唯一正式的本地执行层，负责：

- 主动连接 Cloud，完成鉴权、心跳和在线状态维护
- 接收任务通知与窗口命令，并在本机执行
- 管理本地 Chrome / Portable Chrome 窗口生命周期
- 回传窗口状态、任务日志、执行结果

系统关系如下：

```text
Frontend -> Cloud API / SSE
Cloud -> Agent WS / HTTP
Agent -> 本地 Chrome / 本地执行器
Agent -> Cloud 状态 / 日志 / 结果回传
```

## 当前能力

当前版本已经具备以下运行能力：

- 启动检查、配置加载、日志初始化
- `/agent/me` 鉴权校验
- 心跳上报与任务兜底拉取
- WebSocket 实时通知：
  - `command_available`
  - `task_available`
  - 重连补偿拉取
- 窗口命令执行：
  - `open_window`
  - `close_window`
  - `restart_window`
  - `refresh_status`
- 窗口状态周期上报与关键状态即时上报
- 本地执行器接管：
  - `arrival`
  - `dispatch`
  - `sign`
  - `integrated`
- 未迁移任务继续走 Cloud `run-engine` 兼容路径

## 代码结构

Step 8 之后，启动编排已收口为 `AgentDaemon`：

```text
src/
  index.ts                    # 薄入口：横幅、配置、日志、启动 AgentDaemon
  runtime/
    AgentDaemon.ts            # 顶层编排：startup/auth/heartbeat/ws/shutdown
    TaskLoop.ts               # 任务拉取与立即补偿轮询
    WindowCommandLoop.ts      # 窗口命令拉取、执行、ack/running/done
    StatusPublisher.ts        # 窗口状态采集与上报
  ws/
    AgentWsClient.ts          # Cloud <-> Agent 实时通知通道
  local-runtime/              # 本地窗口管理、状态机、ReadyGuard
  executors/                  # 业务执行器
```

## 前置条件

1. Cloud 已创建执行电脑，并拿到 `agentToken`
2. Node.js >= 18
3. 本机可访问 Cloud 地址
4. `agent.json` 中已配置浏览器路径与用户目录

## 快速开始

### 1. 复制配置文件

```bash
Copy-Item .\agent.example.json .\agent.json
```

### 2. 填写核心配置

最小示例：

```json
{
  "cloudBaseUrl": "http://localhost:3300",
  "agentToken": "daopai_agent_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "workstationName": "天南大-前台电脑01",
  "siteId": null,
  "logLevel": "info",
  "heartbeatIntervalMs": 1000,
  "taskPollIntervalMs": 1000,
  "browser": {
    "executablePath": "chrome/chrome.exe",
    "userDataDir": "profiles/default",
    "debugPort": 9223,
    "headless": false
  }
}
```

### 3. 安装依赖

```bash
npm install
```

### 4. 启动 Agent

```bash
npm run dev
```

启动后应看到以下关键行为：

- 启动检查通过
- `/agent/me` 鉴权成功
- 心跳循环启动
- 窗口状态上报启动
- 窗口命令轮询启动
- WebSocket 客户端启动

## 运行说明

### 任务链

- WebSocket 负责实时通知
- HTTP `pullTask` 负责原子拉取与兜底
- 未迁移任务仍允许回退到 Cloud `run-engine`

### 窗口命令链

- Cloud 持久化 `window_commands`
- WebSocket 仅做 `command_available` 通知
- Agent 仍走 HTTP pull / claim 执行，避免绕过持久化

### 状态链

- `StatusPublisher` 周期采集窗口状态
- 关键窗口命令执行过程会即时上报中间状态
- READY 判定已收敛到状态机与 ReadyGuard 体系

## Smoke Checklist

联调和回归请优先按这份清单执行：

- [smoke-checklist.md](./docs/smoke-checklist.md)

建议至少覆盖：

- Agent 启动与鉴权
- WS 在线与断线重连
- 任务创建后的实时通知
- 窗口打开 / 关闭 / 重启 / 刷新
- 状态上报与前端回显
- 旧 Cloud 执行链边界校验

## 安全与边界

- `agent.json` 包含授权码，禁止提交到 Git
- 本地 Chrome CDP 仅允许绑定 `127.0.0.1`
- WebSocket 只做通知，不绕过 Cloud 命令持久化
- 旧 Cloud 浏览器执行链只保留兼容，不在本步骤扩展

## 相关文档

- [smoke-checklist.md](./docs/smoke-checklist.md)
- [Phase 4-A：Local Agent 边界设计](../../docs/V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md)
- [Phase 4-B：Agent Token 与执行电脑鉴权设计](../../docs/V3_PHASE4B_AGENT_TOKEN_AUTH.md)
- [Phase 4-C：Agent API 协议设计](../../docs/V3_PHASE4C_AGENT_API_PROTOCOL.md)
