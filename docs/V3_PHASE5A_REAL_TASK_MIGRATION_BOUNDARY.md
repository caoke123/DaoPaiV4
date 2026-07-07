# DaoPai V3 Phase 5-A：真实任务迁移边界 + Arrival 优先迁移方案

> 版本：v1.0
> 日期：2026-06-30
> 阶段：Phase 5-A（边界设计，仅文档，不写代码）
> 前置 commit：`ea4d230` — docs: polish Phase 4 handoff
> 关联文档：V3_PHASE4_HANDOFF.md / V3_PHASE4_ACCEPTANCE_REPORT.md

---

## 1. Phase 5 总体目标

```
Phase 5 目标：将真实业务任务（到件/派件/签收/到派一体）逐步迁移到 Agent 执行。
每次只迁移一个业务类型，优先 DRY-RUN，再真实执行。
旧执行链路（BrowserPool + EasyBR）保留，Agent 链路稳定后再下线。
```

---

## 2. Cloud / Agent 职责边界

### Cloud 负责

```text
创建任务（POST /api/operations/arrive 等）
保存任务状态（PostgreSQL 主写）
展示任务中心（列表、详情、日志）
保存日志和结果（task_logs、waybill_results）
不直接操作浏览器
不读取本地浏览器状态
```

### Agent 负责

```text
拉取任务（POST /agent/tasks/pull）
读取本地 data/settings.json（获取网点/窗口/员工配置）
启动并管理本地浏览器（Playwright）
执行浏览器自动化（填运单、选快递员、提交）
上报 progress/logs/complete/fail
回传运单结果（waybill_results）
```

---

## 3. 为什么优先 Arrival 到件扫描

### 四个业务类型对比

| 维度 | Arrival 到件 | Dispatch 派件 | Sign 签收 | Integrated 到派一体 |
|------|-------------|--------------|----------|-------------------|
| Assignment 数量 | 通常 1 个 | 多个（每个快递员一个） | 1 个 | 多个 |
| 并发复杂度 | 低（单窗口） | 高（多窗口并发） | 中 | 高 |
| 员工/窗口依赖 | 自动选（方案B） | 需指定快递员 | 需指定签收人 | 需指定快递员 |
| Handler 代码量 | 最简（~40行） | 中等 | 中等 | 中等 |
| 页面操作步骤 | 5步 | 7步 | 6步 | 8步 |
| 迁移复杂度 | 低 | 中 | 中 | 高 |

### 结论

```text
优先 Arrival 到件扫描，原因：
1. 链路最单一：通常只有 1 个 Assignment，不需要多窗口并发
2. 无员工指定依赖：Arrival 使用方案B自动选择窗口，不需要指定快递员
3. Handler 最薄：ArrivalHandler 仅 40 行，直接委托 arriveExecute
4. 适合作为 Agent 化样板：先跑通 Arrival，后续 Dispatch/Integrated/Sign 可复用模式
5. DRY-RUN 验证成本最低：只需传入运单号列表，不需员工/快递员分配逻辑
```

---

## 4. Arrival Agent 化 payload 设计

### 4.1 任务类型命名约定

```text
后端旧接口名继续保留 /api/operations/arrive，不在 Phase 5 修改。
Agent 任务类型统一使用 arrival。
前端显示仍为"到件扫描"。

为避免与前端页面名称和后续任务类型混乱，Agent 任务 type 统一使用 arrival。
旧 Cloud 执行接口 /api/operations/arrive 保留，用于兼容现有执行链路。
```

### 4.2 Cloud 创建 Arrival 任务时的 payload

```json
{
  "type": "arrival",
  "siteId": "site-1782121346155",
  "siteName": "天南大",
  "dryRun": true,
  "payload": {
    "waybills": ["YD1234567890", "YD0987654321"],
    "options": {
      "batchSize": 200,
      "prevStation": "天津"
    }
  }
}
```

### 4.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| type | `"arrival"` | 是 | 任务类型 |
| siteId | string | 是 | 网点 ID（对应 settings.json sites[].id） |
| siteName | string | 否 | 网点名称（便于 Agent 日志显示） |
| dryRun | boolean | 是 | Phase 5-B 必须为 true |
| payload.waybills | string[] | 是 | 运单号列表 |
| payload.options.batchSize | number | 否 | 每批处理条数，默认 200 |
| payload.options.prevStation | string | 否 | 上一站名称，默认从 settings.json 读取 |

### 4.4 关键约束

```text
Phase 5-B 第一版：dryRun 必须为 true
不处理真实运单提交
不执行生产动作（最终确认按钮不点击）
Agent 端通过 dryRun 标志控制行为
```

---

## 5. settings.json 读取策略

### 5.1 当前状态

```text
settings.json 位于 data/settings.json，由 Cloud 端 SettingsManager 管理。
包含：网点列表、窗口配置、员工账号密码、dryRunMode 全局开关。
Agent 端当前不读取 settings.json。
```

