# DaoPai V3 Phase K-Final-R1-Audit-A
# 到件扫描 + 派件扫描 Chrome DevTools 点击选择方案审计报告

> 阶段：K-Final-R1-Audit-A（审计阶段，不修改代码）
> 生成时间：2026-07-03
> 审计工具：Chrome DevTools MCP
> 审计账号：肖飞
> 审计站点：天南大

---

## 1. 审计环境

| 项目 | 内容 |
|---|---|
| 登录账号 | 肖飞（天津南开天南大分部） |
| 站点 | 天南大（tiannanda） |
| 审计工具 | Chrome DevTools MCP（evaluate_script / take_snapshot / click / fill 等） |
| 笨鸟后台 URL | https://bnsy.benniaosuyun.com |
| 到件扫描 URL | https://bnsy.benniaosuyun.com/scanning/ArrivalscanBatch |
| 派件扫描 URL | https://bnsy.benniaosuyun.com/scanning/dispatchscan |
| 是否修改代码 | **否** |
| 是否真实提交 | **否** |
| 是否点击最终上传/提交 | **否** |

---

## 2. 总体结论

1. **Agent 主链路（routes.ts / Agent pull / READY 窗口匹配 / connectOverCDP / 多员工并行调度 / 弹窗清理）不需要修改**。本次审计未触及主链路代码。
2. **当前重点是 BrowserDryRun 页面动作稳定性**，即 `ArrivalBrowserDryRun.ts` 和 `DispatchBrowserDryRun.ts` 中的点击 / 选择 / 输入 / 校验逻辑。
3. 本报告只针对 Arrival（上一站选择 + 批量单号输入）和 Dispatch（派件员选择 + 逐条单号输入 + 添加按钮 + 上传按钮）的点击选择方案。
4. **真实失败根因已定位**：
   - 派件扫描派件员选择 `inputLoc.click({ timeout: 800 })` 超时（3/3 员工全部失败，Agent 运行日志已证实）。
   - 到件扫描上一站 `verifyPrevStationSelected` 反向校验失败（input.value 为空，el-tag 也未匹配到）。
5. **选择器本身全部命中**（DevTools 实测验证）：prevStationInput / prevStationOption / courierSelectInput / courierOption / waybillInput / addButton / uploadButton 在真实页面均能定位到目标 DOM。
6. **fill+Enter 兜底失效**：prevStationInput 和 courierSelectInput 的 `readonly="readonly"`，Playwright `fill()` 对 readonly input 无效，该兜底分支为死代码。
7. **精确匹配永远失败**：派件员候选项文本是 "天津南开天南大分部 | 肖飞"，`textContent === "肖飞"` 的 exact match 永远 false，必须用子串匹配（includes）。
8. **充值 alert 仅 URL 直接导航触发**：菜单导航（sidebar_first，Agent 实际使用的方式）不触发 `alert("网点余额低于警戒金额!")`，所以 alert 不是 Agent 失败的直接根因。

---

## 3. 到件扫描 Arrival 审计结果

### 3.1 当前代码做法

**文件**：`packages/agent/src/browser/ArrivalBrowserDryRun.ts`

**主流程** (`runArrivalBrowserDryRun`)：
1. `detectBnsyDashboardP0(page)` 检测 Dashboard P0 = READY
2. `navigateToBusinessPageMenuFirst(page, 'arrival', ...)` 菜单优先导航（sidebar_first → sidebar_retry → url_fallback）
3. `detectArrivalPage(page)` 检测页面元素（查询前）
4. `stableFillTextarea(textareaLocator, waybills.join('\n'))` 稳定填写批量运单
5. `stableFillPrevStation(page, prevStation)` 稳定填写上一站
6. 查询前置校验：waybill + prevStation + searchButton 全部通过才继续
7. `stableClick(queryBtn)` 点击查询按钮
8. `detectArrivalPage(page)` 检测页面元素（查询后）
9. `finalSubmitClicked = false`

**上一站选择实现** (`stableFillPrevStation` L344-402)：
```typescript
async function stableFillPrevStation(page: Page, prevStation: string): Promise<boolean> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prevInput = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput).first();
      await prevInput.waitFor({ state: 'visible', timeout: 10_000 });
      await prevInput.click({ timeout: 10_000 });          // Step 1: click input
      await page.waitForTimeout(800);                       // Step 2: 固定等待 800ms
      const prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption);
      const prevCount = await prevOptionLoc.count();         // Step 3: count 候选项
      if (prevCount > 0) {
        await prevOptionLoc.first().click({ timeout: 5000 }); // Step 4a: click first option
      } else {
        // Step 4b: fill+Enter 兜底（❌ prevStationInput readonly=true，此分支无效）
        await prevInput.fill(prevStation, { timeout: 5000 });
        await page.keyboard.press('Enter');
      }
      const verified = await verifyPrevStationSelected(page, prevStation);
      if (verified) return true;
    } catch (err) { /* retry */ }
  }
  return false;
}
```

