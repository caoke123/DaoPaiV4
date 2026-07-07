# DaoPai V3 Phase K-R0 四业务 Agent 迁移真实性反审报告

> Phase K-R0 | 2026-07-03
>
> 本报告为**纯事实反审**，不修改任何业务代码，不做 E2E，不切换执行路径。
> 目的：确认 Arrival / Dispatch / Sign / Integrated 四个业务到底是否真正走 Local Agent。

---

## 1. 反审背景

此前 Phase K-2A/B/C/D/E 验收报告认为四个业务已迁回 Agent 本地执行。但最新 K-3A 阶段一报告显示：

- Dispatch 在 routes.ts 中**无条件** `scheduleLocalEngineRun`
- Dispatch task 不会被 Agent pull（setImmediate 几乎立即把 pending → assigned）
- Dispatch 浏览器动作由 Backend PlaywrightRuntime 执行
- DispatchExecutor.ts 实际是死代码

如果属实，则 K-2B/K-2C 的"Dispatch 已迁 Agent"结论需要撤回。Sign/Integrated 也需要同样审查。Arrival 是唯一可能真正走 Agent 的业务，但 Agent 无法接管 Backend READY 窗口，会 new BrowserManager 新开 Chrome。

本次反审逐一核实四个业务的真实执行路径。

---

## 2. 审查范围

### 2.1 审查文件

| 文件 | 审查重点 |
|------|---------|
| `backend/api/routes.ts` | 4 个业务 route 是否判断 AGENT_LOCAL_XXX、是否调用 scheduleLocalEngineRun |
| `backend/services/TaskEngineRunner.ts` | Cloud 引擎入口、日志 source |
| `backend/db/PgDatabase.ts` | pullPendingTask 与 claimTaskForEngine 的状态流转 |
| `backend/agent/agentRoutes.ts` | run-engine 409 保护、pull 接口 |
| `packages/agent/src/index.ts` | Agent task type 路由到 Executor |
| `packages/agent/src/executors/*.ts` | 4 个 Executor 入口日志、source=agent 上传 |
| `packages/agent/src/logger/AgentLogger.ts` | Agent 日志上传机制 |
| `.env` | AGENT_LOCAL_XXX 实际值 |

### 2.2 严格限制（已遵守）

- ✅ 不修改业务代码
- ✅ 不做 E2E
- ✅ 不启用真实提交
- ✅ 不删除 run-engine
- ✅ 不恢复或切换执行路径
- ✅ 不改前端 UI
- ✅ 不重写 Agent
- ✅ 本阶段只输出事实报告

---

## 3. 四业务执行路径总表

| 业务 | route 创建 pending | 是否 scheduleLocalEngineRun | Agent 是否 pull 到 | 是否进入 Agent Executor | 日志 source | 浏览器动作来源 | 结论 |
|------|------|------|------|------|------|------|------|
| Arrival | ✅ (L1085) | ❌ 跳过（AGENT_LOCAL_ARRIVAL=true） | ✅ 能 pull 到 | ✅ ArrivalExecutor 真实执行 | `agent` | Agent 进程内（new BrowserManager 新开 Chrome） | **真 Agent 本地执行**（但窗口不复用） |
| Dispatch | ✅ (L1166) | ✅ **无条件**调用（L1215） | ❌ 永远 pull 不到 | ❌ DispatchExecutor 死代码 | `local-api` | Backend PlaywrightRuntime | **Cloud 引擎执行** |
| Sign | ✅ (L1430) | ✅ 调用（AGENT_LOCAL_SIGN 未设） | ❌ 永远 pull 不到 | ❌ SignExecutor 死代码 | `local-api` | Backend PlaywrightRuntime | **Cloud 引擎执行** |
| Integrated | ✅ (L1300) | ✅ 调用（AGENT_LOCAL_INTEGRATED 未设） | ❌ 永远 pull 不到 | ❌ IntegratedExecutor 死代码 | `local-api` | Backend PlaywrightRuntime | **Cloud 引擎执行** |

### 3.1 关键证据链

**.env 实际配置**：
```
AGENT_LOCAL_ARRIVAL=true       # L43 — Arrival 真跳过 scheduleLocalEngineRun
AGENT_LOCAL_DISPATCH=true      # L46 — 但 routes.ts 不判断此变量！无效配置
# AGENT_LOCAL_SIGN 未设置       # 默认 false → 走 else 分支 → scheduleLocalEngineRun
# AGENT_LOCAL_INTEGRATED 未设置 # 默认 false → 走 else 分支 → scheduleLocalEngineRun
```

