# DaoPai V3 Phase 4-A：Local Agent 边界设计

> 版本：v1.0
> 日期：2026-06-29
> 阶段：Phase 4-A（边界设计，仅文档，不写代码）
> 前置 commit：`35490e0` — docs: add Phase 3 acceptance and handoff
> 关联文档：V3_ARCHITECTURE.md / V3_AGENT_DESIGN.md / V3_CLOUD_PLATFORM.md / V3_DATA_MODEL.md / V3_DECISIONS.md / V3_PHASE3_ACCEPTANCE_REPORT.md / V3_PHASE3_HANDOFF.md / V3_PHASE3_KNOWN_ISSUES.md

---

## 1. Phase 4-A 总结结论

```
Cloud Platform 是云端管理中心。
Local Agent 是本地执行端。
Cloud 不应该直接控制浏览器。
Agent 才负责本机浏览器、窗口、任务执行。
```

### 一句话边界

| 角色 | 一句话 |
|------|--------|
| Cloud Platform | 管理租户、用户、任务、日志、结果，下发任务给 Agent，**不直接操作浏览器** |
| Local Agent | 安装在本机，拉取任务、执行浏览器自动化、回传进度与结果，**不管理 SaaS 用户** |

### 为什么必须拆分

DaoPai 不是普通网页系统，核心任务必须在本地电脑执行浏览器自动化。直接把浏览器自动化留在云端会带来：

- 云服务器无法稳定访问员工电脑本地的浏览器实例和已登录会话
- 云服务器让员工电脑浏览器端口直接对外暴露，存在严重安全风险
- 一旦员工关机、网络抖动，云端直接控制会立即失败且难以恢复

因此 V3 采用 **Local Agent 主动连接云端** 的模型（已在 V3_ARCHITECTURE.md §2 中确认）。

---

## 2. Cloud Platform 职责

### 2.1 Cloud 负责

| 类别 | 具体职责 | 当前状态（Phase 3 结束时） |
|------|----------|---------------------------|
| 用户认证 | 用户登录、JWT 颁发、Token 刷新、登出 | 已实现（Phase 3-B/D） |
| 租户管理 | 租户开通、停用、到期、最大设备数 | 部分实现（tenants 表只读） |
| 站点管理 | 租户下站点只读查询 | 已实现（/api/cloud/sites） |
| 工作站管理 | 工作站注册、绑定、授权、心跳状态 | 已实现（/api/cloud/workstations 只读） |
| 任务创建 | 用户在 Web 端创建任务，写入 `tasks` 表 | 已实现（init_window/arrive/dispatch/integrated/sign） |
| 任务队列 | 任务状态机（pending → assigned → running → done/failed） | 已实现（tasks 表状态管理） |
| 任务状态 | 任务生命周期管理，超时回收 | 已实现 |
| 日志中心 | Agent 上报日志的聚合与查询 | 已实现（task_logs 表） |
| 结果保存 | waybill_results 归档 | 已实现（waybill_results 表） |
| Agent 注册记录 | 记录 workstation 注册信息 | 已实现（workstations 表） |
| Agent Token 发放与校验 | 签发 agentToken，验证 Agent 身份 | 待实现（Phase 4-B） |
| 系统管理页面 | 系统总览、组织与站点、用户信息 | 已实现（/system） |
| 数据隔离 | 所有查询按 tenant_id 强制过滤 | 已实现 |

### 2.2 Cloud 不负责（当前及未来）

| 事项 | 说明 |
|------|------|
| 直接启动浏览器 | 浏览器启动由 Agent 在本机执行 |
| 直接控制本机窗口 | 窗口状态检测、窗口复用归 Agent 管理 |
| 直接读取本地浏览器状态 | 浏览器状态由 Agent 上报，Cloud 只记录 |
| 保存本机浏览器敏感运行数据 | 浏览器用户数据、会话 cookies 不离开本机 |
| 本地截图存储 | 截图本地临时保存，不上传云端（除非未来接对象存储且只存地址） |

### 2.3 当前 Cloud 中临时存在的执行能力

Phase 3 结束时，Cloud 后端仍包含 BrowserPool / PlaywrightRuntime / EasyBR 等执行模块。这些是 **V2 遗留、当前为兼容保留**，在 Local Agent 执行链路稳定后应迁移到 Agent 侧并从 Cloud 后端移除（详见 §9）。

