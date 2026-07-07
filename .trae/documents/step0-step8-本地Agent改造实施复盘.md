# DaoPai V4 本地 Agent Step 0 - Step 8 实施复盘

## 1. 文档目的

本文档用于沉淀本轮 `Step 0` 到 `Step 8` 的实际改造结果，重点回答三件事：

- 这 8 步分别做了哪些工作
- 每一步是如何实现的
- 改造前后，窗口命令链、任务链、状态链分别发生了什么变化

本文档不再讨论“大方向是否正确”，而是聚焦已经完成的实施工作、技术落点、链路变化和当前收益。

---

## 2. 改造背景

DaoPai V4 的正式方向已经明确：

- 云端：`frontend/` + `backend/`
- 本地：`packages/agent/`

正式执行职责必须收敛为：

```text
Frontend -> Cloud 创建任务 / 窗口命令
Cloud -> Agent 下发通知与持久化编排
Agent -> 本地管理 Chrome 窗口并执行任务
Agent -> Cloud 回传状态、日志、结果
```

本轮改造的核心目标不是“把旧 V3 代码搬过来”，而是在不破坏边界的前提下，尽量恢复 V3 的四类体验：

- Header 点击后立即有反馈
- 打开窗口接近秒启动
- 关闭窗口接近秒关闭
- 任务创建后 Agent 很快开始执行

---

## 3. 总体结论

经过 `Step 0` 到 `Step 8`，当前 Agent 主链已经完成以下收口：

- 边界层：旧 Cloud 执行链被冻结，后续步骤全部围绕 Agent 正式执行层推进
- 观测层：窗口命令链、任务链、前端状态链都补上了 trace
- 实时层：任务通知、窗口命令通知都以 WS 为主，轮询为兜底
- 体验层：Header 已支持乐观状态，不再完全等待后端轮询确认
- 正确性层：BUSY 已经下沉为窗口级，READY 判定已引入 ReadyGuard 与状态机
- 结构层：`index.ts` 已拆出 `TaskLoop`、`StatusPublisher`、`WindowCommandLoop`，并在 Step 8 增加 `AgentDaemon`
- 文档层：Agent README 和 smoke checklist 已同步到当前真实运行态

---

## 4. 改造总览

| 步骤 | 目标 | 核心结果 |
|---|---|---|
| Step 0 | 冻结边界，建立基线 | 明确旧 Cloud 执行链不可扩展，所有后续改动必须通过 `check:no-cloud-engine` |
| Step 1 | 先测量，再优化 | 为 Frontend / Cloud / Agent 补链路耗时日志 |
| Step 2 | 任务通知 WS 化 | 任务创建后，Agent 不再主要依赖 heartbeat 感知任务 |
| Step 3 | 批量窗口命令 WS 化 | 单窗和批量命令都走 WS 通知加速，并补齐命令 `running` 闭环 |
| Step 4 | Header 乐观状态 | 点击窗口 Tag 后立即有本地过渡状态，SSE / 命令结果再校正 |
| Step 5 | 窗口级 BUSY | BUSY 从全局运行任务收敛为窗口级占用 |
| Step 6 | ReadyGuard + 状态机 | READY 判定与窗口生命周期状态收敛 |
| Step 7 | 拆 `index.ts` | 抽出运行时循环模块，减少入口耦合 |
| Step 8 | 小收口 | 增加 `AgentDaemon`、更新 README、补 smoke checklist |

---

## 5. 总体前后对比

### 5.1 窗口命令链

**改造前**

```text
Header 点击
  -> Cloud 创建 window_command
  -> Agent 主要靠轮询发现命令
  -> 执行窗口命令
  -> Cloud / Frontend 感知状态变化
```

**改造后**

```text
Header 点击
  -> 前端立即显示 optimistic state
  -> Cloud 创建 window_command
  -> Cloud 立即 WS 通知 Agent
  -> Agent pull/claim 命令并执行
  -> Agent 回传 ack / running / done / failed
  -> Cloud SSE 推送前端
  -> 前端用真实状态修正 optimistic state
```

### 5.2 任务链

**改造前**

```text
Cloud 创建任务
  -> Agent 主要依赖 heartbeat / 定时 pullTask 感知
  -> Agent 开始执行
  -> 日志与进度回传
```

**改造后**

