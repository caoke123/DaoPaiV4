# DaoPai V3 业务执行页面实时日志修复报告

> 日期：2026-07-01
> 执行人：Codex
> 验收页面：`/integrated`、`/arrival`、`/dispatch`、`/sign`

## 1. 是否复现人工截图问题

复现了同类断点：业务页进入执行态时，日志区域依赖当前页面的 `taskId`、`taskActive` 和日志数据源绑定；在修复前，若 PG task 日志为空、Agent 尚未拉取、或前端未正确启用 hook，页面会只显示占位日志 `任务启动中...`。

本机首次打开 `/integrated` 时还发现一个环境前置状态：所有执行窗口离线，启动按钮禁用。通过页面“启动 Chrome”后，4 个窗口变为 READY，随后按真实业务页路径完成验证。

## 2. 根因定位

根因不是任务中心，也不是 Agent 控制台，而是业务页日志绑定链路不够稳：

- `ScanWorkbench` / `SignPage` 的日志 hook 只在较窄的 `liveStatus` 条件下启用，缺少“只要当前页面持有 taskId 就立即拉日志”的稳定性。
- `submitTask` 只信任 `resp.taskId`，没有兼容 `resp.id`，也没有在缺失 taskId 时阻止进入执行态。
- `useTaskLiveLogs` 只读 PG `/api/tasks/:id/logs`，对 legacy `/api/operations/:id/logs` 没有兜底，PG/legacy 双链路过渡期容易出现页面空白。
- 业务提交路由创建 PG task 后只写旧内存 `taskLogManager`，没有同步写 PG task_logs；Agent 下一轮心跳前，业务页可能只能看到占位。
- Agent 端源码存在两个可靠性问题：`payload.assignments` 兼容代码未同步类型导致 Agent 子包 build 失败；`AgentLogger.close()` 先置 `closed=true` 再 flush，导致 close 阶段剩余日志可能无法刷出。

断点分类：

| 分类 | 结论 |
|---|---|
| taskId 获取 | 已修复：`submitTask` 统一归一化 `taskId || id`，缺失则报错 |
| taskOrigin 判断 | 未发现字符串不一致；保留 `submitApi` origin |
| useTaskLiveLogs enabled | 已修复：当前页持有 taskId 且非 idle 即启用 |
| API 数据源 | 已修复：PG 优先，legacy logs 兜底 |
| PG/legacy mismatch | 已确认存在：PG status/logs 与 operations mirror 状态可能不同 |
| 页面渲染 | 已确认使用 `globalLogs` / `logsByWorker`；修复后页面显示 hook 返回日志 |

## 3. 修改文件列表

| 文件 | 修改说明 |
|---|---|
| `frontend/src/api/client.ts` | `TaskSubmitResponse` 兼容 `id`；`submitTask` 统一返回真实 `taskId`，缺失时报错 |
| `frontend/src/hooks/useTaskLiveLogs.ts` | PG logs 为空或失败时读取 legacy operations logs 兜底；final fetch 同样兜底 |
| `frontend/src/components/shared/ScanWorkbench.tsx` | `taskActive` 放宽为当前页 taskId 非 idle 即启用；提交后校验 taskId |
| `frontend/src/pages/SignPage.tsx` | 同步 `taskActive` 和 taskId 校验；提交签收任务时传递 `dryRunMode` |
| `backend/api/routes.ts` | 到件/派件/到派一体/签收创建任务后，通过 `TaskLogService` 写入 PG 起始日志并广播 |
| `backend/auth/authMiddleware.ts` | 防御 `req.path` 缺失，避免 mock/边缘请求崩溃 |
| `packages/agent/src/logger/AgentLogger.ts` | 修复 `close()` 不 flush 剩余日志的问题 |
| `packages/agent/src/httpClient.ts` | `uploadLogs` 类型补充 `staffName` |
| `packages/agent/src/executors/*.ts` | 兼容 `assignments[].waybillNos`；失败已上报后不再向外抛出导致重复 `failTask` |

## 4. `/integrated` 业务页验收

人工路径：

1. 打开 `http://localhost:5176/integrated`
2. 点击“测试数据”
3. 点击“全选在线”
4. 点击“启动 · 4 窗口并发 · 50 条运单”
5. 不进入任务中心，只观察当前业务页日志区域

页面 taskId：`ca24985b-f445-46bd-921c-f334411041e2`

后端接口核验：

| 接口 | 结果 |
|---|---|
| `/api/tasks/:id/status` | `failed`, total=50, done=0 |
| `/api/tasks/:id/logs?limit=500` | 16 条 |
| `/api/operations/:id` | legacy mirror 仍为 `pending` |
| `/api/operations/:id/logs` | 1 条旧内存日志 |

验收表：

| 时间点 | 页面路径 | 页面 taskId | PG status | operations | API 日志条数 | 页面任务总日志条数 | 员工日志条数 | 是否仍只有占位 |
|---|---|---|---|---|---:|---:|---:|---|
| T+0s | `/integrated` | `ca24985b...` | pending/running | pending | 1 | 1 | 0 | 否 |
| T+2s | `/integrated` | 同上 | running | pending | 11 | 11 | 0 | 否 |
| T+4s | `/integrated` | 同上 | failed | pending | 16 | 16 | 0 | 否 |
| T+8s | `/integrated` | 同上 | failed | pending | 16 | 16 | 0 | 否 |
| T+done | `/integrated` | 同上 | failed | pending | 16 | 16 | 0 | 否 |

说明：任务最终失败原因为本地配置无法读取员工凭据，但失败原因和执行过程日志均显示在 `/integrated` 当前页面的“任务总日志”中。这正是本次修复目标：业务人员能看到真实日志和失败原因，而不是认为系统卡死。

## 5. 回归结果

| 页面 | 操作 | 页面日志结果 | 是否依赖任务中心 | 是否仍只有占位 |
|---|---|---|---|---|
| `/arrival` | 测试数据 + 全选在线 + 启动 | T+0/T+4 显示 `任务开始: 到件扫描...`，任务总日志 1 条 | 没有 | 否 |
| `/dispatch` | 测试数据 + 全选在线 + 启动 | T+0/T+4 显示 `任务开始: 派件扫描...`，任务总日志 1 条 | 没有 | 否 |
| `/sign` | 全选在线 + 启动 | T+0/T+4 显示 `任务开始: 签收录入...` 和 `SIGN_DRY_RUN...`，任务总日志 2 条 | 没有 | 否 |

## 6. 验证命令

通过：

```bash
npm run build
cd frontend && npm run build
cd packages/agent && npm run build
npx vitest run backend/auth/__tests__/authMiddleware.test.ts
```

全量测试：

```bash
npm test
```

结果：128 passed / 4 failed。剩余 4 个失败均为 credentials fallback 既有问题：

- `backend/config/__tests__/resolveWorkerCredential.test.ts` T3
- `backend/browser/__tests__/loginCredential.test.ts` C2b / C4 / C5

本次未修改 credentials fallback 策略。

## 7. 结论

- `/integrated` 当前业务页已经能显示真实实时日志，不再只有 `任务启动中...` 占位。
- `/arrival`、`/dispatch`、`/sign` 当前业务页均能显示真实起始日志。
- 没有使用任务中心作为验收依据。
- 没有触碰 V2。
- 没有修改 `database/migrations`。
- 没有引入 Redis / WebSocket / Kafka / gRPC / 外部日志平台。
- 没有大重构任务系统。
- 没有修改 BrowserDryRun 业务执行流程。
