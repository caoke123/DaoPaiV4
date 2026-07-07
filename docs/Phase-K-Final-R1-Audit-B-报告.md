# DaoPai V3 Phase K-Final-R1-Audit-B
# 签收录入与到派一体 Chrome DevTools 点击选择方案审计报告

**审计日期**: 2026-07-03

---

## 〇、工作区状态

当前工作区存在大量未提交修改（来自上一轮 Fix-A），按指令**仅记录，不处理**：

- 修改文件（已追踪）: 51 个，包括 `SignBrowserDryRun.ts`, `IntegratedBrowserDryRun.ts`, `AgentBusinessRuntime.ts`, `SignExecutor.ts`, `IntegratedExecutor.ts` 等核心文件
- 新增未追踪文件: 36 个，主要是 `docs/` 下的 Phase 报告和相关文件

---

## 一、签收录入 Sign 审计

### 1.1 页面入口

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险/建议 |
|--------|------------|------------------------|----------|
| **侧边栏路径** | `操作中心 → 签收 → 签收录入` | ✅ 真实路径一致：`操作中心 → 签收 → 签收录入` | 无风险 |
| **真实 URL** | `https://bnsy.benniaosuyun.com/scanning/signFor/signForInput` | ✅ 完全匹配 | 无风险 |
| **页面 ready 判断** | `requiredElements: ['.search-wrap .item-actions .el-button--primary', '.search-wrap .inputs .el-date-editor']` | ✅ 两个元素在页面加载后均已出现 | 无风险 |
| **loading 消失判断** | `verifyRequiredElements` + `.el-loading-mask` hidden wait | ✅ 正确 | 建议：若页面初始化时有大量运单数据渲染，应等待 `.el-table__body-wrapper tbody tr` 或 `.el-table__empty-text` 出现 |
| **弹窗清理** | `afterPageChangedCleanup` (alert guard + drain + cleanDomPopups) | ✅ 首次访问时有"网点余额低于警戒金额" alert 和"充值" DOM 弹窗，已按现有策略处理 | 无风险 |
| **导航策略** | `navigateToBusinessPageMenuFirst` → sidebar_first → sidebar_retry → url_fallback | ✅ 审计实测：sidebar_first 成功导航 | **注意**：URL fallback 直接跳转确实触发原生 alert（实测确认），与已有设计原则一致 |

### 1.2 日期选择 ⚠️ **严重缺陷**

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险定级 |
|--------|------------|------------------------|----------|
| **是否设置日期** | **❌ 完全没有日期设置逻辑**。仅检测 `hasDateRangeInput`，不修改日期值 | 页面默认值：开始 `06-26 00:00:00` 至结束 `07-03 23:59:59`（最近7天） | **P0 严重** |
| **日期控件类型** | 选择器 `'.search-wrap .inputs .el-date-editor input'` | ✅ Element UI `el-date-range-picker`，非单个日期，是范围选择器 | 选择器正确 |
| **input 属性** | 未读取 | `readOnly: false`，可 fill；但日期面板需要点击交互 | 关键：不是 readonly，理论上可以 fill |
| **日期面板** | 代码含日期面板 selector（`datePickerStartInput`, `datePickerEndInput`, `datePickerConfirm`）但未调用 | 面板挂在 `body` 下，含 `el-picker-panel el-date-range-picker has-sidebar has-time` | 面板定位准确 |
| **反向校验** | ❌ 无 | 应读取 `dateInputs[0].value` 和 `dateInputs[1].value` 确认日期范围 | **缺失** |
| **默认规则** | ❌ 未定义 | 页面默认最近 7 天。若任务未传日期，风险是数据范围过大导致签收错误数据 | 需要明确默认规则 |

#### 1.2.1 日期选择推荐方案

