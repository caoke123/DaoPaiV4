# Agent Smoke Checklist

## 目标

用于 Step 8 后的最小回归，确认 AgentDaemon 收口没有引入行为漂移，同时继续满足“不碰旧 Cloud 执行链”的边界。

## 1. 启动与鉴权

- 准备好 `agent.json`
- 在 `packages/agent` 下执行 `npm run dev`
- 确认控制台出现以下关键日志：
  - 启动检查通过
  - `settings.json` 路径输出正常
  - `/agent/me` 鉴权成功
  - 心跳循环启动
  - 窗口状态上报启动
  - 窗口命令轮询启动
  - WebSocket 客户端启动

## 2. WS 在线状态

- 启动后观察是否出现 `hello ack`
- 断开 Cloud 或关闭后端，确认 Agent 输出断线与重连日志
- 恢复后端，确认 Agent 自动重连
- 重连后确认会触发一次命令与任务补偿拉取

## 3. 任务通知链

- 在 Cloud 创建一条 `agent_test` 或业务任务
- 确认 Agent 在 WS 在线时能快速收到 `task_available`
- 确认 `TaskLoop` 会立即触发补偿拉取，而不是等待长轮询
- 确认任务日志、进度、完成状态能回传 Cloud

## 4. 窗口命令链

- 在前端 Header 或 Browser 管理页下发以下命令：
  - `open_window`
  - `close_window`
  - `restart_window`
  - `refresh_status`
- 确认 Agent 能看到：
  - `command_available`
  - `command_ack`
  - `command_running`
  - `done` 或 `failed`
- 确认 WS 在线时窗口命令轮询降为慢轮询，WS 离线时恢复快轮询

## 5. 状态回传链

- 打开窗口后，确认 Cloud / 前端能看到：
  - `starting`
  - `ready_checking` 或相关过渡态
  - `ready` / `login_required` / `error`
- 关闭窗口后，确认状态清理为 `offline`
- 执行任务时，确认只有目标窗口进入 `busy`

## 6. 兼容路径

- 创建一个尚未迁移到本地执行器的任务类型
- 确认 Agent 仍走 Cloud `run-engine` 兼容路径
- 确认日志中能明确看出这是兼容路径，而不是误判为本地执行

## 7. 边界校验

- 在仓库根目录执行 `npm run check:no-cloud-engine`
- 预期结果：
  - 旧 Cloud 浏览器执行链未被扩展
  - Step 8 只收口 Agent 编排与文档，不新增 Cloud 执行能力

## 8. 诊断校验

- 检查本次变更文件的 TypeScript 诊断
- 重点关注：
  - `src/index.ts`
  - `src/runtime/AgentDaemon.ts`

## 通过标准

- Agent 能正常启动并进入在线态
- WS 通知、任务拉取、窗口命令、状态回传链路保持原行为
- 断线重连后的补偿拉取仍可用
- 未碰旧 Cloud 执行链边界
