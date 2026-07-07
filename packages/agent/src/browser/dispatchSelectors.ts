/**
 * 派件扫描页面 DOM 选择器（Agent 侧副本）
 *
 * 来源：backend/operations/selectors/dispatchScan.selectors.ts
 * 采集：真实凤凰系统 DOM（2026-06-20）
 *
 * Phase 5-F：禁止猜测选择器，本文件所有常量均从旧执行流程代码原样复制。
 *
 * 旧流程操作顺序（来源：backend/operations/DispatchScan.ts:165-184 processOneBatch）：
 *   1. 选派件员（courierSelectInput → courierOption）
 *   2. 逐个输入运单 + 点击"添加"（waybillInput + addButton）
 *   3. 设 200 条/页（pageSizeInput + pageSizeOption200）
 *   4. 全选（selectAllCheckbox）
 *   5. [DRY-RUN 跳过] 上传（uploadButton）—— 真实提交按钮
 *
 * dryRun 阻断点：DispatchScan.ts:419 uploadAndJudge 函数 `if (dryRunMode) { return ... }`
 */

/** 派件扫描页面 URL 路径（来源：PageStateManager.ts:19） */
export const DISPATCH_PAGE_ROUTE = '/scanning/dispatchscan';

/**
 * 派件扫描流程涉及的全部 DOM 选择器
 *
 * 来源：backend/operations/selectors/dispatchScan.selectors.ts:25-66
 */
export const DISPATCH_SCAN_SELECTORS = {
  /** 1a. 派件员下拉框 input（点击展开）
   *  来源：dispatchScan.selectors.ts:27-28
   *  旧代码使用位置：DispatchScan.ts:199
   */
  courierSelectInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(1) > div > div.el-input.el-input--medium.el-input--suffix > input',

  /** 1b. 派件员下拉选项（文本匹配 staffName，:visible 过滤当前可见浮层）
   *  来源：dispatchScan.selectors.ts:35-36
   *  旧代码使用位置：DispatchScan.ts:203-204
   *  ${staffName} 为运行时替换占位符
   */
  courierOption:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("${staffName}")',

  /** 2. 运单号输入框
   *  来源：dispatchScan.selectors.ts:39-40
   *  旧代码使用位置：DispatchScan.ts:267, 270
   */
  waybillInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_left > div > div:nth-child(5) > div > input',

  /** 3. "添加"按钮（primary 样式）—— 语义化选择器
   *  来源：dispatchScan.selectors.ts:43
   *  旧代码使用位置：DispatchScan.ts:277
   *  注意：此按钮将运单加入表格，不是真实提交；Agent DRY-RUN 仅检测不点击
   */
  addButton: '.dispatchscan_left button.el-button--primary',

  /** 4a. 分页大小下拉框 input（点击展开）
   *  来源：dispatchScan.selectors.ts:46-47
   *  旧代码使用位置：DispatchScan.ts:339
   */
  pageSizeInput:
    '#app > div.app-wrapper.openSidebar > div.main-container.hasTagsView > section > div > div.dispatchscan_right > div > div.el-pagination.is-background > span.el-pagination__sizes > div > div > input',

  /** 4b. 分页选项"200条/页"（:visible 过滤）
   *  来源：dispatchScan.selectors.ts:53-54
   *  旧代码使用位置：DispatchScan.ts:342
   */
  pageSizeOption200:
    'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("200条/页")',

  /** 5. 表头全选 checkbox（语义化选择器）
   *  来源：dispatchScan.selectors.ts:62
   *  旧代码使用位置：DispatchScan.ts:377, 386
   */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 6. ⚠️"上传"按钮（真实提交按钮，success 样式）
   *  来源：dispatchScan.selectors.ts:65
   *  旧代码使用位置：DispatchScan.ts:444
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  uploadButton: '.dispatchscan_right button.el-button--success',
} as const;

/** 派件表格行选择器
 *  来源：dispatchScan.selectors.ts:72-73
 *  旧代码使用位置：DispatchScan.ts:324
 */
export const DISPATCH_TABLE_ROW_SELECTOR =
  'div.dispatchscan_right div.el-table__body-wrapper table tbody tr.el-table__row';
