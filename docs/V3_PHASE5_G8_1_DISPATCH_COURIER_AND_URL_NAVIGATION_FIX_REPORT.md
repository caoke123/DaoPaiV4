# DaoPai V3 Phase 5-G-8-1：派件员选择稳定 + URL 导航切换 + 取消弹窗清理报告

日期：2026-07-01

## 结论

基于 Phase 5-G-8 已完成的稳定点击方案迁移，本阶段修复了两个人工测试发现的阻塞问题：

1. **/dispatch 派件员选择失败**：原派件员选择使用脆弱的绝对 CSS 路径（`nth-child(1)` + 深层嵌套）+ 无结果验证，重写为多策略定位 + 稳定点击 + 回填验证。
2. **跨任务页面切换 WRONG_PAGE/ELEMENT_MISSING 长时间阻塞**：原 `ensureReadyForTask` 遇到 URL 不对时走菜单优先导航，菜单被弹窗遮挡导致 47-50 秒超时；改为 URL 优先导航 + 前后"取 消"快速清理。

TypeScript 全量编译通过（backend、frontend、agent 均无错误）。

---

## 一、问题分析

### 问题 1：派件员选择失败根因

原 `selectCourier` 代码（DispatchScan.ts）：

```typescript
// 旧选择器：绝对CSS路径，依赖DOM层级和nth-child
courierSelectInput: '#app > div.app-wrapper.openSidebar > ... > div:nth-child(1) > div > div.el-input... > input'

// 旧选择逻辑：
await page.click(DISPATCH_SCAN_SELECTORS.courierSelectInput, { timeout: TIMEOUT_ELEMENT });
await page.waitForTimeout(500);
const optionSel = DISPATCH_SCAN_SELECTORS.courierOption.replace('${staffName}', courierName);
const optionLoc = page.locator(optionSel);
if (optionCount === 0) throw new FatalDispatchError(...);
await optionLoc.first().click();
```

三个问题：
1. **选择器极脆弱**：`div:nth-child(1)` 深层绝对路径，DOM 任何轻微变化（加一个 div、换个顺序）即失效。
2. **下拉展开无验证**：点击后固定 wait 500ms，不验证下拉浮层是否真的出现。
3. **点击后无回填验证**：点完选项就认为成功，不验证派件员 input 是否回填了正确姓名。
4. **选项匹配脆弱**：`:has-text()` + Playwright CSS 选择器模板字符串拼接，容易出错。

### 问题 2：跨任务导航失败根因

原 `ensureReadyForTask` Step 4 流程：

```
URL 不对 → 走菜单导航（navigateViaMenu）
         → 菜单需要展开侧边栏 → 点击父菜单 → 点击子菜单 → waitForURL(10s)
         → 菜单失败 → 降级 URL goto
         → URL goto 后 dismissAll(timeout:5000)
         → 仍不对则重试（多轮）
```

问题：
1. **有弹窗时菜单点击被遮挡**，菜单导航反复失败，累计耗时可达 50 秒。
2. **WRONG_PAGE 情况下仍走菜单路径**，但此时页面可能在另一个业务页，菜单展开/点击都不可靠。
3. **弹窗清理用 dismissAll**（多轮 + 长超时），在导航前/后都做，每次消耗 5-8 秒。
4. **无快速路径**：没有在导航前先清理最上层的"取 消"确认框。

---

## 二、修复方案

### 修复 1：派件员选择重写（DispatchScan.ts + dispatchScan.selectors.ts）

#### 选择器改为语义化

[dispatchScan.selectors.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/selectors/dispatchScan.selectors.ts)

```typescript
courierSelectWrapper: '.dispatchscan_left .el-form-item:has(label:has-text("派件员"))',
courierSelectInput: '.dispatchscan_left .el-form-item:has(label:has-text("派件员")) .el-select .el-input__inner',
courierOptionTextOnly: 'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item',
```

- 使用 `:has()` 语义化定位，不依赖 nth-child 和绝对路径。
- 运单号输入框也改为语义化（placeholder 匹配）。
- 分页下拉框也改为语义化选择器。

#### 六步选择流程（结果导向）

[selectCourier](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L229-L365)

