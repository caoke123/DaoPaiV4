# DaoPai V3 Phase K-2B-1 Dispatch Agent 本地执行 E2E 验收报告

- 阶段：Phase K-2B-1
- 类型：Dispatch Agent 本地执行 E2E 验证
- 时间：2026-07-02
- 执行环境：Cloud backend + Local Agent + 项目便携 Chrome + PostgreSQL
- 上游：Codex Phase K-2B 代码迁移（Dispatch 接入 Agent 本地 DispatchExecutor）

---

## 一、验收目标

确认 Dispatch 已真正迁移到 Agent 本地执行，满足以下硬指标：

| # | 验收项 | 结果 |
|---|--------|------|
| 1 | Cloud 只创建 Dispatch 任务，不 scheduleLocalEngineRun | ✅ 通过 |
| 2 | Agent pull 到 Dispatch 任务 | ✅ 通过 |
| 3 | Agent 使用 DispatchExecutor 本地执行 | ✅ 通过 |
| 4 | Dispatch 不调用 /agent/tasks/:id/run-engine | ✅ 通过 |
| 5 | Cloud 不进入 TaskEngineRunner / AssignmentEngine 执行 Dispatch | ✅ 通过 |
| 6 | 浏览器动作发生在 Agent 本机 | ✅ 通过 |
| 7 | 任务日志 / progress / complete 能回写 Cloud | ✅ 通过 |
| 8 | 任务中心能看到日志和状态 | ✅ 通过 |

---

## 二、环境配置

### 2.1 .env 关键开关

```env
# ── Phase K-2A：Arrival Agent 本地执行开关 ──
AGENT_LOCAL_ARRIVAL=true

# ── Phase K-2B：Dispatch Agent 本地执行开关 ──
AGENT_LOCAL_DISPATCH=true

# ── 安全门：禁止真实提交 ──
ENABLE_REAL_SUBMIT=false
ENABLE_RUNTIME_SCREENSHOTS=0
```

### 2.2 服务进程

- PostgreSQL：127.0.0.1:5436，库 `daopai_v3`
- backend：`npm run dev`，监听 127.0.0.1:3300
- agent：`npm run dev`，主循环拉取 + 本地执行
- 浏览器：项目便携 Chrome `E:\网站开发\DaoPaiV3\Chrome\App\chrome.exe`，独立 profile

### 2.3 代码迁移确认（Codex K-2B 产物）

| 文件 | 关键改动 | 状态 |
|------|----------|------|
| `packages/agent/src/index.ts` L260-269 | dispatch 任务分发到 `executeDispatchDryRun`，不调用 `runTaskWithBackendEngine` | ✅ |
| `packages/agent/src/executors/DispatchExecutor.ts` | 完整本地执行器（payload 解析/登录/页面 DRY-RUN/安全门/回写） | ✅ |
| `packages/agent/src/browser/DispatchBrowserDryRun.ts` | 派件页面 DRY-RUN，硬保护不点击最终提交按钮 | ✅ |
| `backend/api/routes.ts` L1212-1216 | `AGENT_LOCAL_DISPATCH=true` 时只创建任务，跳过 `scheduleLocalEngineRun` | ✅ |
| `backend/agent/agentRoutes.ts` L181-188 | run-engine 对 dispatch 返回 409 `TASK_TYPE_MIGRATED_TO_AGENT` | ✅ |
| `packages/agent/src/AgentSettingsLoader.ts` L211-267 | `getLoginCredentialForStaff` 按员工匹配凭据（执行窗口≠目标派件员场景） | ✅ |

---

## 三、测试 A：默认模式（执行窗口 = 目标派件员）

### 3.1 场景

- 员工：肖飞
- 目标派件员：肖飞
- 单号：8 条测试单号 `SF7654322001` ~ `SF7654322008`
- `browserDryRun=true`
- 预期：执行窗口=肖飞，目标派件员=肖飞，模式=default

### 3.2 操作

- `POST /api/operations/dispatch`
  - body：`{"site":"site-1782121346155","assignments":[{"staffName":"肖飞","waybillNos":[...8条]}],"executionMode":"default","dryRunMode":true,"browserDryRun":true}`
- 返回：`{"taskId":"5b851555-8aea-4f03-a082-1e6efa5fd494","status":"pending"}`

