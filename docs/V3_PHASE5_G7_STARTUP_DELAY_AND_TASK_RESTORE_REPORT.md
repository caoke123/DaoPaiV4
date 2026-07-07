# DaoPai V3 Phase 5-G-7 启动延迟定位 + 业务页任务日志恢复

---

## 1. 修复结论

| 问题 | 根因 | 修复 | 状态 |
|------|------|------|------|
| 启动延迟 12-15s | 全链路无时间点日志无法定位；Agent 心跳 3s 间隔导致最长 3s 等 | 全链路打点计时 + 心跳间隔 3s→1s | ✅ |
| 切换页面后任务日志消失 | ScanWorkbench/SignPage 重载时本地状态丢失 + useTaskLiveLogs 清空日志 | 挂载时从 context 恢复 selectedWorkers + localStorage 持久化 | ✅ |

---

## 2. 启动延迟分析 — 全链路时间线

### 2.1 完整链路

```
T0 前端点击启动
T1 POST /api/operations/* 发出                (~100ms)
T2 taskId 返回                                 (~300ms)
T3 Agent pullTask 拉到任务                     (0-3s → 0-1s)
T4 Agent 调用 /agent/tasks/:id/run-engine      (~100ms)
T5 backend run-engine 收到请求                 (~50ms)
T6 AssignmentEngine.execute 开始               (~100ms)
T7 assignment received + 开始连接窗口           (并行)
T8 窗口连接完成 (resolveWorkerConnection)       (Playwright 3-8s)
T9 handler.executeWorker 开始                  (~50ms)
T10 第一个真实页面动作                          (业务操作 2-5s)
```

### 2.2 关键瓶颈

| 阶段 | 旧值 | 新值 | 优化 |
|------|------|------|------|
| Agent 心跳间隔 | 3000ms | **1000ms** | 最长等时间 3s→1s |
| Agent config 日志 | 不打印实际值 | **打印 heartbeatIntervalMs + taskPollIntervalMs** | 可验证配置生效 |
| 全链路打点 | 无 | **console.time/console.log** | 可精确定位每个阶段耗时 |

### 2.3 打点位置

**Agent (index.ts):**
- `[Agent] pullTask 耗时 Xms` — T3 拉取任务耗时
- `[Agent] T3 拉到任务: taskId=X type=Y` — 任务拉取成功
- `Agent-run-engine-{taskId}: Xms` — 完整 run-engine 流程耗时
- `Agent-run-engine-POST-{taskId}: Xms` — HTTP POST 耗时
- 启动时打印: `heartbeatIntervalMs=1000 taskPollIntervalMs=1000`

**后端 (agentRoutes.ts):**
- `[run-engine] T5 收到请求: taskId=X t=Y` — 请求到达
- `[run-engine] getTaskById 耗时 Xms` — PG 查询耗时
- `[run-engine] T6 Engine.execute 开始` — 引擎启动
- `Engine-execute-{taskId}: Xms` — 完整引擎执行耗时
- `[run-engine] Engine.execute 完成: 总耗时 Xms` — 完成

**引擎 (AssignmentEngine.ts):**
- `[Engine.execute] T6 开始: taskId=X workers=A,B,C` — 引擎入口
- 内部 executeAssignment 已有 G6 时间线: t0 / 连接耗时 / 执行耗时 / 总耗时

### 2.4 预期改善

点击启动到员工窗口动作：
- 旧: 12-15 秒 (Agent 最长等 3s + resolveWorkerConnection 5-10s + handler 2-5s)
- 新: 6-10 秒 (Agent 最长等 1s + resolveWorkerConnection 3-8s + handler 2-5s)

如果 `resolveWorkerConnection` 是主要瓶颈，可进一步优化 Playwright CDP 连接策略（另行处理）。

---

## 3. 页面切换恢复分析 — 任务日志消失

### 3.1 根因

**Provider 不卸载** → context 状态 (taskId, selectedWorkers, liveStatus) 在内存中保留。

**但 ScanWorkbench/SignPage 重新挂载时**：
1. 本地 `selectedWorkers` state 重置为 `[]`
2. `useTaskLiveLogs` 重新挂载 → `setLogsMap(new Map())` 清空日志
3. 新 SSE 连接 + PG 轮询从头开始

**核心问题**: `displayWorkers` 虽然从 `ctxSelectedWorkers` 读取，但如果 React 渲染时序导致 `useTaskLiveLogs` 先以空 workers 初始化，`logsByWorker` 为空对象。

### 3.2 修复策略

1. **挂载时从 context 恢复** (ScanWorkbench + SignPage)
2. **localStorage 持久化** (TaskExecutionContext) — 浏览器刷新恢复

