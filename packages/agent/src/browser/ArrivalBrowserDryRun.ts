/**
 * ArrivalBrowserDryRun — 到件扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-D: 在笨鸟系统中执行到件扫描页面级 DRY-RUN。
 * Phase 5-E-1: 严格按旧执行流程代码的选择器，禁止猜测。
 *
 * 选择器来源：
 *   backend/operations/selectors/arrivalScanBatch.selectors.ts
 * 交互顺序来源：
 *   backend/operations/ArriveScanBatch.ts:178-225 (Step 7 上一站 + Step 8 查询)
 *
 * 硬性边界：
 *   - 禁止点击最终提交按钮（批量到件/确认到件/提交）
 *   - 只能点击查询/搜索类按钮
 *   - 不产生真实到件业务
 *   - 不处理真实生产单号
 */

import type { Page } from 'playwright-core';
import { detectArrivalPage, type ArrivalPageDetectResult } from './ArrivalPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableFillTextarea, verifyInputValue, stableClick } from './StablePageActions';
import {
  ARRIVAL_BATCH_SELECTORS,
  DEFAULT_PREV_STATION,
} from './arrivalSelectors';
import {
  navigateToBusinessPageMenuFirst,
  afterPageChangedCleanup,
  type AgentRuntimeLogFn,
  type AgentRuntimeMeta,
} from './AgentBusinessRuntime';

export interface ArrivalBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    prevStation?: string;
    batchSize?: number;
  };
  /** Phase K-2E: Agent 运行时日志函数（可选） */
  log?: AgentRuntimeLogFn;
  /** Phase K-2E: Agent 运行时元数据（可选） */
  meta?: AgentRuntimeMeta;
}

export interface ArrivalBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  queried: boolean;
  finalSubmitClicked: false;
  detectBefore: ArrivalPageDetectResult | null;
  detectAfter: ArrivalPageDetectResult | null;
  message: string;
  warnings: string[];
  /** Phase 5-E-1: 校验日志（供 Agent 上传） */
  validationLogs: string[];
}

// 到件扫描页面 URL 兜底来源：PageStateManager.ts:18 ARRIVAL_PAGE_ROUTE（由 AgentBusinessRuntime 内部使用）

// 禁止点击的按钮关键词（用于 assertNotFinalSubmit 安全保护）
const FORBIDDEN_BUTTON_KEYWORDS = [
  '批量到件', '确认到件', '提交到件', '提交', '保存', '完成',
];

/**
 * 硬性保护：检查按钮文本是否是最终提交按钮
 * 来源：项目硬性约束（memory_item）
 * 如果疑似最终提交，直接抛错并停止
 */
function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

/**
 * 执行到件扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 运单 textarea：ARRIVAL_BATCH_SELECTORS.waybillTextarea
 *   - 上一站：ARRIVAL_BATCH_SELECTORS.prevStationInput + prevStationOption（el-select 下拉）
 *   - 查询按钮：ARRIVAL_BATCH_SELECTORS.queryBtn
 *   - 最终提交按钮：ARRIVAL_BATCH_SELECTORS.submitBatchBtn（仅检测，绝不点击）
 */
