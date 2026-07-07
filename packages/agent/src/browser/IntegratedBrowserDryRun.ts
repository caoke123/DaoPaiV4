/**
 * Phase I-4-1: 上一站轻量校验 — 只读 input.value，不读行级/大容器 textContent。
 * 不点击、不打开下拉、不扫描候选项。
 * 目标耗时 50-150ms。
 *
 * 规则：
 *   - value.length === 0  → EMPTY_INPUT_VALUE
 *   - value.length > 30   → INVALID_VALUE_TOO_LONG（防止误读大容器/下拉候选项全集）
 *   - 正常长度下 normalizedValue === target 或 includes(target)
 *   - 否则 → VALUE_NOT_MATCHED
 */
async function verifyPrevStationLight(
  page: Page,
  prevStation: string,
): Promise<{ matched: boolean; value: string; reason?: string }> {
  const normalize = (s: string) => s.replace(/\s+/g, '');
  try {
    const prevInputHandle = await findPrevStationInputByLabel(page);
    if (!prevInputHandle) {
      return { matched: false, value: '', reason: 'INPUT_NOT_FOUND' };
    }
    const inputValue = await prevInputHandle.inputValue().catch(() => '');
    if (inputValue.length === 0) {
      return { matched: false, value: '', reason: 'EMPTY_INPUT_VALUE' };
    }
    if (inputValue.length > 30) {
      return { matched: false, value: inputValue, reason: 'INVALID_VALUE_TOO_LONG' };
    }
    const normalizedValue = normalize(inputValue);
    const normalizedTarget = normalize(prevStation);
    if (normalizedValue === normalizedTarget || normalizedValue.includes(normalizedTarget)) {
      return { matched: true, value: inputValue, reason: undefined };
    }
    return { matched: false, value: inputValue, reason: 'VALUE_NOT_MATCHED' };
  } catch {
    return { matched: false, value: '', reason: 'EVALUATE_FAILED' };
  }
}

/**
 * Phase I-4-1: 日志截断 — 防止超长候选项文本污染 task_logs。
 * value.length <= 80 → 直接输出；> 80 → valueLen + preview 前 80 字。
 */
function formatPrevStationValue(value: string): string {
  if (value.length <= 80) return value;
  const preview = value.substring(0, 80);
  return `valueLen=${value.length} preview=${preview}...`;
}

/**
 * IntegratedBrowserDryRun — 到派一体扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行到派一体扫描页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/integratedScan.selectors.ts
 * 交互顺序来源：
 *   backend/operations/IntegratedScan.ts:157-223 processOneBatch
 *
 * 硬性边界：
 *   - 禁止点击"上传"按钮（最终提交）
 *   - 禁止点击"添加"按钮（spec 白名单只允许查询/搜索/检索）
 *   - 允许勾选"到派一体"复选框（选择必要业务字段）
 *   - 允许选"上一站"（选择必要业务字段）
 *   - 不产生真实业务，不处理真实生产单号
 */

import type { Page, ElementHandle, Locator } from 'playwright-core';
import { detectIntegratedPage, type IntegratedPageDetectResult } from './IntegratedPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableClick } from './StablePageActions';
import {
  INTEGRATED_SCAN_SELECTORS,
  DEFAULT_PREV_STATION,
  INTEGRATED_TABLE_ROW_SELECTOR,
} from './integratedSelectors';
import {
  navigateToBusinessPageMenuFirst,
  afterPageChangedCleanup,
  type AgentRuntimeLogFn,
  type AgentRuntimeMeta,
} from './AgentBusinessRuntime';

export interface IntegratedBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    prevStation?: string;
    /** 派件员姓名（用于回填校验） */
    courierName?: string;
    /** 派件员员工编号（用于弹窗表格精确匹配） */
    courierEmployeeId?: string;
  };
  /** Phase K-2E: Agent 运行时日志函数（可选） */
  log?: AgentRuntimeLogFn;
  /** Phase K-2E: Agent 运行时元数据（可选） */
  meta?: AgentRuntimeMeta;
}

export interface IntegratedBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  prevStationSelected: boolean;
  integratedCheckboxChecked: boolean;
  courierSelected: boolean;
  clickedButton: 'none' | 'search';
  finalSubmitClicked: false;
  detectBefore: IntegratedPageDetectResult | null;
  detectAfter: IntegratedPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
  /** Phase K-Final-R1-Fix-B: 逐条运单添加结果 */
  addWaybillResults?: Array<{ waybill: string; result: 'success' | 'failed' | 'no_response'; reason?: string }>;
}

// 到派一体页面 URL 兜底来源：PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE（由 AgentBusinessRuntime 内部使用）

// 禁止点击的按钮关键词
const FORBIDDEN_BUTTON_KEYWORDS = [
  '上传', '提交', '确认', '批量', '派件', '签收', '保存', '完成', '执行', '到派',
];

const WAYBILL_FAST_RESULT_TIMEOUT_MS = 650;
const WAYBILL_TOTAL_RESULT_TIMEOUT_MS = 950;
const MAX_CONSECUTIVE_WAYBILL_NO_RESPONSE = 3;
const PREV_STATION_FAST_TIMEOUT_MS = 900;

function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

async function getIntegratedTableRowCount(page: Page): Promise<number> {
  return page.locator(INTEGRATED_TABLE_ROW_SELECTOR).count().catch(() => 0);
}

async function findIntegratedAddButton(page: Page): Promise<Locator> {
  const buttons = page.locator(INTEGRATED_SCAN_SELECTORS.addButton);
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = ((await button.textContent().catch(() => '')) || '').replace(/\s+/g, '').trim();
    if (text === '添加' || text.includes('添加')) {
      return button;
    }
  }
  return buttons.first();
}

async function getIntegratedWaybillAddDiagnostics(
  page: Page,
  waybillInput: Locator,
  addButtonLoc: Locator,
): Promise<{ inputValue: string; addButtonText: string; messages: string[] }> {
  const inputValue = await waybillInput.inputValue().catch(() => '');
  const addButtonText = ((await addButtonLoc.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const messages = await page.evaluate(() => {
    const selectors = [
      '.el-message__content',
      '.el-notification__content',
      '.el-form-item__error',
      '.el-tooltip__popper',
      '.el-table__empty-text',
    ];
    const els = new Set<Element>();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(el => els.add(el));
    }
    return Array.from(els)
      .filter((el) => {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 0 && rect.height >= 0;
      })
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }).catch(() => []);
  return { inputValue, addButtonText, messages };
}

async function getVisibleIntegratedBlockingMessage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const selectors = [
      '.el-form-item__error',
      '.el-message__content',
      '.el-notification__content',
      '.el-tooltip__popper',
    ];
    const messages: string[] = [];
    for (const selector of selectors) {
      const els = Array.from(document.querySelectorAll(selector));
      for (const el of els) {
        const html = el as HTMLElement;
        const style = window.getComputedStyle(html);
        const rect = html.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 0 || rect.height < 0) continue;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) messages.push(text);
      }
    }
    return messages.find(text =>
      text.includes('不能为空') ||
      text.includes('不存在') ||
      text.includes('错误') ||
      text.includes('无效') ||
      text.includes('重复')
    ) || '';
  }).catch(() => '');
}

async function isIntegratedCheckboxChecked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('label.el-checkbox')).some((label) => {
      const text = label.textContent || '';
      const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      return text.includes('到派一体')
        && (label.classList.contains('is-checked') || input?.checked === true);
    });
  }).catch(() => false);
}

/**
 * 执行到派一体扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 上一站：INTEGRATED_SCAN_SELECTORS.prevStationInput + prevStationOption（el-select 下拉）
 *   - 到派一体复选框：INTEGRATED_SCAN_SELECTORS.integratedCheckbox
 *   - 运单输入框：INTEGRATED_SCAN_SELECTORS.waybillInput
 *   - 添加按钮：INTEGRATED_SCAN_SELECTORS.addButton（仅检测，不点击）
 *   - 上传按钮：INTEGRATED_SCAN_SELECTORS.uploadButton（仅检测，绝不点击）
 */
