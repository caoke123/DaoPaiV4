# DaoPai V3 Phase 5-G-8-4：业务页面导航恢复机制 + 页面变化后弹窗清理报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-4  
**修复目标**: 统一业务页面导航恢复机制，任何页面变化后先清理原生 Alert + DOM 弹窗，再验证 URL 和目标元素

---

## 一、核心设计：BusinessPageNavigator

**文件**: [BusinessPageNavigator.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/BusinessPageNavigator.ts)

### 1.1 TargetSpec 统一配置

人工实测确认的 URL 映射（不再散落在各业务文件中）：

| 任务类型 | URL | 菜单文本 | 关键元素 |
|----------|-----|---------|---------|
| arrival | `/scanning/ArrivalscanBatch` | 到件扫描(批量) | `textarea`, `button.el-button--danger` |
| dispatch | `/scanning/dispatchscan` | 派件扫描 | `.dispatchscan_left input`, `.dispatchscan_left button.el-button--primary` |
| integrated | `/scanning/arrivalscan` | 到派一体 | `#waybillNum`, `.arrivalscan_left button.el-button--primary` |
| sign | `/scanning/signFor/signForInput` | 签收录入 | `.search-wrap .item-actions .el-button--primary`, `.search-wrap .inputs .el-date-editor` |
| 首页 | `/dashboard` | - | `.el-menu` 侧边栏 |

**注意**: 到件扫描 = `/scanning/ArrivalscanBatch`，到派一体 = `/scanning/arrivalscan`，两者不是同一页面。

### 1.2 afterPageChangedCleanup — 页面变化后统一清理钩子

任何页面变化之后必须调用。固定流程：

```
1. attachNativeAlertGuard（幂等，确保已挂载）
2. drainNativeAlerts（800-1500ms，清理原生 Alert）
3. dismissRechargeCancelDialog（清理 DOM 充值弹窗）
4. 再 drainNativeAlerts（300-800ms，DOM 弹窗关闭后可能触发新 alert）
```

返回：`{ currentUrl, alertClosed, domPopupClosed }`

**调用位置覆盖**：登录后、goto 首页后、goto 业务页后、URL 重试后、侧边栏点击后、page.reload 后、ensureReadyForTask 检查前、任务结束回首页后。

### 1.3 ensureCleanHome — 任务开始前恢复干净首页

```
1. afterPageChangedCleanup（清理弹窗）
2. 如果不在 /dashboard → goto 首页
3. afterPageChangedCleanup（页面变化后再次清理）
4. 验证：URL=/dashboard, 不在/login, 侧边栏存在
5. 失败快速失败，不继续盲目执行业务动作
```

### 1.4 navigateToBusinessPage — URL 优先 + 重试 + 侧边栏兜底

```
1. 如果已在目标页且元素存在 → 清理弹窗后直接返回
2. ensureCleanHome()（先恢复干净首页）
3. 第一层：URL 导航 → afterPageChangedCleanup → 验证 URL + 元素
4. 第二层：URL 重试 → ensureCleanHome → afterPageChangedCleanup → 验证
5. 第三层：侧边栏菜单兜底 → ensureCleanHome → navigateByMenu → afterPageChangedCleanup → 验证
6. 全部失败 → 15s 内快速失败，输出明确原因
```

**验证标准**：URL 正确 + 关键元素存在 + 无遮罩弹窗。URL 正确但元素缺失不算 ready。

### 1.5 restoreCleanHome — 任务结束后恢复干净首页

```
1. drainNativeAlerts + dismissRechargeCancelDialog（清理弹窗）
2. goto 首页 /dashboard
3. afterPageChangedCleanup（页面变化后清理）
4. 验证首页 ready
5. 回首页失败不改变任务结果，但写 warning
```

**必须在释放窗口锁之前完成。**

---

## 二、全生命周期接入

### 2.1 四个业务模块统一使用导航器

