# DaoPai V3 Phase K-R1 Cloud Engine 归档隔离报告

> **阶段**：Phase K-R1 — Cloud Engine 归档隔离与 Agent 单执行链固化
> **日期**：2026-07-02
> **前置**：Phase K-R0 四业务 Agent 迁移真实性反审（已确认 Dispatch/Sign/Integrated 为假迁移，Cloud 引擎仍在执行）
> **目标**：把 Cloud 引擎从四业务主执行路径中归档隔离，防止后续 AI IDE 再次误用旧路径
> **核心原则**：先清路，再修路。先断掉 Cloud 执行，再恢复 Agent 执行。

---

## 1. 修改文件列表

| 文件路径 | 修改内容 |
|----------|----------|
| `backend/api/routes.ts` | 删除 `scheduleLocalEngineRun` 函数定义；删除 `TaskEngineRunner` / `isPlaywrightMode` import；删除 4 个 Handler import；四业务 route（arrive/dispatch/integrated/sign）删除 `AGENT_LOCAL_XXX` 分支和 `scheduleLocalEngineRun` 调用 |
| `backend/services/TaskEngineRunner.ts` | 完整重写：删除 4 个 Handler import；删除 `getEngineHandler` / `normalizeTaskAssignments` 死代码函数；删除 `AssignmentEngine.execute` 调用；新增 `AGENT_ONLY_BUSINESS_TYPES` 常量；新增 `assertNotAgentOnlyBusiness` 硬防护函数；`runTask` 入口 precheck 拒绝四业务 |
| `backend/modules/assignment-engine/index.ts` | 删除 4 个 Handler 的 export（ArrivalHandler/DispatchHandler/IntegratedHandler/SignHandler）；保留 `AssignmentEngine` / `InitWindowHandler` / 相关 type export |
| `tsconfig.json` | `exclude` 添加 `"backend/archive"`，归档目录不被 tsc 编译 |
| `package.json` | 新增 `check:no-cloud-engine` script |
| `scripts/check-no-cloud-engine.js` | 新增检查脚本（6 条规则） |

---

## 2. 归档文件列表

| 原位置 | 归档位置 | 说明 |
|--------|----------|------|
| `backend/modules/assignment-engine/handlers/ArrivalHandler.ts` | `backend/archive/cloud-engine/handlers/ArrivalHandler.ts` | 到件扫描业务处理器 |
| `backend/modules/assignment-engine/handlers/DispatchHandler.ts` | `backend/archive/cloud-engine/handlers/DispatchHandler.ts` | 派件扫描业务处理器 |
| `backend/modules/assignment-engine/handlers/IntegratedHandler.ts` | `backend/archive/cloud-engine/handlers/IntegratedHandler.ts` | 到派一体扫描业务处理器 |
| `backend/modules/assignment-engine/handlers/SignHandler.ts` | `backend/archive/cloud-engine/handlers/SignHandler.ts` | 签收录入业务处理器 |
| （新增） | `backend/archive/cloud-engine/README.md` | 归档目录说明文档 |

归档文件头部均添加 `Phase K-R1: ARCHIVED` 注释块，标明：
- 归档时间、归档原因、原位置
- 保留用途（历史代码参考、Agent Executor 实现对照）
- 严禁行为（主代码禁止 import、不被 tsc 编译、Cloud 引擎硬拒绝）

---

## 3. 删除或断开的 Cloud 执行入口列表

| 入口 | 处理方式 | 说明 |
|------|----------|------|
| `scheduleLocalEngineRun` 函数（routes.ts） | **删除** | 函数定义已删除，四业务 route 不再调用 |
| Arrival route `AGENT_LOCAL_ARRIVAL` 分支 | **删除** | 不再判断环境变量，只创建 pending task |
| Dispatch route `scheduleLocalEngineRun` 调用 | **删除** | 删除 K-2E-R2 直接调用 Cloud 引擎的逻辑 |
| Integrated route `AGENT_LOCAL_INTEGRATED` 分支 | **删除** | 不再判断环境变量，只创建 pending task |
| Sign route `AGENT_LOCAL_SIGN` 分支 | **删除** | 不再判断环境变量，只创建 pending task |
| `TaskEngineRunner.runTask` 四业务执行路径 | **断路** | precheck 硬拒绝四业务，不 claim task、不调 AssignmentEngine、不写 source='local-api' |
| `AssignmentEngine.execute` 从 TaskEngineRunner 调用 | **删除** | TaskEngineRunner 不再调用 AssignmentEngine.execute |
| 4 个 Handler 主代码 import | **删除** | index.ts 不再 export，routes.ts/TaskEngineRunner.ts 不再 import |

