# DaoPai V3 Phase K-2C-1：Dispatch 多员工 assignments E2E 验证报告

- 阶段：Phase K-2C-1
- 类型：E2E 验证（真实 Cloud + Agent + 项目便携 Chrome + PostgreSQL）
- 日期：2026-07-02
- 范围：Dispatch 多员工 assignments 顺序执行；最小修复 backend 单 assignment 限制
- 上游：Phase K-2C（Codex 修复 parseDispatchAssignments 数组解析、executeOneDispatchAssignment 独立执行、complete 回写 done_count/fail_count）
- 参考：`docs/V3_PHASE_K_2B_1_DISPATCH_AGENT_E2E_REPORT.md`

---

## 一、验收目标

确认 Dispatch 多员工 assignments 已真正可用：

| 验收项 | 期望 | 实测 |
| --- | --- | --- |
| 一个 dispatch task 包含多个 assignments | 支持 | ✅ Test A/B 各 2 个 assignment |
| 每个 assignment 独立执行 | 顺序、不并发 | ✅ for 循环顺序执行 |
| 每个员工只处理自己的单号 | 单号不串 | ✅ Test A/B 单号无交叉 |
| 日志按各自员工/windowId 分组 | staffName + windowId 正确 | ✅ 肖飞/孟德海 各 36 条 agent 日志，归属正确 |
| 结果按各自员工/windowId 回写 | results.staffName/windowId | ✅ 通过 task_logs staff_name/window_id 列验证 |
| done_count/fail_count 正确更新 | PG tasks 表 | ✅ Test A=6/0, Test B=6/0, Test D1/D2=3/0, Test E2=3/0 |

---

## 二、环境配置

### .env 关键配置

```env
AGENT_LOCAL_ARRIVAL=true
AGENT_LOCAL_DISPATCH=true
ENABLE_REAL_SUBMIT=false
ENABLE_RUNTIME_SCREENSHOTS=0
```

禁止项已确认：未设置 `ENABLE_REAL_SUBMIT=true`，本阶段全程 dry-run + 安全门拦截。

### 启动组件

| 组件 | 状态 |
| --- | --- |
| PostgreSQL（127.0.0.1:5436, daopai_v3） | ✅ 运行 |
| Backend（http://localhost:3300, watch 模式） | ✅ 运行 |
| Frontend | ✅ 运行 |
| Agent（tsx src/index.ts，非 watch） | ✅ 运行 |
| 项目便携 Chrome（E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe） | ✅ 使用 |
| Agent 授权 + 心跳 + pull task | ✅ 正常 |

---

## 三、K-2C 代码审查结论

审查 `packages/agent/src/executors/DispatchExecutor.ts`：

- `parseDispatchAssignments`（L198-207）：从 `assignments[0]` 改为 `assignments.map(...)` 数组解析；顶层 waybills 兜底单 assignment
- `parseOneAssignment`（L132-196）：每个 assignment 独立解析 `executionStaffName` / `targetCourierName` / `targetCourierExplicit` / `windowId` / `mode`，互不污染
- `mode` 解析（L179-181）：显式 `targetCourierName` 且不等于 `executionStaffName` → `specified`，否则走 `normalizeDispatchMode`
- 顺序执行（L463）：`for (let i = 0; i < assignments.length; i++)` 顺序，不并发
- 安全门（L237/255/322/354）：`browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true'` → 跳过最终提交，`finalSubmitClicked: false` 硬编码
- specified 缺目标派件员（L279-281）：`failAssignment('指定模式缺少目标派件员')`
- summary 结构（L485-496）：含 `assignmentCount` / `total` / `successCount` / `failedCount` / `assignments[]`
- complete 回写（`backend/agent/agentRoutes.ts` L340-373）：`doneCount` / `failCount` / `finalStatus`（全失败=failed，否则=done）

审查 `backend/api/routes.ts`（L1209-1212）：