---

## 3. Local Agent 职责

### 3.1 Agent 负责

| 类别 | 具体职责 |
|------|----------|
| 本机启动 | Agent 进程启动、环境检测、配置加载 |
| 工作站身份 | 持有 workstationId + agentToken，向 Cloud 注册 |
| 本机浏览器运行环境 | Playwright 浏览器安装、启动、会话管理 |
| 窗口状态检测 | 本机 READY / BUSY / ERROR 窗口状态判定 |
| 账号登录执行 | 读取本地 settings.json 获取员工账号密码，执行笨鸟业务系统登录 |
| 到件/派件/到派一体/签收自动化执行 | 复刻 V2 已稳定的浏览器自动化操作 |
| 执行日志本地采集 | 运行日志写入本地 logs/ 目录 |
| 进度上报 | 阶段性上报执行进度到 Cloud |
| 结果回传 | 运单结果回传 Cloud |
| 本地 settings.json 读取 | 读取员工账号、密码、窗口绑定、运行模式 |
| 本地截图/临时日志 | 调试模式截图保存，日志滚动保留 |

### 3.2 Agent 不负责

| 事项 | 说明 |
|------|------|
| 用户登录 | 用户 JWT 登录由 Cloud 前端处理，Agent 不用用户 JWT |
| SaaS 用户权限 | 角色管理、权限控制归 Cloud |
| 租户管理 | 租户开通/停用/到期归 Cloud |
| 云端任务历史管理 | 任务列表、历史查询归 Cloud |
| 多租户后台管理 | Agent 只认自己的 tenantId，不跨租户 |

### 3.3 Agent 与 V2 执行能力的关系

- V3 Local Agent 复用 V2 已稳定的浏览器自动化执行内核（Playwright 操作、窗口复用、笨鸟业务会话保持）
- V3 不修改 V2 代码，V2 继续独立运行
- V3 Local Agent 是独立程序，不与 V2 共享进程、配置、端口
- 从 V2 抽取执行内核的过程不破坏 V2 运行链路

---

## 4. workstation 设计

### 4.1 定义

```
一台安装 Local Agent 的本地电脑 / 执行端。
workstation 是 Cloud 管理执行设备的单位，不等于用户。
```

### 4.2 建议字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `tenant_id` | VARCHAR | 所属租户 |
| `site_id` | VARCHAR | 所属站点（必填） |
| `name` | VARCHAR | 工作站名称（如"天南大-前台01"） |
| `status` | VARCHAR | 授权状态：`active` / `disabled` |
| `online_status` | VARCHAR | 在线状态：`online` / `offline` / `error` |
| `browser_status` | VARCHAR | 浏览器状态：`ready` / `browser_missing` / `degraded` / `unknown` |
| `agent_token_hash` | VARCHAR | Agent Token 的哈希值（不存明文） |
| `agent_version` | VARCHAR | Agent 版本号 |
| `machine_fingerprint` | VARCHAR | 机器指纹（可选，用于检测重复运行） |
| `last_heartbeat_at` | TIMESTAMP | 最后心跳时间 |
| `last_ip` | VARCHAR | 最后心跳来源 IP |
| `created_at` | TIMESTAMP | 创建时间 |
| `updated_at` | TIMESTAMP | 更新时间 |

### 4.3 关系说明

```
tenant（租户）
  └─ site（站点）
       └─ workstation（执行设备）
            └─ Agent（本地程序实例）
```

- 一个租户可以有多个 workstation
- 一个 workstation 必须绑定一个主要站点
- workstation 不等于用户，它是设备
- workstation 用 Agent Token 鉴权，不用用户 JWT

### 4.4 状态三维度

已在 V3_DATA_MODEL.md §5.5 中确认，三个维度独立：

| 维度 | 字段 | 取值 | 含义 |
|------|------|------|------|
| 授权 | `status` | active / disabled | 管理员手动控制 |
| 在线 | `online_status` | online / offline / error | 心跳推导 |
| 浏览器 | `browser_status` | ready / browser_missing / degraded / unknown | Agent 上报 |