### 3.3 结果

- 任务状态：`done`，progress=100
- 任务用时：约 35 秒（05:36:42 → 05:37:17）
- 日志 staffName=肖飞，windowId=staff:肖飞
- 摘要：`dispatchMode=default, executionStaffName=肖飞, targetCourierName=肖飞, courierSelected=true, finalSubmitClicked=false`
- Agent 日志：`[Agent] 收到 Dispatch 任务，使用 Agent 本地执行器`
- 安全门：`dry-run 跳过最终提交`
- 浏览器：V3 Chrome 启动→登录→进入派件页面→选派件员→输入运单→不点击上传→关闭，无残留进程
- Cloud 日志：未出现 TaskEngineRunner / AssignmentEngine 执行 Dispatch 的痕迹
- 未调用 `/agent/tasks/:id/run-engine`

### 3.4 验证点

| 检查项 | 结果 |
|--------|------|
| 不会真实提交 | ✅ finalSubmitClicked=false |
| 任务不长期 running | ✅ 35 秒完成 |
| 浏览器资源释放 | ✅ V3 Chrome 已关闭，无残留 |
| 不调用 run-engine | ✅ Agent 主循环直接本地执行 |
| Cloud 不执行 Dispatch 浏览器动作 | ✅ Cloud 只创建任务 |

---

## 四、测试 B：指定模式（执行窗口 ≠ 目标派件员）

### 4.1 场景

- 执行窗口：孟德海
- 目标派件员：肖飞
- 单号：8 条测试单号 `SF7654322011` ~ `SF7654322018`
- `browserDryRun=true`
- 预期：用孟德海凭据登录，页面目标派件员选肖飞，日志归孟德海

### 4.2 操作

- `POST /api/operations/dispatch`
  - body：`{"site":"site-1782121346155","assignments":[{"staffName":"孟德海","targetCourierName":"肖飞","waybillNos":[...8条]}],"executionMode":"designated","dryRunMode":true,"browserDryRun":true}`
- 返回：`{"taskId":"03179e06-66e3-4385-9b62-1e54a1348b9e","status":"pending"}`

### 4.3 结果

- 任务状态：`done`，progress=100
- 任务用时：约 31 秒（05:38:40 → 05:39:11）
- 日志 staffName=孟德海（37 条业务日志），windowId=staff:孟德海
- 摘要：`dispatchMode=specified, executionStaffName=孟德海, targetCourierName=肖飞, courierSelected=true, finalSubmitClicked=false`
- Agent 日志：`模式=specified，执行窗口=孟德海，目标派件员=肖飞`
- 派件员选择：`选派件员开始：肖飞` → `派件员选择校验通过：肖飞`
- 单号：`准备填写单号，数量=8，首条=SF7654322011，末条=SF7654322018`

### 4.4 验证点

| 检查项 | 结果 |
|--------|------|
| 不能用肖飞凭据登录 | ✅ 使用孟德海凭据登录 |
| 不能把目标派件员当执行窗口 | ✅ executionStaffName=孟德海，targetCourierName=肖飞 |
| 日志不归属到肖飞窗口 | ✅ 37 条业务日志 staff_name=孟德海，0 条 staff_name=肖飞 |
| 单号不串 | ✅ 8 条单号全部为 SF7654322011~2018 |
| 摘要含 dispatchMode=specified | ✅ |

---

## 五、测试 C：多员工 assignments

### 5.1 场景

- 肖飞：3 条单号 `JD7654322101` ~ `JD7654322103`
- 孟德海：3 条单号 `JD7654322104` ~ `JD7654322106`
- `browserDryRun=true`
- 预期：记录当前 Agent 多 assignment 处理行为（已知限制：只处理 assignments[0]）

### 5.2 操作

- `POST /api/operations/dispatch`
  - body：`{"site":"site-1782121346155","assignments":[{"staffName":"肖飞","waybillNos":[...3条]},{"staffName":"孟德海","waybillNos":[...3条]}],"executionMode":"default","dryRunMode":true,"browserDryRun":true}`
- 返回：`{"taskId":"1e9f022e-069f-4ab3-8081-aa8d4b49364f","status":"pending"}`

### 5.3 结果

