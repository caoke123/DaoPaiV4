# DaoPai V3 Agent READY 窗口迁移指导文档

本文档沉淀 Phase K-3A Arrival 与 Phase K-3B Dispatch 的迁移经验，用于后续业务迁回 Local Agent 本地执行时复用。

核心目标：

```text
Cloud 只创建任务；
Agent 主动拉取任务；
Agent 接管已有 READY 员工窗口；
不新开 Chrome；
不重新登录；
不恢复 Cloud Engine / local-api 执行业务。
```

---

## 1. 适用范围

适用于把某个业务从 Cloud 本地执行路径迁移到：

```text
/api/operations/*
  -> tasks pending
  -> Agent heartbeat / pull
  -> Executor
  -> /agent/window-connections
  -> BrowserManager.connectExisting(cdpEndpoint)
  -> BrowserDryRun
  -> progress/logs/complete/fail
```

已验证业务：

- Arrival：多员工 READY 窗口并行接管。
- Dispatch：默认模式、指定模式、缺 READY 窗口失败路径。

不适用：

- 需要新开浏览器的初始化窗口任务。
- 尚未登录或未进入 READY 状态的员工窗口。
- Cloud 侧直接控制浏览器的旧路径。

---

## 2. 迁移原则

### 2.1 Cloud 边界

Cloud 只做：

- 校验请求。
- 创建 `tasks` 记录，状态为 `pending`。
- 写入 `input_data`。
- 写入 API 起始日志。
- 等待 Agent 拉取与回传。

Cloud 禁止做：

- 调用 `scheduleLocalEngineRun`。
- 调用 `TaskEngineRunner` 执行四业务。
- 调用 `PlaywrightRuntime` 直接执行业务动作。
- 通过 `local-api` claim 后在 Cloud 进程里控制浏览器。
- `/api/operations/*` 创建任务后 `setImmediate` 执行业务逻辑。

### 2.2 Agent 边界

Agent 做：

- heartbeat。
- `/agent/tasks/pull` 拉任务。
- 查询 `/agent/window-connections`。
- 匹配 READY 员工窗口。
- `connectOverCDP` 接管已有窗口。
- 执行业务 dry-run。
- 上报日志、进度、结果、完成或失败。

Agent 禁止做：

- 在业务 Executor 正常路径里 `new BrowserManager`。
- `manager.start()` 新开 Chrome。
- `manager.openPage(loginUrl)`。
- `ensureBnsyLoggedIn` 重新登录。
- READY 窗口缺失时 fallback 到新窗口。

---

## 3. 迁移前检查

### 3.1 Cloud Engine 是否断根

执行：

```bash
npm run check:no-cloud-engine
```

期望：

```text
✅ 检查通过：未发现 Cloud 引擎回流风险
```

同时静态搜索：

```bash
rg -n "scheduleLocalEngineRun|TaskEngineRunner.runTask|source: 'local-api'" backend packages/agent
```

允许：

- `scheduleLocalEngineRun` 出现在注释中。
- `source: 'local-api'` 出现在类型枚举中。
- `TaskEngineRunner.runTask` 只保留在被 guard 拦截的通用路径中。

不允许：

- 四业务 `/api/operations/*` 正常路径调用 Cloud Engine。
- 四业务任务出现 `source=local-api` 业务日志。

### 3.2 READY 窗口检查

用 Agent Token 查询：

```bash
GET /agent/window-connections?siteId=<siteId>&status=ready
Authorization: Bearer <agentToken>
```

必须确认每个目标窗口：

```text
staffName 正确
windowId 正确
siteId 正确
status=ready
cdpAttachable=true
cdpEndpoint=http://127.0.0.1:<port>
currentUrl 在 dashboard 或业务可恢复状态
isLoggedIn=true
```

如果窗口不 READY，业务 Executor 应失败为 `READY_WINDOW_NOT_FOUND` 或 `READY_WINDOW_DASHBOARD_NOT_READY`，不能新开窗口兜底。

### 3.3 队列检查

迁移测试前检查是否有旧任务干扰：

```sql
select id, type, status, site_id, created_at
from tasks
where status in ('pending', 'assigned', 'running')
order by created_at asc;
```

如果有历史 pending 任务，先清理或等待它们完成，否则 Agent 会先拉旧任务。

---

## 4. Executor 迁移步骤

### 4.1 输入解析

从 task `inputData` 中解析：

```text
executionMode
assignments
dryRun/browserDryRun
siteId
```

