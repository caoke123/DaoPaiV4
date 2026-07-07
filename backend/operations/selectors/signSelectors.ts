/**
 * 签收录入页面 DOM 选择器（标准化版本）
 *
 * 结构分类：
 *   1. 搜索区域（日期、派件员、搜索按钮）
 *   2. 分页组件（pageSize、页码、总数、上下页）
 *   3. 订单列表（行、checkbox、全选、订单号）
 *   4. 批量操作（批量签收按钮）
 *   5. 签收弹窗（签收人选择、确认/取消）
 *   6. Loading 遮罩
 */

export const SIGN_SELECTORS = {
  // ── 1. 搜索区域 ──

  /** 日期范围选择器 input（点击展开日期面板） */
  dateRangeInput: '.search-wrap .inputs .el-date-editor input',

  /** 日期面板开始日期输入框（左侧，无 is-left 类，用 placeholder 匹配） */
  datePickerStartInput: '.el-date-range-picker__time-header input[placeholder="开始日期"]',

  /** 日期面板结束日期输入框（右侧） */
  datePickerEndInput: '.el-date-range-picker__time-header input[placeholder="结束日期"]',

  /** 日期面板"确定"按钮（实测 .el-button--default，非 --primary） */
  datePickerConfirm: '.el-picker-panel__footer .el-button--default',

  /** 派件员下拉框 input */
  courierSelectInput: '.search-wrap .inputs .el-select input',

  /** 派件员下拉选项模板（${staffName} 运行时替换） */
  courierOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${staffName}")',

  /** 搜索按钮 */
  searchButton: '.search-wrap .item-actions .el-button--primary',

  // ── 2. 分页组件 ──

  /** 分页大小下拉框 input */
  pageSizeInput: '.el-pagination .el-pagination__sizes .el-input input',

  /** 分页大小选项模板（${pageSizeText} 运行时替换，如"50条/页"） */
  pageSizeOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${pageSizeText}")',

  /** 当前激活页码按钮 */
  currentPage: '.el-pagination .el-pager li.is-active.number',

  /** 分页总数文本（如"共 123 条"） */
  totalCount: '.el-pagination .el-pagination__total',

  /** 下一页按钮 */
  nextPageBtn: '.el-pagination .btn-next',

  /** 上一页按钮 */
  prevPageBtn: '.el-pagination .btn-prev',

  /** 页码跳转输入框 */
  jumpPageInput: '.el-pagination .el-pagination__jump .el-input__inner',

  // ── 3. 订单列表 ──

  /** 表格行 */
  orderRow: '.el-table__body-wrapper table tbody tr.el-table__row',

  /** 行内 checkbox（每行第一个） */
  rowCheckbox: '.el-table__body-wrapper table tbody tr.el-table__row td:first-child input[type="checkbox"]',

  /** 表头全选 checkbox */
  selectAllCheckbox: '.el-table__header-wrapper input[type="checkbox"]',

  /** 订单号单元格（第二列） */
  orderNumberCell: '.el-table__body-wrapper table tbody tr.el-table__row td:nth-child(2)',

  // ── 4. 批量操作 ──

  /** 批量签收按钮 */
  batchSignButton: '.search-wrap .item-actions .el-button--danger',

  // ── 5. 签收弹窗 ──

  /** 弹窗容器 */
  signDialog: '.el-dialog__wrapper .el-dialog:visible',

  /** 签收人下拉框 input */
  signerSelectInput: '.el-dialog__wrapper .el-dialog .el-input input',

  /** 签收人选项模板（${signerName} 运行时替换） */
  signerOptionTpl:
    'div.el-select-dropdown.el-popper li.el-select-dropdown__item:has-text("${signerName}")',

  /** 弹窗确认按钮（确定） */
  dialogConfirmBtn: '.el-dialog__wrapper .el-dialog .el-button--primary',

  /** 弹窗取消按钮 */
  dialogCancelBtn: '.el-dialog__wrapper .el-dialog .el-button--default:not(.el-button--primary)',

  // ── 6. Loading ──

  /** Element UI loading 遮罩 */
  loadingMask: '.el-loading-mask',
} as const;

/** 支持的分页大小选项（UI 配置档位） */
export type PageSizeOption = 30 | 50 | 100 | 200;

/** 默认分页大小（Phase 4: 默认 100 条/页） */
export const DEFAULT_PAGE_SIZE: PageSizeOption = 100;

/** 分页大小选项常量（供 UI 使用） */
export const PAGE_SIZE_OPTIONS: PageSizeOption[] = [30, 50, 100, 200];

/** 默认签收人 */
export const DEFAULT_SIGNER = '本人';

/** 项目支持的签收人选项 */
export const SUPPORTED_SIGNERS = [
  '本人',
  '家人',
  '家门口',
  '前台',
  '代收点',
] as const;

export type SupportedSigner = typeof SUPPORTED_SIGNERS[number];
