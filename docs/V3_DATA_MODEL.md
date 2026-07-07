# DaoPai V3 数据模型与隔离设计

> 版本：v1.0（Phase 1 架构冻结草案）
> 适用范围：DaoPai V3 SaaS 方向
> 关联文档：V3_ARCHITECTURE.md / V3_AGENT_DESIGN.md / V3_CLOUD_PLATFORM.md

---

## 1. 三个核心 ID

V3 数据隔离围绕三个核心 ID 设计，缺一不可：

| ID | 名称 | 含义 | 隔离层级 |
| -- | -- | -- | -- |
| `tenantId` | 租户 ID | 客户/租户唯一标识 | 最高数据隔离边界 |
| `siteId` | 网点 ID | 租户下的具体网点 | 租户内业务分组 |
| `workstationId` | 工作站 ID | 本地执行电脑 | 网点内执行设备 |

**核心原则**：

- `tenantId` 是**最高隔离边界**，跨租户数据绝对不可见。
- `siteId` 用于租户内的网点业务分组与统计。
- `workstationId` 用于执行设备隔离，决定窗口状态、任务领取、执行锁的归属。

---

## 2. 关系说明

```text
tenant（租户）
  ├─ site（网点）
  │   ├─ employee（派件员 / 目标员工 / 业务员工）
  │   └─ workstation（执行设备）
  └─ user（平台用户：管理员 / 操作员）
```

关系说明：

- 一个 `tenant` 下可有多个 `site`。
- 一个 `site` 下可有多个 `employee` 和多个 `workstation`。
- `user` 直接挂在 `tenant` 下，不挂在 `site` 下（一个用户可能管理多个网点）。
- `workstation` 必须绑定到一个 `site`，不能游离。

### 2.1 employee 与 SaaS 会员的区别

- `employee` 是快递网点业务人员（派件员 / 目标员工 / 业务员工），不是 SaaS 会员。
- SaaS 会员 / 授权属于 `tenant` / `tenant_subscriptions` / `tenant_authorizations`，与 `employee` 无关。
- `employee` 不参与租户授权、不参与计费、不持有平台账号。
- `employee` 仅作为浏览器自动化执行时的"目标员工"或"业务账号"出现，例如登录笨鸟业务系统的网点账号。

### 2.2 user 与 site 的权限扩展

第一版 `user` 直接挂在 `tenant` 下，默认可访问该 `tenant` 下被授权的业务范围。

如后续需要限制某个用户只能管理部分网点，可采用以下扩展方式之一：

- **方案 A**：新增 `user_sites` 关联表，记录 `user_id` 与 `site_id` 的多对多关系。
- **方案 B**：在 `users` 表中增加 `accessible_site_ids` 字段（JSON 数组），简单场景下更轻量。

该扩展**不影响 `tenant_id` 作为最高隔离边界**：即使 `user` 被限制只能访问部分 `site`，所有查询仍必须强制带 `tenant_id`，跨租户访问依然返回 403。`user_sites` / `accessible_site_ids` 只用于租户内的网点级细分授权。

---

## 3. 数据隔离原则

数据隔离是 V3 SaaS 的底线，必须强制执行：

- **所有云端业务查询必须按 `tenant_id` 隔离**：不允许出现不带 `tenant_id` 限制的全表查询。
- **不允许只靠前端隐藏数据**：前端隐藏只是 UI 体验，后端必须强制过滤。
- **后端 API 层必须强制限制 `tenant_id`**：从会话/JWT 中提取 `tenant_id`，注入到所有业务查询条件中。
- **不同租户之间不能互相看到**：任务、日志、员工、网点、设备数据全部隔离。
- **跨租户访问必须显式报错**：不允许"查不到就返回空"，应返回 403 或 404，避免信息泄露。
- **超级管理员后台单独审计**：如需跨租户运维，走单独审计通道，记录操作日志。

---

## 4. 核心表方向

第一版建议表（不写完整 SQL，仅列方向）：

| 表名 | 主要职责 | 关键字段方向 |
| -- | -- | -- |
| `tenants` | 租户主表 | id, name, status, expires_at, max_workstations |
| `users` | 平台用户 | id, tenant_id, username, password_hash, role, status |
| `sites` | 网点 | id, tenant_id, name, config |
| `employees` | 派件员 / 目标员工 / 业务员工 | id, tenant_id, site_id, name, easybr_browser_id |
| `workstations` | 执行设备 | id, tenant_id, site_id, name, agent_token, status, online_status, browser_status, last_heartbeat_at |
| `tasks` | 任务主表 | id, tenant_id, site_id, workstation_id, type, status, payload, created_at |
| `task_logs` | 任务日志 | id, tenant_id, task_id, workstation_id, level, message, created_at |
| `waybill_results` | 运单结果 | id, tenant_id, site_id, task_id, waybill_no, status, data |
| `agent_heartbeats` | Agent 心跳 | id, tenant_id, workstation_id, status, reported_at |
| `tenant_subscriptions` / `tenant_authorizations` | 租户订阅/授权 | id, tenant_id, plan, starts_at, expires_at, max_workstations |