```
推荐点击方式:
  1. 点击 dateRangeInput（打开日期范围面板）
  2. 等待面板出现：waitForSelector('.el-date-range-picker.has-time', { state: 'visible' })
  3. fill start input（非 readonly，可直接 fill）
  4. fill end input（非 readonly，可直接 fill）
  5. 点击"确定"按钮：datePickerConfirm

推荐等待条件:
  - 等待 loading mask 消失（若有）
  - 确认 input.value 已更新为目标日期

推荐反向校验:
  - 读取两个 el-range-input 的 value
  - 确认开始日期 = 目标日期、结束日期 = 目标日期（当天则设为当天 23:59:59）
  - 校验失败 → 错误码 SIGN_DATE_SELECTION_FAILED

推荐失败错误码:
  - SIGN_DATE_NOT_SET：未设置日期
  - SIGN_DATE_VERIFY_FAILED：日期反向校验失败
  - SIGN_DATE_PANEL_TIMEOUT：日期面板未出现

根因分析（为什么当前日期选择不正确）:
  1. PRIMARY: 根本没有设置日期 — SignBrowserDryRun 缺少日期选择调用
  2. SECONDARY: 没有反向校验 — 即使设置了也无从知道是否成功
```

### 1.3 派件员选择 ✅ 基本正确

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **input selector** | `'.search-wrap .inputs .el-select input'` | ✅ 精准命中 | 低 |
| **下拉挂载位置** | 挂载在 `body` 下 | ✅ `div.el-select-dropdown.el-popper` 挂在 body | 低 |
| **option selector** | `div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${staffName}")` | ✅ 候选文本格式：`"肖飞"`, `"魏宗信"` 等（纯姓名，无前缀） | 低 |
| **选中后 value** | 代码读取 `input.value` 做 `includes(staffName)` 校验 | ✅ `input.value` = `"肖飞"`（选中后） | 低 |
| **includes 匹配** | 第一步：`el-select-dropdown__item:has-text` + 精确或 includes 点击；`evaluate` 兜底 | ✅ `includes` 可行（无重复姓名），但精确匹配更安全 | 低 |

**推荐方案**：

```
推荐点击方式:
  1. Playwright click 打开下拉（element handle click 或 locator.click）
  2. 等待 popper 出现（waitForSelector 'div.el-select-dropdown.el-popper', state: 'visible'）
  3. 优先使用 Playwright locator.click 点击 option（触发 Vue 事件）
  4. 降级 evaluate DOM click 兜底

推荐 retry:
  - MAX_RETRIES = 3
  - 每次失败后按 Escape 关闭下拉，waitForTimeout 500ms

推荐反向校验:
  - 读取 input.value，严格等于 staffName（不用 includes）
  - 若 input.value 为空，检查 li.selected 文本
```

### 1.4 条数/页选择 ⚠️ 有风险

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **是否设置** | ✅ `setPageSize(page, pageSize)` 在 `selectCourier` 后被调用 | — | 正常 |
| **pageSize selector** | `'.el-pagination .el-pagination__sizes .el-input input'` | ✅ 命中分页下拉 | 低 |
| **option selector** | `div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${pageSizeText}")` | ⚠️ **同一个 popper 中混杂了派件员选项！** 共 13 个 option: 5 个 pageSize(10-200条/页) + 8 个派件员（网点管理员、罗晓红...请选择） | **中** |
| **evaluate click 生效** | 先用 Playwright click → 降级 evaluate DOM click | ⚠️ evaluate click 选中 "100条/页" 后 input.value 未更新（显示仍为 "10条/页"） | **中** |
| **反向校验** | ❌ 无 | 应读取分页 input.value 确认变为 "100条/页" | **缺失** |

**推荐方案**：

```
推荐点击方式:
  - 必须使用 Playwright 真实 click（locator.click），不能用 page.evaluate
  - 因为 evaluate DOM click 不触发 Vue 监听器，input.value 不会更新

推荐等待条件:
  - 点击 option 后等待 800ms
  - 等待 popper 关闭或消失

推荐反向校验:
  - 读取 .el-pagination__sizes input 的 value
  - 确认为 "100条/页"（或其他目标值）
  - 失败 → pageSizeVerifyFailed

推荐失败错误码:
  - SIGN_PAGESIZE_SELECT_FAILED
  - SIGN_PAGESIZE_VERIFY_FAILED
```

