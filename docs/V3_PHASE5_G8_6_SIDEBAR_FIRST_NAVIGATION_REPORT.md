# DaoPai V3 Phase 5-G-8-6：侧边栏菜单优先，URL 仅兜底报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-6  
**修复目标**: 调整业务页面进入策略，侧边栏菜单点击为主路径，URL 仅作为最后兜底

---

## 一、策略调整 Before / After

### Before（URL 优先）

```
1. ensureCleanHome
2. URL 导航 (page.goto) → 验证
3. URL 重试 → 验证
4. 侧边栏菜单兜底 → 验证
5. 全部失败 → 快速失败
```

问题：笨鸟系统直接 URL 导航成功率低，经常停留在空白页/首页/旧页面。

### After（侧边栏优先）

```
Step 1: ensureCleanHome — 回干净首页 + 清弹窗
Step 2: 第一次侧边栏菜单点击 → afterPageChangedCleanup → 验证（URL + DOM）
Step 3: 失败 → 回首页 + 清弹窗 → 第二次侧边栏菜单点击 → 验证
Step 4: 仍失败 → URL 兜底 (page.goto) → afterPageChangedCleanup → 验证
Step 5: 全部失败 → 15s 内快速失败
```

---

## 二、修改文件

| 文件 | 修改内容 |
|------|---------|
| [BusinessPageNavigator.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/BusinessPageNavigator.ts) | 重写 `navigateToBusinessPage`：侧边栏优先 + 重试 + URL 兜底；更新 `NavigateResult.method` 类型 |

---

## 三、业务页面配置

复用已有 `BUSINESS_PAGE_SPECS`，不新增配置：

| 任务类型 | menuText | fallbackUrl | 关键元素 |
|----------|----------|-------------|---------|
| arrival | 到件扫描(批量) | `/scanning/ArrivalscanBatch` | `textarea`, `button.el-button--danger` |
| dispatch | 派件扫描 | `/scanning/dispatchscan` | `.dispatchscan_left input`, `.dispatchscan_left button.el-button--primary` |
| integrated | 到派一体 | `/scanning/arrivalscan` | `#waybillNum`, `.arrivalscan_left button.el-button--primary` |
| sign | 签收录入 | `/scanning/signFor/signForInput` | `.search-wrap .item-actions .el-button--primary`, `.search-wrap .inputs .el-date-editor` |

---

## 四、验证逻辑

验证不只看 URL，组合判断：

1. URL 包含预期路径（`isOnPage`）
2. 关键元素存在（`checkElements` — 逐个 selector 检查）
3. 弹窗已清理（`afterPageChangedCleanup` 后无残留）

---

## 五、弹窗清理覆盖

每次页面变化后都清理（复用 NativeAlertGuard + PopupManager）：

| 节点 | 原生 alert | DOM 弹窗 |
|------|:---:|:---:|
| 回首页后 | ✅ | ✅ |
| 点击菜单前（ensureCleanHome 内） | ✅ | ✅ |
| 点击菜单后 | ✅ drain | ✅ |
| URL 兜底后 | ✅ drain | ✅ |
| 业务页面校验前 | ✅ | ✅ |
| 任务结束后回首页 | ✅ drain | ✅ |

---

## 六、日志输出

### 成功路径

```
[导航] 准备进入业务页面：到派一体
[导航] 回首页，准备进入业务页面
[导航] 第一次点击侧边栏菜单：到派一体
[导航] 第一次菜单点击进入成功 (3200ms)
```

### 重试路径

```
[导航] 第一次菜单点击未进入目标页面，准备回首页重试
[导航] 第二次点击侧边栏菜单：到派一体
[导航] 第二次菜单点击进入成功 (5800ms)
```

### URL 兜底路径

```
[导航] 两次菜单点击均失败，准备使用 URL 兜底
[导航] URL 兜底进入成功 (8200ms)
```

### 任务结束

```
[导航] 任务结束，准备恢复首页
[导航] 首页已恢复并确认干净: https://bnsy.benniaosuyun.com/dashboard (1500ms)
```

---

## 七、任务结束后回首页

已在 Phase 5-G-8-4 实现，保持不变：

- `AssignmentEngine.executeAssignment` 的 `finally` 块中调用 `restoreCleanHome`
- `restoreCleanHome` 做最终确认清理（原生 alert + DOM 弹窗）
- 回首页失败不改变任务结果，但写 warning

---

## 八、编译验证

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

---

## 九、未修改项

- 到件/派件/到派一体/签收业务提交逻辑 — 不变
- AssignmentEngine 调度逻辑 — 不变
- Settings Center 数据结构 — 不变
- API 入参结构 — 不变
- 数据库结构 — 不变
- 任务中心展示结构 — 不变

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端编译通过  
**下一步**: 人工测试侧边栏菜单点击进入各业务页面的成功率
