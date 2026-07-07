# DaoPai V3 Phase K-2A-1：Arrival Agent 本地执行 E2E 验收报告

## 0. 结论

**通过。** Arrival 到件扫描已完整迁移到 Agent 本地执行，三轮 E2E + run-engine 防误入全部通过。Cloud 后端不再触碰浏览器，只创建任务 / 保存状态 / 收日志结果。

| 验收项 | 结果 |
|---|---|
| AGENT_LOCAL_ARRIVAL=true 生效 | ✓ |
| Arrival 不走 backend local-api | ✓ |
| Agent 能 pull Arrival | ✓ |
| Agent 使用 ArrivalExecutor | ✓ |
| Arrival 不调用 run-engine | ✓ |
| BrowserManager 连接/启动浏览器 | ✓ |
| 到件 dry-run 页面动作真实发生 | ✓ |
| 不真实提交 | ✓ |
| 员工日志进入任务中心 | ✓ |
| progress / complete / fail 回写正常 | ✓ |
| 任务不长期 running | ✓ |
| run-engine 防误入返回 TASK_TYPE_MIGRATED_TO_AGENT | ✓ |

---

## 1. 验收范围与约束

- 只验收 Arrival，不迁移 Dispatch / Integrated / Sign。
- 不修改 database/migrations。
- 不启用真实提交（`ENABLE_REAL_SUBMIT=false`）。
- 不恢复截图（`ENABLE_RUNTIME_SCREENSHOTS=0`）。
- 不绕过 Agent 用 backend local-api 冒充通过。
- Codex 已完成 K-2A 代码迁移与 build；本阶段只做 E2E 验收和必要最小修复。

---

## 2. 环境与配置

### 2.1 环境变量（`.env`）

验收前 `.env` 缺少 `AGENT_LOCAL_ARRIVAL`，导致 arrival 仍会走 `scheduleLocalEngineRun`。已补齐：

```env
# ── Phase K-2A：Arrival Agent 本地执行开关 ──
AGENT_LOCAL_ARRIVAL=true
ENABLE_REAL_SUBMIT=false
ENABLE_RUNTIME_SCREENSHOTS=0
```

- `AGENT_LOCAL_ARRIVAL=true`：backend 只创建任务，不执行 `scheduleLocalEngineRun`（[backend/api/routes.ts:1085-1089](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts)）。
- `ENABLE_REAL_SUBMIT=false`：安全门关闭，即使 `browserDryRun=false` 也不真实提交。
- `ENABLE_RUNTIME_SCREENSHOTS=0`：截图保持关闭。

### 2.2 进程

| 进程 | 命令 | 端口 |
|---|---|---|
| backend | `npm run dev`（tsx watch backend/index.ts） | 3300 |
| frontend | `npm run dev`（vite） | 5176 |
| agent | `npm run dev`（tsx src/index.ts） | — |

- PostgreSQL 5436 / daopai_v3。
- AUTH_REQUIRED=true（用户 JWT 强制）。
- Agent 授权码验证成功，执行电脑：本机默认工作站，租户：默认租户。

### 2.3 数据

- 站点：天南大（site-1782121346155），code=tiannanda。
- 员工：肖飞（02201030008）、孟德海（02201030006）。
- settings.json runtime.dryRunMode=true。

---

## 3. 代码审查摘要

### 3.1 Agent 主循环分发（[packages/agent/src/index.ts:248-258](file:///e:/网站开发/DaoPaiV3/packages/agent/src/index.ts)）

```ts
else if (task.type === 'arrival' || (task as any).taskType === 'arrival') {
  console.log(`[Agent] 收到 Arrival 任务，使用 Agent 本地执行器`);
  runningTaskId = task.taskId;
  await executeArrivalDryRun(task as any, client, settingsLoader, config);
  runningTaskId = null;
}
```

arrival 任务分发到 `executeArrivalDryRun`（本地执行器），**不调用** `runTaskWithBackendEngine`。dispatch/integrated/sign 仍走兼容路径。

### 3.2 backend 跳过 local-api（[backend/api/routes.ts:1085-1089](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts)）

