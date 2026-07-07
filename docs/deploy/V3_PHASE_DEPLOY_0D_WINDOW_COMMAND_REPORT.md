# DaoPai V3 Phase Deploy-0D Window Command 模式报告

## 1. 总体结论

Header 启动/关闭窗口已成功从直接调用 PlaywrightRuntime API 迁移为 **Window Command 模式**：

```
Header → 创建 command → Cloud window_commands 表 → Agent pull → 执行 → 上报 window_status → Header 展示
```

四个业务 Executor **零改动**，通过 `/agent/window-connections` 优先读取 `window_status` 表 + PlaywrightRuntime fallback 保持兼容。

---

## 2. 修改文件列表

### 新增文件 (4)

| 文件 | 说明 |
|------|------|
| `database/migrations/010_v3_window_commands.sql` | window_commands 持久化表 |
| `packages/agent/src/local-runtime/LocalWindowRuntime.ts` | 窗口命令执行器（open/close/restart/refresh）|
| `packages/agent/src/local-runtime/WindowStatusCollector.ts` | 本地窗口状态采集器（进程/CDP/URL检测）|

### 修改文件 (8)

| 文件 | 改动 |
|------|------|
| `backend/db/PgDatabase.ts` | 新增 window_commands CRUD（7方法）+ getReadyWindowConnectionsFromStatus |
| `backend/api/routes.ts` | 新增 Cloud command API（create / batch / get）|
| `backend/agent/agentRoutes.ts` | 新增 Agent command API（pull / complete / fail）+ 修改 window-connections 优先读 window_status |
| `packages/agent/src/httpClient.ts` | 新增 pullWindowCommands / completeWindowCommand / failWindowCommand |
| `packages/agent/src/index.ts` | 新增独立 command poll loop（3s）+ 报告改为 Local Runtime 真实检测 |
| `frontend/src/api/client.ts` | 新增 createWindowCommand / createWindowCommandBatch / getWindowCommand |
| `frontend/src/components/layout/Header.tsx` | 启动/关闭/一键启动改为创建 command |

---

## 3. 数据库变更

### 新增表: `window_commands`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 命令 ID（randomUUID）|
| tenant_id | TEXT NOT NULL | 租户隔离 |
| site_id | TEXT NOT NULL | 站点 |
| workstation_id | TEXT NOT NULL | 工作站 |
| window_id | TEXT NOT NULL | 目标窗口 |
| staff_name | TEXT NOT NULL | 员工名称 |
| type | TEXT CHECK | open_window / close_window / restart_window / refresh_status |
| status | TEXT CHECK | pending / claimed / running / done / failed / cancelled |
| params | JSONB | 命令参数 |
| result | JSONB | 执行结果 |
| error | TEXT | 失败描述 |
| claimed_at / started_at / finished_at | TIMESTAMPTZ | 生命周期时间戳 |

### 索引

- `idx_window_commands_claim`: 原子 claim 索引（tenant_id, workstation_id, status, created_at）
- `idx_window_commands_site`: 站点查询索引
- `idx_window_commands_status`: 状态时序索引

### 状态流转

```
pending → claimed → running → done
                          ↘ failed
                          ↘ cancelled (超时)
```

---

## 4. Backend Command API

### Cloud API

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/cloud/windows/commands` | 创建窗口命令（Header 启动/关闭）|
| POST | `/api/cloud/windows/commands/batch` | 批量创建（一键启动）|
| GET | `/api/cloud/windows/commands/:commandId` | 查询命令状态 |

### Agent API

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/agent/windows/commands/pull` | Agent 拉取命令（原子 claim）|
| POST | `/agent/windows/commands/:commandId/complete` | 上报完成 |
| POST | `/agent/windows/commands/:commandId/fail` | 上报失败 |

### 关键实现

- `claimPendingWindowCommands`: 使用 `SELECT ... FOR UPDATE SKIP LOCKED` 保证原子性，防止多 Agent 重复 claim
- 所有 Backend API **不直接操作 PlaywrightRuntime**，不启动 Chrome，不访问本地进程
- V3 Playwright 过渡接口完整保留作为 fallback

---

## 5. Agent Command 执行

### 新增模块

```
packages/agent/src/local-runtime/
├── types.ts                    (已存在，D-0B)
├── LocalWindowRuntime.ts       (新增)
└── WindowStatusCollector.ts    (新增)
```

### 路径计算

| 配置项 | 计算方式 | 示例值 |
|--------|----------|--------|
| chromePath | `{localRoot}/chrome/chrome.exe` | `DaoPai-Local/chrome/chrome.exe` |
| profilePath | `{localRoot}/profiles/{tenantId}/{siteId}/{windowId}` | `profiles/demo/demo-site/win-001` |
| debugPort | `31000 + hash(windowId) % 100` | `31042` |

无硬编码绝对路径。

### open_window

1. 计算 `profilePath` / `chromePath` / `debugPort`
2. 使用 BrowserManager 启动便携 Chrome（复用进程守卫 + 端口检查）
3. CDP 连接 + 导航到业务系统首页
4. 采集状态后上报 window_status
5. 完成 command

### close_window

1. 检查窗口 busy 状态（通过 `runningTaskId` 上下文判断）
2. busy 时拒绝并 fail command
3. 非 busy 时 `killV3ChromeByPid` + 清理 registry
4. 上报 `window_status = offline`
5. 完成 command

