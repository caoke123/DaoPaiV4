# DaoPai V3 Phase 5-G-7-3：启动延迟与任务恢复真实修复报告

日期：2026-07-01  
结论：两个主问题已按当前代码重新修复并做了真实验证；弹窗为模拟验证，未遇到业务站点真实 alert。

## 1. 本轮代码改动

### 启动延迟

- 新增 `backend/services/TaskEngineRunner.ts`
  - 抽出 `/agent/tasks/:id/run-engine` 的核心执行逻辑。
  - `runTask(taskId, tenantId, workstationId, source)` 统一处理 handler 选择、assignments 解析、员工日志、Engine 调用和 T5/T6 打点。
- `backend/db/PgDatabase.ts`
  - 新增 `claimTaskForEngine()` 原子认领。
  - `local-api` 只允许 claim `pending`。
  - `agent-engine` 只允许继续执行已 pull 的 `assigned`。
  - 非 pending/assigned 任务直接 skip，防止重复执行。
- `backend/api/routes.ts`
  - `/api/operations/arrive|dispatch|integrated|sign` 创建任务后，在 `WINDOW_RUNTIME_MODE=playwright` 下立即 `setImmediate` 调用 `TaskEngineRunner.runTask(..., 'local-api')`。
  - legacy 模式仍保留 Agent 拉取路径。
- `backend/agent/agentRoutes.ts`
  - `/agent/tasks/:id/run-engine` 改为复用 `TaskEngineRunner`。

### 页面恢复

- `frontend/src/components/shared/TaskExecutionContext.tsx`
  - localStorage 只保存 `{ taskId, taskType, taskOrigin, savedAt }`。
  - `restoreTask(origin)` 强制从 `GET /api/tasks/:id` 恢复 taskId/status/统计/assignments/workerProgress。
  - 同一 taskId 如 workers 尚未补齐，允许再次从后端恢复。
- `backend/api/routes.ts`
  - `GET /api/tasks/:id` 从 `inputData.assignments[].waybillNos.length` 恢复员工 count，修复恢复后员工进度 0 的问题。
- `frontend/src/hooks/useTaskLiveLogs.ts`
  - 保留同一 taskId 日志，挂载后立即拉 `GET /api/tasks/:id/logs?limit=500`。
  - 按 `staffName` 自动分组，不把无 staffName 的系统日志放入员工卡片。
- `ScanWorkbench.tsx` / `SignPage.tsx`
  - 页面挂载时按当前页面 origin 调用 `restoreTask`。
  - 避免 `activeSiteId` 初次赋值时误 `resetTask()` 清掉 localStorage。
  - 后端恢复完成后同步配置区本地 selectedWorkers，避免返回页面显示“已选 0”。

## 2. 启动延迟验证

环境：`WINDOW_RUNTIME_MODE=playwright`，前端 5176，后端 3300，dryRunMode=true。  
Agent 仍在运行，但本轮业务任务由 `local-api` 直接 claim，未等待 Agent。

### /sign API 实测（窗口冷启动）

taskId：`94d313c1-7868-45c3-ab6b-a89f8aa0a8af`

| 阶段 | 距任务创建耗时 | 说明 |
|---|---:|---|
| T2 返回 taskId | 17ms | API 提交耗时 |
| local-api 接管 | 10ms | `本机 API 已直接启动任务` |
| T6 Engine 开始 | 19ms | Engine 日志写入 |
| T7 assignment received | 20ms | 员工日志出现 |
| T9 窗口 ready | 5575ms | 冷启动/连接 Playwright 窗口，日志显示连接耗时 5551ms |
| T11 首个真实动作 | 5580ms | `开始执行业务操作...` |

判断：Agent 等待已消除；这次超过 5s 的部分来自冷启动窗口连接，不是 Agent 轮询。窗口预热后应按 integrated 实测结果计算。

### /integrated API 实测（窗口已 ready）

taskId：`6c602f01-8071-4349-aa45-b4ced23f3e0d`

