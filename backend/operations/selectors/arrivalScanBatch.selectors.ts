/**
 * 到件扫描（批量）页面 DOM 选择器配置
 *
 * 来源：真实凤凰系统 DOM 采集（2026-06-19）
 * 用途：ArriveScanBatch 操作模块引用，避免选择器散落在业务代码中
 */

/** 默认"上一站"网点名称 */
export const DEFAULT_PREV_STATION = '天津分拨中心';

/** 默认每页条数（用于 pageSizeOption 文本匹配） */
export const DEFAULT_PAGE_SIZE = '200';

/**
 * 到件扫描（批量）流程涉及的全部 DOM 选择器
 *
 * 操作顺序（9步）：
 * 1. 关闭充值弹窗（payDialogCloseBtn）
 * 2. 点击侧边栏"操作中心"（sidebarOperationCenter）
 * 3. 点击"到件扫描（批量）"二级菜单（sidebarArrivalBatchLink）
 * 4. 在 textarea 输入单号（waybillTextarea）
 * 5. 点击"上一站"下拉框，输入"天津分拨中心"，选择匹配项（prevStationInput + prevStationOption）
 * 6. 点击"查询"按钮（queryBtn）
 * 7. 点击"条数/页"下拉框，选择"200条/页"（pageSizeSelect + pageSizeOption）
 * 8. 点击表头全选框（selectAllCheckbox）
 * 9. 点击"批量到件"按钮（submitBatchBtn）
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

  /** 4. 运单号输入框 textarea */
  waybillTextarea:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(1) > div > textarea',

  /** 5a. "上一站"下拉框 input */
  prevStationInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(6) > div > div.el-input.el-input--medium.el-input--suffix > input',

  /** 5b. "上一站"下拉选项（通过文本匹配 DEFAULT_PREV_STATION，过滤后唯一可见项） */
  prevStationOption: `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${DEFAULT_PREV_STATION}")`,

  /** 6. "查询"按钮（primary 样式） */
  queryBtn:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(8) > button.el-button.el-button--primary.el-button--medium',

  /** 7a. "条数/页"下拉选择框 input */
  pageSizeSelect:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.block > div > span.el-pagination__sizes > div > div.el-input.el-input--mini.el-input--suffix > input',

  /** 7b. "条数/页"下拉选项（通过文本匹配 DEFAULT_PAGE_SIZE，选择 200 条/页） */
  pageSizeOption: `body > div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${DEFAULT_PAGE_SIZE}")`,

  /** 8. 表头全选复选框（不依赖动态 column ID，直接定位 selection 列的 checkbox） */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 9. "批量到件"提交按钮（danger 样式） */
  submitBatchBtn:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div:nth-child(8) > button.el-button.el-button--danger.el-button--medium',
} as const;