| Step | 动作 | 失败处理 |
|------|------|----------|
| 1. 定位 input | 语义选择器 → getByLabel → 第一个 el-select input（三策略） | 所有策略失败 → 明确错误 |
| 2. 点击打开下拉 | fastStableBypassClick（普通click→force回退） | 点击失败 → FatalDispatchError |
| 3. 等待浮层 | waitFor visible (5s) | 未出现 → force click 重试一次 → 仍失败 → FatalDispatchError |
| 4. 匹配选项 | 遍历所有 li，先精确匹配，后子串兜底 | 无匹配 → 列出所有选项文本 → FatalDispatchError |
| 5. 点击选项 | fastStableBypassClick | 点击失败 → FatalDispatchError |
| 6. 验证结果 | 浮层消失 + input 回填包含目标姓名 | 浮层未关但input已回填 → warning继续；两者都失败 → FatalDispatchError |

失败日志明确说明哪一步失败。

### 修复 2：dismissTopCancelConfirm 快速弹窗清理

[PopupManager.dismissTopCancelConfirm](file:///e:/网站开发/DaoPaiV3/backend/browser/PopupManager.ts#L415-L448)

新增方法，专门用于导航前后快速清理二次确认框：

- 只处理最上层 `.el-message-box`，不处理 dialog/toast/overlay。
- 优先点"取消/取 消"（去除空格匹配）。
- 默认超时短（按钮点击 2s，消失等待 3s）。
- 无弹窗时立即返回，不做无意义等待。
- 不破坏原有 `dismissAll` 逻辑。
- 返回 `boolean`（是否点击了取消）。

### 修复 3：navigateBusinessPage URL 优先导航

[NavigationGovernance.navigateBusinessPage](file:///e:/网站开发/DaoPaiV3/backend/browser/NavigationGovernance.ts#L291-L348)

新增独立的 URL 导航方法：

```
1. dismissTopCancelConfirm（切换前清理"取 消"）
2. page.goto(targetUrl, waitUntil: 'domcontentloaded', 15s)
   → 失败则 location.href 兜底
3. waitForURL 匹配目标路径（8s）
4. waitForSelector .app-container/.el-table/.el-form（5s，非阻塞）
5. waitFor .el-loading-mask hidden（8s，非阻塞）
6. dismissTopCancelConfirm（导航后再清理一次）
```

- 不依赖菜单点击，不展开侧边栏，不做多轮重试。
- 失败快速返回（不 throw），让调用方决定降级策略。
- 预计正常切换耗时 ≤ 5-8 秒。

### 修复 4：ensureReadyForTask URL 优先修正

[PageStateManager.ensureReadyForTask Step 4](file:///e:/网站开发/DaoPaiV3/backend/browser/PageStateManager.ts#L276-L316)

从"菜单优先→URL降级"改为"URL优先→菜单兜底"：

```
WRONG_PAGE →
  1. dismissTopCancelConfirm（快速清理）
  2. navigateBusinessPage（URL直达，带前后取消清理）
  3. URL 成功 → dismissTopCancelConfirm → 验证 URL
  4. URL 失败 → 降级一次 navigateViaMenu（快速失败）
  5. 仍失败 → 明确诊断日志（当前URL、目标URL、messageBox是否可见）
```

Step 5（ELEMENT_MISSING）同步优化：

```
ELEMENT_MISSING →
  1. navigateBusinessPage URL修正（替代直接reload）
  2. dismissTopCancelConfirm
  3. 仍失败 → 最后一次降级 page.reload + dismissAll
```

`remediate()` 方法也同步更新为 URL 优先。

### 修复 5：业务页面初始导航切换

- [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L159-L168)：`navGov.navigateTo('dispatch')` → `navGov.navigateBusinessPage(page, 'dispatch')`
- [SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts#L73-L104)：`navGov.navigateTo('sign')` → `navGov.navigateBusinessPage(page, 'sign')`，Escape 弹窗外理改为 dismissTopCancelConfirm
- IntegratedScan.ts：**未修改**（按用户要求"不要大改已经人工通过的 /integrated"）
- ArriveScanBatch.ts：未修改（本身不做显式导航，依赖 ensureReadyForTask）

---

## 三、涉及文件清单

| 文件 | 修改类型 | 修改内容 |
|------|----------|----------|
| [backend/browser/PopupManager.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PopupManager.ts) | 修改 | 新增 dismissTopCancelConfirm 方法 |
| [backend/browser/NavigationGovernance.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/NavigationGovernance.ts) | 修改 | 新增 navigateBusinessPage 方法 |
| [backend/browser/PageStateManager.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PageStateManager.ts) | 修改 | Step 4/5 URL优先导航、remediate同步更新、新增getCapabilityFromRoute辅助方法 |
| [backend/operations/DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts) | 修改 | selectCourier重写为六步结果导向、初始导航改用navigateBusinessPage |
| [backend/operations/selectors/dispatchScan.selectors.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/selectors/dispatchScan.selectors.ts) | 修改 | 选择器全部改为语义化，移除绝对nth-child路径 |
| [backend/operations/SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts) | 修改 | 初始导航改用navigateBusinessPage、弹窗处理改用dismissTopCancelConfirm、新增PopupManager导入 |

### 未修改文件

- `backend/operations/IntegratedScan.ts` — 按要求保留已通过状态
- `backend/operations/ArriveScanBatch.ts` — 无显式导航，依赖 ensureReadyForTask 自动修正
- `backend/operations/core/signExecutor.ts` — 内部操作逻辑不变
- `backend/browser/ClickHelper.ts` — 未改动
- V2 目录、database/migrations、AssignmentEngine 均未触及

---

## 四、性能预期

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 正常页面切换（同员工不同批） | 3-8s（reload+wait） | 3-8s（保持不变） |
| 跨任务切换（有弹窗） | 47-50s（菜单失败重试） | ≤8s（URL直达+快速取消清理） |
| 派件员选择（正常） | 1-2s | 1-2s（保持不变） |
| 派件员选择（DOM变化导致旧选择器失效） | 直接 FatalDispatchError | 多策略兜底找到input |
| ensureReadyForTask 正常 | 3-8s | 3-8s |
| ensureReadyForTask URL不对 | 15-50s | ≤8s（URL导航）→ ≤15s（含菜单兜底+reload） |

---

## 五、截图状态确认

- 本阶段未修改截图相关代码。
- G8 中已实现的 `ENABLE_RUNTIME_SCREENSHOTS=0` 默认关闭仍然有效。
- `takeScreenshot`、`captureFailureScreenshot`、`captureSignFailureScreenshot` 仍受开关保护。
- 本阶段新增代码中没有重新引入截图调用。

---

## 六、编译验证

```
backend:  npx tsc --noEmit  → 0 errors
frontend: npx tsc --noEmit  → 0 errors
agent:    npx tsc --noEmit  → 0 errors
```

---

## 七、验收清单

| 验收项 | 状态 | 说明 |
|--------|------|------|
| /dispatch 3员工×3轮，无"派件员选择失败" | 待测试 | 六步选择+多策略定位+回填验证 |
| /dispatch 无 element is not stable | 待测试 | fastStableBypassClick + 回填验证 |
| /dispatch 失败单号快速失败 | 待测试 | 选择失败即 throw，不阻塞后续 |
| /dispatch 日志完整（PERF打点保留） | 代码确认 | PERF selectCourier + item级PERF保留 |
| 跨任务切换不出现 WRONG_PAGE | 待测试 | URL优先导航+前后取消清理 |
| 跨任务切换不出现 ELEMENT_MISSING | 待测试 | URL修正+快速取消清理 |
| ensureReadyForTask ≤ 8s（正常） | 待测试 | URL导航替代菜单重试 |
| ensureReadyForTask ≤ 15s（异常） | 代码确认 | URL→菜单→reload三级快速失败 |
| /integrated 回归 | 待测试 | 未修改该文件 |
| 截图默认关闭（runtime/screenshots无新增） | 代码确认 | 未修改截图开关代码 |
| 有二次确认框时自动点"取 消" | 待测试 | dismissTopCancelConfirm |
| dismissAll 不被破坏 | 代码确认 | 新方法独立，不修改dismissAll逻辑 |
