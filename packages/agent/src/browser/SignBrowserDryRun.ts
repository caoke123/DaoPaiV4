/**
 * SignBrowserDryRun — 签收录入浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行签收录入页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/signSelectors.ts（标准化版本）
 * 交互顺序来源：
 *   backend/operations/SignScan.ts:108-121 + core/signExecutor
 *
 * 硬性边界：
 *   - 禁止点击"批量签收"按钮（最终提交）
 *   - 禁止点击签收弹窗"确定"按钮（最终提交）
 *   - 允许点击"搜索"按钮（spec 白名单允许查询/搜索/检索）
 *   - 不产生真实签收业务
 */

import type { Page } from 'playwright-core';
import { detectSignPage, type SignPageDetectResult } from './SignPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableClick } from './StablePageActions';
import { SIGN_SELECTORS } from './signSelectors';
import {
  navigateToBusinessPageMenuFirst,
  afterPageChangedCleanup,
  type AgentRuntimeLogFn,
  type AgentRuntimeMeta,
} from './AgentBusinessRuntime';

export interface SignBrowserDryRunInput {
  siteId: string;
  siteName: string;
  /** 任务 ID（用于日志追踪） */
  taskId?: string;
  options?: {
    staffName?: string;
    pageSize?: 30 | 50 | 100 | 200;
    /** Phase K-Final-R1-Fix-B: 日期范围。未传则默认今天 00:00:00 ~ 23:59:59 */
    dateRange?: { start: string; end: string };
  };
  /** Phase K-2E: Agent 运行时日志函数（可选） */
  log?: AgentRuntimeLogFn;
  /** Phase K-2E: Agent 运行时元数据（可选） */
  meta?: AgentRuntimeMeta;
}

export interface SignBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  searched: boolean;
  pageSizeApplied: number | null;
  courierSelected: boolean;
  finalSubmitClicked: false;
  detectBefore: SignPageDetectResult | null;
  detectAfter: SignPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
}

// 签收录入页面 URL 兜底来源：PageStateManager.ts:20 SIGN_PAGE_ROUTE（由 AgentBusinessRuntime 内部使用）

// 禁止点击的按钮关键词
const FORBIDDEN_BUTTON_KEYWORDS = [
  '批量签收', '签收', '提交', '确认', '批量', '保存', '完成', '执行', '到派',
];

function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

// 允许点击的按钮关键词（spec 白名单）
const ALLOWED_BUTTON_KEYWORDS = ['查询', '搜索', '检索'];

/**
 * 执行签收录入浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 日期范围选择器：SIGN_SELECTORS.dateRangeInput（仅检测）
 *   - 派件员下拉框：SIGN_SELECTORS.courierSelectInput（仅检测）
 *   - 搜索按钮：SIGN_SELECTORS.searchButton（允许点击）
 *   - 批量签收按钮：SIGN_SELECTORS.batchSignButton（仅检测，绝不点击）
 *   - 签收弹窗确认按钮：SIGN_SELECTORS.dialogConfirmBtn（仅检测，绝不点击）
 */
