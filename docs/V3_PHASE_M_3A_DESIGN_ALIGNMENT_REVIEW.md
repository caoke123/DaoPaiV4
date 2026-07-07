# DaoPai V3 Phase M-3A 初始设计对齐审查报告

> 审查日期：2026-07-04
> 审查性质：只读审查，未修改任何代码
> 当前阶段基线：Phase M-2B 已完成并保存
> 审查人：AI Agent（基于代码实际状态生成）

---

## 1. 审查结论

```
最终判断：当前 DaoPai V3 基本符合最初 V3 设计方向，且已完成四业务 Agent 化回正。
存在部分偏离和未完成项，但都不是架构级偏离，可以排期处理。
```

| 结论 | 说明 |
|------|------|
| **基本符合，但存在偏离** | 核心 Cloud Platform + Local Agent 边界已建立，四个业务已从 Cloud 迁移到 Agent；但存在硬编码 siteId、tenentId 缺省值、BrowserPool 遗留代码等偏离点 |

---

## 2. 审查范围

### 2.1 已阅读的设计文档

| 文档 | 路径 |
|------|------|
| V3_CONTEXT.md | `E:\网站开发\DaoPaiV3\V3_CONTEXT.md` |
| README.md | `E:\网站开发\DaoPaiV3\README.md` |
| V3_ARCHITECTURE.md | `E:\网站开发\DaoPaiV3\docs\V3_ARCHITECTURE.md` |
| V3_DATA_MODEL.md | `E:\网站开发\DaoPaiV3\docs\V3_DATA_MODEL.md` |
| V3_AGENT_DESIGN.md | `E:\网站开发\DaoPaiV3\docs\V3_AGENT_DESIGN.md` |
| V3_CLOUD_PLATFORM.md | `E:\网站开发\DaoPaiV3\docs\V3_CLOUD_PLATFORM.md` |
| V3_ROADMAP.md | `E:\网站开发\DaoPaiV3\docs\V3_ROADMAP.md` |
| V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md | `E:\网站开发\DaoPaiV3\docs\V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md` |
| V3_PHASE4B_AGENT_TOKEN_AUTH.md | `E:\网站开发\DaoPaiV3\docs\V3_PHASE4B_AGENT_TOKEN_AUTH.md` |
| V3_PHASE4_HANDOFF.md | `E:\网站开发\DaoPaiV3\docs\V3_PHASE4_HANDOFF.md` |
| V3_PHASE5A_REAL_TASK_MIGRATION_BOUNDARY.md | `E:\网站开发\DaoPaiV3\docs\V3_PHASE5A_REAL_TASK_MIGRATION_BOUNDARY.md` |

### 2.2 已审查的代码目录

| 目录 | 说明 |
|------|------|
| `backend/api/routes.ts` | Cloud API 路由（任务创建、runtime mode、operations） |
| `backend/agent/agentRoutes.ts` | Agent 侧 API（心跳、拉取、日志、结果） |
| `backend/config/SettingsManager.ts` | 全局配置管理（settings.json） |
| `backend/config/runtimeMode.ts` | 窗口运行时模式 |
| `backend/config/signConfig.ts` | 签收策略配置 |
| `backend/db/PgDatabase.ts` | PostgreSQL 数据访问层 |
| `backend/db/Database.ts` | SQLite 数据访问层 |
| `backend/browser/BrowserPool.ts` | LEGACY 浏览器池 |
| `backend/playwright-runtime/PlaywrightRuntime.ts` | 新标准 Playwright 运行时 |
| `backend/easybr/EasyBRClient.ts` | LEGACY EasyBR 客户端 |
| `backend/operations/*` | 四个业务的 Cloud 操作模块 |
| `backend/modules/assignment-engine/*` | 任务分配引擎 |
| `packages/agent/src/index.ts` | Agent 主入口 |
| `packages/agent/src/executors/*` | 四个业务执行器 |
| `packages/agent/src/browser/BrowserManager.ts` | 浏览器管理器 |
| `packages/agent/src/httpClient.ts` | Agent HTTP 客户端 |
| `packages/agent/src/config.ts` | Agent 配置 |
| `packages/agent/src/types.ts` | Agent 类型定义 |
| `packages/agent/src/logger/AgentLogger.ts` | Agent 日志缓冲器 |
| `frontend/src/api/client.ts` | 前端 API 客户端 |
| `frontend/src/pages/TasksPage.tsx` | 任务中心页面 |
| `frontend/src/pages/SettingsPage.tsx` | 设置页面 |
| `frontend/src/pages/ArrivalPage.tsx` | 到件页面 |
| `frontend/src/pages/DispatchPage.tsx` | 派件页面 |
| `frontend/src/pages/IntegratedPage.tsx` | 到派一体页面 |
| `frontend/src/pages/SignPage.tsx` | 签收页面 |
| `frontend/src/components/shared/ScanWorkbench.tsx` | 扫描工作台 |
| `frontend/src/components/shared/RuntimeModeProvider.tsx` | 运行时模式上下文 |
| `frontend/src/lib/task-log-display/*` | 执行页日志翻译模块 |