### 5.2 Phase 5-B 策略

```text
方案：Phase 5-B 先实现 AgentSettingsLoader 最小读取

AgentSettingsLoader 只读取 Arrival 所需字段：
  - sites[].id → 匹配 siteId
  - sites[].name → 网点名称
  - runtime.dryRunMode → 全局试运行开关

不迁移 settings.json 到 Cloud
不把员工账号密码上传 Cloud
Agent 本机直接读取本地 settings.json 文件
```

### 5.3 settingsPath 配置

```text
AgentSettingsLoader 必须支持 settingsPath 配置，避免写死相对路径。

优先级（从高到低）：
  1. 环境变量 DAOPAI_SETTINGS_PATH
  2. agent.json 中 settingsPath 字段
  3. 默认路径：项目根目录 data/settings.json

agent.json 配置示例：
  {
    "settingsPath": "../../data/settings.json"
  }

环境变量覆盖：
  DAOPAI_SETTINGS_PATH=E:/网站开发/DaoPaiV3/data/settings.json

Agent 位于 packages/agent/ 子目录，默认相对路径需向上两级到项目根目录。
```

### 5.4 实现方式

```text
packages/agent/src/AgentSettingsLoader.ts
  - readSettingsFile(): 按 settingsPath 优先级读取并解析 settings.json
  - getSiteById(siteId): 根据 siteId 查找网点配置，校验 siteId 是否存在
  - getSiteName(siteId): 返回网点名称（用于日志显示）
  - getDryRunMode(): 读取全局试运行开关
  - 不复制 SettingsManager 全部代码，只实现最小所需

Phase 5-B 范围限制：
  - 不读取员工账号密码
  - 不读取浏览器窗口绑定（browserId）
  - 不启动浏览器
  - 只验证 arrival payload → Agent dryRun → progress/logs/complete → 任务中心展示

Phase 5-C 真实 Playwright 执行时再读取员工账号密码和窗口绑定。
```

### 5.5 后续演进

```text
Phase 6+：Agent 通过 Cloud API 获取配置（/agent/config）
Phase 6+：settings.json 逐步迁移到 Cloud 数据库
Phase 5-B 期间：保持本地文件读取，避免大重构
```

---

## 6. 现有 Arrival 执行链路分析

### 6.1 当前执行链路

```
POST /api/operations/arrive
  → routes.ts 校验参数
  → 创建 tasks 记录（PG 主写）
  → AssignmentEngine.execute()
    → SettingsManager.getDryRunMode()
    → BrowserPool.getStaffConnection() 或 WindowAdapterRegistry
    → WindowLockManager.acquire()
    → ArrivalHandler.executeWorker()
      → arriveExecute(page, waybillNos, onProgress, taskId, windowId, staffName, dryRunMode)
        → PageStateManager 检查页面状态
        → 填入 textarea
        → 选上一站
        → 查询 → 设 200/页 → 全选 → 批量到件
        → dryRun 控制是否点击最终提交
        → toast 判定结果
    → WindowLockManager.release()
    → 更新 tasks 状态
```

### 6.2 关键依赖分析

| 依赖 | 是否可迁移到 Agent | 说明 |
|------|-------------------|------|
| `arriveExecute(page, ...)` | 可复用 | 纯 Playwright 操作，不依赖 Cloud 单例 |
| `PageStateManager` | 可复用 | 页面状态检查，不依赖 Cloud |
| `PopupManager` | 可复用 | 弹窗管理，不依赖 Cloud |
| `PageNavigator` | 可复用 | 页面导航，不依赖 Cloud |
| `BrowserPool` | 不可复用 | Cloud 端窗口管理，Agent 需自己管理浏览器 |
| `WindowLockManager` | 不可复用 | Cloud 端锁机制，Agent 场景无意义 |
| `AssignmentEngine` | 不可复用 | Cloud 端任务编排，Agent 需独立实现 |
| `SettingsManager` | 不可复用 | Cloud 端配置管理，Agent 用 AgentSettingsLoader |
| `arrivalScanBatch.selectors` | 可复用 | 纯 CSS 选择器常量，可直接复制 |

### 6.3 复用策略

```text
不要直接搬迁 ArrivalHandler 到 Agent。

Phase 5-B 策略：
  1. Agent 实现 AgentArrivalExecutor（独立文件）
  2. Phase 5-B 先做 dryRun 模拟（不启动浏览器）
  3. Phase 5-C 接真实 Playwright 时，复用 arriveExecute 和 selectors
  4. Agent 不引入 BrowserPool / AssignmentEngine / WindowLockManager
  5. Agent 自行管理浏览器生命周期（启动、登录、关闭）
```

---

## 7. Phase 5-B 开发步骤

### 可直接编码的步骤