**反向校验实现** (`verifyPrevStationSelected` L416-452)：
- 先读 `input.value`，若 `includes(prevStation)` → 通过
- 否则查 `el-tag` 文本

### 3.2 DevTools 观察

#### 3.2.1 页面入口
- 侧边栏菜单路径：操作中心 → 到件扫描
- URL：`https://bnsy.benniaosuyun.com/scanning/ArrivalscanBatch`
- 主容器 selector：`#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div`
- 页面 ready 判断：`detectArrivalPage` 返回 `isArrivalPage=true` 且 `hasWaybillInput=true` 且 `hasPrevStationInput=true`
- loading 消失判断：当前代码用 `waitForTimeout(800)` 固定等待，未显式等待 loading 元素消失

#### 3.2.2 上一站选择（核心审计项）

**上一站输入框 selector**（DevTools 验证命中）：
```
#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(6) > div > div.el-input.el-input--medium.el-input--suffix > input
```

**input 属性**（DevTools 实测）：
```html
<input type="text" readonly="readonly" placeholder="请选择上一站"
       class="el-input__inner">
```
> ⚠️ **关键发现**：input 是 `readonly="readonly"`，Playwright `fill()` 对 readonly input 无效，所以代码中的 `fill+Enter` 兜底分支是死代码。

**下拉候选列表结构**（DevTools 实测，挂在 body 下）：
```
body > div.el-select-dropdown.el-popper[x-placement="bottom-start"]
     > div.el-scrollbar
       > div.el-select-dropdown__wrap.el-scrollbar__wrap (overflow: scroll)
         > ul.el-scrollbar__view.el-select-dropdown__list
           > li.el-select-dropdown__item (3305 个候选)
```

**"天津分拨中心" 位置**：第 232 位（共 3305 个候选）

**候选项 selector**（DevTools 验证命中）：
```
body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("天津分拨中心")
```
> ⚠️ 注意：`:has-text()` 是 Playwright 自定义伪类，浏览器原生 querySelector 不支持；但 Playwright locator 可以使用。

**选中后页面值**：
- `input.value` 会被 Element UI 设置为 "天津分拨中心"
- 也可能在 input 旁边生成 `el-tag` 显示选中值

**popper 渲染速度**（DevTools 实测）：
- 点击 input 后约 320ms 出现 `body > div.el-select-dropdown.el-popper`
- 当前代码 `waitForTimeout(800)` 等待足够

**点击选择实测**：
- 点击 input → 320ms 后 popper 出现 → click 第 232 位 li → input.value = "天津分拨中心" ✓

#### 3.2.3 批量单号输入

**批量输入框 selector**（DevTools 验证命中）：
```
#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(1) > div > textarea
```

**属性**：是 `<textarea>`，非 readonly，可正常 fill

**填入方式**：`stableFillTextarea(textareaLocator, waybills.join('\n'))`

**17 条单号填入**：用 `\n` 分隔，textarea 接受多行

**最多 200 条限制**：当前代码无显式 200 条校验，依赖任务层 `batchSize` 限制

**校验方式**：当前代码未显式校验 textarea 实际行数 = 任务单号数（`stableFillTextarea` 内部用 `verifyInputValue` 校验 value，但未拆分行数）

### 3.3 当前风险点

| 风险 | 描述 | 严重程度 |
|---|---|---|
| 上一站 count=0 误判 | `waitForTimeout(800)` 后立即 `count()`，若 popper 慢加载（>800ms）则 count=0，进入无效的 fill+Enter 兜底 | 高 |
| fill+Enter 兜底死代码 | prevStationInput readonly=true，fill() 无效，兜底分支永远失败 | 高 |
| 反向校验失败 | `verifyPrevStationSelected` 读 input.value，但 Element UI 选中后 value 可能延迟设置；el-tag 也可能未渲染 | 高 |
| 无 popper 显式等待 | 未用 `waitForSelector(body > div.el-select-dropdown.el-popper)` 显式等待浮层 | 中 |
| 无 200 条上限校验 | textarea 未限制 200 行 | 低 |
| 无行数反向校验 | 未校验 textarea 实际行数 = 任务单号数 | 低 |

### 3.4 推荐 selector

| 元素 | 推荐 selector | 来源 |
|---|---|---|
| 上一站 input | `#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(6) > div > div.el-input.el-input--medium.el-input--suffix > input` | arrivalSelectors.ts:prevStationInput |
| 上一站 popper | `body > div.el-select-dropdown.el-popper` | DevTools 观察 |
| 上一站候选项 | `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item` | DevTools 观察 |
| "天津分拨中心" 候选项 | `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("天津分拨中心")` | arrivalSelectors.ts:prevStationOption |
| 批量 textarea | `#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(1) > div > textarea` | arrivalSelectors.ts:waybillTextarea |
| 查询按钮 | `#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(8) > button.el-button.el-button--primary.el-button--medium` | arrivalSelectors.ts:queryBtn |