**领取任务前置条件**：`status=active` 且 `online_status=online` 且 `browser_status` 可执行。

### 4.5 注册与绑定流程

```
1. 超级管理员在 Cloud 后台创建 workstation 记录
2. Cloud 生成 agentToken（只展示一次）
3. 管理员将 agent.json 配置下发到员工电脑
4. Agent 启动，使用 agentToken 调用 /agent/heartbeat 完成首次注册
5. Cloud 记录 workstation.online_status=online
6. Agent 开始周期性心跳 + 轮询任务
```

---

## 5. Agent Token 设计

### 5.1 核心原则

```
用户 JWT 和 Agent Token 必须分离。
用户 JWT 代表人，Agent Token 代表设备。
两者不可互换。
```

### 5.2 对照表

| 维度 | 用户 JWT | Agent Token |
|------|----------|-------------|
| 代表谁 | 用户（人） | 工作站（设备） |
| 谁使用 | 前端 Web 页面 | Local Agent 程序 |
| 访问路径 | `/api/*` | `/agent/*` |
| 能否登录前端 | 能 | 不能 |
| 能否访问用户后台 | 能 | 不能 |
| 能否领取任务 | 通过 Web 创建任务 | 通过 Agent API 拉取任务 |
| 有效期 | access 15 分钟 / refresh 7 天 | 长期有效，支持撤销 |
| 刷新机制 | refresh token 轮换 | 撤销后重新生成 |
| 存储 | 前端 localStorage | Agent 本地 agent.json |
| 数据库存储 | users 表 + refresh_tokens 表 | workstations 表 agent_token_hash |

### 5.3 Agent Token 设计建议

| 特性 | 建议 |
|------|------|
| 生成时机 | 创建 workstation 时生成 |
| 展示次数 | 仅创建时展示一次 |
| 存储方式 | 数据库存 hash，不存明文 |
| 格式 | `daopai_agent_` 前缀 + 随机字符串（如 `daopai_agent_a1b2c3d4e5f6...`） |
| 有效期 | 默认长期有效，支持设置过期时间 |
| 禁用 | 管理员可禁用某 workstation 的 token |
| 轮换 | 管理员可重新生成 token（旧 token 立即失效） |
| 验证方式 | Agent 请求时带 `Authorization: Bearer agentToken`，Cloud 比对 hash |

### 5.4 Agent Token 与用户 JWT 的隔离

- Agent Token 只能访问 `/agent/*` 路径
- Agent Token 不能访问 `/api/auth/*`、`/api/cloud/*`、`/api/settings/*` 等用户接口
- 用户 JWT 不能访问 `/agent/*` 路径
- 中间件需要根据路径前缀区分鉴权方式

### 5.5 安全要求

- agentToken 不在日志中明文输出
- agent.json 必须设置文件权限（仅当前用户可读写）
- agent.json 不进入 Git 仓库
- Agent 检测到 token 失效后，停止领取任务并进入等待重新绑定状态

---

## 6. 通信模型

### 6.1 第一版：HTTP 轮询

第一版使用 HTTP 轮询，不依赖 WebSocket（已在 V3_DECISIONS.md DECISION-006 中确认）。

### 6.2 建议默认值

| 项 | 默认值 | 说明 |
|----|--------|------|
| Agent 心跳 | 15 秒一次 | 上报在线状态 |
| 离线判定 | 60 秒无心跳 | Cloud 标记 offline |
| 任务轮询 | 5 秒一次 | 检查是否有待执行任务 |
| 任务执行中进度上报 | 2-5 秒一次 | 执行期间提高上报频率 |

### 6.3 Agent 主循环

```
Agent 启动
  ↓
1. 启动检查（连接云端、Token 有效、浏览器环境就绪、配置完整）
  ↓
2. 使用 agentToken 调用 POST /agent/heartbeat
  ↓
3. Cloud 返回心跳响应，含是否有待执行任务
  ↓
4. 如有任务 → Agent 调用 POST /agent/tasks/pull 拉取任务
  ↓
5. Agent 本地执行任务（Playwright 自动化）
  ↓
6. Agent 调用 POST /agent/tasks/:id/progress 上报进度
  ↓
7. Agent 调用 POST /agent/tasks/:id/logs 上报日志
  ↓
8. Agent 调用 POST /agent/tasks/:id/complete 回传结果
  ↓
9. 循环回到步骤 2（心跳 + 轮询）
```