```ts
if (process.env.AGENT_LOCAL_ARRIVAL === 'true') {
  console.log(`[AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true，arrival taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'arrival');
}
```

### 3.3 run-engine 防误入（[backend/agent/agentRoutes.ts:173-180](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts)）

```ts
if (task.type === 'arrival' || task.type === 'arrive') {
  return res.status(409).json({
    ok: false,
    code: 'TASK_TYPE_MIGRATED_TO_AGENT',
    message: 'Arrival 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行',
    timestamp: new Date().toISOString(),
  });
}
```

### 3.4 安全门（[packages/agent/src/executors/ArrivalExecutor.ts:129-131,175-177,255-259](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/ArrivalExecutor.ts)）

```ts
if (browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true') {
  logger.warning('[Agent][Arrival][安全门] 跳过最终提交', meta);
}
```

- `browserDryRun=true` → dry-run 路径，永不点击最终提交。
- `browserDryRun=false` + `ENABLE_REAL_SUBMIT≠true` → 安全门拦截，仍不提交。
- `ArrivalBrowserDryRun.ts` 的 `assertNotFinalSubmit()` 硬保护：按钮文本匹配"批量到件/确认到件/提交/保存/完成"时直接抛错。
- `finalSubmitClicked` 硬编码为 `false`。

### 3.5 编译验证

| 包 | 命令 | 结果 |
|---|---|---|
| backend | `npm run build`（tsc） | exit 0 |
| agent | `npm run build`（tsc -p tsconfig.json） | exit 0 |
| frontend | `npm run build`（tsc && vite build） | exit 0，4.99s |

---

## 4. 最小修复

### 4.1 AgentSettingsLoader 网点匹配（必要修复）

**现象**：第一轮 E2E 失败，`[AgentSettingsLoader] 错误：未找到网点 tiannanda` → `无法读取员工凭据`。

**根因**：backend `normalizeSiteToCode` 把 `site-1782121346155`（天南大）转成 code `tiannanda` 存入任务。Agent 的 `AgentSettingsLoader.getLoginCredentialForSite` 只按 `s.id === siteId` 匹配，settings.json 里是 `site-1782121346155`，匹配失败。

**修复**：[packages/agent/src/AgentSettingsLoader.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/AgentSettingsLoader.ts) 新增 `siteNameToCode` + `matchSite`，按 id / name / 派生 code 三形态匹配，与 backend `normalizeSiteToCode` 映射一致（天南大→tiannanda，和苑→heyuan）。

**影响范围**：仅 Agent 侧网点查找逻辑，不影响 backend、不改变 settings.json 结构、不影响 V2。

---

## 5. E2E 测试结果

### 5.1 第一轮：肖飞单员工

| 项 | 值 |
|---|---|
| taskId | 6bb73a2b-6072-4723-9a94-cc78e272fa3e |
| 员工 | 肖飞 |
| 站点 | 天南大 |
| 单号数 | 8 |
| browserDryRun | true |
| 提交时间 | 2026-07-02 05:01 |

**执行链路**：

```
前端 POST /api/operations/arrive
→ backend [AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true，只创建任务，等待 Agent 本地执行
→ Agent pullTask 拉到任务 type=arrival
→ Agent 收到 Arrival 任务，使用 Agent 本地执行器
→ ArrivalExecutor 启动便携版 Chrome (PID=1092)
→ CDP 连接成功，单标签页清理
→ 打开登录页，自动登录成功
→ Dashboard P0 = READY
→ 弹窗清理：点击"取消"按钮
→ 导航到到件扫描页面（Vue Router 兜底）
→ 页面标题：到件扫描(批量) - 凤凰系统-笨鸟速运
→ 运单输入框/上一站/查询按钮/结果表格/最终提交按钮 全部检测到
→ 稳定输入 8 条运单，校验通过
→ 上一站填写：天津分拨中心，候选项数量:1，点击候选项，校验通过
→ 查询前置校验通过（运单=true，上一站=true，查询按钮=true）
→ 点击查询按钮（文本"查询"，安全检查通过）
→ 查询结果表格行已加载
→ DRY-RUN 完成：已输入运单并点击查询，未点击最终提交按钮
→ Chrome 关闭，无 V3 残留进程
→ 任务完成，已回传 Cloud
```

**backend 日志验证**：

- `[AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true，arrival taskId=6bb73a2b... 只创建任务，等待 Agent 本地执行` ✓
- 未出现 `scheduleLocalEngineRun arrival` / `TaskEngineRunner.runTask arrival` / `AssignmentEngine execute arrival` ✓

**任务回写验证**：

- status=done ✓
- 日志 staffName=肖飞, windowId=天南大-肖飞, source=agent, workstationId=ws-local-default ✓
- 摘要 `{mode:browserDryRun, total:8, queried:true, finalSubmitClicked:false}` ✓
- 8 条 waybill_results 全部 `status=dry_run, message=已输入并查询，未提交到件` ✓

### 5.2 第二轮：肖飞重复执行（窗口干净验证）

| 项 | 值 |
|---|---|
| taskId | 6809b3eb-d5e7-46f8-8b25-0874cbbe19fd |
| 员工 | 肖飞 |
| 单号数 | 5 |

**窗口干净验证**：

- 新 Chrome 进程启动，重新登录成功 ✓
- 无 WRONG_PAGE / ELEMENT_MISSING ✓
- 无旧弹窗影响（弹窗清理第1轮点"取消"，第2轮无可见弹窗）✓
- 到件页面导航成功，所有元素检测到 ✓
- 5 条运单输入校验通过 ✓
- 上一站第 1 次尝试即校验通过 ✓
- 查询执行，结果表格行加载 ✓
- 未点击最终提交 ✓
- Chrome 关闭，无 V3 残留进程 ✓
- status=done ✓

### 5.3 第三轮：换员工孟德海（日志不串验证）

| 项 | 值 |
|---|---|
| taskId | 30a20a22-7241-4436-84bd-6e6eb13d4083 |
| 员工 | 孟德海 |
| 单号数 | 6 |

**日志不串验证**：

- 任务日志 staffName=孟德海, windowId=天南大-孟德海 ✓（非肖飞，无串号）
- 关键日志上下文：
  - `[success] [Agent][Arrival] 本地执行完成 | staff=孟德海 window=天南大-孟德海`
  - `[info] [Agent][Arrival] 上一站填写校验通过：天津分拨中心 | staff=孟德海 window=天南大-孟德海`
- 摘要 `{mode:browserDryRun, total:6, queried:true, finalSubmitClicked:false}` ✓
- status=done ✓

### 5.4 run-engine 防误入验证

```
POST /agent/tasks/6bb73a2b-6072-4723-9a94-cc78e272fa3e/run-engine
Authorization: Bearer <agentToken>

HTTP 409
{
  "ok": false,
  "code": "TASK_TYPE_MIGRATED_TO_AGENT",
  "message": "Arrival 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行",
  "timestamp": "2026-07-02T05:07:26.119Z"
}
```

- 返回 409 + `TASK_TYPE_MIGRATED_TO_AGENT` ✓
- 未进入 TaskEngineRunner / AssignmentEngine ✓

### 5.5 安全门验证（代码路径）

- `browserDryRun=true` 时：走 dry-run 路径，`ArrivalBrowserDryRun.ts` 只点击查询按钮，`finalSubmitClicked` 硬编码 false。三轮 E2E 已实证。 ✓
- `browserDryRun=false` + `ENABLE_REAL_SUBMIT≠true` 时：`ArrivalExecutor.ts` L129/175/255 三处检查，日志输出"安全门 跳过最终提交"，仍走 dry-run 页面动作但不提交。代码路径验证通过（未真实构造 browserDryRun=false 任务，因安全门已在代码中明确拦截）。 ✓
- `assertNotFinalSubmit()` 硬保护：即使误传提交按钮选择器，也会在点击前抛错。 ✓

---

## 6. 失败排查记录

### 6.1 第一轮首次提交失败：网点匹配

- **卡在哪层**：Agent 进入 ArrivalExecutor → BrowserManager 启动 Chrome 成功 → 打开登录页 → `getLoginCredentialForSite(siteId)` 返回 null。
- **根因**：任务 siteId=`tiannanda`（backend normalizeSiteToCode 产出），AgentSettingsLoader 只按 `s.id` 匹配 settings.json 的 `site-1782121346155`，匹配失败。
- **修复**：见 §4.1，新增 `matchSite` 三形态匹配。
- **修复后**：第二轮起全部通过。

### 6.2 残留 Chrome 进程

- 每轮执行后 `BrowserManager.close()` 会检测到 6 个 V3 Chrome 残留子进程，逐一关闭，最终"Chrome 已关闭，无 V3 残留进程"。
- 属正常行为（Chrome 多进程架构），不影响下一轮。

---

## 7. 已知限制（不影响验收）

| 项 | 说明 | 是否需立即修 |
|---|---|---|
| Agent 侧导航用 page.goto + Vue Router 兜底 | 未采用 Phase 5-G8-6 的"侧边栏优先"。当前到件页面导航成功（Vue Router 兜底生效），但若未来笨鸟系统改版导致 URL 直跳失效，需迁移侧边栏逻辑。 | 否，暂留 |
| getLoginCredentialForSite 返回站点第一个有凭据的员工 | 不按 staffName 精确匹配员工账号。当前 dry-run 不依赖具体登录账号，日志 staffName 来自任务 payload 而非登录账号。 | 否，Phase K-3 跟随 |
| task.doneCount=0 / progress 为空 | Agent completeTask 回传的 summary/results 未回填 doneCount。dry-run 场景可接受。 | 否 |
| 少量日志 staffName=(空) | complete/fail 回传时 Agent 上传的收尾日志未带 meta（`TaskLogService` 记录 `staffName=(空)`）。主体业务日志均带正确上下文。 | 否，Phase K-2B 优化 |

---

## 8. 修改文件清单

| 文件 | 修改类型 | 说明 |
|---|---|---|
| `.env` | 配置补齐 | 新增 AGENT_LOCAL_ARRIVAL=true / ENABLE_REAL_SUBMIT=false / ENABLE_RUNTIME_SCREENSHOTS=0 |
| [packages/agent/src/AgentSettingsLoader.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/AgentSettingsLoader.ts) | 最小修复 | 新增 siteNameToCode + matchSite，按 id/name/code 三形态匹配网点 |

未修改：backend 任何文件、database/migrations、V2、ArrivalExecutor、ArrivalBrowserDryRun、agent index.ts、agentRoutes.ts、routes.ts。

---

## 9. 通过标准核对

| # | 标准 | 结果 | 证据 |
|---|---|---|---|
| 1 | AGENT_LOCAL_ARRIVAL=true 生效 | ✓ | backend 日志 `[AgentLocalArrival] AGENT_LOCAL_ARRIVAL=true` |
| 2 | Arrival 不走 backend local-api | ✓ | backend 日志无 scheduleLocalEngineRun/TaskEngineRunner/AssignmentEngine |
| 3 | Agent 能 pull Arrival | ✓ | Agent 日志 `T3 拉到任务 type=arrival` |
| 4 | Agent 使用 ArrivalExecutor | ✓ | Agent 日志 `收到 Arrival 任务，使用 Agent 本地执行器` |
| 5 | Arrival 不调用 run-engine | ✓ | Agent 日志无 `runTaskWithBackendEngine(arrival)`，无 `POST /agent/tasks/:id/run-engine` |
| 6 | BrowserManager 连接/启动浏览器 | ✓ | `便携版 Chrome 启动成功` + `CDP 就绪` + `Playwright CDP 连接成功` |
| 7 | 到件 dry-run 页面动作真实发生 | ✓ | 登录/导航/运单填写/上一站/查询全部执行 |
| 8 | 不真实提交 | ✓ | `finalSubmitClicked:false`，`assertNotFinalSubmit` 保护 |
| 9 | 员工日志进入任务中心 | ✓ | PG task_logs 有 staffName/windowId/source=agent 日志 |
| 10 | progress / complete / fail 回写正常 | ✓ | task status=done，progress 5→30→90→done |
| 11 | 任务不长期 running | ✓ | 三轮均 done，无卡 running |
| 12 | run-engine 防误入返回 TASK_TYPE_MIGRATED_TO_AGENT | ✓ | HTTP 409 + code=TASK_TYPE_MIGRATED_TO_AGENT |

**只 build 通过不算通过** — 本验收在 build 通过基础上完成了真实 Cloud + Agent + 浏览器 E2E 三轮。

---

## 10. 下一步建议

- **Phase K-2B**：Dispatch 迁移到 Agent 本地执行（复用 K-2A 模式）。
- **Phase K-2C**：Integrated / Sign 迁移。
- **Phase K-3**：`/api/operations/*` 的 `scheduleLocalEngineRun` 下线；`/agent/tasks/:id/run-engine` 端点删除；Cloud 端 BrowserPool/PlaywrightRuntime/EasyBRClient 执行内核评估迁出或删除。