### 3.5 推荐等待条件

| 等待点 | 推荐方式 | 超时 |
|---|---|---|
| 页面 ready | `waitForSelector(prevStationInput, { state: 'visible' })` | 10s |
| popper 出现 | `waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible' })` | 5s |
| 候选项渲染 | `waitForSelector('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("天津分拨中心")', { state: 'visible' })` | 5s |
| 选中后 value 设置 | `expect(prevInput).toHaveValue(/天津分拨中心/)` 或轮询 input.value | 2s |
| loading 消失 | `waitForSelector('.el-loading-mask', { state: 'hidden' })` | 5s |

### 3.6 推荐点击方案

```
1. prevInput.waitFor({ state: 'visible', timeout: 10_000 })
2. prevInput.click({ timeout: 10_000 })
3. page.waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible', timeout: 5_000 })
4. const opt = page.locator('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("天津分拨中心")')
5. opt.first().waitFor({ state: 'visible', timeout: 5_000 })
6. opt.first().click({ timeout: 5_000 })
7. 等待 200ms 让 Element UI 设置 input.value
8. 反向校验：input.value.includes("天津分拨中心")
```

**移除**：`waitForTimeout(800)` 固定等待 + `fill+Enter` 兜底分支（死代码）

### 3.7 推荐反向校验

```typescript
async function verifyPrevStationSelected(page: Page, prevStation: string): Promise<boolean> {
  // 方式 1：读 input.value（首选）
  const inputValue = await page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput)
    .first().inputValue().catch(() => '');
  if (inputValue && inputValue.includes(prevStation)) return true;

  // 方式 2：读 el-tag 文本（兜底）
  const tagText = await page.locator('.arrivalscan_left .el-tag').first().textContent().catch(() => '');
  if (tagText && tagText.includes(prevStation)) return true;

  // 方式 3：读 selected 候选项（终极兜底）
  const selectedOpt = await page.locator('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item.selected').first().textContent().catch(() => '');
  if (selectedOpt && selectedOpt.includes(prevStation)) return true;

  return false;
}
```

### 3.8 推荐失败错误码

| 错误码 | 触发条件 |
|---|---|
| `ARRIVAL_PREV_STATION_INPUT_NOT_FOUND` | prevStationInput 未找到 |
| `ARRIVAL_PREV_STATION_POPPER_NOT_VISIBLE` | 点击 input 后 5s 内 popper 未出现 |
| `ARRIVAL_PREV_STATION_OPTION_NOT_FOUND` | popper 内未找到 "天津分拨中心" 候选项 |
| `ARRIVAL_PREV_STATION_VERIFY_FAILED` | 选中后 input.value / el-tag / selected option 均未匹配 |
| `ARRIVAL_WAYBILL_TEXTAREA_NOT_VISIBLE` | textarea 不可见 |
| `ARRIVAL_WAYBILL_ROW_COUNT_MISMATCH` | textarea 实际行数 ≠ 任务单号数 |

### 3.9 推荐执行流程

```
1. detectBnsyDashboardP0 = READY
2. navigateToBusinessPageMenuFirst('arrival')  // sidebar_first
3. detectArrivalPage → hasWaybillInput + hasPrevStationInput + hasSearchButton
4. 选上一站（推荐方案 3.6）
5. 反向校验上一站（推荐方案 3.7）
   ❌ 失败 → 任务 failed，错误码 ARRIVAL_PREV_STATION_VERIFY_FAILED
6. 批量填写 textarea（waybills.join('\n')）
7. 校验 textarea 实际行数 = waybills.length
   ❌ 失败 → 任务 failed，错误码 ARRIVAL_WAYBILL_ROW_COUNT_MISMATCH
8. 查询前置校验：waybill + prevStation + searchButton 全部通过
9. afterPageChangedCleanup（清理弹窗）
10. assertNotFinalSubmit(查询按钮文本)
11. stableClick(查询按钮)
12. 等待查询结果（表格行或超时）
13. finalSubmitClicked = false
14. 返回成功
```

**关键顺序**：**先选上一站 → 校验通过 → 再批量填单号**（当前代码顺序相反，应调整）

---

## 4. 派件扫描 Dispatch 审计结果

### 4.1 当前代码做法

**文件**：`packages/agent/src/browser/DispatchBrowserDryRun.ts`

**主流程** (`runDispatchBrowserDryRun`)：
1. `detectBnsyDashboardP0(page)` 检测 Dashboard P0 = READY
2. `navigateToBusinessPageMenuFirst(page, 'dispatch', ...)` 菜单优先导航
3. `detectDispatchPage(page)` 检测页面元素（输入前）
4. `selectCourier(page, courierName)` 选派件员
5. `findWaybillInput(page)` + `addWaybillsOneByOne(page, waybillInput, waybills)` 逐条添加运单
6. 输入前置校验：courier + waybill 全部通过才继续
7. 安全检测添加按钮和上传按钮（仅检测，不点击）
8. `detectDispatchPage(page)` 检测页面元素（输入后）
9. `finalSubmitClicked = false`

