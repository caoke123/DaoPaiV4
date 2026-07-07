# DaoPai V3 Phase K-3A-2：Arrival Agent connectOverCDP 接管 READY 窗口 — 实施报告

> **日期:** 2026-07-03  
> **实施者:** opencode AI (model: deepseek-v4-pro)  
> **阶段:** Phase K-3A-2  
> **范围:** 仅 Arrival Executor，不涉及 Dispatch / Sign / Integrated

---

## 一、接手审查：项目结构总览

### 1.1 项目目录结构

```
E:\网站开发\DaoPaiV3\
├── backend/           # Cloud 后端 (Express + Playwright + PostgreSQL)
│   ├── agent/         # Agent API 路由 (RT: agentRoutes.ts)
│   ├── api/           # 业务 API 路由 (routes.ts)
│   ├── auth/          # 鉴权中间件
│   ├── browser/       # 浏览器控制层 (BrowserPool, PlaywrightRuntime)
│   ├── db/            # 数据库层 (PgDatabase)
│   └── services/      # 业务服务 (TaskEngineRunner, TaskLogService)
├── packages/agent/    # Agent 本地执行端
│   └── src/
│       ├── index.ts               # Agent 主循环入口
│       ├── config.ts              # 配置加载
│       ├── httpClient.ts          # HTTP 客户端 (Axios)
│       ├── types.ts               # 类型定义
│       ├── logger/AgentLogger.ts  # 日志缓冲器
│       ├── browser/
│       │   ├── BrowserManager.ts          # Chrome 管理 (启动/CDP/关闭)
│       │   ├── AgentBusinessRuntime.ts    # 基础运行时 (导航/弹窗/首页)
│       │   ├── ArrivalBrowserDryRun.ts    # 到件扫描 DRY-RUN
│       │   ├── BnsySessionManager.ts      # 登录状态管理
│       │   ├── BnsyDashboardDetector.ts   # Dashboard P0 检测
│       │   └── ...                        # 其他业务模块
│       └── executors/
│           ├── ArrivalExecutor.ts   # ⭐ 本次修改
│           ├── DispatchExecutor.ts
│           ├── SignExecutor.ts
│           └── IntegratedExecutor.ts
├── frontend/          # Vite + Vue 前端
├── scripts/           # 辅助脚本
│   └── check-no-cloud-engine.js   # Cloud Engine 隔离检查
├── docs/              # 文档
├── .env               # 环境变量
└── package.json       # 根工程
```

### 1.2 关键技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 | Express + TypeScript | Cloud API 服务 :3300 |
| 数据库 | PostgreSQL (pg) | 本地 :5436, daopai_v3 |
| 浏览器 | Playwright (playwright-core) | 两个实例: Cloud PlaywrightRuntime + Agent BrowserManager |
| Agent HTTP | Axios | Bearer Token 鉴权 |
| 前端 | Vite + Vue 3 + Element Plus | :5176 |
| 构建 | tsc (TypeScript) | 全项目 tsconfig |

### 1.3 Phase K 当前阶段总览

```
Phase K-R1:  ✅ 完成 — Cloud Engine 归档隔离
  - 四业务 route 只创建 pending task
  - Cloud 后端不再执行浏览器业务动作
  - run-engine 对四业务返回 409
  - check:no-cloud-engine 通过

Phase K-3A-1: ✅ 完成 — Backend CDP endpoint 暴露
  - ENABLE_WINDOW_CDP_ENDPOINT=true
  - PlaywrightRuntime 启动窗口带 --remote-debugging-port
  - runtime state 记录 cdpPort/cdpEndpoint/cdpAttachable
  - GET /agent/window-connections 可查询 READY 窗口

Phase K-3A-2: ⬅ 本次实施 — Arrival Agent connectOverCDP 接管
Phase K-3B:   ⬜ 待实施 — Dispatch Agent 迁移
Phase K-3C:   ⬜ 待实施 — Sign Agent 迁移
Phase K-3D:   ⬜ 待实施 — Integrated Agent 迁移
```

---

## 二、审查发现：Arrival 执行链（修复前）

### 2.1 Before: 旧执行链

```
POST /api/operations/arrive (Cloud)
  → insertTask status=pending
  → 不执行浏览器动作 (K-R1 已归档)

Agent heartbeat → hasTask=true
  → POST /agent/tasks/pull
  → packages/agent/src/index.ts

ArrivalExecutor.executeArrivalDryRun()
  → executeBrowserDryRunAssignment()
      → new BrowserManager(browserConfig)   ← ⚠️ 新开 Chrome
      → manager.start()                     ← ⚠️ spawn 便携版 Chrome
      → manager.connect()                   ← ⚠️ connectOverCDP 连自己
      → manager.openPage(loginUrl)          ← ⚠️ 打开登录页
      → ensureBnsyLoggedIn(page, credential) ← ⚠️ 重新登录
      → runArrivalBrowserDryRun(page, ...)
      → manager.close()                     ← ⚠️ 关闭 Chrome
```

