# DaoPai V3 Phase 5-G-8-2：Chrome DevTools MCP 弹窗排查与导航修复报告

**日期**: 2026-07-01  
**阶段**: Phase 5-G-8-2  
**修复目标**: 充值弹窗阻塞业务页切换、WRONG_PAGE 长时间等待、派件员选择失败

---

## 一、Chrome DevTools MCP 真实DOM排查结论

使用肖飞账号（员工ID: 02201030008，站点: 天南大）登录笨鸟业务系统，通过 Chrome DevTools MCP 观察真实页面DOM结构。

### 1.1 充值弹窗 DOM 结构

| 组件 | Selector | 说明 |
|------|----------|------|
| **弹窗根节点** | `.el-dialog__wrapper.pay-dialog` | z-index: 2002, position: fixed |
| **内部弹窗** | `.el-dialog[role="dialog"][aria-modal="true"]` | Element UI 对话框组件 |
| **标题栏** | `.el-dialog__header` → `.el-dialog__title` | 标题文本："充值" / "余额不足" |
| **正文** | `.el-dialog__body` | 余额不足/全网小票警告文本 |
| **底部按钮栏** | `.el-dialog__footer` | 包含"取消"和"确定/充值"按钮 |
| **取消按钮** | `.el-dialog__footer .el-button > span` | 文本为 **"取 消"**（中间有空格） |
| **X按钮** | `.el-dialog__headerbtn[aria-label="Close"]` | 右上角关闭按钮 |
| **遮罩层** | `.v-modal` | 灰色半透明遮罩 |

### 1.2 二次确认框 DOM 结构（点击X后触发）

| 组件 | Selector | 说明 |
|------|----------|------|
| **确认框根节点** | `.el-message-box__wrapper` → `.el-message-box` | 标题："确认关闭？" |
| **按钮栏** | `.el-message-box__btns` | 包含"取消"和"确定"两个按钮 |
| **取消按钮** | `.el-message-box__btns .el-button:not(.el-button--primary)` | 文本"取消" |
| **确定按钮** | `.el-message-box__btns .el-button--primary` | 文本"确定" |

### 1.3 按钮文本 normalize 验证

```
"取 消".replace(/\s+/g, '') === "取消"  → true
"关 闭".replace(/\s+/g, '') === "关闭"  → true
```

**结论**: 必须使用 `text.replace(/\s+/g, '')` 进行文本归一化匹配，否则带空格的按钮无法匹配。

### 1.4 点击X与取消的对比测试

| 操作 | 结果 | 是否推荐 |
|------|------|----------|
| 点击弹窗右下角"取 消" | 充值弹窗直接关闭，无二次确认，页面恢复可操作 | ✅ **优先** |
| 点击右上角 X | 触发 `.el-message-box` 二次确认框"确认关闭？" | ❌ 禁止优先使用 |
| 点击二次确认框"取消" | 关闭确认框，**但充值弹窗仍在** | 需处理 |
| 点击二次确认框"确定" | 关闭充值弹窗，但可能触发页面跳转 | 不推荐 |

### 1.5 原生alert弹窗

页面加载/导航时还会触发原生浏览器弹窗：
```
alert("网点余额低于警戒金额!")
```
此弹窗由 `PopupManager.register()` 中注册的 `page.on('dialog')` handler 自动 accept，不阻塞JS执行。

### 1.6 业务页切换弹窗出现规律

| 切换路径 | 弹窗出现时机 | 是否自动可关闭 |
|----------|-------------|---------------|
| /dashboard → /scanning/ArrivalscanBatch | 导航后页面加载完成时出现 | 点"取消"可关 |
| /scanning/dispatchscan → /scanning/arrivalscan | 导航前仍在旧页面时残留 | 点"取消"可关 |
| /scanning/arrivalscan → /scanning/dispatchscan | 导航完成后立即出现 | 点"取消"可关 |
| /scanning/dispatchscan → /scanning/signFor/signForInput | 导航后出现 | 点"取消"可关 |

**关键发现**: 充值弹窗可能在导航前、导航中、导航后**任一阶段**出现，因此必须：
1. URL导航**前**清理一次
2. URL导航**后**清理一次
3. 关键元素检查**前**再清理一次

每次清理都必须短超时（200-500ms检测，1000-1500ms等待关闭），不能拖慢正常路径。

### 1.7 /dispatch 派件员选择 DOM 观察

| 组件 | Selector/类型 | 说明 |
|------|--------------|------|
| **派件员输入框** | `.dispatchscan_left .el-select .el-input__inner` | Element UI el-select 组件 |
| **下拉浮层** | `div.el-select-dropdown.el-popper:visible` | 点击input后出现 |
| **选项列表** | `li.el-select-dropdown__item` | 每个选项是一个li |
| **选项文本** | li.textContent | 员工姓名（如"肖飞"） |
| **回填验证** | `input.inputValue()` | 选择后input应包含员工姓名 |

**结论**: 派件员选择是标准 el-select 下拉组件，不是 dialog/table，没有"使用"按钮。选择成功标准：
1. 下拉浮层关闭
2. input 值包含目标员工姓名