```text
Cloud 创建任务
  -> Cloud WS task_available 通知 Agent
  -> Agent TaskLoop 立即 pullTask
  -> Agent 开始执行本地执行器
  -> 日志、进度、完成状态快速回传
  -> heartbeat 只保留兜底
```

### 5.3 状态链

**改造前**

- 前端对“点击是否生效”的感知较慢
- READY 判定偏轻，容易出现误判
- BUSY 粒度不够细，可能误伤其他窗口
- `index.ts` 既管启动，又管循环，又管 WS，风险高

**改造后**

- 前端点击后立即进入本地过渡状态
- READY 经过 ReadyGuard 和状态机统一判定
- BUSY 按 `windowId` 维护
- 运行时循环拆分，Step 8 再由 `AgentDaemon` 统一编排

---

## 6. Step 0：冻结边界和建立基线

### 6.1 本步目标

- 在开始任何性能优化前，先锁死边界
- 明确旧 Cloud 执行链只能保留兼容，不能继续扩展
- 为后续每一步建立“有对照的”执行基线

### 6.2 实际做了哪些工作

- 将“不碰旧 Cloud 执行链”提升为后续所有步骤的前置约束
- 每一步完成后都使用 `npm run check:no-cloud-engine` 做边界回归检查
- 在执行方案中加入 `Step 0`，把边界冻结放到所有优化之前

### 6.3 具体如何实现

- 通过 `scripts/check-no-cloud-engine.js` 防止 Cloud 执行链回流
- 通过文档和实施顺序约束，明确后续优化只允许发生在：
  - `packages/agent/*`
  - Cloud 到 Agent 的通知链
  - 前端状态反馈链

### 6.4 涉及范围

- `scripts/check-no-cloud-engine.js`
- `backend/agent/agentRoutes.ts`
- `backend/playwright-runtime/*`
- `backend/window-adapter/*`
- `backend/modules/assignment-engine/*`
- `.trae/documents/daopai-v4-项目梳理与本地套件优先规划.md`

### 6.5 前后执行对比

**之前**

- 旧 Cloud 执行链虽然已经降级，但边界没有被明确冻结
- 后续优化存在误把逻辑继续做到 Cloud 里的风险

**之后**

- 所有优化都以 Agent 正式执行层为中心
- 旧 Cloud 执行链只保留兼容，不再扩展

### 6.6 本步收益

- 把“大方向跑偏”的风险提前消掉
- 后续每一步都能在正确边界内进行

---

## 7. Step 1：链路耗时日志

### 7.1 本步目标

- 先测量“到底慢在哪”，而不是凭感觉优化
- 打通前端、Cloud、Agent 三段链路的耗时观测

### 7.2 实际做了哪些工作

- 新增 Cloud trace helper：`backend/utils/trace.ts`
- 新增 Agent trace helper：`packages/agent/src/trace.ts`
- 新增 Frontend trace helper：`frontend/src/lib/trace.ts`
- 在以下关键链路补充耗时与事件日志：
  - Header 点击与命令创建
  - Cloud 创建任务 / 窗口命令
  - Cloud WS 推送
  - Agent pullTask / pullWindowCommands
  - Agent 执行窗口命令
  - SSE 收包与前端状态刷新

### 7.3 具体如何实现

- 在 `backend/api/routes.ts`、`backend/agent/AgentWebSocket.ts`、`backend/agent/agentRoutes.ts` 打点
- 在 `packages/agent/src/httpClient.ts`、`packages/agent/src/index.ts` 打点
- 在 `frontend/src/components/layout/Header.tsx`、`frontend/src/components/shared/WindowStateProvider.tsx` 打点

### 7.4 涉及文件

- `backend/utils/trace.ts`
- `packages/agent/src/trace.ts`
- `frontend/src/lib/trace.ts`
- `backend/api/routes.ts`
- `backend/agent/AgentWebSocket.ts`
- `backend/agent/agentRoutes.ts`
- `packages/agent/src/httpClient.ts`
- `packages/agent/src/index.ts`
- `frontend/src/components/layout/Header.tsx`
- `frontend/src/components/shared/WindowStateProvider.tsx`

### 7.5 前后执行对比

**之前**

- 只能感知“体感慢”
- 很难区分是 Cloud 慢、Agent 慢，还是前端反馈慢

**之后**