**保留但加防护的入口**：
| 入口 | 防护方式 | 说明 |
|------|----------|------|
| `/agent/tasks/:id/run-engine` 端点（agentRoutes.ts） | 409 + precheck 二次防护 | 四业务返回 HTTP 409 `TASK_TYPE_MIGRATED_TO_AGENT`；非四业务调用 `TaskEngineRunner.runTask` 时被 precheck 拦截（返回 skipped） |
| `AssignmentEngine` 模块 | 保留，但只用于非四业务 | init_window / cancel / stats / recoverRunningTasks 仍使用，不经 TaskEngineRunner |

---

## 4. 四业务 route Before / After 对比

### 4.1 POST /api/operations/arrive（到件扫描）

**Before**：
```typescript
if (process.env.AGENT_LOCAL_ARRIVAL === 'true') {
  console.log(`[AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true，arrival taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'arrival');
}
res.json({ taskId, status: 'pending' });
```

**After**：
```typescript
// Phase K-R1: arrival 只创建 pending task，等待 Local Agent pull 执行。
// 不再调用 scheduleLocalEngineRun；不再判断 AGENT_LOCAL_ARRIVAL。
// Cloud 引擎对 arrival 已被 TaskEngineRunner.assertNotAgentOnlyBusiness 硬拒绝。
res.json({ taskId, status: 'pending' });
```

### 4.2 POST /api/operations/dispatch（派件扫描）

**Before**：
```typescript
// Phase K-2E-R2: Dispatch uses the already-ready employee windows.
console.log(`[DispatchReadyWindow] dispatch taskId=${taskId} 直接使用准备态员工窗口执行`);
scheduleLocalEngineRun(req, taskId, 'dispatch');
res.json({ taskId, status: 'pending' });
```

**After**：
```typescript
// Phase K-R1: dispatch 只创建 pending task，等待 Local Agent pull 执行。
// 删除原 K-2E-R2 直接调用 Cloud 引擎的逻辑：
//   - 不再调用 scheduleLocalEngineRun
//   - 不再由 Cloud 引擎使用准备态员工窗口执行浏览器动作
// Cloud 引擎对 dispatch 已被 TaskEngineRunner.assertNotAgentOnlyBusiness 硬拒绝。
// Agent 不在线时任务保持 pending，绝不允许 Cloud fallback。
res.json({ taskId, status: 'pending' });
```

### 4.3 POST /api/operations/integrated（到派一体）

**Before**：
```typescript
if (process.env.AGENT_LOCAL_INTEGRATED === 'true') {
  console.log(`[AgentLocalIntegrated] AGENT_LOCAL_INTEGRATED=true，integrated taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'integrated');
}
res.json({ taskId, status: 'pending' });
```

**After**：
```typescript
// Phase K-R1: integrated 只创建 pending task，等待 Local Agent pull 执行。
// 不再调用 scheduleLocalEngineRun；不再判断 AGENT_LOCAL_INTEGRATED。
// Cloud 引擎对 integrated 已被 TaskEngineRunner.assertNotAgentOnlyBusiness 硬拒绝。
res.json({ taskId, status: 'pending' });
```

### 4.4 POST /api/operations/sign（签收录入）

**Before**：
```typescript
if (process.env.AGENT_LOCAL_SIGN === 'true') {
  console.log(`[AgentLocalSign] AGENT_LOCAL_SIGN=true，sign taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'sign');
}
res.json({ taskId, status: 'pending' });
```

**After**：
```typescript
// Phase K-R1: sign 只创建 pending task，等待 Local Agent pull 执行。
// 不再调用 scheduleLocalEngineRun；不再判断 AGENT_LOCAL_SIGN。
// Cloud 引擎对 sign 已被 TaskEngineRunner.assertNotAgentOnlyBusiness 硬拒绝。
res.json({ taskId, status: 'pending' });
```

---

## 5. TaskEngineRunner 防护说明

### 5.1 防护机制

`backend/services/TaskEngineRunner.ts` 新增两层硬防护：

**第一层：AGENT_ONLY_BUSINESS_TYPES 常量**
```typescript
const AGENT_ONLY_BUSINESS_TYPES = new Set(['arrival', 'arrive', 'dispatch', 'sign', 'integrated']);
```

**第二层：assertNotAgentOnlyBusiness 函数**
```typescript
function assertNotAgentOnlyBusiness(taskType: string): void {
  if (AGENT_ONLY_BUSINESS_TYPES.has(taskType)) {
    const err = new Error(
      `CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS: task type ${taskType} must be executed by Local Agent only`
    );
    (err as any).code = 'CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS';
    throw err;
  }
}
```

**runTask 入口 precheck**：
1. 先 `pg.getTaskById` 查询 task type
2. 调用 `assertNotAgentOnlyBusiness(precheck.type)`
3. 四业务 → throw `CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS` + 写拒绝日志
4. 非四业务 → 返回 `{ accepted: false, skipped: true, reason: 'Cloud 引擎不再执行业务' }`

### 5.2 防护保证

对四业务，TaskEngineRunner.runTask 保证：
- **不 claim task**（precheck 在 claimTaskForEngine 之前）
- **不调用 AssignmentEngine**（已删除 AssignmentEngine.execute 调用）
- **不写 source='local-api' 的业务执行日志**（已删除 taskLogService.appendLogs 业务日志写入，只写拒绝日志）
- **不执行任何浏览器动作**（已删除 4 个 Handler import）

### 5.3 错误码

```
CLOUD_ENGINE_FORBIDDEN_FOR_AGENT_BUSINESS: task type <type> must be executed by Local Agent only
```

---

## 6. archive 禁止引用机制说明

### 6.1 三层防护机制

**第一层：tsconfig.json exclude**
```json
"exclude": [
  "node_modules",
  "frontend",
  "dist",
  "scripts",
  "backend/archive"
]
```
归档目录下的 .ts 文件不会被 tsc 编译，避免类型错误传播。

**第二层：check:no-cloud-engine 脚本**
`scripts/check-no-cloud-engine.js`，通过 `npm run check:no-cloud-engine` 调用，6 条规则：

| 规则 | 检查内容 |
|------|----------|
| RULE_1_NO_ARCHIVE_IMPORT | 主代码禁止 `from '...archive'` 或 `require('...archive...')` |
| RULE_2_NO_SCHEDULE_LOCAL_ENGINE_RUN | 禁止调用 `scheduleLocalEngineRun(` |
| RULE_3_NO_TASK_ENGINE_RUNNER | 禁止调用 `TaskEngineRunner.runTask(`（agentRoutes.ts run-engine 端点除外，已有 409 保护） |
| RULE_4_NO_LOCAL_API_SOURCE | 禁止写 `source: 'local-api'`（TaskEngineRunner.ts 自身参数声明除外；类型声明 `source: 'local-api' \| 'agent-engine'` 除外） |
| RULE_5_NO_ARCHIVED_HANDLER_IMPORT | 禁止 import 已归档的 4 个 Handler |
| RULE_6_NO_AGENT_LOCAL_FALLBACK | 禁止使用 `process.env.AGENT_LOCAL_XXX` 做 Cloud fallback 判断 |

**第三层：归档文件头部注释**
每个归档 .ts 文件头部均有 `Phase K-R1: ARCHIVED` 注释块，标明严禁行为。

### 6.2 脚本扫描范围

扫描 `backend/` 下的主代码目录（不包括 `backend/archive`）：
- api / services / modules / operations / agent
- auth / browser / config / db / playwright-runtime
- runtime / utils / window-adapter

### 6.3 脚本例外

| 文件 | 例外规则 | 原因 |
|------|----------|------|
| `backend/agent/agentRoutes.ts` | RULE_3 例外 | run-engine 端点已有 409 保护，四业务被拦截；非四业务调用 TaskEngineRunner.runTask 会被 precheck 拦截 |
| `backend/services/TaskEngineRunner.ts` | RULE_4 例外 | 自身仍接受 source 参数（用于拒绝日志），但不再对四业务调用 |
| 类型声明行（含 `\|`） | RULE_4 例外 | `source: 'local-api' \| 'agent-engine'` 是联合类型声明，不是实际写入 |

---

## 7. grep / 搜索验证结果

### 7.1 `scheduleLocalEngineRun`

```
e:\网站开发\DaoPaiV3\backend\api\routes.ts:24:  // 注释
e:\网站开发\DaoPaiV3\backend\api\routes.ts:951:  // 注释
e:\网站开发\DaoPaiV3\backend\api\routes.ts:1066:  // 注释
e:\网站开发\DaoPaiV3\backend\api\routes.ts:1189:  // 注释
e:\网站开发\DaoPaiV3\backend\api\routes.ts:1314:  // 注释
e:\网站开发\DaoPaiV3\backend\api\routes.ts:1443:  // 注释
```
**结论**：6 处全部为注释，无调用代码。✅

### 7.2 `TaskEngineRunner.runTask`

```
e:\网站开发\DaoPaiV3\backend\agent\agentRoutes.ts:206:  const result = await TaskEngineRunner.runTask({
e:\网站开发\DaoPaiV3\backend\services\TaskEngineRunner.ts:10:  * 注释
```
**结论**：1 处调用（agentRoutes.ts run-engine 端点，已有 409 保护 + precheck 二次防护），1 处注释。✅

### 7.3 `source: 'local-api'`

```
e:\网站开发\DaoPaiV3\backend\db\PgDatabase.ts:281:  source: 'local-api' | 'agent-engine',
```
**结论**：1 处类型声明（联合类型），非实际写入。✅

### 7.4 `source='local-api'`

```
e:\网站开发\DaoPaiV3\backend\services\TaskEngineRunner.ts:18:  * 注释
```
**结论**：1 处注释，无实际写入。✅

### 7.5 `AssignmentEngine`

仍被以下位置合法使用（符合 K-R1 设计）：
- `backend/index.ts` — 启动 + recoverRunningTasks
- `backend/api/routes.ts` — import + init_window（L323）+ cancel（L1463）+ stats（L1970）+ recoverRunningTasks（L2309/2313）
- `backend/modules/assignment-engine/` — 自身定义
- 其他文件 — 注释中提及

**结论**：AssignmentEngine 保留用于非四业务（init_window / cancel / stats / recoverRunningTasks），符合 K-R1 设计。✅

### 7.6 `from '...archive'`

```
No matches found
```
**结论**：主代码未 import archive 目录。✅

### 7.7 `/archive/`

```
e:\网站开发\DaoPaiV3\backend\api\routes.ts:23:  // 注释
e:\网站开发\DaoPaiV3\backend\modules\assignment-engine\index.ts:5:  // 注释
```
**结论**：2 处注释，无 import 代码。✅

---

## 8. build / typecheck / check:no-cloud-engine 结果

### 8.1 `npm run build`（等价于 typecheck，项目无独立 typecheck 命令）

```
> bnsy-operator-next@1.0.0 build
> tsc
```
**退出码**：0
**结论**：TypeScript 编译通过，无错误。✅

### 8.2 `npm run check:no-cloud-engine`

```
[check:no-cloud-engine] Phase K-R1 Cloud Engine 归档隔离检查
[check:no-cloud-engine] 扫描根目录: backend
[check:no-cloud-engine] 扫描完成: 95 个 .ts 文件
[check:no-cloud-engine] ✅ 检查通过：未发现 Cloud 引擎回流风险
```
**退出码**：0
**结论**：6 条规则全部通过，95 个 .ts 文件无违规。✅

---

## 9. 当前仍保留的 Cloud 平台能力

Cloud 后端仍保留以下能力（与四业务浏览器执行无关）：

### 9.1 任务管理
- 任务创建（insertTask）— 四业务 route 只创建 pending task
- 任务查询（getTaskList、getTaskById）
- 任务日志查询
- 任务中心展示接口

### 9.2 Agent 协作
- Agent heartbeat / pull / complete / fail
- `/agent/window-connections`（CDP 端口暴露，K-3A 阶段一已完成）
- `/agent/tasks/:id/run-engine`（兼容路径，已有 409 + precheck 双重防护，实际不执行业务）

### 9.3 窗口管理
- 站点/员工/窗口配置读取
- 窗口状态查询（/api/status、/api/windows）
- 窗口初始化（POST /api/windows/init，由 AssignmentEngine + InitWindowHandler 直接执行）
- 窗口切换/清理/P0 检查

### 9.4 引擎能力（非四业务）
- `AssignmentEngine` 模块保留，用于：
  - init_window 任务（route 直接调用 AssignmentEngine.execute）
  - 任务 cancel（routes.ts L1463）
  - 任务 stats（routes.ts L1970）
  - recoverRunningTasks（routes.ts L2309/2313，index.ts L337）

### 9.5 数据库
- PostgreSQL 任务/日志/运单结果读写
- claimTaskForEngine / pullPendingTask（保留，TaskEngineRunner 仍接受 source 参数用于拒绝日志）

---

## 10. 后续 K-3A-2 Arrival READY 窗口接管前置条件是否满足

### 10.1 前置条件检查

| 前置条件 | 状态 | 说明 |
|----------|------|------|
| Cloud 引擎不再抢占 Arrival task | ✅ 满足 | routes.ts arrival route 删除 scheduleLocalEngineRun 调用；TaskEngineRunner precheck 硬拒绝 arrival |
| Agent 能 pull 到 Arrival task | ✅ 满足 | task 保持 pending 状态，Agent 通过 /agent/tasks/pull 拉取 |
| Backend CDP 端口暴露 | ✅ 满足 | K-3A 阶段一已完成（PlaywrightWindowState.cdpPort/cdpEndpoint/cdpAttachable + /agent/window-connections） |
| Agent 能查询 READY 窗口连接 | ✅ 满足 | GET /agent/window-connections 已实现（tenant 隔离） |
| Agent Executor 真实存在 | ✅ 满足 | packages/agent/src/index.ts 中 ArrivalExecutor 路由代码真实存在 |
| ENABLE_WINDOW_CDP_ENDPOINT=true | ✅ 满足 | .env 已配置 |
| TaskEngineRunner 不执行四业务 | ✅ 满足 | assertNotAgentOnlyBusiness 硬拒绝 |
| 主代码不 import archive | ✅ 满足 | check:no-cloud-engine 验证通过 |

### 10.2 K-3A-2 待实现内容（K-R1 之后）

- Agent 端实现 `BrowserManager.connectExisting`（通过 CDP 端点连接已存在的 READY 窗口）
- 修改 `ArrivalExecutor` 查询 `/agent/window-connections` 并复用 READY 窗口
- 添加保护日志：READY 窗口存在时禁止 new BrowserManager 新开 Chrome
- 完善 Arrival 日志：assignment receipt / window connection / reuse status / failure reason

### 10.3 结论

**K-R1 已满足 K-3A-2 的所有前置条件**。Cloud 引擎已从 Arrival 主执行路径中断路，Agent 可以安全 pull task 并接管 READY 窗口，无需担心 Cloud 引擎抢占或 fallback。

---

## 11. 验收标准核对

| 验收项 | 状态 | 说明 |
|--------|------|------|
| 1. routes.ts 四业务不再调用 scheduleLocalEngineRun | ✅ | 4 处调用全部删除，仅剩注释 |
| 2. Dispatch route 不再无条件调用 scheduleLocalEngineRun | ✅ | K-2E-R2 直接调用逻辑已删除 |
| 3. Sign / Integrated 不再通过 AGENT_LOCAL_XXX=false fallback 到 Cloud | ✅ | 整个 if/else 分支删除 |
| 4. 四业务提交后，backend 不会 setImmediate 调 TaskEngineRunner.runTask | ✅ | scheduleLocalEngineRun 函数已删除 |
| 5. TaskEngineRunner 无法执行 arrival / arrive / dispatch / sign / integrated | ✅ | assertNotAgentOnlyBusiness 硬拒绝 |
| 6. AssignmentEngine 不再从四业务 route 被调用 | ✅ | 四业务 route 不再调用 AssignmentEngine.execute |
| 7. task_logs 不再由 Cloud 引擎为四业务写入 source='local-api' 执行日志 | ✅ | TaskEngineRunner 不再写业务执行日志，只写拒绝日志 |
| 8. Agent 不在线时，任务保持 pending 或明确失败，不允许 Cloud 接管 | ✅ | task 保持 pending，Cloud 引擎 precheck 硬拒绝 |
| 9. archive / legacy 代码没有被主代码 import | ✅ | check:no-cloud-engine RULE_1 验证通过 |
| 10. TypeScript 编译通过 | ✅ | npm run build 退出码 0 |

**全部 10 项验收标准通过。**

---

## 12. 总结

Phase K-R1 完成 Cloud Engine 归档隔离与 Agent 单执行链固化：

1. **断路**：删除 scheduleLocalEngineRun 函数 + 四业务 route 删除 AGENT_LOCAL_XXX 分支 + TaskEngineRunner precheck 硬拒绝四业务
2. **归档**：4 个 Handler 移到 backend/archive/cloud-engine/handlers/，tsconfig exclude 排除归档目录
3. **防回流**：check:no-cloud-engine 脚本 6 条规则，npm script 可重复执行
4. **保留**：AssignmentEngine 模块保留用于非四业务（init_window / cancel / stats / recoverRunningTasks）

**核心原则达成**：
> 任务没有 Agent 执行，可以 pending / fail；
> 但绝不能由 Cloud Engine 执行。

后续路径：
- **K-3A-2**：Arrival Agent connectOverCDP 接管 READY 窗口（前置条件已满足）
- **K-3B**：Dispatch 真 Agent 迁移
- **K-3C**：Sign 真 Agent 迁移
- **K-3D**：Integrated 真 Agent 迁移
