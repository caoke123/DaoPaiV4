# DaoPai V3 Phase I-3 Integrated 流畅度优化报告

> **日期**: 2026-07-03
> **阶段**: Phase I-3（流畅度优化，不修阻塞）
> **修改文件**: 1 个（IntegratedBrowserDryRun.ts）

---

## 1. 修改文件列表

| 文件 | 修改类别 |
|---|---|
| [packages/agent/src/browser/IntegratedBrowserDryRun.ts](../packages/agent/src/browser/IntegratedBrowserDryRun.ts) | 唯一修改文件，共 4 类修改 |

---

## 2. 任务 1：性能耗时打点

### 新增 task_logs 日志

| 日志 | 含义 | 位置 |
|---|---|---|
| `[Agent][Integrated][perf] prevStation durationMs=...` | 上一站选择总耗时 | 主函数 prevStation 调用后 |
| `[Agent][Integrated][perf] waybillAdd waybillNo=... durationMs=...` | 每条单号添加耗时 | waybill 迭代末尾 |
| `[Agent][Integrated][perf] waybillAddTotal count=N durationMs=... avgMs=...` | 多单号汇总 | waybill 循环结束后 |

---

## 3. 任务 2：上一站选择加速

### 3a. SKIP_ALREADY_SELECTED

在 `stableFillPrevStation` 入口新增已选检查：
- 调用 `verifyPrevStationSelected` 判断
- 已选中 → 直接 `return true`，不打开 dropdown，不点击
- 日志：`[prevStation] SKIP_ALREADY_SELECTED value=...`

### 3b. domClick 快速路径

新增 `clickVisiblePrevStationOptionFast` 函数：
- 使用 `page.evaluate(el.click())`（V2 风格 DOM click）
- 绕过 Playwright actionability 检查，更快
- 修改 `clickVisiblePrevStationOption` 返回类型：`Promise<boolean>` → `Promise<string>`
- 返回值：`'domClick'` / `'mouseClick'` / `'locatorClick'` / `'none'`
- 日志：`[prevStation] CLICK_OPTION method=domClick`

### 3c. 缩短成功路径等待

| 原方案 | 新方案 |
|---|---|
| `waitForTimeout(500)` 固定等待 | `page.waitForFunction(timeout=1200, polling=100)` — 通过立即返回 |
| 再调 `verifyPrevStationSelected` 单次校验 | waitForFunction 内联三重校验（input.value / el-tag / li.selected） |
| 每次重试间 `waitForTimeout(500)` | 每个重试间 `waitForTimeout(300)` |
| 失败后 `waitForTimeout(300)` | 直接继续（不再在异常分支加延迟） |

### 3d. 三点式重试

| 重试 | 点击策略 |
|---|---|
| 第 1 次 | domClick 快速路径 → 未命中则坐标/locator |
| 第 2 次 | 坐标 click → locator click |
| 第 3 次 | 坐标 click → locator click → nth-child 兜底 |

### 3e. OPTIONS 日志 + 失败诊断

- 成功路径：`[prevStation] OPTIONS items=[...]` 仅输出可见候选项文本（最多 10 条）
- 全部失败：`[prevStation] FAIL PREV_STATION_NOT_APPLIED target=... actual=... options=[...]`

---

## 4. 任务 3：单号添加加速

### 4a. locator 预创建

L360-361 已在外层创建 `waybillInput` / `addButtonLoc`，保持不变。

### 4b. 快速路径 rowCount 检测

| 原方案 | 新方案 |
|---|---|
| `while (Date.now() - startTime < 3000)` 每 300ms 轮询 | 先用 `waitForFunction(timeout=1200, polling=100)` 等 rowCount 增加 |
| 每轮同时检查 error message / rowCount / loading | 1200ms 内命中 → 立即 PASS |
| 3s 内无变化 → no_response | 1200ms 未命中 → 进入慢诊断（剩余 ~1800ms）检查 error message + rowCount |

### 4c. 成功路径不截图、不 cleanup

- 成功路径不调用 `afterPageChangedCleanup`
- 失败时才输出 `WAYBILL_ADD_CLICK_NO_EFFECT` 含 `clickMethod` + `rowCountBefore` + `rowCountAfter`
- 失败时才输出 `WAYBILL_ERROR_MESSAGE` 含完整诊断

### 4d. 其他加速

| 改动 | 效果 |
|---|---|
| `waitForTimeout(200)` → `waitForTimeout(100)` | 输入后等待减半 |
| `clickAddButtonStable` / `clickUseButtonStable` 内部不变 | 保持 Phase I-2 稳定性 |

---

## 5. 安全边界确认

本阶段**不改变**安全边界：

- 未新开 Chrome ✅
- 未重新登录 ✅
- 未点击最终提交 ✅（`finalSubmitClicked=false`）
- 未真实提交 ✅
- READY 窗口保持运行 ✅

---

## 6. 期望验收日志变化

### 上一站选择（成功路径）

```
[Agent][Integrated][prevStation] START target=天津分拨中心
[Agent][Integrated][prevStation] SKIP_ALREADY_SELECTED value=天津分拨中心   ← 如果已选中
-- 或 --
[Agent][Integrated][prevStation] OPTIONS items=[...天津分拨中心...]
[Agent][Integrated][prevStation] CLICK_OPTION method=domClick target=天津分拨中心
[Agent][Integrated][prevStation] PASS value=天津分拨中心
[Agent][Integrated][perf] prevStation durationMs=<缩短>
```

### 单号添加（成功路径）

```
[Agent][Integrated][waybill] FILL_OK waybillNo=...
[Agent][Integrated][waybill] BEFORE waybillNo=... rowCount=...
[Agent][Integrated][waybill] CLICK_ADD method=forceClick
[Agent][Integrated][waybill] PASS waybillNo=... rowCountBefore=... rowCountAfter=...
[Agent][Integrated][perf] waybillAdd waybillNo=... durationMs=<缩短>
-- 多单号汇总 --
[Agent][Integrated][perf] waybillAddTotal count=3 durationMs=... avgMs=...
```

---

## 7. 下一阶段建议

1. 单窗口 dry-run 验收，观察 `[perf] prevStation durationMs` 和 `[perf] waybillAdd` 耗时
2. 确认 `SKIP_ALREADY_SELECTED` 在多员工并发场景不误判（每个窗口独立）
3. 如上一站仍慢，检查 domClick 是否实际生效（看 `CLICK_OPTION method=` 日志）