每个 assignment 至少应归一化：

```text
executionStaffName：执行窗口员工
targetCourierName：业务目标员工，默认等于 executionStaffName
windowId：优先来自前端；缺省可用 staff-<executionStaffName>
waybillNos：当前员工单号
mode：default / specified
```

注意：代码中接口约定可能是 `designated`，日志中可以显示为 `specified`，但要保持输入校验和前端一致。

### 4.2 查询 READY 窗口

Executor 开始前，先查询：

```typescript
const readyWindows = await queryWindowConnections(client, {
  siteId,
  status: 'ready',
});
```

建议也查询一次同站点全部窗口，用于失败日志：

```typescript
const allSiteWindows = await queryWindowConnections(client, { siteId });
```

### 4.3 匹配规则

推荐匹配顺序：

```text
1. windowId 精确匹配。
2. staffName === executionStaffName。
3. 校验 siteId 一致。
4. 校验 cdpAttachable=true。
5. 校验 cdpEndpoint 存在。
6. 防止同一个 windowId 被多个 assignment 重复占用。
```

失败时返回清晰错误：

```text
READY_WINDOW_NOT_FOUND: staffName=xxx siteId=xxx；visible windows: ...
READY_WINDOW_NOT_ATTACHABLE
READY_WINDOW_ENDPOINT_MISSING
READY_WINDOW_DUPLICATED
```

### 4.4 并行执行

多员工任务使用并发限制：

```typescript
const concurrency = Math.min(assignments.length, 5);
```

行为要求：

- 一个 assignment 缺 READY 窗口，只失败这个 assignment。
- 其它 READY assignment 继续执行。
- 汇总时保留每个 assignment 的 `executionStaffName/targetCourierName/windowId/success/results`。

### 4.5 接管已有窗口

正式路径只允许：

```typescript
const connected = await BrowserManager.connectExisting(cdpEndpoint);
const page = connected.page;
```

禁止：

```typescript
new BrowserManager(...)
manager.start()
manager.openPage(loginUrl)
ensureBnsyLoggedIn(...)
```

日志必须包含：

```text
[RuntimeProof][<Executor>] mode=READY_CDP_ATTACH noNewChrome=true noRelogin=true parallel=true
[Agent][<Business>] connectOverCDP 开始 windowId=...
[Agent][<Business>] connectOverCDP 成功 windowId=...
[Agent][<Business>] 使用 READY 窗口执行，不新开 Chrome
[Agent][<Business>] 不新开 Chrome，不重新登录
```

### 4.6 页面前置校验

接管后先做轻量校验：

```text
detectBnsyDashboardP0 或等价登录/首页判断
registerNativeAlertGuard
ensureCleanHome
navigateToBusinessPageMenuFirst
afterPageChangedCleanup
verifyBusinessPageReady
```

不要在业务页进入成功后重复：

```text
reload
goto business URL
ensureReadyForTask 重型导航
重新登录
```

---

## 5. BrowserDryRun 迁移与修复经验

### 5.1 导航统一

业务页面进入应优先：

```text
从 READY 首页
-> 真实点击侧边栏父菜单
-> 真实点击业务子菜单
-> 验证 URL 或关键元素
-> 成功后停止导航
```

URL fallback 只能作为菜单点击失败后的兜底。

### 5.2 弹窗处理

native alert：

```text
alert / confirm：dialog.accept()，相当于点“确定”
prompt：accept('')
beforeunload：dismiss()
```

DOM 弹窗：

```text
先判断可见弹窗容器；
没有弹窗不点击任何按钮；
有弹窗只在弹窗内部点“取 消”；
找不到“取 消”只记录 warning。
```

禁止全页面搜索“取消”按钮。

### 5.3 Dispatch 派件员选择经验

Dispatch 的派件员是 `el-select`，容易出现：

```text
input 可见但普通 click 超时；
候选列表只渲染当前可见项；
指定模式目标派件员不在第一屏候选中。
```

稳定方案：

```text
1. 找 .dispatchscan_left 内派件员 el-select input。
2. 普通 locator.click()。
3. 普通点击失败时，点击 el-select wrapper。
4. 仍失败时 force click 兜底。
5. 先匹配可见候选项。
6. 候选未命中时，在 el-select input 输入 targetCourierName 过滤。
7. 再匹配候选项。
8. 选择后验证 input.value 或 selected item。
```

日志建议：