export async function runArrivalBrowserDryRun(
  page: Page,
  input: ArrivalBrowserDryRunInput,
): Promise<ArrivalBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options, log, meta } = input;
  const prevStation = options?.prevStation || DEFAULT_PREV_STATION;

  const result: ArrivalBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    queried: false,
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  log?.('info', '[Agent][Arrival] 检测 Dashboard P0...', meta);
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    log?.('error', `[Agent][Arrival] ${result.message}`, meta);
    return result;
  }
  log?.('info', '[Agent][Arrival] Dashboard P0 = READY', meta);

  // 2. 进入到件扫描页面 —— Phase K-2E: 菜单优先导航（sidebar_first → sidebar_retry → url_fallback）
  log?.('info', '[Agent][Arrival] 菜单优先导航到到件扫描页面', meta);
  const navResult = await navigateToBusinessPageMenuFirst(page, 'arrival', log, meta);
  if (!navResult.success) {
    result.message = `到件页面导航失败: ${navResult.message}`;
    warnings.push(`导航方法: ${navResult.method}`);
    log?.('error', `[Agent][Arrival] ${result.message}`, meta);
    return result;
  }
  log?.('info', `[Agent][Arrival] 导航成功，方法: ${navResult.method}`, meta);
  result.validationLogs.push(`导航方法: ${navResult.method}`);

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
    log?.('warning', '[Agent][Arrival] page.title() 失败，页面可能正在重载', meta);
  }
  log?.('info', `[Agent][Arrival] 页面已打开: ${result.pageUrl}`, meta);

  // 3. 检测到件页面元素（查询前）
  log?.('info', '[Agent][Arrival] 检测到件页面元素（查询前）...', meta);
  const detectBefore = await detectArrivalPage(page);
  result.detectBefore = detectBefore;

  log?.('info', `[Agent][Arrival] 页面检测: isArrivalPage=${detectBefore.isArrivalPage} waybillInput=${detectBefore.hasWaybillInput} prevStation=${detectBefore.hasPrevStationInput} queryBtn=${detectBefore.hasSearchButton} table=${detectBefore.hasTable}`, meta);

  if (!detectBefore.isArrivalPage) {
    warnings.push('当前页面不是到件扫描页面');
  }
  if (!detectBefore.hasWaybillInput) {
    warnings.push('未检测到运单输入框');
  }
  if (!detectBefore.hasSearchButton) {
    warnings.push('未检测到查询按钮');
  }

  // ────────────────────────────────────────────────────────────
  // 4. 稳定填写上一站（优先于运单输入）
  //    选择器来源：
  //      - prevStationInput: arrivalScanBatch.selectors.ts:46-47
  //      - getPrevStationOption(text): arrivalScanBatch.selectors.ts (动态)
  //    交互顺序来源：ArriveScanBatch.ts:178-200 (Step 7)
  //    Phase I-4-Arrival-Fix: 接入 log/meta + 动态选择器 + 遍历候选项点击
  // ────────────────────────────────────────────────────────────
  let prevStationSuccess = false;
  if (detectBefore.hasPrevStationInput && prevStation) {
    log?.('info', `[Agent][Arrival] 上一站填写开始: ${prevStation}`, meta);
    result.validationLogs.push(`上一站填写开始：${prevStation}`);
    try {
      prevStationSuccess = await stableFillPrevStation(page, prevStation, log, meta);
      if (prevStationSuccess) {
        log?.('success', `[Agent][Arrival] 目标上一站=${prevStation}，匹配=true`, meta);
        result.validationLogs.push(`上一站填写校验通过：${prevStation}`);
      } else {
        log?.('warning', `[Agent][Arrival] 目标上一站=${prevStation}，匹配=false`, meta);
      }
    } catch (err) {
      log?.('error', `[Agent][Arrival] 上一站填写异常: ${(err as Error).message}`, meta);
    }

    if (!prevStationSuccess) {
      warnings.push(`上一站填写失败：未确认选中"${prevStation}"`);
      // 上一站失败：不填单号，不查询，直接返回
      result.message = `上一站填写失败：未确认选中"${prevStation}"，已停止执行`;
      result.success = false;
      result.validationLogs.push(`上一站填写失败，已停止执行，未点击查询`);
      log?.('error', `[Agent][Arrival] ${result.message}`, meta);
      return result;
    }
  }

  // ────────────────────────────────────────────────────────────
  // 5. 稳定输入测试运单（上一站校验通过后才执行）
  //    选择器来源：arrivalScanBatch.selectors.ts:42-43 waybillTextarea
  //    旧代码使用位置：ArriveScanBatch.ts:158, 162-176
  // ────────────────────────────────────────────────────────────
  let waybillInputSuccess = false;
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    // 数量上限校验
    if (waybills.length > 200) {
      result.message = `运单数量超过上限：${waybills.length} > 200，拒绝执行`;
      result.success = false;
      result.validationLogs.push(result.message);
      warnings.push(result.message);
      log?.('error', `[Agent][Arrival] ${result.message}`, meta);
      return result;
    }

    log?.('info', `[Agent][Arrival] 稳定输入测试运单 (${waybills.length} 条)...`, meta);
    try {
      const textareaLocator = page.locator(ARRIVAL_BATCH_SELECTORS.waybillTextarea).first();
      if (await textareaLocator.isVisible({ timeout: 5000 })) {
        await stableFillTextarea(textareaLocator, waybills.join('\n'), { maxRetries: 3 });
        result.inputCount = waybills.length;

        // 行数反验：textarea.value 拆分行数 === waybills.length
        const actualLines = await textareaLocator.inputValue().then(v =>
          v.split('\n').filter(line => line.trim().length > 0).length
        ).catch(() => 0);
        if (actualLines !== waybills.length) {
          log?.('warning', `[Agent][Arrival] 任务单号数=${waybills.length}，textarea实际行数=${actualLines}`, meta);
          warnings.push(`运单行数不匹配：预期${waybills.length}行，实际${actualLines}行`);
          result.message = `运单行数校验失败：预期${waybills.length}行，实际${actualLines}行`;
          result.success = false;
          return result;
        }
        waybillInputSuccess = true;
        log?.('info', `[Agent][Arrival] 运单输入校验通过: ${waybills.length} 条`, meta);
        result.validationLogs.push(`运单输入校验通过：${waybills.length} 条`);
      } else {
        warnings.push('运单输入框不可见');
        log?.('warning', '[Agent][Arrival] 运单输入校验失败：textarea 不可见', meta);
      }
    } catch (err) {
      warnings.push(`运单输入失败: ${(err as Error).message}`);
      log?.('error', `[Agent][Arrival] 运单输入异常: ${(err as Error).message}`, meta);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 6. 查询前置校验：必须全部通过才能点击查询
  // ────────────────────────────────────────────────────────────
  log?.('info', '[Agent][Arrival] 查询前置校验开始...', meta);
  const preQueryChecks = {
    prevStation: prevStationSuccess,
    waybill: waybillInputSuccess,
    searchButton: detectBefore.hasSearchButton,
  };
  log?.('info', `[Agent][Arrival] 校验结果：上一站=${preQueryChecks.prevStation}，运单=${preQueryChecks.waybill}，查询按钮=${preQueryChecks.searchButton}`, meta);

  if (!preQueryChecks.prevStation || !preQueryChecks.waybill || !preQueryChecks.searchButton) {
    const failedParts: string[] = [];
    if (!preQueryChecks.prevStation) failedParts.push('上一站填写');
    if (!preQueryChecks.waybill) failedParts.push('运单输入');
    if (!preQueryChecks.searchButton) failedParts.push('查询按钮检测');
    result.message = `查询前置校验失败：${failedParts.join('、')}未通过，已停止执行，未点击查询`;
    result.success = false;
    result.validationLogs.push(`查询前置校验失败，已停止执行，未点击查询`);
    log?.('error', `[Agent][Arrival] ${result.message}`, meta);
    return result;
  }
  log?.('info', '[Agent][Arrival] 查询前置校验通过', meta);
  result.validationLogs.push('查询前置校验通过');

  // ────────────────────────────────────────────────────────────
  // 7. 点击查询按钮
  //    安全保护：点击前再次 assertNotFinalSubmit
  // ────────────────────────────────────────────────────────────
  await afterPageChangedCleanup(page, log, meta, 'arrival-before-query');
  log?.('info', '[Agent][Arrival] 点击查询按钮...', meta);
  try {
    const queryBtn = page.locator(ARRIVAL_BATCH_SELECTORS.queryBtn).first();

    // 安全保护：先读取按钮文本，确认不是最终提交
    const btnText = (await queryBtn.textContent() || '').trim();
    assertNotFinalSubmit(btnText);
    log?.('info', `[Agent][Arrival] 查询按钮文本: "${btnText}"（安全检查通过）`, meta);

    // 等待可见并点击
    await stableClick(queryBtn, { timeoutMs: 5000 });
    result.queried = true;
    log?.('info', '[Agent][Arrival] 已点击查询按钮', meta);

    // 等待查询结果（旧代码 ArriveScanBatch.ts:207 waitForTimeout(3000)）
    await page.waitForTimeout(3000);

    // 旧代码 ArriveScanBatch.ts:211 等待表格行可见
    try {
      await page.waitForSelector('.el-table__body-wrapper .el-table__row', {
        timeout: 8000,
        state: 'visible',
      });
      log?.('info', '[Agent][Arrival] 查询结果表格行已加载', meta);
    } catch {
      warnings.push('查询后表格行未加载（可能运单号是测试号，无数据属正常）');
      log?.('warning', '[Agent][Arrival] 查询结果表格行未加载（测试运单号无数据，属正常）', meta);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('安全保护')) {
      result.message = err.message;
      log?.('error', `[Agent][Arrival] ${result.message}`, meta);
      return result;
    }
    warnings.push(`查询按钮点击失败: ${(err as Error).message}`);
    log?.('error', `[Agent][Arrival] 查询按钮点击异常: ${(err as Error).message}`, meta);
  }

  // 8. 再次检测到件页面元素（查询后）
  log?.('info', '[Agent][Arrival] 检测到件页面元素（查询后）...', meta);
  const detectAfter = await detectArrivalPage(page);
  result.detectAfter = detectAfter;

  log?.('info', `[Agent][Arrival] 查询后: table=${detectAfter.hasTable} submitBtn=${detectAfter.hasFinalSubmitButton}`, meta);

  // 9. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.validationLogs.push('已阻止最终提交');

  // 10. 结果
  result.success = true;
  result.message = 'DRY-RUN 完成：已输入运单并点击查询，未点击最终提交按钮';

  log?.('success', `[Agent][Arrival] ${result.message}`, meta);
  return result;
}