### 6.4 建议 Agent API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/agent/heartbeat` | 心跳上报 + 任务通知 |
| POST | `/agent/tasks/pull` | 拉取待执行任务 |
| POST | `/agent/tasks/:id/progress` | 上报执行进度 |
| POST | `/agent/tasks/:id/logs` | 上报执行日志 |
| POST | `/agent/tasks/:id/complete` | 回传执行结果 |
| POST | `/agent/tasks/:id/fail` | 上报执行失败 |
| GET | `/agent/me` | 验证 Agent Token 有效性 |

### 6.5 WebSocket 后续增强

未来可引入 WebSocket 做 `task_available` 实时通知，但：

- WebSocket 不能替代数据库任务状态机
- 收到通知后仍通过 HTTP 拉取任务详情
- 断线后必须回退到轮询兜底
- WebSocket 是"加速器"，不是"承重墙"

---

## 7. 任务流转设计

### 7.1 完整流转流程

```
用户在 Cloud Web 创建任务
  ↓
Cloud 保存任务为 pending，写入 tasks 表
  ↓
Agent 周期性心跳，Cloud 告知有待执行任务
  ↓
Agent 调用 POST /agent/tasks/pull 拉取任务
  ↓
Cloud 原子操作分配任务，状态变为 assigned，记录 workstation_id
  ↓
Agent 确认领取，开始本地执行，状态变为 running
  ↓
Agent 执行过程中周期性上报日志与进度
  ↓
Agent 执行完成，回传 waybill_results
  ↓
Cloud 标记任务 done，写入 waybill_results 表
  ↓
任务中心展示结果
```

### 7.2 任务状态机

```
pending    → 待领取（Cloud 创建任务后的初始状态）
assigned   → 已分配（Agent 拉取后，Cloud 原子分配）
running    → 执行中（Agent 确认开始执行）
succeeded  → 执行成功（Agent 回传结果）
failed     → 执行失败（Agent 上报错误）
timeout    → 执行超时（Cloud 检测超时，等待人工处理）
cancelled  → 已取消（用户在 Cloud 取消）
```

### 7.3 关键原则

| 原则 | 说明 |
|------|------|
| Cloud 是任务状态真理源 | 所有状态变更以 PostgreSQL 为准 |
| Agent 是执行者 | Agent 不直接决定历史任务展示 |
| Agent 掉线时 Cloud 标记 offline | 不影响已分配任务的历史记录 |
| 领取必须原子 | `SELECT ... FOR UPDATE SKIP LOCKED` 或乐观锁 |
| 结果回传幂等 | 同一任务可多次回传，以最终一次为准 |
| 不自动重跑真实任务 | 快递业务自动化最怕重复执行，失败任务优先人工确认 |

### 7.4 超时回收策略

| 任务状态 | 超时阈值 | 处理策略 |
|----------|----------|----------|
| `pending` | 长期保留 | 不自动回收 |
| `assigned` | 超过 5 分钟未变 `running` | 可回收为 `pending` |
| `running` | 超过 2 小时无心跳 | 标记 `timeout`，等待人工处理 |

---

## 8. settings.json 边界

### 8.1 当前数据分布

```
┌─────────────────────────────────────────────────────────┐
│                    PostgreSQL (Cloud)                      │
│  tenants / users / refresh_tokens / workstations          │
│  sites (只读同步) / tasks / task_logs / waybill_results   │
│  waybill_pool / metrics_snapshots                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                  settings.json (本地)                      │
│  网点配置 / 员工窗口 / 账号密码 / 浏览器窗口绑定           │
│  试运行模式 / 数据保留策略                                  │
└─────────────────────────────────────────────────────────┘
```

### 8.2 继续本地保留

| 配置项 | 保留原因 |
|--------|----------|
| 员工账号 | 网点业务系统账号，非 SaaS 用户账号 |
| 员工密码 | 敏感凭据，不应离开本机 |
| 本机窗口绑定 | 浏览器窗口与员工电脑强绑定 |
| 本地浏览器配置 | 浏览器路径、用户数据目录、会话保持 |
| 试运行模式 | 本机执行模式，非云端配置 |
| 本地运行配置 | 轮询间隔、心跳间隔、日志保留天数 |

