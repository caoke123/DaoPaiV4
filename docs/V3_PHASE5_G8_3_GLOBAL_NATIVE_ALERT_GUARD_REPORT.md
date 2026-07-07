# DaoPai V3 Phase 5-G-8-3：全局原生 Alert 清理方案报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-3  
**修复目标**: 全站级浏览器原生 Alert（"网点余额低于警戒金额！"）阻塞登录和业务页切换

---

## 一、弹窗分类与处理策略

### A 类：浏览器原生 Alert

| 属性 | 值 |
|------|------|
| 表现 | 浏览器顶部弹窗，域名显示 bnsy.benniaosuyun.com |
| 内容 | "网点余额低于警戒金额！" |
| 按钮 | 确定 |
| 出现场景 | 登录首页、业务页面跳转 |
| 处理方式 | `page.on('dialog')` + CDP `Page.handleJavaScriptDialog` accept |

### B 类：业务 DOM 充值弹窗

| 属性 | 值 |
|------|------|
| 表现 | 页面内部弹窗，标题"充值"，灰色遮罩 |
| 按钮 | 取消 / 取 消 |
| 处理方式 | `PopupManager.dismissRechargeCancelDialog` 点击"取消" |

**本阶段重点处理 A 类。执行顺序：先 NativeAlertGuard，再 PopupManager。**

---

## 二、NativeAlertGuard 设计

**文件**: [NativeAlertGuard.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/NativeAlertGuard.ts)

### 2.1 attach — 全局 dialog 拦截器

```typescript
attachNativeAlertGuard(page, { staffName, log, scope })
```

- `page.on('dialog')` 注册全局拦截器
- alert / confirm / prompt → `dialog.accept()`（点击"确定"）
- beforeunload → `dialog.dismiss()`（不阻止离开）
- 同一 page 不重复注册（WeakSet 去重）
- 日志带 scope 和 staffName：`[NativeAlert][肖飞][business-navigation] 检测到原生弹窗：网点余额低于警戒金额！`

### 2.2 forceAccept — CDP 兜底

```typescript
forceAcceptCurrentNativeAlert(page, { staffName, log, scope }): Promise<boolean>
```

- 使用 `page.context().newCDPSession(page)` 创建 CDP 会话
- 发送 `Page.handleJavaScriptDialog { accept: true }`
- 适用场景：alert 已经弹出，`page.on('dialog')` 可能错过旧事件
- **没有 alert 时返回 false，不是错误**

### 2.3 drain — 短轮询清理

```typescript
drainNativeAlerts(page, { durationMs, intervalMs, staffName, log, scope }): Promise<number>
```

- 在 `durationMs` 时间内，每 `intervalMs` 尝试一次 `forceAccept`
- 默认：1500ms 持续，200ms 间隔
- 返回实际关闭的 alert 数量
- 适用场景：导航后 alert 可能延迟出现

---

## 三、全生命周期接入

### 3.1 Page 创建时 attach