### 2.3 已审查的接口

| 接口 | 说明 |
|------|------|
| `POST /api/operations/arrive` | 到件任务创建 |
| `POST /api/operations/dispatch` | 派件任务创建 |
| `POST /api/operations/integrated` | 到派一体任务创建 |
| `POST /api/operations/sign` | 签收任务创建 |
| `GET /api/runtime/mode` | 读取运行时模式 |
| `POST /api/runtime/mode` | 切换运行时模式 |
| `POST /api/cloud/agent-arrival-task` | Cloud Agent 到件任务 |
| `POST /api/cloud/agent-dispatch-task` | Cloud Agent 派件任务 |
| `POST /api/cloud/agent-integrated-task` | Cloud Agent 到派一体任务 |
| `POST /api/cloud/agent-sign-task` | Cloud Agent 签收任务 |
| `POST /agent/heartbeat` | Agent 心跳 |
| `POST /agent/tasks/pull` | Agent 拉取任务 |
| `POST /agent/tasks/:id/complete` | Agent 上报完成 |
| `POST /agent/tasks/:id/fail` | Agent 上报失败 |
| `POST /agent/tasks/:id/logs` | Agent 上报日志 |
| `POST /agent/tasks/:id/progress` | Agent 上报进度 |
| `GET /agent/window-connections` | Agent 查询 READY 窗口 |
| `POST /agent/tasks/:id/run-engine` | 兼容路径（已硬防护） |

---

## 3. V3 最初设计摘要

### 3.1 核心架构

```text
Cloud Platform + Local Agent
```

### 3.2 Cloud Platform 职责

- 租户管理、网点管理、工作站管理、用户/权限
- 任务创建、任务中心、日志中心、结果持久化
- PostgreSQL 数据管理、多租户隔离
- **不直接控制本地浏览器**

### 3.3 Local Agent 职责

- 本机浏览器自动化执行
- EasyBR / Playwright 窗口连接
- 员工窗口 READY 检测
- 本地登录状态检查
- 任务拉取、真实业务执行
- 执行日志回传、执行结果回传

### 3.4 关键隔离边界

`tenantId` / `siteId` / `workstationId` / `windowId` / `staffName`

### 3.5 最初设计原则

- Cloud 不应直接控制本地浏览器
- 浏览器动作必须发生在 Local Agent
- V2 是稳定基线，不应被 V3 修改
- 真实业务执行权应逐步从 Cloud 后端迁回 Agent 本地执行

---

## 4. 当前项目实际状态摘要

### 4.1 Cloud Platform 实际状态

- Express + TypeScript 后端运行在 3300 端口
- PostgreSQL 作为主数据存储（5436 端口）
- SQLite 作为 legacy mirror（仅 best-effort 写入）
- settings.json 管理网点和运行时配置
- 四个核心业务任务创建已全部走 `/api/operations/*` 路由
- Cloud 引擎（BrowserPool + AssignmentEngine）**已被 TaskEngineRunner 硬防护阻止执行四业务**
- `scheduleLocalEngineRun` 已从所有四业务路由中删除

### 4.2 Local Agent 实际状态

- Agent 作为独立包存在于 `packages/agent/`
- 通过心跳 + 拉取模式获取任务
- 通过 CDP (`chromium.connectOverCDP`) 接管 Backend PlaywrightRuntime 已打开的 Chrome 窗口
- 不启动新 Chrome，不执行登录
- 四个业务执行器（ArrivalExecutor / DispatchExecutor / IntegratedExecutor / SignExecutor）实现完整的浏览器 DRY-RUN
- AgentLogger 缓冲 + 定时 flush 回传日志到 Cloud

### 4.3 Frontend 实际状态

- Vite + React SPA 运行在 5176 端口
- 两条执行路径：
  - **路径 A：ScanWorkbench** — 四个业务页面（ArrivalPage / DispatchPage / IntegratedPage / SignPage）
  - **路径 B：TasksPage Cloud Agent 任务** — 任务中心内的"快速测试"模态框
- RuntimeModeProvider 统一管理全局 `dryRunMode`
- SettingsPage 提供试运行/真实生产模式切换开关
- 执行页日志已业务化翻译（Phase L-1A-Fix）

