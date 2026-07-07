/**
 * 签收录入页面 DOM 选择器（Agent 侧副本）
 *
 * 来源：backend/operations/selectors/signSelectors.ts（标准化版本，SignExecutor 使用）
 *       backend/operations/selectors/signScan.selectors.ts（历史版本，已被标准化版本取代）
 * 采集：SIGN_VERIFICATION_REPORT.md（2026-06-21 Chrome DevTools MCP 实际验证）
 *
 * Phase 5-F：禁止猜测选择器，本文件所有常量均从旧执行流程代码原样复制。
 *
 * 旧流程操作顺序（来源：backend/operations/SignScan.ts:108-121 + core/signExecutor）：
 *   1. 设置日期范围为今天（dateRangeInput + datePickerStartInput/EndInput + datePickerConfirm）
 *   2. 选择派件员（courierSelectInput + courierOptionTpl）
 *   3. 点击"搜索"按钮（searchButton）—— 允许点击的预处理类按钮
 *   4. 设分页大小（pageSizeInput + pageSizeOptionTpl）
 *   5. 全选（selectAllCheckbox）
 *   6. [DRY-RUN 跳过] 批量签收（batchSignButton）—— 真实提交按钮
 *
 * dryRun 阻断点：SignExecutor 内部（isDryRun=true 时跳过 signConfirmButton 点击）
 */

/** 签收录入页面 URL 路径（来源：PageStateManager.ts:20 sign） */
export const SIGN_PAGE_ROUTE = '/scanning/signFor/signForInput';

/** 默认分页大小（来源：signSelectors.ts:109） */
export const DEFAULT_PAGE_SIZE = 100;

/** 默认签收人（来源：signSelectors.ts:115） */
export const DEFAULT_SIGNER = '本人';

/**
 * 签收录入流程涉及的全部 DOM 选择器
 *
 * 来源：backend/operations/selectors/signSelectors.ts:13-103
 */
export const SIGN_SELECTORS = {
  // ── 1. 搜索区域 ──

  /** 1a. 日期范围选择器 input（点击展开日期面板）
   *  来源：signSelectors.ts:17
   *  旧代码使用位置：SignExecutor.setDateRangeToday
   */
  dateRangeInput: '.search-wrap .inputs .el-date-editor input',

  /** 1b. 日期面板开始日期输入框（左侧，placeholder 匹配）
   *  来源：signSelectors.ts:20
   */
  datePickerStartInput: '.el-date-range-picker__time-header input[placeholder="开始日期"]',

  /** 1c. 日期面板结束日期输入框（右侧）
   *  来源：signSelectors.ts:23
   */
  datePickerEndInput: '.el-date-range-picker__time-header input[placeholder="结束日期"]',

  /** 1d. 日期面板"确定"按钮（实测 .el-button--default，非 --primary）
   *  来源：signSelectors.ts:26
   */
  datePickerConfirm: '.el-picker-panel__footer .el-button--default',

  /** 2a. 派件员下拉框 input
   *  来源：signSelectors.ts:29
   *  旧代码使用位置：SignExecutor.selectCourier
   */
  courierSelectInput: '.search-wrap .inputs .el-select input',

  /** 2b. 派件员下拉选项模板（${staffName} 运行时替换）
   *  来源：signSelectors.ts:32-33
   */
  courierOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${staffName}")',

  /** 3. 搜索按钮（primary 样式）—— 允许点击的预处理类按钮
   *  来源：signSelectors.ts:36
   *  旧代码使用位置：SignExecutor.selectCourier 后调用
   */
  searchButton: '.search-wrap .item-actions .el-button--primary',

  // ── 2. 分页组件 ──

  /** 4a. 分页大小下拉框 input
   *  来源：signSelectors.ts:41
   */
  pageSizeInput: '.el-pagination .el-pagination__sizes .el-input input',

  /** 4b. 分页大小选项模板（${pageSizeText} 运行时替换）
   *  来源：signSelectors.ts:44-45
   */
  pageSizeOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${pageSizeText}")',

  /** 当前激活页码按钮
   *  来源：signSelectors.ts:48
   */
  currentPage: '.el-pagination .el-pager li.is-active.number',

  /** 分页总数文本（如"共 123 条"）
   *  来源：signSelectors.ts:51
   */
  totalCount: '.el-pagination .el-pagination__total',

  // ── 3. 订单列表 ──

  /** 表格行
   *  来源：signSelectors.ts:65
   */
  orderRow: '.el-table__body-wrapper table tbody tr.el-table__row',

  /** 行内 checkbox（每行第一个）
   *  来源：signSelectors.ts:68
   */
  rowCheckbox: '.el-table__body-wrapper table tbody tr.el-table__row td:first-child input[type="checkbox"]',

  /** 表头全选 checkbox
   *  来源：signSelectors.ts:71
   */
  selectAllCheckbox: '.el-table__header-wrapper input[type="checkbox"]',

  /** 订单号单元格（第二列）
   *  来源：signSelectors.ts:74
   */
  orderNumberCell: '.el-table__body-wrapper table tbody tr.el-table__row td:nth-child(2)',

  // ── 4. 批量操作 ──

  /** 6. ⚠️"批量签收"按钮（danger 样式）—— 真实提交按钮
   *  来源：signSelectors.ts:79
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  batchSignButton: '.search-wrap .item-actions .el-button--danger',

  // ── 5. 签收弹窗 ──

  /** 弹窗容器
   *  来源：signSelectors.ts:84
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  signDialog: '.el-dialog__wrapper .el-dialog:visible',

  /** 签收人下拉框 input
   *  来源：signSelectors.ts:87
   */
  signerSelectInput: '.el-dialog__wrapper .el-dialog .el-input input',

  /** 签收人选项模板（${signerName} 运行时替换）
   *  来源：signSelectors.ts:90-91
   */
  signerOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${signerName}")',

  /** ⚠️弹窗确认按钮（确定）—— 真实提交按钮
   *  来源：signSelectors.ts:94
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  dialogConfirmBtn: '.el-dialog__wrapper .el-dialog .el-button--primary',

  /** 弹窗取消按钮
   *  来源：signSelectors.ts:97
   */
  dialogCancelBtn: '.el-dialog__wrapper .el-dialog .el-button--default:not(.el-button--primary)',

  // ── 6. Loading ──

  /** Element UI loading 遮罩
   *  来源：signSelectors.ts:102
   */
  loadingMask: '.el-loading-mask',
} as const;