| 模块 | 文件 | 修改内容 |
|------|------|---------|
| DispatchScan | [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L159-L172) | 替换 `navGov.navigateBusinessPage` 为 `businessNav.navigateToBusinessPage` |
| ArriveScanBatch | [ArriveScanBatch.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/ArriveScanBatch.ts#L162-L175) | 在 ensureReadyForTask 前加入 `navigateToBusinessPage` |
| IntegratedScan | [IntegratedScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/IntegratedScan.ts#L204-L217) | 替换 `navGov.navigateTo` 为 `businessNav.navigateToBusinessPage` |
| SignScan | [SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts#L75-L91) | 替换 `navGov.navigateBusinessPage` + 移除旧 `dismissTopCancelConfirm` 逻辑 |

业务文件现在只负责：选择上一站、勾选到派一体、选择派件员、录入单号、搜索/提交/签收。

### 2.2 AssignmentEngine 任务结束后恢复首页

**文件**: [AssignmentEngine.ts](file:///e:/网站开发/DaoPaiV3/backend/modules/assignment-engine/AssignmentEngine.ts#L995-L1013)

在 `executeAssignment` 的 `finally` 块中，`conn.release()` 之前加入 `restoreCleanHome`：

```typescript
} finally {
  // Phase 5-G-8-4: 任务结束后恢复干净首页（在释放窗口锁之前）
  try {
    await BusinessPageNavigator.getInstance().restoreCleanHome(conn.page, {
      staffName,
      log: (level, msg) => staffLog(level, msg),
    });
  } catch (restoreErr) {
    staffLog('warning', `任务结束恢复首页异常: ${(restoreErr as Error).message}`);
  }
  try {
    await conn.release();
  } catch (releaseErr) { ... }
}
```

**关键规则**：
- 回首页在释放窗口锁之前完成
- 回首页失败不改变任务结果（done/failed）
- 但写 warning："任务已结束，但窗口恢复首页失败，下次任务前将重新校验"

---

## 三、弹窗处理执行顺序

```
任何页面变化后：
  1. NativeAlertGuard（原生 alert/confirm/prompt → accept "确定"）
  2. PopupManager.dismissRechargeCancelDialog（DOM 充值弹窗 → 点"取消"）
  3. 再 NativeAlertGuard（DOM 弹窗关闭后可能触发新 alert）
```

**DOM 弹窗处理原则**：
1. 优先点"取消 / 取 消"（文本 normalize: `text.replace(/\s+/g, '')`）
2. 有 `.el-message-box` 时先处理最上层 message-box
3. 不优先点 X（X 触发二次确认框）
4. 清完后重新验证 URL 和关键元素

---

## 四、性能设计

| 场景 | 超时 |
|------|------|
| 无弹窗检测 | 200-500ms |
| 原生 Alert drain（正常） | 1200ms |
| 原生 Alert drain（导航后） | 1500ms |
| 原生 Alert drain（短确认） | 800ms |
| DOM 弹窗关闭等待 | 1200ms |
| URL 导航 goto | 5000ms |
| 关键元素等待 | 5000ms |
| 回首页 goto | 8000ms |
| 正常业务页进入 | 5-8s |
| 异常恢复（含重试+侧边栏） | ≤ 15s |

**不为了清理弹窗让每次任务固定多等 10 秒。**

---

## 五、截图功能保持关闭

- `ENABLE_RUNTIME_SCREENSHOTS` 默认未设置 → `isScreenshotEnabled()` 返回 `false`
- 任务失败后 `runtime/screenshots` 不新增图片
- 日志不出现"异常截图已保存"

---

## 六、编译验证

### 6.1 后端编译

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 七、修改文件汇总

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| backend/browser/BusinessPageNavigator.ts | 🆕 新增 | 统一业务页面导航器（TargetSpec + afterPageChangedCleanup + ensureCleanHome + navigateToBusinessPage + restoreCleanHome） |
| backend/operations/DispatchScan.ts | ✏️ 修改 | 替换导航为 navigateToBusinessPage('dispatch') |
| backend/operations/ArriveScanBatch.ts | ✏️ 修改 | 加入 navigateToBusinessPage('arrival') |
| backend/operations/IntegratedScan.ts | ✏️ 修改 | 替换导航为 navigateToBusinessPage('integrated') |
| backend/operations/SignScan.ts | ✏️ 修改 | 替换导航为 navigateToBusinessPage('sign')，移除旧 dismissTopCancelConfirm 逻辑 |
| backend/modules/assignment-engine/AssignmentEngine.ts | ✏️ 修改 | finally 块中加入 restoreCleanHome |

---

## 八、验收检查清单

### 8.1 首页恢复验收

每个员工窗口（肖飞/孟德海/刘磊）：
- 打开窗口 → 登录 → 处理原生 Alert → 处理 DOM 弹窗 → 恢复首页 → 验证首页干净

通过标准：URL=/dashboard, 不在/login, 无原生 Alert, 无 DOM 弹窗, 侧边栏可用

### 8.2 业务页 URL 导航验收

从首页分别进入：
- 到件扫描 `/scanning/ArrivalscanBatch`
- 派件扫描 `/scanning/dispatchscan`
- 到派一体 `/scanning/arrivalscan`
- 签收录入 `/scanning/signFor/signForInput`

通过标准：URL 正确, 关键元素存在, 无弹窗遮挡

### 8.3 URL 失败重试 + 侧边栏兜底验收

通过标准：URL 重试一次 → 仍失败则回首页点击侧边栏菜单 → 最终进入目标页面 → 不出现 47-50 秒等待

### 8.4 跨任务顺序验收

连续执行：
- /dispatch → /integrated
- /integrated → /dispatch
- /arrival → /dispatch
- /dispatch → /sign
- /sign → /integrated

通过标准：每个任务结束后窗口回到干净首页, 下一个任务从首页进入目标页面, 不出现 WRONG_PAGE / ELEMENT_MISSING / 业务页残留弹窗

### 8.5 任务回首页验收

任意任务结束后检查：URL=/dashboard, 无原生 Alert, 无 DOM 弹窗, 侧边栏可用

---

## 九、核心策略总结

1. **统一导航入口**: 所有业务模块通过 `BusinessPageNavigator.navigateToBusinessPage` 进入目标页面

2. **页面变化后必须清理**: `afterPageChangedCleanup` 统一执行 NativeAlertGuard → PopupManager → 短确认 drain

3. **三层导航兜底**: URL 直接 → URL 重试 → 侧边栏菜单

4. **任务开始前恢复首页**: `ensureCleanHome` 确保从干净首页出发

5. **任务结束后恢复首页**: `restoreCleanHome` 在释放窗口锁之前完成，失败不影响任务结果

6. **快速失败**: 异常 15s 内返回明确错误，不再 47-50 秒卡死

7. **验证不只看 URL**: URL 正确 + 关键元素存在 + 无遮罩弹窗 才算 ready

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工执行首页恢复验收 + 业务页导航验收 + 跨任务顺序验收