// ══════════════════════════════════════════════════════════
// 稳定填写上一站
//
// 严格遵循旧代码 ArriveScanBatch.ts:178-200 (Step 7) 的交互顺序：
//   1. page.click(ARRIVAL_BATCH_SELECTORS.prevStationInput, { timeout: 10000 })
//   2. page.waitForTimeout(800)
//   3. prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption)
//   4. if (count > 0) { prevOptionLoc.first().click(); waitForTimeout(500); }
//   5. else { fill(prevStationInput, prevStation); keyboard.press('Enter'); }
//
// 选择器来源：
//   - prevStationInput: arrivalScanBatch.selectors.ts:46-47
//   - prevStationOption: arrivalScanBatch.selectors.ts:49-50
// ══════════════════════════════════════════════════════════

/**
 * 稳定填写上一站
 *
 * Phase I-4-Arrival-Fix:
 *   - 接入 log/meta 参数，关键步骤输出 task_logs
 *   - 点击 input → fill(prevStation) → Element UI 自动过滤 → 点击候选项
 *   - DevTools 实测：3295 条候选项，fill 后 <1 秒过滤为 1 条
 *
 * @returns true=成功，false=失败
 */
async function stableFillPrevStation(
  page: Page,
  prevStation: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  const MAX_RETRIES = 3;
  const DROPDOWN_VISIBLE = 'body > div.el-select-dropdown.el-popper:not([style*="display: none"])';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log?.('info', `[Agent][Arrival] 上一站填写第 ${attempt}/${MAX_RETRIES} 次尝试`, meta);

    try {
      // Cleanup residual poppers from previous attempts (matches Sign/bnsy-operator pattern)
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);

      // Step 1: Click input with force:true to open popper
      //   force:true bypasses actionability checks (readonly input + background tab CDP mode)
      //   This is the proven pattern from Sign setPageSize and bnsy-operator
      const prevInput = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput).first();
      await prevInput.waitFor({ state: 'visible', timeout: 10_000 });
      await prevInput.click({ timeout: 5000, force: true });

      // Step 2: Wait 800ms for Element UI el-zoom-in-top animation to complete
      //   (matches Sign setPageSize / bnsy-operator PaginationAdapter / bnsyV2 IntegratedScan)
      await page.waitForTimeout(800);

      // Step 3: Check popper appeared (use count() instead of waitForSelector for faster feedback)
      const popperCount = await page.locator(DROPDOWN_VISIBLE).count().catch(() => 0);
      if (popperCount === 0) {
        log?.('warning', '[Agent][Arrival] 上一站 popper 未在 800ms 内出现', meta);
        continue;
      }

      // Step 4: Type prevStation to trigger Element UI internal filter
      //   DevTools confirmed: 3295 items → 1 visible item in <1s
      await prevInput.fill(prevStation, { timeout: 5000 });
      log?.('info', `[Agent][Arrival] 已输入上一站: ${prevStation}`, meta);
      await page.waitForTimeout(300);

      // Step 5: Click option via page.evaluate DOM click
      //   Element UI dropdown items in background tabs have CSS animation issues
      //   (height=0, opacity=0, viewport offset). page.evaluate bypasses all checks.
      //   Matches Sign setPageSize / bnsy-operator / bnsyV2 proven pattern.
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
      }, prevStation);

      if (!clicked) {
        log?.('warning', `[Agent][Arrival] 候选项"${prevStation}"未在过滤后出现`, meta);
        continue;
      }

      await page.waitForTimeout(500);
      log?.('info', `[Agent][Arrival] 已点击候选项: ${prevStation}`, meta);

      // Step 6: Verify selection
      const verified = await verifyPrevStationSelected(page, prevStation, log, meta);
      if (verified) {
        log?.('success', `[Agent][Arrival] 目标上一站=${prevStation}，页面上一站已验证`, meta);
        return true;
      }

      // Verification failed: retry
      log?.('warning', `[Agent][Arrival] 上一站校验失败（第 ${attempt} 次），准备重试`, meta);
    } catch (err) {
      log?.('warning', `[Agent][Arrival] 上一站填写第 ${attempt} 次异常: ${(err as Error).message}`, meta);
    }

    if (attempt < MAX_RETRIES) {
      await page.waitForTimeout(500);
    }
  }

  log?.('error', `[Agent][Arrival] 上一站填写 ${MAX_RETRIES} 次尝试全部失败`, meta);
  return false;
}

