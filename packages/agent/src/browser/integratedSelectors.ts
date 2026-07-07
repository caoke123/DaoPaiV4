/**
 * 到派一体扫描页面 DOM 选择器（Agent 侧副本）
 *
 * 来源：backend/operations/selectors/integratedScan.selectors.ts
 * 采集：真实凤凰系统 DOM（2026-06-20 / 2026-06-21 弹窗结构补采）+ 语义化改造
 *
 * Phase 5-F：禁止猜测选择器，本文件所有常量均从旧执行流程代码原样复制。
 *
 * 页面区域：arrivalscan_left / arrivalscan_right（与到件扫描批量同区域）
 * 旧流程操作顺序（来源：backend/operations/IntegratedScan.ts:157-223 processOneBatch）：
 *   1. 导航到到件扫描页面（route: /scanning/arrivalscan）
 *   2. 选"上一站"= 天津分拨中心（prevStationInput + prevStationOption）
 *   3. 勾选"到派一体"复选框（integratedCheckbox）
 *   4. 选派件员（触发弹窗：courierSelectInput + courierDialog* + courierUseButton）
 *   5. 逐个输入单号 + 点击"添加"（waybillInput + addButton）
 *   6. 设 200 条/页（pageSizeInput + pageSizeOption200）
 *   7. 全选（selectAllCheckbox）
 *   8. [DRY-RUN 跳过] 上传（uploadButton）—— 真实提交按钮
 *
 * dryRun 阻断点：IntegratedScan.ts:714 uploadAndJudge 函数 `if (dryRunMode) { return ... }`
 */

/** 到派一体页面 URL 路径（来源：PageStateManager.ts:21 integrated） */
export const INTEGRATED_PAGE_ROUTE = '/scanning/arrivalscan';

/** 默认"上一站"网点名称（来源：integratedScan.selectors.ts:23） */
export const DEFAULT_PREV_STATION = '天津分拨中心';

/**
 * 到派一体扫描流程涉及的全部 DOM 选择器
 *
 * 来源：backend/operations/selectors/integratedScan.selectors.ts:25-102
 *
 * ⚠️ Phase 5-F-0 DOM 审计结论（2026-06-30，commit ad89249）：
 *   - 旧 `prevStationInput: '.arrivalscan_left .el-input--suffix input'` 选择器在 DOM 中
 *     会按文档顺序匹配多个 input，.first() 命中的是「班次」(Row 2) 而非「上一站」(Row 7)，
 *     导致任务卡住。
 *   - 班次字段：Row 2（.arrivalscan_left > div > div:nth-child(2) input）
 *   - 上一站字段：Row 7（.arrivalscan_left > div > div:nth-child(7) input）
 *   - 修复策略：弃用 `.first()`，改用 label 文本"上一站"向上查找祖先容器定位 input。
 *     详见 IntegratedBrowserDryRun.ts: findPrevStationInputByLabel / assertNotShiftField。
 */