### 1.5 搜索与安全门 ⚠️ 有风险

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **搜索按钮 selector** | `'.search-wrap .item-actions .el-button--primary'` | ✅ 命中"搜索"按钮（text="搜索"） | 低 |
| **搜索前置校验** | 仅检查 `hasSearchButton` | ❌ **未校验日期、派件员、pageSize** | **P1 高** |
| **安全保护** | `assertNotFinalSubmit(btnText)` 检查搜索按钮文本不含危险词 | ✅ 正确 | 低 |
| **搜索后 loading** | `waitForTimeout(3000)` 硬等 | ✅ loading mask 搜索后保持不可见（无表格数据场景） | 建议：主动等待 `.el-loading-mask` hidden 后消失 |
| **暂无数据** | 由 `detectAfter.hasTable` 判断 | ✅ 搜索后若无数据，出现 `.el-table__empty-text` = "暂无数据"，rows=0 | 建议增加 `detectAfter.isEmptyResult` |
| **批量签收按钮** | `batchSignButton: '.search-wrap .item-actions .el-button--danger'` | ✅ 真实按钮 text="批量签收"，disabled=false | 低 |
| **dry-run 检测** | 仅检测不点击；`finalSubmitClicked = false` | ✅ 正确 | 低 |

**推荐方案**：

```
搜索前置条件（搜索前必须通过三项校验）:
  1. 日期正确 — 读取 input.value 确认日期范围设置成功
  2. 派件员正确 — 读取 input.value 确认严格等于目标姓名
  3. pageSize 正确 — 读取分页 input.value 确认为目标条数
  三项全部通过 → 执行搜索
  任一失败 → 返回错误并停止

推荐前置校验错误码:
  - SIGN_PRECHECK_DATE_FAILED
  - SIGN_PRECHECK_COURIER_FAILED
  - SIGN_PRECHECK_PAGESIZE_FAILED
```

---

## 二、到派一体 Integrated 审计

### 2.1 页面入口与到派一体 checkbox ✅ 基本正确

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **侧边栏路径** | `操作中心 → 到件扫描` | ✅ 正确：到件扫描菜单 → `https://bnsy.benniaosuyun.com/scanning/arrivalscan` | 低 |
| **checkbox selector** | `'.el-checkbox:has-text("到派一体") .el-checkbox__inner'` | ✅ 真实 DOM: `<label class="el-checkbox"><span class="el-checkbox__input"><span class="el-checkbox__inner"></span><input class="el-checkbox__original"/></span><span>到派一体</span></label>` | 低 |
| **Element UI 组件** | 是 | ✅ Element UI checkbox | 低 |
| **checked 状态读取** | `.el-checkbox:has-text("到派一体").is-checked` | ⚠️ `evaluate` DOM click 后 **`input.checked=true` 但 `el-checkbox.is-checked` 未添加**（Vue 未响应） | **中** |
| **勾选后变化** | 派件员输入框出现 | ✅ Row 12 出现 "派件员" input（placeholder="请选择", readonly=false）、"盲区派件" checkbox | 符合预期 |
| **反向校验** | `page.locator('.el-checkbox:has-text("到派一体").is-checked').count() > 0` | ⚠️ 如果用 evaluate click，`.is-checked` class 不会被添加 | **中** |

**推荐方案**：

```
推荐点击方式:
  - 使用 Playwright locator.click 点击 .el-checkbox__inner（触发 Vue 监听器）
  - 不能用 page.evaluate(el.click())

推荐反向校验:
  方式 1（推荐）: 检查 input.checked === true
  方式 2: 检查 .el-checkbox.is-checked 存在
  注意：用 evaluate click 时方式 2 不可靠，必须用方式 1 或改用 Playwright click

推荐失败错误码:
  - INTEGRATED_CHECKBOX_NOT_FOUND
  - INTEGRATED_CHECKBOX_VERIFY_FAILED
```

