/**
 * 到件扫描（批量）页面 DOM 选择器（Agent 侧副本）
 *
 * 来源：backend/operations/selectors/arrivalScanBatch.selectors.ts
 * 采集：真实凤凰系统 DOM（2026-06-19）
 *
 * Phase 5-E-1：禁止猜测选择器，本文件所有常量均从旧执行流程代码原样复制。
 *
 * 操作顺序（旧流程 9 步，参考 ArriveScanBatch.ts）：
 *   1. 关闭充值弹窗（payDialogCloseBtn）
 *   2. 点击侧边栏"操作中心"（sidebarOperationCenter）
 *   3. 点击"到件扫描（批量）"二级菜单（sidebarArrivalBatchLink）
 *   4. 在 textarea 输入单号（waybillTextarea）
 *   5. 点击"上一站"下拉框，输入"天津分拨中心"，选择匹配项（prevStationInput + prevStationOption）
 *   6. 点击"查询"按钮（queryBtn）
 *   7. 点击"条数/页"下拉框，选择"200条/页"（pageSizeSelect + pageSizeOption）
 *   8. 点击表头全选框（selectAllCheckbox）
 *   9. 点击"批量到件"按钮（submitBatchBtn）—— DRY-RUN 模式跳过此步
 */

/** 默认"上一站"网点名称 */
export const DEFAULT_PREV_STATION = '天津分拨中心';

/** 默认每页条数（用于 pageSizeOption 文本匹配） */
export const DEFAULT_PAGE_SIZE = '200';

/** 到件扫描（批量）页面 URL 路径（来源：PageStateManager.ts:18） */
export const ARRIVAL_PAGE_ROUTE = '/scanning/ArrivalscanBatch';

/**
 * 到件扫描（批量）流程涉及的全部 DOM 选择器
 *
 * 来源：backend/operations/selectors/arrivalScanBatch.selectors.ts:28-69
 */
export const ARRIVAL_BATCH_SELECTORS = {
  /** 1. 充值弹窗关闭按钮（pay-dialog 底部 footer 内的 button） */
  payDialogCloseBtn:
    '#app > div.el-dialog__wrapper.pay-dialog > div > div.el-dialog__footer > span > button',

  /** 2. 侧边导航"操作中心"一级菜单项 */
  sidebarOperationCenter:
    '#app > div.app-wrapper.openSidebar > div.has-logo.sidebar-container > div.el-scrollbar > div.scrollbar-wrapper.el-scrollbar__wrap > div > ul > div:nth-child(6) > li > div',

  /** 3. "到件扫描（批量）"二级菜单链接 */
  sidebarArrivalBatchLink:
    '#app > div.app-wrapper.openSidebar > div.has-logo.sidebar-container > div.el-scrollbar > div.scrollbar-wrapper.el-scrollbar__wrap > div > ul > div:nth-child(6) > li > ul > div:nth-child(7) > a > li',

  /** 4. 运单号输入框 textarea
   *  来源：arrivalScanBatch.selectors.ts:42-43
   *  旧代码使用位置：ArriveScanBatch.ts:158, 162-176
   */
  waybillTextarea:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(1) > div > textarea',

  /** 5a. "上一站"下拉框 input
   *  来源：arrivalScanBatch.selectors.ts:46-47
   *  类型：Element el-input--suffix（el-select 下拉框），非普通 input
   *  旧代码使用位置：ArriveScanBatch.ts:182, 185, 193
   */
  prevStationInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(6) > div > div.el-input.el-input--medium.el-input--suffix > input',

  /** 5b. "上一站"下拉选项
   *  来源：arrivalScanBatch.selectors.ts:49-50
   *  旧代码使用位置：ArriveScanBatch.ts:185-188
   *  注意：el-select-dropdown 是 body 下的浮层，不在 #app 内
   *
   *  Phase I-4-Arrival-Fix: 改为动态函数，根据实际 prevStation 生成选择器，
   *  避免硬编码 DEFAULT_PREV_STATION 导致自定义上一站无法匹配。
   */
  getPrevStationOption: (text: string) =>
    `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${text}")`,

  /** @deprecated 使用 getPrevStationOption(text) 替代，避免硬编码 */
  prevStationOption: `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${DEFAULT_PREV_STATION}")`,

  /** 6. "查询"按钮（primary 样式）
   *  来源：arrivalScanBatch.selectors.ts:53-54
   *  旧代码使用位置：ArriveScanBatch.ts:206
   */
  queryBtn:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(8) > button.el-button.el-button--primary.el-button--medium',

  /** 7a. "条数/页"下拉选择框 input */
  pageSizeSelect:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.block > div > span.el-pagination__sizes > div > div.el-input.el-input--mini.el-input--suffix > input',

  /** 7b. "条数/页"下拉选项（通过文本匹配 DEFAULT_PAGE_SIZE，选择 200 条/页） */
  pageSizeOption: `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${DEFAULT_PAGE_SIZE}")`,

  /** 8. 表头全选复选框（不依赖动态 column ID，直接定位 selection 列的 checkbox） */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 9. "批量到件"提交按钮（danger 样式）
   *  来源：arrivalScanBatch.selectors.ts:67-68
   *  旧代码使用位置：ArriveScanBatch.ts:305
   *  DRY-RUN 模式下：ArriveScanBatch.ts:283-299 在点击前阻断
   */
  submitBatchBtn:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(8) > button.el-button.el-button--danger.el-button--medium',
} as const;

/**
 * 旧流程交互顺序参考（来源：ArriveScanBatch.ts:178-200）
 *
 * Step 7 选择"上一站"真实流程：
 *   1. await page.click(ARRIVAL_BATCH_SELECTORS.prevStationInput, { timeout: 10000 })
 *   2. await page.waitForTimeout(800)
 *   3. const prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption)
 *   4. const prevCount = await prevOptionLoc.count()
 *   5. if (prevCount > 0) { await prevOptionLoc.first().click(); await page.waitForTimeout(500); }
 *   6. else { 兜底：await page.fill(prevStationInput, DEFAULT_PREV_STATION); await page.keyboard.press('Enter'); }
 *
 * Step 8 点击"查询"按钮：
 *   await page.click(ARRIVAL_BATCH_SELECTORS.queryBtn, { timeout: 3000 })
 *   await page.waitForTimeout(3000)
 *   await page.waitForSelector('.el-table__body-wrapper .el-table__row', { timeout: 8000, state: 'visible' })
 */