```text
派件员下拉框打开: method=input_click/select_wrapper_click/input_force_click
派件员可见候选未命中，尝试输入过滤: xxx
派件员精确匹配失败，使用子串匹配: ...
派件员 input.value 校验通过: selectedCourierText="xxx"
```

### 5.4 Dispatch 单号添加经验

统一路径：

```text
findWaybillInput
fill('')
fill(waybillNo)
inputValue 验证
点击添加
并行等待：
  - 表格行数增加
  - 新错误 message 出现
  - loading 消失
  - 短超时 no_response
```

不要按窗口走不同判定路径。

无效测试单号允许结果为：

```text
successCount=0
failedCount=N
任务日志显示 safe dry-run 完成
finalSubmitClicked=false
```

---

## 6. 任务终态判断

迁移验证时要区分：

```text
执行链路是否成功
业务单号是否成功
```

例如 Dispatch dry-run 中，测试单号无效时可能出现：

```text
任务表 status=failed
done_count=0
fail_count=N
progress=100
```

这不一定代表迁移失败。只要日志证明：

```text
Agent 拉到任务
进入 Executor
READY 窗口 connectOverCDP 成功
未新开 Chrome
未重新登录
进入业务页
业务 dry-run 完成
未点击最终提交
结果按真实页面 message 判失败
```

则迁移链路是通过的，业务单号失败属于页面真实结果。

---

## 7. 验证脚本模板

### 7.1 默认模式多员工

```powershell
$json = @'
{
  "site": "site-1782121346155",
  "executionMode": "default",
  "dryRunMode": true,
  "assignments": [
    {
      "staffName": "肖飞",
      "windowId": "staff-肖飞",
      "targetCourierName": "肖飞",
      "waybillNos": ["55999900000101", "55999900000102"]
    },
    {
      "staffName": "孟德海",
      "windowId": "staff-孟德海",
      "targetCourierName": "孟德海",
      "waybillNos": ["55999900000103", "55999900000104"]
    }
  ]
}
'@

$login = Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3300/api/auth/login' `
  -ContentType 'application/json' `
  -Body '{"username":"admin","password":"admin123456"}'

Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3300/api/operations/dispatch' `
  -Headers @{Authorization="Bearer $($login.accessToken)"} `
  -ContentType 'application/json' `
  -Body $json
```

### 7.2 指定模式

```json
{
  "site": "site-1782121346155",
  "executionMode": "designated",
  "dryRunMode": true,
  "assignments": [
    {
      "staffName": "肖飞",
      "windowId": "staff-肖飞",
      "targetCourierName": "刘磊",
      "waybillNos": ["55999900000121", "55999900000122"]
    }
  ]
}
```

验收点：

```text
执行窗口=肖飞
目标派件员=刘磊
connectOverCDP windowId=staff-肖飞
派件员选择校验通过：刘磊
```

### 7.3 缺 READY 窗口失败路径

选择一个站点内存在、但当前没有 READY 窗口的员工：

```json
{
  "site": "site-1782121346155",
  "executionMode": "default",
  "dryRunMode": true,
  "assignments": [
    {
      "staffName": "肖飞",
      "windowId": "staff-肖飞",
      "targetCourierName": "肖飞",
      "waybillNos": ["55999900000131"]
    },
    {
      "staffName": "罗晓红",
      "windowId": "staff-罗晓红",
      "targetCourierName": "罗晓红",
      "waybillNos": ["55999900000132"]
    }
  ]
}
```

验收点：

```text
肖飞继续执行
罗晓红失败为 READY_WINDOW_NOT_FOUND
没有新开 Chrome
没有重新登录
parallel assignments settled success=1 failed=1
```

---

## 8. 数据库验证 SQL

任务状态：

```sql
select id, type, status, site_id, total_count, done_count, fail_count,
       progress, assigned_at, finished_at
from tasks
where id = '<taskId>';
```

日志来源：

```sql
select source, count(*)
from task_logs
where task_id = '<taskId>'
group by source
order by source;
```

关键日志：

```sql
select to_char(created_at,'HH24:MI:SS.MS') as time,
       source, level, staff_name, window_id, message
from task_logs
where task_id = '<taskId>'
  and (
    message like '%RuntimeProof%'
    or message like '%parallel assignment start%'
    or message like '%connectOverCDP%'
    or message like '%不新开%'
    or message like '%不重新登录%'
    or message like '%READY_WINDOW%'
    or message like '%parallel assignments settled%'
    or message like '%任务完成%'
    or message like '%任务失败%'
  )