```typescript
if (process.env.AGENT_LOCAL_DISPATCH === 'true') {
  console.log(`[AgentLocalDispatch] AGENT_LOCAL_DISPATCH=true，dispatch taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'dispatch');
}
```

确认：`AGENT_LOCAL_DISPATCH=true` 时 Cloud 不调 `scheduleLocalEngineRun`，只创建任务等待 Agent。

---

## 四、最小修复

### 修复 1：backend 移除 designated 模式单 assignment 限制

- 文件：`backend/api/routes.ts` L1137-1151
- 原因：Test B 多员工 specified 模式被旧校验 `assignments.length !== 1` 拦截，返回 400 "指定模式仅支持单个执行窗口"
- 修复：移除单 assignment 限制，改为循环校验每个 assignment 的 `targetCourierName` 和归属

```typescript
// Phase 2-B / K-2C: 指定模式校验（支持多 assignment designated 模式）
if (executionMode === 'designated') {
  for (const a of assignments) {
    if (!a.targetCourierName) {
      return res.status(400).json({ error: '指定模式每个 assignment 必须选择目标派件员' });
    }
    const targetCheck = await validateAssignmentsBelongToSite(site, [{ staffName: a.targetCourierName, waybillNos: [] } as Assignment]);
    if (!targetCheck.ok) {
      return res.status(400).json({ error: `目标派件员 "${a.targetCourierName}" 不属于当前网点` });
    }
  }
}
```

修复范围符合"允许的最小修复"清单（payload 字段解析兼容 + assignment 循环逻辑）。

---

## 五、测试结果

### Test A：多员工 default 模式 ✅

- taskId：`9be3d2ed-11fb-4036-b130-9575d51e4587`
- 请求：肖飞 3 条（K2C-XF-001~003） + 孟德海 3 条（K2C-MDH-001~003），executionMode=default，browserDryRun=true
- PG tasks 表：status=done, done_count=6, fail_count=0, progress=100, total_count=6

日志分组（source=agent，按 staff_name + window_id 聚合）：

| staff_name | window_id | 日志数 | XF 引用 | MDH 引用 |
| --- | --- | --- | --- | --- |
| 肖飞 | staff:肖飞 | 36 | 2 | 0 |
| 孟德海 | staff:孟德海 | 36 | 0 | 2 |
| (任务级，staff_name 空) | - | 6 | 1 | 1 |

重点检查：
- ✅ 肖飞日志里不出现孟德海单号（xf_refs=2, mdh_refs=0）
- ✅ 孟德海日志里不出现肖飞单号（xf_refs=0, mdh_refs=2）
- ✅ 任务级日志引用首条 XF 和首条 MDH（正常 summary 行为）
- ✅ waybill_results 未全部归到肖飞
- ✅ 不是只处理 assignments[0]

### Test B：多员工 specified 模式 ✅

- taskId：`44f272ec-9635-46a7-b291-d8490c1312f0`
- 请求：
  - assignment 1：孟德海窗口 + 肖飞目标派件员 + K2C-SP1-001~003
  - assignment 2：肖飞窗口 + 孟德海目标派件员 + K2C-SP2-001~003
  - executionMode=designated，browserDryRun=true
- PG tasks 表：status=done, done_count=6, fail_count=0, progress=100, total_count=6

日志分组（source=agent）：

| staff_name | window_id | 日志数 | SP1 引用 | SP2 引用 |
| --- | --- | --- | --- | --- |
| 孟德海 | staff:孟德海 | 36 | 2 | 0 |
| 肖飞 | staff:肖飞 | 36 | 0 | 2 |
| (任务级) | - | 6 | 1 | 1 |

重点检查：
- ✅ assignment 1 使用孟德海凭据登录（executionStaffName=孟德海），未用肖飞凭据
- ✅ assignment 1 页面目标派件员选择肖飞（targetCourierName=肖飞）
- ✅ assignment 2 使用肖飞凭据登录（executionStaffName=肖飞），未用孟德海凭据
- ✅ assignment 2 页面目标派件员选择孟德海（targetCourierName=孟德海）
- ✅ 日志归属按 executionStaffName（孟德海 logs 归孟德海，肖飞 logs 归肖飞）
- ✅ 单号无交叉（孟德海 logs 只引用 SP1，肖飞 logs 只引用 SP2）
- ✅ 未用目标派件员凭据登录
- ✅ 未把目标派件员当执行窗口

### Test C：指定模式缺少目标派件员 ✅

- 请求：1 个 assignment（staffName=肖飞，无 targetCourierName），executionMode=designated
- 结果：backend 400 拦截

```json
{"error":"指定模式每个 assignment 必须选择目标派件员"}
```

重点检查：
- ✅ 该 assignment 未静默按默认模式执行
- ✅ 错误信息明确
- ✅ fail_count 未错误累加（backend 在任务创建前拦截，未生成 task）

### Test D：单 assignment 回归 ✅

#### D1 默认模式

- taskId：`4757e766-d4b9-4b5e-932e-4e47d1a25f4a`（首次 ECONNRESET 重试一次后成功）
- 请求：肖飞 3 条，executionMode=default，browserDryRun=true
- PG tasks 表：status=done, done_count=3, fail_count=0, progress=100, total_count=3
- ✅ 不受多 assignment 改造影响

#### D2 指定模式

- taskId：`36d2effb-30f4-41f5-81e2-02ec255e201c`
- 请求：孟德海窗口 + 肖飞目标派件员 + 3 条，executionMode=designated，browserDryRun=true
- PG tasks 表：status=done, done_count=3, fail_count=0, progress=100, total_count=3
- ✅ 日志归孟德海
- ✅ 页面选择肖飞

### Test E：安全门回归 ✅

#### E1 browserDryRun=true

- 由 Test A/B/D1 覆盖
- ✅ dry-run 跳过最终提交
- ✅ finalSubmitClicked=false

#### E2 browserDryRun=false + ENABLE_REAL_SUBMIT=false

- taskId：`36145531-e758-48ea-ac49-a69ce996b194`
- 请求：browserDryRun=false, dryRunMode=false
- PG tasks 表：status=done, done_count=3, fail_count=0, progress=100, total_count=3
- ✅ 日志显示 browserDryRun=false
- ✅ 进入真实执行准备路径
- ✅ 安全门拦截最终提交（mode=SAFETY_GATE_SKIPPED）
- ✅ finalSubmitClicked=false
- ✅ 未点击最终提交

### Test F：done_count / fail_count 回写 ✅

汇总 PG tasks 表：

| taskId | 测试 | status | done_count | fail_count | progress | total_count |
| --- | --- | --- | --- | --- | --- | --- |
| 9be3d2ed | Test A 多 default | done | 6 | 0 | 100 | 6 |
| 44f272ec | Test B 多 specified | done | 6 | 0 | 100 | 6 |
| 4757e766 | Test D1 单 default | done | 3 | 0 | 100 | 3 |
| 36d2effb | Test D2 单 specified | done | 3 | 0 | 100 | 3 |
| 36145531 | Test E2 安全门 | done | 3 | 0 | 100 | 3 |

重点检查：
- ✅ 多员工 default 6 条全部 dry_run：done_count=6, fail_count=0
- ✅ Test C 指定模式缺目标派件员在 backend 400 拦截，未生成 task（无 fail_count 错误累加）
- ✅ 所有 progress=100

### Test G：run-engine 防误入 ✅

请求 `POST /agent/tasks/:id/run-engine`（Authorization: Bearer <agentToken>）：

| 测试 | taskId | type | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| G1 dispatch | 36145531... | dispatch | 409 | ✅ 409 `TASK_TYPE_MIGRATED_TO_AGENT` "Dispatch 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行" |
| G2 arrival | 30a20a22... | arrival | 409 | ✅ 409 `TASK_TYPE_MIGRATED_TO_AGENT` "Arrival 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行" |
| G3 integrated | 0f946b72... | integrated | 200 compat | ✅ 200 `{accepted:false, skipped:true, reason:"任务状态已是 failed，跳过重复执行"}`（进入 run-engine 路径，因 failed 跳过） |
| G4 sign | e365d6f5... | sign | 200 compat | ✅ 200 `{accepted:false, skipped:true, reason:"任务状态已是 failed，跳过重复执行"}`（进入 run-engine 路径，因 failed 跳过） |

重点检查：
- ✅ Dispatch 迁移保护存在（409）
- ✅ Arrival 迁移保护仍然存在（409）
- ✅ Integrated 保留兼容路径（200，进入 TaskEngineRunner）
- ✅ Sign 保留兼容路径（200，进入 TaskEngineRunner）
- ✅ Dispatch/Arrival 不会进入 TaskEngineRunner / AssignmentEngine

### Test H：Cloud 不执行 Dispatch 浏览器动作 ✅

#### task_logs source 分布（5 个 dispatch 任务）

| source | level | count |
| --- | --- | --- |
| agent | info | 243 |
| agent | success | 38 |
| agent | warning | 2 |
| api | info | 5 |

- ✅ 所有浏览器动作日志 source=agent（283 条）
- ✅ source=api 仅 5 条，全部是任务创建日志：

| task_id | message |
| --- | --- |
| 9be3d2ed | 任务开始: 派件扫描, 员工数=2, 单号数=6 |
| 44f272ec | 任务开始: 派件扫描, 员工数=2, 单号数=6 |
| 4757e766 | 任务开始: 派件扫描, 员工数=1, 单号数=3 |
| 36d2effb | 任务开始: 派件扫描, 员工数=1, 单号数=3 |
| 36145531 | 任务开始: 派件扫描, 员工数=1, 单号数=3 |

#### 禁止日志检查

```sql
SELECT COUNT(*) FROM task_logs
WHERE task_id IN (...)
  AND (message ILIKE '%scheduleLocalEngineRun%'
    OR message ILIKE '%TaskEngineRunner runTask dispatch%'
    OR message ILIKE '%AssignmentEngine execute dispatch%');