### 8.3 Cloud 已管理或可展示

| 数据 | 说明 |
|------|------|
| 租户 | 已在 PostgreSQL tenants 表 |
| 站点 | 已在 PostgreSQL sites 表（只读同步） |
| 工作站 | 已在 PostgreSQL workstations 表 |
| 用户 | 已在 PostgreSQL users 表 |
| 任务 | 已在 PostgreSQL tasks 表 |
| 日志 | 已在 PostgreSQL task_logs 表 |
| 结果 | 已在 PostgreSQL waybill_results 表 |

### 8.4 未来迁移建议

| 配置项 | 建议 | 优先级 |
|--------|------|--------|
| 站点主数据 | 可逐步上云，PostgreSQL 作为真理源 | 中 |
| 员工账号密码 | 是否上云需谨慎评估安全风险 | 低 |
| 浏览器窗口绑定 | 应归 Agent 管理，不上云 | 不上云 |
| 试运行模式 | 可保留本地，Cloud 可展示状态 | 低 |
| 本地运行配置 | 归 Agent 管理，agent.json 替代部分 settings.json | 中 |

### 8.5 核心原则

- settings.json 不应一次性强迁移
- Agent 上线后，settings.json 的"执行相关配置"逐步迁移到 agent.json
- settings.json 的"业务配置"（网点、员工）可逐步上云
- 任何迁移不得破坏现有执行链路

---

## 9. EasyBR 删除专项

### 9.1 当前状态

- EasyBR 是 V2 遗留的浏览器执行管理模块
- V3 前端已隐藏所有 EasyBR 用户文案（Phase 3-D 完成）
- 后端代码中 EasyBR 引用暂保留，确保执行链路不中断
- 当前禁止删除 EasyBR（Phase 3 交接文档 §9）

### 9.2 删除时机

**EasyBR 删除应放在 Local Agent / Playwright 执行链路稳定后。**

前置条件：
1. Agent 已覆盖窗口状态检测（替代 EasyBR 的窗口状态管理）
2. Agent 已覆盖窗口启动（替代 EasyBR 的浏览器启动）
3. Agent 已覆盖任务执行（替代 EasyBR 的任务调度）
4. Agent 已覆盖日志回传（替代 EasyBR 的日志采集）
5. Agent 执行链路在生产环境稳定运行

### 9.3 删除内容清单

| 删除项 | 位置 |
|--------|------|
| EasyBRClient 类 | backend/browser/ |
| `/api/easybr/*` 路由 | backend/api/routes.ts |
| `legacy_easybr` 模式 | backend/browser/ 相关代码 |
| `easybr*` 字段命名 | settings.json、数据库、代码 |
| 用户可见旧文案 | 前端（已完成） |
| EasyBR 相关配置项 | settings.json |
| EasyBR 相关文档引用 | docs/ |

### 9.4 删除后验证

- Cloud 后端不再包含任何 EasyBR 引用
- 执行链路完全由 Agent 承担
- 前端无 EasyBR 文案（已验收通过）
- 构建通过，测试通过
- 生产环境 Agent 稳定运行

---

## 10. Phase 4 后续拆分建议

### 10.1 阶段规划

```
Phase 4-A：Local Agent 边界设计（当前阶段，仅文档）✅
Phase 4-B：Agent Token 与 workstation 鉴权设计
Phase 4-C：Agent API 协议设计
Phase 4-D：Local Agent 项目骨架设计
Phase 4-E：Agent 心跳与在线状态落地
Phase 4-F：任务拉取与结果回传最小闭环
```

### 10.2 各阶段说明

#### Phase 4-B：Agent Token 与 workstation 鉴权设计

- 设计 Agent Token 的生成、存储、验证、撤销、轮换机制
- 设计 workstation 注册与绑定流程
- 设计 `/agent/*` 路径的鉴权中间件
- 设计 Agent Principal 与 User Principal 的隔离
- 输出：Agent Token 鉴权设计文档 + 数据库 migration（workstations 表 agent_token_hash 字段）

#### Phase 4-C：Agent API 协议设计