export async function runIntegratedBrowserDryRun(
  page: Page,
  input: IntegratedBrowserDryRunInput,
): Promise<IntegratedBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options, log, meta } = input;
  const prevStation = options?.prevStation || DEFAULT_PREV_STATION;
  const courierName = options?.courierName;
  const courierEmployeeId = options?.courierEmployeeId;

  const result: IntegratedBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    prevStationSelected: false,
    integratedCheckboxChecked: false,
    courierSelected: false,
    clickedButton: 'none',
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 0. Phase I-2: IntegratedBrowserDryRun 入口日志
  log?.('info', `[Agent][Integrated][BrowserDryRun][FIX-I-002] ENTER staffName=${meta?.staffName || '-'} windowId=${meta?.windowId || '-'} siteId=${meta?.siteId || '-'}`, meta);

  // 1. 确保 Dashboard P0 READY
  console.log('  [Integrated-DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [Integrated-DRY-RUN] Dashboard P0 = READY');

  // 2. 进入到派一体页面 —— Phase K-2E: 菜单优先导航（sidebar_first → sidebar_retry → url_fallback）
  console.log(`  [Integrated-DRY-RUN] 菜单优先导航到到派一体页面`);
  console.log(`  [Integrated-DRY-RUN] 到派一体页面 URL 兜底来源: PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE`);
  const navResult = await navigateToBusinessPageMenuFirst(page, 'integrated', log, meta);
  if (!navResult.success) {
    result.message = `到派一体页面导航失败: ${navResult.message}`;
    warnings.push(`导航方法: ${navResult.method}`);
    return result;
  }
  console.log(`  [Integrated-DRY-RUN] 导航成功，方法: ${navResult.method}，URL: ${navResult.pageUrl}`);
  result.validationLogs.push(`导航方法: ${navResult.method}`);

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
  }
  console.log(`  [Integrated-DRY-RUN] 页面已打开: ${result.pageUrl}`);
  log?.('info', `[Agent][Integrated][BrowserDryRun] 导航成功 method=${navResult.method} url=${result.pageUrl}`, meta);

  // 3. 检测到派一体页面元素（输入前）
  console.log('  [Integrated-DRY-RUN] 检测到派一体页面元素（输入前）...');
  const detectBefore = await detectIntegratedPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [Integrated-DRY-RUN] 是否到派一体页面: ${detectBefore.isIntegratedPage}`);
  console.log(`  [Integrated-DRY-RUN] 上一站输入框: ${detectBefore.hasPrevStationInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 到派一体复选框: ${detectBefore.hasIntegratedCheckbox ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 运单输入框: ${detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 添加按钮: ${detectBefore.hasAddButton ? '已检测到（不点击）' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 上传按钮: ${detectBefore.hasUploadButton ? '已检测到（不点击）' : '未检测到'}`);

  // 4. 选"上一站"= 天津分拨中心
  //    选择器来源：integratedScan.selectors.ts:27 prevStationInput, :30 prevStationOption
  //    交互顺序来源：IntegratedScan.ts:241-272 selectPrevStation
  let prevStationSuccess = false;
  if (detectBefore.hasPrevStationInput && prevStation) {
    console.log(`  [Integrated-DRY-RUN] 上一站填写开始：${prevStation}`);
    console.log(`  [Integrated-DRY-RUN] 上一站 input 选择器来源: integratedScan.selectors.ts:27 prevStationInput`);
    console.log(`  [Integrated-DRY-RUN] 上一站 option 选择器来源: integratedScan.selectors.ts:30 prevStationOption`);
    console.log(`  [Integrated-DRY-RUN] 上一站交互方式: 点击 input → 等 800ms → 选择下拉候选 → 校验 value`);
    result.validationLogs.push(`上一站填写开始：${prevStation}`);
    log?.('info', `[Agent][Integrated][prevStation] START target=${prevStation}`, meta);
    const prevStationStart = Date.now();
    try {
      prevStationSuccess = await stableFillPrevStation(page, prevStation, log, meta);
      if (prevStationSuccess) {
        result.prevStationSelected = true;
        console.log(`  [Integrated-DRY-RUN] 上一站填写校验通过：${prevStation}`);
        result.validationLogs.push(`上一站填写校验通过：${prevStation}`);
        log?.('info', `[Agent][Integrated][prevStation] PASS value=${prevStation}`, meta);
      } else {
        console.log(`  [Integrated-DRY-RUN] 上一站填写失败：未确认选中"${prevStation}"`);
        log?.('error', `[Agent][Integrated][prevStation] FAIL reason=PREV_STATION_NOT_APPLIED`, meta);
      }
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 上一站填写异常: ${(err as Error).message}`);
      log?.('error', `[Agent][Integrated][prevStation] FAIL reason=${(err as Error).message}`, meta);
    }
    const prevStationDuration = Date.now() - prevStationStart;
    log?.('info', `[Agent][Integrated][perf] prevStation durationMs=${prevStationDuration}`, meta);

    if (!prevStationSuccess) {
      warnings.push(`上一站填写失败：未确认选中"${prevStation}"`);
    }
  }

  // 5. 勾选"到派一体"复选框
  //    选择器来源：integratedScan.selectors.ts:33 integratedCheckbox
  //    交互顺序来源：IntegratedScan.ts:287-319 checkIntegratedCheckbox
  let integratedCheckboxSuccess = false;
  if (detectBefore.hasIntegratedCheckbox) {
    console.log(`  [Integrated-DRY-RUN] 勾选"到派一体"复选框...`);
    console.log(`  [Integrated-DRY-RUN] 到派一体复选框选择器来源: integratedScan.selectors.ts:33 integratedCheckbox`);
    result.validationLogs.push(`勾选到派一体复选框开始`);
    log?.('info', '[Agent][Integrated][checkbox] START', meta);
    try {
      // 检查是否已勾选（旧代码 IntegratedScan.ts:296-302）
      const checkedLoc = page.locator('.el-checkbox:has-text("到派一体").is-checked');
      const isChecked = await checkedLoc.count();

      if (isChecked > 0) {
        integratedCheckboxSuccess = true;
        result.integratedCheckboxChecked = true;
        console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 到派一体 checkbox：目标=true，页面=true，匹配=true`);
        result.validationLogs.push(`到派一体复选框已勾选`);
        log?.('info', '[Agent][Integrated][checkbox] PASS checked=true (already checked)', meta);
      } else {
        // 点击 checkbox（旧代码 IntegratedScan.ts:312）
        const checkboxLoc = page.locator(INTEGRATED_SCAN_SELECTORS.integratedCheckbox);
        const cbCount = await checkboxLoc.count();

        if (cbCount === 0) {
          warnings.push('未找到"到派一体"复选框');
          console.log(`  [Integrated-DRY-RUN] 未找到"到派一体"复选框`);
          log?.('error', '[Agent][Integrated][checkbox] FAIL reason=CHECKBOX_NOT_FOUND', meta);
        } else {
          await stableClick(checkboxLoc.first(), { timeoutMs: 5000 });
          await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('label.el-checkbox')).some((label) => {
              const text = label.textContent || '';
              const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
              return text.includes('到派一体')
                && (label.classList.contains('is-checked') || input?.checked === true);
            });
          }, {}, { timeout: 3000 }).catch(() => {});

          // 验证勾选成功
          const checkedAfter = await isIntegratedCheckboxChecked(page);
          if (checkedAfter) {
            integratedCheckboxSuccess = true;
            result.integratedCheckboxChecked = true;
            console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 到派一体 checkbox：目标=true，页面=true，匹配=true`);
            result.validationLogs.push(`到派一体复选框已勾选`);
            log?.('info', '[Agent][Integrated][checkbox] PASS checked=true inputChecked=true', meta);
          } else {
            warnings.push('"到派一体"复选框勾选后验证失败');
            console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 到派一体 checkbox：目标=true，页面=false，匹配=false`);
            log?.('error', '[Agent][Integrated][checkbox] FAIL reason=CHECKBOX_NOT_CHECKED', meta);
          }
        }
      }
    } catch (err) {
      warnings.push(`勾选"到派一体"失败: ${(err as Error).message}`);
      console.log(`  [Integrated-DRY-RUN] 勾选"到派一体"异常: ${(err as Error).message}`);
      log?.('error', `[Agent][Integrated][checkbox] FAIL reason=${(err as Error).message}`, meta);
    }
  }

  // 6. 选派件员 —— 触发"选择派件员"弹窗，按员工编号精确匹配，点击"使用"按钮
  //    选择器来源：integratedSelectors.ts courierSelectInput / courierDialogWrapper /
  //                courierDialogTableRow / courierDialogEmployeeIdCell / courierUseButton
  //    交互顺序来源：IntegratedScan.ts:341-464 selectCourier
  //    ⚠️ 必须用 Playwright 真实 .click() 点击（不能用 page.evaluate），否则 Vue 监听器不响应
  //    ⚠️ "使用"按钮不是最终提交，是必要业务字段选择，允许点击
  //    ⚠️ 派件员 input 在勾选"到派一体"复选框后才动态出现，不能用 detectBefore 检测结果
  //       （detectBefore 是勾选前检测，hasCourierSelectInput 必然为 false）
  //       selectCourier 内部会用 locator.count() 重新检测，找不到时返回 false
  let courierSelectSuccess = false;
  if (integratedCheckboxSuccess && courierName) {
    console.log(`  [Integrated-DRY-RUN] 选派件员开始：${courierName} (employeeId=${courierEmployeeId})`);
    console.log(`  [Integrated-DRY-RUN] 派件员 input 选择器来源: integratedSelectors.ts courierSelectInput`);
    console.log(`  [Integrated-DRY-RUN] 派件员弹窗选择器来源: integratedSelectors.ts courierDialogWrapper`);
    console.log(`  [Integrated-DRY-RUN] 派件员表格行选择器来源: integratedSelectors.ts courierDialogTableRow`);
    console.log(`  [Integrated-DRY-RUN] 员工编号列选择器来源: integratedSelectors.ts courierDialogEmployeeIdCell`);
    console.log(`  [Integrated-DRY-RUN] 使用按钮选择器来源: integratedSelectors.ts courierUseButton`);
    result.validationLogs.push(`选派件员开始：${courierName} (employeeId=${courierEmployeeId})`);
    log?.('info', `[Agent][Integrated][courier] START target=${courierName} employeeId=${courierEmployeeId || '-'}`, meta);
    try {
      courierSelectSuccess = await selectCourier(page, courierName, courierEmployeeId, log, meta);
      if (courierSelectSuccess) {
        result.courierSelected = true;
        console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 目标派件员=${courierName}，匹配=true`);
        result.validationLogs.push(`派件员选择校验通过：${courierName}`);
        log?.('info', `[Agent][Integrated][courier] PASS inputValue=${courierName}`, meta);
      } else {
        console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 目标派件员=${courierName}，匹配=false`);
        log?.('error', `[Agent][Integrated][courier] FAIL reason=COURIER_ROW_NOT_FOUND`, meta);
      }
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 派件员选择异常: ${(err as Error).message}`);
      log?.('error', `[Agent][Integrated][courier] FAIL reason=${(err as Error).message}`, meta);
    }

    if (!courierSelectSuccess) {
      warnings.push(`派件员选择失败：未确认选中"${courierName}"`);
    } else {
      // Phase I-4: 轻量校验替代强制重选
      const lightAfterCourier = await verifyPrevStationLight(page, prevStation);
      if (lightAfterCourier.matched) {
        result.prevStationSelected = true;
        log?.('info', `[Agent][Integrated][prevStation] VERIFY_AFTER_COURIER matched=true value=${formatPrevStationValue(lightAfterCourier.value)}`, meta);
      } else {
        log?.('info', `[Agent][Integrated][prevStation] VERIFY_AFTER_COURIER matched=false reason=${lightAfterCourier.reason || '-'} value=${formatPrevStationValue(lightAfterCourier.value)}`, meta);
        log?.('info', `[Agent][Integrated][prevStation] RESELECT_AFTER_COURIER reason=${lightAfterCourier.reason || '-'} target=${prevStation}`, meta);
        prevStationSuccess = await stableFillPrevStation(page, prevStation, log, meta);
        if (prevStationSuccess) {
          result.prevStationSelected = true;
          log?.('info', `[Agent][Integrated][prevStation] RESELECT_AFTER_COURIER_PASS value=${prevStation}`, meta);
        } else {
          log?.('error', `[Agent][Integrated][prevStation] RESELECT_AFTER_COURIER_FAIL target=${prevStation}`, meta);
        }
      }
    }
  } else if (integratedCheckboxSuccess && !courierName) {
    console.log(`  [Integrated-DRY-RUN] 未提供 courierName，跳过派件员选择`);
    warnings.push('未提供派件员信息，跳过派件员选择');
  }

  // 7. 输入前置校验：上一站 + 到派一体复选框 + 派件员必须全部成功，才允许处理单号。
  console.log('  [Integrated-DRY-RUN] 输入前置校验开始...');
  const preInputChecks = {
    prevStation: prevStationSuccess,
    integratedCheckbox: integratedCheckboxSuccess,
    courier: courierSelectSuccess,
  };
  console.log(`  [Integrated-DRY-RUN] 校验结果：上一站=${preInputChecks.prevStation}，到派一体=${preInputChecks.integratedCheckbox}，派件员=${preInputChecks.courier}`);

  if (!preInputChecks.prevStation || !preInputChecks.integratedCheckbox || !preInputChecks.courier) {
    const failedParts: string[] = [];
    if (!preInputChecks.prevStation) failedParts.push('上一站填写');
    if (!preInputChecks.integratedCheckbox) failedParts.push('到派一体勾选');
    if (!preInputChecks.courier) failedParts.push('派件员选择');
    result.message = `输入前置校验失败：${failedParts.join('、')}未通过，已停止执行`;
    log?.('error', `[Agent][Integrated][precheck] FAIL reason=PRE_CHECK_FAILED failed=${failedParts.join(',')}`, meta);
    result.success = false;
    result.validationLogs.push(`输入校验失败，已停止执行，未点击上传`);
    console.log(`  [Integrated-DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [Integrated-DRY-RUN] 输入前置校验通过');
  log?.('info', `[Agent][Integrated][precheck] PASS checkbox=true prevStation=true courier=true attempted=${waybills.length}`, meta);
  result.validationLogs.push('输入前置校验通过');

  // Phase I-4-1: 轻量校验替代强制重选
  const lightBeforeWaybill = await verifyPrevStationLight(page, prevStation);
  if (lightBeforeWaybill.matched) {
    prevStationSuccess = true;
    result.prevStationSelected = true;
    log?.('info', `[Agent][Integrated][prevStation] VERIFY_BEFORE_WAYBILL matched=true value=${formatPrevStationValue(lightBeforeWaybill.value)}`, meta);
  } else {
    log?.('info', `[Agent][Integrated][prevStation] VERIFY_BEFORE_WAYBILL matched=false reason=${lightBeforeWaybill.reason || '-'} value=${formatPrevStationValue(lightBeforeWaybill.value)}`, meta);
    log?.('info', `[Agent][Integrated][prevStation] RESELECT_BEFORE_WAYBILL reason=${lightBeforeWaybill.reason || '-'} target=${prevStation}`, meta);
    prevStationSuccess = await stableFillPrevStation(page, prevStation, log, meta);
    if (prevStationSuccess) {
      log?.('info', `[Agent][Integrated][prevStation] RESELECT_BEFORE_WAYBILL_PASS value=${prevStation}`, meta);
    }
  }
  if (!prevStationSuccess) {
    result.message = `上一站在填单前未保持选中：${prevStation}，已停止执行`;
    result.success = false;
    warnings.push(result.message);
    log?.('error', `[Agent][Integrated][prevStation] RESELECT_BEFORE_WAYBILL_FAIL target=${prevStation}`, meta);
    return result;
  }

  // 8. Phase I-4: 快速输入 + 读取右侧分页总条数
  //    DaoPai 不负责判断单号有效性，单号是否存在由笨鸟系统校验。
  //    DaoPai 只负责快速输入、点击添加，最终读取笨鸟页面右侧分页真实总条数。
  const addWaybillResults: Array<{ waybill: string; result: 'success' | 'failed' | 'no_response'; reason?: string }> = [];
  const waybillTimings: number[] = [];
  let waybillBeforeTotal: number | null = null;
  let waybillAfterTotal: number | null = null;
  let waybillActualAdded: number | null = null;
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    console.log(`  [Integrated-DRY-RUN] 快速输入单号 (${waybills.length} 条)...`);

    const waybillInput = page.locator(INTEGRATED_SCAN_SELECTORS.waybillInput).first();
    const addButtonLoc = await findIntegratedAddButton(page);
    const addButtonExists = await addButtonLoc.count() > 0;

    if (!(await waybillInput.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log(`  [Integrated-DRY-RUN] 运单输入框不可见，跳过运单处理`);
      warnings.push('运单输入框不可见');
    } else {
      // 添加前读取右侧分页总条数
       waybillBeforeTotal = await readIntegratedRightTotal(page);
       if (waybillBeforeTotal !== null) {
         log?.('info', `[Agent][Integrated][waybill] TOTAL_BEFORE pageTotal=${waybillBeforeTotal}`, meta);
      } else {
        log?.('warning', `[Agent][Integrated][waybill] TOTAL_READ_FAIL`, meta);
      }

      const batchStart = Date.now();
      let batchPrevStationEmpty = false;

      for (let i = 0; i < waybills.length; i++) {
        // 检测"上一站不能为空"错误 → 停止批次
        if (batchPrevStationEmpty) {
          addWaybillResults.push({ waybill: waybills[i], result: 'failed', reason: '上一站不能为空，已停止后续填单' });
          continue;
        }

        const waybill = waybills[i];
        const waybillStart = Date.now();

        try {
          await waybillInput.fill(waybill, { timeout: 1500 });

          // 校验 input.value
          const inputValue = await waybillInput.inputValue().catch(() => '');
          if (!inputValue.includes(waybill)) {
            addWaybillResults.push({ waybill, result: 'failed', reason: `输入值不匹配` });
            log?.('error', `[Agent][Integrated][waybill] FAST_ADD_FAIL reason=VALUE_NOT_APPLIED waybillNo=${waybill} actualValue=${inputValue || '-'}`, meta);
            continue;
          }

          // 点击添加
          if (addButtonExists) {
            const addClickMethod = await clickAddButtonStable(page, addButtonLoc, log, meta);

            // 短等待让笨鸟系统处理
            await page.waitForTimeout(150);

            // 快速检测"上一站不能为空"错误消息
            const blockingMsg = await getVisibleIntegratedBlockingMessage(page);
            if (blockingMsg && blockingMsg.includes('上一站不能为空')) {
              // Phase I-4-1: 先补选上一站，补选失败才 STOP_BATCH
              log?.('error', `[Agent][Integrated][waybill] PREV_STATION_EMPTY_BEFORE_ADD index=${i + 1}/${waybills.length}`, meta);
              log?.('info', `[Agent][Integrated][prevStation] RESELECT_DURING_WAYBILL reason=EMPTY target=${prevStation}`, meta);
              const reselectOk = await stableFillPrevStation(page, prevStation, log, meta);
              if (reselectOk) {
                log?.('info', `[Agent][Integrated][prevStation] RESELECT_DURING_WAYBILL_PASS value=${prevStation}`, meta);
                // 补选成功：重填当前单号 + 重试添加
                await waybillInput.fill(waybill, { timeout: 1500 });
                const retryInputValue = await waybillInput.inputValue().catch(() => '');
                if (!retryInputValue.includes(waybill)) {
                  addWaybillResults.push({ waybill, result: 'failed', reason: '输入值不匹配(重试)' });
                  log?.('error', `[Agent][Integrated][waybill] FAST_ADD_FAIL reason=VALUE_NOT_APPLIED_RETRY waybillNo=${waybill}`, meta);
                  continue;
                }
                if (addButtonExists) {
                  const retryAddClickMethod = await clickAddButtonStable(page, addButtonLoc, log, meta);
                  await page.waitForTimeout(150);
                  const waybillDuration = Date.now() - waybillStart;
                  waybillTimings.push(waybillDuration);
                  log?.('info', `[Agent][Integrated][waybill] FAST_ADD index=${i + 1}/${waybills.length} waybillNo=${waybill} method=${retryAddClickMethod} durationMs=${waybillDuration}`, meta);
                }
                continue;
              } else {
                batchPrevStationEmpty = true;
                addWaybillResults.push({ waybill, result: 'failed', reason: '上一站补选失败，已停止后续填单' });
                log?.('error', `[Agent][Integrated][waybill] STOP_BATCH reason=PREV_STATION_RESELECT_FAILED remaining=${waybills.length - i - 1}`, meta);
                continue;
              }
            }

            const waybillDuration = Date.now() - waybillStart;
            waybillTimings.push(waybillDuration);
            log?.('info', `[Agent][Integrated][waybill] FAST_ADD index=${i + 1}/${waybills.length} waybillNo=${waybill} method=${addClickMethod} durationMs=${waybillDuration}`, meta);
          } else {
            addWaybillResults.push({ waybill, result: 'success', reason: '仅输入，未添加' });
            log?.('warning', `[Agent][Integrated][waybill] CLICK_ADD waybillNo=${waybill} reason=WAYBILL_ADD_BUTTON_NOT_FOUND`, meta);
          }
        } catch (err) {
          addWaybillResults.push({ waybill, result: 'failed', reason: (err as Error).message });
          log?.('error', `[Agent][Integrated][waybill] FAST_ADD_FAIL reason=CLICK_FAILED waybillNo=${waybill} method=exception`, meta);
        }
      }

      // 汇总：读取右侧分页真实总条数
       const batchDuration = Date.now() - batchStart;
       await page.waitForTimeout(500);
       waybillAfterTotal = await readIntegratedRightTotal(page);
       waybillActualAdded = (waybillBeforeTotal !== null && waybillAfterTotal !== null) ? waybillAfterTotal - waybillBeforeTotal : null;
       const avgMs = waybillTimings.length > 0 ? Math.round(waybillTimings.reduce((a, b) => a + b, 0) / waybillTimings.length) : 0;

       log?.('info', `[Agent][Integrated][waybill] TOTAL attempted=${waybills.length} beforeTotal=${waybillBeforeTotal ?? 'null'} afterTotal=${waybillAfterTotal ?? 'null'} actualAdded=${waybillActualAdded ?? 'null'} durationMs=${batchDuration} avgMs=${avgMs}`, meta);
       console.log(`  [Integrated-DRY-RUN] 单号汇总: attempted=${waybills.length} beforeTotal=${waybillBeforeTotal} afterTotal=${waybillAfterTotal} actualAdded=${waybillActualAdded} durationMs=${batchDuration} avgMs=${avgMs}`);

      result.inputCount = waybills.length;
      result.addWaybillResults = addWaybillResults;

      // Phase I-3: 多单号 perf 汇总
      if (waybillTimings.length > 0) {
        const totalMs = waybillTimings.reduce((a, b) => a + b, 0);
        log?.('info', `[Agent][Integrated][perf] waybillAddTotal count=${waybillTimings.length} durationMs=${totalMs} avgMs=${avgMs}`, meta);
      }
    }
  }

  // 9. 安全检测添加按钮和上传按钮（仅检测上传按钮，不点击；添加按钮已在步骤 7 安全点击）
  console.log(`  [Integrated-DRY-RUN] 上传按钮选择器来源: integratedScan.selectors.ts:92 uploadButton（仅检测，不点击）`);
  console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 已检测上传按钮，dry-run 不点击`);
  result.validationLogs.push('已检测上传按钮（未点击）');
  result.validationLogs.push('[Agent][Integrated] 已检测上传按钮，dry-run 不点击');
  result.validationLogs.push('已阻止最终提交');

  // 10. 再次检测页面元素（输入后）
  console.log('  [Integrated-DRY-RUN] 检测到派一体页面元素（输入后）...');
  const detectAfter = await detectIntegratedPage(page);
  result.detectAfter = detectAfter;

  // 11. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.clickedButton = 'none';
  console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] finalSubmitClicked=false`);
  log?.('info', '[Agent][Integrated][safety] DRY_RUN=true finalSubmitClicked=false', meta);

  // 12. 结果
  const successWbCount = addWaybillResults.filter(r => r.result === 'success').length;
  result.success = true;
  result.message = `到派一体 DRY-RUN 完成：attempted=${waybills.length}，页面实际接收=${waybillActualAdded ?? '?'}，pageTotal=${waybillAfterTotal ?? '?'}，未点击上传按钮`;

  console.log(`  [Integrated-DRY-RUN] ${result.message}`);
  return result;
}

// ══════════════════════════════════════════════════════════
// Phase 5-F-0 DOM 审计后修复：基于 label 文本定位"上一站" input
//
// 审计结论（commit ad89249）：
//   - 旧 selector `.arrivalscan_left .el-input--suffix input` + `.first()`
//     命中的是 Row 2「班次」，不是 Row 7「上一站」，导致任务卡住。
//   - 修复策略：弃用 `.first()`，改用 label 文本"上一站"向上查找祖先容器定位 input。
//
// 交互顺序（保留旧代码 IntegratedScan.ts:241-272 的可靠部分）：
//   1. findPrevStationInputByLabel：遍历 .arrivalscan_left input，向上找祖先
//      textContent 同时满足 includes("上一站") && !includes("班次")
//   2. assertNotShiftField：再次校验候选 input 不在班次行（双保险）
//   3. 点击 input → 等 800ms → force click 候选项 → DOM click 兜底 → fill+Enter 兜底
//   4. 三重校验：input.value / el-tag / li.selected
// ══════════════════════════════════════════════════════════

/**
 * Phase 5-F-0: 基于 label 文本定位"上一站" input
 *
 * 审计验证：到派一体左侧表单 Row 7 是 label="上一站" 的行，Row 2 是 label="班次" 的行。
 * 旧 .first() 命中 Row 2 班次，本函数改用 label 文本向上查找行容器定位 Row 7 上一站。
 *
 * 策略（关键：只检查行级容器文本，不检查 .arrivalscan_left 级别）：
 *   1. 遍历 .arrivalscan_left 内所有 input
 *   2. 对每个 input 向上查找"行容器"（.arrivalscan_left > div 的直接子 div）
 *   3. 检查行容器 textContent：
 *      - 必须包含 "上一站"
 *      - 必须不包含 "班次"
 *   4. 命中即返回该 input 的 ElementHandle
 *
 * 注意：不能向上查找过深，否则会到达 .arrivalscan_left 级别，
 *       那里包含所有字段文本（同时含"上一站"和"班次"），导致误判。
 *
 * @returns ElementHandle 或 null（未找到时回退到 nth-child(7) selector）
 */
async function findPrevStationInputByLabel(
  page: Page,
): Promise<ElementHandle<HTMLInputElement> | null> {
  const handle = await page.evaluateHandle(() => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) return null;

    // 到派一体左侧表单结构：.arrivalscan_left > div > div(每个表单行)
    // rowContainer = .arrivalscan_left > div（包含所有行的容器）
    const rowContainer = leftPanel.querySelector(':scope > div');
    if (!rowContainer) return null;

    const inputs = leftPanel.querySelectorAll('input');
    for (const input of inputs) {
      const inputEl = input as HTMLInputElement;

      // 向上查找所属行：rowContainer 的直接子元素
      let node: Node | null = inputEl.parentElement;
      let depth = 0;
      while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          // 行容器的特征：parentElement === rowContainer
          if (el.parentElement === rowContainer) {
            const rowText = el.textContent || '';
            // 行级文本必须包含"上一站"，且不包含"班次"
            if (rowText.includes('上一站') && !rowText.includes('班次')) {
              return inputEl;
            }
            break; // 找到行容器但不符合，跳过这个 input
          }
        }
        node = node.parentNode;
        depth++;
      }
    }
    return null;
  });

  const element = handle.asElement() as ElementHandle<HTMLInputElement> | null;
  return element;
}

/**
 * Phase 5-F-0: 班次字段保护
 *
 * 校验候选 input 的所属行不是班次字段。
 * 只检查行级容器文本（不检查 .arrivalscan_left 级别，避免误中所有字段）。
 *
 * 这是双保险：findPrevStationInputByLabel 已经排除班次，本函数在点击前再校验一次。
 */
async function assertNotShiftField(
  inputHandle: ElementHandle,
): Promise<void> {
  const isShift = await inputHandle.evaluate((el) => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) return false;
    const rowContainer = leftPanel.querySelector(':scope > div');
    if (!rowContainer) return false;

    // 向上查找所属行
    let node: Node | null = el.parentElement;
    let depth = 0;
    while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el2 = node as HTMLElement;
        if (el2.parentElement === rowContainer) {
          // 找到行容器，只检查这一行的文本
          const rowText = el2.textContent || '';
          return rowText.includes('班次');
        }
      }
      node = node.parentNode;
      depth++;
    }
    return false;
  });

  if (isShift) {
    throw new Error('错误：当前元素是班次字段，禁止作为上一站使用');
  }
}

async function getPrevStationInputMeta(
  inputHandle: ElementHandle<HTMLInputElement>,
): Promise<{ rowText: string; placeholder: string }> {
  return inputHandle.evaluate((el) => {
    const placeholder = el.getAttribute('placeholder') || '';
    const leftPanel = document.querySelector('.arrivalscan_left');
    const rowContainer = leftPanel?.querySelector(':scope > div') || null;
    let rowText = '';
    let node: Node | null = el.parentElement;
    let depth = 0;
    while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const candidate = node as HTMLElement;
        if (!rowContainer || candidate.parentElement === rowContainer) {
          rowText = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
          break;
        }
      }
      node = node.parentNode;
      depth++;
    }
    return { rowText, placeholder };
  }).catch(() => ({ rowText: '', placeholder: '' }));
}

async function readPrevStationPageValue(page: Page, prevStation: string): Promise<string> {
  const inputHandle = await findPrevStationInputByLabel(page);
  const inputValue = inputHandle ? await inputHandle.inputValue().catch(() => '') : '';
  if (inputValue) return inputValue;
  if (!inputHandle) return '';
  return inputHandle.evaluate((el, search) => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    const rowContainer = leftPanel?.querySelector(':scope > div') || null;
    let node: Node | null = el.parentElement;
    let depth = 0;
    while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const candidate = node as HTMLElement;
        if (!rowContainer || candidate.parentElement === rowContainer) {
          const rowText = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
          return rowText.includes(search) ? rowText : '';
        }
      }
      node = node.parentNode;
      depth++;
    }
    return '';
  }, prevStation).catch(() => '');
}

async function waitPrevStationRowValue(page: Page, prevStation: string, timeoutMs: number): Promise<boolean> {
  return page.waitForFunction((target: string) => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) return false;
    const rowContainer = leftPanel.querySelector(':scope > div');
    if (!rowContainer) return false;
    const inputs = Array.from(leftPanel.querySelectorAll('input')) as HTMLInputElement[];
    for (const input of inputs) {
      let node: Node | null = input.parentElement;
      let depth = 0;
      while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const row = node as HTMLElement;
          if (row.parentElement === rowContainer) {
            const rowText = row.textContent || '';
            if (rowText.includes('上一站') && !rowText.includes('班次')) {
              return !!input.value && input.value.includes(target);
            }
            break;
          }
        }
        node = node.parentNode;
        depth++;
      }
    }
    return false;
  }, prevStation, { timeout: timeoutMs, polling: 60 }).then(() => true).catch(() => false);
}

async function isVisiblePrevStationPopper(page: Page, prevStation?: string): Promise<boolean> {
  return page.evaluate((target?: string) => {
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    return poppers.some((popper) => {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      if (!visible) return false;
      if (!target) return true;
      return (popper.textContent || '').includes(target);
    });
  }, prevStation).catch(() => false);
}

async function filterPrevStationOptions(
  page: Page,
  prevInputHandle: ElementHandle<HTMLInputElement>,
  prevStation: string,
  timeoutMs = 1200,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  await page.waitForTimeout(500);

  const searchText = prevStation === DEFAULT_PREV_STATION ? '天津分拨站中心' : prevStation;
  let typedInPopper = false;
  const popperSearchInput = page
    .locator('body > div.el-select-dropdown.el-popper:visible input:visible')
    .last();
  const searchInputVisible = await popperSearchInput
    .waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 1200) })
    .then(() => true)
    .catch(() => false);
  if (searchInputVisible && (await popperSearchInput.count().catch(() => 0)) > 0) {
    typedInPopper = await popperSearchInput
      .click({ timeout: 500 })
      .then(async () => {
        await popperSearchInput.fill(searchText, { timeout: 700 });
        return true;
      })
      .catch(() => false);
  }

  if (!typedInPopper) {
    typedInPopper = await page.evaluate((text: string) => {
    const visiblePoppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    let activePopper: HTMLElement | null = null;
    for (const popper of visiblePoppers) {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
      activePopper = popper;
    }
    if (!activePopper) return false;

    const inputs = Array.from(activePopper.querySelectorAll('input')) as HTMLInputElement[];
    const searchInput = inputs.find((input) => {
      const style = window.getComputedStyle(input);
      const rect = input.getBoundingClientRect();
      return input.type !== 'hidden' &&
        !input.disabled &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;
    });
    if (!searchInput) return false;

    searchInput.focus();
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.value = text;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
    }, searchText).catch(() => false);
  }

  if (!typedInPopper) {
    const popperVisible = await isVisiblePrevStationPopper(page);
    if (!popperVisible) {
      await prevInputHandle.click({ timeout: 800, force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(searchText, { delay: 0 }).catch(() => {});
  }
  log?.(
    typedInPopper ? 'info' : 'warning',
    `[Agent][Integrated][prevStation] FILTER_INPUT typedInPopper=${typedInPopper} searchText=${searchText}`,
    meta,
  );

  return page.waitForFunction((target: string) => {
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    return poppers.some((popper) => {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        (popper.textContent || '').includes(target);
    });
  }, prevStation, { timeout: timeoutMs, polling: 80 }).then(() => true).catch(() => false);
}

async function clickPrevStationTrigger(page: Page, prevInputHandle: ElementHandle<HTMLInputElement>, prevStation: string): Promise<boolean> {
  const triggerAttempts: Array<{ name: string; click: () => Promise<void> }> = [
    {
      name: 'input_right_edge',
      click: async () => {
        const box = await prevInputHandle.boundingBox();
        if (!box) throw new Error('prev station input box not found');
        await page.mouse.click(box.x + Math.max(box.width - 18, box.width / 2), box.y + box.height / 2);
      },
    },
    {
      name: 'suffix',
      click: async () => {
        const suffix = await prevInputHandle.evaluateHandle((input) =>
          input.closest('.item')?.querySelector('.el-input__suffix') ||
          input.closest('.el-select')?.querySelector('.el-input__suffix')
        );
        const element = suffix.asElement();
        if (!element) throw new Error('prev station suffix not found');
        await element.click({ timeout: 5_000 });
      },
    },
    {
      name: 'row_select_wrapper',
      click: async () => {
        const box = await prevInputHandle.evaluate((input) => {
          const wrapper = input.closest('.el-select') || input.closest('.el-input') || input.parentElement;
          if (!wrapper) return null;
          const rect = wrapper.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        if (!box) throw new Error('prev station wrapper box not found');
        await page.mouse.click(box.x + Math.max(box.width - 18, box.width / 2), box.y + box.height / 2);
      },
    },
    {
      name: 'wrapper',
      click: async () => {
        const wrapper = await prevInputHandle.evaluateHandle((input) =>
          input.closest('.item')?.querySelector('.el-select') ||
          input.closest('.el-select') ||
          input.closest('.el-input')
        );
        const element = wrapper.asElement();
        if (!element) throw new Error('prev station wrapper not found');
        await element.click({ timeout: 5_000 });
      },
    },
  ];

  for (const attempt of triggerAttempts) {
    if (await isVisiblePrevStationPopper(page)) return true;
    await attempt.click();
    console.log(`  [Integrated-DRY-RUN] 已点击上一站 ${attempt.name}`);
    const opened = await page.waitForFunction(() => {
      const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
      return poppers.some((popper) => {
        const style = window.getComputedStyle(popper);
        const rect = popper.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0;
      });
    }, {}, { timeout: 1200, polling: 80 }).then(() => true).catch(() => false);
    if (opened || await isVisiblePrevStationPopper(page)) return true;
    await page.waitForTimeout(250);
  }

  return false;
}

async function clickVisiblePrevStationOptionFast(page: Page, prevStation: string): Promise<string> {
  const optionBox = await page.evaluate((target) => {
    const normalize = (text: string) => text.replace(/\s+/g, '');
    const normalizedTarget = normalize(target);
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    for (const popper of poppers) {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      const popperVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      if (!popperVisible) continue;
      const options = Array.from(popper.querySelectorAll('li.el-select-dropdown__item')) as HTMLElement[];
      for (const option of options) {
        const text = normalize(option.textContent || '');
        if (text.includes(normalizedTarget)) {
          option.scrollIntoView({ block: 'center', inline: 'nearest' });
          const rect = option.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: option.textContent || '',
          };
        }
      }
    }
    return null;
  }, prevStation).catch(() => '');
  if (optionBox && typeof optionBox === 'object' && Number.isFinite(optionBox.x) && Number.isFinite(optionBox.y)) {
    await page.mouse.click(optionBox.x, optionBox.y);
    return 'mouseFastClick';
  }
  return '';
}

async function clickVisiblePrevStationOption(page: Page, prevStation: string): Promise<string> {
  // Phase I-3: V2 风格 evaluate DOM click 优先（绕过 Playwright actionability）
  const domResult = await clickVisiblePrevStationOptionFast(page, prevStation);
  if (domResult === 'domClick') {
    console.log(`  [Integrated-DRY-RUN] 上一站候选项 DOM click: ${prevStation}`);
    return 'domClick';
  }

  // 坐标点击兜底
  const optionBox = await page.evaluate((target) => {
    const normalize = (text: string) => text.replace(/\s+/g, '');
    const normalizedTarget = normalize(target);
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    for (const popper of poppers) {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      const popperVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      if (!popperVisible) continue;
      const options = Array.from(popper.querySelectorAll('li.el-select-dropdown__item')) as HTMLElement[];
      for (const option of options) {
        const text = normalize(option.textContent || '');
        if (!text.includes(normalizedTarget)) continue;
        option.scrollIntoView({ block: 'center', inline: 'nearest' });
        const optionRect = option.getBoundingClientRect();
        return {
          x: optionRect.left + optionRect.width / 2,
          y: optionRect.top + optionRect.height / 2,
          text: option.textContent || '',
        };
      }
    }
    return null;
  }, prevStation).catch(() => null);
  if (optionBox && Number.isFinite(optionBox.x) && Number.isFinite(optionBox.y)) {
    console.log(`  [Integrated-DRY-RUN] 上一站候选项坐标点击: ${optionBox.text.replace(/\s+/g, ' ').trim()}`);
    await page.mouse.click(optionBox.x, optionBox.y);
    return 'mouseClick';
  }

  // locator click 兜底
  const optionHandles = await page.$$('body > div.el-select-dropdown.el-popper li.el-select-dropdown__item');
  for (const option of optionHandles) {
    const match = await option.evaluate((item, target) => {
      const popper = item.closest('div.el-select-dropdown.el-popper') as HTMLElement | null;
      if (!popper) return false;
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      const popperVisible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      return popperVisible && (item.textContent || '').includes(target);
    }, prevStation).catch(() => false);
    if (!match) continue;
    await option.click({ timeout: 5_000 });
    return 'locatorClick';
  }
  return 'none';
}

async function tryV2LegacySelectPrevStation(
  page: Page,
  prevStation: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  try {
    log?.('info', `[Agent][Integrated][prevStation] V2_LEGACY_START target=${prevStation}`, meta);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(100);
    await page.click(INTEGRATED_SCAN_SELECTORS.prevStationInput, { timeout: 5000 });
    await page.waitForTimeout(800);

    const clicked = await page.evaluate((stationName) => {
      const items = document.querySelectorAll('li.el-select-dropdown__item');
      for (const item of items) {
        if (item.textContent && item.textContent.includes(stationName)) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, prevStation).catch(() => false);

    if (clicked) {
      await page.waitForTimeout(500);
      const verified = await waitPrevStationRowValue(page, prevStation, 1200);
      log?.(verified ? 'info' : 'warning', `[Agent][Integrated][prevStation] V2_LEGACY_CLICK clicked=true verified=${verified}`, meta);
      if (verified) return true;
    }

    log?.('warning', `[Agent][Integrated][prevStation] V2_LEGACY_OPTION_NOT_FOUND action=fill_enter`, meta);
    await page.fill(INTEGRATED_SCAN_SELECTORS.prevStationInput, prevStation, { timeout: 3000 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const verified = await waitPrevStationRowValue(page, prevStation, 1200);
    log?.(verified ? 'info' : 'warning', `[Agent][Integrated][prevStation] V2_LEGACY_FILL verified=${verified}`, meta);
    return verified;
  } catch (err) {
    log?.('warning', `[Agent][Integrated][prevStation] V2_LEGACY_FAIL reason=${(err as Error).message}`, meta);
    return false;
  }
}

async function tryFastFillPrevStation(
  page: Page,
  prevStation: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  if (await tryV2LegacySelectPrevStation(page, prevStation, log, meta)) {
    return true;
  }

  let prevInputHandle = await findPrevStationInputByLabel(page);
  if (!prevInputHandle) {
    const fallbackHandle = await page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInputByRow)
      .first()
      .elementHandle()
      .catch(() => null);
    prevInputHandle = fallbackHandle as ElementHandle<HTMLInputElement> | null;
  }
  if (!prevInputHandle) return false;

  await assertNotShiftField(prevInputHandle);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(80);
  await prevInputHandle.click({ timeout: 1200 }).catch(async () => {
    await prevInputHandle!.click({ timeout: 1200, force: true });
  });

  const opened = await page.waitForFunction(() => {
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    return poppers.some((popper) => {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;
    });
  }, {}, { timeout: PREV_STATION_FAST_TIMEOUT_MS, polling: 60 }).then(() => true).catch(() => false);
  if (!opened) return false;

  await filterPrevStationOptions(page, prevInputHandle, prevStation, PREV_STATION_FAST_TIMEOUT_MS, log, meta);

  const clickMethod = await clickVisiblePrevStationOptionFast(page, prevStation);
  if (clickMethod !== 'mouseFastClick') return false;

  const verified = await waitPrevStationRowValue(page, prevStation, PREV_STATION_FAST_TIMEOUT_MS);

  if (verified) {
    const pageValue = await readPrevStationPageValue(page, prevStation);
    console.log(`  [Integrated-DRY-RUN] 上一站快速路径通过：目标=${prevStation}，页面=${pageValue || '(空)'}`);
    log?.('info', `[Agent][Integrated][prevStation] FAST_PASS target=${prevStation} actual=${pageValue || '-'}`, meta);
    return true;
  }

  log?.('warning', `[Agent][Integrated][prevStation] FAST_FAIL target=${prevStation}`, meta);
  return false;
}

async function stableFillPrevStation(
  page: Page,
  prevStation: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  // Phase I-4: 已选跳过 — 轻量校验，不打开下拉、不扫描候选项
  const lightCheck = await verifyPrevStationLight(page, prevStation);
  if (lightCheck.matched) {
    console.log(`  [Integrated-DRY-RUN] 上一站已选中，跳过: ${prevStation} (value=${formatPrevStationValue(lightCheck.value)})`);
    log?.('info', `[Agent][Integrated][prevStation] SKIP_ALREADY_SELECTED value=${formatPrevStationValue(lightCheck.value)}`, meta);
    return true;
  }

  if (await tryFastFillPrevStation(page, prevStation, log, meta).catch(() => false)) {
    return true;
  }

  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  [Integrated-DRY-RUN] 上一站填写第 ${attempt} 次尝试...`);

    try {
      // Step 1: 基于 label 文本定位"上一站" input
      let prevInputHandle = await findPrevStationInputByLabel(page);

      if (!prevInputHandle) {
        console.log(`  [Integrated-DRY-RUN] label 定位未命中，回退到 nth-child(7) selector`);
        const fallbackLoc = page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInputByRow);
        if (await fallbackLoc.count() === 0) {
          console.log(`  [Integrated-DRY-RUN] 兜底 selector 也未命中，放弃本次尝试`);
          continue;
        }
        const fallbackHandle = await fallbackLoc.first().elementHandle();
        if (!fallbackHandle) continue;
        prevInputHandle = fallbackHandle as ElementHandle<HTMLInputElement>;
      }

      // Step 2: 班次字段保护（双保险）
      await assertNotShiftField(prevInputHandle);
      console.log(`  [Integrated-DRY-RUN] 已通过班次保护校验，确认是上一站 input`);

      // Step 3: 打开 dropdown
      const popperOpened = await clickPrevStationTrigger(page, prevInputHandle, prevStation);
      if (!popperOpened) {
        console.log(`  [Integrated-DRY-RUN] INTEGRATED_PREV_STATION_POPPER_NOT_VISIBLE`);
        await page.keyboard.press('Escape').catch(() => {});
        continue;
      }
      console.log(`  [Integrated-DRY-RUN] 上一站 popper 已出现`);
      const filtered = await filterPrevStationOptions(page, prevInputHandle, prevStation, 1200, log, meta);
      log?.(filtered ? 'info' : 'warning', `[Agent][Integrated][prevStation] FILTER target=${prevStation} matched=${filtered}`, meta);

      // Phase I-3: 输出可见候选项（仅在 task_logs，不刷 DOM 细节）
      const visibleOptions = await page.evaluate(() => {
        const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
        for (const popper of poppers) {
          const style = window.getComputedStyle(popper);
          const rect = popper.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
          const options = Array.from(popper.querySelectorAll('li.el-select-dropdown__item'));
          return options.map(o => (o.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        }
        return [];
      });
      log?.('info', `[Agent][Integrated][prevStation] OPTIONS items=${JSON.stringify(visibleOptions.slice(0, 10))}`, meta);

      // Step 4: 点击候选项
      // Phase I-3: 第 1 次 domClick，第 2 次坐标/locator click，第 3 次 nth-child 兜底
      let clickMethod: string;
      if (attempt === 1) {
        // 快速路径：domClick
        clickMethod = await clickVisiblePrevStationOptionFast(page, prevStation);
        if (clickMethod !== 'mouseFastClick') {
          // domClick 未命中，走完整 clickVisiblePrevStationOption
          clickMethod = await clickVisiblePrevStationOption(page, prevStation);
        }
      } else {
        clickMethod = await clickVisiblePrevStationOption(page, prevStation);
      }
      log?.('info', `[Agent][Integrated][prevStation] CLICK_OPTION method=${clickMethod} target=${prevStation}`, meta);
      console.log(`  [Integrated-DRY-RUN] 已点击候选项 method=${clickMethod}`);

      const verified = await waitPrevStationRowValue(page, prevStation, 1200);

      if (verified) {
        const pageValue = await readPrevStationPageValue(page, prevStation);
        console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 目标上一站=${prevStation}，页面上一站=${pageValue || '(空)'}，匹配=true`);
        return true;
      }

      const pageValue = await readPrevStationPageValue(page, prevStation);
      console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 目标上一站=${prevStation}，页面上一站=${pageValue || '(空)'}，匹配=false`);
      console.log(`  [Integrated-DRY-RUN] INTEGRATED_PREV_STATION_VERIFY_FAILED method=${clickMethod}`);
      await page.keyboard.press('Escape').catch(() => {});
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 上一站填写第 ${attempt} 次异常: ${(err as Error).message}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    if (attempt < MAX_RETRIES) {
      await page.waitForTimeout(300);
    }
  }

  // 全部失败，输出候选项文本帮助排错
  const finalOptions = await page.evaluate(() => {
    const poppers = Array.from(document.querySelectorAll('body > div.el-select-dropdown.el-popper')) as HTMLElement[];
    for (const popper of poppers) {
      const style = window.getComputedStyle(popper);
      const rect = popper.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
      return Array.from(popper.querySelectorAll('li.el-select-dropdown__item')).map(o => (o.textContent || '').replace(/\s+/g, ' ').trim());
    }
    return [];
  });
  const pageValue = await readPrevStationPageValue(page, prevStation);
  log?.('error', `[Agent][Integrated][prevStation] FAIL PREV_STATION_NOT_APPLIED target=${prevStation} actual=${pageValue || '-'} options=${JSON.stringify(finalOptions.slice(0, 10))}`, meta);
  return false;
}

