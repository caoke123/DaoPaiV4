# DaoPai V3 Phase Deploy-0C Agent 窗口状态上报与持久化报告

> 生成日期：2026-07-04  
> 代码版本：V3 当前主干  
> 状态：**代码完成，TypeScript 通过，待人工测试**

---

## 1. 总体结论

**Header 状态已优先读取 Agent 上报的持久化窗口状态，window_status 表已建立，Agent 已具备独立的状态上报循环。**

- Header `WindowStateProvider` 优先调用 `GET /api/cloud/windows/status` 读取 Cloud 持久化状态
- 若无 Agent 上报数据，自动 fallback 到 `GET /api/sites/:siteId/playwright-windows`
- Agent 每 5 秒独立上报窗口状态（与任务拉取/执行完全解耦）
- 启动/关闭窗口继续走 V3 Playwright 过渡接口

---

## 2. 修改文件列表

### 新增文件

| 文件 | 说明 |
|---|---|
| [009_v3_window_status.sql](file:///e:/网站开发/DaoPaiV3/database/migrations/009_v3_window_status.sql) | PostgreSQL migration — window_status 表 |
| [local-runtime/types.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/local-runtime/types.ts) | Deploy-0B 新增，Deploy-0C 未修改 |

### 后端（4 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts) | 修改 | 新增 `GET /api/cloud/windows/status` |
| [agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts) | 修改 | 新增 `POST /agent/windows/status` |
| [PgDatabase.ts](file:///e:/网站开发/DaoPaiV3/backend/db/PgDatabase.ts) | 修改 | 新增 `upsertWindowStatus()` + `getWindowStatusBySite()` |

### Agent（3 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [types.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/types.ts) | 修改 | 新增 `WindowStatusReportEntry` + `WindowStatusReportBody` |
| [httpClient.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/httpClient.ts) | 修改 | 新增 `reportWindowStatus()` |
| [index.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/index.ts) | 修改 | 新增独立窗口状态上报循环 |

### Frontend（2 个文件）

| 文件 | 操作 | 说明 |
|---|---|---|
| [client.ts](file:///e:/网站开发/DaoPaiV3/frontend/src/api/client.ts) | 修改 | 新增 `CloudWindowStatus` 类型 + `getCloudWindowStatus()` |
| [WindowStateProvider.tsx](file:///e:/网站开发/DaoPaiV3/frontend/src/components/shared/WindowStateProvider.tsx) | 修改 | 优先 Cloud 状态 + Playwright fallback |

---

## 3. 数据库变更

### 新增表：window_status

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | BIGSERIAL | 主键 |
| `tenant_id` | TEXT | 租户 ID（FK → tenants） |
| `site_id` | TEXT | 网点 ID |
| `workstation_id` | TEXT | 执行电脑 ID |
| `window_id` | TEXT | 窗口标识（如 `staff-张三`） |
| `staff_name` | TEXT | 员工姓名 |
| `status` | TEXT | `offline` / `starting` / `login_required` / `logging_in` / `ready` / `busy` / `error` |
| `status_text` | TEXT | 状态文案 |
| `current_url` | TEXT | 当前 URL |
| `is_process_alive` | BOOLEAN | Chrome 进程是否存活 |
| `is_cdp_ready` | BOOLEAN | CDP 连接是否就绪 |
| `is_dashboard_ready` | BOOLEAN | P0 守卫是否通过 |
| `is_login_page` | BOOLEAN | 是否在登录页 |
| `last_error` | TEXT | 最近错误 |
| `cdp_endpoint` | TEXT | CDP 端口 |
| `profile_path` | TEXT | Profile 路径 |
| `chrome_pid` | INTEGER | Chrome 进程 PID |
| `last_heartbeat_at` | TIMESTAMPTZ | 最后心跳时间 |
| `created_at` | TIMESTAMPTZ | 创建时间 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

### 唯一约束

```sql
UNIQUE (tenant_id, site_id, workstation_id, window_id)
```

### Upsert 逻辑

```sql
INSERT INTO window_status (...) VALUES (...)
ON CONFLICT (tenant_id, site_id, workstation_id, window_id)
DO UPDATE SET ... (全部字段更新，last_heartbeat_at = NOW())
```

### 过期状态判断

在 `GET /api/cloud/windows/status` 中实现：

```ts
const STALE_MS = 60_000; // 超过 60 秒视为过期
const stale = (Date.now() - new Date(updatedAt).getTime()) > STALE_MS;
if (stale) { status = 'offline'; statusText = '离线（状态过期）'; }
```

### 索引

```sql
CREATE INDEX idx_window_status_site ON window_status(tenant_id, site_id);
CREATE INDEX idx_window_status_ws ON window_status(tenant_id, site_id, workstation_id);
CREATE INDEX idx_window_status_updated ON window_status(updated_at DESC);
```

---

## 4. Backend API

### 4.1 Agent 窗口状态上报 — `POST /agent/windows/status`

- **位置**：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts)
- **认证**：`requireAgent` 中间件，通过 `getAgentPrincipal(req)` 获取 `tenantId` / `workstationId`
- **请求体**：`{ siteWindows: WindowStatusReportEntry[] }`
- **参数验证**：`siteWindows` 必须是数组，缺少 `siteId`/`windowId` 的条目会被跳过并打印 warn
- **批量限制**：最多 50 条目/次
- **失败处理**：只打印 `console.warn`，不影响业务任务
- **不触发**：窗口启动/关闭/任务创建

### 4.2 Header 窗口状态查询 — `GET /api/cloud/windows/status`

- **位置**：[routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts)
- **参数**：`?siteId=xxx`（必填）
- **返回**：
  ```json
  {
    "windows": [
      {
        "siteId": "...",
        "workstationId": "...",
        "windowId": "...",
        "staffName": "...",
        "status": "ready",
        "statusText": "就绪",
        "isDashboardReady": true,
        "stale": false,
        "updatedAt": "..."
      }
    ]
  }
  ```
- **不依赖**：PlaywrightRuntime、本地 Chrome、Backend 内存缓存
- **数据来源**：PostgreSQL 的 `window_status` 表

---

## 5. Agent 状态上报

### 5.1 状态采集来源（过渡实现）

当前采用过渡方案：Agent 调用 Cloud 的 `/agent/window-connections` 获取窗口信息，整理后上报。

```text
Deploy-0C 过渡：Cloud PlaywrightRuntime → /agent/window-connections → Agent 整理 → /agent/windows/status → PostgreSQL
Deploy-0D 目标：Local Runtime 直接检测 Portable Chrome → Agent → /agent/windows/status → PostgreSQL
```

### 5.2 上报频率

每 5 秒执行一次（`REPORT_INTERVAL_MS = 5000`）。

### 5.3 失败处理

```text
上报失败 → console.warn（非致命） → 不影响任务执行
```

### 5.4 是否阻塞任务执行

**否。** 状态上报是独立的 `setInterval`，与心跳/任务拉取/任务执行完全解耦。

```ts
const reportTimer = setInterval(() => reportWindowStatusLoop(), REPORT_INTERVAL_MS);
```

### 5.5 busy 状态处理

从 Cloud PlaywrightRuntime 返回的窗口状态中读取 `status === 'busy'`，直接映射上报。未做 windowId 与 runningTaskId 的精准绑定。

**限制说明**：当前无法精准识别"哪个具体 window 在 busy"，仅依赖 Cloud 端的 busy 标记。Deploy-0D 后改为 Local Runtime 直接检测。

### 5.6 状态映射（Cloud 状态 → Agent 上报状态）

| Cloud Playwright 状态 | Agent 上报状态 | statusText |
|---|---|---|
| `ready` | `ready` | 就绪 |
| `busy` | `busy` | 工作中 |
| `login_required` | `login_required` | 待登录 |
| `connecting` | `starting` | 启动中 |
| `connected` | `starting` | 连接中 |
| `offline` / 其他 | `offline` | 离线 |

---

## 6. Frontend Header 状态改造

### 6.1 WindowStateProvider 状态来源优先级

```text
1. GET /api/cloud/windows/status (Agent 上报持久化状态) — 优先
2. GET /api/sites/:siteId/playwright-windows (V3 Playwright 过渡) — fallback
```

### 6.2 是否保留 Playwright fallback

**是。** 当 `/api/cloud/windows/status` 返回空数组或失败时，自动 fallback 到 Playwright 过渡路径。避免 Agent 状态上报未启动时 Header 空白。

### 6.3 Cloud 状态映射到 Header

| Cloud 状态 | Header displayStatus |
|---|---|
| `ready` | `ready` |
| `busy` | `busy` |
| `login_required` | `login_required` |
| `starting` / `logging_in` | `connecting` |
| `offline` | `offline` |
| `error` | `degraded` |

### 6.4 启动/关闭按钮

继续走 V3 Playwright 过渡接口，**未改为 Window Command 模式**。

```
Header 启动 → /api/sites/:siteId/playwright-windows/ensure
Header 关闭 → /api/sites/:siteId/playwright-windows/close
一键启动   → /api/sites/:siteId/playwright-windows/launch-all
```

---

## 7. EasyBR 清理保持情况

**Deploy-0B 清理结果保持，没有恢复 EasyBR 调用。**

### 验证搜索

| 搜索词 | 生产代码结果 |
|---|---|
| `EasyBRClient` | 仅存在于 `easybr/EasyBRClient.ts` 文件中（无 import） |
| `toggleWindow` | 0 匹配 |
| `getBrowerList` | 0 匹配 |
| `openedList` | 0 匹配 |
| `browerid` | 仅存在于 410 Gone 路由参数中 |
| `E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe` | 0 匹配 |

---

## 8. 不变项确认

本次 Deploy-0C **没有修改** 以下核心模块：

- ArrivalExecutor — 到件扫描执行器
- DispatchExecutor — 派件扫描执行器
- IntegratedExecutor — 到派一体执行器
- SignExecutor — 签收录入执行器
- READY-window 匹配逻辑
- dryRunMode / ENABLE_REAL_SUBMIT 安全门
- Task Center 日志策略
- BrowserManager.connectExisting(cdpEndpoint)
- 任务创建 / 任务拉取主链路
- 多员工 assignments 逻辑

---

## 9. 验证结果

### TypeScript 编译

| 包 | 结果 |
|---|---|
| Backend | 通过 |
| Frontend | 通过 |
| Packages/agent | 通过 |

### 人工测试清单

| 测试项 | 状态 |
|---|---|
| 启动 backend | 待测试 |
| 启动 frontend | 待测试 |
| 启动 Agent | 待测试 |
| Header 正常显示窗口状态 | 待测试 |
| Agent 上报后 Header 显示 Cloud 状态 | 待测试 |
| 停止 Agent 后 Header 状态过期 → offline | 待测试 |
| 一键启动窗口可用 | 待测试 |
| 单个窗口启动可用 | 待测试 |
| 单个窗口关闭可用 | 待测试 |
| 创建试运行任务 | 待测试 |
| Agent 拉取任务 | 待测试 |
| 窗口执行任务 | 待测试 |
| 执行日志正常回传 | 待测试 |
| Task Center 状态正常 | 待测试 |

---

## 10. 遗留风险

| 编号 | 风险 | 等级 | 后续处理 |
|---|---|---|---|
| R1 | Agent 状态采集来源为 Cloud PlaywrightRuntime（过渡），非 Local Runtime 真实检测 | P2 | Deploy-0D 改为本地检测 |
| R2 | busy 状态未精准绑定 windowId（只能通过 Cloud side 标记） | P2 | Deploy-0D Local Runtime 直接标记 |
| R3 | 启动/关闭仍走 Playwright 过渡接口，非 Window Command 模式 | P1 | Deploy-0D |
| R4 | profile 路径未实际切换到 `profiles/{tenantId}/{siteId}/{windowId}/` | P2 | Deploy-0D/Deploy-1 |
| R5 | BrowserPool.ts / EasyBRClient.ts 未物理删除 | P2 | Deploy-0D |

---

## 11. Git 提交

| 项目 | 说明 |
|---|---|
| 本阶段是否提交 | **否** |
| 计划提交策略 | Deploy-0B + Deploy-0C 一起提交 |
| 建议 commit message | `feat: persist agent window status and prepare local runtime` |
| 确认排除项 | `.env`, `data/settings.json`, `runtime/profiles`, `logs`, `screenshots`, Chrome profile |

### 当前 Git 状态

```
 M backend/agent/agentRoutes.ts
 M backend/api/routes.ts
 M backend/browser/runtime/RuntimeStatus.ts
 M backend/browser/runtime/__tests__/RuntimeStatus.test.ts
 M backend/config/runtimeMode.ts
 M backend/db/PgDatabase.ts
 M backend/index.ts
 M backend/modules/assignment-engine/AssignmentEngine.ts
 M frontend/src/api/client.ts
 M frontend/src/components/layout/Header.tsx
 M frontend/src/components/shared/WindowStateProvider.tsx
 M frontend/src/index.css
 M frontend/src/lib/mock-data.ts
 M frontend/src/pages/BrowserPage.tsx
 M frontend/src/pages/SettingsPage.tsx
 M packages/agent/agent.example.json
 M packages/agent/src/browser/ChromeProcessGuard.ts
 M packages/agent/src/config.ts
 M packages/agent/src/httpClient.ts
 M packages/agent/src/index.ts
 M packages/agent/src/types.ts
?? database/migrations/009_v3_window_status.sql
?? packages/agent/src/local-runtime/
?? docs/deploy/
```