### 4.4 当前执行路径

```
前端页面
  ↓ POST /api/operations/arrive (或其他业务类型)
Cloud API (routes.ts)
  ↓ 创建 PG 任务 (status: pending)
  ↓ 写 SQLite legacy mirror (best-effort)
  ↓ 不调用任何引擎执行
  ↓ 返回 { taskId, status: 'pending' }
  ─────────────────────
  (Agent 轮询)
Agent POST /agent/tasks/pull
  ↓ PG claimPendingTask (原子操作)
  ↓
Agent Executor
  ↓ queryWindowConnections (GET /agent/window-connections)
  ↓ 匹配 READY 窗口 (windowId 优先 → staffName 兜底)
  ↓ BrowserManager.connectExisting(cdpEndpoint)
  ↓ detectBnsyDashboardP0 (验证 Dashboard 就绪)
  ↓ runXxxBrowserDryRun() (执行业务操作, 停止在最终提交前)
  ↓ AgentLogger.flush (回传日志)
  ↓ completeTask / failTask (回传结果)
Cloud 更新任务中心
  ↓ PG task_logs / waybill_results 写入
  ↓ SSE EventBus 推送到前端
```

---

## 5. 已完成工作清单

### A. Cloud Platform 侧

| 项目 | 状态 | 说明 |
|------|------|------|
| 任务创建 | ✅ 完成 | 四个业务通过 `/api/operations/*` 创建任务，写入 PostgreSQL + SQLite legacy mirror |
| 任务中心 | ✅ 完成 | TasksPage 提供任务列表、详情、日志查看 |
| 日志存储 | ✅ 完成 | Agent 上报日志写入 PG task_logs，SSE 实时推送前端 |
| 结果回传/持久化 | ✅ 完成 | Agent complete/fail 写入 waybill_results，任务状态机正常工作 |
| runtime mode 全局开关 | ✅ 完成 | Phase M-2B：settings.json dryRunMode 统一控制所有业务 |
| PostgreSQL 使用 | ✅ 完成 | 主写路径（tasks/task_logs/waybill_results），含 tenant_id 隔离 |
| SQLite 使用 | ✅ legacy mirror | 仅 best-effort 写入，PG 写入失败直接 500 |
| settings.json | ✅ 完成 | SettingsManager 单例管理，支持原子写入 (.tmp → rename) |
| Cloud 直接执行浏览器 | ✅ 已硬防护 | TaskEngineRunner.assertNotAgentOnlyBusiness 阻止四业务 Cloud 执行 |
| `/api/operations` 路由 | ✅ 完成 | 四个业务均不再调用 scheduleLocalEngineRun |

### B. Local Agent 侧

| 项目 | 状态 | 说明 |
|------|------|------|
| 拉取任务 | ✅ 完成 | `POST /agent/tasks/pull`，心跳 + 轮询双信号机制 |
| 识别 READY 窗口 | ✅ 完成 | `GET /agent/window-connections` 查询 PlaywrightRuntime 窗口状态 |
| 连接现有员工窗口 | ✅ 完成 | CDP 接管 (`chromium.connectOverCDP`)，不启动新 Chrome |
| 四业务执行 | ✅ 完成 | ArrivalExecutor / DispatchExecutor / IntegratedExecutor / SignExecutor |
| 多员工/多窗口执行 | ✅ 完成 | 并发度 5，usedWindowIds Set 防重复 |
| 回传日志 | ✅ 完成 | AgentLogger 缓冲 + 定时 flush → `POST /agent/tasks/:id/logs` |
| 回传任务结果 | ✅ 完成 | completeTask / failTask → waybill_results 写入 PG |
| 避免新开 Chrome | ✅ 完成 | noNewChrome=true Guard 在所有 Executor 中生效 |
| 避免重新登录 | ✅ 完成 | noRelogin=true Guard，Dashboard 非 READY 直接拒绝 |
| 避免 Cloud fallback | ✅ 完成 | TaskEngineRunner 硬防护 409 TASK_TYPE_MIGRATED_TO_AGENT |

### C. 四个核心业务

| 业务 | Agent 本地执行 | Cloud 直执残留 | 试运行/真实 | 关键修复 |
|------|--------------|---------------|------------|---------|
| Arrival 到件 | ✅ | ❌ 无 | ✅ | 上一站选择已修复 |
| Dispatch 派件 | ✅ | ❌ 无 | ✅ | 卡死问题已修复 |
| Integrated 到派一体 | ✅ | ❌ 无 | ✅ | READY-window 路径已迁移 |
| Sign 签收 | ✅ | ❌ 无 | ✅ | 签收策略固定 |

