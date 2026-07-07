# DaoPai V3 Phase 5-G-8 稳定点击方案迁移 + 全局截图默认关闭报告

日期：2026-07-01

## 结论

基于 Phase 5-G-7-4 在 `/integrated` 到派一体页面验证通过的稳定点击方案，本轮完成了以下工作：

1. 提取通用稳定点击工具 `ClickHelper.ts`。
2. 将稳定点击方案迁移到 `/dispatch` 派件扫描页面。
3. 将 PERF 性能打点迁移到 `/dispatch`、`/arrival`、`/sign` 三个业务页面。
4. 全局默认关闭运行时截图（通过 `ENABLE_RUNTIME_SCREENSHOTS=0`）。
5. `/integrated` 基准页面未做修改，保持已通过的稳定状态。

## 一、新建文件

### 1. backend/browser/ClickHelper.ts

从 `IntegratedScan.ts` 的 `fastStableBypassClick` 提取为公共通用点击工具。

接口：

```typescript
async function fastStableBypassClick(locator: Locator, options: {
  log?: LogFn;
  label: string;
  timeoutMs?: number;
  verify?: () => Promise<boolean>;
}): Promise<void>
```

点击策略：

1. `waitFor({ state: 'visible' })` 确认元素存在且可见。
2. 优先短超时（min(timeoutMs, 3000)）普通 `click()`。
3. 普通点击因 `element is not stable` / `Timeout` 失败时，使用 `force: true` 回退。
4. 如提供 `verify` 回调，点击后执行验证；验证失败抛出明确错误。

原则：**不全局滥用 force click**。只在明确不稳定、且点击后有结果验证的按钮上使用。

## 二、修改文件

### 2. backend/browser/PageNavigator.ts

**修改内容**：

- 新增 `isScreenshotEnabled()` 辅助函数，检查 `ENABLE_RUNTIME_SCREENSHOTS` 环境变量。
- `takeScreenshot()` 内部：默认跳过截图，仅当 `ENABLE_RUNTIME_SCREENSHOTS=1` 或 `ENABLE_RUNTIME_SCREENSHOTS=true` 时执行。
- `captureFailureScreenshot()` 内部：同上。

默认值：**关闭**（`ENABLE_RUNTIME_SCREENSHOTS=0`）。

截图失败不影响业务逻辑，失败日志仍保留文字原因。

### 3. backend/screenshots/captureFailure.ts

**修改内容**：

- 新增 `isScreenshotEnabled()` 辅助函数。
- `captureSignFailureScreenshot()` 内部：默认跳过，仅当 `ENABLE_RUNTIME_SCREENSHOTS=1` 时执行。

### 4. backend/operations/DispatchScan.ts

**迁移内容**：

#### 4.1 稳定点击迁移

- 导入 `fastStableBypassClick` 来自 `../browser/ClickHelper`。
- `addWaybillsOneByOne()` 中的"添加"按钮点击从普通 `page.locator(...).first().click()` 替换为 `fastStableBypassClick()`。
  - 先普通 click，失败后 force 回退。
  - 带有 `label: 'dispatchAddButton'` 日志标签。
  - 点击后通过 `rowsAfter > rowsBefore` 隐式验证。

#### 4.2 PERF 性能打点

新增 `timedStep()` 包装，覆盖以下关键步骤：

- `PERF navigateTo(dispatch)` — 导航到派件扫描页面
- `PERF page.reload` — 页面重新加载
- `PERF wait navigation settle` — 导航稳定等待
- `PERF ensureReadyForTask(dispatch)` — 页面状态前置检查
- `PERF selectCourier` — 选择派件员
- `PERF addWaybillsOneByOne` — 逐个添加运单（总耗时）
- `PERF uploadAndJudge` — 上传提交 + 四态判定
- `PERF batch total` — 整批总耗时

单条运单添加内部耗时（慢路径诊断）：

- `countBefore`, `fill`, `verifyInput`, `clickAdd`, `waitAfterClick`, `countAfter`

超过 `SLOW_STEP_MS=1500ms` 的单条会输出 `PERF addWaybill slow` warning 日志，附带表单状态诊断（button disabled/loading、loading masks、messages）。