- 可观测完整链路：
  - 点击
  - 写库
  - WS 推送
  - Agent 收到
  - pull / claim
  - 执行
  - 回传
  - 前端看到

### 7.6 本步收益

- 为 Step 2 到 Step 4 的速度优化提供证据
- 为 Step 5 到 Step 6 的状态准确性问题提供定位依据

---

## 8. Step 2：任务通知 WS 化，TaskLoop 与 heartbeat 解耦

### 8.1 本步目标

- 让任务感知从 heartbeat 中独立出来
- 任务创建后尽快通知 Agent，而不是等待下一轮 heartbeat

### 8.2 实际做了哪些工作

- 在 Cloud 端增加 `task_available` 推送能力
- Agent WS 客户端增加 `onTaskAvailable`
- 引入独立 `TaskLoop` 调度逻辑
- heartbeat 只保留在线状态和兜底 `hasTask` 信号

### 8.3 具体如何实现

- `backend/api/routes.ts` 在任务创建后调用 `notifyAgentTaskAvailable(...)`
- `backend/agent/AgentWebSocket.ts` 增加 `pushTaskAvailable(...)`
- `packages/agent/src/ws/AgentWsClient.ts` 增加：
  - `WsTaskAvailable`
  - `WsTaskHandler`
  - `onTaskAvailable`
- `packages/agent/src/index.ts` 将任务拉取逻辑从 heartbeat 中拆出，形成 `TaskLoop`

### 8.4 涉及文件

- `backend/api/routes.ts`
- `backend/agent/AgentWebSocket.ts`
- `packages/agent/src/ws/AgentWsClient.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/runtime/TaskLoop.ts`

### 8.5 前后执行对比

**之前**

```text
Cloud 创建任务
  -> Agent 等下一轮 heartbeat
  -> Agent pullTask
  -> 执行
```

**之后**

```text
Cloud 创建任务
  -> Cloud WS 推送 task_available
  -> Agent 立即 requestImmediatePoll('ws_task_available')
  -> TaskLoop pullTask
  -> 执行
  -> heartbeat 仅做兜底
```

### 8.6 本步收益

- 任务创建到 Agent 开始执行的首响应时间显著缩短
- `taskPollIntervalMs` 开始真正有意义
- 任务链不再和 heartbeat 强耦合

---

## 9. Step 3：批量窗口命令也走 WS

### 9.1 本步目标

- 让一键启动和单窗启动共享同一条快速通知通道
- 补齐命令状态从 `pending -> claimed -> running -> done/failed` 的闭环

### 9.2 实际做了哪些工作

- Cloud 批量窗口命令接口增加 WS 推送统计
- Agent 增加 `command_running` 回传
- Cloud 增加 `markWindowCommandRunning()` 的落库链路
- 前端同步批量命令响应类型

### 9.3 具体如何实现

- `backend/api/routes.ts`
  - 批量接口返回：
    - `created`
    - `agentOnlineCount`
    - `wsPushedCount`
    - `workstationCount`
- `backend/agent/agentRoutes.ts`
  - 新增 `POST /agent/windows/commands/:commandId/running`
- `packages/agent/src/httpClient.ts`
  - 新增 `markWindowCommandRunning(...)`
- `packages/agent/src/index.ts`
  - 执行窗口命令前先发送 `command_ack`
  - 再上报 `running`
  - 再执行本地命令

### 9.4 涉及文件

- `backend/api/routes.ts`
- `backend/agent/agentRoutes.ts`
- `packages/agent/src/httpClient.ts`
- `packages/agent/src/index.ts`
- `frontend/src/api/client.ts`

### 9.5 前后执行对比

**之前**

```text
pending
  -> claimed
  -> done / failed
```

**之后**

```text
pending
  -> claimed
  -> running
  -> done / failed
```

### 9.6 本步收益

- 一键启动不再因为“只写库不推送”而慢一拍
- 命令执行过程可见性更强
- 前端和 Cloud 都能明确区分“已收到”和“执行中”

---

## 10. Step 4：Header 乐观状态

### 10.1 本步目标

- 让 Header 点击后立即有反馈
- 从“轮询确认驱动 UI”转为“乐观 UI + 实时状态校正”

### 10.2 实际做了哪些工作