**routes.ts 4 个业务的分支判断**：

| 业务 | 行号 | 代码 |
|------|------|------|
| Arrival | L1085-1089 | `if (AGENT_LOCAL_ARRIVAL === 'true') { 只创建任务 } else { scheduleLocalEngineRun }` |
| Dispatch | L1209-1215 | **无 if 判断**，注释 "Phase K-2E-R2: Dispatch uses the already-ready employee windows"，直接 `scheduleLocalEngineRun` |
| Integrated | L1336-1340 | `if (AGENT_LOCAL_INTEGRATED === 'true') { 只创建任务 } else { scheduleLocalEngineRun }` |
| Sign | L1467-1471 | `if (AGENT_LOCAL_SIGN === 'true') { 只创建任务 } else { scheduleLocalEngineRun }` |

**scheduleLocalEngineRun 实现**（routes.ts L952-974）：
```typescript
function scheduleLocalEngineRun(req, taskId, routeName): void {
  if (!isPlaywrightMode()) return;
  const tenantId = getTenantId(req);
  const workstationId = getWorkstationId(req);
  console.log(`[local-engine] schedule setImmediate: route=${routeName} taskId=${taskId}`);
  setImmediate(() => {
    TaskEngineRunner.runTask({
      taskId, tenantId, workstationId,
      source: 'local-api',
    }).catch(err => console.error(...));
  });
}
```

**setImmediate 竞态分析**：
- Agent 心跳间隔 = 1 秒（`packages/agent/src/config.ts` L17-18）
- `setImmediate` 在当前宏任务结束后立即执行（< 1ms）
- `TaskEngineRunner.runTask` → `claimTaskForEngine(source='local-api')` → pending → assigned
- Agent 下一次 tick（最多 1 秒后）调 `pullPendingTask`，但 task 已是 assigned，查不到
- 结论：**Agent 永远 pull 不到被 scheduleLocalEngineRun 抢占的 task**

---

## 4. Arrival 真实路径

### 4.1 完整执行链

```
前端 POST /api/operations/arrive
  ↓
routes.ts L982-1093（arrival route）
  ↓
pg.insertTask({ type: 'arrival', status: 'pending' })  ← L1075
  ↓
L1085: if (process.env.AGENT_LOCAL_ARRIVAL === 'true')  ← .env L43 = true
  ↓ 跳过 scheduleLocalEngineRun
res.json({ taskId, status: 'pending' })  ← L1092
  ↓
Agent tick（1 秒间隔）→ sendHeartbeat → hasTask=true → pullTask
  ↓
agentRoutes.ts L118: pg.pullPendingTask(tenantId, workstationId)
  ↓
PgDatabase.ts L1774-1830: SELECT ... WHERE status='pending' AND type IN ('arrival', ...) FOR UPDATE SKIP LOCKED
  ↓ 命中 arrival task，UPDATE status='assigned'
  ↓ 返回 task 给 Agent
  ↓
index.ts L255: if (task.type === 'arrival' || 'arrive')
  ↓
L260: await executeArrivalDryRun(task, client, settingsLoader, config)
  ↓
ArrivalExecutor.ts L184: export async function executeArrivalDryRun
  ↓
L195: const taskLogger = createAgentLogger(client, taskId)
  ↓
L212: taskLogger.info('[Agent][Arrival] 收到任务', { siteId })
  ↓
L338-356: manager = new BrowserManager(browserConfig); await manager.start(); await manager.connect(); page = await manager.openPage(loginUrl)
  ↓ 新开 Chrome + 重登（不复用 Backend READY 窗口）
  ↓
runArrivalBrowserDryRun(page, ...)  ← 浏览器动作发生在 Agent 进程内
  ↓
completeTask / failTask
```

### 4.2 关键事实

