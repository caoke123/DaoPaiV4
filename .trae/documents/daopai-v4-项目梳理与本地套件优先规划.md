# DaoPai V4 本地 Agent 窗口管理与通信方案审查报告

## 1. 当前代码现状

### 1.1 云端 / Agent / 前端的真实分工

- `backend/index.ts` 已经把云端主链完整挂起：`/agent` 路由、业务路由、窗口运行时路由、HTTP Server、`/agent/ws` WebSocket，全都在同一个 Express 进程里启动，说明当前云端是“单体控制面”。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/backend/index.ts#L244-L316)
- `backend/agent/agentRoutes.ts` 已实现 Agent 鉴权、心跳、任务拉取、日志/进度/完成/失败回传、窗口状态上报、窗口命令 pull/complete/fail，说明云端已经具备正式编排层能力。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L35-L755)
- `packages/agent/src/index.ts` 已经不是“骨架”，而是一个真实常驻执行端：启动检查、配置加载、心跳、任务拉取、本地业务执行器、窗口状态上报、窗口命令轮询、WS 联动都在这里。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L200-L767)
- 前端真实的窗口交互核心不在 `BrowserPage.tsx`，而在全局 `Header.tsx` + `WindowStateProvider.tsx`。`BrowserPage.tsx` 仍是占位页。证据：[Header.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/layout/Header.tsx#L35-L260)、[BrowserPage.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/pages/BrowserPage.tsx#L6-L20)

### 1.2 当前 Agent 已具备哪些窗口管理能力

- 支持四类窗口命令：`open_window`、`close_window`、`restart_window`、`refresh_status`。证据：[httpClient.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/httpClient.ts#L237-L279)
- `LocalWindowRuntime.ts` 已具备本地窗口生命周期能力：
  - `open_window`: 启动 Chrome、连 CDP、导航、自动登录、P0 检测、状态回传。
  - `close_window`: 优先按 registry 的 PID/CDP 精准关闭。
  - `restart_window`: close + reopen。
  - `refresh_status`: 主动采集一次当前状态。
  证据：[LocalWindowRuntime.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/LocalWindowRuntime.ts#L123-L431)
- `LocalWindowRegistry.ts` 已保存 `windowId -> chromePid / cdpEndpoint / debugPort / profilePath`，可用于精准关闭。证据：[LocalWindowRegistry.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/LocalWindowRegistry.ts#L12-L80)
- `BrowserManager.ts` 已把“只使用项目内 Portable Chrome、只用指定 profile、禁止误伤系统 Chrome、关闭时必须确认 PID 归属”这些硬约束落进实现。证据：[BrowserManager.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/browser/BrowserManager.ts#L1-L15)、[BrowserManager.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/browser/BrowserManager.ts#L74-L198)

### 1.3 当前 Agent 已具备哪些任务能力

- 心跳和任务拉取已经跑通。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L255-L365)、[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L78-L156)
- Arrival / Dispatch / Sign / Integrated 已优先走 Agent 本地执行器，未知任务才回退兼容的 Cloud `run-engine`。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L284-L337)
- 任务日志、进度、完成、失败回传链路已完整。证据：[httpClient.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/httpClient.ts#L92-L146)、[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L225-L472)
- 四类执行器已经复用 READY 窗口接管能力，核心思路是“优先接管已有 READY 窗口，而不是新开浏览器”。证据：[ArrivalExecutor.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/executors/ArrivalExecutor.ts#L242-L331)、[DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/executors/DispatchExecutor.ts#L276-L364)、[SignExecutor.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/executors/SignExecutor.ts#L380-L454)、[IntegratedExecutor.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/executors/IntegratedExecutor.ts#L333-L415)

### 1.4 当前 Cloud 到 Agent 的窗口控制链路

- 前端 Header 点击后，不直接调用本地运行时，而是走 `/api/cloud/windows/commands` 创建命令。证据：[client.ts](file:///e:/网站开发/DaoPaiV4/frontend/src/api/client.ts#L1058-L1109)、[routes.ts](file:///e:/网站开发/DaoPaiV4/backend/api/routes.ts#L457-L523)
- 命令先持久化到 `window_commands`，再尝试通过 WebSocket 推送给在线 Agent。证据：[routes.ts](file:///e:/网站开发/DaoPaiV4/backend/api/routes.ts#L487-L518)、[PgDatabase.ts](file:///e:/网站开发/DaoPaiV4/backend/db/PgDatabase.ts#L2207-L2223)
- Agent WS 收到 `command_available` 后，并不直接执行，而是触发一次 HTTP `pullWindowCommands()`，通过 `claimPendingWindowCommands()` 原子 claim 命令。证据：[AgentWsClient.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/ws/AgentWsClient.ts#L123-L145)、[PgDatabase.ts](file:///e:/网站开发/DaoPaiV4/backend/db/PgDatabase.ts#L2231-L2293)
- 前端同时订阅 SSE `/api/cloud/windows/events`，靠 `command_*` 和 `window_status_updated` 做及时刷新。证据：[WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/shared/WindowStateProvider.tsx#L196-L267)、[AgentWebSocket.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/AgentWebSocket.ts#L251-L312)

### 1.5 当前数据库支撑情况

#### 已存在

- `window_status`：
  - 已有 `tenant_id/site_id/workstation_id/window_id/staff_name`
  - 已有 `status/status_text/current_url/is_process_alive/is_cdp_ready/is_dashboard_ready/is_login_page`
  - 已有 `last_error/cdp_endpoint/profile_path/chrome_pid/updated_at`
  证据：[009_v3_window_status.sql](file:///e:/网站开发/DaoPaiV4/database/migrations/009_v3_window_status.sql#L11-L54)
- `window_commands`：
  - 已有 `id/tenant_id/site_id/workstation_id/window_id/staff_name/type/status`
  - 已有 `params/result/error/created_at/claimed_at/started_at/finished_at/updated_at`
  证据：[010_v3_window_commands.sql](file:///e:/网站开发/DaoPaiV4/database/migrations/010_v3_window_commands.sql#L11-L51)
- Agent 心跳、工作站、多租户底座已存在。证据：[001_v3_multitenant_base.sql](file:///e:/网站开发/DaoPaiV4/database/migrations/001_v3_multitenant_base.sql)、[004_v3_agent_token_auth.sql](file:///e:/网站开发/DaoPaiV4/database/migrations/004_v3_agent_token_auth.sql)、[005_v3_agent_task_loop.sql](file:///e:/网站开发/DaoPaiV4/database/migrations/005_v3_agent_task_loop.sql)

#### 明显缺口

- `window_status` 缺少 `busy_task_id`、`last_command_id`、`state_version`、`last_state_changed_at`。
- `window_commands` 缺少 `received_at`、`trigger_source`、`idempotency_key`、`attempt_count`。
- 本地 registry 没有持久化恢复表或本地快照文件。

## 2. 当前最大问题

### 2.1 `packages/agent/src/index.ts` 职责过重

- 该文件同时承担：
  - AgentDaemon 启动
  - 心跳
  - 任务拉取
  - 窗口命令循环
  - 窗口状态循环
  - WS 客户端生命周期
  - 本地窗口 tracking
- 这是当前最直接的结构风险。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L200-L767)

### 2.2 Busy 粒度错误

- 现在只有一个全局 `runningTaskId`，意味着任意一个任务运行时，所有窗口都被视为 busy。
- 结果是：
  - 可能错误阻止关闭其他空闲窗口
  - 无法表达“多窗口并发、多窗口独立 BUSY”
- 证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L51-L52)、[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L394-L397)、[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L481-L485)

### 2.3 Registry 还不是可靠状态源

- `LocalWindowRegistry.ts` 只有进程内 `Map`，没有落盘恢复，没有多键索引，没有 composite key 隔离。证据：[LocalWindowRegistry.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/LocalWindowRegistry.ts#L25-L80)
- 注释写着“Agent 重启后通过 window_status 恢复”，但当前 registry 文件本身没有恢复实现。证据：[LocalWindowRegistry.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/LocalWindowRegistry.ts#L1-L10)
- 这会带来：
  - Agent 重启后丢 PID/CDP/profilePath 映射
  - Cloud 仍显示 READY，但本地 manager 不认识这个窗口
  - 关闭命令只能退化为按 profilePath 扫描

### 2.4 READY 判定过于依赖 URL

- `WindowStatusCollector.ts` 主要依据 URL 判断 login/dashboard，没做关键 DOM、阻塞弹窗、归属校验。证据：[WindowStatusCollector.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/WindowStatusCollector.ts#L101-L186)
- 这意味着 READY 可能被误判为：
  - 跳到错误业务页但 URL 仍在同域
  - 卡在半登录态
  - 被弹窗遮挡
  - 实际已不属于正确 staff/window

### 2.5 命令链路的“快通道”还没完全打通

- 单窗口命令接口会尝试 WS 推送。证据：[routes.ts](file:///e:/网站开发/DaoPaiV4/backend/api/routes.ts#L497-L518)
- 批量命令接口当前只写库、不推 WS，这会直接拖慢“一键启动”。证据：[routes.ts](file:///e:/网站开发/DaoPaiV4/backend/api/routes.ts#L530-L566)
- `markWindowCommandRunning()` 已实现但未接入执行链，`running` 状态没有被充分利用。证据：[PgDatabase.ts](file:///e:/网站开发/DaoPaiV4/backend/db/PgDatabase.ts#L2295-L2303)
- WS `command_ack` 只是广播 SSE，不更新 DB 状态，状态语义存在混淆。证据：[AgentWebSocket.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/AgentWebSocket.ts#L251-L260)

### 2.6 任务响应节奏没有真正解耦

- `config.ts` 有 `taskPollIntervalMs`。证据：[config.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/config.ts#L29-L34)、[config.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/config.ts#L90-L93)
- 但 `index.ts` 实际只有一个按 `heartbeatIntervalMs` 驱动的主循环，`taskPollIntervalMs` 只是打印，没有独立调度。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L248-L252)、[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L255-L365)
- 后端 heartbeat 也返回 `nextPollAfterMs`，但 Agent 没使用。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L96-L107)
- 这会造成“任务感知速度”和“心跳速度”耦合。

### 2.7 前端体验仍偏“轮询确认”，还不是“点击即反馈 + 实时确认”

- `Header.tsx` 点击后要轮询 `getWindowCommand()`，最长 15 秒。证据：[Header.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/layout/Header.tsx#L141-L180)
- `WindowStateProvider.tsx` 还依赖 5 秒状态轮询、30 秒 runtime 轮询，SSE 断线后再 5 秒重连。证据：[WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/shared/WindowStateProvider.tsx#L108-L122)、[WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/shared/WindowStateProvider.tsx#L188-L194)、[WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/components/shared/WindowStateProvider.tsx#L253-L259)
- `BrowserPage.tsx` 还是空白页，因此本地套件控制面板尚未落地。证据：[BrowserPage.tsx](file:///e:/网站开发/DaoPaiV4/frontend/src/pages/BrowserPage.tsx#L6-L20)

### 2.8 云端旧执行链仍大量存在

- `Database.ts` 明确写着自己已降级为 `legacy / fallback / 非主数据源`。证据：[Database.ts](file:///e:/网站开发/DaoPaiV4/backend/db/Database.ts#L12-L25)
- `agentRoutes.ts` 仍保留 `/agent/tasks/:id/run-engine` 兼容入口。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L158-L223)
- `window-connections` 仍 fallback 到 `PlaywrightRuntime`。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L597-L646)
- `check-no-cloud-engine.js` 已经在防止 Cloud 执行链回流，说明这个风险真实存在。证据：[check-no-cloud-engine.js](file:///e:/网站开发/DaoPaiV4/scripts/check-no-cloud-engine.js#L1-L213)

## 3. V3 速度体验为什么好

### 3.1 前端触发链更短

- V3 Header 更偏直接触发 `ensure/close` 类动作，前端对窗口操作的链路更短。参考证据：[V3 Header.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/components/layout/Header.tsx)、[V3 client.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/api/client.ts)

### 3.2 用户更早看到“系统在工作”

- V3 的核心优势不只是“物理启动更快”，而是“更早给用户正反馈”：
  - 点一下就有状态变化
  - 本地执行很快接手
  - 日志/状态马上出现
- V4 当前也在做这件事，但被命令轮询、状态轮询稀释了体感。

### 3.3 本地执行链更接近“直达”

- V3 文档和后续迁移文档都强调 Cloud 只建任务，Agent 在本地执行浏览器动作。证据：[V3_PHASE5_G4_1_CURRENT_CODE_EXECUTION_CHAIN_FIX.md](file:///e:/网站开发/DaoPaiV3/docs/V3_PHASE5_G4_1_CURRENT_CODE_EXECUTION_CHAIN_FIX.md#L10-L21)

### 3.4 READY 窗口复用是快感的核心来源

- V4 当前四类执行器已经在复用 READY 窗口，这其实就是延续 V3 速度体验最关键的部分。证据：[BrowserManager.connectExisting](file:///e:/网站开发/DaoPaiV4/packages/agent/src/browser/BrowserManager.ts#L343-L416)

## 4. V4 要保留哪些体验

- Header 点击后 UI 立即变化，不要先等命令完成。
- 单窗口打开要先给 `OPENING`，不要长时间停在“未知”。
- 关闭窗口必须接近秒关，并且关闭后状态立即干净。
- 一键启动不能因为批量写库而失去 WS 加速。
- 任务创建后 Agent 应尽快感知，不应完全依赖长轮询。
- READY 只能在严格校验通过后出现，不能为了“看起来快”放宽判断。

## 5. 推荐总体架构

### 5.1 最终分工

#### Cloud

- 负责租户、站点、工作站、用户、任务中心、日志中心。
- 负责 `window_commands` 与 `window_status` 持久化。
- 负责对前端提供 REST + SSE。
- 负责对 Agent 提供 REST + WebSocket。

#### Agent

- 作为唯一正式执行层。
- 常驻管理本地 Chrome / Portable Chrome。
- 维护本地窗口注册表、状态机、CDP 连接、任务执行队列。
- 接受 Cloud 命令并回传状态、日志、结果。

#### Frontend

- 负责“远程控制面板”，不是浏览器实际执行者。
- Header Tag 负责快速操作入口。
- BrowserPage 负责完整管理视图。
- 显示乐观状态，最终以 Agent 上报状态为准。

### 5.2 主链路建议

```text
Frontend
  -> Cloud REST 创建 window_command / task
  -> Cloud 立即 WS 通知 Agent
  -> Agent claim + execute
  -> Agent 关键状态立即上报 Cloud
  -> Cloud SSE / WS 广播前端
  -> Frontend 实时修正乐观 UI
```

### 5.3 三种通信模式比较

| 方案 | 角色 | 是否推荐 | 结论 |
|---|---|---:|---|
| A. Cloud WS Command Push | 主方案 | 是 | 作为主链路，最快且不破坏审计 |
| B. 高频短轮询 | 兜底 | 是 | 作为断线或丢通知的补偿 |
| C. Localhost Bridge | 可选增强 | 暂缓 | 只作为后续极致提速增强，不做第一阶段依赖 |

### 5.4 推荐结论

- 主方案必须是 `Cloud WebSocket -> Agent`。
- 命令真源仍是 `window_commands`，WS 只加速，不替代持久化。
- 任务通知也应引入 WS 提示，轮询作为兜底。
- `Localhost Bridge` 不应作为核心依赖。

## 6. 本地 Agent 窗口管理内核设计

### 6.1 推荐模块

| 模块 | 职责 | 当前代码对应 | 建议 |
|---|---|---|---|
| `AgentDaemon` | 启动常驻、加载配置、初始化所有循环、处理退出恢复 | `packages/agent/src/index.ts` | 新增顶层编排器，拆出 `index.ts` |
| `LocalWindowSupervisor` | 统一接收 open/close/restart/refresh；同一 `windowId` 串行 | `LocalWindowRuntime.ts` + `index.ts` | 新增 |
| `WindowRegistry` | 维护窗口运行态和本地索引；支持恢复与清理 | `LocalWindowRegistry.ts` | 重构增强 |
| `BrowserProcessManager` | 启动/关闭 Chrome；端口和 profile 归属校验 | `BrowserManager.ts` | 保留并增强 |
| `CdpConnectionManager` | 维护 CDP 可用性、绑定关系、防串连 | 分散在 `BrowserManager.ts` / `WindowStatusCollector.ts` | 新增 |
| `WindowStateMachine` | 统一窗口状态变迁 | 分散在 `index.ts` / `WindowStatusCollector.ts` / 前端 helper | 新增 |
| `ReadyGuard` | READY 严格判定 | `ensureBnsyLoggedIn` + `WindowStatusCollector` | 新增 |
| `CommandRouter` | 去重、排队、同窗串行、ack/running/success/failed | `pullWindowCommandsLoop` | 新增 |
| `StatusPublisher` | 状态节流上报、关键状态立即上报、事件回推 | `reportWindowStatus` + WS 部分 | 新增 |
| `TaskLoop` | 任务通知、窗口锁定、执行、日志回传、释放 BUSY | `tick()` + executors | 拆出 |

### 6.2 推荐模块边界

#### `AgentDaemon`

- 负责：
  - `loadConfig()`
  - `startupCheck()`
  - `HeartbeatLoop`
  - `TaskLoop`
  - `WindowCommandLoop`
  - `StatusPublisher`
  - `LocalWindowSupervisor`
- 第一阶段建议形态：
  - `Node CLI 常驻进程` + 开机自启脚本
  - 不先上 Tauri/Electron
  - 不先做 Windows Service
- 原因：
  - 风险最低
  - 便于调试
  - 不引入 GUI 壳层复杂度

#### `LocalWindowSupervisor`

- 接口建议：

```ts
interface LocalWindowSupervisor {
  open(input: WindowTarget): Promise<WindowRuntimeState>
  close(input: WindowTarget): Promise<void>
  restart(input: WindowTarget): Promise<WindowRuntimeState>
  refresh(input: WindowTarget): Promise<WindowRuntimeState>
}
```

- 规则：
  - 同一 `windowId` 同时只有一个生命周期动作
  - 不同 `windowId` 可并行
  - 生命周期动作内部可发阶段事件

#### `WindowRegistry`

- 必须从“纯内存 Map”升级为“内存主态 + 本地快照恢复”。
- 主键不能只靠 `windowId`，建议内部索引至少包含：
  - `tenantId + siteId + workstationId + windowId`
  - `pid`
  - `debugPort`
  - `profilePath`
- 必须支持：
  - 启动恢复
  - 孤儿进程识别
  - 关闭彻底清理
  - 同名员工跨站点隔离

#### `BrowserProcessManager`

- 保留 `BrowserManager.ts` 的安全思路：
  - 只使用本地 Portable Chrome
  - 强制固定 profile
  - 检查端口归属
  - 禁止误连系统 Chrome
- 但职责要下沉为“纯进程层”：
  - 启动进程
  - 关闭进程
  - 检查 profile lock
  - 端口就绪检测
- 不再承担 READY 判定和业务页面逻辑

#### `CdpConnectionManager`

- 当前 `BrowserManager.connectExisting()` 是很好的复用点。证据：[BrowserManager.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/browser/BrowserManager.ts#L343-L416)
- 建议新增职责：
  - `connect(windowState)`
  - `validateBinding(windowState)`
  - `ping(windowState)`
  - `disconnect(windowState)`
- 必须保证：
  - `cdpEndpoint` 只能绑定 `127.0.0.1`
  - 不允许跨 `siteId/windowId` 复用

#### `ReadyGuard`

- 必须替代当前纯 URL 判定方式。
- READY 至少应验证：
  - CDP 可用
  - 当前 URL 在正确业务域
  - 非 login
  - 核心业务 DOM 存在
  - 无阻塞弹窗
  - 当前窗口归属匹配 `siteId/staffName/windowId`
  - 当前没有 `busyTaskId`

## 7. Cloud / Agent / Frontend 通信方式设计

### 7.1 推荐主通信方式

#### Command

```text
Frontend -> Cloud REST -> window_commands
Cloud -> Agent WS(command_available)
Agent -> Cloud HTTP claim
Agent -> execute
Agent -> Cloud HTTP complete/fail + WS status event
Cloud -> Frontend SSE
```

#### Task

```text
Frontend -> Cloud REST create task
Cloud -> Agent WS(task_available)
Agent -> Cloud HTTP pullTask
Agent -> execute
Agent -> Cloud progress/logs/complete/fail
Cloud -> Frontend SSE
```

### 7.2 方案 A：WebSocket Command Push 作为主方案

#### 当前代码基础

- Cloud WS 服务已挂载。证据：[backend/index.ts](file:///e:/网站开发/DaoPaiV4/backend/index.ts#L313-L316)
- Agent WS 客户端已具备断线重连和收到命令后补偿拉取。证据：[AgentWsClient.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/ws/AgentWsClient.ts#L91-L205)
- Cloud 已支持将窗口命令推送给在线 Agent。证据：[AgentWebSocket.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/AgentWebSocket.ts#L130-L158)

#### 需要增强

- 批量命令也要 WS 推送，不然一键启动总会慢一拍。
- 增加任务通知 WS。
- 增加 `received_at`。
- `command_running` 应同步落 DB，而不是只广播 SSE。

#### Ack 设计建议

| 阶段 | 建议含义 | 持久化 |
|---|---|---|
| `pending` | Cloud 已创建命令 | DB |
| `received` | Agent 已通过 WS 收到通知 | DB 新字段 `received_at` 或事件表 |
| `claimed` | Agent 已通过 HTTP claim 命令 | DB 现有 |
| `running` | Agent 已开始执行本地动作 | DB 现有 |
| `success` | 已完成 | DB `done` |
| `failed` | 已失败 | DB `failed` |

#### 丢命令处理

- 不依赖 WS 送达保证。
- 所有命令先入 `window_commands`。
- Agent 任何时候都能通过 `pullWindowCommands()` 补拉。
- Agent 重连后必须立即补拉 pending/claimed 未完成命令。

### 7.3 方案 B：高频短轮询作为兜底

#### 建议参数

- WS 在线：
  - 命令兜底轮询 `2s~5s`
  - 不建议 30s
- WS 离线：
  - 命令轮询 `500ms~1s`
  - 任务轮询 `500ms~1s`
- 空闲长稳态：
  - 可退到 `3s~5s`

#### 原因

- 当前 WS 在线时 30 秒兜底太慢，丢一条通知体感会很差。证据：[index.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/index.ts#L451-L459)

### 7.4 方案 C：Localhost Bridge 作为可选增强

#### 结论

- 不建议第一阶段引入。
- 可以作为同机前端的极速增强，但只能可选。

#### 原因

- HTTPS 页面访问 HTTP localhost 有混合内容问题。
- CORS 和本地 token 校验都要重新设计。
- 企业网络和安全软件有额外不确定性。
- 当前主链通过 WS 已足够做到接近 V3。

## 8. 打开 / 关闭 / 重启 / 刷新 / 执行任务流程

### 8.1 打开窗口流程

```text
Frontend Header 点击窗口 Tag
  -> Frontend 立即将该 Tag 标记为 OPENING
  -> Cloud 创建 open_window command
  -> Cloud WS 推送 command_available 给 Agent
  -> Agent CommandRouter 记录 received
  -> Agent HTTP claim 命令
  -> LocalWindowSupervisor 加窗口级生命周期锁
  -> WindowStateMachine: OFFLINE -> OPENING
  -> BrowserProcessManager 启动 Chrome
  -> CdpConnectionManager 建立 CDP
  -> WindowStateMachine: OPENING -> CONNECTING
  -> ReadyGuard 校验页面
  -> 通过: READY / 待登录: LOGIN_REQUIRED / 失败: FAILED
  -> StatusPublisher 立即上报关键状态
  -> Cloud SSE 推送给 Frontend
  -> Frontend 用最终状态修正乐观 UI
```

### 8.2 关闭窗口流程

```text
Frontend 点击关闭
  -> Frontend 立即标记 CLOSING
  -> Cloud 创建 close_window command
  -> Cloud WS 推送 Agent
  -> Agent claim
  -> LocalWindowSupervisor 加锁
  -> WindowStateMachine: READY/BUSY/FAILED -> CLOSING
  -> BrowserProcessManager 优先 CDP close
  -> 若未退出则按 registry PID taskkill /T
  -> 清理 CDP 绑定
  -> WindowRegistry 清空 pid/cdp/profile 临时态
  -> WindowStateMachine -> OFFLINE
  -> StatusPublisher 立即上报 OFFLINE
  -> Frontend 立即变干净
```

### 8.3 重启窗口流程

```text
Frontend 点击重启
  -> Cloud 创建 restart_window
  -> Agent claim
  -> WindowStateMachine -> RESTARTING
  -> 执行 close 流程
  -> 清理 registry / cdp / busyTaskId
  -> 执行 open 流程
  -> 最终进入 READY / LOGIN_REQUIRED / FAILED
```

### 8.4 刷新状态流程

```text
Frontend 点击刷新
  -> Cloud 创建 refresh_status
  -> Agent claim
  -> CdpConnectionManager ping
  -> ReadyGuard 重新校验
  -> WindowStateMachine 根据结果更新
  -> StatusPublisher 立即上报
```

### 8.5 创建业务任务并执行流程

```text
Frontend 创建任务
  -> Cloud insert task(status=pending/assigned)
  -> Cloud WS 通知 Agent task_available
  -> Agent TaskLoop 立即 pullTask
  -> TaskLoop 选择目标窗口
  -> WindowStateMachine: READY -> BUSY
  -> Executor 执行业务
  -> 实时 uploadLogs + reportProgress
  -> 完成后 completeTask / failTask
  -> WindowStateMachine: BUSY -> READY 或 DEGRADED
  -> StatusPublisher 立即上报
```

### 8.6 Agent 断线重连流程

```text
Agent WS 断开
  -> 切换到高频短轮询
  -> 继续 heartbeat + pull commands + pull tasks
  -> WS 重连成功
  -> 立即补拉 pending commands / pending tasks
  -> 补发本地窗口状态摘要
  -> Cloud 前端恢复实时状态
```

### 8.7 本地电脑重启后恢复流程

```text
AgentDaemon 启动
  -> 读取本地 WindowRegistry 快照
  -> 扫描 profile / pid / debugPort
  -> 识别仍存活窗口与孤儿进程
  -> 重新建立 registry
  -> 对每个窗口执行 ReadyGuard
  -> 上报恢复后的 window_status
  -> 补拉 pending commands / tasks
```

## 9. 状态机设计

### 9.1 推荐状态

| 状态 | 含义 | 可执行任务 |
|---|---|---:|
| `OFFLINE` | 未运行、已关闭、无有效进程 | 否 |
| `OPENING` | 正在启动 Chrome 或准备 profile | 否 |
| `CONNECTING` | 进程已起，正在建立 CDP | 否 |
| `LOGIN_REQUIRED` | 需要人工登录或被登录阻塞 | 否 |
| `LOGGING_IN` | 正在自动登录 | 否 |
| `READY_CHECKING` | 正在做 ReadyGuard 验证 | 否 |
| `READY` | 可安全执行任务 | 是 |
| `BUSY` | 正在执行任务 | 否 |
| `CLOSING` | 正在关闭 | 否 |
| `RESTARTING` | 重启中 | 否 |
| `DEGRADED` | 可连接但状态不可靠，需要人工或刷新 | 否 |
| `FAILED` | 生命周期操作失败 | 否 |

### 9.2 允许的关键迁移

```text
OFFLINE -> OPENING
OPENING -> CONNECTING
CONNECTING -> LOGGING_IN
CONNECTING -> LOGIN_REQUIRED
CONNECTING -> READY_CHECKING
LOGGING_IN -> READY_CHECKING
READY_CHECKING -> READY
READY_CHECKING -> LOGIN_REQUIRED
READY_CHECKING -> DEGRADED
READY -> BUSY
BUSY -> READY
READY/BUSY/DEGRADED/FAILED -> CLOSING
CLOSING -> OFFLINE
READY/BUSY/DEGRADED/FAILED -> RESTARTING -> OPENING
ANY -> FAILED
FAILED -> RESTARTING 或 OFFLINE
```

### 9.3 READY 判定规则

- 必须同时满足：
  - 进程存活
  - CDP 可连
  - URL 在目标业务系统域
  - 不是登录页
  - 关键业务 DOM 存在
  - 无阻塞弹窗
  - `tenantId/siteId/workstationId/windowId/staffName` 对应正确
  - `busyTaskId` 为空

### 9.4 BUSY 释放规则

- 只有执行器完成 `complete/fail/cancel` 后才能释放。
- Agent 崩溃恢复时，如果本地没有该 task 执行上下文，则把 BUSY 降级为 `DEGRADED`，等待刷新或重新分配。

### 9.5 close 后清理规则

- 必须清理：
  - `busyTaskId`
  - `cdpEndpoint`
  - `pid`
  - `lastError` 中的临时错误
  - 运行期 lease / lock
- `profilePath` 可保留为配置属性，但运行态字段必须清零。

### 9.6 failed 后恢复规则

- `FAILED` 不自动改成 `READY`。
- 只能通过：
  - `refresh_status`
  - `restart_window`
  - 人工登录后 `refresh_status`
- 恢复成功后进入 `READY_CHECKING -> READY`。

## 10. 性能优化策略

### 10.1 Agent 必须常驻

- 推荐第一阶段：`Node CLI 常驻 + 开机自启`。
- 不推荐第一阶段就上 Tauri/Electron/Windows Service。
- 理由：
  - 你当前最关键的是速度和稳定性，不是桌面壳。
  - CLI daemon 最容易观测与排障。

### 10.2 配置预加载

- `tenantId/siteId/workstationId/cloudBaseUrl/agentToken/settingsPath/browserPath/profileRoot` 全部在启动时加载。
- 点击 Header 时，不再重新扫描大配置。
- 当前 `config.ts` 已有缓存能力，可继续保留。证据：[config.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/config.ts#L19-L27)

### 10.3 启动优化

- 固定 Portable Chrome 路径。
- 固定 profile 目录。
- 启动阶段只做必要检查：
  - profile lock
  - 端口归属
  - 可执行文件存在
- 启动后立即先回 `OPENING`，不要等待完整登录后才让前端变化。
- READY 校验异步继续推进。

### 10.4 关闭优化

- 优先顺序：
  - CDP `Browser.close`
  - PID `taskkill /T`
  - 兜底按 profile residue 清理
- 关闭后立即上报 `OFFLINE`，不要等长超时。
- 当前 `close_window` 实现已经接近这个方向，应保留。证据：[LocalWindowRuntime.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/local-runtime/LocalWindowRuntime.ts#L305-L392)

### 10.5 状态更新优化

- 关键状态立即推送：
  - `OPENING`
  - `LOGGING_IN`
  - `LOGIN_REQUIRED`
  - `READY`
  - `BUSY`
  - `OFFLINE`
  - `FAILED`
- 周期心跳只做兜底摘要。
- 前端用 SSE/WS 接事件，不再严重依赖 5 秒轮询。

### 10.6 任务响应优化

- 任务创建后 Cloud 立即 WS 通知 Agent。
- Agent 立即 `pullTask()`。
- 独立 `TaskLoop` 使用自己的轮询节奏，不绑 heartbeat。
- 日志实时批量回传，建议 `300ms~800ms` 本地缓冲聚合，而不是每条都 HTTP。
- 多窗口多任务采用“窗口级 BUSY + 任务级并发池”。

## 11. 异常恢复策略

### 11.1 READY 误判

- 引入 `ReadyGuard`。
- 从“URL Ready”升级为“CDP + URL + DOM + popup + ownership”五重校验。

### 11.2 BUSY 残留

- 窗口状态必须记录 `busyTaskId`。
- 启动恢复时校验本地是否仍有该 task 执行上下文。
- 无上下文则降级 `DEGRADED`，不直接保留 BUSY。

### 11.3 跨站点污染

- 不允许仅靠 `staffName` 复用窗口。
- 任何窗口复用必须校验：
  - `tenantId`
  - `siteId`
  - `workstationId`
  - `windowId`
  - `profilePath`

### 11.4 关闭后又自动拉起

- 关闭命令完成后，必须清理 registry 运行态和任何自动恢复标记。
- Agent 启动恢复只恢复“确实存在的进程”，不根据 Cloud 状态自动重建窗口。

### 11.5 孤儿进程

- 启动和定期巡检都要做 orphan scan：
  - profile 存在
  - Chrome 进程存在
  - registry 无记录
- 发现后：
  - 尝试重新绑定
  - 或标记 `DEGRADED`
  - 必要时清理

## 12. 当前模块复用、冻结、重构清单

| 模块 | 当前职责 | 问题 | 建议处理 |
|---|---|---|---|
| `packages/agent/src/index.ts` | Agent 主入口、心跳、任务、窗口、WS 全包 | 过重、耦合高、忙闲粒度错误 | 需要重构 |
| `packages/agent/src/config.ts` | 配置加载、缓存、路径解析 | 结构可用，但字段语义还不够清晰 | 保留并增强 |
| `packages/agent/src/httpClient.ts` | Cloud 接口封装 | 适合继续复用；未来可加重试/批量策略 | 保留并增强 |
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | open/close/restart/refresh | 生命周期能力不错，但职责仍混有 Ready 判定 | 保留并下沉为 Supervisor 子模块 |
| `packages/agent/src/local-runtime/LocalWindowRegistry.ts` | 进程内窗口注册表 | 只有 Map、无恢复、无多索引 | 需要重构 |
| `packages/agent/src/local-runtime/WindowStatusCollector.ts` | 进程/CDP/URL 状态采集 | READY 判定过轻 | 保留并增强 |
| `packages/agent/src/browser/BrowserManager.ts` | 启停 Chrome、连 CDP、接管 READY 窗口 | 安全约束设计很好，职责稍宽 | 保留并增强 |
| `packages/agent/src/browser/AgentBusinessRuntime.ts` | DOM 清理、首页恢复、弹窗处理 | 复用价值很高 | 保留并增强 |
| `packages/agent/src/executors/*` | 四业务本地执行 | 模板重复较多 | 保留并逐步抽象 |
| `backend/agent/agentRoutes.ts` | Agent HTTP 协议主链 | 混有 fallback 兼容层 | 保留主链，兼容部分冻结 |
| `backend/agent/AgentWebSocket.ts` | Agent WS 通道、SSE 广播 | 方向正确，但 ack/running 状态还未完全闭环 | 保留并增强 |
| `backend/api/routes.ts` | Cloud 业务 API、窗口命令 API | 单窗推 WS，批量不推 | 保留并增强 |
| `backend/db/PgDatabase.ts` | 主数据源、window_status/window_commands CRUD | 结构正确 | 保留并增强 |
| `backend/db/Database.ts` | legacy fallback 数据源 | 双写残留、误导风险高 | 冻结不再扩展 |
| `backend/playwright-runtime/*` | 旧 Cloud 运行时 | 仍被 fallback 使用 | 冻结不再扩展 |
| `backend/window-adapter/*` | 旧适配链 | 不是未来正式方向 | 冻结不再扩展 |
| `backend/modules/assignment-engine/*` | 旧 Cloud 执行调度 | 当前仅适合兼容未迁移任务 | 仅保留兼容 |
| `scripts/check-no-cloud-engine.js` | 防 Cloud 执行回流 | 很有价值 | 保留并增强 |
| `frontend/src/components/shared/WindowStateProvider.tsx` | 窗口状态聚合 | 轮询占比高 | 保留并增强 |
| `frontend/src/components/layout/Header.tsx` | 窗口 Tag 主交互 | 轮询命令时间较长 | 保留并增强 |
| `frontend/src/pages/BrowserPage.tsx` | 浏览器管理页占位 | 还未落地 | 需要重构 |
| `frontend/src/api/client.ts` | 前端 API 封装 | 方向正确 | 保留并增强 |
| `frontend/src/components/layout/Sidebar.tsx` | 导航入口 | 可接入 BrowserPage 正式入口 | 保留并增强 |

## 13. 分阶段实施路线

### M1：窗口管理方案文档与边界冻结

#### 目标

- 明确 Agent 是唯一正式执行层。
- 明确 Cloud 不再扩展浏览器执行能力。
- 输出本报告和冻结清单。

#### 最小改造范围

- 只更新文档、架构说明、开发约束。
- 不改业务逻辑。

### M2：重构 Agent 内部结构，但不改变外部行为

#### 目标

- 从 `index.ts` 拆出：
  - `AgentDaemon`
  - `TaskLoop`
  - `WindowCommandLoop`
  - `LocalWindowSupervisor`
  - `StatusPublisher`
- 对外 HTTP/WS 协议不变。

### M3：WindowRegistry + WindowStateMachine + ReadyGuard 落地

#### 目标

- 引入窗口级 BUSY。
- 解决 READY 误判。
- 解决关闭后脏状态残留。
- 解决跨站点复用污染。

### M4：通信速度优化

#### 目标

- 窗口命令和任务通知都以 WS 为主。
- 轮询只做补偿。
- 一键启动增加批量 WS 推送。
- 前端更多依赖 SSE 事件，而不是命令轮询。

### M5：BrowserPage 管理页落地

#### 目标

- 将 `BrowserPage` 升级为本地执行套件管理页。
- 支持工作站、窗口、最近命令、Agent 状态管理。

### M6：本地套件安装形态设计

#### 目标

- 明确：
  - 安装目录
  - 运行目录
  - profile 目录
  - 日志目录
  - Portable Chrome 目录
  - 自检与排障方式

## 14. 每阶段验收标准

### M1 验收

- 文档明确：
  - Cloud 负责什么
  - Agent 负责什么
  - 哪些旧模块冻结
  - 为什么不能让 Cloud 直连本地 Chrome

### M2 验收

- Agent 可正常启动。
- 心跳正常。
- 任务拉取正常。
- 窗口命令正常。
- TypeScript 编译通过。

### M3 验收

- READY 必须经过 ReadyGuard。
- BUSY 必须按窗口级维护。
- 关闭后不残留 `BUSY/READY/cdpEndpoint/chromePid` 脏数据。
- 不误复用其他站点窗口。

### M4 验收

- Header 点击后 UI 立即反馈。
- 单窗命令大多在 1 秒内被 Agent 收到。
- 一键启动不再明显慢于单窗。
- 任务创建后 Agent 能快速开始执行。

### M5 验收

- BrowserPage 可以远程管理本地 Agent。
- 员工无需理解技术细节也能操作。
- Header Tag 与 BrowserPage 的状态一致。

### M6 验收

- 能清楚说明员工电脑如何安装。
- 能清楚说明如何绑定云端。
- 能清楚说明如何启动、停止、自检、排障。

## 15. 风险点与注意事项

### 15.1 不应该现在做的事情

- 不要直接删除 `backend/browser/*`。
- 不要直接删除 `backend/playwright-runtime/*`。
- 不要直接删除 `backend/window-adapter/*`。
- 不要一次性推倒重写 Agent。
- 不要引入复杂权限系统、支付系统、远程浏览器画面嵌入。
- 不要让 Cloud 直接连接本地 Chrome CDP。
- 不要让本地 Chrome CDP 暴露公网。

### 15.2 第一阶段最大的工程风险

- 如果一上来就改协议和 UI，会把问题面同时扩大到前后端和 Agent。
- 最低风险路径应该是：
  - 先冻结边界
  - 再拆 Agent 内部结构
  - 再引入状态机和 ReadyGuard
  - 最后做前端体感优化

### 15.3 需要特别关注的兼容点

- `window-connections` 还在 fallback 到 `PlaywrightRuntime`，迁移时不能立刻删。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L597-L646)
- `run-engine` 仍要保留给未迁移任务类型。证据：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV4/backend/agent/agentRoutes.ts#L158-L223)
- 现有 executors 已依赖 READY 窗口接管，重构时不要破坏 `connectExisting()` 契约。证据：[BrowserManager.ts](file:///e:/网站开发/DaoPaiV4/packages/agent/src/browser/BrowserManager.ts#L343-L416)

## 16. 最终建议

### 16.1 核心结论

- `DaoPai V4` 不需要回退到 `V3` 的旧后端控窗方式。
- 正确方向是：
  - 保留 Cloud 编排与持久化
  - 强化 Agent 常驻和本地窗口管理内核
  - 用 WS 把“快反馈”做回来
  - 用状态机和 ReadyGuard 把“准状态”做扎实

### 16.2 我给出的最终推荐

- 正式执行层：`packages/agent`
- 主命令通道：`Cloud WS -> Agent`，DB 持久化兜底
- 主状态通道：`Agent -> Cloud HTTP/WS -> Frontend SSE`
- UI 体验策略：`乐观 UI + 实时纠正`
- 窗口核心架构：`AgentDaemon + LocalWindowSupervisor + WindowRegistry + BrowserProcessManager + CdpConnectionManager + WindowStateMachine + ReadyGuard + CommandRouter + StatusPublisher + TaskLoop`

### 16.3 第一阶段最小改造范围

- 不改协议外形，不推倒任务链。
- 只做四件事：
  - 冻结 Cloud 旧执行残留边界
  - 拆 `packages/agent/src/index.ts`
  - 引入窗口级状态机和 registry 强化
  - 把 WS 推送做成真正主链路，补齐批量命令推送

### 16.4 这套方案最终服务的唯一目标

- 云端负责管理。
- 本地 Agent 负责快速、稳定、准确地管理 Chrome 窗口和执行任务。
- 在不牺牲架构边界的前提下，把 V3 的“秒启动、秒关闭、状态及时、任务响应快”体验带回 V4。

## 17. 按当前思路的完整执行方案

### 执行总原则

- 先冻结边界，再进入任何优化和重构。
- 先测量，再优化，不凭感觉改链路。
- 先加速“命令到达”和“任务感知”，再做状态正确性。
- 先保持外部协议兼容，再逐步重构内部结构。
- 每一步都要求“可回退、可对比、可验收”。

### Step 0：冻结边界和建立基线，绝对不能碰旧 Cloud 执行链

#### 目标

- 在进入任何性能优化前，先把“哪些链路可以改、哪些链路绝对不能碰”写死。
- 明确旧 Cloud 执行链只允许保持现状兼容，禁止继续扩展、禁止回流、禁止顺手改造。
- 为后续每一步建立可对比基线，避免优化后无法判断是否真的变快、是否引入回退。

#### 核心原则

- 绝对不能碰旧 Cloud 执行链的正式职责边界。
- 不允许把窗口控制或业务执行重新接回：
  - `backend/browser/*`
  - `backend/playwright-runtime/*`
  - `backend/window-adapter/*`
  - `backend/modules/assignment-engine/*`
- 不允许为了“先跑通”而让：
  - Cloud 直接连本地 Chrome CDP
  - Cloud 重新接管 arrival/dispatch/sign/integrated 正式执行
  - 前端重新直接调用旧 Cloud 窗口运行时作为主链

#### 涉及文件

- `scripts/check-no-cloud-engine.js`
- `backend/agent/agentRoutes.ts`
- `backend/api/routes.ts`
- `backend/db/Database.ts`
- `backend/playwright-runtime/*`
- `backend/window-adapter/*`
- `backend/modules/assignment-engine/*`
- `docs/V3_ARCHITECTURE.md`
- `docs/V3_AGENT_DESIGN.md`
- `packages/agent/README.md`

#### 具体动作

- 把 `scripts/check-no-cloud-engine.js` 作为执行前必跑的基线检查脚本。
- 在方案和执行说明里明确：
  - `run-engine` 只保留给未迁移任务类型兼容使用
  - 四业务正式方向只能在 Agent 本地执行
  - `window-connections` 中对 `PlaywrightRuntime` 的 fallback 只允许保留，不允许增强
- 建立一份基线指标：
  - 单窗打开耗时
  - 单窗关闭耗时
  - 一键启动首响应耗时
  - 任务创建到 Agent 开始执行耗时
  - 第一条日志到前端出现耗时

#### 验收

- 所有人对以下边界无歧义：
  - 正式执行层是 `packages/agent`
  - 旧 Cloud 执行链只能冻结兼容，不能继续扩张
  - 后续优化全部发生在命令传递、Agent 内核、前端状态反馈三条线上

### Step 1：先加链路耗时日志，确认到底慢在哪

#### 目标

- 把“前端点击 -> Cloud 写命令 -> WS 推送 -> Agent 收到 -> Agent claim -> 本地执行 -> 状态回传 -> 前端看到”的关键耗时全部打出来。
- 把“任务创建 -> Agent 感知 -> pullTask -> executor 开始 -> 第一条日志出现”的关键耗时全部打出来。
- 先用真实数据判断瓶颈是在：
  - Cloud 入库
  - WS 推送
  - Agent claim
  - Chrome 启动
  - CDP 连接
  - 登录/ReadyGuard
  - SSE 回前端

#### 涉及文件

- `frontend/src/components/layout/Header.tsx`
- `frontend/src/components/shared/WindowStateProvider.tsx`
- `frontend/src/api/client.ts`
- `backend/api/routes.ts`
- `backend/agent/AgentWebSocket.ts`
- `backend/agent/agentRoutes.ts`
- `backend/db/PgDatabase.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/httpClient.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/browser/BrowserManager.ts`
- `packages/agent/src/ws/AgentWsClient.ts`

#### 日志点建议

- 窗口命令链：
  - `Header click at`
  - `Cloud command inserted at`
  - `Cloud ws pushed at`
  - `Agent ws received at`
  - `Agent pull started / finished at`
  - `Command claimed at`
  - `LocalRuntime open start / chrome started / cdp ready / login start / ready done`
  - `Status report sent at`
  - `SSE received at`
- 任务链：
  - `Task created at`
  - `Task WS notified at`
  - `Agent heartbeat sees hasTask at`
  - `pullTask start / done`
  - `executor start`
  - `first log upload`
  - `frontend first log receive`

#### 实施要求

- 所有日志统一带：
  - `traceId` 或 `commandId/taskId`
  - `siteId`
  - `windowId`
  - `staffName`
  - `ts`
- 第一阶段只加日志，不改业务逻辑。

#### 验收

- 能回答至少这 5 个问题：
  - 单窗打开慢在哪一段
  - 单窗关闭慢在哪一段
  - 一键启动比单窗慢在哪一段
  - 任务创建后慢在哪一段
  - 前端“体感慢”和后端“实际慢”是否一致

### Step 2：任务通知 WS 化，TaskLoop 与 heartbeat 解耦

#### 目标

- 不再让任务感知完全绑在 heartbeat 上。
- heartbeat 专注在线状态和摘要上报。
- TaskLoop 独立负责：
  - 任务通知
  - 快速 pull
  - 失败重试
  - 空闲降频

#### 涉及文件

- `backend/agent/AgentWebSocket.ts`
- `backend/agent/agentRoutes.ts`
- `backend/api/routes.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/ws/AgentWsClient.ts`
- `packages/agent/src/httpClient.ts`

#### 具体改法

- Cloud 在创建业务任务后，尝试通过 WS 发 `task_available` 给对应 Agent。
- Agent WS 收到后，立即触发一次 `pullTask()`。
- `tick()` 不再同时承担 heartbeat 和 task pull。
- 拆成：
  - `HeartbeatLoop`
  - `TaskLoop`
- `taskPollIntervalMs` 真正用于 TaskLoop，而不是只打印。
- `nextPollAfterMs` 也真正参与调度。

#### 风险控制

- 先保留 heartbeat 中 `hasTask` 判断作为兜底。
- 新增 WS 任务通知后，旧逻辑不立即删。

#### 验收

- 创建任务后，Agent 在大多数情况下不需要等下一轮 heartbeat 才开始执行。
- `taskPollIntervalMs` 在日志里能看到真实生效。
- 任务链路平均首响应时间明显缩短。

### Step 3：批量窗口命令也走 WS

#### 目标

- 让“一键启动”不再天然慢一拍。
- 批量开窗与单窗开窗共享同一种“即时通知”能力。

#### 涉及文件

- `backend/api/routes.ts`
- `backend/agent/AgentWebSocket.ts`
- `packages/agent/src/ws/AgentWsClient.ts`
- `packages/agent/src/index.ts`
- `frontend/src/api/client.ts`
- `frontend/src/components/layout/Header.tsx`

#### 具体改法

- `POST /api/cloud/windows/commands/batch` 在插入每条命令后：
  - 收集目标 `workstationId`
  - 对在线 Agent 发送 WS `command_available`
- 如果一批命令属于同一台工作站，可以支持：
  - 一条条推
  - 或新增 `commands_available` 批通知
- Agent 端仍不直接执行 WS payload，而是收到后触发 `pullWindowCommandsLoop()`。

#### 同步增强

- 把 `markWindowCommandRunning()` 接进正式执行链。
- 让命令状态至少形成：
  - `pending -> claimed -> running -> done/failed`

#### 验收

- 一键启动的首个窗口开始启动时间接近单窗启动。
- 批量命令不会因为“只写库不推送”而多等一个轮询周期。

### Step 4：前端 Header 做乐观状态

#### 目标

- 点击后立即有 UI 反馈。
- 前端不再把“是否完成命令轮询”作为唯一反馈来源。
- 前端以“本地预期状态 + SSE 实时校正”为主。

#### 涉及文件

- `frontend/src/components/layout/Header.tsx`
- `frontend/src/components/shared/WindowStateProvider.tsx`
- `frontend/src/lib/window-status.ts`
- `frontend/src/api/client.ts`

#### 具体改法

- 点击 `open_window`：
  - 立即设本地 optimistic state = `OPENING`
- 点击 `close_window`：
  - 立即设本地 optimistic state = `CLOSING`
- 点击 `restart_window`：
  - 立即设本地 optimistic state = `RESTARTING`
- 点击 `refresh_status`：
  - 立即设本地 optimistic state = `READY_CHECKING`
- SSE 收到正式状态后覆盖 optimistic state。
- 命令状态轮询保留，但退居失败诊断，不再承担主要 UI 驱动角色。

#### 验收

- Header Tag 点击后 UI 立即变化，不再出现明显“点了没反应”的空窗期。
- SSE 到来后状态能自然校正，不出现长时间卡死。

### Step 5：窗口级 BUSY

#### 目标

- 不再使用全局 `runningTaskId` 表示所有窗口忙碌。
- 让每个窗口只为自己的任务负责。

#### 涉及文件

- `packages/agent/src/index.ts`
- `packages/agent/src/local-runtime/LocalWindowRegistry.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/httpClient.ts`
- `backend/agent/agentRoutes.ts`
- `backend/db/PgDatabase.ts`
- `database/migrations/*`
- `frontend/src/components/shared/WindowStateProvider.tsx`
- `frontend/src/lib/window-status.ts`

#### 具体改法

- `WindowRegistry` 增加 `busyTaskId`。
- 任务执行前锁定目标窗口。
- 执行完成后释放对应窗口。
- `window_status` 建议补字段：
  - `busy_task_id`
  - `last_command_id`
- 关闭窗口时只检查目标窗口是否 busy，不再被别的窗口任务误伤。

#### 验收

- 一个窗口执行任务时，其他窗口仍可关闭、重启、刷新。
- 前端能准确显示哪个窗口在 BUSY。

### Step 6：ReadyGuard + 状态机

#### 目标

- 从“快反馈”进入“准状态”阶段。
- 解决 READY 误判、BUSY 残留、关闭后脏状态、跨站点污染。

#### 涉及文件

- `packages/agent/src/local-runtime/WindowStatusCollector.ts`
- `packages/agent/src/local-runtime/LocalWindowRuntime.ts`
- `packages/agent/src/local-runtime/LocalWindowRegistry.ts`
- `packages/agent/src/browser/*`
- `packages/agent/src/executors/*`
- `frontend/src/lib/window-status.ts`
- `backend/db/PgDatabase.ts`
- `database/migrations/*`

#### 具体改法

- 新增 `ReadyGuard`：
  - 进程
  - CDP
  - URL
  - DOM
  - popup
  - ownership
- 新增 `WindowStateMachine`：
  - `OFFLINE`
  - `OPENING`
  - `CONNECTING`
  - `LOGIN_REQUIRED`
  - `LOGGING_IN`
  - `READY_CHECKING`
  - `READY`
  - `BUSY`
  - `CLOSING`
  - `RESTARTING`
  - `DEGRADED`
  - `FAILED`
- 所有状态流转从散落逻辑收敛到状态机。

#### 验收

- READY 只在严格校验通过后出现。
- 关闭后不残留 READY/BUSY/cdpEndpoint/chromePid 脏状态。
- 不会误把别的站点窗口认成当前窗口。

### Step 7：再逐步拆 `index.ts` 和整理 Agent 内核

#### 目标

- 在前 6 步已经把“速度问题”和“状态正确性问题”压住后，再做结构重构。
- 降低重构风险，避免边改边失控。

#### 涉及文件

- `packages/agent/src/index.ts`
- `packages/agent/src/config.ts`
- `packages/agent/src/httpClient.ts`
- `packages/agent/src/local-runtime/*`
- `packages/agent/src/browser/*`
- `packages/agent/src/executors/*`
- `packages/agent/README.md`

#### 重构目标结构

- `AgentDaemon`
- `HeartbeatLoop`
- `TaskLoop`
- `WindowCommandLoop`
- `LocalWindowSupervisor`
- `WindowRegistry`
- `ReadyGuard`
- `WindowStateMachine`
- `StatusPublisher`

#### 验收

- 外部行为不变。
- 编译通过。
- 关键链路日志仍然完整。
- 便于后续做安装包和本地服务化。

## 18. 推荐实施节奏与里程碑映射

### P0：冻结边界与建立基线

- 包含：
  - Step 0 冻结边界和建立基线
- 目标：
  - 先锁死禁区
  - 先拿到后续所有优化的对比基准

### P1：测量与快速提速

- 包含：
  - Step 1 链路耗时日志
  - Step 2 任务通知 WS 化
  - Step 3 批量窗口命令走 WS
  - Step 4 Header 乐观状态
- 目标：
  - 先把“为什么慢”测清楚
  - 先把“感知慢”压下去

### P2：状态正确性

- 包含：
  - Step 5 窗口级 BUSY
  - Step 6 ReadyGuard + 状态机
- 目标：
  - 把状态做准
  - 把异常恢复做稳

### P3：结构治理

- 包含：
  - Step 7 拆 `index.ts`
- 目标：
  - 为后续长期演进和打包做准备

## 19. 按此思路的最新验收标准

### 阶段零验收：先锁死禁区

- 旧 Cloud 执行链被明确标注为“冻结兼容，不可扩张”。
- 有一套可重复采样的性能基线数据。
- 后续步骤不会误把优化做到旧 Cloud 链路里。

### 阶段一验收：先知道慢在哪

- 能看到窗口操作完整耗时链。
- 能看到任务创建完整耗时链。
- 能明确主瓶颈段，不再靠猜。

### 阶段二验收：先把体感速度做回来

- 任务创建后，Agent 更快开始执行。
- 一键启动明显快于当前版本。
- Header 点击后立即有状态反馈。

### 阶段三验收：再把状态做准

- 窗口 BUSY 精确到单窗。
- READY 不误判。
- 关闭不残留脏状态。

### 阶段四验收：最后再做结构收口

- `index.ts` 不再承担全部职责。
- Agent 内核模块边界清晰。
- 后续打包、安装、守护进程化有明确承接点。

## 附录 A：建议核心数据结构

### A.1 WindowRuntimeState

```ts
type WindowStatus =
  | 'OFFLINE'
  | 'OPENING'
  | 'CONNECTING'
  | 'LOGIN_REQUIRED'
  | 'LOGGING_IN'
  | 'READY_CHECKING'
  | 'READY'
  | 'BUSY'
  | 'CLOSING'
  | 'RESTARTING'
  | 'DEGRADED'
  | 'FAILED'

interface WindowRuntimeState {
  tenantId: string
  siteId: string
  workstationId: string
  windowId: string
  staffName: string
  browserId?: string
  pid?: number
  cdpEndpoint?: string
  debugPort?: number
  profilePath: string
  status: WindowStatus
  busyTaskId?: string
  lastSeenAt?: string
  lastCommandId?: string
  lastError?: string
  lastStateChangedAt?: string
  stateVersion: number
}
```

#### 与当前代码对比

- 已存在：`tenantId/siteId/workstationId/windowId/staffName/pid(cromePid)/cdpEndpoint/profilePath/status/lastError`
- 建议补充：`busyTaskId/lastCommandId/lastStateChangedAt/stateVersion`

### A.2 WindowCommand

```ts
interface WindowCommand {
  commandId: string
  tenantId: string
  siteId: string
  workstationId: string
  windowId: string
  type: 'open_window' | 'close_window' | 'restart_window' | 'refresh_status'
  status: 'pending' | 'received' | 'claimed' | 'running' | 'success' | 'failed'
  createdAt: string
  receivedAt?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  triggerSource?: 'header' | 'browser_page' | 'system'
}
```

#### 与当前表结构对比

- 已存在：`commandId/tenantId/siteId/workstationId/windowId/type/status/createdAt/startedAt/finishedAt/error`
- 建议补充：`receivedAt/triggerSource`
- 建议映射：数据库里的 `done` 对外语义映射为 `success`

### A.3 AgentConnectionState

```ts
interface AgentConnectionState {
  tenantId: string
  workstationId: string
  wsConnected: boolean
  lastHelloAt?: string
  lastPingAt?: string
  lastHeartbeatAt?: string
  reconnecting: boolean
  commandPollMode: 'fast' | 'slow'
  taskPollMode: 'fast' | 'slow'
}
```

### A.4 TaskAssignmentRuntime

```ts
interface TaskAssignmentRuntime {
  taskId: string
  tenantId: string
  siteId: string
  workstationId: string
  windowId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt?: string
  finishedAt?: string
  currentAction?: string
  busyLeaseId: string
  executorType: 'arrival' | 'dispatch' | 'sign' | 'integrated'
}
```

#### 当前字段基础

- `tasks` 表已有任务状态与分配基础。
- 当前缺的是“窗口级执行租约”和“窗口级 busy 映射”。