### 2.2 核心问题

**Arrival Agent 没有复用 Backend 已启动并登录好的 READY 员工窗口。**

每次执行 Arrival 任务时:
1. Agent 新开一个 Chrome (spawn)
2. 打开登录页重新登录
3. 执行完毕后关闭 Chrome

这违背了 Phase K 的核心设计目标: **Agent 应在 Backend 已有的员工 READY 窗口上执行业务动作。**

---

## 三、K-3A-2 修复内容

### 3.1 After: 新执行链

```
POST /api/operations/arrive (Cloud)
  → insertTask status=pending
  → 不执行浏览器动作

Agent heartbeat → hasTask=true
  → POST /agent/tasks/pull
  → packages/agent/src/index.ts (未修改)

ArrivalExecutor.executeArrivalDryRun()
  → executeBrowserDryRunAssignment()
      → queryWindowConnections({staffName, siteId, status: 'ready'})
      → 匹配 READY 窗口
      → 验证 siteId / staffName / cdpAttachable / cdpEndpoint
      → BrowserManager.connectExisting(cdpEndpoint)  ← ✅ CDP 接管
      → detectBnsyDashboardP0(page)                   ← ✅ 只验证，不重登
      → runArrivalBrowserDryRun(page, ...)
      → restoreCleanHome(page)                        ← ✅ 不关浏览器
      → complete / fail
```

### 3.2 修改的文件

| 文件 | 行数变化 | 变更内容 |
|------|----------|----------|
| `packages/agent/src/httpClient.ts` | +40 行 | 新增 `queryWindowConnections()` + `WindowConnection` 类型 + `WindowConnectionsResponse` 类型 |
| `packages/agent/src/browser/BrowserManager.ts` | +78 行 | 新增 `static connectExisting(cdpEndpoint)` 方法 + `BrowserContext` 类型导入 |
| `packages/agent/src/executors/ArrivalExecutor.ts` | ~260 行重写 | 替换 `executeBrowserDryRunAssignment` 实现 |

### 3.3 关键实现

#### 3.3.1 queryWindowConnections

位置: `packages/agent/src/httpClient.ts:176`

```typescript
export async function queryWindowConnections(
  client: AxiosInstance,
  filters?: { staffName?: string; status?: string; siteId?: string },
): Promise<WindowConnectionsResponse>
```

- 调用 `GET /agent/window-connections?staffName=X&siteId=Y&status=ready`
- 10 秒超时
- 返回 `{ windows: WindowConnection[], total: number }`
- 使用 Agent 已有 Bearer Token 鉴权
- 请求失败写 agent 日志，不 fallback

#### 3.3.2 BrowserManager.connectExisting

位置: `packages/agent/src/browser/BrowserManager.ts:341`

```typescript
static async connectExisting(cdpEndpoint: string): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}>
```

- 使用 `chromium.connectOverCDP(cdpEndpoint)` 连接已有 Backend READY 窗口
- 不启动新 browser 进程，不调用 launch/start
- 复用已有 context (`browser.contexts()[0]`)
- 页面选择优先级:
  1. 笨鸟业务域名页面 (`benniaosuyun.com`)
  2. 非 about:blank 页面
  3. 第一个页面 (含 about:blank)
  4. `context.newPage()` (仍在同一 CDP browser 内)
- 连接失败抛出 `CDP_CONNECT_FAILED`，不 fallback
- 日志: `[Agent][Browser] connectExisting start/success/failed`

#### 3.3.3 ArrivalExecutor READY 窗口匹配

位置: `packages/agent/src/executors/ArrivalExecutor.ts:310-420`

**匹配流程:**

| 步骤 | 操作 | 失败后果 |
|------|------|----------|
| 1 | `queryWindowConnections({staffName, siteId, status:'ready'})` | `READY_WINDOW_QUERY_FAILED` |
| 2 | count=0 时重试诊断查询(不加 status 过滤) | `READY_WINDOW_NOT_FOUND` (含状态列表) |
| 3 | 匹配: windowId 精确 > 第一个结果 | — |
| 4 | 验证 `siteId` 一致性 | `READY_WINDOW_SITE_MISMATCH` |
| 5 | 验证 `staffName` 一致性 | `READY_WINDOW_STAFF_MISMATCH` |
| 6 | 验证 `cdpAttachable=true` | `READY_WINDOW_NOT_ATTACHABLE` |
| 7 | 验证 `cdpEndpoint` 非空 | `READY_WINDOW_CDP_ENDPOINT_MISSING` |
| 8 | `BrowserManager.connectExisting(cdpEndpoint)` | `CDP_CONNECT_FAILED` |
| 9 | `detectBnsyDashboardP0(page)` 验证 READY | `READY_WINDOW_DASHBOARD_NOT_READY` |