-- 结果: forbidden_count = 0
```

- ✅ 无 `scheduleLocalEngineRun dispatch` 日志
- ✅ 无 `TaskEngineRunner runTask dispatch` 日志
- ✅ 无 `AssignmentEngine execute dispatch` 日志
- ✅ Backend 代码 L1209-1210 确认 `AGENT_LOCAL_DISPATCH=true` 时只 log `[AgentLocalDispatch]` 不调 `scheduleLocalEngineRun`

---

## 六、关键代码引用

- 多 assignment 解析：[DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts#L198-L207)
- 单 assignment 独立执行：[DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts#L241-L395)
- specified 缺目标派件员校验：[DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts#L279-L281)
- 安全门硬编码 finalSubmitClicked=false：[DispatchExecutor.ts](file:///e:/网站开发/DaoPaiV3/packages/agent/src/executors/DispatchExecutor.ts#L353)
- complete 回写 done_count/fail_count：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts#L340-L373)
- run-engine Dispatch 409 保护：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts#L181-L188)
- run-engine Arrival 409 保护：[agentRoutes.ts](file:///e:/网站开发/DaoPaiV3/backend/agent/agentRoutes.ts#L173-L180)
- AGENT_LOCAL_DISPATCH 只创建任务：[routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts#L1209-L1212)
- K-2C 最小修复（多 assignment designated 校验）：[routes.ts](file:///e:/网站开发/DaoPaiV3/backend/api/routes.ts#L1137-L1151)

---

## 七、已知限制

1. **Test D1 首次 ECONNRESET**：Agent 浏览器执行成功后回传 Cloud 时网络抖动（ECONNRESET），重试一次后成功。非 K-2C 代码问题，建议后续增强 Agent complete 重试。
2. **Test C 未触发 Agent 端 failAssignment 路径**：backend 在任务创建前 400 拦截，未生成 task。Agent 端 `failAssignment('指定模式缺少目标派件员')` 路径需在 backend 校验放宽时才能触发。当前 backend 严格校验是更安全的行为，符合"任务不应该静默按默认模式执行"。
3. **Integrated / Sign 仍走 Cloud run-engine 兼容路径**：本阶段未迁移，符合任务约束。

---

## 八、验收结论

| 测试 | 结果 |
| --- | --- |
| Test A 多员工 default 模式 | ✅ 通过 |
| Test B 多员工 specified 模式 | ✅ 通过（含 backend 最小修复） |
| Test C 指定模式缺目标派件员 | ✅ 通过（backend 400 拦截） |
| Test D1 单 assignment default 回归 | ✅ 通过（重试一次） |
| Test D2 单 assignment specified 回归 | ✅ 通过 |
| Test E1 browserDryRun=true 安全门 | ✅ 通过（由 A/B/D1 覆盖） |
| Test E2 browserDryRun=false + ENABLE_REAL_SUBMIT=false | ✅ 通过（SAFETY_GATE_SKIPPED） |
| Test F done_count/fail_count 回写 | ✅ 通过（5 任务全部 progress=100） |
| Test G run-engine 防误入 | ✅ 通过（Dispatch/Arrival 409，Integrated/Sign 200 compat） |
| Test H Cloud 不执行 Dispatch 浏览器动作 | ✅ 通过（source=agent 283 条，forbidden_count=0） |

**Phase K-2C-1 验收通过**。Dispatch 多员工 assignments 已真正可用：

- 一个 dispatch task 支持多个 assignments
- 每个 assignment 独立顺序执行
- 每个员工只处理自己的单号（无串号）
- 日志按各自员工/windowId 分组
- 结果按各自员工/windowId 回写
- done_count/fail_count 正确更新
- Cloud 只创建任务，Agent 本地执行浏览器自动化
- Dispatch/Arrival run-engine 防误入保护存在
- Integrated/Sign 保留兼容路径
- 安全门拦截最终提交，未真实提交

---

## 九、本阶段未做（范围外）

- 未迁移 Integrated / Sign 到 Agent 本地执行
- 未删除 run-engine 端点
- 未删除 Cloud local-api
- 未大改数据库
- 未启用真实提交（ENABLE_REAL_SUBMIT 始终 false）
- 未绕过 Agent 用 Cloud 路径冒充通过

所有修改均在"允许的最小修复"清单内。
