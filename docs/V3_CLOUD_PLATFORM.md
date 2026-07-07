# DaoPai Cloud Platform 设计

> 版本：v1.0（Phase 1 架构冻结草案）
> 适用范围：DaoPai V3 SaaS 方向
> 关联文档：V3_ARCHITECTURE.md / V3_DATA_MODEL.md / V3_AGENT_DESIGN.md

---

## 1. 云端平台定位

DaoPai Cloud Platform 是 V3 SaaS 的云端单体服务，承担所有"管理类"职责：

- **Web 前端**：管理员/操作员使用的 SPA（Vite + React）。
- **API 后端**：Express + TypeScript，单体部署。
- **PostgreSQL**：业务数据唯一持久化目标。
- **Redis**：会话、缓存、限流、原子锁辅助。
- **租户管理**：开通、停用、到期、最大设备数。
- **用户管理**：租户内用户、角色、简单授权。
- **网点管理**：租户下的网点增删改查。
- **设备管理**：workstation 注册、绑定、心跳、授权。
- **任务中心**：任务创建、状态机、分配、结果归档。
- **日志中心**：Agent 上报日志的聚合与查询。
- **授权控制**：第一版手动开通/停用/到期，不做支付。

云端第一版**不做**：本地浏览器执行、本地窗口状态判定、截图二进制存储、复杂 RBAC、支付系统、Kubernetes 部署。

---

## 2. 云端 Docker 组成

第一版云端 Docker Compose 建议组成：

| 服务 | 镜像 / 来源 | 职责 |
| -- | -- | -- |
| `cloud-web` | 本地构建（Vite 产物 + nginx） | 前端静态资源 |
| `cloud-api` | 本地构建（Node + TypeScript） | Express API |
| `postgres` | 官方 postgres:16 | 业务数据 |
| `redis` | 官方 redis:7 | 会话 / 缓存 / 锁 |
| `nginx` | 官方 nginx:1.27 | 反向代理 + HTTPS 终止 |

部署形态：

- 单台轻量云服务器即可承载第一版。
- `cloud-web` 与 `cloud-api` 可合并为单容器（第一版简化），后续再拆分。
- `nginx` 作为入口，统一 HTTPS 终止和路径转发。
- `postgres` 与 `redis` 不对外暴露端口，仅容器内网互通。

---

## 3. 租户 / 会员

第一版租户管理采用最简模型，不做支付：

### 3.1 租户状态机

```text
tenant.status:
  - active      已开通，可正常使用
  - disabled    已停用（管理员手动停用）
  - expired     已到期（expires_at 早于当前时间）
```

### 3.2 关键字段

| 字段 | 含义 |
| -- | -- |
| `tenant.status` | active / disabled / expired |
| `tenant.expires_at` | 到期时间，到期后自动转为 expired |
| `tenant.max_workstations` | 该租户允许绑定的最大设备数 |

### 3.3 控制规则

- `disabled` / `expired` 状态的租户：用户无法登录，Agent 无法鉴权。
- 新增 workstation 时校验当前租户设备数是否超过 `max_workstations`。
- 第一版不做自动续费、不做支付回调，所有状态变更由超级管理员手动操作。
- 后续如需引入支付，可扩展 `tenant_subscriptions` 表，不影响现有字段。

---

## 4. 设备绑定

每台本地电脑是一个 `workstation`，绑定流程如下：

### 4.1 首次绑定

1. 超级管理员在云端后台为租户创建 `workstation` 记录（生成 `workstationId` + `agentToken`）。
2. 将 `agent.json` 配置（含 `tenantId` / `siteId` / `workstationId` / `agentToken`）下发给员工电脑。
3. Agent 首次启动，使用 `agentToken` 调用 `POST /agent/register` 完成首次注册。
4. 云端记录 `workstation.status = active`，`online_status` 根据心跳更新，`last_heartbeat_at` 记录最后心跳时间。

### 4.2 在线状态

- Agent 周期性上报心跳到 `agent_heartbeats` 表。
- 云端定时任务扫描，超过阈值（如 60 秒）未上报则将 `workstation.online_status` 标记为 `offline`。
- `workstation.status` = `active` / `disabled`（授权状态，管理员手动控制）。
- `workstation.online_status` = `online` / `offline` / `error`（在线状态，由心跳推导）。
- `workstation.browser_status` = `ready` / `browser_missing` / `degraded` / `unknown`（浏览器环境状态，由 Agent 上报）。

**关键说明**：

- **在线/离线不是授权状态**：`offline` 只是临时在线状态，不应混入 `workstation.status`。
- **授权状态由 `workstation.status` 表示**：管理员开通 / 停用设备。
- **在线状态由 `online_status` + `last_heartbeat_at` 推导**：心跳超时即变 `offline`，恢复心跳即变 `online`。
- **浏览器是否可执行由 `browser_status` 表示**：由 Agent 启动检查和环境检测上报。

### 4.3 授权状态