- 扩展前端显示状态模型
- 在 Header 中增加 `optimisticStatuses`
- 点击开窗 / 关窗 / 重启 / 刷新时，立即给本地过渡状态
- 命令轮询和 SSE 到达后，清理或修正乐观状态

### 10.3 具体如何实现

- `frontend/src/lib/window-status.ts`
  - 增加：
    - `closing`
    - `restarting`
    - `ready_checking`
- `frontend/src/components/layout/Header.tsx`
  - 增加本地 optimistic state map
  - 新增 `setOptimisticStatus()` / `clearOptimisticStatus()`
  - `pollCommandStatus(...)` 绑定对应窗口
  - `getEffectiveStatus(...)` 综合：
    - 后端真实状态
    - initializingTasks
    - optimisticStatuses

### 10.4 涉及文件

- `frontend/src/lib/window-status.ts`
- `frontend/src/components/layout/Header.tsx`

### 10.5 前后执行对比

**之前**

```text
Header 点击
  -> 请求创建命令
  -> 等命令轮询 / SSE
  -> UI 才变化
```

**之后**

```text
Header 点击
  -> UI 立即进入 opening / closing / restarting / ready_checking
  -> 后台异步执行
  -> SSE / 命令状态到达后校正
```

### 10.6 本步收益

- 用户体感明显改善
- “点了没反应”的空窗期被消除
- 即使后端链路还要几百毫秒到数秒，前端也会立刻反馈

---

## 11. Step 5：窗口级 BUSY

### 11.1 本步目标

- BUSY 不再是“全局运行任务”的粗粒度概念
- 每个窗口只为自己的任务负责

### 11.2 实际做了哪些工作

- 新增窗口级 BUSY 注册表
- 状态采集和窗口命令拦截改为按 `windowId` 判断
- 四个本地执行器在执行前后显式 acquire / release BUSY

### 11.3 具体如何实现

- 新增 `packages/agent/src/local-runtime/WindowBusyRegistry.ts`
  - `acquireWindowBusy(...)`
  - `releaseWindowBusy(...)`
  - `getWindowBusy(...)`
  - `isWindowBusy(...)`
- `LocalWindowRuntime.ts`
  - `isWindowBusy()` 改为读取窗口级 BUSY
- `packages/agent/src/index.ts`
  - 周期状态上报和窗口命令拦截改为按窗口判断
- 四个执行器：
  - `ArrivalExecutor.ts`
  - `DispatchExecutor.ts`
  - `SignExecutor.ts`
  - `IntegratedExecutor.ts`
  - 在 READY 窗口匹配成功后 acquire
  - 在 `finally` 中 release

### 11.4 涉及文件

- `packages/agent/src/local-runtime/WindowBusyRegistry.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/executors/ArrivalExecutor.ts`
- `packages/agent/src/executors/DispatchExecutor.ts`
- `packages/agent/src/executors/SignExecutor.ts`
- `packages/agent/src/executors/IntegratedExecutor.ts`

### 11.5 前后执行对比

**之前**

- 只要 Agent 有任务在跑，其他窗口也可能被认为 busy
- 空闲窗口也可能被错误阻止关闭 / 重启

**之后**

- 只有被当前任务占用的窗口进入 busy
- 其他空闲窗口仍可独立关闭 / 重启 / 刷新

### 11.6 本步收益

- 消除多窗口场景下的误伤
- BUSY 的语义从“Agent 忙”变成“窗口忙”
- 为后续状态机奠定准确的占用信息

---

## 12. Step 6：ReadyGuard + 状态机

### 12.1 本步目标

- 解决 READY 误判
- 统一窗口生命周期状态
- 收敛 Agent 和前端的状态语义

### 12.2 实际做了哪些工作

- 将 Dashboard 严格判定抽象为独立分类器
- 新增轻量 `ReadyGuard`
- 新增 `WindowStateMachine`
- 状态采集、开窗 phase 回传、状态上报都改走统一状态推导
- 前端识别新增的 `error` 状态

### 12.3 具体如何实现

- `packages/agent/src/browser/BnsyDashboardDetector.ts`
  - 新增 `DashboardSnapshot`
  - 新增 `classifyDashboardSnapshot(...)`
- `packages/agent/src/local-runtime/ReadyGuard.ts`
  - 通过本地 CDP `/json` + WebSocket `Runtime.evaluate` 做轻量严格检查