- 任务状态：`done`，progress=100
- 任务用时：约 31 秒（05:40:48 → 05:41:19）
- 日志 staffName=肖飞（37 条业务日志），windowId=staff:肖飞
- 摘要：`dispatchMode=default, executionStaffName=肖飞, targetCourierName=肖飞, total=6, inputCount=1, courierSelected=true, finalSubmitClicked=false`
- 单号填写：`准备填写单号，数量=6，首条=JD7654322101，末条=JD7654322106`（6 条全部被收集到肖飞名下）

### 5.4 已知限制（不修复，记录为下一阶段问题）

**当前行为**：`DispatchExecutor.parseDispatchPayload` 在 `packages/agent/src/executors/DispatchExecutor.ts` L127 只取 `assignments[0]` 作为执行员工；`collectWaybills` 收集所有 assignments 的所有单号到第一个 staff 名下。

**影响**：多员工 assignments 任务实际只处理 assignments[0]，assignments[1] 的员工（孟德海）被忽略，其单号被归到 assignments[0]（肖飞）名下。

**符合 K-2B 设计**：本阶段不做大改，记录为下一阶段问题（K-2C 或后续）。

### 5.5 验证点

| 检查项 | 结果 |
|--------|------|
| 任务能正常结束 | ✅ 31 秒完成 |
| 资源释放正常 | ✅ Chrome 已关闭，无残留 |
| 行为已记录 | ✅ 记录为下一阶段问题 |

---

## 六、测试 D：run-engine 防误入

### 6.1 操作

对一个 dispatch task 手动请求：

```
POST /agent/tasks/<taskId>/run-engine
Authorization: Bearer <agentToken>
```

### 6.2 结果

- HTTP 409
- 响应体：

```json
{
  "ok": false,
  "code": "TASK_TYPE_MIGRATED_TO_AGENT",
  "message": "Dispatch 已迁移到 Agent 本地执行，禁止通过 run-engine 兼容路径执行",
  "timestamp": "..."
}
```

### 6.3 验证点

| 检查项 | 结果 |
|--------|------|
| HTTP 409 | ✅ |
| code = TASK_TYPE_MIGRATED_TO_AGENT | ✅ |
| message 包含 "Dispatch 已迁移到 Agent 本地执行" | ✅ |
| 未进入 TaskEngineRunner | ✅ |
| 未进入 AssignmentEngine | ✅ |
| Integrated / Sign 不受影响 | ✅ 仍保留旧兼容路径 |

---

## 七、测试 E：安全门

### 7.1 E1：browserDryRun=true

由 Test A / B / C 覆盖：

- 任务启动时：`[Agent][Dispatch][执行配置] browserDryRun=true`
- 最终提交前：`[Agent][Dispatch] dry-run 跳过最终提交`（info 级别）
- 摘要 mode：`browserDryRun`
- finalSubmitClicked：`false`
- message：`派件扫描浏览器 DRY-RUN 完成，未点击最终提交`

### 7.2 E2：browserDryRun=false + ENABLE_REAL_SUBMIT=false

#### 7.2.1 操作

- `POST /api/operations/dispatch`
  - body：`{"site":"site-1782121346155","assignments":[{"staffName":"肖飞","waybillNos":["E2-SAFE-001","E2-SAFE-002","E2-SAFE-003"]}],"executionMode":"default","dryRunMode":false,"browserDryRun":false}`
- 返回：`{"taskId":"039a5b6a-4ff2-410a-9f48-7c0b52082e26","status":"pending"}`

#### 7.2.2 结果

- 任务状态：`done`，progress=100
- 任务用时：约 31 秒（05:52:06 → 05:52:37）
- 关键日志（区别于 E1）：
  - `[Agent][Dispatch][执行配置] browserDryRun=false`
  - `[Agent][Dispatch][安全门] 未开启 ENABLE_REAL_SUBMIT，跳过最终提交`（warning 级别，任务启动时预警）
  - `[Agent][Dispatch][安全门] 跳过最终提交`（warning 级别，最终提交前拦截）
- 摘要：