- `workstation.status = active`：设备已授权，**结合 `online_status` 和 `browser_status` 判断是否可领取新任务**。
- `workstation.status = disabled`：管理员禁用设备，不可领取新任务，已分配任务可继续完成或回收。
- **`disabled` 表示管理员禁用设备，不等同于 `offline`**。`offline` 是心跳超时推导出来的临时在线状态，授权状态仍为 `active`。
- `agentToken` 可由云端**撤销和重新生成**，撤销后 Agent 鉴权失败，进入等待重新绑定状态。

### 4.4 解绑与迁移

- 员工电脑更换时：超级管理员在云端停用旧 workstation，新建 workstation 并下发配置。
- 不允许同一 `workstationId` 在多台电脑同时运行（云端通过心跳来源 IP / Agent 实例 ID 校验，第一版可简化）。

---

## 5. 任务中心

任务中心是云端核心业务模块：

### 5.1 任务生命周期

```text
pending    待领取
assigned   已分配给某 workstation
running    Agent 已开始执行
succeeded  执行成功
failed     执行失败
timeout    执行超时
cancelled  已取消
```

### 5.2 任务创建

- 用户在云端 Web 创建任务，指定 `tenant_id` / `site_id`（可选 `workstation_id`）。
- 任务初始状态 `pending`，写入 `tasks` 表。
- 任务 `payload` 字段存放任务参数（JSON），不存放二进制数据。

### 5.3 任务领取

- Agent 通过 `POST /agent/tasks/claim` 领取任务。
- 云端使用原子操作（`SELECT ... FOR UPDATE SKIP LOCKED` 或乐观锁）分配任务。
- 领取后状态变为 `assigned`，记录 `workstation_id` 和 `assigned_at`。

**领取前置条件**：只有同时满足以下条件的 workstation 才能领取新任务：

- `tenant.status = active`（租户已开通且未到期/停用）
- `workstation.status = active`（设备已授权）
- `workstation.online_status = online`（设备在线）
- `workstation.browser_status = ready` 或其它可执行状态（浏览器环境就绪）

任一条件不满足时，云端拒绝领取请求并返回相应错误码（403 无权限 / 409 状态冲突）。

### 5.4 结果回传

- Agent 执行过程中通过 `POST /agent/tasks/:id/logs` 上报日志。
- 完成后通过 `POST /agent/tasks/:id/result` 上传结果，写入 `waybill_results`。
- 失败时通过 `POST /agent/tasks/:id/fail` 上报错误信息。

### 5.5 数据可见性

- 用户只能查看自己 `tenant_id` 下的任务、日志、结果。
- 跨租户查询一律拒绝（403）。
- 任务列表默认按 `workstation_id` 过滤（本机视图），可切换为 `site_id` 视图（本网点）。

---

## 6. API 错误处理

Cloud API 必须统一错误响应格式与状态码，避免错误路径长时间挂起（参考 Phase 0-C ISSUE-006）：

### 6.1 统一状态码

| 状态码 | 含义 | 使用场景 |
| -- | -- | -- |
| 200 | 成功 | 正常业务响应 |
| 400 | 请求参数错误 | 参数缺失、格式错误 |
| 401 | 未登录 | Token 缺失或无效 |
| 403 | 无权限 | 跨租户访问、角色不足 |
| 404 | 不存在 | 资源不存在或不可见 |
| 408 | 请求超时 | 客户端超时 |
| 409 | 冲突 | 重复领取、状态冲突 |
| 500 | 服务错误 | 未捕获异常 |

### 6.2 统一响应格式

```json
{
  "ok": false,
  "code": "TENANT_FORBIDDEN",
  "message": "无权访问该租户数据",
  "timestamp": "2026-06-29T12:00:00Z"
}
```

### 6.3 错误中间件

- 所有 API 路由必须经过统一错误处理中间件。
- 未匹配路由必须立即返回 404，不允许长时间挂起。
- 所有未捕获异常必须被兜底中间件捕获并返回 500，不允许进程崩溃。

---

## 7. 备份

### 7.1 PostgreSQL 备份

- 每日定时全量备份（推荐 pg_dump）。
- 备份文件保留最近 7～30 天。
- 备份文件不与数据库同机存放（建议传对象存储或异地服务器）。
- 定期验证备份可恢复性（每月一次恢复演练）。

### 7.2 不存大文件

- 轻量云服务器**不存截图大文件**。
- 业务数据只存数据库，不上传二进制到容器内磁盘。
- 日志按天滚动，避免磁盘被打满。

### 7.3 关键配置备份

- `docker-compose.yml`、`.env`（脱敏后）、Nginx 配置、租户开通记录纳入版本控制或配置库。
- Agent 下发配置（`agent.json` 模板）由超级管理员后台管理，定期导出归档。

---

## 8. 与 V2 的隔离

- V3 云端使用独立域名、独立端口、独立数据库、独立 Redis。
- V3 不复用 V2 的任何运行配置或凭据。
- V3 开发期间 V2 继续独立运行，互不影响。
- V3 不修改 V2 任何代码与配置。