### restart_window

- `close_window → open_window`

### refresh_status

- 执行 `collectWindowStatus()` 检测进程/CDP/URL/登录态
- 上报 `window_status`

### busy 保护

```ts
if ((cmd.type === 'close_window' || cmd.type === 'restart_window') && runningTaskId) {
  await failWindowCommand(client, cmd.commandId, '当前窗口正在执行任务，不能关闭');
  continue;
}
```

---

## 6. Header 改造

### 启动按钮

```
原来: ensurePlaywrightWindow(activeSiteId, staffName)
现在: createWindowCommand({ type: 'open_window', ... })
```

### 关闭按钮

```
原来: closePlaywrightWindow(activeSiteId, staffName)
现在: createWindowCommand({ type: 'close_window', ... })
```

### 一键启动

```
原来: launchAllPlaywrightWindows(activeSiteId)
现在: createWindowCommandBatch(commands)
```

### 状态读取

- 继续读取 `GET /api/cloud/windows/status`（从 window_status 表）
- 未改为直接读 Playwright 状态
- Playwright fallback API 函数保留在 `client.ts` 中，但 Header 不再使用

---

## 7. /agent/window-connections 兼容

### 核心改动

```
原来: 仅读 PlaywrightRuntime.listWindowsJSON()
现在: 优先读 window_status 表（ready/cdp_endpoint NOT NULL/未过期）
     → fallback PlaywrightRuntime（去重后补充）
```

### 返回结构

保持完全兼容：

```ts
{
  ok: true,
  data: {
    windows: Array<{
      runtimeKey, windowId, staffName, windowName,
      tenantId, siteId, status, currentUrl, isLoggedIn,
      cdpPort, cdpEndpoint, cdpAttachable
    }>,
    total: number
  }
}
```

### READY 判断规则

优先数据源 `window_status`:
- `status = 'ready'`
- `is_cdp_ready = true`
- `is_dashboard_ready = true`
- `cdp_endpoint IS NOT NULL`
- `last_heartbeat_at > NOW() - 60s` (未过期)

### 四个 Executor 状态

**零改动**，继续调用 `/agent/window-connections` → `BrowserManager.connectExisting(cdpEndpoint)`。

---

## 8. 安全保护

| 保护项 | 实现 |
|--------|------|
| busy 窗口关闭保护 | Agent 执行 close 前二次检查 `runningTaskId`，拒绝并 fail command |
| 命令不触发业务提交 | command 只操作窗口生命周期，不创建业务任务 |
| 失败可见 | `window_commands.error` 字段记录，Header 通过 API 可查询 |
| Agent 未启动 | command 创建成功，status 保持 pending；Header 不崩溃 |
| 命令超时 | pending > 60s / running > 120s 可视为过期（当前仅记录，未自动取消）|

---

## 9. EasyBR 清理保持情况

Deploy-0B 清理结果**未被恢复**：

- ✅ 无新文件 import EasyBRClient（仅在 legacy `BrowserPool.ts` / `EasyBRClient.ts` 中）
- ✅ `toggleWindow` / `getBrowerList` / `openedList` 仅存在于 legacy 文件
- ✅ 硬编码 Chrome 路径 0 结果
- ✅ 所有 EasyBR production 路由保持 410 Gone

---

## 10. 不变项确认

以下内容**未修改**（Deploy-0D 零改动）：

- [x] `ArrivalExecutor.ts`
- [x] `DispatchExecutor.ts`
- [x] `IntegratedExecutor.ts`
- [x] `SignExecutor.ts`
- [x] `dryRunMode` / `ENABLE_REAL_SUBMIT`
- [x] Task Center 日志策略
- [x] V3 Playwright 过渡接口（保留 fallback）
- [x] `window_status` fallback 逻辑（保留）
- [x] EasyBR legacy code（保留未删）

---

## 11. 验证结果

| 检查项 | 结果 |
|--------|------|
| `backend && npx tsc --noEmit` | ✅ 通过 |
| `frontend && npx tsc --noEmit` | ✅ 通过 |
| `packages/agent && npx tsc --noEmit` | ✅ 通过 |
| `grep EasyBRClient` (生产路径) | ✅ 未恢复 |
| `grep toggleWindow/getBrowerList/openedList` (生产路径) | ✅ 未恢复 |
| `grep "E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe"` | ✅ 未恢复 |
| `git diff -- executors` | ✅ 零改动 |

---

## 12. 遗留风险

| 风险 | 说明 | 后续阶段 |
|------|------|----------|
| Local Runtime 未独立打包 | 当前通过 Agent 直接执行 LocalWindowRuntime | Deploy-0E+ |
| Profile 无迁移策略 | 新 profile 路径不同于 V3 Playwright profile | Deploy-0E+ |
| Playwright 过渡接口 | 保留但不再使用；最终需下线 | 完整迁移后 |
| BrowserPool / EasyBRClient | 物理删除（当前仅断开生产路径） | 异步清理 |
| 无复杂调度 | 无队列/Redis/WebSocket | 后续按需 |

---

## 13. Git 状态

- 基线 commit: `ef38f2256b8ce1ac7759ee072e091ac1fd44a2c6`
- 本阶段修改待人工测试通过后提交