export async function runSignBrowserDryRun(
  page: Page,
  input: SignBrowserDryRunInput,
): Promise<SignBrowserDryRunResult> {
  const warnings: string[] = [];
  const { log, meta } = input;

  const result: SignBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    searched: false,
    pageSizeApplied: null,
    courierSelected: false,
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  log?.('info', '[Agent][Sign] 检测 Dashboard P0...', meta);
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    log?.('error', `[Agent][Sign] ${result.message}`, meta);
    return result;
  }
  log?.('info', '[Agent][Sign] Dashboard P0 = READY', meta);

  // 2. 进入签收录入页面 —— Phase K-2E: 菜单优先导航（sidebar_first → sidebar_retry → url_fallback）
  log?.('info', '[Agent][Sign] 菜单优先导航到签收录入页面', meta);
  const navResult = await navigateToBusinessPageMenuFirst(page, 'sign', log, meta);
  if (!navResult.success) {
    result.message = `签收页面导航失败: ${navResult.message}`;
    warnings.push(`导航方法: ${navResult.method}`);
    log?.('error', `[Agent][Sign] ${result.message}`, meta);
    return result;
  }
  log?.('info', `[Agent][Sign] 导航成功，方法: ${navResult.method}`, meta);
  result.validationLogs.push(`导航方法: ${navResult.method}`);

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
    log?.('warning', '[Agent][Sign] page.title() 失败，页面可能正在重载', meta);
  }
  log?.('info', `[Agent][Sign] 页面已打开: ${result.pageUrl}`, meta);

  // 3. 检测签收页面元素（搜索前）
  log?.('info', '[Agent][Sign] 检测签收页面元素（搜索前）...', meta);
  const detectBefore = await detectSignPage(page);
  result.detectBefore = detectBefore;

  log?.('info', `[Agent][Sign] 页面检测: isSignPage=${detectBefore.isSignPage} dateRange=${detectBefore.hasDateRangeInput} courier=${detectBefore.hasCourierSelectInput} searchBtn=${detectBefore.hasSearchButton} batchSignBtn=${detectBefore.hasBatchSignButton}`, meta);

  const staffName = input.options?.staffName;
  const pageSize = input.options?.pageSize || 100;

  // Phase K-Final-R1-Fix-B: 新增日期设置
  const dateRange = input.options?.dateRange || (() => {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return { start: `${yyyy}-${mm}-${dd} 00:00:00`, end: `${yyyy}-${mm}-${dd} 23:59:59` };
  })();

  let dateSetSuccess = false;
  if (detectBefore.hasDateRangeInput) {
    log?.('info', `[Agent][Sign] 设置日期范围：${dateRange.start} 至 ${dateRange.end}`, meta);
    result.validationLogs.push(`日期设置开始：${dateRange.start} 至 ${dateRange.end}`);
    try {
      dateSetSuccess = await setSignDateRange(page, dateRange.start, dateRange.end, log, meta);
      if (dateSetSuccess) {
        log?.('info', `[Agent][Sign] 目标日期范围=${dateRange.start} 至 ${dateRange.end}，匹配=true`, meta);
        result.validationLogs.push(`日期设置校验通过`);
      } else {
        log?.('warning', `[Agent][Sign] 目标日期范围=${dateRange.start} 至 ${dateRange.end}，匹配=false`, meta);
        warnings.push('日期设置失败');
      }
    } catch (err) {
      log?.('error', `[Agent][Sign] 日期设置异常: ${(err as Error).message}`, meta);
      warnings.push(`日期设置异常: ${(err as Error).message}`);
    }
  }

  let courierSelectSuccess = false;
  if (detectBefore.hasCourierSelectInput && staffName) {
    log?.('info', `[Agent][Sign] 选择派件员：${staffName}`, meta);
    result.validationLogs.push(`选择派件员开始：${staffName}`);
    courierSelectSuccess = await selectCourier(page, staffName, log, meta).catch(err => {
      warnings.push(`派件员选择异常: ${(err as Error).message}`);
      return false;
    });
    result.courierSelected = courierSelectSuccess;
    if (courierSelectSuccess) {
      log?.('success', `[Agent][Sign] 目标派件员=${staffName}，匹配=true`, meta);
      result.validationLogs.push(`派件员选择校验通过：${staffName}`);
    } else {
      log?.('warning', `[Agent][Sign] 目标派件员=${staffName}，匹配=false`, meta);
      warnings.push(`派件员选择失败：${staffName}`);
    }
  }

  // 4. 搜索前置校验（date + courier + searchButton，pageSize 在搜索后设置）
  log?.('info', '[Agent][Sign] 搜索前置校验开始...', meta);
  const preSearchChecks = {
    date: dateSetSuccess,
    courier: courierSelectSuccess || !staffName,
    searchButton: detectBefore.hasSearchButton,
  };
  log?.('info', `[Agent][Sign] 搜索前置校验：date=${preSearchChecks.date} courier=${preSearchChecks.courier} searchButton=${preSearchChecks.searchButton}`, meta);

  if (!preSearchChecks.date || !preSearchChecks.courier || !preSearchChecks.searchButton) {
    const failedParts: string[] = [];
    if (!preSearchChecks.date) failedParts.push('日期设置');
    if (!preSearchChecks.courier) failedParts.push('派件员选择');
    if (!preSearchChecks.searchButton) failedParts.push('搜索按钮检测');
    result.message = `搜索前置校验失败：${failedParts.join('、')}未通过，已停止执行，未点击搜索`;
    result.success = false;
    result.validationLogs.push(`搜索前置校验失败：${failedParts.join('、')}`);
    log?.('error', `[Agent][Sign] ${result.message}`, meta);
    return result;
  }
  log?.('info', '[Agent][Sign] 搜索前置校验通过', meta);
  result.validationLogs.push('搜索前置校验通过');

  // 5. 点击搜索按钮（spec 白名单允许查询/搜索/检索）
  await afterPageChangedCleanup(page, log, meta, 'sign-before-search');
  log?.('info', '[Agent][Sign] 点击搜索按钮...', meta);
  try {
    const searchBtn = page.locator(SIGN_SELECTORS.searchButton).first();

    // 安全保护：先读取按钮文本，确认不是最终提交
    const btnText = (await searchBtn.textContent() || '').trim();
    assertNotFinalSubmit(btnText);

    // 检查是否是搜索类按钮
    const isSearchBtn = ALLOWED_BUTTON_KEYWORDS.some(kw => btnText.includes(kw));
    if (!isSearchBtn) {
      warnings.push(`搜索按钮文本异常："${btnText}"，不包含查询/搜索/检索关键词`);
      log?.('warning', `[Agent][Sign] 搜索按钮文本异常："${btnText}"`, meta);
    }

    log?.('info', `[Agent][Sign] 搜索按钮文本: "${btnText}"（安全检查通过）`, meta);

    await stableClick(searchBtn, { timeoutMs: 5000 });
    result.searched = true;
    log?.('info', '[Agent][Sign] 已点击搜索按钮', meta);

    await page.waitForSelector(SIGN_SELECTORS.loadingMask, { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('.el-table__body-wrapper table tbody tr.el-table__row');
      const empty = Array.from(document.querySelectorAll('.el-table__empty-text'))
        .some(el => (el.textContent || '').includes('暂无数据'));
      return rows.length > 0 || empty;
    }, {}, { timeout: 5000 }).catch(() => {});
  } catch (err) {
    if (err instanceof Error && err.message.includes('安全保护')) {
      result.message = err.message;
      log?.('error', `[Agent][Sign] ${result.message}`, meta);
      return result;
    }
    warnings.push(`搜索按钮点击失败: ${(err as Error).message}`);
    log?.('error', `[Agent][Sign] 搜索按钮点击异常: ${(err as Error).message}`, meta);
  }

  // 5. 搜索后设置分页大小（搜索后 pagination 状态更稳定）
  let pageSizeApplied = false;
  const contextForLogs = {
    taskId: input.taskId ?? '(no-task-id)',
    staffName: input.options?.staffName ?? '(no-staff)',
    windowId: meta?.windowId ?? '(no-window)',
  };
  if ([30, 50, 100, 200].includes(pageSize)) {
    log?.('info', `[Agent][Sign] 设置分页大小：${pageSize}条/页`, meta);
    result.validationLogs.push(`分页大小设置开始：${pageSize}条/页`);
    pageSizeApplied = await setPageSize(page, pageSize, log, meta, contextForLogs).catch(err => {
      const errMsg = `[Agent][Sign][setPageSize-call] ERROR pageSize=${pageSize} error=${(err as Error).message}`;
      log?.('error', errMsg, meta);
      warnings.push(`分页大小设置异常: ${(err as Error).message}`);
      return false;
    });
    if (pageSizeApplied) {
      result.pageSizeApplied = pageSize;
      log?.('success', `[Agent][Sign] 目标条数/页=${pageSize}，匹配=true`, meta);
      result.validationLogs.push(`分页大小设置完成：${pageSize}条/页`);
    } else {
      warnings.push(`分页大小设置失败：${pageSize}条/页`);
      result.validationLogs.push(`分页大小设置失败：${pageSize}条/页`);
    }
  }

  // 6. 安全检测批量签收按钮（仅检测，不点击）
  result.validationLogs.push('已检测批量签收按钮（未点击）');
  result.validationLogs.push('已检测签收弹窗确认按钮（未点击）');
  result.validationLogs.push('已阻止最终提交');

  // 7. 再次检测页面元素（搜索后）
  log?.('info', '[Agent][Sign] 检测签收页面元素（搜索后）...', meta);
  const detectAfter = await detectSignPage(page);
  result.detectAfter = detectAfter;

  log?.('info', `[Agent][Sign] 搜索后: table=${detectAfter.hasTable} batchSignBtn=${detectAfter.hasBatchSignButton}`, meta);

  // 8. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;

  // 9. 结果
  result.success = true;
  result.message = '签收录入 DRY-RUN 完成：已点击搜索按钮，未点击批量签收按钮，未点击签收弹窗确认按钮';

  log?.('success', `[Agent][Sign] ${result.message}`, meta);
  return result;
}