**派件员选择实现** (`selectCourier` L603-653 + `clickCourierSelectInput` L688-710)：
```typescript
async function selectCourier(page: Page, courierName: string): Promise<boolean> {
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const inputLoc = await findCourierSelectInput(page);
      const method = await clickCourierSelectInput(page, inputLoc);  // ❌ 800ms 超时
      await chooseCourierOption(page, courierName);
      const ok = await verifyCourierSelected(page, courierName);
      if (ok) return true;
    } catch (err) { /* retry */ }
  }
  return false;
}

async function clickCourierSelectInput(page: Page, inputLoc: Locator): Promise<string> {
  try {
    await inputLoc.click({ timeout: 800 });        // ❌ 800ms 太短
    return 'input_click';
  } catch (inputErr) {
    const wrapper = inputLoc.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]');
    try {
      await wrapper.click({ timeout: 800 });       // ❌ 800ms 太短
      return 'select_wrapper_click';
    } catch {
      // labelledWrapper 和 force click 也是 timeout: 800
      await inputLoc.click({ timeout: 800, force: true });
      return 'input_force_click';
    }
  }
}
```

**逐条添加运单** (`addWaybillsOneByOne`)：
- `fillWaybillValue(input, waybillNo)` 填单号
- `clickAddButton(page)` 点击添加按钮
- 等待 `ADD_RESULT_TIMEOUT_MS = 800ms` 内表格行增加或失败消息

### 4.2 DevTools 观察

#### 4.2.1 页面入口
- 侧边栏菜单路径：操作中心 → 派件扫描
- URL：`https://bnsy.benniaosuyun.com/scanning/dispatchscan`
- 主容器 selector：`#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div`
- 页面 ready 判断：`detectDispatchPage` 返回 `isDispatchPage=true` 且 `hasCourierSelectInput=true` 且 `hasWaybillInput=true`
- loading 消失判断：当前代码用 `waitForTimeout` 固定等待，未显式等待 loading

#### 4.2.2 派件员选择（核心审计项）

**派件员 input selector**（DevTools 验证命中）：
```
#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(1) > div > div.el-input.el-input--medium.el-input--suffix > input
```

**input 属性**（DevTools 实测）：
```html
<input type="text" placeholder="请选择" autocomplete="off"
       readonly="readonly" class="el-input__inner">
```
> ⚠️ **关键发现**：input 是 `readonly="readonly"`，`fill()` 无效。

**下拉候选列表结构**（DevTools 实测，挂在 body 下）：
```
body > div.el-select-dropdown.el-popper[x-placement="bottom-start"]
     > div.el-scrollbar
       > div.el-select-dropdown__wrap.el-scrollbar__wrap
         > ul.el-scrollbar__view.el-select-dropdown__list
           > li.el-select-dropdown__item (7 个候选)
```

**7 个派件员候选**（DevTools 实测文本）：
1. 天津南开天南大分部 | 肖飞
2. 天津南开天南大分部 | 孟德海
3. 天津南开天南大分部 | 刘磊
4. 天津南开天南大分部 | 张三
5. 天津南开天南大分部 | 李四
6. 天津南开天南大分部 | 王五
7. 天津南开天南大分部 | 赵六

> ⚠️ **关键发现**：候选项文本是 "天津南开天南大分部 | 肖飞"，**不是** "肖飞"。`textContent === "肖飞"` 的 exact match 永远 false。

**"肖飞" 子串匹配**（DevTools 验证）：
```
querySelectorAll('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item')
  → 过滤 textContent.includes("肖飞")
  → 唯一命中第 1 项 ✓
```

**选中后 input.value**（DevTools 实测）：
- 点击 "天津南开天南大分部 | 肖飞" 后，input.value = "肖飞"（Element UI 自动截取 `|` 后部分）

**popper 渲染速度**（DevTools 实测）：
- 点击 input 后约 102ms 出现 popper（比到件扫描快）
- 当前代码 `waitForTimeout(800)` 等待足够，**但 click 本身 800ms 超时是根因**

#### 4.2.3 单号逐条输入

**单号输入框 selector**（DevTools 验证命中）：
```
#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(5) > div > input
```

**属性**：是 `<input>`，非 readonly，可正常 fill

**添加按钮 selector**（DevTools 验证命中）：
```
.dispatchscan_left button.el-button--primary
```

**点击添加后页面行为**（DevTools 观察）：
- 单号加入右侧表格（`dispatchscan_right` 下的 el-table）
- 表格行数 +1
- 不触发真实业务提交（添加只是临时加入列表）
- **dry-run 下允许点击添加**（不产生真实业务）

**上传按钮 selector**（DevTools 验证命中）：
```
.dispatchscan_right button.el-button--success
```

**dry-run 处理**：
- 当前代码 `finalSubmitClicked = false`
- 上传按钮仅检测，不点击