/**
 * 校验上一站是否成功选中
 *
 * Element el-select 选中后，可能有多重表现：
 *   1. input.value 直接为选中文本（普通模式）
 *   2. input.value 为空，但显示 el-tag（多选/远程模式）
 *   3. .el-select__input 或 .el-input__inner 持有选中值（filterable/动态模式）
 *
 * Phase I-4-Arrival-Fix: 增强 DOM 搜索策略，覆盖所有 el-select 选中态路径。
 *   接入 log/meta 参数，校验结果写入 task_logs。
 */
async function verifyPrevStationSelected(
  page: Page,
  prevStation: string,
  log?: AgentRuntimeLogFn,
  meta?: AgentRuntimeMeta,
): Promise<boolean> {
  try {
    // Strategy 1: Read input.value directly
    const inputValue = await page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput).first()
      .inputValue().catch(() => '');
    if (inputValue.includes(prevStation)) {
      log?.('info', `[Agent][Arrival] 上一站 input.value 校验通过: "${inputValue}"`, meta);
      return true;
    }

    // Strategy 2: Flexible DOM search via page.evaluate
    const found = await page.evaluate((search: string) => {
      // Search entire el-select subtree for the target text
      const wrappers = document.querySelectorAll(
        '#app .el-select, ' +
        '#app .el-input.el-input--medium.el-input--suffix'
      );
      for (const wrapper of wrappers) {
        // Check .el-tag / .el-tag__content (multi-select mode)
        const tags = wrapper.querySelectorAll('.el-tag, .el-tag__content');
        for (const tag of tags) {
          if ((tag.textContent || '').trim().includes(search)) return true;
        }
        // Check .el-select__input (filterable mode)
        const innerInput = wrapper.querySelector('.el-select__input') as HTMLInputElement | null;
        if (innerInput?.value?.includes(search)) return true;
        // Check .el-input__inner (standard mode)
        const standardInput = wrapper.querySelector('.el-input__inner') as HTMLInputElement | null;
        if (standardInput?.value?.includes(search)) return true;
        // Check .el-select__tags-text
        const tagsTexts = wrapper.querySelectorAll('.el-select__tags-text');
        for (const t of tagsTexts) {
          if ((t.textContent || '').trim().includes(search)) return true;
        }
      }
      // Fallback: search trigger area visible text
      const triggerAreas = document.querySelectorAll(
        '#app .el-select .el-input__suffix, ' +
        '#app .el-select .el-input__prefix'
      );
      for (const area of triggerAreas) {
        if ((area.textContent || '').trim().includes(search)) return true;
      }
      return false;
    }, prevStation).catch(() => false);

    if (found) {
      log?.('info', `[Agent][Arrival] 上一站 DOM 文本校验通过: "${prevStation}"`, meta);
      return true;
    }

    // Strategy 3: Failed
    log?.('warning', `[Agent][Arrival] 上一站校验失败：input="${inputValue.substring(0, 50)}"`, meta);
    return false;
  } catch (err) {
    log?.('warning', `[Agent][Arrival] 上一站校验异常: ${(err as Error).message}`, meta);
    return false;
  }
}