- `packages/agent/src/local-runtime/WindowStateMachine.ts`
  - 定义：
    - `offline`
    - `starting`
    - `logging_in`
    - `login_required`
    - `ready_checking`
    - `ready`
    - `busy`
    - `error`
- `packages/agent/src/local-runtime/WindowStatusCollector.ts`
  - 增加：
    - `readyState`
    - `readyMessage`
    - `readyWarnings`
    - `hasCoreDom`
    - `hasBlockedPopup`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
  - phase 增加 `ready_checking`
- `packages/agent/src/index.ts`
  - 周期上报和最终开窗结果改走 `deriveWindowState(...)`
- 前端：
  - `frontend/src/api/client.ts`
  - `frontend/src/lib/window-status.ts`

### 12.4 涉及文件

- `packages/agent/src/browser/BnsyDashboardDetector.ts`
- `packages/agent/src/local-runtime/ReadyGuard.ts`
- `packages/agent/src/local-runtime/WindowStateMachine.ts`
- `packages/agent/src/local-runtime/WindowStatusCollector.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/index.ts`
- `frontend/src/api/client.ts`
- `frontend/src/lib/window-status.ts`

### 12.5 前后执行对比

**之前**

- READY 主要依赖 URL / 基础 CDP 状态
- 状态语义分散在多个模块里手工拼接

**之后**

```text
状态采集
  -> ReadyGuard 严格判断页面
  -> WindowStateMachine 统一推导生命周期状态
  -> 上报 Cloud
  -> Frontend 统一映射展示
```

### 12.6 本步收益

- READY 误判显著降低
- 开窗、刷新、周期状态采集共用同一套状态语义
- 错误态不再混成 `failed` 或未知态

---

## 13. Step 7：拆 `index.ts`，整理 Agent 内核

### 13.1 本步目标

- 把过重的 `index.ts` 拆轻
- 在不改变外部行为的前提下，先把运行时编排结构整理出来

### 13.2 实际做了哪些工作

- 新增 `TaskLoop`
- 新增 `StatusPublisher`
- 新增 `WindowCommandLoop`
- `index.ts` 从“大而全实现文件”转为“运行时装配层”

### 13.3 具体如何实现

- `packages/agent/src/runtime/TaskLoop.ts`
  - 封装任务拉取、立即补偿轮询、in-flight 控制、runningTaskId
- `packages/agent/src/runtime/StatusPublisher.ts`
  - 封装 tracked windows 管理、周期状态采集、统一上报
- `packages/agent/src/runtime/WindowCommandLoop.ts`
  - 封装窗口命令拉取、执行、ack/running/done、状态上报
- `packages/agent/src/index.ts`
  - 只负责：
    - 启动检查
    - 授权校验
    - 创建运行时循环
    - heartbeat
    - WS 接线
    - shutdown

### 13.4 涉及文件

- `packages/agent/src/runtime/TaskLoop.ts`
- `packages/agent/src/runtime/StatusPublisher.ts`
- `packages/agent/src/runtime/WindowCommandLoop.ts`
- `packages/agent/src/index.ts`

### 13.5 前后执行对比

**之前**

- 任务循环、状态上报、窗口命令、heartbeat、WS 全堆在 `index.ts`
- 任何改动都容易牵一发动全身

**之后**

```text
index.ts
  -> createTaskLoop(...)
  -> createStatusPublisher(...)
  -> createWindowCommandLoop(...)
  -> AgentWsClient 接线
```

### 13.6 本步收益

- 运行时职责开始分层
- 为 Step 8 的 `AgentDaemon` 收口创造条件
- 后续继续演进时，不必再从一个超大入口文件切入

---

## 14. Step 8：小收口

### 14.1 本步目标

- 把 Step 7 拆出的运行时模块再进一步收口
- 为当前状态补齐运行文档和最小 smoke checklist

### 14.2 实际做了哪些工作

- 新增 `packages/agent/src/runtime/AgentDaemon.ts`
- 将 `index.ts` 压缩成真正的薄入口
- 更新 `packages/agent/README.md`
- 新增 `packages/agent/docs/smoke-checklist.md`

### 14.3 具体如何实现

- `AgentDaemon` 统一收拢：
  - startup check
  - `/agent/me` 鉴权
  - heartbeat
  - TaskLoop
  - StatusPublisher
  - WindowCommandLoop
  - AgentWsClient
  - shutdown