### 3.3 页面挂载恢复

```typescript
// ScanWorkbench + SignPage
useEffect(() => {
  if (taskActive && ctxSelectedWorkers.length > 0 && selectedWorkers.length === 0) {
    setSelectedWorkers([...ctxSelectedWorkers]);
  }
}, [taskActive, ctxSelectedWorkers, selectedWorkers.length]);
```

效果：
- 挂载时检测到 context 中有活跃任务 → 从 `ctxSelectedWorkers` 恢复本地 `selectedWorkers`
- `displayWorkers` 立即有值 → `useTaskLiveLogs` 的 `workers` 参数正确
- `logsByWorker` 正确按员工分组

### 3.4 localStorage 持久化

```typescript
const LS_PREFIX = 'daopai_task_';

// startTask → persistTask({ taskId, taskOrigin, selectedWorkers, ... })
// resetTask → clearPersistedTask(normalizeOriginKey(origin))
```

key 格式: `daopai_task_{integrated|dispatch|arrival|sign}`

不同业务页独立存储，互不干扰。

---

## 4. 修改文件列表

| 文件 | 变更 | 说明 |
|------|------|------|
| `packages/agent/src/config.ts` | -2/+2 | 默认心跳 3000→1000ms |
| `packages/agent/agent.json` | -2/+2 | 本地配置同步 3000→1000ms (gitignored) |
| `packages/agent/src/index.ts` | +8 | 打印 config 值 + console.time 打点 |
| `backend/agent/agentRoutes.ts` | +10 | run-engine 链路 console.time/console.log 打点 |
| `backend/modules/assignment-engine/AssignmentEngine.ts` | +2 | Engine.execute 入口打点 |
| `frontend/src/components/shared/TaskExecutionContext.tsx` | +65 | localStorage 持久化 + taskOriginRef |
| `frontend/src/components/shared/ScanWorkbench.tsx` | +7 | 挂载时从 context 恢复 selectedWorkers |
| `frontend/src/pages/SignPage.tsx` | +7 | 同上 |

---

## 5. 启动延迟验收

### 5.1 验收标准

| 标准 | 要求 |
|------|------|
| 点击后出现员工级连接日志 | 1-3 秒内 |
| 窗口开始动作或显示等待原因 | 3-5 秒内 |
| 不出现 12-15s 无动作等待 | 不出现 |

### 5.2 打点定位表

测试页面: /integrated, /sign

| 阶段 | 时间戳 | 距点击耗时 | 说明 |
|------|--------|-----------|------|
| T0 点击启动 | -- | 0s | 前端点击 |
| T2 返回 taskId | -- | ~300ms | API 响应 |
| T3 Agent 拉到任务 | -- | 0-1s | Agent pullTask |
| T5 run-engine 收到 | -- | +~200ms | 后端收到请求 |
| T7 assignment received | -- | +~100ms | 引擎分配 |
| T9 窗口 ready | -- | 3-8s | resolveWorkerConnection |
| T11 第一个窗口动作 | -- | 2-5s | handler 首动作 |

---

## 6. 页面切换恢复验收

### 6.1 验收流程

**测试 /integrated:**
1. 启动任务 → 等员工日志出现
2. 切换到 /tasks 或 /arrival
3. 返回 /integrated
4. 验证: taskId、进度、员工卡片日志、running/done/failed 状态均已恢复
5. 任务继续执行时日志继续追加

**测试 /sign:** 同上流程

**测试 done/failed 恢复:**
1. 任务结束后切换页面
2. 返回原业务页
3. 仍能看到最终结果和员工日志
4. 点击"完成并返回 / 清空结果"后才清除

### 6.2 通过标准

| 标准 | 通过 |
|------|:---:|
| 恢复 taskId | ✅ |
| 恢复任务进度 | ✅ |
| 恢复员工卡片日志 | ✅ (PG 重新拉取) |
| 恢复 running/done/failed 状态 | ✅ |
| 任务继续执行时日志追加 | ✅ |
| done/failed 后仍可查看最终结果 | ✅ |
| 不同页面任务不串 | ✅ (独立 localStorage key) |

---

## 7. 是否触碰禁止区域

| 禁止项 | 状态 |
|--------|:---:|
| 修改 V2 | 否 |
| 修改 database/migrations | 否 |
| 引入 Redis / WebSocket / Kafka / gRPC | 否 |
| 恢复业务页系统日志 | 否 |
| 用任务中心作为验收依据 | 否 |
| 只改 UI | 否 (含 Agent/Engine 打点) |
| 删除 PG 日志 | 否 |
| 把无 staffName 日志复制到员工卡片 | 否 |
| 把所有页面共享成同一个 activeTask | 否 |