/**
 * 校验上一站是否成功选中
 *
 * Element el-select 选中后，可能有三种表现：
 *   1. input.value 直接为选中文本（普通模式）
 *   2. input.value 为空，但显示 el-tag（多选/远程模式）
 *   3. li.el-select-dropdown__item 有 selected 类（Element UI 内部状态）
 *
 * Phase 5-F-0 修复：input.value 读取改用 findPrevStationInputByLabel，
 *                   避免旧 .first() 命中班次 input。
 *
 * 校验策略（增强版，处理到派一体页面 el-select 特殊行为）：
 *   - 先读 input.value（基于 label 定位），若包含 prevStation → 通过
 *   - 否则查找 el-select__tags 或 .el-tag，若包含 prevStation → 通过
 *   - 否则查找 li.el-select-dropdown__item.selected，若文本包含 prevStation → 通过
 *   - 否则失败
 */
async function verifyPrevStationSelected(page: Page, prevStation: string): Promise<boolean> {
  try {
    // 1. 读取 input.value（Phase 5-F-0：基于 label 定位，不再用 .first()）
    let inputValue = '';
    const prevInputHandle = await findPrevStationInputByLabel(page);
    if (prevInputHandle) {
      inputValue = await prevInputHandle.inputValue().catch(() => '');
    } else {
      // 兜底：nth-child(7) selector
      inputValue = await page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInputByRow)
        .first().inputValue().catch(() => '');
    }

    if (inputValue.includes(prevStation)) {
      console.log(`  [Integrated-DRY-RUN] 上一站 input.value 校验通过: "${inputValue}"`);
      return true;
    }

    // 2. 只检查上一站所在行的展示文本，避免其它 el-select 的 selected 状态造成假阳性。
    const tagText = prevInputHandle
      ? await prevInputHandle.evaluate((el, search) => {
        const leftPanel = document.querySelector('.arrivalscan_left');
        const rowContainer = leftPanel?.querySelector(':scope > div') || null;
        let node: Node | null = el.parentElement;
        let depth = 0;
        while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const candidate = node as HTMLElement;
            if (!rowContainer || candidate.parentElement === rowContainer) {
              const rowText = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
              return rowText.includes(search) ? rowText : '';
            }
          }
          node = node.parentNode;
          depth++;
        }
        return '';
      }, prevStation).catch(() => '')
      : '';

    if (tagText.includes(prevStation)) {
      console.log(`  [Integrated-DRY-RUN] 上一站 el-tag 校验通过: "${tagText}"`);
      return true;
    }

    // 3. 校验失败
    console.log(`  [Integrated-DRY-RUN] 上一站校验失败：input="${inputValue}"，rowText="${tagText}"`);
    return false;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 选派件员 —— 触发"选择派件员"弹窗，按员工编号精确匹配，点击"使用"按钮