```json
{
  "mode": "realSubmitBlockedBySafetyGate",
  "dispatchMode": "default",
  "executionStaffName": "肖飞",
  "targetCourierName": "肖飞",
  "windowId": "staff:肖飞",
  "total": 3,
  "inputCount": 1,
  "courierSelected": true,
  "finalSubmitClicked": false,
  "pageUrl": "https://bnsy.benniaosuyun.com/scanning/dispatchscan",
  "message": "派件扫描已执行到最终提交前，ENABLE_REAL_SUBMIT 未开启，已跳过最终提交"
}
```

#### 7.2.3 验证点

| 检查项 | 结果 |
|--------|------|
| 日志显示 browserDryRun=false | ✅ |
| 进入真实执行准备路径 | ✅ 登录、进页面、选派件员、输入运单全部执行 |
| 安全门拦截最终提交 | ✅ `[安全门] 跳过最终提交` |
| 不点击最终提交 | ✅ finalSubmitClicked=false |
| 不真实提交 | ✅ |
| 任务能正常结束 | ✅ 31 秒完成 |

### 7.3 安全门代码路径确认

`packages/agent/src/executors/DispatchExecutor.ts`：

- L237/255：任务启动时检测 `browserDryRun === false && process.env.ENABLE_REAL_SUBMIT !== 'true'`，输出 warning
- L322-325：最终提交前，安全门分支：
  - `browserDryRun === false && ENABLE_REAL_SUBMIT !== 'true'` → `[安全门] 跳过最终提交`
  - 否则 → `dry-run 跳过最终提交`
- L353：`finalSubmitClicked: false` 硬编码
- L355-357：message 根据 browserDryRun 区分

`packages/agent/src/browser/DispatchBrowserDryRun.ts`：

- L62-69：`assertNotFinalSubmit` 硬保护，按钮文本含"上传/提交/确认/批量/派件/签收/保存/完成/执行/到派"时抛错
- L310：`result.finalSubmitClicked = false` 硬编码

---

## 八、测试 F：日志分组

### 8.1 分组规则

- 默认模式日志进入执行员工分组
- 指定模式日志进入执行窗口员工分组（不归目标派件员）
- 日志 message 中体现目标派件员
- 无 staffName 的日志才进入全局区

### 8.2 PG 统计证据

```
                    id                  |   模式   | total | xiaofei | mengdehai | global
--------------------------------------+----------+-------+---------+-----------+--------
 5b851555-8aea-4f03-a082-1e6efa5fd494 | 默认     |   41  |   37    |     0     |   4
 03179e06-66e3-4385-9b62-1e54a1348b9e | 指定     |   41  |    0    |    37     |   4
 1e9f022e-069f-4ab3-8081-aa8d4b49364f | 多员工   |   41  |   37    |     0     |   4
 039a5b6a-4ff2-410a-9f48-7c0b52082e26 | 安全门E2 |   42  |   38    |     0     |   4
```

### 8.3 验证点

| 检查项 | 结果 | 证据 |
|--------|------|------|
| 默认模式日志进入执行员工分组 | ✅ | Test A：37 条归肖飞 |
| 指定模式日志进入执行窗口员工分组 | ✅ | Test B：37 条归孟德海 |
| 指定模式日志不归目标派件员 | ✅ | Test B：0 条归肖飞 |
| 日志 message 体现目标派件员 | ✅ | Test B：`模式=specified，执行窗口=孟德海，目标派件员=肖飞` |
| 无 staffName 日志才进入全局区 | ✅ | 所有任务 4 条全局日志（任务开始/摘要/结果/完成） |

---

## 九、Cloud 不执行 Dispatch 浏览器动作验证

### 9.1 代码路径确认

`backend/api/routes.ts` L1212-1216：

```typescript
if (process.env.AGENT_LOCAL_DISPATCH === 'true') {
  console.log(`[AgentLocalDispatch] AGENT_LOCAL_DISPATCH=true，dispatch taskId=${taskId} 只创建任务，等待 Agent 本地执行`);
} else {
  scheduleLocalEngineRun(req, taskId, 'dispatch');
}
```

`AGENT_LOCAL_DISPATCH=true` 时，backend 跳过 `scheduleLocalEngineRun`，不调用 TaskEngineRunner / AssignmentEngine。

### 9.2 运行时验证

