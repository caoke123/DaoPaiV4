/**
 * 派件扫描页面 DOM 选择器配置
 *
 * 来源：真实凤凰系统 DOM 采集（2026-06-20），Phase 5-G-8-1 更新语义化选择器
 * 用途：DispatchScan 操作模块引用，避免选择器散落在业务代码中
 *
 * Phase 5-G-8-1 修正：
 * - 派件员下拉框 input 使用语义化选择器（.dispatchscan_left），不用绝对 nth-child 路径
 * - 添加按钮、上传按钮用语义化选择器
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
  /** 1a. 派件员区域（包含 label "派件员" 的那一行的 el-select input） */
  courierSelectWrapper: '.dispatchscan_left .el-form-item:has(label:has-text("派件员"))',
  /** 1b. 派件员下拉框 input（语义化：在派件员区域内的 el-select input） */
  courierSelectInput: '.dispatchscan_left .el-form-item:has(label:has-text("派件员")) .el-select .el-input__inner',
  /** 1c. 派件员选项（文本匹配 courierName，可见浮层） */
  courierOptionTextOnly: 'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item',

  /** 2. 运单号输入框（语义化：单号/运单号 label 所在行的 input） */
  waybillInput: '.dispatchscan_left .el-form-item:has(label:has-text("运单"), label:has-text("单号")) input.el-input__inner, .dispatchscan_left input.el-input__inner[placeholder*="单号"], .dispatchscan_left input.el-input__inner[placeholder*="运单"]',

  /** 3. "添加"按钮（primary 样式）—— 语义化选择器 */
  addButton: '.dispatchscan_left button.el-button--primary',

  /** 4a. 分页大小下拉框 input */
  pageSizeInput: '.dispatchscan_right .el-pagination .el-pagination__sizes .el-select .el-input__inner',

  /** 4b. 分页选项"200条/页" */
  pageSizeOption200: 'div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item:has-text("200条/页")',

  /** 5. 表头全选 checkbox */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 6. ⚠️"上传"按钮（真实提交按钮，success 样式） */
  uploadButton: '.dispatchscan_right button.el-button--success',
} as const;

/**
 * 派件表格行选择器（用于 countTableRows 检测添加成功/失败）
 */
export const DISPATCH_TABLE_ROW_SELECTOR =
  'div.dispatchscan_right div.el-table__body-wrapper table tbody tr.el-table__row';
