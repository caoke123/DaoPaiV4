/**
 * 派件扫描页面 DOM 选择器配置
 *
 * 来源：真实凤凰系统 DOM 采集（2026-06-20）
 * 用途：DispatchScan 操作模块引用，避免选择器散落在业务代码中
 *
 * 关键修正点（相对原始采集数据）：
 * - 派件员/分页下拉选项用文本匹配 + :visible（当前可见浮层），不用 .hover class
 * - 分页浮层不用 nth-child(14) 固定位置，改用 :visible 过滤
 * - selectAllCheckbox 优先用语义化选择器（th.el-table-column--selection），
 *   不依赖动态 column ID（el-table_1_column_1）
 */

/**
 * 派件扫描流程涉及的全部 DOM 选择器
 *
 * 操作顺序：
 * 1. 点击派件员下拉框（courierSelectInput）→ 文本匹配选择员工（courierOption）
 * 2. 在运单号输入框填入单号（waybillInput）
 * 3. 点击"添加"按钮（addButton）→ 逐条添加构建表格
 * 4. 点击分页大小下拉框（pageSizeInput）→ 选择 200条/页（pageSizeOption200）
 * 5. 点击表头全选框（selectAllCheckbox）
 * 6. ⚠️点击"上传"按钮（uploadButton）—— 真实提交按钮，受 DISPATCH_SCAN_DRY_RUN 保护
 */
export const DISPATCH_SCAN_SELECTORS = {
  /** 1a. 派件员下拉框 input（点击展开） */
  courierSelectInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(1) > div > div.el-input.el-input--medium.el-input--suffix > input',

  /**
   * 1b. 派件员下拉选项（文本匹配 staffName）
   * 使用 :visible 过滤当前可见浮层，不用 .hover class
   * ${staffName} 为运行时替换占位符
   */
  courierOption:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("${staffName}")',

  /** 2. 运单号输入框 */
  waybillInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(5) > div > input',

  /** 3. "添加"按钮（primary 样式）—— 语义化选择器，不依赖 nth-child 固定位置 */
  addButton: '.dispatchscan_left button.el-button--primary',

  /** 4a. 分页大小下拉框 input（点击展开） */
  pageSizeInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_right > div > div.el-pagination.is-background > span.el-pagination__sizes > div > div > input',

  /**
   * 4b. 分页选项"200条/页"
   * 使用 :visible 过滤当前可见浮层，文本匹配"200条/页"，不用 nth-child(14)
   */
  pageSizeOption200:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("200条/页")',

  /**
   * 5. 表头全选 checkbox
   * 优先用语义化选择器（不依赖动态 column ID el-table_1_column_1）
   * 原始绝对路径作为参考保留在注释中：
   *   #app > ... > th.el-table_1_column_1.el-table-column--selection.is-leaf.el-table__cell > div > label > span > span
   */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 6. ⚠️"上传"按钮（真实提交按钮，success 样式）—— 语义化选择器，受 DISPATCH_SCAN_DRY_RUN 保护 */
  uploadButton: '.dispatchscan_right button.el-button--success',
} as const;

/**
 * 派件表格行选择器（用于 countTableRows 检测添加成功/失败）
 * 派件表格位于 dispatchscan_right 区域
 */
export const DISPATCH_TABLE_ROW_SELECTOR =
  'div.dispatchscan_right div.el-table__body-wrapper table tbody tr.el-table__row';