```text
步骤 1：后端放开 arrival 类型任务拉取
  文件：backend/db/PgDatabase.ts → pullPendingTask
  改动：将 type = 'agent_test' 改为 type IN ('agent_test', 'arrival')
  同时：agentRoutes.ts 无需修改（pull 接口已返回 type 字段）

  ⚠️ 风险提醒：编码前必须检查 tasks.type 是否存在 CHECK 约束。
  如果当前 tasks.type 只允许 agent_test 或旧类型，不允许 arrival，
  则需要新增幂等 migration 放开 arrival 类型。

  如需 migration，要求：
    - 只做最小幂等变更，不大改 tasks 表结构
    - 目标是允许 arrival 类型进入 Agent 任务管道
    - 不影响已有 agent_test
    - 不影响旧 /api/operations/arrive 执行链路

步骤 2：后端放开 arrival 类型任务创建（Agent 版）
  文件：backend/api/routes.ts
  改动：新增 POST /api/cloud/agent-arrival-task（类似 agent-test-task）
  payload 格式见第 4 节

步骤 3：Agent 支持 arrival 类型拉取
  文件：packages/agent/src/index.ts
  改动：task.type === 'arrival' 时走 executeArrivalDryRun()
  不再硬编码只处理 agent_test

步骤 4：Agent 实现 executeArrivalDryRun()
  文件：packages/agent/src/executors/ArrivalExecutor.ts（新增）
  逻辑：
    1. 读取 payload.waybills
    2. 读取 payload.options（batchSize, prevStation）
    3. 模拟运单处理（按 batchSize 分批）
    4. 每批上报 progress 和 logs
    5. 全部完成后 complete
    6. 不启动浏览器（dryRun 模式）

步骤 5：Agent 实现 AgentSettingsLoader
  文件：packages/agent/src/AgentSettingsLoader.ts（新增）
  逻辑：
    读取 data/settings.json
    提供 getSiteById / getWindowForSite / getDryRunMode

步骤 6：前端任务中心显示
  文件：frontend/src/pages/TasksPage.tsx
  改动：arrival 类型原已显示"到件扫描"，无需修改
  确认 agent-arrival-task 创建的任务能在任务中心正常显示

步骤 7：验证
  npm run build（backend + frontend + agent）
  手工验证：创建 arrival 任务 → Agent 拉取 → dryRun 执行 → complete
  确认不触发真实浏览器
```

### 禁止事项

```text
不接真实 Playwright 浏览器
不点击真实提交按钮
不处理真实运单数据
不修改 AssignmentEngine
不修改 BrowserPool
不修改 ArrivalHandler
不删除 EasyBR
不迁移 settings.json
```

---

## 8. 风险点

| 风险 | 级别 | 缓解措施 |
|------|------|----------|
| settings.json 路径不一致 | 中 | AgentSettingsLoader 使用相对路径，支持环境变量覆盖 |
| 运单号格式差异 | 低 | dryRun 阶段不提交，仅验证格式解析 |
| 后端 pullPendingTask 改动影响现有 agent_test | 低 | 使用 IN 子句兼容，agent_test 不受影响 |
| Agent 端代码膨胀 | 中 | Phase 5-B 只加 ArrivalExecutor，不引入大型依赖 |
| 与现有 /api/operations/arrive 冲突 | 低 | 新增独立接口 /api/cloud/agent-arrival-task，不修改旧接口 |

---

## 9. 相关文件清单

### 审计过的文件

```
backend/api/routes.ts                          # 现有 Arrival 任务创建路由
backend/modules/assignment-engine/AssignmentEngine.ts  # 任务执行引擎
backend/modules/assignment-engine/handlers/ArrivalHandler.ts  # 到件扫描 Handler
backend/modules/assignment-engine/handlers/DispatchHandler.ts # 派件扫描 Handler
backend/modules/assignment-engine/handlers/SignHandler.ts     # 签收录入 Handler
backend/modules/assignment-engine/handlers/IntegratedHandler.ts # 到派一体 Handler
backend/modules/assignment-engine/types.ts      # WorkerContext / TaskContext 类型
backend/operations/ArriveScanBatch.ts           # 到件扫描核心执行逻辑
backend/config/SettingsManager.ts               # 配置管理器
backend/agent/agentRoutes.ts                    # Agent API 路由
backend/db/PgDatabase.ts                        # 数据库方法（pullPendingTask 等）
data/settings.json                              # 网点/窗口/员工配置
packages/agent/src/index.ts                     # Agent 主入口
packages/agent/src/httpClient.ts                # Agent HTTP 客户端
```

### Phase 5-B 预计修改/新增

```
backend/db/PgDatabase.ts                        # pullPendingTask 放宽类型
backend/api/routes.ts                           # 新增 agent-arrival-task 接口
packages/agent/src/index.ts                     # 支持 arrival 类型
packages/agent/src/executors/ArrivalExecutor.ts # 新增：Arrival dryRun 执行器
packages/agent/src/AgentSettingsLoader.ts       # 新增：settings.json 最小读取器
```