| 阶段 | 距任务创建耗时 | 说明 |
|---|---:|---|
| T2 返回 taskId | 16ms | API 提交耗时 |
| local-api 接管 | 9ms | `本机 API 已直接启动任务` |
| T6/T7 | 17ms | Engine + assignment received |
| T9 窗口 ready | 23ms | 窗口连接耗时 2ms |
| T11 首个真实动作 | 26-31ms | `开始执行业务操作...` / 导航动作 |

通过：已不再出现 12-15 秒无动作等待。

### /sign UI 实测（窗口已 ready）

taskId：`e01478a8-d44e-4640-afe4-d03c563e9a72`

页面点击启动后 3.5 秒内，员工卡片已显示：

- `窗口连接已就绪，耗时 2ms`
- `开始执行业务操作...`
- `进入签收页面 [试运行模式]`
- 后续设置日期、选择派件员、搜索日志持续出现

## 3. 页面恢复验证

### UI 验证：/sign

running 中切换 `/sign -> /tasks -> /sign`：

- 执行面板恢复：通过。
- task 状态恢复：显示执行中。
- 统计恢复：总计 1，已完成 0，失败 0。
- 员工卡片恢复：肖飞卡片存在。
- 历史日志恢复：从 assignment received 到搜索日志均恢复。
- 未出现“等待员工窗口日志...”。

done/failed 后切换 `/sign -> /tasks -> /sign`：

- 状态恢复：任务失败。
- 统计恢复：已完成 1 / 总计 1 / 成功 0 / 失败 1。
- 员工卡片恢复：肖飞 1/1。
- 最终失败原因恢复：`签收完成: 成功0条, 失败1条` 以及搜索超时/截图日志可见。

### 四类任务 detail/logs 恢复接口核对

| 页面 | taskId | 状态 | 统计 | 员工 | 日志 | 最终原因 |
|---|---|---|---|---|---:|---|
| /arrival | `17a76f0b-46f5-463b-9109-f78a4ca98031` | failed | 3/3/3 | 肖飞 count=3 | 16 | 有 |
| /dispatch | `33cda7d7-3173-4842-b639-b810164ea6d6` | failed | 3/3/3 | 肖飞 count=3 | 34 | 有 |
| /integrated | `6c602f01-8071-4349-aa45-b4ced23f3e0d` | failed | 1/1/1 | 肖飞 count=1 | 41 | 有 |
| /sign | `e01478a8-d44e-4640-afe4-d03c563e9a72` | failed | 1/1/1 | 肖飞 count=1 | 38 | 有 |

未发现串任务：四类 `GET /api/tasks/:id` 返回 type 均匹配页面类型。

## 4. 弹窗验证

代码确认：

- `PlaywrightRuntime.launchWindow()` page 创建后注册 dialog handler。
- `ensureSingleBusinessPage()` 新 page 和保留 page 都会注册。
- `PopupManager` 用 `WeakSet<Page>` 防止重复注册。
- alert / confirm / prompt 默认 accept。

模拟验证：

- 使用 headless Playwright page 注册 `PopupManager.register(page, '模拟员工')`。
- 依次触发 alert、confirm、prompt。
- 结果：三类弹窗均自动关闭，总耗时 149ms，`isRegistered(page)=true`。

本轮未遇到真实业务站点 alert，仅完成代码路径验证/模拟验证，不能判定真实弹窗场景完全通过。当前弹窗日志能进入后端 console；尚未接入员工卡片 staffLog。

## 5. 验证命令

- `npm run build`
- `cd frontend && npm run build`
- `cd packages/agent && npm run build`
- API 启动链路实测：`POST /api/operations/sign`、`POST /api/operations/integrated`
- UI 恢复实测：`/sign -> /tasks -> /sign`
- 弹窗模拟：`PopupManager.register()` + alert/confirm/prompt

## 6. 仍需注意

- 如果员工 Playwright 窗口未启动，第一次任务仍可能花约 5-6 秒在窗口冷启动/连接；这不是 Agent 等待。
- 本轮 UI 真实恢复重点验证了 `/sign`；四类页面的后端 detail/logs 恢复数据已核对。建议人工再按四页各跑一次页面切换验收。
- 真实 BNSY alert 本轮未出现，不能写成真实场景完全通过。
