# DaoPai V3 Phase I-2 Integrated 修复报告

> **日期**: 2026-07-03
> **阶段**: Phase I-2（最小稳定性修复）
> **修改文件**: 1 个（IntegratedBrowserDryRun.ts）

---

## 1. 修改文件列表

| 文件 | 修改点 |
|---|---|
| [packages/agent/src/browser/IntegratedBrowserDryRun.ts](../packages/agent/src/browser/IntegratedBrowserDryRun.ts) | 唯一修改文件，共 6 类修改 |

### 修改明细

1. **入口日志** — LOG L134-135：FIX-I-001 → FIX-I-002，统一使用 `log?.()` 语法
2. **导航成功日志** — L166：新增 `[BrowserDryRun] 导航成功`
3. **checkbox 日志** — 新增 `[checkbox] START` / `[checkbox] PASS` / `[checkbox] FAIL`（含 CHECKBOX_NOT_FOUND / CHECKBOX_NOT_CHECKED）
4. **上一站日志** — 新增 `[prevStation] START` / `[prevStation] PASS` / `[prevStation] FAIL`（含 PREV_STATION_NOT_APPLIED），`stableFillPrevStation` 签名新增 `log?` / `meta?` 参数
5. **派件员弹窗日志** — 新增 `[courier] DIALOG_OPENED` / `[courier] MATCH` / `[courier] CLICK_USE` / `[courier] PASS` / `[courier] FAIL`（含 COURIER_ROW_NOT_FOUND / COURIER_USE_CLICK_NO_EFFECT），`selectCourier` 签名新增 `log?` / `meta?` 参数
6. **派件员"使用"按钮** — 原 `locator.click()` → `clickUseButtonStable()`（forceClick → mouseClick 坐标兜底）
7. **添加单号按钮** — 原 `locator.click()` → `clickAddButtonStable()`（forceClick → mouseClick 坐标兜底）
8. **单号添加日志** — 新增 `[waybill] FILL_OK` / `[waybill] BEFORE` / `[waybill] CLICK_ADD` / `[waybill] PASS` / `[waybill] FAIL`（含 WAYBILL_VALUE_NOT_APPLIED / WAYBILL_ADD_CLICK_NO_EFFECT / WAYBILL_ERROR_MESSAGE）
9. **前置校验日志** — 新增 `[precheck] PASS` / `[precheck] FAIL`
10. **安全边界日志** — 新增 `[safety] DRY_RUN=true finalSubmitClicked=false`
11. **稳定点击工具函数** — 文件末尾新增 `clickUseButtonStable()` 和 `clickAddButtonStable()`

---

## 2. task_logs 接入情况

### 已接入（可通过前端实时日志查看）

| 日志标记 | 内容 | 级别 |
|---|---|---|
| `[FIX-I-002] ENTER` | 函数入口，含 staffName/windowId/siteId | info |
| `[BrowserDryRun] 导航成功` | method + url | info |
| `[checkbox] START` | 标记开始 | info |
| `[checkbox] PASS` | checked=true inputChecked=true / (already checked) | info |
| `[checkbox] FAIL` | CHECKBOX_NOT_FOUND / CHECKBOX_NOT_CHECKED / 异常 | error |
| `[prevStation] START` | target | info |
| `[prevStation] PASS` | value | info |
| `[prevStation] FAIL` | PREV_STATION_NOT_APPLIED | error |
| `[courier] DIALOG_OPENED` | 弹窗已出现 | info |
| `[courier] MATCH` | employeeId + staffName + matchType + row | info |
| `[courier] CLICK_USE` | method=forceClick/mouseClick | info |
| `[courier] PASS` | inputValue 已回填 | info |
| `[courier] FAIL` | COURIER_ROW_NOT_FOUND / COURIER_USE_CLICK_NO_EFFECT | error |
| `[waybill] FILL_OK` | waybillNo + value | info |
| `[waybill] BEFORE` | waybillNo + rowCount | info |
| `[waybill] CLICK_ADD` | waybillNo + method | info |
| `[waybill] PASS` | waybillNo + rowCountBefore + rowCountAfter | info |
| `[waybill] FAIL` | WAYBILL_VALUE_NOT_APPLIED / WAYBILL_ADD_CLICK_NO_EFFECT / WAYBILL_ERROR_MESSAGE | error/warning |
| `[precheck] PASS` | checkbox=true prevStation=true courier=true waybillCount | info |
| `[precheck] FAIL` | 失败字段列表 | error |
| `[safety]` | DRY_RUN=true finalSubmitClicked=false | info |

