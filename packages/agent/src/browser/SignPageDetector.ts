/**
 * SignPageDetector — 签收录入页面检测
 *
 * Phase 5-F: 检测签收录入页面核心 DOM 元素。
 *
 * 选择器来源：
 *   backend/operations/selectors/signSelectors.ts（标准化版本）
 *
 * 只检测，不操作。不点击任何按钮，尤其是"批量签收"和"确定"提交按钮。
 */

import type { Page } from 'playwright-core';
import { SIGN_SELECTORS, SIGN_PAGE_ROUTE } from './signSelectors';

export interface SignPageDetectResult {
  url: string;
  title: string;
  isSignPage: boolean;
  hasDateRangeInput: boolean;
  hasCourierSelectInput: boolean;
  hasSearchButton: boolean;
  hasTable: boolean;
  hasBatchSignButton: boolean;
  hasSignDialog: boolean;
  matchedSelectors: string[];
  batchSignButtonSelectors: string[];
  warnings: string[];
}

// 签收录入页面 URL 路径（来源：PageStateManager.ts:20）
const SIGN_URL_PATTERNS = [
  SIGN_PAGE_ROUTE,
  '/scanning/signFor/signForInput',
  'signForInput',
];

// 签收页面关键词
const SIGN_PAGE_KEYWORDS = [
  '签收录入', '签收', '批量签收', '派件员', '签收人',
];

// 结果表格选择器（来源：signSelectors.ts:65）
const TABLE_SELECTORS = [
  '.el-table__body-wrapper table tbody tr.el-table__row',
  '.el-table__body-wrapper',
  '.el-table',
];

/**
 * 检测签收录入页面核心 DOM
 *
 * 选择器全部来源于 signSelectors.ts，不猜测：
 *   - 日期范围选择器：dateRangeInput
 *   - 派件员下拉框：courierSelectInput
 *   - 搜索按钮：searchButton
 *   - 批量签收按钮（最终提交）：batchSignButton（仅检测，不点击）
 *   - 签收弹窗确认按钮（最终提交）：dialogConfirmBtn（仅检测，不点击）
 */
export async function detectSignPage(page: Page): Promise<SignPageDetectResult> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 1000) : '';
  });

  const warnings: string[] = [];
  const matchedSelectors: string[] = [];
  const batchSignButtonSelectors: string[] = [];

  // 1. 判断是否疑似签收录入页面
  const urlMatch = SIGN_URL_PATTERNS.some(p => url.includes(p));
  const keywordMatch = SIGN_PAGE_KEYWORDS.some(kw => bodyText.includes(kw));
  const isSignPage = urlMatch || keywordMatch;

  if (!isSignPage) {
    warnings.push('当前页面不是签收录入页面');
  }

  // 2. 检测日期范围选择器（来源：signSelectors.ts:17）
  let hasDateRangeInput = false;
  try {
    const count = await page.$$eval(SIGN_SELECTORS.dateRangeInput, els => els.length);
    if (count > 0) {
      hasDateRangeInput = true;
      matchedSelectors.push(`日期范围选择器: signSelectors.ts:17 dateRangeInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 3. 检测派件员下拉框（来源：signSelectors.ts:29）
  let hasCourierSelectInput = false;
  try {
    const count = await page.$$eval(SIGN_SELECTORS.courierSelectInput, els => els.length);
    if (count > 0) {
      hasCourierSelectInput = true;
      matchedSelectors.push(`派件员下拉框: signSelectors.ts:29 courierSelectInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 4. 检测搜索按钮（来源：signSelectors.ts:36）
  let hasSearchButton = false;
  try {
    const count = await page.$$eval(SIGN_SELECTORS.searchButton, els => els.length);
    if (count > 0) {
      hasSearchButton = true;
      matchedSelectors.push(`搜索按钮: signSelectors.ts:36 searchButton`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 5. 检测结果表格
  let hasTable = false;
  for (const sel of TABLE_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        hasTable = true;
        matchedSelectors.push(`表格: ${sel}`);
        break;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 6. 检测"批量签收"按钮（最终提交，仅检测不点击）
  //    来源：signSelectors.ts:79
  let hasBatchSignButton = false;
  try {
    const count = await page.$$eval(SIGN_SELECTORS.batchSignButton, els => els.length);
    if (count > 0) {
      const btnText = await page.$$eval(SIGN_SELECTORS.batchSignButton, els =>
        els.map(el => (el as HTMLElement).textContent || '').join('|')
      );
      hasBatchSignButton = true;
      batchSignButtonSelectors.push(`批量签收按钮: signSelectors.ts:79 batchSignButton (文本: ${btnText.substring(0, 50)})`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 7. 检测签收弹窗（仅检测，不点击）
  //    来源：signSelectors.ts:84
  let hasSignDialog = false;
  try {
    const count = await page.$$eval(SIGN_SELECTORS.signDialog, els => els.length);
    if (count > 0) {
      hasSignDialog = true;
      matchedSelectors.push(`签收弹窗: signSelectors.ts:84 signDialog`);
    }
  } catch {
    // 选择器无效，跳过
  }

  return {
    url,
    title,
    isSignPage,
    hasDateRangeInput,
    hasCourierSelectInput,
    hasSearchButton,
    hasTable,
    hasBatchSignButton,
    hasSignDialog,
    matchedSelectors,
    batchSignButtonSelectors,
    warnings,
  };
}