- 设计 `/agent/heartbeat`、`/agent/tasks/pull`、`/agent/tasks/:id/progress`、`/agent/tasks/:id/logs`、`/agent/tasks/:id/complete`、`/agent/tasks/:id/fail`、`/agent/me` 接口
- 定义请求/响应格式
- 定义错误码与错误处理
- 输出：Agent API 协议文档 + 后端路由骨架

#### Phase 4-D：Local Agent 项目骨架设计

- 在 `packages/agent/` 下创建 Agent 项目骨架
- agent.json 配置模板
- 启动检查流程（连接云端、Token 验证、浏览器环境检测）
- 心跳与轮询主循环框架
- 输出：Agent 项目骨架代码 + 构建配置

#### Phase 4-E：Agent 心跳与在线状态落地

- 实现 Agent 心跳上报
- Cloud 端心跳接收与在线状态管理
- 离线判定与 workstation.online_status 更新
- 浏览器状态检测与上报
- 输出：心跳闭环可运行

#### Phase 4-F：任务拉取与结果回传最小闭环

- 实现 Agent 任务拉取
- Cloud 端任务原子分配
- Agent 本地执行（复用 Playwright 执行内核）
- 进度上报、日志回传、结果回传
- 端到端最小闭环：创建任务 → Agent 拉取 → 执行 → 回传 → 任务中心展示
- 输出：最小闭环可运行

### 10.3 后续阶段依赖关系

```
4-A（本文档）
  ↓
4-B（Agent Token 鉴权）  ← 必须先于 4-C
  ↓
4-C（Agent API 协议）    ← 必须先于 4-D
  ↓
4-D（Agent 项目骨架）    ← 必须先于 4-E
  ↓
4-E（心跳与在线状态）    ← 可并行于 4-F 的部分设计
  ↓
4-F（最小闭环）          ← 最终目标
```

---

## 11. 与现有文档的一致性

### 11.1 已确认的决策

| 决策编号 | 内容 | 本文档对齐情况 |
|----------|------|---------------|
| DECISION-001 | SQL migration 文件 + schema 版本表 | 不冲突，后续 Phase 4-B 新增 migration |
| DECISION-002 | 用户 JWT + Agent Token 分离 | 本文档 §5 明确确认 |
| DECISION-003 | Agent 放在 DaoPaiV3 仓库内 `packages/agent/` | 本文档 §10.2 Phase 4-D 确认 |
| DECISION-004 | 最小超级管理员后台 | 不冲突，workstation 创建纳入超级管理员后台 |
| DECISION-005 | 任务 payload 上限 2MB | 不冲突 |
| DECISION-006 | HTTP 轮询，不依赖 WebSocket | 本文档 §6 确认 |
| DECISION-007 | workstation 重复运行软检测 | 不冲突 |
| DECISION-008 | 任务超时回收保守策略 | 本文档 §7.4 确认 |
| DECISION-009 | 第一版不接对象存储 | 不冲突 |
| DECISION-010 | 生产域名和路径设计 | 不冲突，Agent API 使用 `/agent` 路径 |

### 11.2 与现有架构文档的关系

| 文档 | 本文档引用 |
|------|-----------|
| V3_ARCHITECTURE.md | Cloud + Agent 双层形态，本文档继承并细化 |
| V3_AGENT_DESIGN.md | Agent 定位、目录结构、启动检查，本文档继承并细化 |
| V3_CLOUD_PLATFORM.md | 设备绑定、任务中心，本文档继承并细化 |
| V3_DATA_MODEL.md | tenant/site/workstation 三元组，状态三维度，本文档继承 |
| V3_DECISIONS.md | 10 项冻结决策，本文档全部对齐 |

---

## 12. 本阶段禁止事项确认

本阶段（Phase 4-A）**仅设计，不开发**。以下事项已确认未执行：

- [x] 不写 Agent 代码
- [x] 不新增数据库 migration
- [x] 不新增接口实现
- [x] 不修改前端
- [x] 不修改 BrowserPool
- [x] 不修改 PlaywrightRuntime
- [x] 不修改 AssignmentEngine
- [x] 不删除 EasyBR
- [x] 不迁移 settings.json
- [x] 不触碰 V2