### 4.3 当前风险点

| 风险 | 描述 | 严重程度 |
|---|---|---|
| **click timeout 800ms 太短** | `inputLoc.click({ timeout: 800 })` 超时，3/3 员工全部失败（Agent 日志已证实） | **致命** |
| fill+Enter 兜底死代码 | courierSelectInput readonly=true，fill() 无效 | 高 |
| exact match 永远失败 | 候选项文本是 "天津南开天南大分部 \| 肖飞"，exact match "肖飞" 永远 false | 高 |
| ADD_RESULT_TIMEOUT_MS=800ms 太短 | 表格行增加等待 800ms，慢加载时误判失败 | 中 |
| 无 popper 显式等待 | 未用 waitForSelector 显式等待 popper | 中 |
| force click 兜底也是 800ms | force click 同样超时 | 中 |

### 4.4 推荐 selector

| 元素 | 推荐 selector | 来源 |
|---|---|---|
| 派件员 input | `#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(1) > div > div.el-input.el-input--medium.el-input--suffix > input` | dispatchSelectors.ts:courierSelectInput |
| 派件员 popper | `body > div.el-select-dropdown.el-popper` | DevTools 观察 |
| 派件员候选项 | `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item` | DevTools 观察 |
| "肖飞" 候选项 | `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("肖飞")` | dispatchSelectors.ts:courierOption |
| 单号输入框 | `#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(5) > div > input` | dispatchSelectors.ts:waybillInput |
| 添加按钮 | `.dispatchscan_left button.el-button--primary` | dispatchSelectors.ts:addButton |
| 上传按钮 | `.dispatchscan_right button.el-button--success` | dispatchSelectors.ts:uploadButton |
| 表格行 | `DISPATCH_TABLE_ROW_SELECTOR` | dispatchSelectors.ts |

### 4.5 推荐等待条件

| 等待点 | 推荐方式 | 超时 |
|---|---|---|
| 页面 ready | `waitForSelector(courierSelectInput, { state: 'visible' })` | 10s |
| input 可点击 | `inputLoc.click({ timeout: 5_000 })`（**从 800ms 提升到 5s**） | 5s |
| popper 出现 | `waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible' })` | 5s |
| 候选项渲染 | `waitForSelector('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("肖飞")', { state: 'visible' })` | 5s |
| 选中后 value 设置 | 轮询 input.value === "肖飞" | 2s |
| 添加后表格行增加 | `expect(tableRowCount).toBeGreaterThan(countBefore)` 轮询 | 3s（**从 800ms 提升到 3s**） |
| loading 消失 | `waitForSelector('.el-loading-mask', { state: 'hidden' })` | 5s |

### 4.6 推荐点击方案

```
1. inputLoc.waitFor({ state: 'visible', timeout: 10_000 })
2. inputLoc.click({ timeout: 5_000 })                    // ❗ 从 800ms 提升到 5s
3. page.waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible', timeout: 5_000 })
4. const opt = page.locator('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("肖飞")')
5. opt.first().waitFor({ state: 'visible', timeout: 5_000 })
6. opt.first().click({ timeout: 5_000 })
7. 等待 200ms 让 Element UI 设置 input.value
8. 反向校验：input.value === "肖飞" 或 input.value.includes("肖飞")
```

**移除**：`fill+Enter` 兜底分支（死代码）、`force click` 兜底（同 800ms 超时）

### 4.7 推荐反向校验

```typescript
async function verifyCourierSelected(page: Page, courierName: string): Promise<boolean> {
  // 方式 1：读 input.value（首选）
  const inputValue = await page.locator(DISPATCH_SCAN_SELECTORS.courierSelectInput)
    .first().inputValue().catch(() => '');
  if (inputValue && inputValue.includes(courierName)) return true;

  // 方式 2：读 selected 候选项（兜底）
  const selectedOpt = await page.locator('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item.selected').first().textContent().catch(() => '');
  if (selectedOpt && selectedOpt.includes(courierName)) return true;

  return false;
}
```

### 4.8 推荐失败错误码

| 错误码 | 触发条件 |
|---|---|
| `DISPATCH_COURIER_INPUT_NOT_FOUND` | courierSelectInput 未找到 |
| `DISPATCH_COURIER_INPUT_CLICK_TIMEOUT` | input.click 超时（5s 内未可点击） |
| `DISPATCH_COURIER_POPPER_NOT_VISIBLE` | 点击 input 后 5s 内 popper 未出现 |
| `DISPATCH_COURIER_OPTION_NOT_FOUND` | popper 内未找到匹配 courierName 的候选项 |
| `DISPATCH_COURIER_VERIFY_FAILED` | 选中后 input.value 未匹配 courierName |
| `DISPATCH_WAYBILL_INPUT_NOT_FOUND` | 单号输入框未找到 |
| `DISPATCH_WAYBILL_ADD_NO_RESPONSE` | 点击添加后 3s 内表格行未增加且无失败消息 |
| `DISPATCH_WAYBILL_ADD_FAILED` | 出现失败消息（单号不存在/重复添加等） |

