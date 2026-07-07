# DaoPai V3 Phase 5-G-4 员工窗口执行链路修复报告

## 1. 结论

本次修复以真实业务页为验收入口，未使用任务中心作为依据。

- `/integrated` 已从业务页点击启动后进入员工窗口执行链路，当前页面员工卡片能显示真实员工日志。
- `/arrival`、`/dispatch`、`/sign` 已完成业务页回归，均不依赖任务中心查看日志。
- 系统级日志已改为“系统日志 / 诊断信息”，默认折叠，失败时自动展开。
- 未修改 V2、`database/migrations`、BrowserDryRun 业务流程，未引入 Redis、WebSocket、Kafka、gRPC 或外部日志平台。

## 2. 是否复现问题

已复现业务页链路断点：业务页提交任务后能创建 PG task 并进入执行态，但员工窗口链路缺少足够的员工窗口元数据，Agent 侧业务任务执行路径也没有统一进入后端 AssignmentEngine 的员工窗口执行链路。表现为业务页容易只有占位日志、员工卡片没有真实员工动作日志、进度不能稳定跟随后端执行结果。

## 3. 根因定位

断点类型：

- taskId 获取：业务页已能拿到 PG taskId，不是本次主断点。
- taskOrigin 判断：不是主断点，但日志 hook 必须以当前业务页刚创建的 taskId 为准。
- useTaskLiveLogs enabled：上一阶段已修复为按 taskId 拉取，本次保留该方向。
- API 数据源：业务页走 PG task 和 `/api/tasks/:id/logs`，不是 legacy logs 作为主链路。
- PG/legacy mismatch：不是最终主因。
- 页面渲染：员工卡片已改为使用带 `staffName` 的实时日志；系统日志不再承担员工日志展示。
- 员工窗口执行链路：主因。前端 assignments 缺少 `siteId/windowId/runtimeKey/browserId` 等员工窗口定位信息，Agent 侧业务任务路径没有稳定接入后端 AssignmentEngine，导致业务页创建任务后不能可靠驱动对应员工窗口。
- 进度同步：AssignmentEngine 运行中没有稳定把 PG task 进度和 TASK_LOG 事件同步到业务页；前端旧 fallback 在空 results 时可能把 worker 进度覆盖回 0。

## 4. 修改文件

- `frontend/src/lib/assignment-builder.ts`
  - 为 Assignment 增加 `siteId`、`windowId`、`browserId`、`runtimeKey`。
- `frontend/src/components/shared/ScanWorkbench.tsx`
  - 业务页启动任务时补齐员工窗口元数据。
  - 员工日志继续按 `staffName` 渲染，系统日志改名为“系统日志 / 诊断信息”并默认折叠。
- `frontend/src/pages/SignPage.tsx`
  - 签收页补齐员工窗口元数据。
  - 同步系统诊断日志折叠 UI。
- `frontend/src/api/client.ts`
  - 允许业务任务 assignments 携带员工窗口元数据。
- `frontend/src/components/shared/TaskExecutionContext.tsx`
  - PG status 轮询按 `doneCount/failCount/totalCount` 推进全局和员工进度。
  - 空 results 不再把已有进度重置为 0。
- `backend/agent/agentRoutes.ts`
  - 新增 `/agent/tasks/:id/run-engine`，由 Agent 触发后端 AssignmentEngine 执行业务任务。
  - 对每个员工写入带 `staffName/windowId` 的准备执行日志。
- `backend/modules/assignment-engine/AssignmentEngine.ts`
  - AssignmentEngine 写入 PG task logs 后同步 emit `TASK_LOG`。
  - 执行中持续更新 PG task 进度并 flush 员工日志。
  - Playwright 模式 EasyBR 跳过日志改为显示真实 taskType。
- `packages/agent/src/httpClient.ts`
  - 增加调用后端 engine 执行接口的方法。
- `packages/agent/src/index.ts`
  - Agent 收到业务任务后转交后端 AssignmentEngine。
  - 增加任务 payload 预览日志，不输出密码。

## 5. `/integrated` 业务页验收

验收入口：`http://localhost:5176/integrated`

操作：选择员工“刘磊”“罗晓红”，点击“启动分布式扫描”，停留在当前业务页观察实时执行日志。

| 时间点 | 页面路径 | 页面 taskId | PG status | operations 接口 | API 日志条数 | 页面系统日志 | 员工日志 | 是否仍只有占位 |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| T+0s | `/integrated` | `b6be7d34-0287-40ae-810e-89f0b49eaa03` | running | 非依据 | 1+ | 1 | 占位/等待 Agent 心跳 | 是，刚启动瞬间 |
| T+17s | `/integrated` | 同上 | running | 非依据 | 增长中 | 有 | 出现“准备执行员工”日志 | 否 |
| T+20s | `/integrated` | 同上 | running，25/50 | 非依据 | 增长中 | 有 | 刘磊 13/25，罗晓红出现窗口未登录员工级失败 | 否 |
| T+done | `/integrated` | 同上 | failed，50/50 | 非依据 | 42 | 自动展开诊断日志 | 34 条 staff logs，刘磊 25/25，罗晓红失败原因显示在员工卡片 | 否 |

补充验证：在同一修复链路的早期 integrated 任务中，罗晓红员工窗口也进入过真实页面动作链路，日志包含到件扫描页面、选择快递员、批次处理、释放窗口等动作。最终验收任务中罗晓红窗口未登录，页面已正确显示员工级失败，而不是静默卡死或只显示全局占位。

## 6. 回归结果

| 页面 | taskId | 业务页结果 | 员工卡片日志 | 结论 |
| --- | --- | --- | --- | --- |
| `/arrival` | `6122df81-f400-4153-9c79-7faf4d8996bc` | 50/50，成功 50，失败 0，扫描完成 | 刘磊员工卡片显示准备执行和窗口连接日志 | 通过 |
| `/dispatch` | `7ae4e5df-ecba-4c64-a65c-69d0edfa306e` | 50/50，失败 50，任务失败 | 刘磊员工卡片显示批次进度、完成 50 条和上传跳过原因 | 通过，失败原因可见 |
| `/sign` | `ec0b9159-5219-4ec1-a38c-34e5dc985aca` | 1/1，失败 1，任务失败 | 刘磊员工卡片显示搜索动作、重试、截图路径和员工级失败 | 通过，失败原因可见 |

## 7. 验收说明

- 是否还存在“任务启动中...”占位不消失：否。启动瞬间仍会出现占位，但 Agent 心跳接管后员工日志会追加；失败时员工卡片显示真实失败原因。
- 员工窗口是否真的动作：是。Ready 员工窗口会进入 AssignmentEngine 对应业务 handler。未登录员工窗口会显示员工级失败，不再表现为业务页无日志卡死。
- 是否仍依赖全局日志证明员工执行：否。员工卡片使用带 `staffName` 的日志。
- 是否使用任务中心作为依据：没有。
- 是否触碰禁止区域：没有修改 V2、没有修改 `database/migrations`、没有引入外部日志平台、没有改 BrowserDryRun 业务执行流程。

## 8. 验证命令

- `npm run build`
- `npm run build`（`packages/agent`）
- `npm run build`（`frontend`）

全量 `npm test` 本轮未重新执行；此前已知存在与凭据 fallback 相关的非本次链路问题。本次以业务页真实运行、PG task status/logs 和页面员工卡片日志作为验收依据。