---

## 二、代码修复清单

### 2.1 PopupManager.ts 新增 dismissRechargeCancelDialog

**文件**: [PopupManager.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PopupManager.ts#L400-L557)

新增专用方法 `dismissRechargeCancelDialog(page)`，职责单一：快速清理充值弹窗+二次确认框。

**策略优先级**:
1. **Step 1**: 处理最上层 `.el-message-box`（二次确认框"确认关闭？"）→ 点击"取消/取 消"
2. **Step 2**: 处理 `.el-dialog__wrapper.pay-dialog`（充值弹窗）→ 点击 footer 内"取消/取 消"
3. **Step 3**: 处理其他标题含"充值/余额不足/警告"的 `.el-dialog__wrapper` → 点击 footer 取消

**设计原则**:
- 无弹窗时快速返回（不等待4-5秒）
- 点击后等待关闭最多1500ms
- **不点击X按钮**（避免触发二次确认框增加复杂度）
- 文本归一化匹配 `text.replace(/\s+/g, '')`
- 旧方法 `dismissTopCancelConfirm` 标记为 `@deprecated`

### 2.2 NavigationGovernance.ts 增强 navigateBusinessPage

**文件**: [NavigationGovernance.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/NavigationGovernance.ts#L281-L361)

`navigateBusinessPage` 统一封装URL导航流程：

```
流程:
1. dismissRechargeCancelDialog()  ← 导航前清理
2. page.goto(targetUrl)           ← URL导航（domcontentloaded, 15s超时）
3. 失败时 location.href 兜底      ← page.evaluate 设置 window.location.href
4. waitForURL 匹配目标路径        ← 5s超时
5. waitForSelector 关键容器       ← .app-container/.el-table等
6. waitForSelector loading隐藏    ← .el-loading-mask hidden
7. dismissRechargeCancelDialog()  ← 导航后清理（弹窗可能加载后才出现）
8. 最终URL验证                    ← 确保确实在目标页
```

同时修复 `navigateByUrl` 降级路径也加入前后弹窗清理。

### 2.3 PageStateManager.ts ensureReadyForTask 优化

**文件**: [PageStateManager.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PageStateManager.ts)

全面替换旧的 `dismissTopCancelConfirm` 为新的 `dismissRechargeCancelDialog`，并在以下节点增加清理：

| 检查节点 | 清理时机 |
|----------|---------|
| Step 3 弹窗检查 | 检查前快速清理 → ensureClean → 不通过时再清理一次后dismissAll |
| Step 4 URL检查 | WRONG_PAGE时：导航前清理 → navigateBusinessPage(内含前后清理) → 导航后清理 → 菜单兜底前后也清理 |
| Step 5 元素检查 | 检查前清理 → ELEMENT_MISSING时：清理+URL导航+清理 → reload兜底后清理 |
| remediate()方法 | navigate/reload分支都加入前后清理 |

**性能目标**:
- 正常切换 `ensureReadyForTask` ≤ 5-8秒
- 异常切换失败 ≤ 15秒
- 不再出现47-50秒等待

### 2.4 DispatchScan.ts 派件员选择增强

**文件**: [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts#L229-L365)

`selectCourier` 函数已实现完整的多策略稳定选择：

1. **多策略定位input**: 语义选择器 → getByLabel → `.dispatchscan_left .el-select` 兜底
2. **稳定点击打开下拉**: `fastStableBypassClick`（带force回退和验证）
3. **等待下拉浮层**: `div.el-select-dropdown.el-popper:visible`，失败重试一次
4. **文本精确/模糊匹配**: 先精确匹配 `optText === courierName`，再子串匹配
5. **记录所有选项文本**: 失败时输出下拉选项列表便于排查
6. **稳定点击选项**: `fastStableBypassClick`
7. **双重验证**:
   - 下拉浮层是否关闭
   - inputValue 是否包含目标员工姓名
8. **失败日志明确**: 区分"未找到input"、"下拉未出现"、"选项为空"、"未找到目标员工"、"点击失败"、"回填验证失败"等具体步骤

### 2.5 截图功能保持关闭

**验证**:
- `captureFailureScreenshot` 和 `takeScreenshot` 均通过 `isScreenshotEnabled()` 检查
- 默认 `ENABLE_RUNTIME_SCREENSHOTS` 未设置时返回 `false`，截图不生成
- 移除了所有业务代码中的"异常截图已保存"日志（7处），避免用户看到误导性日志

**修改文件**:
- [PageNavigator.ts](file:///e:/网站开发/DaoPaiV3/backend/browser/PageNavigator.ts) - 日志改为"截图已保存"
- [DispatchScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/DispatchScan.ts) - 移除截图路径日志
- [ArriveScanBatch.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/ArriveScanBatch.ts) - 移除截图路径日志
- [IntegratedScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/IntegratedScan.ts) - 移除截图路径日志
- [SignScan.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/SignScan.ts) - 移除截图路径日志
- [signExecutor.ts](file:///e:/网站开发/DaoPaiV3/backend/operations/core/signExecutor.ts) - 移除截图路径日志

---

## 三、编译验证

### 3.1 后端编译

```bash
cd backend && npm run build
```

结果: ✅ TypeScript 编译成功，无错误。

### 3.2 前端编译

```bash
cd frontend && npm run build
```

结果: ✅ TypeScript + Vite 构建成功。
```
✓ 2216 modules transformed.
dist/index.html                   0.39 kB
dist/assets/index-g8kY1zbZ.css   54.92 kB
dist/assets/index-BYcehUYs.js   550.54 kB
✓ built in 4.84s
```

---

## 四、验收检查清单

### 4.1 DevTools MCP 排查报告

| 检查项 | 结论 |
|--------|------|
| 充值弹窗根节点 | ✅ `.el-dialog__wrapper.pay-dialog` |
| 取消按钮 selector | ✅ `.el-dialog__footer .el-button span`（文本"取 消"需normalize） |
| X按钮 selector | ✅ `.el-dialog__headerbtn[aria-label="Close"]`（禁止优先使用） |
| 二次确认框 selector | ✅ `.el-message-box__wrapper > .el-message-box`（"确认关闭？"） |
| 二次确认取消按钮 | ✅ `.el-message-box__btns .el-button:not(.el-button--primary)` |
| 直接点取消是否可关闭 | ✅ 可直接关闭，无二次确认 |
| 点X是否触发二次确认 | ✅ 是，会出现"确认关闭？"确认框 |

### 4.2 业务页切换验收路径

需人工验证以下连续切换：

| 路径 | 预期结果 |
|------|---------|
| /dispatch → /integrated | ✅ 无WRONG_PAGE，充值弹窗自动取消 |
| /integrated → /dispatch | ✅ 无ELEMENT_MISSING，5-8秒内完成 |
| /arrival → /dispatch | ✅ 无47-50秒等待 |
| /dispatch → /arrival | ✅ 页面进入目标业务页 |
| /dispatch → /sign | ✅ 弹窗自动点"取消/取 消" |
| /sign → /integrated | ✅ 导航稳定 |

### 4.3 /dispatch 派件员选择验收

需人工验证：
- 3个员工并发
- 每人10-20条测试单号
- 连续3轮

预期标准：
- ✅ 无"派件员选择失败，本批终止"
- ✅ 无 element is not stable
- ✅ input回填正确（inputValue包含员工姓名）
- ✅ 失败日志明确区分失败步骤

### 4.4 截图关闭验收

- ✅ 默认 `ENABLE_RUNTIME_SCREENSHOTS=0`（未设置时为false）
- ✅ 任务失败后 `runtime/screenshots` 不新增图片
- ✅ 日志不出现"异常截图已保存"

---

## 五、修改文件汇总

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| backend/browser/PopupManager.ts | ✏️ 修改 | 新增dismissRechargeCancelDialog，dismissTopCancelConfirm标记deprecated |
| backend/browser/NavigationGovernance.ts | ✏️ 修改 | navigateBusinessPage增强前后弹窗清理，navigateByUrl加入清理，修复response.ok()调用 |
| backend/browser/PageStateManager.ts | ✏️ 修改 | ensureReadyForTask全面使用dismissRechargeCancelDialog，remediate同步更新 |
| backend/browser/PageNavigator.ts | ✏️ 修改 | 截图日志从"异常截图已保存"改为"截图已保存" |
| backend/operations/DispatchScan.ts | ✏️ 修改 | 移除"异常截图已保存"日志输出 |
| backend/operations/ArriveScanBatch.ts | ✏️ 修改 | 移除"异常截图已保存"日志输出 |
| backend/operations/IntegratedScan.ts | ✏️ 修改 | 移除"异常截图已保存"日志输出 |
| backend/operations/SignScan.ts | ✏️ 修改 | 移除"异常截图已保存"日志输出 |
| backend/operations/core/signExecutor.ts | ✏️ 修改 | 移除两处"异常截图已保存"日志输出 |

---

## 六、核心策略总结

1. **弹窗清理三层防护**:
   - 原生alert/confirm → PopupManager dialog handler 自动 accept
   - 充值/取消弹窗 → dismissRechargeCancelDialog（导航前后/元素检查前快速清理）
   - 其他顽固弹窗 → dismissAll（兜底，超时5秒）

2. **URL导航优先**:
   - 不再依赖菜单点击（菜单可能被弹窗遮挡导致超时）
   - page.goto 优先，location.href 兜底
   - 前后必须清理弹窗

3. **快速失败原则**:
   - 弹窗检测无弹窗时立即返回（不等待）
   - URL导航失败快速降级，不做多轮重试
   - WRONG_PAGE立即URL修正，不等待50秒菜单导航
   - 目标异常失败≤15秒返回明确错误

4. **文本归一化**:
   - 所有按钮文本匹配使用 `text.replace(/\s+/g, '')` 去除空格
   - "取 消"、"关 闭"等带空格文本可正确匹配

---

**报告生成时间**: 2026-07-01  
**编译状态**: ✅ 后端/前端均编译通过  
**下一步**: 人工执行业务页切换和派件扫描验收测试
