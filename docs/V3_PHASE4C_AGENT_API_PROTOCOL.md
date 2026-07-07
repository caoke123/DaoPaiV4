# DaoPai V3 Phase 4-C：Agent API 协议设计

> 版本：v1.0
> 日期：2026-06-29
> 阶段：Phase 4-C（API 协议设计，仅文档，不写代码）
> 前置 commit：`f0b89e1` — docs: refine Agent Token auth design
> 关联文档：V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md / V3_PHASE4B_AGENT_TOKEN_AUTH.md / V3_ARCHITECTURE.md / V3_DATA_MODEL.md

---

## 1. 协议总原则

```
Cloud 是任务状态真理源。
Agent 是本地执行者。
Agent 通过 HTTP 轮询与 Cloud 通信。
第一版不上 WebSocket。
Agent 只访问 /agent/*。
Web 前端只访问 /api/*。
```

任务状态统一使用：

```
pending / assigned / running / done / failed / timeout / cancelled
```

不使用 `succeeded`，统一使用 `done`。

---

## 2. 通用格式

### 2.1 请求

所有 `/agent/*` 请求必须携带：

```http
Authorization: Bearer <执行电脑授权码>
Content-Type: application/json
```

### 2.2 成功响应

```json
{
  "ok": true,
  "data": {},
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

### 2.3 失败响应

```json
{
  "ok": false,
  "code": "AGENT_TOKEN_INVALID",
  "message": "执行电脑授权码无效",
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

### 2.4 鉴权要求

所有 `/agent/*` 接口必须经过 `requireAgent` 中间件（见 Phase 4-B §6），验证通过后注入 `AgentPrincipal`：

```ts
{
  type: 'agent',
  tenantId: string,
  workstationId: string,
  siteId?: string | null
}
```

---

## 3. 接口清单

| 方法 | 路径 | 用途 | 频率 |
|------|------|------|------|
| GET | `/agent/me` | 验证授权码，返回执行电脑信息 | 启动时 / 按需 |
| POST | `/agent/heartbeat` | 心跳上报 + 任务通知 | 15 秒一次 |
| POST | `/agent/tasks/pull` | 拉取待执行任务 | 心跳发现有任务时 |
| POST | `/agent/tasks/:id/progress` | 上报任务进度 | 执行中 2-5 秒一次 |
| POST | `/agent/tasks/:id/logs` | 批量上报任务日志 | 执行中定期批量 |
| POST | `/agent/tasks/:id/complete` | 任务流程正常结束 | 任务结束时 |
| POST | `/agent/tasks/:id/fail` | 任务整体失败 | 任务失败时 |

---

## 4. 接口详细设计

### 4.1 GET /agent/me

**用途**：验证执行电脑授权码有效性，返回当前执行电脑信息。

**请求**：无 body。

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "workstationId": "ws-a1b2c3d4",
    "name": "天南大-前台01",
    "tenantId": "tenant-default",
    "tenantName": "默认快递公司",
    "siteId": "site-xxx",
    "siteName": "天南大网点",
    "status": "active",
    "onlineStatus": "online",
    "browserStatus": "ready"
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `workstationId` | string | 执行电脑编号 |
| `name` | string | 执行电脑名称 |
| `tenantId` | string | 快递公司编号 |
| `tenantName` | string | 快递公司名称 |
| `siteId` | string \| null | 所属网点编号（可空） |
| `siteName` | string \| null | 所属网点名称（可空） |
| `status` | string | 授权状态：`active` / `disabled` |
| `onlineStatus` | string | 在线状态：`online` / `offline` / `unknown` |
| `browserStatus` | string | 本地运行环境：`ready` / `login` / `p0` / `unknown` |

**鉴权失败响应**：见 §2.3 及 Phase 4-B §6.3。

---

### 4.2 POST /agent/heartbeat

**用途**：执行电脑上报在线状态、本地运行环境、版本信息。Cloud 返回是否有待执行任务。

**请求**：

```json
{
  "agentVersion": "1.0.0",
  "machineFingerprint": "fp-a1b2c3d4e5f6",
  "browserStatus": "ready",
  "localStatus": {
    "runningTaskId": null,
    "pendingLogCount": 0,
    "diskFreeMb": 20480
  }
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentVersion` | string | 是 | 执行端版本号 |
| `machineFingerprint` | string | 否 | 机器指纹 |
| `browserStatus` | string | 是 | 本地运行环境：`ready` / `login` / `p0` / `unknown` |
| `localStatus.runningTaskId` | string \| null | 否 | 当前正在执行的任务 ID |
| `localStatus.pendingLogCount` | number | 否 | 待上报日志数 |
| `localStatus.diskFreeMb` | number | 否 | 可用磁盘空间（MB） |

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "serverTime": "2026-06-30T00:00:00.000Z",
    "workstationStatus": "active",
    "hasTask": true,
    "nextPollAfterMs": 5000
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**响应字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverTime` | string | 服务器当前时间 |
| `workstationStatus` | string | 执行电脑授权状态：`active` / `disabled` |
| `hasTask` | boolean | 是否有待执行任务（`true` 只表示可能有，仍需调用 pull） |
| `nextPollAfterMs` | number | 建议下次心跳间隔（毫秒） |

**规则**：

- 心跳建议 15 秒一次
- 60 秒无心跳 Cloud 标记 `online_status = offline`
- `hasTask=true` 只表示可能有任务，Agent 仍需调用 `pull` 确认
- 心跳成功更新 `workstations` 表：`online_status`、`browser_status`、`last_heartbeat_at`、`last_ip`、`agent_version`
- 心跳失败（401/403）Agent 停止轮询，等待重新配置授权码

---

### 4.3 POST /agent/tasks/pull

**用途**：拉取一个待执行任务。Cloud 负责原子分配。

**请求**：

```json
{
  "capabilities": ["arrive", "dispatch", "integrated", "sign"],
  "siteId": "site-xxx",
  "maxTasks": 1
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `capabilities` | string[] | 是 | 执行电脑支持的任务类型 |
| `siteId` | string \| null | 否 | 限定网点（null 表示不限） |
| `maxTasks` | number | 是 | 最多拉取任务数（第一版 = 1） |

**规则**：

- 第一版 `maxTasks = 1`
- Cloud 分配任务必须原子化（`SELECT ... FOR UPDATE SKIP LOCKED`）
- 拉取后任务状态：`pending → assigned`，写入 `workstation_id`
- Agent 开始执行后通过 `progress` 上报 `running`

**有任务响应** `200`：

```json
{
  "ok": true,
  "data": {
    "hasTask": true,
    "task": {
      "taskId": "task-a1b2c3d4",
      "type": "arrive",
      "siteId": "site-xxx",
      "siteName": "天南大网点",
      "payload": {
        "waybills": ["YD1234567890", "YD0987654321"],
        "options": {}
      },
      "dryRun": false,
      "createdAt": "2026-06-30T00:00:00.000Z"
    }
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**无任务响应** `200`：

```json
{
  "ok": true,
  "data": {
    "hasTask": false,
    "task": null,
    "nextPollAfterMs": 5000
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**任务字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `taskId` | string | 任务 ID |
| `type` | string | 任务类型：`arrive` / `dispatch` / `integrated` / `sign` |
| `siteId` | string | 网点编号 |
| `siteName` | string | 网点名称 |
| `payload` | object | 任务参数（含运单列表、执行选项） |
| `dryRun` | boolean | 是否试运行模式 |
| `createdAt` | string | 任务创建时间 |

**payload 大小限制**：不超过 2MB（Phase 3 DECISION-005）。

**错误响应**：

| 场景 | 状态码 | 错误码 |
|------|--------|--------|
| 已有 running 任务（第一版不允许并发） | 409 | `WORKSTATION_BUSY` |

---

### 4.4 POST /agent/tasks/:id/progress

**用途**：上报任务执行进度。执行中周期性调用。

**请求**：

```json
{
  "status": "running",
  "progress": 45,
  "currentStaffName": "张三",
  "currentAction": "正在处理到件扫描",
  "processedCount": 45,
  "totalCount": 100
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | 是 | 当前状态：`assigned` / `running` |
| `progress` | number | 是 | 进度百分比 0-100 |
| `currentStaffName` | string | 否 | 当前操作员工姓名 |
| `currentAction` | string | 否 | 当前操作描述 |
| `processedCount` | number | 否 | 已处理数量 |
| `totalCount` | number | 否 | 总数量 |

**规则**：

- `progress` 范围 0-100
- `status` 只允许 `assigned` / `running`（`done` / `failed` 走 `complete` / `fail`）
- 重复上报不能报错（幂等）
- 进度不应倒退（Cloud 可做校验，倒退时记录警告但不拒绝）
- 首次上报 `running` 时，Cloud 更新 `tasks.status = running`

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "accepted": true
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**错误响应**：

| 场景 | 状态码 | 错误码 |
|------|--------|--------|
| 任务不存在 | 404 | `TASK_NOT_FOUND` |
| 任务不属于当前执行电脑 | 403 | `TASK_NOT_ASSIGNED_TO_WORKSTATION` |
| 任务已结束 | 409 | `TASK_ALREADY_FINISHED` |

---

### 4.5 POST /agent/tasks/:id/logs

**用途**：批量上报任务执行日志。

**请求**：

```json
{
  "logs": [
    {
      "level": "info",
      "message": "开始处理运单 YD1234567890",
      "staffName": "张三",
      "waybillNo": "YD1234567890",
      "timestamp": "2026-06-30T00:00:05.000Z"
    },
    {
      "level": "success",
      "message": "运单 YD1234567890 到件扫描成功",
      "staffName": "张三",
      "waybillNo": "YD1234567890",
      "timestamp": "2026-06-30T00:00:08.000Z"
    }
  ]
}
```

**日志条目字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `level` | string | 是 | 日志等级 |
| `message` | string | 是 | 日志内容 |
| `staffName` | string | 否 | 操作员工姓名 |
| `waybillNo` | string | 否 | 关联运单号 |
| `timestamp` | string | 是 | 日志产生时间 |

**日志等级**：

```
debug / info / warn / error / success
```

**规则**：

- 一次最多 100 条日志
- 日志过长需截断（建议单条 message 不超过 2000 字符）
- 日志内容**不能包含**执行电脑授权码、员工账号、员工密码
- 写入 `task_logs` 表
- 第一版允许重复日志（后续可用 `clientLogId` 去重）

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "accepted": 2,
    "rejected": 0
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**错误响应**：

| 场景 | 状态码 | 错误码 |
|------|--------|--------|
| 任务不存在 | 404 | `TASK_NOT_FOUND` |
| 任务不属于当前执行电脑 | 403 | `TASK_NOT_ASSIGNED_TO_WORKSTATION` |
| 日志条目超过上限 | 400 | `LOGS_BATCH_TOO_LARGE` |

---

### 4.6 POST /agent/tasks/:id/complete

**用途**：任务流程正常结束。无论部分运单是否失败，只要流程跑完就调用此接口。

**请求**：

```json
{
  "finalStatus": "done",
  "progress": 100,
  "summary": {
    "total": 100,
    "success": 95,
    "failed": 5,
    "durationMs": 45320
  },
  "results": [
    {
      "waybillNo": "YD1234567890",
      "status": "success",
      "message": "到件扫描成功",
      "timestamp": "2026-06-30T00:00:08.000Z"
    },
    {
      "waybillNo": "YD0987654321",
      "status": "failed",
      "message": "运单不存在",
      "timestamp": "2026-06-30T00:00:10.000Z"
    }
  ]
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `finalStatus` | string | 是 | 固定值 `done` |
| `progress` | number | 是 | 固定值 `100` |
| `summary.total` | number | 是 | 总处理数 |
| `summary.success` | number | 是 | 成功数 |
| `summary.failed` | number | 是 | 失败数 |
| `summary.durationMs` | number | 是 | 执行耗时（毫秒） |
| `results` | array | 是 | 运单结果列表 |

**运单结果条目**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `waybillNo` | string | 运单号 |
| `status` | string | `success` / `failed` |
| `message` | string | 结果描述 |
| `timestamp` | string | 处理时间 |

**规则**：

- 流程完成即调用 `complete`，部分运单失败也可以 `finalStatus=done`
- 运单失败写入 `results` 中的 `status=failed` 条目
- Cloud 更新 `tasks.status = done`
- 写入 `waybill_results` 表
- 重复 `complete` 不重复写结果（幂等）

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "accepted": true
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**错误响应**：

| 场景 | 状态码 | 错误码 |
|------|--------|--------|
| 任务不存在 | 404 | `TASK_NOT_FOUND` |
| 任务不属于当前执行电脑 | 403 | `TASK_NOT_ASSIGNED_TO_WORKSTATION` |
| 任务已结束 | 409 | `TASK_ALREADY_FINISHED` |

---

### 4.7 POST /agent/tasks/:id/fail

**用途**：任务整体失败（如浏览器崩溃、登录失败、配置缺失等）。

**请求**：

```json
{
  "finalStatus": "failed",
  "error": {
    "code": "BROWSER_NOT_READY",
    "message": "浏览器未就绪，无法启动自动化",
    "detail": "Playwright 浏览器启动超时（30s）"
  },
  "progress": 10,
  "summary": {
    "total": 100,
    "success": 0,
    "failed": 0,
    "durationMs": 30100
  }
}
```

**请求字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `finalStatus` | string | 是 | 固定值 `failed` |
| `error.code` | string | 是 | 错误码 |
| `error.message` | string | 是 | 错误描述 |
| `error.detail` | string | 否 | 错误详情（不含敏感信息） |
| `progress` | number | 是 | 失败时进度 |
| `summary` | object | 否 | 执行摘要 |

**常见错误码**：

| 错误码 | 说明 |
|--------|------|
| `BROWSER_NOT_READY` | 浏览器未就绪 |
| `LOGIN_REQUIRED` | 需要重新登录 |
| `SITE_CONFIG_MISSING` | 网点配置缺失 |
| `WORKER_CREDENTIAL_MISSING` | 员工账号密码缺失 |
| `TASK_PAYLOAD_INVALID` | 任务参数无效 |
| `EXECUTION_TIMEOUT` | 执行超时 |
| `UNKNOWN_ERROR` | 未知错误 |

**规则**：

- `fail` 用于任务整体失败，不是单个运单失败
- Cloud 更新 `tasks.status = failed`
- 错误写入 `task_logs`（level = error）
- 单运单失败走 `complete`，不触发 `fail`

**成功响应** `200`：

```json
{
  "ok": true,
  "data": {
    "accepted": true
  },
  "timestamp": "2026-06-30T00:00:00.000Z"
}
```

**错误响应**：

| 场景 | 状态码 | 错误码 |
|------|--------|--------|
| 任务不存在 | 404 | `TASK_NOT_FOUND` |
| 任务不属于当前执行电脑 | 403 | `TASK_NOT_ASSIGNED_TO_WORKSTATION` |
| 任务已结束 | 409 | `TASK_ALREADY_FINISHED` |

---

## 5. 任务状态流转

```
pending
  │
  │  POST /agent/tasks/pull
  ↓
assigned
  │
  │  POST /agent/tasks/:id/progress { status: "running" }
  ↓
running
  │
  ├── POST /agent/tasks/:id/complete → done
  │
  ├── POST /agent/tasks/:id/fail → failed
  │
  ├── Cloud 超时检测 → timeout
  │
  └── 用户取消 → cancelled
```

### 状态转换表

| 当前状态 | 允许转换到 | 触发方式 |
|----------|-----------|----------|
| `pending` | `assigned` | Agent pull |
| `pending` | `cancelled` | 用户取消 |
| `assigned` | `running` | Agent progress |
| `assigned` | `pending` | Cloud 超时回收 |
| `assigned` | `cancelled` | 用户取消 |
| `running` | `done` | Agent complete |
| `running` | `failed` | Agent fail |
| `running` | `timeout` | Cloud 超时检测 |
| `running` | `cancelled` | 用户取消 |
| `done` | — | 终态 |
| `failed` | — | 终态 |
| `timeout` | — | 终态（可人工重跑） |
| `cancelled` | — | 终态 |

### 超时策略

| 状态 | 超时阈值 | 处理 |
|------|----------|------|
| `assigned` | 5 分钟未变 `running` | 回收为 `pending` |
| `running` | 2 小时无心跳 | 标记 `timeout` |

---

## 6. 幂等规则

| 操作 | 幂等性 | 说明 |
|------|--------|------|
| `progress` | 允许重复，不允许倒退 | 倒退记录警告但不拒绝 |
| `logs` | 第一版允许重复 | 后续可用 `clientLogId` 去重 |
| `complete` | 重复不重复写结果 | 已 `done` 的任务再次 `complete` 返回 `accepted: true` 但不写数据 |
| `fail` | 重复不重复写 | 已 `failed` 的任务再次 `fail` 忽略 |
| 已 `done` 后再 `fail` | 拒绝 | 返回 `TASK_ALREADY_FINISHED` |
| 已 `failed` 后再 `complete` | 拒绝 | 返回 `TASK_ALREADY_FINISHED` |

---

## 7. 错误码汇总

### 7.1 鉴权类（Phase 4-B 已定义）

| 错误码 | HTTP 状态码 | 说明 |
|--------|------------|------|
| `AGENT_TOKEN_MISSING` | 401 | 未携带执行电脑授权码 |
| `AGENT_TOKEN_INVALID` | 401 | 执行电脑授权码无效 |
| `AGENT_TOKEN_REVOKED` | 401 | 执行电脑授权码已被撤销 |
| `WORKSTATION_DISABLED` | 403 | 执行电脑已停用 |
| `WORKSTATION_DELETED` | 403 | 执行电脑已删除 |

### 7.2 任务类

| 错误码 | HTTP 状态码 | 说明 |
|--------|------------|------|
| `TASK_NOT_FOUND` | 404 | 任务不存在 |
| `TASK_NOT_ASSIGNED_TO_WORKSTATION` | 403 | 任务不属于当前执行电脑 |
| `TASK_STATUS_CONFLICT` | 409 | 任务状态冲突 |
| `TASK_PAYLOAD_INVALID` | 400 | 任务参数无效 |
| `TASK_ALREADY_FINISHED` | 409 | 任务已结束 |
| `WORKSTATION_BUSY` | 409 | 执行电脑已有运行中任务 |
| `LOGS_BATCH_TOO_LARGE` | 400 | 日志批次超过上限 |

### 7.3 执行环境类（Agent 上报）

| 错误码 | 说明 |
|--------|------|
| `BROWSER_NOT_READY` | 浏览器未就绪 |
| `LOGIN_REQUIRED` | 需要重新登录 |
| `SITE_CONFIG_MISSING` | 网点配置缺失 |
| `WORKER_CREDENTIAL_MISSING` | 员工账号密码缺失 |
| `EXECUTION_TIMEOUT` | 执行超时 |
| `UNKNOWN_ERROR` | 未知错误 |

---

## 8. 数据落库关系

| 接口 | 影响 | 操作 |
|------|------|------|
| `heartbeat` | `workstations` | 更新 `online_status`、`browser_status`、`last_heartbeat_at`、`last_ip`、`agent_version` |
| `tasks/pull` | `tasks` | `pending → assigned`，写入 `workstation_id`、`assigned_at` |
| `progress` | `tasks` | 更新 `status`（首次 `running`）、`progress`、`updated_at` |
| `logs` | `task_logs` | 批量 INSERT |
| `complete` | `tasks` + `waybill_results` | `tasks.status = done`；INSERT `waybill_results` |
| `fail` | `tasks` + `task_logs` | `tasks.status = failed`；INSERT 错误日志到 `task_logs` |

---

## 9. Agent 主循环

```
Agent 启动
  ↓
1. GET /agent/me  → 验证授权码，确认执行电脑信息
  ↓
2. 循环开始：
  ├── POST /agent/heartbeat  → 上报状态，获取 hasTask
  ├── hasTask=true？
  │   ├── 是 → POST /agent/tasks/pull  → 拉取任务
  │   │   ├── 有任务 → 执行任务
  │   │   │   ├── POST /agent/tasks/:id/progress  → 上报进度（循环）
  │   │   │   ├── POST /agent/tasks/:id/logs  → 上报日志（批量）
  │   │   │   └── 执行完成 →
  │   │   │       ├── 成功 → POST /agent/tasks/:id/complete
  │   │   │       └── 失败 → POST /agent/tasks/:id/fail
  │   │   └── 无任务 → 等待 nextPollAfterMs
  │   └── 否 → 等待 nextPollAfterMs
  └── 回到循环开始
```

---

## 10. 现有执行链路说明

```
当前 Phase 4-C 只设计协议，不迁移执行链路。
Cloud 后端仍有 BrowserPool / AssignmentEngine / PlaywrightRuntime / EasyBR 遗留执行能力。
Agent 最小闭环完成后，再逐步迁移执行能力。
EasyBR 删除专项放在 Agent / Playwright 链路稳定后。
```

---

## 11. 与现有文档的一致性

| 文档 | 本文档引用 |
|------|-----------|
| V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md §6 | 通信模型：HTTP 轮询，心跳 15s，轮询 5s |
| V3_PHASE4A_LOCAL_AGENT_BOUNDARY.md §7 | 任务流转：pending → assigned → running → done/failed |
| V3_PHASE4B_AGENT_TOKEN_AUTH.md §2 | 用户 JWT 与 Agent Token 分离 |
| V3_PHASE4B_AGENT_TOKEN_AUTH.md §6 | AgentAuthResult 结构化错误码 |
| V3_PHASE4B_AGENT_TOKEN_AUTH.md §2.4 | 前端命名统一（快递公司、执行电脑、执行电脑授权码） |
| V3_DATA_MODEL.md | tasks / task_logs / waybill_results / workstations 表结构 |
| V3_DECISIONS.md DECISION-005 | payload 上限 2MB |
| V3_DECISIONS.md DECISION-006 | HTTP 轮询，不上 WebSocket |

---

## 12. 本阶段禁止事项确认

本阶段（Phase 4-C）**仅设计协议，不写代码**。以下事项已确认未执行：

- [x] 不写 Local Agent 程序
- [x] 不实现 `/agent/*` 路由
- [x] 不新增 migration
- [x] 不修改前端
- [x] 不修改后端业务代码
- [x] 不改 AssignmentEngine / BrowserPool / PlaywrightRuntime
- [x] 不删除 EasyBR
- [x] 不迁移 settings.json
- [x] 不触碰 V2