| 检查项 | 结果 |
|--------|------|
| route 是否判断 AGENT_LOCAL_ARRIVAL | ✅ L1085 判断 |
| AGENT_LOCAL_ARRIVAL 实际值 | ✅ `true`（.env L43） |
| 是否调用 scheduleLocalEngineRun | ❌ 跳过 |
| task 是否保持 pending 等待 Agent | ✅ 是 |
| Agent pullPendingTask 能否命中 | ✅ 能（type='arrival' 在白名单 L1796） |
| Agent index.ts 是否路由到 ArrivalExecutor | ✅ L255-263 |
| ArrivalExecutor 是否真实被调用 | ✅ 是 |
| ArrivalExecutor 入口日志 | ✅ L212 `taskLogger.info('[Agent][Arrival] 收到任务')` |
| 日志 source | ✅ `agent`（AgentLogger 经 agentRoutes.ts L290 强制 source='agent'） |
| 浏览器动作来源 | Agent 进程内（new BrowserManager 新开 Chrome） |
| 是否复用 Backend READY 窗口 | ❌ **不复用**（这是当前问题） |

### 4.3 当前问题

- ✅ Arrival **是**唯一真正进入 Agent Executor 的业务
- ❌ 但 ArrivalExecutor 通过 `new BrowserManager().start()` 新开 Chrome，不复用 Backend READY 窗口
- ❌ 这导致前端看到员工窗口 READY，但启动到件扫描后 Agent 又新开窗口 + 重登

### 4.4 结论

**Arrival = 真 Agent 本地执行**（但窗口复用机制缺失，需 K-3A-2 修复）

---

## 5. Dispatch 真实路径

### 5.1 完整执行链

```
前端 POST /api/operations/dispatch
  ↓
routes.ts L1096-1219（dispatch route）
  ↓
pg.insertTask({ type: 'dispatch', status: 'pending' })  ← L1169
  ↓
L1209-1215: 注释 "Phase K-2E-R2: Dispatch uses the already-ready employee windows"
            console.log(`[DispatchReadyWindow] dispatch taskId=${taskId} 直接使用准备态员工窗口执行`)
            scheduleLocalEngineRun(req, taskId, 'dispatch')  ← 无条件调用
  ↓
res.json({ taskId, status: 'pending' })  ← L1218
  ↓
setImmediate（< 1ms）→ TaskEngineRunner.runTask({ source: 'local-api' })
  ↓
TaskEngineRunner.ts L57: pg.claimTaskForEngine(tenantId, taskId, 'local-api', workstationId)
  ↓
PgDatabase.ts L278-327: UPDATE tasks SET status='assigned' WHERE status='pending' RETURNING ...
  ↓ 成功 claim（pending → assigned）
  ↓
TaskEngineRunner.ts L69: getEngineHandler('dispatch') → DispatchHandler
  ↓
L114: await AssignmentEngine.getInstance().execute({ taskType: 'dispatch', handler: DispatchHandler, ... })
  ↓
AssignmentEngine.resolvePlaywrightWorkerConnection → PlaywrightRuntime READY 窗口
  ↓
DispatchHandler 执行浏览器动作（在 Backend 进程内）
  ↓
taskLogService.appendLogs(..., { source: 'local-api' })  ← L106-110
```

### 5.2 关键事实

| 检查项 | 结果 |
|--------|------|
| route 是否判断 AGENT_LOCAL_DISPATCH | ❌ **无判断**（L1209-1215 无 if 分支） |
| AGENT_LOCAL_DISPATCH 实际值 | `true`（.env L46）但**无效** |
| 是否调用 scheduleLocalEngineRun | ✅ **无条件**调用（L1215） |
| task 是否保持 pending 等待 Agent | ❌ setImmediate 立即 claim 为 assigned |
| Agent pullPendingTask 能否命中 | ❌ 永远不能（type='dispatch' 在白名单，但 status 已变 assigned） |
| Agent index.ts 是否路由到 DispatchExecutor | ✅ L265-273 代码存在 |
| DispatchExecutor 是否真实被调用 | ❌ **死代码**（Agent pull 不到 task） |
| DispatchExecutor 入口日志 | L494 `taskLogger.info('[Agent][Dispatch] 收到任务')` 但**永不执行** |
| 日志 source | `local-api`（Cloud 引擎写入） |
| 浏览器动作来源 | Backend PlaywrightRuntime（Cloud 引擎） |
| 是否复用 READY 窗口 | ✅ 是（通过 AssignmentEngine.resolvePlaywrightWorkerConnection） |

### 5.3 代码注释证据

routes.ts L1209-1213 的注释明确说：

```
// Phase K-2E-R2: Dispatch uses the already-ready employee windows.
// Manual tests showed that waiting for the Agent leaves tasks pending when the
// Agent process is not polling. The operator workflow here is: windows are
// already logged in and on a clean home page, then the task should click the
// sidebar menu directly.
```