### D. 其他

| 项目 | 状态 | 说明 |
|------|------|------|
| 执行页日志业务化 | ✅ 完成 | Phase L-1A-Fix：translateTaskLogs 翻译链，业务语义化 |
| Task Center 日志保留 | ✅ 保持技术日志 | 按产品决策，不做 Phase L 优化 |
| 全局 dryRunMode 统一 | ✅ 完成 | Phase M-2B：所有路径统一读取 settings.json |
| SettingsPage 模式切换 | ✅ 完成 | 前端 toggle 开关 → POST /api/runtime/mode |

---

## 6. 未完成工作清单

### A. Cloud Platform 侧

| 项目 | 当前状态 | 说明 |
|------|---------|------|
| tenantId 真正多租户隔离 | ⚠️ 部分完成 | 使用 `DEFAULT_TENANT_ID` 兜底，未接入 JWT tenantId 解析 |
| siteId 动态绑定 | ⚠️ 部分完成 | TasksPage 中存在硬编码 `siteId: 'site-1782121346155'` |
| workstationId 设备级隔离 | ⚠️ 部分完成 | 使用 `DEFAULT_WORKSTATION_ID` 兜底 |
| workstation 注册/绑定/心跳/授权管理 UI | ❌ 未完成 | 后台管理页面缺失 |
| 租户到期/停用自动化 | ❌ 未完成 | 仅 tenants 表只读查询 |
| Agent Token 撤销与重新生成 | ❌ 未完成 | Token 机制存在但管理界面缺失 |
| Redis 引入 | ❌ 未完成 | 架构设计中有 Redis，实际未部署使用 |
| BrowserPool 清理 | ❌ 未完成 | LEGACY 代码仍保留，依赖 EasyBR |

### B. Local Agent 侧

| 项目 | 当前状态 | 说明 |
|------|---------|------|
| Agent 独立打包/分发 | ❌ 未完成 | 当前依赖项目 monorepo 运行 |
| Agent 固定浏览器包 | ❌ 未完成 | 当前依赖 Backend PlaywrightRuntime 管理 Chrome |
| 新电脑初始化文档 | ❌ 未完成 | Phase 9 规划的初始化文档 |
| 窗口状态 CDP 自治 | ⚠️ 部分完成 | Agent 通过 CDP 接管 Backend 的 PlaywrightRuntime 窗口，而非完全独立管理 |
| 截图策略实现 | ❌ 未完成 | 架构设计完整但未执行 |

### C. 部署与运维

| 项目 | 当前状态 | 说明 |
|------|---------|------|
| Docker Compose 生产部署 | ❌ 未完成 | 有 docker-compose.yml 但未验证生产环境 |
| HTTPS / Nginx 反向代理 | ❌ 未完成 | Phase 9 规划内容 |
| PostgreSQL 定时备份 | ❌ 未完成 | Phase 9 规划内容 |
| settings.json 实际文件 | ❌ 不存在 | 仅有 settings.example.json，运行时由 SettingsManager 初始化创建 |

---

## 7. 与最初设计一致的部分

### 7.1 核心架构一致

| 设计原则 | 实际状态 | 一致性 |
|---------|---------|--------|
| Cloud Platform + Local Agent | ✅ 已建立 | ✅ 一致 |
| Cloud 不直接控制浏览器 | ✅ TaskEngineRunner 硬防护 | ✅ 一致 |
| 浏览器动作在 Local Agent | ✅ 四个业务全部 Agent 本地执行 | ✅ 一致 |
| V2 不被 V3 修改 | ✅ V2 独立运行 | ✅ 一致 |
| PostgreSQL 主数据存储 | ✅ | ✅ 一致 |
| 多租户隔离 | ✅ tenant_id 查询过滤 | ✅ 基本一致 |
| HTTP 轮询 + 数据库状态机 | ✅ | ✅ 一致 |
| 默认关闭截图 | ✅ | ✅ 一致 |

### 7.2 执行边界一致

| 边界 | 设计预期 | 实际状态 |
|------|---------|---------|
| Arrival Cloud 直执 | 不存在 | ✅ 不存在 |
| Dispatch Cloud 直执 | 不存在 | ✅ 不存在 |
| Integrated Cloud 直执 | 不存在 | ✅ 不存在 |
| Sign Cloud 直执 | 不存在 | ✅ 不存在 |
| Agent 本地执行 | 四个业务 | ✅ 四个业务全部迁移 |

### 7.3 数据隔离一致

