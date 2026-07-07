# DaoPai V3 Phase 5-G-8-5：关闭/启动员工窗口时清理 Chrome 残留标签页报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-5  
**修复目标**: 窗口生命周期标签页清理/归一化，关闭时清干净，启动时只保留一个干净首页

---

## 一、修改文件列表

| 文件 | 修改目的 |
|------|---------|
| [PlaywrightRuntime.ts](file:///e:/网站开发/DaoPaiV3/backend/playwright-runtime/PlaywrightRuntime.ts) | 新增 `cleanupAllTabsBeforeClose` + `normalizeTabsForWindow`，增强 `ensureSingleBusinessPage` 弹窗清理 |

---

## 二、关闭窗口流程 Before / After

### Before

```
closeWindow(runtimeKey)
  → context.close()
  → clearRuntimeStateForClose()  // page=null, context=null, status=closed
```

问题：只关闭 context，不清理标签页。Chrome 持久化 profile 可能残留标签页信息，下次启动时恢复。

### After

```
closeWindow(runtimeKey)
  → cleanupAllTabsBeforeClose(context)  // 新增：逐个关闭所有标签页
    → 遍历 context.pages()
    → 每个页面绑定 dialog dismiss（防止 alert 阻塞 close）
    → 清理 DOM 弹窗（PopupManager.dismissRechargeCancelDialog）
    → page.close({ runBeforeUnload: false })
    → 异常只 warn，不阻断
  → context.close()
  → clearRuntimeStateForClose()
```

---

## 三、启动窗口流程 Before / After

### Before

```
launchWindow(opts)
  → launchPersistentContext(userDataDir, ...)
  → page = context.pages()[0]        // 直接取第一个，可能是 about:blank 或旧业务页
  → if (!page) page = newPage()
  → attachDialogHandler(page)
  → page.goto(TARGET_DASHBOARD)
```

问题：直接复用 Chrome 恢复的标签页，可能是 about:blank、旧业务页面、或多标签页。

### After

```
launchWindow(opts)
  → launchPersistentContext(userDataDir, ...)
  → normalizeTabsForWindow(context, TARGET_DASHBOARD)  // 新增：标签页归一化
    1. 所有页面绑定 NativeAlertGuard + PopupManager
    2. 优先选业务域名页作为 mainPage
    3. 如无可用页，新建一个
    4. 关闭所有其他多余标签页（about:blank / 旧业务页 / 重复标签）
    5. mainPage.goto(TARGET_DASHBOARD)  // 无论当前是什么 URL 都恢复首页
    6. drainNativeAlerts + dismissRechargeCancelDialog  // 清理弹窗
    7. 再次检查导航后是否产生新标签页，如有继续关闭
    8. 返回 mainPage
  → stateStore.update(runtimeKey, { context, page: mainPage })
```

---

## 四、弹窗清理挂载点

| 流程节点 | 原生 alert 清理 | DOM 弹窗清理 |
|----------|:---:|:---:|
| CDP 连接后（attachDialogHandler） | ✅ | ✅ |
| 标签页归一化后（normalizeTabsForWindow） | ✅ drain 1500ms | ✅ |
| goto 首页后 | ✅ | ✅ |
| goto 业务页面后（BusinessPageNavigator） | ✅ drain | ✅ |
| 点击菜单后（BusinessPageNavigator） | ✅ drain | ✅ |
| ensureSingleBusinessPage 后 | ✅ drain 1000ms | ✅ |
| READY/P0 检查前 | ✅ | ✅ |
| 任务执行前（4个业务模块） | ✅ drain 1000ms | ✅ |
| 任务结束后回首页（restoreCleanHome） | ✅ drain | ✅ |
| 关闭窗口前（cleanupAllTabsBeforeClose） | ✅ dialog dismiss | ✅ |

---

## 五、READY 判断变化

### Before

```typescript
// launchWindow 中
let page = context.pages()[0];  // 直接取第一个，可能是残留标签
```

### After

```typescript
// launchWindow 中
const page = await this.normalizeTabsForWindow(context, TARGET_DASHBOARD, tag, opts.staffName);
// normalizeTabsForWindow 保证返回唯一的干净首页 mainPage
// READY/P0 判断基于这个 mainPage
```

`ensureSingleBusinessPage` 也增强了：标签页整理后加入 `drainNativeAlerts` + `dismissRechargeCancelDialog`，确保 READY/P0 判断不受残留弹窗影响。

---

## 六、关键设计原则

1. **关闭时清干净**：`cleanupAllTabsBeforeClose` 逐个关闭所有标签页，异常只 warn 不阻断
2. **启动时只保留一个干净首页**：`normalizeTabsForWindow` 关闭所有多余标签，mainPage 导航到首页
3. **不复用旧标签页**：无论 Chrome 恢复了什么标签，都关闭多余的，mainPage 强制导航到首页
4. **弹窗清理幂等**：`drainNativeAlerts` 和 `dismissRechargeCancelDialog` 可重复调用，无弹窗时不报错
5. **弹窗清理不阻断**：所有 `.catch(() => {})` 确保弹窗清理失败不影响窗口状态
6. **复用现有模块**：PopupManager、NativeAlertGuard、drainNativeAlerts，不重复造新模块

---

## 七、编译验证

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 八、测试建议

### 测试 A：多标签残留

1. 手动打开员工窗口
2. 打开多个笨鸟页面和一个 about:blank
3. 关闭员工窗口
4. 重新启动员工窗口

**预期**：
- 不保留旧标签页
- 不保留 about:blank
- 只剩一个首页标签
- READY 判断正常

### 测试 B：旧业务页面残留

1. 员工窗口停留在派件扫描页面
2. 关闭窗口
3. 重新启动

**预期**：
- 不直接停留在派件扫描页面
- 先恢复干净首页
- 后续任务执行时再由任务 Handler 导航到目标业务页

### 测试 C：alert 弹窗残留

1. 启动员工窗口
2. 笨鸟系统弹出 alert
3. 执行窗口恢复首页

**预期**：
- alert 被自动 dismiss
- DOM 弹窗被清理
- 首页干净
- READY 不被误判

### 测试 D：任务执行前页面干净

1. 启动员工窗口
2. 执行到件 / 派件 / 到派一体 / 签收 dry-run

**预期**：
- 任务执行前页面来源明确（normalizeTabsForWindow 返回的 mainPage）
- 不复用旧标签页
- 不打开空白页
- 日志中能看到窗口恢复首页、弹窗清理、业务页面导航过程

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工执行测试 A/B/C/D 验收