这说明 Dispatch 走 Cloud 引擎是**有意为之**，因为"等 Agent 会让 task 一直 pending"。

### 5.4 结论

**Dispatch = Cloud 引擎执行**（DispatchExecutor 是死代码）

---

## 6. Sign 真实路径

### 6.1 完整执行链

```
前端 POST /api/operations/sign
  ↓
routes.ts L1347-1475（sign route）
  ↓
pg.insertTask({ type: 'sign', status: 'pending' })
  ↓
L1467: if (process.env.AGENT_LOCAL_SIGN === 'true')  ← .env 未设置 → false
  ↓ 走 else 分支
L1470: scheduleLocalEngineRun(req, taskId, 'sign')
  ↓
setImmediate → TaskEngineRunner.runTask({ source: 'local-api' })
  ↓
claimTaskForEngine → pending → assigned
  ↓
getEngineHandler('sign') → SignHandler
  ↓
AssignmentEngine.execute → PlaywrightRuntime READY 窗口
  ↓
SignHandler 执行浏览器动作（在 Backend 进程内）
  ↓
日志 source = 'local-api'
```

### 6.2 关键事实

| 检查项 | 结果 |
|--------|------|
| route 是否判断 AGENT_LOCAL_SIGN | ✅ L1467 判断 |
| AGENT_LOCAL_SIGN 实际值 | ❌ **未设置**（.env 无此变量） → false |
| 是否调用 scheduleLocalEngineRun | ✅ 调用（else 分支 L1470） |
| task 是否保持 pending 等待 Agent | ❌ setImmediate 立即 claim 为 assigned |
| Agent pullPendingTask 能否命中 | ❌ 永远不能（status 已变 assigned） |
| Agent index.ts 是否路由到 SignExecutor | ✅ L275-283 代码存在 |
| SignExecutor 是否真实被调用 | ❌ **死代码**（Agent pull 不到 task） |
| SignExecutor 入口日志 | L495 但**永不执行** |
| 日志 source | `local-api`（Cloud 引擎写入） |
| 浏览器动作来源 | Backend PlaywrightRuntime（Cloud 引擎） |
| 是否复用 READY 窗口 | ✅ 是（通过 AssignmentEngine） |

### 6.3 结论

**Sign = Cloud 引擎执行**（SignExecutor 是死代码）

---

## 7. Integrated 真实路径

### 7.1 完整执行链

```
前端 POST /api/operations/integrated
  ↓
routes.ts L1222-1344（integrated route）
  ↓
pg.insertTask({ type: 'integrated', status: 'pending' })
  ↓
L1336: if (process.env.AGENT_LOCAL_INTEGRATED === 'true')  ← .env 未设置 → false
  ↓ 走 else 分支
L1339: scheduleLocalEngineRun(req, taskId, 'integrated')
  ↓
setImmediate → TaskEngineRunner.runTask({ source: 'local-api' })
  ↓
claimTaskForEngine → pending → assigned
  ↓
getEngineHandler('integrated') → IntegratedHandler
  ↓
AssignmentEngine.execute → PlaywrightRuntime READY 窗口
  ↓
IntegratedHandler 执行浏览器动作（在 Backend 进程内）
  ↓
日志 source = 'local-api'
```

### 7.2 关键事实

| 检查项 | 结果 |
|--------|------|
| route 是否判断 AGENT_LOCAL_INTEGRATED | ✅ L1336 判断 |
| AGENT_LOCAL_INTEGRATED 实际值 | ❌ **未设置**（.env 无此变量） → false |
| 是否调用 scheduleLocalEngineRun | ✅ 调用（else 分支 L1339） |
| task 是否保持 pending 等待 Agent | ❌ setImmediate 立即 claim 为 assigned |
| Agent pullPendingTask 能否命中 | ❌ 永远不能（status 已变 assigned） |
| Agent index.ts 是否路由到 IntegratedExecutor | ✅ L285-293 代码存在 |
| IntegratedExecutor 是否真实被调用 | ❌ **死代码**（Agent pull 不到 task） |
| IntegratedExecutor 入口日志 | L498 但**永不执行** |
| 日志 source | `local-api`（Cloud 引擎写入） |
| 浏览器动作来源 | Backend PlaywrightRuntime（Cloud 引擎） |
| 是否复用 READY 窗口 | ✅ 是（通过 AssignmentEngine） |

### 7.3 结论

**Integrated = Cloud 引擎执行**（IntegratedExecutor 是死代码）