| 隔离维度 | 设计预期 | 实际状态 |
|---------|---------|---------|
| tasks.tenant_id | 必须 | ✅ PgDatabase 中所有查询带 tenant_id |
| waybill_results.tenant_id | 必须 | ✅ 子查询中使用 |
| cross-tenant forbidden | 必须 403 | ✅ tenant_id 注入所有查询条件 |

### 7.4 全局模式一致

| 模式 | 设计预期 | 实际状态 |
|------|---------|---------|
| 试运行模式 | 统一全局开关 | ✅ settings.json runtime.dryRunMode |
| 真实生产模式 | 统一全局开关 | ✅ 环境变量 ENABLE_REAL_SUBMIT 安全门 |
| 四业务统一受控 | 同一个开关 | ✅ Phase M-2B：所有路径统一读取 |
| 前端不做 browserDryRun:true 硬编码 | 不应硬编码 | ✅ ScanWorkbench/TasksPage 均从 RuntimeModeProvider 读取 |

---

## 8. 与最初设计存在偏离的部分

### 偏离 1：CDP 窗口模型 — Agent 不完全自治

**偏离描述**：
最初设计是 Agent 完全独立管理本地浏览器（启动、登录、管理会话）。当前实际是 Backend PlaywrightRuntime 通过 `chromium.launchPersistentContext()` 启动 Chrome 并维护窗口，Agent 通过 CDP (`chromium.connectOverCDP`) 接管已打开的 READY 窗口。Agent 没有独立启动和管理 Chrome 的能力。

**涉及文件**：
- `backend/playwright-runtime/PlaywrightRuntime.ts` — Chrome 由 Backend 启动和管理
- `packages/agent/src/browser/BrowserManager.ts` — Agent CDP 接管
- `packages/agent/src/executors/ArrivalExecutor.ts:571` — `BrowserManager.connectExisting(matched.cdpEndpoint)`

**当前风险**：
- Agent 依赖 Backend 已启动的 Chrome，Agent 不是完全自给自足的本地执行端
- 如果 Backend 未运行或 PlaywrightRuntime 故障，Agent 无法独立执行任务
- 这与 V3_AGENT_DESIGN.md §4 "Agent 启动检查"中描述的 Agent 独立管理浏览器环境的设计不完全一致

**是否必须修复**：P1 — 进入真实生产前应评估是否需要 Agent 完全自治
**建议修复优先级**：P2

---

### 偏离 2：TasksPage 硬编码 siteId

**偏离描述**：
TasksPage 的四个 DRY-RUN 任务创建函数中，`siteId` 硬编码为 `'site-1782121346155'`，`siteName` 硬编码为 `'天南大'`。这违反了多租户/多网点动态隔离设计。

**涉及文件**：
- `frontend/src/pages/TasksPage.tsx` 第 1209、1239、1270、1301 行

```typescript
const resp = await createArrivalDryRunTask({
  siteId: 'site-1782121346155',
  siteName: '天南大',
  waybills,
  options: { prevStation: '天津分拨中心', batchSize: 200 },
  browserDryRun: dryRunMode,
});
```

**当前风险**：
- 多网点场景下，TasksPage DRY-RUN 任务总是创建到同一个固定网点
- 如果 site-1782121346155 不存在或属于其他租户，任务创建失败
- 与 V3_DATA_MODEL.md 的"任务归属某个网点"设计不一致

**是否必须修复**：P1 — 多网点场景下必须动态绑定 siteId
**建议修复优先级**：P1

---

### 偏离 3：tenantId / workstationId 使用缺省值

**偏离描述**：
PgDatabase 中所有查询使用 `DEFAULT_TENANT_ID` 和 `DEFAULT_WORKSTATION_ID` 兜底。虽然查询条件中带了 tenant_id，但来源不是 JWT 或 Agent Token 中的租户身份，而是缺省值。

**涉及文件**：
- `backend/db/PgDatabase.ts` 第 72-73 行：`tenantId?: string` / `workstationId?: string` 均有默认值
- `backend/db/PgDatabase.ts` 第 203 行：`const tenantId = task.tenantId || DEFAULT_TENANT_ID`
- `backend/db/PgDatabase.ts` 第 252 行：`tenantId: string = DEFAULT_TENANT_ID`

**当前风险**：
- 当前为单租户开发环境，缺省值工作正常
- 一旦多租户上线，缺省值可能导致跨租户数据泄露
- V3_DATA_MODEL.md §3 明确要求"不允许出现不带 tenant_id 限制的全表查询"
- 虽然当前查询都带了 tenant_id，但其值来自缺省而非实际租户上下文

**是否必须修复**：P1 — 多租户上线前必须修复
**建议修复优先级**：P1

---

### 偏离 4：三个字段命名并存 (dryRunMode / dryRun / browserDryRun)

