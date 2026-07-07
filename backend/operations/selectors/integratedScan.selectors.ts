/**
 * 到派一体扫描页面 DOM 选择器配置
 *
 * 来源：真实凤凰系统 DOM 采集（2026-06-20 / 2026-06-21 弹窗结构补采）+ 语义化改造
 * 用途：IntegratedScan 操作模块引用，避免选择器散落在业务代码中
 *
 * 页面区域：arrivalscan_left / arrivalscan_right（与到件扫描批量同区域）
 * 操作流程（14步）：
 * 1-2. 导航到到件扫描页面（由 NavigationGovernance 处理）
 * 3-4. 选"上一站"= 天津分拨中心（prevStationInput + prevStationOption）
 * 5. 勾选"到派一体"复选框（integratedCheckbox）
 * 6-7. 选派件员 —— 触发"选择派件员"弹窗（非 el-select 下拉）
 *      6. courierSelectInput：点击派件员 input 触发弹窗（Playwright 真实 .click()）
 *      7. 弹窗内按员工编号精确匹配表格行，点击"使用"按钮
 *         （courierDialog* 系列选择器 + courierUseButton）
 * 8-10. 逐个输入单号 + 点击添加（waybillInput + addButton）
 * 11-12. 设 200 条/页（pageSizeInput + pageSizeOption200）
 * 13. 全选（selectAllCheckbox）
 * 14. 上传（uploadButton，受 INTEGRATED_SCAN_DRY_RUN 保护）
 */

/** 默认"上一站"网点名称 */
export const DEFAULT_PREV_STATION = '天津分拨中心';

export const INTEGRATED_SCAN_SELECTORS = {
  /** 3a. "上一站"下拉框 input — 语义化：arrivalscan_left 区域内带 --suffix 的 el-select input */
  prevStationInput: '.arrivalscan_left .el-input--suffix input',

  /** 3b. "上一站"下拉选项（文本匹配"天津分拨中心"，不用 :visible 因 Element UI 浮层可能不兼容） */
  prevStationOption: 'li.el-select-dropdown__item:has-text("天津分拨中心")',

  /** 5. "到派一体"复选框 — 语义化：文本匹配"到派一体"的 checkbox */
  integratedCheckbox: '.el-checkbox:has-text("到派一体") .el-checkbox__inner',

  /**
   * 6. 派件员 input —— 点击后触发"选择派件员"弹窗（非 el-select 下拉）
   *
   * 真实 DOM 位置：.arrivalscan_left > div > div:nth-child(12) input
   * 该 input 的 placeholder="请选择"、value=""、非只读
   *
   * ⚠️ 必须用 Playwright 真实 .click() 点击（page.click / locator.click），
   *    不能用 page.evaluate(el => el.click()) —— 后者不触发 Vue 监听器，弹窗不会弹出
   */
  courierSelectInput: '.arrivalscan_left > div > div:nth-child(12) input',

  /**
   * @deprecated 旧"派件员下拉选项"选择器 —— 派件员字段实际触发弹窗而非 el-select 下拉，
   *             此选择器已不再使用，保留仅作历史参考。新流程使用 courierDialog* 系列选择器
   */
  courierOption: 'li.el-select-dropdown__item:has-text("${staffName}")',

  /**
   * 7a. "选择派件员"弹窗容器 —— Element UI el-dialog__wrapper
   * 弹窗标题文本包含"选择派件员"，用于弹窗出现/关闭判定
   */
  courierDialogWrapper: 'div.el-dialog__wrapper:has-text("选择派件员")',

  /** 7b. 弹窗内 el-table 表体行（主表）—— 用于遍历匹配员工编号 */
  courierDialogTableRow: '.el-dialog__wrapper .el-table__body-wrapper tbody tr.el-table__row',

  /**
   * 7c. 员工编号列 —— el-table_2_column_16（弹窗 el-table id=el-table_2 的第 16 列）
   * 用于在表格行中精确匹配传入的 employeeId（字符串严格相等，不用 includes）
   */
  courierDialogEmployeeIdCell: '.el-dialog__wrapper td.el-table_2_column_16',

  /**
   * 7d. "使用"按钮 —— 位于 .el-table__fixed-right 固定列内
   * Element UI 固定列机制：操作列在主表中 is-hidden，在 .el-table__fixed-right 中可见
   *
   * ⚠️ 必须用 Playwright 真实 .click() 点击，不能用 page.evaluate 原生 click
   *    （避免不触发 Vue 监听器导致选择不生效）
   */
  courierUseButton: '.el-dialog__wrapper .el-table__fixed-right tbody tr button.el-button--primary.el-button--mini',

  /** 8. 单号输入框 — 用户提供的 ID 选择器，已足够稳健 */
  waybillInput: '#waybillNum',

  /** 9. "添加"按钮（primary 样式）— 语义化 */
  addButton: '.arrivalscan_left button.el-button--primary',

  /** 11. 条数/页下拉框 input */
  pageSizeInput: '.arrivalscan_right .el-pagination__sizes input',

  /** 12. "200条/页"选项（不用 :visible，文本匹配） */
  pageSizeOption200: 'li.el-select-dropdown__item:has-text("200条/页")',

  /** 13. 表头全选 checkbox（与到件/派件一致的语义化选择器） */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 14. ⚠️"上传"按钮（真实提交按钮，success 样式）— 受 INTEGRATED_SCAN_DRY_RUN 保护 */
  uploadButton: '.arrivalscan_right button.el-button--success',

  /**
   * 15. 上传确认弹窗容器 — Element UI el-message-box__wrapper
   * 点击"上传"后系统弹出确认弹窗（"是否确认提交?"），需点击"确定"才真正提交
   */
  confirmDialogWrapper: '.el-message-box__wrapper',

  /** 16. 确认弹窗"确定"按钮 — 限定在 el-message-box__wrapper 内，primary 样式 */
  confirmButton: '.el-message-box__wrapper .el-message-box__btns button.el-button--primary',
} as const;

/** 表格行选择器（用于行数检测，判断添加成功/失败） */
export const INTEGRATED_TABLE_ROW_SELECTOR =
  'div.arrivalscan_right div.el-table__body-wrapper table tbody tr.el-table__row';
