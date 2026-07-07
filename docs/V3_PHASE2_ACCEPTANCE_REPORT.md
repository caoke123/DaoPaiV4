# DaoPai V3 Phase 2 多租户隔离回归验收报告

## Phase 2 总结

Phase 2 完成了从单机 JSON/SQLite 存储到 PostgreSQL 多租户隔离架构的完整迁移：

| 子阶段 | 内容 | Commit |
|---|---|---|
| 2-A | 数据库结构审计 | 审计报告（无 commit） |
| 2-B | 多租户数据库基础落地 | `50e35cb` |
| 2-C | 任务主链路 PG 单写收敛 | `8ff6e31` |
| 2-C-1 | PG 终态写入失败补丁 | `9bb8e24` |
| 2-D | workstation_id 最小注入 | `7a660a8` |
| 2-E | 租户上下文中间件 + API 强制隔离 | `eebbd87` |
| 2-F | 多租户隔离回归验收 | 本阶段 |

**核心成果**：任务主链路已实现 tenant_id / site_id / workstation_id 三元隔离，PostgreSQL 为主数据源，JSON/SQLite 降级为 legacy mirror。

## 1. 修改文件

本阶段仅新增文档：

| 文件 | 说明 |
|---|---|
| `docs/V3_PHASE2_ACCEPTANCE_REPORT.md` | 本验收报告 |

## 2. 全项目搜索结果

### routes.ts 任务主链路

- `DEFAULT_TENANT_ID`: **零残留** — 所有引用已改为 `getTenantId(req)`
- `DEFAULT_WORKSTATION_ID`: **零残留** — 所有引用已改为 `getWorkstationId(req)`

### DEFAULT_TENANT_ID 残留（非主链路模块）

| 文件 | 使用方式 | 判断 |
|---|---|---|
| `requestContext.ts` | 中间件默认值注入 | 正确 — 单点默认值来源 |
| `PgDatabase.ts` | 方法默认参数 | 正确 — API 层显式传 tenantId，内部/测试用默认值 |
| `windowRuntimeRoutes.ts` | 窗口运行时路由 | 非任务主链路 — 独立模块 |
| `playwright-runtime/types.ts` | 自身常量定义 | 非任务主链路 — 独立模块 |
| `AssignmentEngine.ts` L1104 | `resolveWorkerConnection` 适配器 | 非任务持久化 — 运行时绑定 |

### PgDatabase 裸查询检查

所有 31 个 `WHERE ... tenant_id` 子句均已正确过滤。**零裸查询**。

### 结论

- 任务主链路 routes.ts 无 DEFAULT_TENANT_ID/DEFAULT_WORKSTATION_ID 硬编码
- PgDatabase 所有任务查询均带 tenant_id 过滤
- 非主链路模块（窗口运行时、Playwright 适配器）的 DEFAULT_TENANT_ID 使用不涉及任务持久化，不在本阶段收敛范围

## 3. 数据库结构验收

| 表 | tenant_id | site_id | workstation_id |
|---|---|---|---|
| tenants | PK | — | — |
| workstations | 有 | 有（可空） | PK |
| sites | 有 | PK | — |
| tasks | 有 | 有 | 有 |
| task_logs | 有 | 有 | 有 |
| waybill_results | 有 | 有 | — |
| waybill_pool | 有 | 有 | — |

### 默认数据

- `tenant-default`: 存在，status=active
- `ws-local-default`: 存在，tenant_id=tenant-default，status=active

### Migration 记录

```
filename                       | applied_at
001_v3_multitenant_base.sql    | 2026-06-29
002_v3_default_workstation.sql | 2026-06-29
```

后端重启后 migration 不重复执行（"全部 2 个 migration 已是最新"）。

## 4. tenant-other 隔离测试

### 测试数据

- 租户 `tenant-other`，工作站 `ws-other`
- 任务 `b1590f35-...`（dispatch, done, 5/5/0）
- 日志 1 条
- 运单结果 1 条（`OTHER-0001`）

### API 验证结果