**所有失败路径共同保证:**
- 不新开 Chrome
- 不重新登录
- 不 fallback 到 Cloud Engine
- 不 fallback 到 BrowserManager.start()

---

## 四、删除的旧代码

以下代码从 `ArrivalExecutor.ts` 的 `executeBrowserDryRunAssignment` 中**完全删除**:

```
✗  new BrowserManager(browserConfig)
✗  manager.start()
✗  manager.connect()
✗  manager.openPage(loginUrl)
✗  ensureBnsyLoggedIn(page, credential)
✗  manager.close()
✗  loginUrl 变量
✗  config?.browser 依赖检查
✗  browserConfig 变量
```

保留的旧方法 (`BrowserManager` 实例方法 `start()/connect()/openPage()/close()`) 仍可供其他执行器使用，但 Arrival 正式路径不再调用它们。

---

## 五、静态验证结果

### 5.1 npm run build

```
> tsc
(无错误输出)
```

**✅ 通过** — 全项目 TypeScript 编译无错误。

### 5.2 npm run check:no-cloud-engine

```
[check:no-cloud-engine] Phase K-R1 Cloud Engine 归档隔离检查
[check:no-cloud-engine] 扫描根目录: backend
[check:no-cloud-engine] 扫描完成: 95 个 .ts 文件
[check:no-cloud-engine] ✅ 检查通过：未发现 Cloud 引擎回流风险
```

**✅ 通过** — 6 条规则全部通过。

### 5.3 关键字搜索

| 搜索目标 | 范围 | 结果 |
|----------|------|------|
| `new BrowserManager` | `ArrivalExecutor.ts` | **0 处** ✅ |
| `.start()` | `ArrivalExecutor.ts` | **0 处** ✅ |
| `connectOverCDP` | `packages/agent/src` | **3 处** (BrowserManager.connect 旧 + connectExisting 新 + ArrivalExecutor 调用) ✅ |
| `scheduleLocalEngineRun` | `backend/` | **6 处** (全部在注释中) ✅ |
| `source: 'local-api'` | `backend/` | **1 处** (仅类型声明 `PgDatabase.ts:281`) ✅ |
| `ensureBnsyLoggedIn` | `ArrivalExecutor.ts` | **0 处** ✅ |

---

## 六、日志设计

### 6.1 正常流程日志

```
[Agent][Arrival] 收到任务 taskId=xxx siteId=xxx
[Agent][Arrival] assignment 准备执行 staffName=xxx windowId=xxx
[Agent][Arrival] 查询 READY 窗口 connections count=N
[Agent][Arrival] 匹配 READY 窗口成功 staffName=xxx windowId=xxx cdpAttachable=true
[Agent][Arrival] connectOverCDP 开始 windowId=xxx
[Agent][Browser] connectExisting start cdpEndpoint=127.0.0.1:***
[Agent][Browser] connectExisting success pages=N
[Agent][Arrival] connectOverCDP 成功 windowId=xxx
[Agent][Arrival] 使用 READY 窗口执行，不新开 Chrome
[Agent][Arrival] 不新开 Chrome，不重新登录
[Agent][Arrival] READY 窗口 Dashboard 验证通过
[Agent][Arrival] READY 窗口任务完成，浏览器保持运行（由 Backend 管理）
```

### 6.2 失败流程日志

```
[Agent][Arrival] READY_WINDOW_NOT_FOUND: 未找到员工 xxx 在站点 xxx 的 READY 窗口
[Agent][Arrival] READY_WINDOW_NOT_ATTACHABLE: 窗口 xxx cdpAttachable=false
[Agent][Arrival] READY_WINDOW_CDP_ENDPOINT_MISSING: 窗口 xxx cdpEndpoint 为空
[Agent][Arrival] READY_WINDOW_DASHBOARD_NOT_READY: 窗口 xxx 登录态已失效
[Agent][Arrival] CDP_CONNECT_FAILED: ...
[Agent][Arrival] READY_WINDOW_SITE_MISMATCH: ...
[Agent][Arrival] READY_WINDOW_STAFF_MISMATCH: ...
[Agent][Arrival] READY_WINDOW_QUERY_FAILED: ...
```

### 6.3 日志元数据

所有日志附带:
- `staffName` — 员工姓名 (用于前端员工日志框过滤)
- `windowId` — 窗口 ID
- `siteId` — 站点 ID
- `source=agent` — Backend 写入 task_logs 时自动设置

---