order by created_at asc;
```

验收期望：

```text
source 只应有 api / agent
不应有 local-api
```

---

## 9. 编译与静态检查

每次迁移后必须执行：

```bash
cd packages/agent && npm run build
cd backend && npm run build
cd frontend && npm run build
npm run check:no-cloud-engine
```

frontend 只有 Vite chunk warning 不算失败。

额外静态检查：

```bash
rg -n "new BrowserManager|manager\\.start|ensureBnsyLoggedIn" packages/agent/src/executors/<Business>Executor.ts
rg -n "scheduleLocalEngineRun|TaskEngineRunner.runTask|source: 'local-api'" backend packages/agent
```

---

## 10. 最终验收清单

迁移一个业务完成前，逐项确认：

- [ ] `/api/operations/*` 只创建 pending task。
- [ ] Agent 能 pull 到该业务任务。
- [ ] Executor 打印 RuntimeProof。
- [ ] Executor 查询 `/agent/window-connections`。
- [ ] READY 窗口按 `executionStaffName/windowId/siteId` 匹配。
- [ ] 使用 `BrowserManager.connectExisting(cdpEndpoint)`。
- [ ] 没有 `new BrowserManager`。
- [ ] 没有 `manager.start`。
- [ ] 没有重新登录。
- [ ] 多员工并行，且并发上限可控。
- [ ] 单个 assignment 失败不阻塞其它 READY assignment。
- [ ] 缺 READY 窗口返回明确错误，不 fallback。
- [ ] 日志有 `staffName/windowId/siteId` 上下文。
- [ ] `task_logs.source` 只有 `api/agent`。
- [ ] 没有 `local-api` 业务日志。
- [ ] 未点击最终提交按钮。
- [ ] 编译通过。
- [ ] `check:no-cloud-engine` 通过。

---

## 11. 常见问题与处理

### 11.1 点击开始后没日志、窗口没动作

按顺序排查：

```text
1. 前端是否 POST /api/operations/*
2. response 是否有 taskId/status=pending
3. tasks 表是否有 pending
4. 是否有旧 pending 任务排在前面
5. Agent heartbeat 是否成功
6. Agent 是否 pull 到 task
7. Agent 是否进入对应 Executor
8. /agent/window-connections 是否查到 READY 窗口
9. 是否写入 source=agent 日志
```

断点判断：

```text
只有 source=api：Agent 没拉到或没执行
有 source=agent 但无窗口动作：Executor 前置失败或窗口匹配失败
有 local-api：Cloud 回流，必须停止
```

### 11.2 READY 窗口查不到

检查：

```text
siteId 是否是 siteCode，不是 settings 中 site-xxx
staffName 是否一致
windowId 是否一致
窗口 status 是否 ready
cdpAttachable 是否 true
Agent Token tenant 是否与窗口 tenant 一致
```

### 11.3 任务终态 failed 但看起来执行成功

检查 summary：

```text
successAssignments 是否大于 0
finalSubmitClicked 是否 false
失败原因是否来自页面 message
测试单号是否本来无效
```

如果只是单号无效，迁移链路仍可通过。

### 11.4 指定模式目标员工选不中

常见原因：

```text
候选下拉只显示部分员工
需要输入过滤 targetCourierName
精确匹配失败但子串匹配可用
```

处理：

```text
先真实点击 el-select；
可见候选未命中再输入过滤；
只在候选项内点击，不伪造选择状态；
最后验证 input.value。
```

---

## 12. 迁移报告建议格式

每个业务迁移完成后，建议报告包含：

```text
1. 修改文件列表
2. Cloud 断根说明
3. Agent 执行链路说明
4. READY 窗口匹配规则
5. 并行执行策略
6. 默认模式验证
7. 指定模式验证
8. 缺 READY 窗口失败路径验证
9. 日志源分布
10. 是否新开 Chrome / 是否重新登录
11. 是否有 local-api
12. 编译结果
13. 未做真实提交说明
14. 结论：是否可进入下一阶段
```

---

## 13. 最终原则

```text
READY 窗口已经登录，就接管它；
Cloud 只派任务，不碰浏览器；
Agent 只用 connectOverCDP，不新开 Chrome；
缺窗口就明确失败，不偷偷兜底；
多员工并行，但每个员工窗口隔离；
页面业务失败要如实记录，不伪造成功；
迁移完成必须能用日志证明没有 Cloud 回流。
```