---

## 5. 字段归属建议

### 5.1 必须含 `tenant_id` 的表

所有业务表都必须含 `tenant_id`：

- `users`、`sites`、`employees`、`workstations`
- `tasks`、`task_logs`、`waybill_results`
- `agent_heartbeats`
- `tenant_subscriptions`

### 5.2 必须含 `site_id` 的表

涉及网点业务范围的表：

- `employees`、`workstations`
- `tasks`（任务归属某个网点）
- `waybill_results`（运单结果归属网点）

### 5.3 必须含 `workstation_id` 的表

涉及执行设备隔离的表：

- `tasks`（任务可指定 workstation，也可由 workstation 主动领取）
- `task_logs`（日志归属具体设备）
- `agent_heartbeats`（心跳归属具体设备）

### 5.4 重点约束

- `tasks` 必须同时有 `tenant_id` / `site_id` / `workstation_id`（workstation_id 可空表示未分配）。
- `task_logs` 必须同时有 `tenant_id` / `task_id` / `workstation_id`。
- `waybill_results` 必须同时有 `tenant_id` / `site_id` / `task_id`。
- `workstations` 必须同时有 `tenant_id` / `site_id`。

### 5.5 workstation 状态三拆分

`workstations` 表的状态字段必须拆分为三个独立维度，避免混用：

| 字段 | 取值 | 含义 |
| -- | -- | -- |
| `status` | `active` / `disabled` | 设备授权状态（管理员手动控制） |
| `online_status` | `online` / `offline` / `error` | 当前在线状态（由心跳推导） |
| `browser_status` | `ready` / `browser_missing` / `degraded` / `unknown` | 本地浏览器环境是否可执行 |
| `last_heartbeat_at` | timestamp | 最后心跳时间 |

关键约束：

- `status` 表示**授权状态**，由管理员手动操作（开通 / 停用）。
- `online_status` 表示**在线状态**，由心跳超时推导，不应混入 `workstation.status`。
- `browser_status` 表示**浏览器环境状态**，由 Agent 启动检查和环境检测上报。
- **`offline` 不应混入 `workstation.status`**：离线只是临时在线状态，授权状态仍由 `status` 决定。
- 只有同时满足 `status=active` 且 `online_status=online` 且 `browser_status` 可执行（`ready` 或 `degraded`）的 workstation 才能领取新任务。

---

## 6. 多电脑隔离

V3 支持同一网点下多台电脑并行执行，必须做好设备级隔离：

### 6.1 窗口状态属于本地电脑

- `READY` / `BUSY` / `ERROR` 等窗口状态**只代表当前 workstation**。
- A 电脑的 `READY` 不能影响 B 电脑的 `BUSY`。
- 云端显示设备状态时，按 `workstationId` 分开展示。

### 6.2 执行锁粒度包含 `workstationId`

- 任务领取锁应包含 `workstationId`，避免同一任务被多台电脑同时领取。
- 推荐数据库层使用 `SELECT ... FOR UPDATE SKIP LOCKED` 或乐观锁版本号。
- 任务一旦被某 workstation 领取，状态变为 `assigned`，其它 workstation 不可再领取。

### 6.3 任务视图策略

- **第一版**：任务中心默认显示"本机任务"（按当前 workstation 过滤）。
- **后续**：支持"本网点任务"视图（按 site 过滤，可看到同网点其它设备的任务）。
- **不做**：跨网点任务视图（除非超级管理员审计通道）。

### 6.4 心跳与离线判定

- Agent 周期性上报心跳到 `agent_heartbeats` 表。
- 超过阈值未上报，云端将 `workstation.online_status` 标记为 `offline`。
- `workstation.status` 仍表示授权状态（例如 `active` / `disabled`），不会因心跳超时改变。
- 只有 `status=active` 且 `online_status=online` 且 `browser_status` 可执行的 workstation 才能领取新任务。
- `online_status=offline` 的 workstation 不再被分配新任务。
- 已分配但未完成的任务，由云端根据超时策略决定回收或保留。