---

## 8. run-engine 409 反审

### 8.1 run-engine 端点行为

`agentRoutes.ts` L157-222 的 `POST /agent/tasks/:id/run-engine` 端点对 4 个业务都返回 409：

```typescript
if (task.type === 'arrival' || task.type === 'arrive') {
  return res.status(409).json({ code: 'TASK_TYPE_MIGRATED_TO_AGENT', ... });
}
if (task.type === 'dispatch') {
  return res.status(409).json({ code: 'TASK_TYPE_MIGRATED_TO_AGENT', ... });
}
if (task.type === 'sign') {
  return res.status(409).json({ code: 'TASK_TYPE_MIGRATED_TO_AGENT', ... });
}
if (task.type === 'integrated') {
  return res.status(409).json({ code: 'TASK_TYPE_MIGRATED_TO_AGENT', ... });
}
```

### 8.2 为什么 409 不是迁移完成证明

**关键事实**：`scheduleLocalEngineRun` **不经过** `/agent/tasks/:id/run-engine` 端点。

`scheduleLocalEngineRun` 的实现是：

```typescript
function scheduleLocalEngineRun(req, taskId, routeName): void {
  if (!isPlaywrightMode()) return;
  setImmediate(() => {
    TaskEngineRunner.runTask({ taskId, tenantId, workstationId, source: 'local-api' });
  });
}
```

它直接调用 `TaskEngineRunner.runTask`（Backend 内部模块），**完全绕过** `/agent/tasks/:id/run-engine` HTTP 端点。

所以：
- `run-engine` 409 只是保护 HTTP 端点不被 Agent 调用
- `scheduleLocalEngineRun` 是 Backend 内部调用，不受 409 影响
- **409 与 scheduleLocalEngineRun 共存**，两者互不冲突

### 8.3 409 与 scheduleLocalEngineRun 共存情况

| 业务 | run-engine 返回 409 | route 是否调用 scheduleLocalEngineRun | 共存？ |
|------|---------------------|--------------------------------------|--------|
| Arrival | ✅ 409（L173-180） | ❌ 跳过（AGENT_LOCAL_ARRIVAL=true） | N/A（Arrival 真走 Agent） |
| Dispatch | ✅ 409（L181-188） | ✅ **无条件**调用（L1215） | ✅ **共存**（409 无效保护） |
| Sign | ✅ 409（L189-196） | ✅ 调用（else 分支 L1470） | ✅ **共存**（409 无效保护） |
| Integrated | ✅ 409（L197-204） | ✅ 调用（else 分支 L1339） | ✅ **共存**（409 无效保护） |

### 8.4 结论

**run-engine 409 只是 HTTP 端点保护，不是迁移完成证明**。Dispatch/Sign/Integrated 的 409 与 scheduleLocalEngineRun 共存，409 完全无效。

---

## 9. 此前 Phase K 验收有效性评估

### 9.1 逐项评估

| 阶段 | 业务 | 原验收结论 | 反审结论 | 有效性 |
|------|------|-----------|---------|--------|
| K-2A | Arrival | Arrival 迁回 Agent 本地执行 | ✅ 真 Agent 本地执行 | ✅ **有效** |
| K-2B | Dispatch | Dispatch 迁回 Agent 本地执行 | ❌ Cloud 引擎执行（DispatchExecutor 死代码） | ❌ **撤回** |
| K-2C | Dispatch 多员工 | 多 assignment 顺序执行，Agent 端 DispatchExecutor 支持 | ❌ DispatchExecutor 从未执行，多员工逻辑由 Cloud AssignmentEngine 完成 | ❌ **撤回**（验收的是 Cloud 引擎） |
| K-2D | Sign/Integrated | Sign/Integrated 迁回 Agent 本地执行 | ❌ Cloud 引擎执行（SignExecutor/IntegratedExecutor 死代码） | ❌ **撤回** |
| K-2E | Agent 运行时最小闭环 | 4 个 Executor 接入 AgentBusinessRuntime | ⚠️ 代码改造真实存在，但只有 ArrivalExecutor 实际运行；其他 3 个 Executor 从未被执行 | ⚠️ **部分有效**（代码改造有效，但执行验证无效） |

### 9.2 为什么 K-2B/K-2C/K-2D 验收会误判

可能原因：

1. **409 误读为迁移完成**：验收时看到 run-engine 返回 409 TASK_TYPE_MIGRATED_TO_AGENT，误以为 task 已不被 Cloud 执行。但实际 scheduleLocalEngineRun 绕过 run-engine 端点。