**文件**: [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts#L74-L88)

`attachDialogHandler` 方法中，NativeAlertGuard 优先于 PopupManager 挂载：
- `launchWindow` 创建 page 后调用（L161）
- `closeWindow` 保留 page 时调用（L448, L463）

### 3.2 登录流程

**文件**: [PlaywrightLoginVerifier.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightLoginVerifier.ts#L154-L215)

**旧策略（已废弃）**: `suspendDialogHandling` → 3s 超时 → 关闭窗口重登  
**新策略**: NativeAlertGuard drain

```
1. 确保 NativeAlertGuard 已挂载（兜底）
2. 点击登录前 forceAccept 一次
3. 点击登录
4. drainNativeAlerts 2000ms（alert 可能延迟出现）
5. 检查 dashboard
6. 未进入 → forceAccept 再试一次
7. 仍失败才关闭窗口重登
```

### 3.3 业务页面跳转

**文件**: [NavigationGovernance.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/NavigationGovernance.ts#L301-L351)

`navigateBusinessPage` 流程：

```
1. drainNativeAlerts 1000ms（导航前）
2. dismissRechargeCancelDialog（清理 DOM 弹窗）
3. page.goto URL 导航
4. 等待 URL 匹配
5. 等待关键容器加载
6. drainNativeAlerts 2000ms（导航后，alert 可能延迟出现）
7. dismissRechargeCancelDialog（清理 DOM 弹窗）
8. 最终 URL 验证
```

`navigateByUrl` 降级路径同步加入前后 drain。

### 3.4 ensureReadyForTask

**文件**: [PageStateManager.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PageStateManager.ts)

| 检查节点 | drain 时机 |
|----------|-----------|
| Step 3 弹窗检查前 | `drainNativeAlerts 1000ms` → `dismissRechargeCancelDialog` |
| Step 4 WRONG_PAGE 修复 | `drainNativeAlerts 1000ms` → `dismissRechargeCancelDialog` → `navigateBusinessPage`（内含前后drain）→ 导航后 drain |
| Step 5 元素检查前 | `drainNativeAlerts 1000ms` → `dismissRechargeCancelDialog` |
| Step 5 ELEMENT_MISSING autoFix | `drainNativeAlerts 1000ms` → `navigateBusinessPage` → `drainNativeAlerts 1000ms` |

### 3.5 各业务任务执行前

| 模块 | 接入位置 | scope |
|------|---------|-------|
| [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L158-L161) | processOneBatch 导航前 | `dispatch-before-batch` |
| [ArriveScanBatch.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/ArriveScanBatch.ts#L161-L164) | processOneBatch ensureReadyForTask 前 | `arrival-before-batch` |
| [IntegratedScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/IntegratedScan.ts#L203-L206) | processOneBatch 导航前 | `integrated-before-batch` |
| [SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts#L74-L77) | executeSign 导航前 | `sign-before-task` |

---

## 四、DOM 充值弹窗策略保留

上一阶段的 `dismissRechargeCancelDialog` 继续保留，执行顺序：

```
先 NativeAlertGuard（原生 alert）
再 PopupManager.dismissRechargeCancelDialog（DOM 弹窗）
```

不删除、不混用。

---

## 五、编译验证

### 5.1 后端编译

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 六、修改文件汇总

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| backend/browser/NativeAlertGuard.ts | 🆕 新增 | 全局原生 Alert 守卫（attach/forceAccept/drain） |
| backend/browser/NavigationGovernance.ts | ✏️ 修改 | navigateBusinessPage/navigateByUrl 加入前后 drain |
| backend/browser/PageStateManager.ts | ✏️ 修改 | ensureReadyForTask 各检查节点加入 drain |
| backend/playwright-runtime/PlaywrightRuntime.ts | ✏️ 修改 | attachDialogHandler 同时挂载 NativeAlertGuard |
| backend/playwright-runtime/PlaywrightLoginVerifier.ts | ✏️ 修改 | 废弃 suspendDialogHandling，改用 drain 策略 |
| backend/operations/DispatchScan.ts | ✏️ 修改 | 批次执行前 drain |
| backend/operations/ArriveScanBatch.ts | ✏️ 修改 | 批次执行前 drain |
| backend/operations/IntegratedScan.ts | ✏️ 修改 | 批次执行前 drain |
| backend/operations/SignScan.ts | ✏️ 修改 | 任务执行前 drain |

---

## 七、验收检查清单

### 7.1 单窗口肖飞验收

| 步骤 | 预期结果 |
|------|---------|
| 关闭肖飞窗口 → 重新初始化 | NativeAlertGuard 在 page 创建时挂载 |
| 登录 | 登录前 forceAccept，登录后 drain 2000ms，alert 自动点确定 |
| 进入 dashboard | 不卡在 /login |
| 切换到到件扫描 | drain + URL 导航，不出现 WRONG_PAGE |
| 切换到派件扫描 | drain + URL 导航，不出现 ELEMENT_MISSING |
| 切换到到派一体 | drain + URL 导航，页面进入目标业务页 |
| 切换到签收录入 | drain + URL 导航，所有 alert 自动点确定 |

### 7.2 三员工并发验收

| 员工 | 业务 | 预期 |
|------|------|------|
| 肖飞 | /dispatch | 不被原生 Alert 卡住 |
| 孟德海 | /integrated | 不被 DOM 充值弹窗卡住 |
| 刘磊 | /dispatch | 不出现 WRONG_PAGE / ELEMENT_MISSING |

### 7.3 Chrome DevTools MCP 验证

**场景 1：登录阶段**
- 触发"网点余额低于警戒金额！"原生 Alert
- 系统自动点击"确定"
- 页面进入 dashboard，不卡在 /login

**场景 2：业务页跳转阶段**
- /dashboard → /scanning/arrivalscan：alert 自动确定
- /scanning/arrivalscan → /scanning/dispatchscan：不阻塞
- /scanning/dispatchscan → /scanning/arrivalscan：不出现 WRONG_PAGE
- /scanning/arrivalscan → 签收录入：不出现 ELEMENT_MISSING

---

## 八、核心策略总结

1. **弹窗分类处理**:
   - A 类原生 Alert → NativeAlertGuard（page.on('dialog') + CDP）
   - B 类 DOM 弹窗 → PopupManager.dismissRechargeCancelDialog

2. **执行顺序**: 先 NativeAlertGuard，再 PopupManager

3. **三层防护**:
   - attach: page 创建时全局注册 dialog handler
   - forceAccept: CDP 兜底关闭已存在的 alert
   - drain: 短轮询清理延迟出现的 alert

4. **登录策略升级**: 废弃 suspendDialogHandling，改用 drain 主动清理

5. **全生命周期覆盖**: page 创建 → 登录 → 业务页切换 → ensureReadyForTask → 任务执行

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工执行单窗口肖飞验收 + 三员工并发验收 + Chrome DevTools MCP 验证