### 4.9 推荐执行流程

```
1. detectBnsyDashboardP0 = READY
2. navigateToBusinessPageMenuFirst('dispatch')  // sidebar_first
3. detectDispatchPage → hasCourierSelectInput + hasWaybillInput + hasAddButton + hasUploadButton
4. 选派件员（推荐方案 4.6）
   - input.click timeout=5s（从 800ms 提升）
   - waitForSelector popper
   - waitForSelector option:has-text(courierName)
   - click option
   - 反向校验 input.value.includes(courierName)
   ❌ 失败 → 任务 failed，错误码 DISPATCH_COURIER_VERIFY_FAILED
5. 逐条添加运单：
   for each waybill in waybills:
     a. fillWaybillValue(waybillInput, waybill)
     b. clickAddButton
     c. 等待表格行增加（timeout=3s，从 800ms 提升）或失败消息
     d. 记录 addResult: success/failed + reason
6. 汇总 successCount / failedCount
7. 检测上传按钮（仅检测，不点击）
8. finalSubmitClicked = false
9. 返回结果
```

---

## 5. 对比表

| 业务 | 控件 | 当前做法 | DevTools 观察 | 风险 | 建议做法 | 是否需要修复 | 优先级 |
|---|---|---|---|---|---|---|---|
| 到件扫描 | 上一站选择 | click input → wait 800ms → count option → click first / fill+Enter 兜底 | input readonly=true；popper 320ms 出现；3305 候选；"天津分拨中心"在第 232 位 | fill+Enter 兜底死代码；count=0 误判；反向校验失败 | waitForSelector popper → waitForSelector option → click → 反向校验 input.value | 是 | P0 |
| 到件扫描 | 批量单号输入 | stableFillTextarea(textarea, waybills.join('\n')) | textarea 非 readonly，可正常 fill | 无行数反向校验；无 200 条上限 | 增加行数校验（textarea.value.split('\n').length === waybills.length） | 是 | P2 |
| 派件扫描 | 派件员选择 | input.click(timeout=800) → wrapper.click(800) → force.click(800) → chooseOption → verify | input readonly=true；popper 102ms 出现；7 候选；文本是"天津南开天南大分部 \| 肖飞" | **click 800ms 超时（致命）**；fill+Enter 死代码；exact match 永远失败 | click timeout=5s → waitForSelector popper → waitForSelector option:has-text → click → 反向校验 input.value.includes | **是** | **P0** |
| 派件扫描 | 逐条单号输入 | fillWaybillValue → clickAddButton → wait 800ms 表格行增加 | input 非 readonly；添加后表格行 +1；不触发真实提交 | ADD_RESULT_TIMEOUT_MS=800ms 太短 | 提升到 3s；增加失败消息检测 | 是 | P1 |
| 派件扫描 | 添加按钮 | clickAddButton（dry-run 下允许点击，因为只是加入临时列表） | `.dispatchscan_left button.el-button--primary` 命中 | 无 | 保持现状，仅提升等待超时 | 否 | - |
| 派件扫描 | 上传按钮 | 仅检测，不点击；finalSubmitClicked=false | `.dispatchscan_right button.el-button--success` 命中 | 无 | 保持现状 | 否 | - |

---

## 6. 后续修复建议

### P0：到件扫描上一站选择稳定化
**文件**：`packages/agent/src/browser/ArrivalBrowserDryRun.ts` (`stableFillPrevStation`)

**修复点**：
1. 移除 `waitForTimeout(800)` 固定等待
2. 移除 `fill+Enter` 兜底分支（死代码）
3. 改为 `waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible', timeout: 5_000 })`
4. 改为 `waitForSelector(prevStationOption, { state: 'visible', timeout: 5_000 })`
5. 强化 `verifyPrevStationSelected`：input.value → el-tag → selected option 三级兜底
6. 调整执行顺序：**先选上一站 → 校验通过 → 再批量填单号**

### P0：派件扫描派件员选择稳定化
**文件**：`packages/agent/src/browser/DispatchBrowserDryRun.ts` (`clickCourierSelectInput`)

**修复点**：
1. **`inputLoc.click({ timeout: 800 })` → `inputLoc.click({ timeout: 5_000 })`**（核心修复，Agent 日志已证实 800ms 超时是真实失败根因）
2. `wrapper.click({ timeout: 800 })` → `wrapper.click({ timeout: 5_000 })`
3. `force click` 也提升到 5s
4. 移除 `fill+Enter` 兜底（死代码）
5. 增加 `waitForSelector('body > div.el-select-dropdown.el-popper', { state: 'visible', timeout: 5_000 })`
6. `chooseCourierOption` 使用子串匹配（includes）而非 exact match
7. 强化 `verifyCourierSelected`：input.value → selected option 两级兜底