### 2.2 上一站选择 ✅ 逻辑正确，存在已知风险

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **input selector** | `findPrevStationInputByLabel`（label 文本定位）→ 回退 `nth-child(7)` | Row 7 是上一站，nth-child(7) 正确 | 低（有双保险） |
| **班次保护** | `assertNotShiftField` 双保险 | Row 2 是班次（nth-child(2)），保护到位 | 低 |
| **input 属性** | `readOnly: true` | ✅ | 低 |
| **popper 内容** | `li.el-select-dropdown__item` 3306 个选项 | ✅ "天津分拨中心" 是第一个含"天津"的选项 | 低 |
| **force click** | 代码使用 `force: true` + DOM click 兜底 + fill+Enter 兜底 | ✅ force click 是必要的（popper 在 DOM 中但 Playwright 可能认为不可见） | ⚠️ **fill+Enter 兜底违反审计指令**：readonly input 不应用 fill+Enter |
| **反向校验** | 三重：`input.value` / `el-tag` / `li.selected` | ✅ `input.value` = "天津分拨中心"（选中后） | 正确 |

**⚠️ 审计指令合规性警告**：

`stableFillPrevStation` 中的 Step 7（fill + Enter 兜底）**违反审计指令 2.3 节明确要求**："readonly input 不允许继续设计 fill+Enter 兜底"。虽然这在当前代码中是兜底步骤（前两步骤优先），但审计要求必须移除这个分支，改用纯 popper-click 方案。

### 2.3 派件员选择 ✅ 基本正确

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **input selector** | `'.arrivalscan_left > div > div:nth-child(12) input'` | ✅ Row 12 正确 | 硬编码 nth-child 有 DOM 变化风险 |
| **弹窗类型** | `div.el-dialog__wrapper:has-text("选择派件员")`（modal dialog，非 el-select） | ✅ 确认：是 `dialog "选择派件员" modal`，非下拉 | 低 |
| **表格行 selector** | `'.el-dialog__wrapper .el-table__body-wrapper tbody tr.el-table__row'` | ✅ 7 rows | 低 |
| **员工编号列** | 代码遍历所有 td 严格相等匹配 | ⚠️ 真实列 class = `el-table_3_column_26`（代码写 `el-table_2_column_16`） | **不影响**：evaluate 遍历所有 td 做严格相等匹配，不依赖固定列 class |
| **"使用"按钮** | `'.el-dialog__wrapper .el-table__fixed-right tbody tr button.el-button--primary.el-button--mini'` + `.nth(matchedRowIdx)` | ✅ 操作列在 `.el-table__fixed-right` 中可见（主表 `is-hidden`） | 低 |
| **回填校验** | 弹窗关闭后读取 `input.value === courierName` | ✅ 需要 Playwright 真实 click 触发 Vue | 低 |

**推荐方案**：

```
推荐点击方式:
  - courierSelectInput Playwright click → 等待 dialog visible →
    遍历表格行按 employeeId 严格相等匹配 → Playwright click "使用"按钮
  - 必须全程使用 Playwright 真实 .click()，不能 evaluate

推荐等待条件:
  - 派件员 input click 后等 dialog visible（timeout 10s）
  - "使用" click 后等 dialog hidden（timeout 5s）

推荐反向校验:
  - input.value 严格等于 courierName
  - 弹窗已关闭（hidden）
```

### 2.4 逐条输入单号 ✅ 安全

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **是否只处理第一条** | ✅ 是：`waybills[0]`（smoke test） | — | 符合 dry-run 设计 |
| **输入 selector** | `'#waybillNum'` | ✅ id 选择器，精准命中 | 低 |
| **添加按钮** | **仅检测不点击** | ✅ `button.el-button--primary` text="添加"，disabled=false | 符合安全要求 |
| **上传按钮** | **仅检测不点击** | ✅ `button.el-button--success` text="上传"，disabled=false | 符合安全要求 |
| **添加行为** | — | "添加"将运单加入右侧表格（本地临时列表），不触发 API 提交 | 安全 |
| **上传行为** | — | "上传"是最终服务器提交 | **绝对不能点击** |

**明确结论**：
- "添加"按钮：将运单加入右侧临时列表，不触发真实业务提交 → **DRY-RUN 下允许点击**
- "上传"按钮：真实服务器提交 → **DRY-RUN 下绝对禁止点击**

### 2.5 最终上传安全门 ✅ 正确