2. **日志 source 误读**：验收时可能看到 task 完成日志，但未仔细检查 source 字段。Cloud 引擎日志 source='local-api'，Agent 日志 source='agent'。如果只看任务完成未看 source，会误判。

3. **窗口复用误读为 Agent 执行**：Cloud 引擎通过 AssignmentEngine.resolvePlaywrightWorkerConnection 复用 PlaywrightRuntime READY 窗口，浏览器动作看起来"在员工窗口发生"，容易误判为 Agent 接管。但实际是 Backend 进程在操作。

4. **AGENT_LOCAL_DISPATCH 配置误读**：.env 中 `AGENT_LOCAL_DISPATCH=true` 让人以为 Dispatch 走 Agent，但 routes.ts 根本不判断此变量。

### 9.3 仍有效的结论

- ✅ K-2A Arrival 迁移真实有效
- ✅ K-2E 4 个 Executor 的代码改造真实存在（AgentBusinessRuntime 接入、菜单优先导航、原生 alert guard 等）
- ✅ K-3A-1 Backend CDP 端口暴露基础设施已完成并验证

### 9.4 需撤回的结论

- ❌ K-2B "Dispatch 已迁回 Agent 本地执行"
- ❌ K-2C "Dispatch 多 assignment 在 Agent 端顺序执行"
- ❌ K-2D "Sign/Integrated 已迁回 Agent 本地执行"

---

## 10. 后续修复路线建议

### 10.1 建议顺序

| 阶段 | 业务 | 修复内容 | 验证标准 |
|------|------|---------|---------|
| K-3A-2 | Arrival | Agent BrowserManager.connectExisting + ArrivalExecutor 复用 READY 窗口 | source=agent + ArrivalExecutor 入口日志 + 无 scheduleLocalEngineRun + 复用 READY 窗口 |
| K-3B | Dispatch | routes.ts L1209-1215 改成判断 AGENT_LOCAL_DISPATCH，true 时跳过 scheduleLocalEngineRun | source=agent + DispatchExecutor 入口日志 + 无 scheduleLocalEngineRun |
| K-3C | Sign | .env 加 AGENT_LOCAL_SIGN=true（route 已有判断） | source=agent + SignExecutor 入口日志 + 无 scheduleLocalEngineRun |
| K-3D | Integrated | .env 加 AGENT_LOCAL_INTEGRATED=true（route 已有判断） | source=agent + IntegratedExecutor 入口日志 + 无 scheduleLocalEngineRun |

### 10.2 每个业务迁移完成的硬性证明

每个业务迁到 Agent 后，必须同时满足：

1. ✅ 日志 source='agent'（不是 'local-api'）
2. ✅ Agent Executor 入口日志出现（如 `[Agent][Dispatch] 收到任务`）
3. ✅ backend 日志无 `[local-engine] schedule setImmediate: route=<业务>` 该 task 的记录
4. ✅ Agent 进程日志有 `[Agent] T3 拉到任务: taskId=xxx type=<业务>`
5. ✅ 浏览器动作发生在 Agent 进程内（通过 CDP 接管 READY 窗口，不是新开 Chrome）

### 10.3 优先级建议

1. **K-3A-2（Arrival 窗口复用）**：解决当前用户报告的"Arrival 新开窗口"问题
2. **K-3B（Dispatch 真 Agent）**：撤回 K-2B/K-2C 误判，让 DispatchExecutor 真实执行
3. **K-3C（Sign 真 Agent）**：撤回 K-2D 误判，让 SignExecutor 真实执行
4. **K-3D（Integrated 真 Agent）**：撤回 K-2D 误判，让 IntegratedExecutor 真实执行

---

## 11. 结论

### 11.1 当前哪些业务是真 Agent？

| 业务 | 真实状态 |
|------|---------|
| Arrival | ✅ **真 Agent**（但窗口不复用，需 K-3A-2 修复） |
| Dispatch | ❌ **假迁移**（Cloud 引擎执行，DispatchExecutor 死代码） |
| Sign | ❌ **假迁移**（Cloud 引擎执行，SignExecutor 死代码） |
| Integrated | ❌ **假迁移**（Cloud 引擎执行，IntegratedExecutor 死代码） |

### 11.2 哪些业务是假迁移？

**Dispatch / Sign / Integrated 三个业务都是假迁移**：