聚合进度日志新增区间耗时：`Batch进度: 5/17 (成功0, 失败5, 区间1-5耗时xxxms)`。

#### 4.3 其他增强

- 新增 `inspectAddFormState()` 函数，用于慢路径诊断时检查添加按钮状态。
- 导航结果日志增加 `method` 和 `fallback` 字段。

### 5. backend/operations/ArriveScanBatch.ts

**迁移内容**：

#### 5.1 PERF 性能打点

新增 `timedStep()` 包装，覆盖以下关键步骤：

- `PERF ensureReadyForTask(arrival)` — 页面状态前置检查
- `PERF fillWaybills` — 填入运单号（textarea 批量模式）
- `PERF selectPrevStation` — 选择上一站
- `PERF queryWaybills` — 点击查询 + 等待表格渲染
- `PERF setPageSize200` — 设置 200 条/页
- `PERF selectAll` — 全选
- `PERF submitAndJudge` — 提交 + toast 判定
- `PERF batch total` — 整批总耗时

#### 5.2 注意事项

- 到件扫描使用 textarea 批量填入模式（非逐条添加），因此不需要 `fastStableBypassClick`。
- "上一站"选择使用下拉选项 + 兜底文本输入，保持不变。
- 试运行模式（dryRunMode）跳出时也输出 `PERF batch total`。

### 6. backend/operations/SignScan.ts

**迁移内容**：

#### 6.1 PERF 性能打点

新增 `timedStep()` 包装，覆盖以下关键步骤：

- `PERF navigateTo(sign)` — 导航到签收录入页面
- `PERF wait nav settle` — 导航稳定等待
- `PERF ensureReadyForTask(sign)` — 页面状态前置检查
- `PERF setDateRangeToday` — 设置日期范围
- `PERF selectCourier` — 选择派件员
- `PERF executeBatchFlow` — 批量签收流程

#### 6.2 注意事项

- 签收录入的派件员选择使用 `page.evaluate()` 原生点击（绕过 CSS 动画），本身已稳定，不需要 `fastStableBypassClick`。
- 弹窗清理逻辑走 `PopupManager` 全局能力，各页面不独立处理。

### 7. backend/operations/core/signExecutor.ts

**修改内容**：

- `executeBatchFlow()` 新增 `PERF executeBatchFlow total` 日志，输出整批签收流程总耗时。
- `clickSearch`、`clickBatchSignButton` 等内部操作通过已有的 `retry` 机制和 `ExecutionLogger` 记录，保持不变。

## 三、截图默认关闭

### 环境变量

```
ENABLE_RUNTIME_SCREENSHOTS=0   # 默认关闭
ENABLE_RUNTIME_SCREENSHOTS=1   # 显式开启
```

### 控制范围

| 函数 | 文件 | 状态 |
|---|---|---|
| `takeScreenshot()` | `backend/browser/PageNavigator.ts` | 已加开关 |
| `captureFailureScreenshot()` | `backend/browser/PageNavigator.ts` | 已加开关 |
| `captureSignFailureScreenshot()` | `backend/screenshots/captureFailure.ts` | 已加开关 |

### 原则

- 默认运行任务后，`runtime/screenshots/` 不再新增图片。
- 日志中不再反复出现"异常截图已保存"。
- 显式 `ENABLE_RUNTIME_SCREENSHOTS=1` 后截图能力完全恢复。
- 截图失败不影响任务执行和任务失败原因（已有 try/catch 保护）。
- 截图代码未删除，仅加开关。

## 四、未修改的部分（按要求保持）

- `/integrated` 到派一体页面未做修改（已通过人工 3 轮测试）。
- `PopupManager` 未做修改（已在 Phase G-7-2/G-7-4 中修复）。
- `PlaywrightLoginVerifier` 未做修改。
- `windowRuntimeRoutes` 未做修改。
- V2 代码未触及。
- `database/migrations` 未触及。
- 派件员选择在各页面的实现方式保持不变（dispatch 用 el-select 文本匹配、integrated 用 dialog + employeeId、sign 用 page.evaluate 原生点击）。

## 五、弹窗处理策略确认