**偏离描述**：
同一概念（试运行标志）在系统中以三个不同字段名存在：
- `settings.json` → `runtime.dryRunMode`
- 前端 API 参数 → `dryRunMode` / `browserDryRun`
- routes.ts inputData → `browserDryRun` + `dryRun`（同时写入）
- Agent Executor 解析 → `payload.browserDryRun ?? payload.dryRunMode ?? payload.dryRun ?? true`

虽然 `SettingsManager.resolveTaskDryRun()` 定义了统一解析逻辑，但各 Agent Executor 未使用该函数，而是各自内联实现解析链。

**涉及文件**：
- `backend/config/SettingsManager.ts` 第 307-326 行 — `resolveTaskDryRun()` 统一解析
- `backend/api/routes.ts` 第 1022、1145、1271、1395 行 — 同时写 `browserDryRun` + `dryRun`
- `packages/agent/src/executors/ArrivalExecutor.ts` 第 350 行 — 独立内联解析
- `packages/agent/src/executors/DispatchExecutor.ts` 第 665 行 — 独立内联解析
- `packages/agent/src/executors/IntegratedExecutor.ts` 第 647 行 — 独立内联解析
- `packages/agent/src/executors/SignExecutor.ts` 第 686 行 — 独立内联解析

**当前风险**：
- 字段不一致增加维护成本和新开发者的理解难度
- Agent Executor 内联解析逻辑可能遗漏某些字段优先级
- 如果 Cloud 端只写 `dryRun` 而 Agent 只检查 `browserDryRun`，可能导致行为不一致

**是否必须修复**：P2 — 建议统一字段名和使用统一的解析函数
**建议修复优先级**：P2

---

### 偏离 5：BrowserPool / AssignmentEngine 遗留代码

**偏离描述**：
BrowserPool（2486 行）、EasyBRClient（540 行）、AssignmentEngine 等 LEGACY 模块仍然存在于 Backend 代码中。虽然 TaskEngineRunner 和 run-engine 路由已对四业务硬防护，但这些遗留代码：
- 仍被 Backend `index.ts` 启动时初始化
- 仍能通过某些兼容路径被调用（`/agent/tasks/:id/run-engine`）
- 增加了代码库复杂度和新开发者的认知负担

**涉及文件**：
- `backend/browser/BrowserPool.ts`
- `backend/easybr/EasyBRClient.ts`
- `backend/playwright-runtime/PlaywrightRuntime.ts`（部分功能与 Agent 重复）
- `backend/modules/assignment-engine/AssignmentEngine.ts`
- `backend/services/TaskEngineRunner.ts`（已作为硬防护存在）

**当前风险**：
- 低风险 — 因为硬防护已生效
- 但如果某条新代码路径绕过硬防护，LEGACY 路径可能被意外触发

**是否必须修复**：P2 — 建议真实生产前清理，但不阻塞
**建议修复优先级**：P2

---

### 偏离 6：settings.json 不存在于磁盘（非偏离，但需记录）

**偏离描述**：
`data/settings.json` 当前不存在于磁盘上，只有 `data/settings.example.json` 模板文件。运行时由 SettingsManager 在首次初始化后动态创建。这不是设计偏离，但说明项目尚未完成生产环境部署准备。

**涉及文件**：
- `data/settings.example.json` — 存在
- `data/settings.json` — 不存在
- `backend/config/SettingsManager.ts` 第 95 行 — `SETTINGS_FILE = ...data/settings.json`

**当前风险**：
- 开发/测试环境可能依赖 sample 配置
- 新环境初始化流程需要文档化

**是否必须修复**：P2 — 部署前需提供初始化脚本/文档
**建议修复优先级**：P2

---

## 9. Cloud / Agent 执行边界审查

### 9.1 四个业务执行权归属

| 业务 | 执行位置 | 执行证据 | 判定 |
|------|---------|---------|------|
| **Arrival 到件** | Agent 本地 | `ArrivalExecutor.ts` CDP 接管 READY 窗口，执行 `runArrivalBrowserDryRun()` | ✅ 真正 Agent 本地执行 |
| **Dispatch 派件** | Agent 本地 | `DispatchExecutor.ts` CDP 接管 READY 窗口，执行 `runDispatchBrowserDryRun()` | ✅ 真正 Agent 本地执行 |
| **Integrated 到派一体** | Agent 本地 | `IntegratedExecutor.ts` CDP 接管 READY 窗口，执行 `runIntegratedBrowserDryRun()` | ✅ 真正 Agent 本地执行 |
| **Sign 签收** | Agent 本地 | `SignExecutor.ts` CDP 接管 READY 窗口，执行 `runSignBrowserDryRun()` | ✅ 真正 Agent 本地执行 |