- Agent 代码层面支持（Executor 真实存在，index.ts 路由正确）
- 但 Backend route 通过 scheduleLocalEngineRun 抢占 task，Agent 永远 pull 不到
- 三个 Executor 从未被执行，是死代码
- 浏览器动作由 Backend PlaywrightRuntime 完成，日志 source='local-api'

### 11.3 假迁移的根因

| 业务 | 根因 |
|------|------|
| Dispatch | routes.ts L1209-1215 **不判断** AGENT_LOCAL_DISPATCH，无条件 scheduleLocalEngineRun |
| Sign | .env **未设置** AGENT_LOCAL_SIGN（route 有判断但变量未设） |
| Integrated | .env **未设置** AGENT_LOCAL_INTEGRATED（route 有判断但变量未设） |

### 11.4 下一步先修哪个？

**优先修复 K-3A-2（Arrival 窗口复用）**：

- Arrival 是唯一真 Agent 业务，但当前新开 Chrome 不复用 READY 窗口
- 这是用户原始报告的核心问题
- K-3A-1 已为 CDP 接管铺平道路（Backend 暴露 CDP endpoint + /agent/window-connections 接口）
- K-3A-2 只需：Agent BrowserManager.connectExisting + ArrivalExecutor 改造

**然后依次修复 K-3B/C/D**：

- K-3B Dispatch：routes.ts L1209-1215 加 AGENT_LOCAL_DISPATCH 判断
- K-3C Sign：.env 加 AGENT_LOCAL_SIGN=true
- K-3D Integrated：.env 加 AGENT_LOCAL_INTEGRATED=true
- 每个业务迁移后必须用 source=agent + Executor 入口日志 + 无 scheduleLocalEngineRun 证明

### 11.5 特别回答用户 8 个问题

1. **Arrival 是否是唯一真正进入 Agent Executor 的业务？**
   ✅ 是。AGENT_LOCAL_ARRIVAL=true 让 task 保持 pending，Agent pull 到后真实调用 ArrivalExecutor。

2. **DispatchExecutor 是否确实是死代码？**
   ✅ 是。routes.ts L1215 无条件 scheduleLocalEngineRun，setImmediate 立即把 task 从 pending → assigned，Agent pullPendingTask 查不到。

3. **SignExecutor 是否确实是死代码？**
   ✅ 是。.env 未设 AGENT_LOCAL_SIGN，走 else 分支 scheduleLocalEngineRun，同 Dispatch。

4. **IntegratedExecutor 是否确实是死代码？**
   ✅ 是。.env 未设 AGENT_LOCAL_INTEGRATED，走 else 分支 scheduleLocalEngineRun，同 Dispatch。

5. **AGENT_LOCAL_DISPATCH / SIGN / INTEGRATED 环境变量是否实际被 route 使用？**
   - AGENT_LOCAL_DISPATCH：❌ **routes.ts 不判断此变量**（即使 .env 设了 true 也无效）
   - AGENT_LOCAL_SIGN：✅ routes.ts L1467 判断，但 .env **未设置** → false
   - AGENT_LOCAL_INTEGRATED：✅ routes.ts L1336 判断，但 .env **未设置** → false

6. **run-engine 409 是否只是保护接口，而不是执行路径证明？**
   ✅ 是。scheduleLocalEngineRun 绕过 run-engine HTTP 端点，直接内部调用 TaskEngineRunner.runTask。409 与 scheduleLocalEngineRun 共存，409 完全无效。

7. **此前 K-2B/K-2C/K-2D 的验收是否可能实际验收了 Cloud 引擎？**
   ✅ 极可能。Cloud 引擎复用 PlaywrightRuntime READY 窗口，浏览器动作看起来"在员工窗口发生"，容易误判为 Agent 接管。但日志 source='local-api'（不是 'agent'），Agent Executor 入口日志从未出现。

8. **四业务真正迁到 Agent 还缺哪些步骤？**
   - Arrival：缺 K-3A-2（Agent CDP 接管 READY 窗口）
   - Dispatch：缺 K-3B（routes.ts 加 AGENT_LOCAL_DISPATCH 判断 + Agent CDP 接管）
   - Sign：缺 K-3C（.env 加 AGENT_LOCAL_SIGN=true + Agent CDP 接管）
   - Integrated：缺 K-3D（.env 加 AGENT_LOCAL_INTEGRATED=true + Agent CDP 接管）
   - 每个业务都需要：source=agent + Executor 入口日志 + 无 scheduleLocalEngineRun 证明