//
// 严格遵循旧代码 IntegratedScan.ts:341-464 selectCourier 原样逻辑：
//   1. Playwright 真实 .click() 点击派件员 input（触发 Vue 监听器弹出弹窗）
//   2. 等待 div.el-dialog__wrapper 弹窗出现（textContent 包含"选择派件员"）
//   3. 遍历 el-table 表格行，按 el-table_2_column_16（员工编号列）精确匹配 employeeId
//      （字符串严格相等，不用 includes 模糊匹配）
//   4. 点击匹配行的"使用"按钮（位于 .el-table__fixed-right 固定列内）
//      ⚠️ "使用"按钮不是最终提交，是必要业务字段选择
//   5. 验证：弹窗关闭 + 派件员 input 回填的姓名与传入 courierName 一致
//
// ⚠️ 关键：必须用 Playwright 真实 .click()（page.click / locator.click），
//    不能用 page.evaluate(el => el.click()) —— 后者不触发 Vue 监听器，
//    弹窗不会弹出，"使用"按钮点击也不会生效。
//
// 选择器来源：
//   - courierSelectInput: integratedSelectors.ts（来源 integratedScan.selectors.ts:44）
//   - courierDialogWrapper: integratedSelectors.ts（来源 integratedScan.selectors.ts:56）
//   - courierDialogTableRow: integratedSelectors.ts（来源 integratedScan.selectors.ts:59）
//   - courierDialogEmployeeIdCell: integratedSelectors.ts（来源 integratedScan.selectors.ts:65）
//   - courierUseButton: integratedSelectors.ts（来源 integratedScan.selectors.ts:74）
// ══════════════════════════════════════════════════════════