| API | 默认请求 (tenant-default) | 结果 |
|---|---|---|
| `GET /api/operations` | tenant-other 任务不可见 | PASS |
| `GET /api/operations/stats` | source=pg，不统计 tenant-other | PASS |
| `GET /api/tasks/:id/logs` | 200，返回空（tenant 过滤） | PASS |
| `GET /api/tasks/:id/waybills` | 200，返回空（tenant 过滤） | PASS |
| `GET /api/tasks/:id/summary` | 404 "任务不存在" | PASS |
| `GET /api/tasks/:id/staff` | 200，返回空（tenant 过滤） | PASS |

**结论**：tenant-default 请求无法访问 tenant-other 数据。隔离生效。

## 5. workstation_id 验收

| 验证项 | 结果 |
|---|---|
| tasks.workstation_id | ws-local-default |
| task_logs.workstation_id | ws-local-default |
| `GET /api/operations` | workstationId: "ws-local-default" |
| `GET /api/tasks/:id/logs` | workstationId: "ws-local-default" |
| `GET /api/tasks/:id/summary` | workstationId: "ws-local-default" |
| recoverRunningTasks | 不清空 workstation_id（仅更新 status/finishedAt） |

## 6. PG 主链路验收

| 写入环节 | 主数据源 | 状态 |
|---|---|---|
| 任务创建 | `pg.insertTask` (PRIMARY) | 5 个入口全部 PG 主写，失败→500 |
| 任务状态更新 | `pg.updateTaskStatus` (PRIMARY) | Engine 所有终态/取消路径 await |
| 任务日志 | `pg.insertTaskLogs` (PRIMARY) | 带 tenant_id + site_id + workstation_id |
| 运单结果 | `pg.insertWaybillResults` (PRIMARY) | 带 tenant_id + site_id，链入 writeChain |
| 运单池 | `pg.upsertWaybillPool` (PRIMARY) | 带 tenant_id |
| 任务读取 | `PgDatabase` (PRIMARY) | 全部 API 读 PG，不回退 JSON/SQLite |
| 终态失败 | PG 失败 → throw | 不允许静默成功 |
| JSON/SQLite | Legacy mirror | best-effort try/catch，不掩盖 PG 失败 |

## 7. 验证结果

| 验证项 | 结果 |
|---|---|
| `npm run build` | exit code 0 |
| 单元测试 | 9 tests passed |
| 后端启动 | Express 3300，PG 连接成功 |
| migration 幂等 | 2 个 migration 不重复执行 |
| 任务中心页面 | 200，可打开 |
| `GET /api/operations` | source=pg，workstationId=ws-local-default |
| `GET /api/operations/stats` | source=pg，200 |
| 任务创建 PG | tasks/task_logs/waybill_results 均写入 PG |
| tenant-other 隔离 | 6 个 API 均无法读取 tenant-other 数据 |
| BrowserPool/Playwright/settings.json | 未修改 |
| V2 目录 | 未触碰 |

## 8. 未处理事项

- **JWT 尚未开始**
- **Agent 鉴权尚未开始**
- **超管后台尚未开始**
- **settings.json 尚未上云**
- **Database.ts legacy 代码仍存在**（仅降级为 mirror/缓存）
- **windowRuntimeRoutes 等非主链路模块仍使用 DEFAULT_TENANT_ID**（不影响任务持久化）
- **recoverRunningTasks 中 PG 失败不中断其余恢复**（per-task try/catch，符合设计）

## 9. 是否修改执行内核

**没有修改执行内核**。未触碰 BrowserPool、Playwright Runtime、窗口 READY / LOGIN / P0 判断。

## 10. 是否触碰 V2

**没有触碰 V2 目录**。

## 11. 是否可以进入 Phase 3

**可以进入 Phase 3 Cloud Platform 基础阶段。**

Phase 2 已实现：
- tenant_id / site_id / workstation_id 三元隔离
- PostgreSQL 任务主数据源
- 请求上下文中间件 + API 强制隔离
- tenant-other 隔离验证通过
- PG 终态写入失败不静默成功
- JSON/SQLite 降级为 legacy mirror

Phase 3 可在此基础上开始：
- JWT 登录系统
- Agent 拆分与鉴权
- 真实 workstation 管理
- settings.json 上云
- Cloud Platform 基础架构