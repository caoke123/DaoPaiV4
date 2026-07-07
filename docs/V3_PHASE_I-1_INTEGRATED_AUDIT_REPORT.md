# DaoPai V3 Phase I-1 Integrated 快审报告

> **日期**: 2026-07-03
> **阶段**: Phase I-1（快审，非修复阶段）
> **范围**: 到派一体 Integrated 真实执行链路 + V2/V3 对比 + 修复清单

---

## 1. 真实执行链路结论

| 检查项 | 结论 |
|---|---|
| Integrated route 当前行为 | [routes.ts:1198-1319](../backend/api/routes.ts#L1198-L1319) **只创建 pending task**，立即返回 `{ taskId, status: 'pending' }`。明确注释："integrated 只创建 pending task，等待 Local Agent pull 执行。不再调用 scheduleLocalEngineRun" |
| Agent 是否 pull | **是**。Agent 通过 [index.ts:256](../packages/agent/src/index.ts#L256) `pullTask(client)` → `POST /agent/tasks/pull` 拉取 |
| IntegratedExecutor 是否执行 | **是**。[index.ts:302-307](../packages/agent/src/index.ts#L302-L307) 匹配 `task.type === 'integrated'` 后调用 `executeIntegratedDryRun()` |
| IntegratedBrowserDryRun 是否执行 | **是**。[IntegratedExecutor.ts:541](../packages/agent/src/executors/IntegratedExecutor.ts#L541) `runIntegratedBrowserDryRun(page, {...})` 被调用 |
| task_logs source | **agent**。`AgentLogger` → `uploadLogs` → `POST /agent/tasks/:id/logs`，[agentRoutes.ts:291](../backend/agent/agentRoutes.ts#L291) 固定 `source: 'agent'` |
| 旧 backend/operations/IntegratedScan.ts 是否参与 | **否**。V3 路径完全不经过 V2 的 IntegratedScan.ts。TaskEngineRunner 对 integrated 硬拒绝 ([TaskEngineRunner.ts:22](../backend/services/TaskEngineRunner.ts#L22) `assertNotAgentOnlyBusiness`) |
| 是否存在 local-api / Cloud 抢执行风险 | **否**。`scheduleLocalEngineRun` 已删除，`assertNotAgentOnlyBusiness` 阻止 Cloud 引擎执行 integrated |

### 真实执行链路

```
POST /api/operations/integrated
  → PG insertTask(type:'integrated', status:'pending')
  → 立即返回 { taskId, status: 'pending' }
  → Agent 心跳轮询 POST /agent/tasks/pull
  → Agent 识别 task.type === 'integrated'
  → executeIntegratedDryRun()
    → parseIntegratedAssignments()
    → prepareIntegratedAssignments() — 查询 READY 窗口 + CDP endpoint
    → executeOneIntegratedAssignment() × N (并发 ≤5)
      → BrowserManager.connectExisting(cdpEndpoint) — CDP 接管
      → detectBnsyDashboardP0() — 验证 READY 状态
      → ensureCleanHome()
      → runIntegratedBrowserDryRun(page, {...})  ← 本次补日志入口
```

**结论：链路完整，V2 已完全脱离，无抢执行风险。**

---

## 2. V2/V3 控件对比表

### 2.1 控件 1：到派一体 checkbox

| 项目 | V2 (IntegratedScan.ts) | V3 (IntegratedBrowserDryRun.ts) |
|---|---|---|
| **selector** | `.el-checkbox:has-text("到派一体") .el-checkbox__inner` | 同 |
| **点击方式** | `checkboxLoc.first().click({ timeout })` — 普通 `locator.click()` | `stableClick(checkboxLoc.first())` → waitFor + scrollIntoView + `locator.click()` |
| **目标元素** | `.el-checkbox__inner` ✅ | `.el-checkbox__inner` ✅ |
| **校验方式** | 检查 `.is-checked` count > 0 (单重) | 双重校验：`.is-checked` 类 + `input.checked === true` |
| **等待机制** | `page.waitForTimeout(800)` | `page.waitForFunction(...)` 最长 3s |
| **缺口分析** | - | V3 优于 V2，无需修复 |
| **是否需要修复** | **否** | - |
| **优先级** | - | - |

### 2.2 控件 2：上一站选择

| 项目 | V2 (IntegratedScan.ts) | V3 (IntegratedBrowserDryRun.ts) |
|---|---|---|
| **selector** | `'.arrivalscan_left .el-input--suffix input'` — **宽选择器，会匹配班次** | `findPrevStationInputByLabel()` — **label 文本定位** + `assertNotShiftField()` 双保险 |
| **点击方式** | `page.click()` (Playwright click on input) | 三步拨开：input → suffix → wrapper |
| **候选项选择** | `page.evaluate(el.click())` — **DOM click，绕过 Vue** | 坐标点击 `page.mouse.click()` → 兜底 `locator.click()` |
| **候选项枚举** | 无显式枚举 | **有**。失败时输出可见候选项文本 |
| **反向校验** | `inputValue()` 单重 | **三重**：`input.value` → `el-tag` → `li.selected` |
| **是否误点班次** | **高风险** ⚠️ `.first()` 会命中 Row 2 班次 | **否**。label 文本排除班次 + `assertNotShiftField()` |
| **重试机制** | 无 | 最多 3 次重试 |
| **兜底** | `page.fill()` + Enter | `nth-child(7)` 选择器兜底 |
| **V2 可借鉴点** | - | V3 已全部覆盖并超越 V2 |
| **是否需要修复** | **否** | - |
| **优先级** | - | - |

### 2.3 控件 3：派件员弹窗选择

| 项目 | V2 (IntegratedScan.ts) | V3 (IntegratedBrowserDryRun.ts) |
|---|---|---|
| **派件员 input selector** | `.arrivalscan_left > div > div:nth-child(12) input` | 同 |
| **弹窗 selector** | `div.el-dialog__wrapper:has-text("选择派件员")` | 同 |
| **匹配方式** | employeeId **精确匹配** (`idText === employeeId`) | employeeId 精确匹配 → staffName 包含匹配 兜底 |
| **表格扫描** | `Locator.nth(i).locator('td.el-table_2_column_16')` — Playwright Locator 遍历 | `page.evaluate()` 批量扫描，输出单元格 dump |
| **"使用"按钮点击** | **`fastStableBypassClick`** → `waitFor visible + click({ force: true })` | **`locator.click()`** — 普通 click，无 force |
| **input 回填校验** | ✅ `courierInputValue === staffName` | ✅ `courierInputValue.includes(courierName)` |
| **弹窗未关闭兜底** | ✅ input 已回填视为成功 | ✅ 同 V2 |
| **V2 稳定点击经验** | `fastStableBypassClick` 的 `force: true` 绕过 actionability 检查 | **未迁入** |
| **是否需要修复** | **是** | - |
| **优先级** | P1（弹窗已有 input 回填兜底，风险可控但应迁入 force click） |

### 2.4 控件 4：添加单号按钮

| 项目 | V2 (IntegratedScan.ts) | V3 (IntegratedBrowserDryRun.ts) |
|---|---|---|
| **单号 input selector** | `#waybillNum` | 同 |
| **添加按钮 selector** | `.arrivalscan_left button.el-button--primary` | 同 |
| **点击方式** | **`fastStableBypassClick`** → `waitFor visible + click({ force: true })` | **`locator.click()`** — 普通 click，无 force |
| **输入前校验** | ✅ `actualValue.trim() !== waybillNo.trim()` | ✅ 同 |
| **rowCount 校验** | ✅ `rowsAfter > rowsBefore` | ✅ `rowsNow > rowsBefore`（3s 轮询） |
| **waybillNo 表格校验** | 否（仅 rowCount） | 否（仅 rowCount） |
| **失败消息检测** | 否（仅 `inspectAddFormState` 慢步骤诊断） | ✅ `.el-message--error` 检测，3s 轮询 |
| **no_response 处理** | 无 | ✅ 3s 超时标记 `no_response` |
| **V2 可借鉴点** | `fastStableBypassClick` 的 `force: true` | **未迁入** |
| **是否需要修复** | **是** | - |
| **优先级** | P1（V3 有失败消息检测 + no_response 兜底，但 force click 可提高稳定性） |

### 汇总表

| 控件 | V2 做法 | V3 当前做法 | V3 缺口 | 是否需要修复 | 优先级 |
|---|---|---|---|---|---|
| 到派一体 checkbox | 普通 click + 单重 is-checked 校验 | stableClick + 双重校验(is-checked + input.checked) | 无 | **否** | - |
| 上一站选择 | evaluate DOM click + 单重校验 | label文本定位 + 坐标click + 三重校验 + 3次重试 | 无 | **否** | - |
| 派件员弹窗 | force click("使用"按钮) | 普通 locator.click("使用"按钮) | 缺少 force click | **是** | P1 |
| 添加单号 | force click + rowCount校验 | 普通 locator.click + rowCount + 错误消息检测 | 缺少 force click | **是** | P1 |

---

## 3. 当前 V3 Integrated 日志能力

### 已有 task_logs（来自 IntegratedExecutor.ts）

| 日志项 | 来源位置 |
|---|---|
| `[RuntimeProof] mode=READY_CDP_ATTACH` | IntegratedExecutor.ts:458 |
| 任务开始/结束 | IntegratedExecutor.ts:463-464, 581 |
| CDP 连接成功/失败 | IntegratedExecutor.ts:516-517 |
| Dashboard 验证结果 | IntegratedExecutor.ts:536 |
| dryRunResult 汇总（inputCount/prevStationSelected/checkboxChecked/courierSelected） | IntegratedExecutor.ts:555-565 |
| 安全门状态 | IntegratedExecutor.ts:556-569 |
| 最终完成/失败 | IntegratedExecutor.ts:581, 621 |

### 缺失 task_logs（来自 IntegratedBrowserDryRun.ts — 全部 console.log，零条 task_logs）

| 缺失日志 | 严重程度 |
|---|---|
| ❌ `IntegratedBrowserDryRun ENTER` | **已修复** — Phase I-1 补 `[FIX-I-001]` |
| ❌ 页面导航成功（方法/URL） | 高 — 定位导航失败必须 |
| ❌ 到派一体 checkbox 开始/成功/失败 | 高 — 定位勾选失败必须 |
| ❌ 上一站选择开始/候选项文本/成功/失败 | 高 — 定位选择失败必须 |
| ❌ 派件员弹窗打开/匹配行/点击使用/回填成功/失败 | 高 — 定位匹配失败必须 |
| ❌ 单号添加前 rowCount / 添加后 rowCount / 成功 / 失败 | 中 — 定位单号问题 |
| ❌ 输入前置校验结果 | 中 |
| ❌ dry-run 阻止最终提交 | 低 — IntegratedExecutor 已有 |
| ❌ finalSubmitClicked=false | 低 — 返回值已有 |

**结论：IntegratedBrowserDryRun 不写入任何 task_logs，问题定位完全依赖 console.log（仅本地可见）。下一阶段必须补齐。**

---

## 4. 下一阶段修复清单

### P0 必修

1. **IntegratedBrowserDryRun 日志全量接入 task_logs** — 将全部 console.log 替换为 `log(level, msg, meta)` 调用，覆盖：
   - 导航成功（方法/URL）
   - checkbox 开始/成功/失败
   - 上一站开始/候选项/成功/失败
   - 派件员弹窗打开/匹配行/使用按钮/回填成功/失败
   - 输入前置校验结果
   - 单号添加 rowCount 变化/成功/失败/错误消息

2. **添加单号 button 迁移为 stableClick 或 force click** — 当前 `locator.click()` 存在 Element UI actionability 超时风险

### P1 可优化

1. **派件员"使用"按钮迁移 force click** — 复用 V2 `fastStableBypassClick` 经验，`click({ force: true })` 绕过固定列 actionability 检查
2. **添加单号后校验 waybillNo 出现在表格中** — 当前仅校验 rowCount，不校验具体单号，无法区分单号重复/替换等情况
3. **明确校验"进入派一体模式"** — checkbox 勾选后应有显式检测（如派件员 input 动态出现确认），当前仅靠后续 `selectCourier` 隐式验证

---

## 5. 禁止修改确认

确认本阶段 **未修改**：

- routes.ts ✅
- TaskEngineRunner ✅
- 前端页面 ✅
- Sign 文件 (SignBrowserDryRun.ts 等) ✅
- V2 backend/operations/IntegratedScan.ts ✅
- Arrival/Dispatch 已通过链路 ✅
- 数据库结构 ✅

---

## 6. 少量代码变更说明

| 项目 | 详情 |
|---|---|
| **修改文件** | `packages/agent/src/browser/IntegratedBrowserDryRun.ts` |
| **修改位置** | 第 132-136 行（`runIntegratedBrowserDryRun` 函数入口，步骤 1 之前） |
| **新增代码** | `if (log) { log('info', '[Agent][Integrated][BrowserDryRun][FIX-I-001] ENTER staffName=... windowId=... siteId=...', meta); }` |
| **日志内容** | `[Agent][Integrated][BrowserDryRun][FIX-I-001] ENTER staffName=... windowId=... siteId=...` |
| **日志级别** | `info` |
| **写入方式** | 通过传入的 `log: AgentRuntimeLogFn` 参数 → `AgentLogger.info()` → buffer → `uploadLogs()` → `POST /agent/tasks/:id/logs` (source='agent') |
| **是否在 task_logs 可见** | **是** — 日志通过 AgentLogger buffer 定时/定量 flush 到 task_logs，前端实时日志可见 |

---

## 7. 审查文件清单

### V3 核心文件

| 文件 | 说明 |
|---|---|
| [packages/agent/src/executors/IntegratedExecutor.ts](../packages/agent/src/executors/IntegratedExecutor.ts) | Agent 本地执行器，CDP 接管 + 多员工并行 |
| [packages/agent/src/browser/IntegratedBrowserDryRun.ts](../packages/agent/src/browser/IntegratedBrowserDryRun.ts) | 到派一体扫描浏览器 dry-run 页面操作 |
| [packages/agent/src/browser/IntegratedPageDetector.ts](../packages/agent/src/browser/IntegratedPageDetector.ts) | 到派一体扫描页面 DOM 元素检测 |
| [packages/agent/src/browser/integratedSelectors.ts](../packages/agent/src/browser/integratedSelectors.ts) | 到派一体扫描页面 DOM 选择器常量 |

### V2 对照文件

| 文件 | 说明 |
|---|---|
| [backend/operations/IntegratedScan.ts](../backend/operations/IntegratedScan.ts) | V2 到派一体扫描操作模块（已脱离 V3 执行路径） |

### 路由/引擎文件

| 文件 | 说明 |
|---|---|
| [backend/api/routes.ts](../backend/api/routes.ts#L1198-L1319) | POST /api/operations/integrated 路由 |
| [backend/services/TaskEngineRunner.ts](../backend/services/TaskEngineRunner.ts) | Cloud 引擎（硬拒绝 integrated） |
| [backend/agent/agentRoutes.ts](../backend/agent/agentRoutes.ts) | Agent 端路由（pull/logs/complete/fail） |
| [packages/agent/src/index.ts](../packages/agent/src/index.ts) | Agent 主循环，任务类型分发 |
| [packages/agent/src/httpClient.ts](../packages/agent/src/httpClient.ts) | Agent HTTP 客户端（pullTask/uploadLogs/completeTask/failTask） |
| [packages/agent/src/logger/AgentLogger.ts](../packages/agent/src/logger/AgentLogger.ts) | Agent 端 buffer + 定时 flush 日志器 |