async function selectCourier(
  page: Page,
  courierName: string,
  courierEmployeeId?: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  // Step 1: Playwright 真实 .click() 点击派件员 input 触发弹窗
  console.log(`  [Integrated-DRY-RUN] 派件员 Step1: 点击派件员 input 触发弹窗`);
  const inputLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput);
  const inputCount = await inputLoc.count();
  if (inputCount === 0) {
    console.log(`  [Integrated-DRY-RUN] 未找到派件员 input（选择器: ${INTEGRATED_SCAN_SELECTORS.courierSelectInput}）`);
    return false;
  }

  try {
    await inputLoc.first().click({ timeout: 10_000 });
  } catch (err) {
    console.log(`  [Integrated-DRY-RUN] 点击派件员 input 失败: ${(err as Error).message}`);
    return false;
  }

  // Step 2: 等待"选择派件员"弹窗出现
  console.log(`  [Integrated-DRY-RUN] 派件员 Step2: 等待"选择派件员"弹窗出现`);
  const dialogLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierDialogWrapper);
  try {
    await dialogLoc.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (err) {
    console.log(`  [Integrated-DRY-RUN] INTEGRATED_COURIER_DIALOG_NOT_OPEN: ${(err as Error).message}`);
    return false;
  }
  console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗已出现`);
  log?.('info', `[Agent][Integrated][courier] DIALOG_OPENED`, meta);

  console.log(`  [Integrated-DRY-RUN] 派件员 Step3: 遍历表格行匹配 (employeeId=${courierEmployeeId || '(空)'}, name=${courierName})`);
  const tableReady = await page.waitForFunction(
    ({ rowSelector, useButtonSelector }) => {
      const rows = Array.from(document.querySelectorAll(rowSelector));
      const visibleRows = rows.filter((row) => {
        const rect = (row as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (row.textContent || '').trim().length > 0;
      });
      const useButtons = Array.from(document.querySelectorAll(useButtonSelector));
      const visibleUseButtons = useButtons.filter((button) => {
        const rect = (button as HTMLElement).getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visibleRows.length > 0 || visibleUseButtons.length > 0;
    },
    {
      rowSelector: INTEGRATED_SCAN_SELECTORS.courierDialogTableRow,
      useButtonSelector: INTEGRATED_SCAN_SELECTORS.courierUseButton,
    },
    { timeout: 8_000 },
  ).then(() => true).catch(() => false);
  if (!tableReady) {
    console.log(`  [Integrated-DRY-RUN] INTEGRATED_COURIER_ROW_NOT_FOUND: 弹窗表格未加载可见行`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    return false;
  }

  const matchResult = await page.evaluate((args: { rowSelector: string; targetId: string; targetName: string }) => {
    const rows = document.querySelectorAll(args.rowSelector);
    const idDump: string[] = [];
    let nameMatchedRowIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowText = (rows[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (nameMatchedRowIdx === -1 && args.targetName && rowText.includes(args.targetName)) {
        nameMatchedRowIdx = i;
      }
      const cells = rows[i].querySelectorAll('td');
      for (const cell of cells) {
        const text = (cell.textContent || '').trim();
        if (text && text.length > 0) {
          idDump.push(`[行${i + 1}列${cell.className || '?'}]=${text}`);
        }
        // 严格相等匹配 employeeId
        if (args.targetId && text === args.targetId) {
          return { matchedRowIdx: i, idDump, matchedText: text, matchType: 'employeeId' };
        }
      }
    }
    if (nameMatchedRowIdx >= 0) {
      return { matchedRowIdx: nameMatchedRowIdx, idDump, matchedText: args.targetName, matchType: 'name' };
    }
    return { matchedRowIdx: -1, idDump, matchedText: '', matchType: 'none' };
  }, {
    rowSelector: INTEGRATED_SCAN_SELECTORS.courierDialogTableRow,
    targetId: courierEmployeeId || '',
    targetName: courierName,
  }).catch(() => ({ matchedRowIdx: -1, idDump: [], matchedText: '', matchType: 'none' }));

  const rowCount = matchResult.idDump.length;
  console.log(`  [Integrated-DRY-RUN] 弹窗表格扫描单元格数: ${rowCount}`);

  if (matchResult.matchedRowIdx === -1) {
    console.log(`  [Integrated-DRY-RUN] INTEGRATED_COURIER_ROW_NOT_FOUND: employeeId=${courierEmployeeId || '(空)'} name=${courierName} 表格扫描结果=${JSON.stringify(matchResult.idDump.slice(0, 20))}`);
    // 关闭弹窗，避免阻塞后续操作
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    return false;
  }

  console.log(`  [Integrated-DRY-RUN] 匹配命中: 第${matchResult.matchedRowIdx + 1}行, matchType=${matchResult.matchType}, matched=${matchResult.matchedText}`);
  const matchedRowIdx = matchResult.matchedRowIdx;
  log?.('info', `[Agent][Integrated][courier] MATCH employeeId=${courierEmployeeId || '-'} staffName=${courierName} matchType=${matchResult.matchType} row=${matchedRowIdx + 1}`, meta);

  // Step 4: 点击匹配行的"使用"按钮（位于 .el-table__fixed-right 固定列内）
  // Element UI 固定列机制：操作列在主表中 is-hidden，在 .el-table__fixed-right 中可见
  // 优先按匹配行索引点固定列按钮；若固定列行号与主表短暂错位，则按主表行坐标找最近的"使用"按钮。
  console.log(`  [Integrated-DRY-RUN] 派件员 Step4: 点击第${matchedRowIdx + 1}行的"使用"按钮`);
  const useClickMethod = await clickCourierUseButtonForRow(page, matchedRowIdx, log, meta);

  // Step 5: 验证 —— 弹窗关闭 + 派件员 input 回填的姓名与传入 courierName 一致
  console.log(`  [Integrated-DRY-RUN] 派件员 Step5: 验证弹窗关闭 + 派件员 input 回填`);
  log?.('info', `[Agent][Integrated][courier] CLICK_USE method=${useClickMethod}`, meta);

  // 等待弹窗关闭（Element UI 关闭动画约 300-500ms，给 5s 兜底）
  let dialogClosed = true;
  try {
    await dialogLoc.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    dialogClosed = false;
  }

  if (!dialogClosed) {
    // 弹窗未关闭 —— 可能是"使用"按钮未生效，但也可能是动画未完成
    // 用派件员 input 回填值做兜底判断：如果已回填正确姓名，说明选择已生效
    const fallbackValue = await page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first()
      .inputValue().catch(() => '');
    if (fallbackValue.includes(courierName)) {
      console.log(`  [Integrated-DRY-RUN] 弹窗未完全关闭，但派件员 input 已回填"${fallbackValue}"，视为选择成功`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
    } else {
      console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗未关闭且 input 未回填（value="${fallbackValue}"），"使用"按钮可能未生效`);
      log?.('error', `[Agent][Integrated][courier] COURIER_USE_CLICK_NO_EFFECT inputValue=${fallbackValue || '-'} dialogVisible=true`, meta);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      return false;
    }
  } else {
    console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗已关闭`);
  }

  // 验证派件员 input 回填的姓名与传入 courierName 一致
  const courierInputValue = await page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first()
    .inputValue().catch(() => '');
  const ok = courierInputValue.includes(courierName);
  console.log(`  [Integrated-DRY-RUN] [Agent][Integrated] 目标派件员=${courierName}，页面派件员=${courierInputValue || '(空)'}，匹配=${ok}`);
  if (ok) {
    return true;
  } else {
    console.log(`  [Integrated-DRY-RUN] INTEGRATED_COURIER_VERIFY_FAILED`);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// Phase I-2: 稳定点击工具函数
// ══════════════════════════════════════════════════════════

/**
 * 派件员弹窗"使用"按钮稳定点击
 *
 * Phase I-2: 迁入 V2 fastStableBypassClick 经验，优先 forceClick，
 * 兜底 mouseClick 坐标点击，解决 Element UI fixed-column actionability 问题。
 *
 * 成功标准由调用方校验（弹窗关闭 / input 回填），本函数只保证点击不报错。
 */
async function clickCourierUseButtonForRow(
  page: Page,
  matchedRowIdx: number,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<string> {
  const useButtons = page.locator(INTEGRATED_SCAN_SELECTORS.courierUseButton);
  const buttonCount = await useButtons.count().catch(() => 0);

  if (buttonCount > matchedRowIdx) {
    try {
      const method = await clickUseButtonStable(page, useButtons.nth(matchedRowIdx), log, meta);
      return `index:${method}`;
    } catch (err) {
      log?.('warning', `[Agent][Integrated][courier] USE_INDEX_CLICK_FAILED row=${matchedRowIdx + 1} count=${buttonCount} reason=${(err as Error).message}`, meta);
    }
  }

  const clickedByRowY = await page.evaluate((args: { rowSelector: string; buttonSelector: string; rowIdx: number }) => {
    const rows = Array.from(document.querySelectorAll(args.rowSelector)) as HTMLElement[];
    const targetRow = rows[args.rowIdx];
    if (!targetRow) return { ok: false, reason: 'ROW_NOT_FOUND', distance: -1 };

    const rowRect = targetRow.getBoundingClientRect();
    const rowY = rowRect.top + rowRect.height / 2;
    const buttons = Array.from(document.querySelectorAll(args.buttonSelector)) as HTMLElement[];
    let best: { button: HTMLElement; distance: number } | null = null;

    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
      const text = (button.textContent || '').replace(/\s+/g, '').trim();
      if (text && !text.includes('使用')) continue;
      const buttonY = rect.top + rect.height / 2;
      const distance = Math.abs(buttonY - rowY);
      if (!best || distance < best.distance) best = { button, distance };
    }

    if (!best) return { ok: false, reason: 'BUTTON_NOT_FOUND', distance: -1 };
    if (best.distance > Math.max(rowRect.height, 36)) {
      return { ok: false, reason: `BUTTON_ROW_DISTANCE_TOO_LARGE:${best.distance}`, distance: best.distance };
    }
    best.button.click();
    return { ok: true, reason: 'rowYDomClick', distance: best.distance };
  }, {
    rowSelector: INTEGRATED_SCAN_SELECTORS.courierDialogTableRow,
    buttonSelector: INTEGRATED_SCAN_SELECTORS.courierUseButton,
    rowIdx: matchedRowIdx,
  }).catch((err) => ({ ok: false, reason: (err as Error).message, distance: -1 }));

  if (clickedByRowY.ok) {
    log?.('info', `[Agent][Integrated][courier] USE_ROW_Y_CLICK row=${matchedRowIdx + 1} distance=${clickedByRowY.distance}`, meta);
    return 'rowYDomClick';
  }

  throw new Error(`COURIER_USE_BUTTON_CLICK_FAILED: row=${matchedRowIdx + 1} count=${buttonCount} reason=${clickedByRowY.reason}`);
}

async function clickUseButtonStable(
  page: Page,
  buttonLoc: ReturnType<Page['locator']>,
  _log?: AgentRuntimeLogFn,
  _meta?: AgentRuntimeMeta,
): Promise<string> {
  // 确认按钮存在
  const count = await buttonLoc.count().catch(() => 0);
  if (count === 0) {
    throw new Error('COURIER_USE_BUTTON_NOT_FOUND: count=0');
  }

  try {
    await buttonLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  } catch {
    // visible check failed, continue with click attempt
  }

  // Strategy 1: force click
  try {
    await buttonLoc.click({ timeout: 3000, force: true });
    return 'forceClick';
  } catch (_forceErr) {
    // force click failed, fallback to mouse click
  }

  // Strategy 2: mouse click (坐标兜底)
  try {
    const box = await buttonLoc.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return 'mouseClick';
    }
  } catch (_mouseErr) {
    // mouse click failed
  }

  throw new Error('COURIER_USE_BUTTON_CLICK_FAILED: forceClick and mouseClick both failed');
}

/**
 * 添加单号"添加"按钮稳定点击
 *
 * Phase I-2: 迁入 V2 fastStableBypassClick 经验，优先 forceClick，
 * 兜底 mouseClick 坐标点击，解决 Element UI actionability 超时风险。
 */
async function clickAddButtonStable(
  page: Page,
  buttonLoc: ReturnType<Page['locator']>,
  _log?: AgentRuntimeLogFn,
  _meta?: AgentRuntimeMeta,
): Promise<string> {
  const count = await buttonLoc.count().catch(() => 0);
  if (count === 0) {
    throw new Error('WAYBILL_ADD_BUTTON_NOT_FOUND: count=0');
  }

  try {
    await buttonLoc.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  } catch {
    // continue
  }

  // Strategy 1: force click
  try {
    await buttonLoc.click({ timeout: 3000, force: true });
    return 'forceClick';
  } catch (_forceErr) {
    // force click failed, fallback
  }

  // Strategy 2: mouse click (坐标兜底)
  try {
    const box = await buttonLoc.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return 'mouseClick';
    }
  } catch (_mouseErr) {
    // mouse click failed
  }

  throw new Error('WAYBILL_ADD_BUTTON_CLICK_FAILED: forceClick and mouseClick both failed');
}

// ══════════════════════════════════════════════════════════
// Phase I-4: 读取右侧分页真实总条数
// ══════════════════════════════════════════════════════════

async function readIntegratedRightTotal(page: Page): Promise<number | null> {
  const selectors = [
    '#app .arrivalscan_right .el-pagination__total',
    '.arrivalscan_right .el-pagination__total',
    '.el-pagination__total',
  ];
  for (const sel of selectors) {
    try {
      const text = await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => '');
      if (!text) continue;
      const match = text.match(/(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (Number.isFinite(num)) return num;
      }
    } catch {
      // continue to next selector
    }
  }
  return null;
}