export const INTEGRATED_SCAN_SELECTORS = {
  /**
   * 3a. "上一站"下拉框 input（仅作历史参考，禁止直接配合 .first() 使用）
   *
   * ⚠️ @deprecated 此选择器会同时匹配「班次」「快件类型」「物品类型」「上一站」「目的地」
   *    等多个 el-select input，.first() 命中的是 Row 2「班次」，不是 Row 7「上一站」。
   *    新代码必须使用 findPrevStationInputByLabel（基于 label 文本"上一站"向上查找）。
   *
   * 来源：integratedScan.selectors.ts:27
   * 旧代码使用位置：IntegratedScan.ts:241, 261, 266
   */
  prevStationInput: '.arrivalscan_left .el-input--suffix input',

  /**
   * 3a-2. "上一站"下拉框 input（Phase 5-F-0 审计后推荐 selector）
   *
   * 来源：Phase 5-F-0 DOM 审计报告（commit ad89249）
   * 审计验证：.arrivalscan_left > div > div:nth-child(7) 是 label="上一站" 的行
   *
   * ⚠️ 此 nth-child 已由审计脚本 auditIntegratedDom.ts 打印确认对应 label="上一站"。
   *    若页面 DOM 结构变化，需重新跑审计脚本验证。
   *    主流程仍优先使用 findPrevStationInputByLabel（label 文本定位），
   *    本 selector 仅作为兜底。
   */
  prevStationInputByRow: '.arrivalscan_left > div > div:nth-child(7) input',

  /**
   * 3a-3. "班次"下拉框 input（Phase 5-F-0 审计新增，用于 assertNotShiftField 保护）
   *
   * 来源：Phase 5-F-0 DOM 审计报告（commit ad89249）
   * 审计验证：.arrivalscan_left > div > div:nth-child(2) 是 label="班次" 的行
   *
   * 用于在选上一站时校验：若候选 input 落在班次行，直接 throw 阻止误操作。
   */
  shiftFieldInput: '.arrivalscan_left > div > div:nth-child(2) input',

  /** 3b. "上一站"下拉选项（文本匹配"天津分拨中心"）
   *  来源：integratedScan.selectors.ts:30
   *  旧代码使用位置：IntegratedScan.ts:246-254（page.evaluate 遍历 li.el-select-dropdown__item）
   */
  prevStationOption: 'li.el-select-dropdown__item:has-text("天津分拨中心")',

  /** 5. "到派一体"复选框 — 语义化：文本匹配"到派一体"的 checkbox
   *  来源：integratedScan.selectors.ts:33
   *  旧代码使用位置：IntegratedScan.ts:305
   */
  integratedCheckbox: '.el-checkbox:has-text("到派一体") .el-checkbox__inner',

  /** 6. 派件员 input —— 点击后触发"选择派件员"弹窗（非 el-select 下拉）
   *  来源：integratedScan.selectors.ts:44
   *  旧代码使用位置：IntegratedScan.ts:354, 362
   *  ⚠️ 必须用 Playwright 真实 .click() 点击，不能用 page.evaluate
   */
  courierSelectInput: '.arrivalscan_left > div > div:nth-child(12) input',

  /** 7a. "选择派件员"弹窗容器（el-dialog__wrapper）
   *  来源：integratedScan.selectors.ts:56
   *  旧代码使用位置：IntegratedScan.ts:370, 434
   */
  courierDialogWrapper: 'div.el-dialog__wrapper:has-text("选择派件员")',

  /** 7b. 弹窗内 el-table 表体行（用于遍历匹配员工编号）
   *  来源：integratedScan.selectors.ts:59
   *  旧代码使用位置：IntegratedScan.ts:384
   */
  courierDialogTableRow: '.el-dialog__wrapper .el-table__body-wrapper tbody tr.el-table__row',

  /** 7c. 员工编号列（el-table_2_column_16）
   *  来源：integratedScan.selectors.ts:65
   *  旧代码使用位置：IntegratedScan.ts:398
   */
  courierDialogEmployeeIdCell: '.el-dialog__wrapper td.el-table_2_column_16',

  /** 7d. "使用"按钮（位于 .el-table__fixed-right 固定列内）
   *  来源：integratedScan.selectors.ts:74
   *  旧代码使用位置：IntegratedScan.ts:418
   *  ⚠️ 必须用 Playwright 真实 .click() 点击
   */
  courierUseButton: '.el-dialog__wrapper .el-table__fixed-right tbody tr button.el-button--primary.el-button--mini',

  /** 8. 单号输入框（用户提供 ID）
   *  来源：integratedScan.selectors.ts:77
   *  旧代码使用位置：IntegratedScan.ts:519, 522
   */
  waybillInput: '#waybillNum',

  /** 9. "添加"按钮（primary 样式）
   *  来源：integratedScan.selectors.ts:80
   *  旧代码使用位置：IntegratedScan.ts:529
   *  注意：此按钮将运单加入表格，不是真实提交；Agent DRY-RUN 仅检测不点击
   */
  addButton: '.arrivalscan_left button.el-button--primary',

  /** 11. 条数/页下拉框 input
   *  来源：integratedScan.selectors.ts:83
   *  旧代码使用位置：IntegratedScan.ts:591
   */
  pageSizeInput: '.arrivalscan_right .el-pagination__sizes input',

  /** 12. "200条/页"选项
   *  来源：integratedScan.selectors.ts:86
   *  旧代码使用位置：IntegratedScan.ts:594
   */
  pageSizeOption200: 'li.el-select-dropdown__item:has-text("200条/页")',

  /** 13. 表头全选 checkbox
   *  来源：integratedScan.selectors.ts:89
   *  旧代码使用位置：IntegratedScan.ts:629, 638
   */
  selectAllCheckbox: 'th.el-table-column--selection .el-checkbox__inner',

  /** 14. ⚠️"上传"按钮（真实提交按钮，success 样式）
   *  来源：integratedScan.selectors.ts:92
   *  旧代码使用位置：IntegratedScan.ts:739
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  uploadButton: '.arrivalscan_right button.el-button--success',

  /** 15. 上传确认弹窗容器
   *  来源：integratedScan.selectors.ts:98
   *  旧代码使用位置：IntegratedScan.ts:669
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  confirmDialogWrapper: '.el-message-box__wrapper',

  /** 16. 确认弹窗"确定"按钮
   *  来源：integratedScan.selectors.ts:101
   *  旧代码使用位置：IntegratedScan.ts:678
   *  Agent DRY-RUN：仅检测，绝不点击
   */
  confirmButton: '.el-message-box__wrapper .el-message-box__btns button.el-button--primary',
} as const;

/** 到派一体表格行选择器
 *  来源：integratedScan.selectors.ts:105-106
 *  旧代码使用位置：IntegratedScan.ts:576
 */
export const INTEGRATED_TABLE_ROW_SELECTOR =
  'div.arrivalscan_right div.el-table__body-wrapper table tbody tr.el-table__row';
