# DaoPai V3 Phase I-4 Integrated 快速输入与上一站去重复优化报告

> **日期**: 2026-07-03
> **修改文件**: 1 个（IntegratedBrowserDryRun.ts）

---

## 1. 修改汇总

| # | 任务 | 改动 | 状态 |
|---|---|---|---|
| 1 | `readIntegratedRightTotal` | 新增函数，读取右侧分页"共 N 条" | 完成 |
| 2 | `verifyPrevStationLight` | 新增函数，只读 input.value + 行级 textContent，不点下拉 | 完成 |
| 3 | waybill 循环重写 | 快速输入 + TOTAL_BEFORE/TOTAL 汇总，移除逐条错误等待 | 完成 |
| 4 | RESELECT_AFTER_COURIER | 强制重选 → `VERIFY_AFTER_COURIER` 轻量校验 | 完成 |
| 5 | RESELECT_BEFORE_WAYBILL | 强制重选 → `VERIFY_BEFORE_WAYBILL` 轻量校验 | 完成 |
| 6 | stableFillPrevStation | 入口增加 `SKIP_ALREADY_SELECTED` | 完成 |
| 7 | precheck 日志 | `waybillCount` → `attempted` | 完成 |
| 8 | result.message | 改为 `attempted=N, 页面实际接收=N, pageTotal=N` | 完成 |

---

## 2. 单号添加：快速输入模式

### 原逻辑

每条单号添加后：
- rowCount 轮询等待（fast：1200ms → slow：1800ms）
- 错误消息检测
- no_response 3s 兜底
- per-waybill diagnostics dump
- 逐条 `PASS` / `WAYBILL_ERROR_MESSAGE` 日志

### 新逻辑

```
TOTAL_BEFORE → for each: fill + click + 150ms → FAST_ADD log → TOTAL (page total)
```

- 只做 input.value 写入校验 + 点击 + 150ms 短等待
- "上一站不能为空"仍拦截批次
- 不逐条判断"单号不存在"
- 最终以右侧分页"共 N 条"为准

### 预期性能

| 指标 | 原 | 新 |
|---|---|---|
| 每条约 704ms | → 目标 150-350ms/条 |

---

## 3. 上一站：去重复选择

### 原逻辑（3 次完整选择）

```
1. START → stableFillPrevStation（首次）  → 打开 dropdown → V2_LEGACY_CLICK
2. RESELECT_AFTER_COURIER → stableFillPrevStation → 再次打开 dropdown
3. RESELECT_BEFORE_WAYBILL → stableFillPrevStation → 再次打开 dropdown
```

### 新逻辑

```
1. START → stableFillPrevStation（首次，SKIP_ALREADY_SELECTED 已跳过）→ 选择一次
2. VERIFY_AFTER_COURIER → verifyPrevStationLight → matched=true → 跳过
3. VERIFY_BEFORE_WAYBILL → verifyPrevStationLight → matched=true → 跳过
```

- 仅首次做完整选择
- 后续用轻量校验（50-150ms），只读 input.value + 行级 textContent
- 值丢失才补选

---

## 4. 新增函数

### `readIntegratedRightTotal(page)`

- 读 `.arrivalscan_right .el-pagination__total` → 解析"共 N 条"
- 3 级选择器兜底
- 失败返回 null + warning 日志，不中断任务

### `verifyPrevStationLight(page, target)`

- 只读 `input.value` + 行级 `textContent`（含 el-tag）
- 不点击、不打开 dropdown、不扫描候选项
- 目标 50-150ms

---

## 5. 预期日志

### 上一站

```
[prevStation] SKIP_ALREADY_SELECTED value=天津分拨中心                      ← 或选择一次后
[prevStation] VERIFY_AFTER_COURIER matched=true value=天津分拨中心           ← 轻量校验
[prevStation] VERIFY_BEFORE_WAYBILL matched=true value=天津分拨中心          ← 轻量校验
```

### 单号

```
[waybill] TOTAL_BEFORE pageTotal=1
[waybill] FAST_ADD index=1/25 waybillNo=... method=forceClick durationMs=200
[waybill] FAST_ADD index=25/25 waybillNo=... method=forceClick durationMs=220
[waybill] TOTAL attempted=25 beforeTotal=1 afterTotal=1 actualAdded=0 durationMs=5500 avgMs=220
```

### precheck

```
[precheck] PASS checkbox=true prevStation=true courier=true attempted=25
```

---

## 6. 安全边界确认

- 未新开 Chrome ✅
- 未重新登录 ✅
- 未点击最终提交 ✅（`finalSubmitClicked=false`）
- 未真实提交 ✅
- 首次上一站选择可靠性保留 ✅
- 补选逻辑保留（`VALUE_LOST` 时触发）✅