- `index.ts` 现在只负责：
  - 横幅输出
  - `loadConfig()`
  - `initLogger()`
  - `new AgentDaemon(...).start()`
- `README.md` 从“Phase 4-D 骨架模式”修正为当前真实运行态
- `smoke-checklist.md` 固化最小联调与回归步骤

### 14.4 涉及文件

- `packages/agent/src/runtime/AgentDaemon.ts`
- `packages/agent/src/index.ts`
- `packages/agent/README.md`
- `packages/agent/docs/smoke-checklist.md`

### 14.5 前后执行对比

**之前**

- `index.ts` 虽然已拆出部分模块，但仍承担完整启动编排
- README 严重过期，仍停留在“不会拉任务 / 不会执行任务 / 不会启动浏览器”

**之后**

```text
index.ts
  -> AgentDaemon.start()

AgentDaemon
  -> startup/auth
  -> heartbeat
  -> taskLoop
  -> statusPublisher
  -> commandLoop
  -> wsClient
  -> shutdown
```

### 14.6 本步收益

- 入口进一步瘦身
- 运行时结构命名明确
- 文档与真实运行态对齐
- 联调和回归有明确清单可执行

---

## 15. 当前代码落点总结

### 15.1 新增或核心新增模块

- `packages/agent/src/runtime/TaskLoop.ts`
- `packages/agent/src/runtime/StatusPublisher.ts`
- `packages/agent/src/runtime/WindowCommandLoop.ts`
- `packages/agent/src/runtime/AgentDaemon.ts`
- `packages/agent/src/local-runtime/WindowBusyRegistry.ts`
- `packages/agent/src/local-runtime/ReadyGuard.ts`
- `packages/agent/src/local-runtime/WindowStateMachine.ts`
- `packages/agent/docs/smoke-checklist.md`

### 15.2 核心被增强的模块

- `packages/agent/src/index.ts`
- `packages/agent/src/ws/AgentWsClient.ts`
- `packages/agent/src/httpClient.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/local-runtime/WindowStatusCollector.ts`
- `packages/agent/src/browser/BnsyDashboardDetector.ts`
- `backend/api/routes.ts`
- `backend/agent/AgentWebSocket.ts`
- `backend/agent/agentRoutes.ts`
- `frontend/src/components/layout/Header.tsx`
- `frontend/src/components/shared/WindowStateProvider.tsx`
- `frontend/src/lib/window-status.ts`
- `frontend/src/api/client.ts`

---

## 16. 当前效果总结

### 16.1 已经解决的问题

- 任务响应速度不再主要依赖 heartbeat
- 批量窗口命令不再天然慢于单窗通知
- Header 点击后不再需要先等待后端确认才有反馈
- BUSY 从全局误伤改成窗口级准确占用
- READY 判定从轻量 URL 判断升级为严格检查
- `index.ts` 不再承担全部运行时职责
- 文档与当前真实运行态已经同步

### 16.2 当前仍保留的边界

- 旧 Cloud 执行链仍保留兼容入口，但不再扩展
- 未迁移任务类型仍可走 Cloud `run-engine`
- Step 8 是“小收口”，不是最终安装包、桌面壳或服务化交付

### 16.3 当前遗留工作

- `BrowserPage` 仍未升级为正式本地执行套件管理页
- 本地窗口 registry 的持久化恢复仍可继续增强
- 安装形态、开机自启、自检与排障工具仍可继续完善

---

## 17. 最终结论

本轮 `Step 0` 到 `Step 8` 的改造，不是一次性“大重写”，而是一条明确的小步快跑路径：

- 先锁死边界
- 再补观测
- 再加速通知链
- 再补前端体感
- 再修状态正确性
- 最后收运行时结构和文档

从结果上看，当前 DaoPai V4 已经从“Agent 真实能力存在但结构混杂、状态不够准、体感不够快”的状态，推进到“Agent 为正式执行层、WS 为主通道、状态语义更统一、运行时编排更清晰”的新阶段。

如果后续继续推进，最自然的下一阶段将是：

- 浏览器管理页落地
- 本地安装形态与开机自启方案
- registry 恢复与孤儿进程治理
- 更完整的运维和自检能力