## 七、已知问题与待办

### 7.1 K-R1 遗留 pending tasks 未清理

K-R1-Verify 留下了 4 个 pending 测试任务，需在启动 Agent 前处理:

| Task ID | 类型 |
|---------|------|
| `72e9dd3c-8432-446f-9697-80c195b88e40` | arrival |
| `9e0d49cf-d2d3-4ab4-a036-eb99480f4ba7` | dispatch |
| `6579325d-65c1-4870-a141-dc679a84957d` | integrated |
| `d257d19e-b8f6-426e-be3e-c921866e1bcd` | sign |

**原因:** 本地 PostgreSQL 连接超时，SQL 清理未执行。  
**建议:** 通过 Backend API 或直接 psql 标记为 `cancelled`。

### 7.2 E2E 验收未执行

以下测试无法在当前环境执行 (需要运行中的 Backend + Frontend):

| 测试项 | 状态 |
|--------|------|
| READY 窗口前置验证 (`GET /agent/window-connections`) | 未执行 |
| Agent 执行 Arrival dry-run (有 READY 窗口) | 未执行 |
| 找不到 READY 窗口失败测试 | 未执行 |
| cdpEndpoint 缺失失败测试 | 未执行 |
| 数据库 task_logs source=agent 验证 | 未执行 |

### 7.3 其他业务执行器

Sign、Dispatch、Integrated 执行器仍然使用 `new BrowserManager` + `manager.start()` 旧路径。这些将在后续 K-3B / K-3C / K-3D 阶段迁移。

---

## 八、Phase K-3A-2 结论

### 结论: 代码实现通过，待 E2E 验收

| 验收标准 | 状态 |
|----------|------|
| Arrival task 由 Agent pull | ✅ 已有逻辑，未修改 |
| ArrivalExecutor 真实执行 | ✅ 代码就绪 |
| task_logs source=agent | ✅ AgentLogger → /agent/tasks/:id/logs → source:'agent' |
| Arrival 使用 connectOverCDP 接管 READY 窗口 | ✅ `BrowserManager.connectExisting()` |
| Arrival 不新开 Chrome | ✅ 已删除 `new BrowserManager` + `start()` |
| Arrival 不重新登录 | ✅ 改用 `detectBnsyDashboardP0` 只读验证 |
| 找不到 READY 窗口时直接 fail | ✅ `READY_WINDOW_NOT_FOUND` 等 8 个错误码 |
| cdpEndpoint 缺失时直接 fail | ✅ `READY_WINDOW_CDP_ENDPOINT_MISSING` |
| cdpAttachable=false 时直接 fail | ✅ `READY_WINDOW_NOT_ATTACHABLE` |
| 不 fallback Cloud | ✅ 无 `scheduleLocalEngineRun` 无 `source:'local-api'` |
| 不恢复 scheduleLocalEngineRun | ✅ 函数已删除 |
| check:no-cloud-engine 通过 | ✅ |
| build 通过 | ✅ |

**是否允许进入 K-3B (Dispatch 真 Agent 迁移):** 条件允许

**条件:**
1. 清理 4 个 K-R1 遗留 pending tasks
2. 至少执行 1 次 E2E dry-run 验证 READY 窗口接管通路 (正常路径 + 找不到窗口路径)

---

## 九、修改文件清单

```
packages/agent/src/httpClient.ts          — +40 行
packages/agent/src/browser/BrowserManager.ts  — +78 行
packages/agent/src/executors/ArrivalExecutor.ts — ~260 行重写
```

---

## 十、附: 未修改的关键文件

以下文件**未修改**，确认无需改动:

| 文件 | 原因 |
|------|------|
| `backend/agent/agentRoutes.ts` | K-3A-1 已实现 `GET /agent/window-connections` |
| `backend/api/routes.ts` | K-R1 已归档，四业务只创建 pending task |
| `backend/playwright-runtime/PlaywrightRuntime.ts` | K-3A-1 已实现 CDP 端口暴露 |
| `packages/agent/src/index.ts` | Arrival 路由逻辑不变，仍调用 `executeArrivalDryRun` |
| `packages/agent/src/browser/AgentBusinessRuntime.ts` | K-2E 运行时规则不变 |
| `packages/agent/src/logger/AgentLogger.ts` | K-2E 日志缓冲逻辑不变 |
| `packages/agent/src/browser/ArrivalBrowserDryRun.ts` | DRY-RUN 页面操作不变 |
| `packages/agent/src/executors/DispatchExecutor.ts` | K-3B 待迁移 |
| `packages/agent/src/executors/SignExecutor.ts` | K-3C 待迁移 |
| `packages/agent/src/executors/IntegratedExecutor.ts` | K-3D 待迁移 |

---

*报告结束*
