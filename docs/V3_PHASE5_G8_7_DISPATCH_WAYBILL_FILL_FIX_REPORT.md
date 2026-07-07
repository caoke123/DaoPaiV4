# DaoPai V3 Phase 5-G-8-7：派件扫描填写单号失败修复报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-7  
**修复目标**: 派件扫描页面单号无法成功写入的问题

---

## 一、修改文件列表

| 文件 | 修改内容 |
|------|---------|
| [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts) | 新增 `locateDispatchWaybillInput` + `fillDispatchWaybill`，替换原有 `page.fill` 逻辑 |

---

## 二、根因说明

派件扫描填写单号失败的真实原因是以下问题的组合：

### 1. 选择器匹配问题

原选择器：
```
.dispatchscan_left .el-form-item:has(label:has-text("运单"), label:has-text("单号")) input.el-input__inner,
.dispatchscan_left input.el-input__inner[placeholder*="单号"],
.dispatchscan_left input.el-input__inner[placeholder*="运单"]
```

问题：`:has(label:has-text("运单"), label:has-text("单号"))` 需要同时存在两个 label（一个含"运单"、一个含"单号"），如果页面只有一个"运单号" label 就不匹配。

### 2. `page.fill()` strict mode 问题

`page.fill(selector, value)` 在选择器匹配多个元素时可能抛 strict mode violation，或匹配到错误的 input（如派件员下拉框的 input）。

### 3. 填写后没有触发 Vue input/change 事件

Element UI / Vue 控件在 `fill()` 后可能不响应，需要手动触发 `input` 和 `change` 事件才能让 Vue 更新 v-model 绑定的值。

### 4. 没有等待元素可见/可编辑

原代码直接 `page.fill()`，没有先等待输入框 visible 和 enabled，页面未稳定时填写会失败。

---

## 三、修复方式

### 1. 精准定位输入框（`locateDispatchWaybillInput`）

三级定位策略：

| 策略 | 说明 |
|------|------|
| 策略 1 | 原语义选择器（label/placeholder 匹配） |
| 策略 2 | `.dispatchscan_left` 内所有 `input.el-input__inner`，排除 `.el-select` 内的（派件员下拉框） |
| 策略 3 | 所有可见 `input.el-input__inner` 兜底 |

策略 2 的关键：通过 `el.closest('.el-select')` 判断 input 是否在 el-select 内，排除派件员下拉框。

### 2. 稳定填写（`fillDispatchWaybill`）

```
1. 精准定位输入框
2. 等待 visible + enabled
3. 填写前清理弹窗（drainNativeAlerts 500ms）
4. 清空（click → Ctrl+A → Backspace）
5. fill() 写入
6. 验证 inputValue()
7. 失败 → evaluate 触发 Vue input/change 事件兜底
8. 再次验证 inputValue()
9. 仍失败 → 抛出明确错误
```

### 3. Vue 事件触发兜底

```typescript
await inputLoc.evaluate((el, value) => {
  const element = el as HTMLInputElement;
  const proto = window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}, waybillNo);
```

### 4. 填写后校验

```typescript
const actualValue = await inputLoc.inputValue().catch(() => '');
if (actualValue.trim() !== waybillNo.trim()) {
  // 兜底 + 再次校验
}
```

---

## 四、日志样例

### 成功路径

```
[派件扫描-肖飞] 单号输入框已定位（语义选择器），候选数量：1
[派件扫描-肖飞] fill 后校验通过
```

### 兜底路径

```
[派件扫描-肖飞] 语义选择器未命中，尝试排除 el-select 兜底定位
[派件扫描-肖飞] 单号输入框已定位（排除 el-select 兜底），候选索引：1
[派件扫描-肖飞] fill 后校验失败(实际="")，尝试 input/change 事件兜底
[派件扫描-肖飞] evaluate 兜底写入成功
```

### 失败路径

```
[派件扫描-肖飞] 单号输入框定位失败：所有策略均未找到可用 input
→ 抛出: 单号输入框定位失败
```

或

```
[派件扫描-肖飞] fill 后校验失败(实际="")，尝试 input/change 事件兜底
→ 抛出: 单号填写失败：预期="SF12345678", 实际="", inputValue.length=0
```

---

## 五、与到派一体的关系

派件扫描和到派一体**不共用**填写单号逻辑：
- 派件扫描：`DispatchScan.ts` → `fillDispatchWaybill` → 选择器 `.dispatchscan_left input.el-input__inner`
- 到派一体：`IntegratedScan.ts` → `INTEGRATED_SCAN_SELECTORS.waybillInput` → 选择器 `#waybillNum`

本次只修改派件扫描，不影响到派一体。

---

## 六、编译验证

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 七、手动测试建议

### A. 单员工派件扫描

1. 启动肖飞窗口
2. 执行派件扫描 dry-run（3条单号）
3. 检查日志是否有"单号输入框已定位"和"fill 后校验通过"

### B. 多员工派件扫描

1. 启动肖飞/孟德海/刘磊三个窗口
2. 各执行派件扫描 dry-run
3. 检查每个窗口单号独立写入，不串号

### C. 页面有弹窗时

1. 等待充值弹窗出现
2. 执行派件扫描
3. 检查填写前清理弹窗，仍能写入

### D. 选择器不匹配时

1. 如果语义选择器不匹配
2. 检查日志是否输出"排除 el-select 兜底定位"
3. 检查是否成功定位到正确的 input

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工测试派件扫描 dry-run 验证单号写入