### 保留的 console.log

所有原有 `console.log` 全部保留，task_logs 为增量添加。

---

## 3. 派件员"使用"按钮修复

| 项目 | 原方案 | 新方案 |
|---|---|---|
| 点击方式 | `useButtonLoc.click({ timeout: 5_000 })` — 普通 click | `clickUseButtonStable()` |
| 策略 | 无兜底 | Strategy 1: `click({ force: true })` → Strategy 2: `page.mouse.click(x, y)` 坐标点击 |
| 成功校验 | 弹窗关闭 + input.value 包含 courierName | 不变（V2 已验证逻辑） |
| 弹窗未关闭兜底 | input 已回填视为成功 | 不变 |
| 失败分类 | 无 | COURIER_USE_BUTTON_NOT_FOUND / COURIER_USE_CLICK_NO_EFFECT |
| task_logs | 无 | CLICK_USE method / PASS / FAIL |

**函数位置**: [IntegratedBrowserDryRun.ts#L1118-L1157](../packages/agent/src/browser/IntegratedBrowserDryRun.ts#L1118-L1157)

---

## 4. 添加单号"添加"按钮修复

| 项目 | 原方案 | 新方案 |
|---|---|---|
| 点击方式 | `addButtonLoc.click({ timeout: 5000 })` — 普通 click | `clickAddButtonStable()` |
| 策略 | 无兜底 | Strategy 1: `click({ force: true })` → Strategy 2: `page.mouse.click(x, y)` 坐标点击 |
| rowCount 校验 | rowsAfter > rowsBefore（3s 轮询） | 不变 |
| 错误消息检测 | `.el-message--error` 检测 | 不变 |
| no_response 处理 | 3s 超时标记 | 不变 |
| 失败分类 | 无结构化分类 | WAYBILL_VALUE_NOT_APPLIED / WAYBILL_ADD_CLICK_NO_EFFECT / WAYBILL_ERROR_MESSAGE |
| task_logs | 无 | FILL_OK / BEFORE / CLICK_ADD / PASS / FAIL |

**函数位置**: [IntegratedBrowserDryRun.ts#L1168-L1200](../packages/agent/src/browser/IntegratedBrowserDryRun.ts#L1168-L1200)

---

## 5. 前置校验日志补强

**PASS 日志**:
```
[Agent][Integrated][precheck] PASS checkbox=true prevStation=true courier=true waybillCount=3
```

**FAIL 日志**:
```
[Agent][Integrated][precheck] FAIL reason=PRE_CHECK_FAILED failed=到派一体勾选,派件员选择
```

---

## 6. 安全边界确认

本阶段修改**不改变任何安全边界**：

- 未新开 Chrome ✅（仍使用 `BrowserManager.connectExisting(cdpEndpoint)` CDP 接管）
- 未重新登录 ✅（仍验证 `Dashboard P0 = READY` 后直接执行）
- 未点击最终提交 ✅（`finalSubmitClicked=false` 保持不变）
- 未真实提交 ✅（上传按钮仅检测不点击）
- READY 窗口保持运行 ✅（finally 块确认浏览器由 Backend 管理）

---

## 7. 下一阶段建议

1. **单窗口 dry-run 验收** — 1个员工+1个测试单号 / 1个员工+3个测试单号，检查 task_logs 完整性
2. **多员工并发 dry-run 验收** — 多员工并发稳定性验证
3. **如失败按 staffName/windowId 分析** — 根据新增 task_logs 快速定位

---

## 8. 禁止修改确认

本阶段**未修改**：

- routes.ts ✅
- TaskEngineRunner ✅
- IntegratedExecutor.ts ✅（仅为调用方传参，未改逻辑）
- IntegratedPageDetector.ts ✅
- integratedSelectors.ts ✅
- 前端页面 ✅
- Sign 相关文件 ✅
- Arrival/Dispatch 已通过链路 ✅
- V2 backend/operations/IntegratedScan.ts ✅
- 数据库结构 ✅
- 任务中心页面 ✅