### 9.2 Cloud 是否还有直接执行浏览器动作的残留路径

| 路径 | 状态 | 说明 |
|------|------|------|
| BrowserPool 直执 | ❌ 已阻断 | TaskEngineRunner 硬防护 409 |
| scheduleLocalEngineRun | ❌ 已删除 | 所有四业务路由中已删除 |
| `/agent/tasks/:id/run-engine` | ❌ 已硬防护 | 返回 409 TASK_TYPE_MIGRATED_TO_AGENT |
| PlaywrightRuntime 启动 Chrome | ⚠️ 存在 | Backend 仍管理 Chrome 生命周期（Agent 通过 CDP 接管） |
| Operations 模块 | ⚠️ 存在但未调用 | backend/operations/* 代码存在，但不由 Cloud 引擎调用 |
| AssignmentEngine | ⚠️ 存在但已绕过 | 四业务不再走 AssignmentEngine |

### 9.3 CDP 模型的双重角色说明

当前 CDP 模型实际上形成了一种 **"Backend 管理浏览器生命周期 + Agent 执行浏览器操作"** 的混合模式：

```text
Backend PlaywrightRuntime:
  - chromium.launchPersistentContext() 启动 Chrome
  - 管理 userDataDir (runtime/profiles/{tenantId}/{siteId}/{windowId}/)
  - 验证登录状态
  - 暴露 CDP endpoint

Agent Executor:
  - BrowserManager.connectExisting(cdpEndpoint) 接管
  - 执行业务操作 (DRY-RUN)
  - 不上传/不关闭窗口
```

这与最初设计（Agent 独立管理本地浏览器）有差异，但在当前阶段是合理的中间态。进入真实生产前可评估是否需要让 Agent 完全独立启动和管理 Chrome。

---

## 10. 全局运行模式审查

### 10.1 Phase M-2B 后全局模式状态

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 试运行模式统一 | ✅ 统一 | settings.json runtime.dryRunMode 为唯一来源 |
| 真实生产模式统一 | ✅ 统一 | ENABLE_REAL_SUBMIT 环境变量安全门 |
| browserDryRun:true 硬编码 | ✅ 无 | 前端不再硬编码，均从 RuntimeModeProvider 读取 |
| 前端模式不一致 | ✅ 一致 | ScanWorkbench 和 TasksPage 均使用同一 RuntimeModeProvider |
| SettingsPage 切换 | ✅ 完成 | toggle → POST /api/runtime/mode → 写入 settings.json |
| Cloud Agent 任务 | ✅ 统一 | Phase M-2B：`resolveTaskDryRun()` 从 SettingsManager 读取 |
| TasksPage 传递 | ✅ 正确 | `browserDryRun: dryRunMode`（从 useRuntimeMode() 获取） |

### 10.2 全局模式风险点

| 风险 | 当前状态 | 等级 |
|------|---------|------|
| 试运行误触发真实提交 | ✅ 安全：dryRunMode=true 时跳过提交 + 安全门 ENABLE_REAL_SUBMIT 检查 | 无风险 |
| 真实生产被局部代码改为试运行 | ✅ 安全：settings.json 为唯一来源，前端只读 | 无风险 |
| 安全门绕过 | ⚠️ 理论上存在：如果有人在 Agent Executor 中移除安全门检查 | P2 |

---

## 11. 多租户 / 多网点 / 多工作站隔离审查

### 11.1 各 ID 当前使用情况

| ID | 数据模型中 | 代码中实际使用 | 判定 |
|----|-----------|--------------|------|
| **tenantId** | tasks 表有 tenant_id 列 | ✅ PgDatabase 所有查询带 tenant_id；使用 DEFAULT_TENANT_ID 兜底 | ⚠️ 部分实现 |
| **siteId** | tasks 表有 site_id 列 | ✅ 任务创建时写入；TasksPage 硬编码；Agent 窗口匹配使用 | ⚠️ 部分实现 |
| **workstationId** | tasks 表有 workstation_id 列 | ✅ 任务创建写入；Agent pull 按 workstationId 过滤；使用 DEFAULT_WORKSTATION_ID 兜底 | ⚠️ 部分实现 |
| **windowId** | Agent 使用 | ✅ Agent 窗口匹配（windowId 优先 → staffName 兜底） | ✅ 已实现 |
| **staffName** | Agent 使用 | ✅ Agent 匹配 + 归属校验；日志中标记 | ✅ 已实现 |

### 11.2 隔离风险

| 风险 | 当前状态 | 等级 |
|------|---------|------|
| 跨租户数据泄露 | ✅ PgDatabase 所有查询带 tenant_id | 低风险（但依赖 DEFAULT_TENANT_ID 兜底） |
| 窗口跨站点污染 | ✅ Agent 匹配时校验 siteId 一致性 | 低风险 |
| 多网点员工混入 | ✅ Backend validateAssignmentsBelongToSite() | 低风险 |
| TasksPage siteId 硬编码 | ⚠️ 多网点时可能创建任务到错误网点 | P1 |
| workstationId 缺省值 | ⚠️ 多设备时可能混淆 | P1 |

---

## 12. 风险等级汇总

| 风险项 | 当前状态 | 影响范围 | 风险等级 | 是否建议立即处理 |
|--------|---------|---------|---------|----------------|
| TasksPage siteId 硬编码 | 存在 | 多网点场景下功能异常 | **P1** | 进入真实生产前处理 |
| tenantId/workstationId 使用 DEFAULT 兜底 | 存在 | 多租户/多设备隔离不完整 | **P1** | 进入真实生产前处理 |
| CDP 窗口模型（Agent 不完全自治） | 存在 | Agent 依赖 Backend 运行 Chrome | **P2** | 可排期处理 |
| dryRunMode/dryRun/browserDryRun 三字段并存 | 存在 | 维护复杂度 | **P2** | 可排期处理 |
| Agent Executor 内联 dryRun 解析未使用 resolveTaskDryRun() | 存在 | 潜在行为不一致 | **P2** | 可排期处理 |
| BrowserPool/AssignmentEngine LEGACY 代码 | 存在 | 代码库复杂度 | **P2** | 可排期清理 |
| settings.json 不存在于磁盘 | 存在 | 新环境初始化 | **P2** | 部署前处理 |
| PostgreSQL 备份未实施 | 未实施 | 数据安全 | **P2** | 部署前处理 |
| Agent 独立打包/分发 | 未实施 | 生产分发 | **P2** | 部署前处理 |
| ENABLE_REAL_SUBMIT 安全门可被代码绕过 | 理论风险 | 真实提交安全 | **P3** | 可暂缓 |

---

## 13. 下一阶段建议

### 1. 必须先做（P1）

1. **修复 TasksPage siteId 硬编码** — 改为从当前活跃网点上下文动态获取 siteId
2. **完善 tenantId / workstationId 实际来源** — 从 JWT/Agent Token 中提取租户和工作站身份，移除 DEFAULT_TENANT_ID / DEFAULT_WORKSTATION_ID 兜底逻辑
3. **统一 dryRunMode 字段命名和解析** — 让 Agent Executor 统一使用 SettingsManager.resolveTaskDryRun()，消除三层字段不一致

### 2. 可以随后做（P2）

1. **清理 LEGACY 代码** — BrowserPool、EasyBRClient、AssignmentEngine 等，确认无依赖后移除
2. **Agent 独立 Chrome 管理** — 评估是否需要 Agent 完全自主启动和管理 Chrome（脱离 Backend PlaywrightRuntime 依赖）
3. **settings.json 初始化脚本** — 提供一行命令或首次启动引导
4. **PostgreSQL 备份脚本** — Phase 9 规划内容，部署前完成
5. **Agent 打包方案** — 评估 pkg / nexe / Node.js 便携分发方案

### 3. 暂时不要做（P3）

1. **WebSocket 实时通知** — 当前 HTTP 轮询足够，Phase 7 备注为后续增强
2. **支付系统** — V3_CLOUD_PLATFORM.md §3 明确不做的范围
3. **复杂 RBAC** — V3_ROADMAP.md §6 明确不做的事
4. **全量截图策略** — 当前默认关闭截图符合设计
5. **Task Center 日志业务化** — 当前产品决策保留技术日志

---

## 14. 最终判断

```text
最终判断：当前 DaoPai V3 基本符合最初 Cloud Platform + Local Agent 设计方向，
四个核心业务已完成 Agent 本地执行迁移，Cloud 直接执行路径已硬防护阻断，
全局试运行/真实生产模式已完成统一。剩余偏离点（siteId 硬编码、tenantId 缺省值、
CDP 窗口模型）均为非架构级偏离，可在后续 Phase 中排期修复。
```

---

## 附录：本次审查遵守规则

| 规则 | 状态 |
|------|------|
| 是否修改代码 | 否 |
| 是否重构文件 | 否 |
| 是否新增业务逻辑 | 否 |
| 是否修复问题 | 否 |
| 是否提交 Git | 否 |
| 是否推送 Git | 否 |
| 结论是否基于代码实际状态 | 是 |
| 是否把未来规划写为已完成 | 否 |