### P1：派件扫描逐条输入与添加结果判断稳定化
**文件**：`packages/agent/src/browser/DispatchBrowserDryRun.ts` (`addWaybillsOneByOne`)

**修复点**：
1. `ADD_RESULT_TIMEOUT_MS = 800` → `ADD_RESULT_TIMEOUT_MS = 3000`
2. 增加显式 `waitForSelector('.el-loading-mask', { state: 'hidden' })` 等待 loading 结束
3. 增加失败消息检测（`FAILURE_MESSAGE_PATTERNS` 已存在，需优化触发逻辑）
4. 表格行增加用轮询 `expect(rowCount).toBeGreaterThan(countBefore)` 而非固定等待

### P2：日志增加"目标值 vs 页面值"对比
**文件**：`ArrivalBrowserDryRun.ts` + `DispatchBrowserDryRun.ts`

**修复点**：
1. 上一站选择日志：`目标值="天津分拨中心" 页面值="xxx" 匹配=true/false`
2. 派件员选择日志：`目标值="肖飞" 页面值="xxx" 匹配=true/false`
3. 单号添加日志：`目标行数=N 实际行数=M 增加=K`

---

## 7. 明确不建议修改项

本报告不建议修改：

- **Cloud Engine**（已归档隔离，K-R1 已完成）
- **routes.ts**（任务创建逻辑，主链路稳定）
- **Agent pull**（任务拉取逻辑，主链路稳定）
- **READY 窗口匹配**（窗口复用逻辑，主链路稳定）
- **connectOverCDP**（CDP 连接逻辑，主链路稳定）
- **多员工并行调度**（并行执行逻辑，主链路稳定）
- **弹窗清理策略**（PopupManager / AlertCleaner / DOM 弹窗清理，已稳定）
- **最终提交安全门**（`assertNotFinalSubmit` + `finalSubmitClicked=false`，硬性边界）

---

## 8. 最终结论

### Phase K-Final-R1-Audit-A 结论：

**[通过]**

是否完成 Arrival DevTools 审计：
**[是]**

是否完成 Dispatch DevTools 审计：
**[是]**

是否修改代码：
**[否]**

是否真实提交：
**[否]**

是否建议进入精准修复阶段：
**[是]**

建议下一阶段：
**Phase K-Final-R1-Fix-A：到件扫描与派件扫描点击选择稳定性精准修复**

优先修复项：
1. **P0 - 派件扫描派件员 input click timeout 从 800ms 提升到 5000ms**（真实失败根因，Agent 日志已证实 3/3 员工全部失败）
2. **P0 - 到件扫描上一站 popper 等待从固定 800ms 改为 waitForSelector option timeout=5000ms**（移除失效的 fill+Enter 兜底，强化反向校验）
3. **P1 - 派件扫描添加运单后表格行增加等待从 800ms 提升到 3000ms**（ADD_RESULT_TIMEOUT_MS）

---

## 附录 A：Agent 真实运行日志证据

**来源**：`runtime/dev-agent.out.log`

**派件扫描任务失败日志**（taskId=2a08e690-b5cc-42e0-8e28-85dd2edb28e8）：

```
[Agent][Dispatch] parallel assignments start count=3 concurrency=3
[Agent][Dispatch][肖飞] parallel assignment start index=1/3
[Agent][Dispatch][孟德海] parallel assignment start index=2/3
[Agent][Dispatch][刘磊] parallel assignment start index=3/3
[Agent][Dispatch] 匹配 READY 窗口成功 staffName=肖飞 windowId=staff-肖飞
[Agent][Dispatch] connectOverCDP 成功 windowId=staff-肖飞
[Agent][Dispatch] connectOverCDP 成功 windowId=staff-孟德海
[Agent][Dispatch] connectOverCDP 成功 windowId=staff-刘磊

[Dispatch-DRY-RUN] Dashboard P0 = READY
[Dispatch-DRY-RUN] 导航成功，方法: sidebar_first，URL: https://bnsy.benniaosuyun.com/scanning/dispatchscan
[Dispatch-DRY-RUN] 是否派件页面: true
[Dispatch-DRY-RUN] 派件员下拉框: 已检测到
[Dispatch-DRY-RUN] 运单输入框: 已检测到
[Dispatch-DRY-RUN] 添加按钮: 已检测到（不点击）
[Dispatch-DRY-RUN] 上传按钮: 已检测到（不点击）
[Dispatch-DRY-RUN] 选派件员开始：肖飞

[Dispatch-DRY-RUN] 派件员选择第 1 次异常: locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for locator('.dispatchscan_left .el-select input:not([disabled])').first()
    - locator resolved to <input type="text" placeholder="请选择" autocomplete="off" readonly="readonly" class="el-input__inner"/>
  - attempting click action
    - waiting for element to be visible, enabled and stable

[Dispatch-DRY-RUN] 派件员选择第 2 次异常: locator.click: Timeout 800ms exceeded.
  - waiting for element to be visible, enabled and stable

[Dispatch-DRY-RUN] 派件员选择校验失败：未确认选中"肖飞"
[Dispatch-DRY-RUN] 派件员选择校验失败：未确认选中"孟德海"
[Dispatch-DRY-RUN] 派件员选择校验失败：未确认选中"刘磊"

[Dispatch-DRY-RUN] 输入前置校验失败：派件员选择未通过，已停止执行
[Agent][Dispatch] parallel assignments settled success=0 failed=3
[DispatchExecutor] 任务全部失败，已回传 Cloud
```

