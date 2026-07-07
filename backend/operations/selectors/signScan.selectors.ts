/**
 * 签收录入页面 DOM 选择器配置
 *
 * 来源：SIGN_VERIFICATION_REPORT.md（2026-06-21 Chrome DevTools MCP 实际验证）
 * 用途：SignScan 操作模块引用，避免选择器散落在业务代码中
 *
 * 操作顺序（prepareSign 阶段）：
 * 1. 点击日期范围选择器（dateRangeInput）→ 弹出日期面板
 * 2. 在日期面板填入开始日期（datePickerStartInput）和结束日期（datePickerEndInput）
 * 3. 点击日期面板"确定"按钮（datePickerConfirm）→ 日期设置为当天 00:00:00 - 23:59:59
 * 4. 点击派件员下拉框（courierSelectInput）→ 文本匹配选择员工（courierOption）
 * 5. 点击"搜索"按钮（searchButton）→ 等待结果返回
 * 6. 点击分页大小下拉框（pageSizeInput）→ 选择 200条/页（pageSizeOption200）
 * 7. 点击表头全选框（selectAllCheckbox）→ 勾选所有记录
 * 8. 点击"批量签收"按钮（batchSignButton）→ 弹出签收确认对话框
 * 9. 点击签收人下拉框（signerSelectInput）→ 选择"本人"（signerOptionSelf）
 * 10. ⚠️点击"确定"按钮（signConfirmButton）—— 真实提交按钮，受 SIGN_DRY_RUN 保护
 */

/**
 * 签收扫描流程涉及的全部 DOM 选择器
 *
 * 关键修正点（基于真实验证）：
 * - 日期面板的开始/结束日期输入框用 .is-left / .is-right 区分
 * - 派件员/签收人下拉选项用文本匹配 + :visible（当前可见浮层）
 * - 全选 checkbox 优先用 input[type="checkbox"]，必要时用 JS click
 * - 签收确认对话框内的"确定"按钮用 .el-button--primary（非 default）
 */
export const SIGN_SCAN_SELECTORS = {
  // ── 搜索区域 ──

  /** 1a. 日期范围选择器 input（点击展开日期面板） */
  dateRangeInput: '.search-wrap .inputs .el-date-editor input',

  /**
   * 2a. 日期面板的开始日期输入框（左侧）
   * Element UI datetimerange 面板：.is-left 含日期+时间两个 input，取第一个（日期）
   */
  datePickerStartInput: '.el-date-range-picker__time-header .is-left input',

  /**
   * 2b. 日期面板的结束日期输入框（右侧）
   * Element UI datetimerange 面板：.is-right 含日期+时间两个 input，取第一个（日期）
   */
  datePickerEndInput: '.el-date-range-picker__time-header .is-right input',

  /**
   * 3. 日期面板"确定"按钮
   * 优先用 primary 样式，fallback 用文本匹配
   */
  datePickerConfirm: '.el-picker-panel__footer .el-button--primary',

  /** 4a. 派件员下拉框 input（点击展开） */
  courierSelectInput: '.search-wrap .inputs .el-select input',

  /**
   * 4b. 派件员下拉选项（文本匹配 staffName）
   * 使用 :visible 过滤当前可见浮层
   * ${staffName} 为运行时替换占位符
   */
  courierOption:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("${staffName}")',

  /** 5. "搜索"按钮（primary 样式） */
  searchButton: '.search-wrap .item-actions .el-button--primary',

  /** 6a. 分页大小下拉框 input（点击展开） */
  pageSizeInput: '.el-pagination .el-pagination__sizes .el-input input',

  /**
   * 6b. 分页选项模板
   * 使用 :visible 过滤当前可见浮层，${pageSizeText} 为运行时替换占位符（如"100条/页"）
   * 支持选项：10条/页、30条/页、50条/页、100条/页、200条/页
   */
  pageSizeOptionTemplate:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("${pageSizeText}")',

  /** 默认分页大小选项"100条/页" */
  pageSizeOption100:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("100条/页")',

  /**
   * 7. 表头全选 checkbox
   * 优先用 input[type="checkbox"]（真实验证发现直接 click 表头可能失败，需用 JS click input）
   */
  selectAllCheckbox: '.el-table__header-wrapper input[type="checkbox"]',

  /** 8. "批量签收"按钮（danger 样式） */
  batchSignButton: '.search-wrap .item-actions .el-button--danger',

  // ── 签收确认对话框 ──

  /** 9a. 签收人下拉框 input（点击展开） */
  signerSelectInput: '.el-dialog__wrapper .el-dialog .el-input input',

  /**
   * 9b. 签收人选项（通用，文本匹配）
   * 使用 :visible 过滤当前可见浮层，${signerName} 为运行时替换占位符
   */
  signerOption:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("${signerName}")',

  /** 10. ⚠️"确定"按钮（真实提交按钮，primary 样式）—— 受 SIGN_DRY_RUN 保护 */
  signConfirmButton: '.el-dialog__wrapper .el-dialog .el-button--primary',
} as const;

/**
 * 签收表格行选择器（用于统计记录数）
 */
export const SIGN_TABLE_ROW_SELECTOR =
  '.el-table__body-wrapper table tbody tr.el-table__row';