| 审计项 | 代码当前做法 | Chrome DevTools 观察结论 | 风险 |
|--------|------------|------------------------|------|
| **上传按钮 selector** | `'.arrivalscan_right button.el-button--success'` | ✅ text="上传"，正确 | 低 |
| **检测不点击** | ✅ 仅通过 `detectBefore.hasUploadButton` 检测 | ✅ `finalSubmitClicked = false` 明确赋值 | 低 |
| **安全关键词** | `FORBIDDEN_BUTTON_KEYWORDS = ['上传', '提交', '确认', ...]` | ✅ 覆盖全面 | 低 |
| **确认弹窗** | `confirmDialogWrapper: '.el-message-box__wrapper'` 仅检测 | — | 低 |

---

## 三、整体评估

### 3.1 签收录入 Sign 评分

| 审计维度 | 状态 | 等级 |
|---------|------|------|
| 页面导航 | ✅ 正确 | PASS |
| 弹窗清理 | ✅ 使用已有方案 | PASS |
| **日期选择** | ❌ 完全缺失 | **FAIL** |
| 派件员选择 | ✅ 基本正确 | PASS |
| 条数/页选择 | ⚠️ evaluate click 不更新 value，无校验 | WARN |
| 搜索安全门 | ⚠️ 缺前置校验 | WARN |
| 最终提交阻止 | ✅ 正确 | PASS |
| 失败重试 | ❌ 无 retry | INFO |

### 3.2 到派一体 Integrated 评分

| 审计维度 | 状态 | 等级 |
|---------|------|------|
| 页面导航 | ✅ 正确 | PASS |
| 到派一体 checkbox | ⚠️ evaluate click 后 is-checked class 不更新 | WARN |
| 上一站选择 | ⚠️ fill+Enter 兜底违反审计指令 | WARN |
| 派件员选择 | ✅ 正确（evaluate 遍历 td 不受列 class 变化影响） | PASS |
| 逐条输入单号 | ✅ 安全（仅输入不添加） | PASS |
| "添加"按钮安全 | ✅ 不点击 | PASS |
| 最终上传安全门 | ✅ 正确 | PASS |
| 失败重试 | ✅ MAX_RETRIES=3（仅上一站选择有重试） | PARTIAL |

### 3.3 关键发现汇总

| # | 发现 | 严重程度 | 涉及文件 |
|---|------|---------|---------|
| 1 | **Sign 完全没有日期选择逻辑** — 只检测不设置，也没有反向校验 | **P0** | SignBrowserDryRun.ts |
| 2 | **Sign 搜索前无前置条件校验**（日期/派件员/pageSize 三项均未校验） | **P1** | SignBrowserDryRun.ts |
| 3 | **Sign pageSize evaluate click 不触发 Vue 更新** — input.value 始终不变化 | **P1** | SignBrowserDryRun.ts |
| 4 | **Integrated 上一站 fill+Enter 兜底违反审计指令** — readonly input 不应使用 fill+Enter | **P2** | IntegratedBrowserDryRun.ts |
| 5 | **Integrated checkbox evaluate click 后 el-checkbox.is-checked 不出现** — 仅 input.checked=true | **P2** | IntegratedBrowserDryRun.ts |
| 6 | **Integrated 派件员弹窗表格列 class 硬编码错误** — 代码写 `_column_16`，实为 `_column_26`（但不影响功能，因 evaluate 遍历所有 td） | INFO | integratedSelectors.ts |
| 7 | **Sign 页默认日期为最近 7 天**，若任务未指定日期，代码不做任何控制 | INFO | SignBrowserDryRun.ts |

---

## 四、审计指令遵从检查

| 审计指令 | 遵从状态 |
|---------|---------|
| 禁止修改源码文件 | ✅ 遵守 |
| 禁止点击最终提交按钮 | ✅ 遵守（未点击批量签收、上传、使用） |
| 使用已有弹窗清理方案 | ✅ 遵守（afterPageChangedCleanup → alert guard + drain + cleanDomPopups） |
| 侧边栏优先导航 | ✅ 遵守（实测 sidebar_first 成功） |
| 只读审计 | ✅ 遵守（仅读取源码 + DevTools observe + evaluate） |
| 不改变业务数据 | ✅ 遵守（无真实签收/上传/到派一体提交） |