按要求检查了 `/arrival`、`/dispatch`、`/sign` 是否有独立弹窗关闭逻辑：

- `/dispatch` (DispatchScan)：弹窗关闭走 `PopupManager` 全局能力。`ensureReadyForTask` 内部调用 `PopupManager.dismissAll`。无独立弹窗关闭代码。
- `/arrival` (ArriveScanBatch)：同样走 `PopupManager` 全局能力。`ensureReadyForTask` 内部处理。无独立弹窗关闭代码。
- `/sign` (SignScan)：在 `executeSign` 中有简单的 Escape 关闭 + 重导航兜底（L67-90，处理弹窗关闭后页面跳转场景），但这是导航辅助逻辑，不是独立的弹窗关闭策略。核心弹窗处理仍依赖 `signExecutor` 内部的 `dismissGuardingPopups` → `PopupManager.dismissAll`。

结论：三个业务页面均统一走 `PopupManager` 全局弹窗处理，不存在各页面各写一套错误顺序的问题。

全局弹窗处理原则（已在 Phase G-7-4 修复）保持不变：

- 登录后原生 alert 不当作普通业务弹窗处理。
- 登录后 3 秒内未进入首页，判定登录死锁，关闭窗口重登。
- 业务页面 DOM 弹窗先处理 `.el-message-box`。
- 二次确认框优先点 `取消 / 取 消`。

## 六、验收标准对照

| 验收项 | 状态 | 说明 |
|---|---|---|
| `/integrated` 回归：3 员工并发，17 条测试单号，耗时稳定 | 待测试 | 基准页面未修改，预期保持稳定 |
| `/dispatch`：2-3 员工并发，派件员选择稳定，运单添加稳定 | 待测试 | 添加按钮已使用 stable click + PERF |
| `/dispatch`：失败单号快速失败，无 element is not stable | 待测试 | force 回退覆盖不稳定场景 |
| `/arrival`：2-3 员工并发，上一站选择稳定，运单录入稳定 | 待测试 | PERF 打点已加，textarea 批量模式 |
| `/arrival`：失败有明确文字日志 | 待测试 | toast 判定 + DOM 回退判定保持不变 |
| `/sign`：2-3 员工并发，派件员选择稳定 | 待测试 | evaluate 原生点击本身稳定 |
| `/sign`：搜索/分页/签收有明确日志，不长期 running 卡住 | 待测试 | PERF 打点 + retry 机制 |
| 截图关闭：默认运行后 `runtime/screenshots/` 不新增图片 | 待测试 | 全局开关已加 |
| `ENABLE_RUNTIME_SCREENSHOTS=1` 后截图可恢复 | 待测试 | 开关逻辑为条件判断 |

## 七、性能打点对照

每个业务页面至少保留的打点：

| 阶段 | `/dispatch` | `/arrival` | `/sign` | `/integrated` |
|---|---|---|---|---|
| PERF navigateTo | 有 | (合并到 ensureReadyForTask) | 有 | 有 |
| PERF ensureReadyForTask | 有 | 有 | 有 | 有 |
| PERF selectCourier / selectPrevStation | 有 | 有 | 有 | 有 |
| PERF addWaybills / queryWaybills | 有（逐条+聚合） | 有 | 有（executeBatchFlow 内部） | 有 |
| PERF uploadAndJudge / submitAndJudge | 有 | 有 | 有 | 有 |
| PERF batch total | 有 | 有 | 有 | 有 |

## 八、涉及文件清单

**新建**：
- `backend/browser/ClickHelper.ts`

**修改**：
- `backend/browser/PageNavigator.ts`
- `backend/screenshots/captureFailure.ts`
- `backend/operations/DispatchScan.ts`
- `backend/operations/ArriveScanBatch.ts`
- `backend/operations/SignScan.ts`
- `backend/operations/core/signExecutor.ts`

**未修改（按要求保持）**：
- `backend/operations/IntegratedScan.ts`
- `backend/browser/PopupManager.ts`
- `backend/playwright-runtime/PlaywrightLoginVerifier.ts`
- `backend/api/windowRuntimeRoutes.ts`
- V2 代码
- `database/migrations`