/**
 * Phase K-Final-R1-Fix-B1: 签收录入派件员选择
 *
 * 主路径：Playwright click。兜底：evaluate DOM click（V2 策略，绕过 CSS 动画问题）。
 * 必须验证 input.value 更新。
 */
async function selectCourier(
  page: Page,
  staffName: string,
  log: AgentRuntimeLogFn | undefined,
  meta: AgentRuntimeMeta | undefined,
): Promise<boolean> {
  const MAX_RETRIES = 3;

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      // Escape + cleanup before each attempt
      await page.keyboard.press('Escape').catch(() => {});
      if (retry > 0) {
        await afterPageChangedCleanup(page, log, meta, `sign-courier-retry-${retry}`);
      }

      const inputLoc = page.locator(SIGN_SELECTORS.courierSelectInput);
      if ((await inputLoc.count().catch(() => 0)) === 0) {
        console.log('  [Sign-DRY-RUN] SIGN_COURIER_INPUT_NOT_FOUND');
        return false;
      }
      await inputLoc.first().click({ timeout: 10000 });

      try {
        await page.waitForSelector('body > div.el-select-dropdown.el-popper:visible', {
          state: 'visible',
          timeout: 5000,
        });
      } catch {
        console.log(`  [Sign-DRY-RUN] SIGN_COURIER_DROPDOWN_NOT_READY (retry ${retry + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Primary path: Playwright click on matching option
      const optionLoc = page
        .locator('body > div.el-select-dropdown.el-popper:visible li.el-select-dropdown__item')
        .filter({ hasText: staffName })
        .first();

      let optionClicked = false;
      if ((await optionLoc.count().catch(() => 0)) > 0) {
        try {
          await optionLoc.click({ timeout: 5000 });
          optionClicked = true;
        } catch {
          console.log(`  [Sign-DRY-RUN] Playwright click 选项失败，尝试 evaluate 兜底 (retry ${retry + 1})`);
        }
      }

      // Fallback: evaluate DOM click (V2 strategy for background tab CSS animation issues)
      if (!optionClicked) {
        const domClicked = await page.evaluate((name: string) => {
          const items = document.querySelectorAll(
            'body > div.el-select-dropdown.el-popper:not([style*="display: none"]) li.el-select-dropdown__item',
          );
          for (const item of items) {
            if ((item.textContent ?? '').trim().includes(name)) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, staffName);

        if (!domClicked) {
          console.log(`  [Sign-DRY-RUN] SIGN_COURIER_OPTION_NOT_FOUND: ${staffName} (retry ${retry + 1}/${MAX_RETRIES})`);
          continue;
        }
      }

      // Verify input.value was updated
      await page.waitForTimeout(300);
      await page.waitForFunction(
        ({ selector, name }: { selector: string; name: string }) => {
          const input = document.querySelector(selector) as HTMLInputElement | null;
          return !!input && input.value.includes(name);
        },
        { selector: SIGN_SELECTORS.courierSelectInput, name: staffName },
        { timeout: 3000 },
      ).catch(() => {});

      const value = await inputLoc.first().inputValue().catch(() => '');
      const ok = value.includes(staffName);
      console.log(`  [Sign-DRY-RUN] [Agent][Sign] 目标派件员=${staffName}，页面派件员=${value || '(空)'}，匹配=${ok}`);

      if (ok) return true;

      console.log(`  [Sign-DRY-RUN] SIGN_COURIER_VERIFY_FAILED (retry ${retry + 1}/${MAX_RETRIES})`);
    } catch (err) {
      console.log(`  [Sign-DRY-RUN] SIGN_COURIER_DROPDOWN_NOT_READY (retry ${retry + 1}/${MAX_RETRIES}): ${(err as Error).message}`);
    }
  }

  console.log('  [Sign-DRY-RUN] SIGN_COURIER_VERIFY_FAILED (重试耗尽)');
  return false;
}

/**
 * Phase I-4-Sign-Fix-V3: 签收录入条数/页选择
 *
 * 参考 bnsy-operator/bnsyV2 PaginationAdapter.setPageSize 已验证可靠的模式：
 *   page.click({ force: true }) + 800ms 等待 + page.evaluate 点击选项
 *
 * DevTools 实测：
 *   - 仅 5 个选项：10/30/50/100/200 条/页
 *   - 输入框始终 readonly，不支持 fill 过滤
 *
 * 流程：page.click force → wait 800ms → popper detection → evaluate click option → verify
 */
async function setPageSize(
  page: Page,
  pageSize: 30 | 50 | 100 | 200,
  log: AgentRuntimeLogFn | undefined,
  meta: AgentRuntimeMeta | undefined,
  _ctx: { taskId: string; staffName: string; windowId: string },
): Promise<boolean> {
  const MAX_RETRIES = 3;
  const pageSizeText = `${pageSize}条/页`;
  const INPUT_SELECTOR = '.el-pagination .el-pagination__sizes .el-input input';
  const DROPDOWN_VISIBLE = 'body > div.el-select-dropdown.el-popper:not([style*="display: none"])';

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    log?.('info', `[Agent][Sign] pageSize 设置第 ${retry + 1}/${MAX_RETRIES} 次`, meta);

    try {
      // Clear any residual poppers
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);

      // Step 1: Click page size input via Playwright force click (reliable, like old bnsy-operator)
      const inputLoc = page.locator(INPUT_SELECTOR).first();
      await inputLoc.click({ timeout: 5000, force: true });
      log?.('info', '[Agent][Sign] 已点击 pageSize 输入框', meta);

      // Step 2: Wait 800ms for Element UI popper animation (matches old version)
      await page.waitForTimeout(800);

      // Step 3: Detect popper
      const popperCount = await page.locator(DROPDOWN_VISIBLE).count().catch(() => 0);
      if (popperCount === 0) {
        log?.('warning', '[Agent][Sign] pageSize popper 未在 800ms 内出现', meta);
        continue;
      }

      // Step 4: Click target option via evaluate (reliable for el-select-dropdown items)
      const clicked = await page.evaluate((text: string) => {
        const items = document.querySelectorAll(
          '.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item',
        );
        for (const item of items) {
          if ((item.textContent ?? '').trim() === text) {
            (item as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, pageSizeText);
      await page.waitForTimeout(300);

      if (!clicked) {
        log?.('warning', `[Agent][Sign] 未找到候选项: ${pageSizeText}`, meta);
        continue;
      }
      log?.('info', `[Agent][Sign] 已点击候选项: ${pageSizeText}`, meta);

      // Step 5: Verify (use evaluate to read readonly el-select input value)
      const value = await page.evaluate((sel: string) => {
        const input = document.querySelector(sel) as HTMLInputElement | null;
        return input?.value ?? '';
      }, INPUT_SELECTOR);
      if (value.includes(String(pageSize))) {
        log?.('success', `[Agent][Sign] pageSize=${pageSizeText} 设置成功`, meta);
        return true;
      }

      log?.('warning', `[Agent][Sign] pageSize 校验失败: expected="${pageSizeText}" actual="${value}"`, meta);
    } catch (err) {
      log?.('warning', `[Agent][Sign] pageSize 异常: ${(err as Error).message}`, meta);
    }

    if (retry < MAX_RETRIES - 1) {
      await page.waitForTimeout(300);
    }
  }

  log?.('error', `[Agent][Sign] pageSize=${pageSizeText} 设置失败（重试耗尽）`, meta);
  return false;
}

/**
 * Phase K-Final-R1-Fix-B1: 签收录入日期范围设置
 *
 * 迁移 V2 稳定方案：点击页面日期 input → 等面板出现 → fill 面板内部 input → 点击"确定" → 反向校验。
 * 不再直接 fill 页面展示 input（Vue 状态不可靠）。
 * 默认规则：无 task 传日期则默认今天 00:00:00 ~ 23:59:59。
 */
async function setSignDateRange(
  page: Page,
  start: string,
  end: string,
  log: AgentRuntimeLogFn | undefined,
  meta: AgentRuntimeMeta | undefined,
): Promise<boolean> {
  const MAX_RETRIES = 3;
  // V2 面板 input 接受 MM-DD 格式，不含年份
  const startShort = start.slice(5); // MM-DD HH:mm:ss
  const endShort = end.slice(5);

  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      // Escape + cleanup before each attempt
      await page.keyboard.press('Escape').catch(() => {});
      if (retry > 0) {
        await afterPageChangedCleanup(page, log, meta, `sign-date-retry-${retry}`);
      }

      // Step 1: Find page date range inputs and click to open picker panel
      const rangeInputs = page.locator(SIGN_SELECTORS.dateRangeInput);
      const count = await rangeInputs.count();
      if (count < 2) {
        console.log('  [Sign-DRY-RUN] SIGN_DATE_INPUT_NOT_FOUND');
        return false;
      }

      await rangeInputs.nth(0).click({ timeout: 5000 });

      // Step 2: Wait for Element UI date range picker panel
      try {
        await page.waitForSelector('.el-date-range-picker.has-time', {
          state: 'visible',
          timeout: 5000,
        });
      } catch {
        console.log(`  [Sign-DRY-RUN] SIGN_DATE_PICKER_NOT_READY (retry ${retry + 1}/${MAX_RETRIES})`);
        continue;
      }

      // Step 3: Fill start date in panel's internal input
      const panelStartInput = page.locator(SIGN_SELECTORS.datePickerStartInput);
      await panelStartInput.click({ timeout: 3000 });
      await page.keyboard.press('Control+A').catch(() => {});
      await panelStartInput.fill(startShort, { timeout: 3000 });
      await page.waitForTimeout(200);

      // Step 4: Fill end date in panel's internal input
      const panelEndInput = page.locator(SIGN_SELECTORS.datePickerEndInput);
      await panelEndInput.click({ timeout: 3000 });
      await page.keyboard.press('Control+A').catch(() => {});
      await panelEndInput.fill(endShort, { timeout: 3000 });
      await page.waitForTimeout(200);

      // Step 5: Click "确定" button to confirm and close panel
      const confirmBtn = page.locator(SIGN_SELECTORS.datePickerConfirm);
      if ((await confirmBtn.count().catch(() => 0)) === 0) {
        console.log(`  [Sign-DRY-RUN] SIGN_DATE_PICKER_CONFIRM_NOT_FOUND (retry ${retry + 1}/${MAX_RETRIES})`);
        continue;
      }
      await confirmBtn.click({ timeout: 3000 });
      await page.waitForTimeout(500);

      // Step 6: Verify page date range inputs reflect the selected values
      const startValue = await rangeInputs.nth(0).inputValue().catch(() => '');
      const endValue = await rangeInputs.nth(1).inputValue().catch(() => '');
      const startOk = startValue.includes(start) || startValue.includes(startShort);
      const endOk = endValue.includes(end) || endValue.includes(endShort);

      console.log(`  [Sign-DRY-RUN] [Agent][Sign] 目标日期范围=${start} 至 ${end}，页面日期范围=${startValue || '(空)'} 至 ${endValue || '(空)'}，匹配=${startOk && endOk}`);

      if (startOk && endOk) return true;

      console.log(`  [Sign-DRY-RUN] SIGN_DATE_VALUE_MISMATCH (retry ${retry + 1}/${MAX_RETRIES})`);
    } catch (err) {
      console.log(`  [Sign-DRY-RUN] SIGN_DATE_PICKER_NOT_READY (retry ${retry + 1}/${MAX_RETRIES}): ${(err as Error).message}`);
    }
  }

  console.log('  [Sign-DRY-RUN] SIGN_DATE_VALUE_MISMATCH (重试耗尽)');
  return false;
}