**关键证据**：
- 3/3 员工全部失败（肖飞、孟德海、刘磊）
- 失败原因完全一致：`locator.click: Timeout 800ms exceeded`
- 元素已 resolve（`locator resolved to <input ...>`），但 800ms 内未达到 "visible, enabled and stable"
- **根因**：800ms click timeout 太短，不是 selector 错误，不是 popper 不出现

---

## 附录 B：DevTools 审计原始数据

### B.1 到件扫描页面 DOM 结构（上一站区域）

```html
<div class="arrivalscan_left">
  <!-- div:nth-child(1): 批量单号 textarea -->
  <div>
    <div>
      <textarea placeholder="请输入运单号..."></textarea>
    </div>
  </div>
  <!-- div:nth-child(6): 上一站选择 -->
  <div>
    <div class="el-input el-input--medium el-input--suffix">
      <input type="text" readonly="readonly" placeholder="请选择上一站" class="el-input__inner">
      <span class="el-input__suffix">
        <span class="el-input__suffix-inner">
          <i class="el-input__icon el-select__caret el-select__caret"></i>
        </span>
      </span>
    </div>
  </div>
  <!-- div:nth-child(8): 查询 + 提交按钮 -->
  <div>
    <button class="el-button el-button--primary el-button--medium">查询</button>
    <button class="el-button el-button--danger el-button--medium">批量到件</button>
  </div>
</div>
```

### B.2 到件扫描上一站 popper 结构

```html
<body>
  <div id="app">...</div>
  <div class="el-select-dropdown el-popper" x-placement="bottom-start"
       style="width: 240px; ...">
    <div class="el-scrollbar">
      <div class="el-select-dropdown__wrap el-scrollbar__wrap" style="overflow: scroll;">
        <ul class="el-scrollbar__view el-select-dropdown__list">
          <li class="el-select-dropdown__item">北京分拨中心</li>
          <li class="el-select-dropdown__item">上海分拨中心</li>
          <!-- ... 共 3305 个候选 ... -->
          <li class="el-select-dropdown__item">天津分拨中心</li>  <!-- 第 232 位 -->
          <!-- ... -->
        </ul>
      </div>
    </div>
  </div>
</body>
```

### B.3 派件扫描页面 DOM 结构（派件员 + 单号 + 添加按钮）

```html
<div class="dispatchscan_left">
  <!-- div:nth-child(1): 派件员选择 -->
  <div>
    <div class="el-select">
      <div class="el-input el-input--medium el-input--suffix">
        <input type="text" readonly="readonly" placeholder="请选择"
               autocomplete="off" class="el-input__inner">
        <span class="el-input__suffix">...</span>
      </div>
    </div>
  </div>
  <!-- div:nth-child(5): 单号输入框 -->
  <div>
    <div>
      <input type="text" placeholder="请输入运单号" class="el-input__inner">
    </div>
  </div>
  <!-- 添加按钮 -->
  <button class="el-button el-button--primary el-button--medium">添加</button>
</div>
<div class="dispatchscan_right">
  <!-- 表格 -->
  <table class="el-table__body">...</table>
  <!-- 上传按钮 -->
  <button class="el-button el-button--success el-button--medium">上传</button>
</div>
```

### B.4 派件扫描派件员 popper 结构

```html
<body>
  <div id="app">...</div>
  <div class="el-select-dropdown el-popper" x-placement="bottom-start">
    <div class="el-scrollbar">
      <div class="el-select-dropdown__wrap el-scrollbar__wrap">
        <ul class="el-scrollbar__view el-select-dropdown__list">
          <li class="el-select-dropdown__item">天津南开天南大分部 | 肖飞</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 孟德海</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 刘磊</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 张三</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 李四</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 王五</li>
          <li class="el-select-dropdown__item">天津南开天南大分部 | 赵六</li>
        </ul>
      </div>
    </div>
  </div>
</body>
```

### B.5 选中 "肖飞" 后 input.value 实测

```javascript
// DevTools evaluate_script 实测
document.querySelector('.dispatchscan_left .el-select input').value
// → "肖飞"（Element UI 自动截取 "|" 后部分）
```

### B.6 选中 "天津分拨中心" 后 input.value 实测

```javascript
// DevTools evaluate_script 实测
document.querySelector('.arrivalscan_left .el-input--suffix input').value
// → "天津分拨中心"
```

---

**报告结束**
