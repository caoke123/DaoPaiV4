# DaoPai V3 Phase 5-G-7-4 到派一体窗口稳定性与弹窗修复报告

日期：2026-07-01

## 结论

本轮针对 `/integrated` 到派一体页面做了专项排查和修复，重点解决了并行任务下不同员工窗口耗时差异大、按钮点击不稳定、登录后原生弹窗卡住、业务页 DOM 弹窗关闭顺序错误等问题。

人工测试 3 轮已通过。

## 一、问题背景

此前人工测试发现，同样的到派一体任务、同样的任务分发链路，不同员工窗口耗时差异明显：

- 肖飞窗口约 16 秒完成。
- 孟德海窗口曾出现约 54-61 秒完成。
- 刘磊窗口曾在派件员选择阶段失败。

经过逐步打点确认，启动、任务分发、窗口连接都不是主要问题：

- assignment received 基本同秒。
- 窗口连接通常 1-3ms。
- 业务操作开始也很快。

真正的问题集中在 BNSY 页面交互：

- 普通 `locator.click()` 在部分窗口等待元素 stable，导致每条单号点击添加约 1.6s。
- Element UI fixed-right 表格里的“使用”按钮会出现 `element is not stable`。
- 登录后原生 alert 会阻塞首页进入。
- 业务页面余额不足弹窗关闭顺序错误，应该先点二次确认框里的 `取 消`，而不是继续点 `X`。

## 二、主要修复

### 1. 到派一体按钮点击稳定性修复

文件：

- `backend/operations/IntegratedScan.ts`

修复内容：

- 新增 `fastStableBypassClick()`。
- 对两个已确认不稳定的按钮使用“先确认可见，再 force 真实点击”：
  - 派件员弹窗中的 `使用` 按钮。
  - 到派一体页面中的 `添加` 按钮。

修复原因：

普通 `locator.click()` 会等待元素 visible、enabled、stable、可接收事件。BNSY 页面中的 Element UI 表格 fixed-right 列和动态布局会导致部分窗口长期处于“不稳定”状态。

修复后：

- 孟德海 `addWaybillsOneByOne` 从约 33.9s 降到约 5.9s。
- 肖飞、孟德海添加 17 条失败单号耗时基本一致。
- 派件员 `clickUseButton` 从秒级或超时降到几十毫秒。

### 2. 到派一体性能打点

文件：

- `backend/operations/IntegratedScan.ts`
- `backend/browser/PageStateManager.ts`

新增员工级 `PERF` 日志，覆盖：

- `navigateTo(integrated)`
- `page.reload`
- `ensureReadyForTask(integrated)`
- `selectPrevStation`
- `checkIntegratedCheckbox`
- `selectCourier`
- `addWaybillsOneByOne`
- 单条 addWaybill 内部耗时：
  - `countBefore`
  - `fill`
  - `verifyInput`
  - `clickAdd`
  - `waitAfterClick`
  - `countAfter`

这些日志用于定位窗口差异，不改变业务行为。

### 3. 成功路径诊断截图默认关闭

文件：

- `backend/operations/IntegratedScan.ts`

修复内容：

- 到派一体成功路径上的诊断截图默认关闭。
- 失败截图仍保留。
- 如需重新打开诊断截图，可设置：

```bash
INTEGRATED_DIAGNOSTIC_SCREENSHOTS=1
```

原因：

并行多窗口执行时，成功路径大量截图会增加 IO 和页面截图压力，不适合作为常态生产路径。

### 4. 登录后原生 alert 卡住策略修复

文件：

- `backend/playwright-runtime/PlaywrightLoginVerifier.ts`
- `backend/api/windowRuntimeRoutes.ts`
- `backend/browser/PopupManager.ts`

问题：

登录页填写账号密码后，BNSY 可能弹出原生 alert：

```text
网点余额低于警戒金额！
```

该 alert 会导致无法进入可用首页。

最终策略：

- 登录阶段不处理该原生 alert。
- 登录后等待 3 秒进入 `/dashboard`。
- 3 秒内未进入首页，判定登录死锁。
- 关闭窗口并重新登录。

修复内容：

- `PopupManager` 新增：
  - `suspendDialogHandling(page)`
  - `resumeDialogHandling(page)`
- 登录阶段暂停原生 dialog 自动 accept。
- `PlaywrightLoginVerifier` 点击登录后只等待 3 秒进入首页。
- `windowRuntimeRoutes` 将 `登录后 3s 内未进入首页` 识别为登录死锁，并触发关闭窗口重登。

### 5. 业务页 DOM 弹窗关闭顺序修复

文件：

- `backend/browser/PopupManager.ts`

问题：

进入业务页面后常见余额不足弹窗。错误处理顺序是先点弹窗右上角 `X`，随后出现“确认关闭?”二次确认框，流程容易卡住或反复叠加确认框。

正确策略：

- 如果存在 `.el-message-box` 二次确认框，先处理最上层确认框。
- 优先点击确认框里的 `取消 / 取 消`。
- 匹配时去除空白，因此 `取 消` 会识别为 `取消`。
- 处理完二次确认框后，本轮不继续点击后层弹窗的 `X`。
- 只有没有二次确认框时，才处理普通 `.el-dialog / pay-dialog`。

修复内容：

- `dismissAllInternal()` 处理顺序调整：
  1. 先处理 `.el-message-box`。
  2. 优先点 `取 消`。
  3. 再处理普通业务弹窗。
- 新增 `clickCancelButton()`，专门识别 `取消 / 取 消`。

## 三、测试结果

人工测试 3 轮通过。

已确认：

- 到派一体多窗口并行执行耗时差异基本消失。
- 添加运单慢路径已修复。
- 派件员“使用”按钮点击稳定。
- 登录后原生 alert 不再走普通弹窗清理路径，而是进入 3 秒登录守卫重启策略。
- 业务页面余额不足弹窗关闭顺序正确，优先点击 `取 消`。

## 四、注意事项

1. 不要把登录后原生 alert 当作普通业务弹窗处理。
   登录阶段应由 LoginGuard 负责，3 秒无法进入首页则关闭窗口重登。

2. 不要在有 `.el-message-box` 二次确认框时继续点击后层弹窗的 `X`。
   必须先处理最上层确认框里的 `取 消`。

3. 到派一体的 `force: true` 点击只应用在已验证的问题点：
   - 派件员 `使用` 按钮。
   - 运单 `添加` 按钮。

4. P0 弹窗清理仍保持保守策略。
   不使用快速可见判断替代 P0 的稳定等待。

## 五、涉及文件

- `backend/operations/IntegratedScan.ts`
- `backend/browser/PageStateManager.ts`
- `backend/browser/PopupManager.ts`
- `backend/playwright-runtime/PlaywrightLoginVerifier.ts`
- `backend/api/windowRuntimeRoutes.ts`