---

## 附录 A：审查文件清单

| 文件 | 审查范围 |
|------|---------|
| `backend/api/routes.ts` L952-974, L1085-1089, L1209-1215, L1336-1340, L1467-1471 | scheduleLocalEngineRun + 4 业务 route 分支 |
| `backend/services/TaskEngineRunner.ts` L46-127 | runTask 实现 + 日志 source |
| `backend/db/PgDatabase.ts` L278-327, L1774-1830 | claimTaskForEngine + pullPendingTask 状态流转 |
| `backend/agent/agentRoutes.ts` L118-155, L157-222 | pull task + run-engine 409 |
| `packages/agent/src/index.ts` L248-300 | task type 路由到 Executor |
| `packages/agent/src/executors/ArrivalExecutor.ts` L184-213 | 入口日志 |
| `packages/agent/src/executors/DispatchExecutor.ts` L480-496 | 入口日志（死代码） |
| `packages/agent/src/executors/SignExecutor.ts` L484-495 | 入口日志（死代码） |
| `packages/agent/src/executors/IntegratedExecutor.ts` L486-498 | 入口日志（死代码） |
| `packages/agent/src/logger/AgentLogger.ts` L1-115 | Agent 日志上传机制（source='agent'） |
| `packages/agent/src/config.ts` L17-18 | 心跳/轮询间隔（1 秒） |
| `.env` L43-46 | AGENT_LOCAL_ARRIVAL=true, AGENT_LOCAL_DISPATCH=true |

## 附录 B：关键代码证据

### B.1 Arrival route 分支（routes.ts L1085-1089）

```typescript
if (process.env.AGENT_LOCAL_ARRIVAL === 'true') {
  console.log(`[AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true，arrival taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'arrival');
}
```

### B.2 Dispatch route 无分支（routes.ts L1209-1215）

```typescript
// Phase K-2E-R2: Dispatch uses the already-ready employee windows.
// Manual tests showed that waiting for the Agent leaves tasks pending when the
// Agent process is not polling.
console.log(`[DispatchReadyWindow] dispatch taskId=${taskId} 直接使用准备态员工窗口执行`);
scheduleLocalEngineRun(req, taskId, 'dispatch');  // ← 无 if 判断
```

### B.3 Sign route 分支（routes.ts L1467-1471）

```typescript
if (process.env.AGENT_LOCAL_SIGN === 'true') {  // ← .env 未设置 → false
  console.log(`[AgentLocalSign] AGENT_LOCAL_SIGN=true，sign taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'sign');  // ← 走这里
}
```

### B.4 Integrated route 分支（routes.ts L1336-1340）

```typescript
if (process.env.AGENT_LOCAL_INTEGRATED === 'true') {  // ← .env 未设置 → false
  console.log(`[AgentLocalIntegrated] AGENT_LOCAL_INTEGRATED=true，integrated taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'integrated');  // ← 走这里
}
```

### B.5 scheduleLocalEngineRun 绕过 run-engine（routes.ts L952-974）

```typescript
function scheduleLocalEngineRun(req, taskId, routeName): void {
  if (!isPlaywrightMode()) return;
  setImmediate(() => {
    TaskEngineRunner.runTask({  // ← 直接内部调用，不经 HTTP 端点
      taskId, tenantId, workstationId,
      source: 'local-api',
    }).catch(...);
  });
}
```

### B.6 Agent pullPendingTask 状态过滤（PgDatabase.ts L1791-1799）

```sql
SELECT id, type, site_id, status, total_count, input_data, created_at
FROM tasks
WHERE tenant_id = $1
  AND status = 'pending'              -- ← 只查 pending
  AND type IN ('agent_test', 'arrival', 'dispatch', 'integrated', 'sign')
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
```

被 scheduleLocalEngineRun 抢占的 task 状态为 assigned，此查询查不到。

### B.7 claimTaskForEngine 状态流转（PgDatabase.ts L296-308）

```typescript
const allowedStatus = source === 'agent-engine' ? 'assigned' : 'pending';
// source='local-api' → allowedStatus='pending' → 把 pending → assigned
const result = await this.pool.query(
  `UPDATE tasks SET status = 'assigned' WHERE id = $1 AND tenant_id = $2 AND status = $3 RETURNING ...`,
  [taskId, tenantId, allowedStatus, workstationId],
);
```