- 所有 4 个 K-2B-1 测试任务的浏览器动作日志（Chrome 启动、登录、页面导航、选派件员、输入运单）source 均为 `agent`
- Cloud backend 日志只出现 `[AgentLocalDispatch] AGENT_LOCAL_DISPATCH=true，dispatch taskId=... 只创建任务，等待 Agent 本地执行`
- 未出现 TaskEngineRunner / AssignmentEngine 执行 Dispatch 的日志

---

## 十、允许的最小修复

本次 E2E 未触发任何代码修复。Codex K-2B 代码迁移完整，所有测试一次通过。

唯一补充的环境配置：

- `.env` 新增 `AGENT_LOCAL_DISPATCH=true`（K-2B 启动开关）

---

## 十一、已知限制（不在本阶段修复）

### 11.1 多员工 assignments 只处理 assignments[0]

- 文件：`packages/agent/src/executors/DispatchExecutor.ts` L127
- 行为：`const firstAssignment = assignments[0] || {};`
- 影响：多员工任务实际只处理 assignments[0]，assignments[1+] 员工被忽略，其单号被归到 assignments[0] 员工名下
- 处理：记录为下一阶段问题（K-2C 或后续），本阶段不大改

### 11.2 DRY-RUN 只输入第一条单号验证

- 文件：`packages/agent/src/browser/DispatchBrowserDryRun.ts` L251-265
- 行为：`const testWaybill = waybills[0];` 只输入第一条运单做校验
- 影响：inputCount 永远为 1，不验证全部单号输入
- 处理：符合 DRY-RUN 设计，不修改

### 11.3 PG waybill_results 计数未回写

- 行为：Agent 完成任务后回传 results，但 PG tasks 表 done_count/fail_count 仍为 0
- 影响：任务中心 progress 显示 100% 但 done_count=0
- 处理：不在本阶段修复，记录为下一阶段问题

---

## 十二、总结

### 12.1 K-2B 迁移目标达成

Dispatch 已真正迁移到 Agent 本地执行：

1. ✅ Cloud 只创建 Dispatch 任务，不进入 TaskEngineRunner / AssignmentEngine
2. ✅ Agent 主循环 pull 到 Dispatch 任务，分发到 `executeDispatchDryRun`
3. ✅ Agent 使用 DispatchExecutor 本地执行（登录、页面导航、选派件员、输入运单、安全门）
4. ✅ Dispatch 不调用 `/agent/tasks/:id/run-engine`（Agent 主循环直接处理）
5. ✅ 浏览器动作发生在 Agent 本机（Chrome 启动/关闭日志在 Agent 侧）
6. ✅ 任务日志 / progress / complete 回写 Cloud（PG task_logs 表）
7. ✅ run-engine 防误入返回 409 `TASK_TYPE_MIGRATED_TO_AGENT`
8. ✅ Integrated / Sign 仍保留 Cloud run-engine 兼容路径

### 12.2 六组测试结果

| 测试 | 场景 | 任务 ID | 结果 |
|------|------|---------|------|
| A | 默认模式（肖飞窗口=肖飞派件员） | 5b851555 | ✅ 通过 |
| B | 指定模式（孟德海窗口，肖飞目标派件员） | 03179e06 | ✅ 通过 |
| C | 多员工 assignments | 1e9f022e | ✅ 通过（已知限制：只处理 assignments[0]） |
| D | run-engine 防误入 | - | ✅ 通过 |
| E1 | 安全门 browserDryRun=true | 由 A/B/C 覆盖 | ✅ 通过 |
| E2 | 安全门 browserDryRun=false+ENABLE_REAL_SUBMIT=false | 039a5b6a | ✅ 通过 |
| F | 日志分组 | 由 A/B/C/E2 覆盖 | ✅ 通过 |

### 12.3 安全保障

- ✅ 未启用真实提交（`ENABLE_REAL_SUBMIT=false`）
- ✅ DispatchBrowserDryRun 硬编码 `finalSubmitClicked=false`
- ✅ `assertNotFinalSubmit` 硬保护，禁止点击疑似最终提交按钮
- ✅ 安全门 E2 验证：browserDryRun=false 时仍被安全门拦截

### 12.4 下一阶段建议

1. K-2C：DispatchExecutor 多员工 assignments 支持（按 assignment 循环执行）
2. PG waybill_results 计数回写修复
3. Integrated / Sign 迁移到 Agent 本地执行（K-2D / K-2E）
