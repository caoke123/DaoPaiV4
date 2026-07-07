/**
 * DispatchPageDetector — 派件扫描页面检测
 *
 * Phase 5-F: 检测派件扫描页面核心 DOM 元素。
 *
 * 选择器来源：
 *   backend/operations/selectors/dispatchScan.selectors.ts
 *
 * 只检测，不操作。不点击任何按钮，尤其是"上传"提交按钮。
 */

import type { Page } from 'playwright-core';
import { DISPATCH_SCAN_SELECTORS, DISPATCH_PAGE_ROUTE } from './dispatchSelectors';

export interface DispatchPageDetectResult {
  url: string;
  title: string;
  isDispatchPage: boolean;
  hasCourierSelectInput: boolean;
  hasWaybillInput: boolean;
  hasAddButton: boolean;
  hasTable: boolean;
  hasUploadButton: boolean;
  matchedSelectors: string[];
  uploadButtonSelectors: string[];
  warnings: string[];
}

// 派件扫描页面 URL 路径（来源：PageStateManager.ts:19）
const DISPATCH_URL_PATTERNS = [
  DISPATCH_PAGE_ROUTE,
  '/scanning/dispatchscan',
  'dispatchscan',
];

// 派件页面关键词
const DISPATCH_PAGE_KEYWORDS = [
  '派件扫描', '派件', '上传', '运单号', '派件员',
];

// 结果表格选择器（来源：dispatchScan.selectors.ts:72-73）
const TABLE_SELECTORS = [
  'div.dispatchscan_right div.el-table__body-wrapper table tbody tr.el-table__row',
  'div.dispatchscan_right div.el-table__body-wrapper',
  'div.dispatchscan_right .el-table',
];

/**
 * 检测派件扫描页面核心 DOM
 *
 * 选择器全部来源于 dispatchScan.selectors.ts，不猜测：
 *   - 派件员输入框：courierSelectInput
 *   - 运单输入框：waybillInput
 *   - 添加按钮：addButton
 *   - 上传按钮（最终提交）：uploadButton（仅检测，不点击）
 */
export async function detectDispatchPage(page: Page): Promise<DispatchPageDetectResult> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 1000) : '';
  });

  const warnings: string[] = [];
  const matchedSelectors: string[] = [];
  const uploadButtonSelectors: string[] = [];

  // 1. 判断是否疑似派件扫描页面
  const urlMatch = DISPATCH_URL_PATTERNS.some(p => url.includes(p));
  const keywordMatch = DISPATCH_PAGE_KEYWORDS.some(kw => bodyText.includes(kw));
  const isDispatchPage = urlMatch || keywordMatch;

  if (!isDispatchPage) {
    warnings.push('当前页面不是派件扫描页面');
  }

  // 2. 检测派件员下拉框（来源：dispatchScan.selectors.ts:27-28）
  let hasCourierSelectInput = false;
  try {
    const count = await page.$$eval(DISPATCH_SCAN_SELECTORS.courierSelectInput, els => els.length);
    if (count > 0) {
      hasCourierSelectInput = true;
      matchedSelectors.push(`派件员下拉框: dispatchScan.selectors.ts:27-28 courierSelectInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 3. 检测运单输入框（来源：dispatchScan.selectors.ts:39-40）
  let hasWaybillInput = false;
  try {
    const count = await page.$$eval(DISPATCH_SCAN_SELECTORS.waybillInput, els => els.length);
    if (count > 0) {
      hasWaybillInput = true;
      matchedSelectors.push(`运单输入框: dispatchScan.selectors.ts:39-40 waybillInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 4. 检测添加按钮（来源：dispatchScan.selectors.ts:43）
  let hasAddButton = false;
  try {
    const count = await page.$$eval(DISPATCH_SCAN_SELECTORS.addButton, els => els.length);
    if (count > 0) {
      hasAddButton = true;
      matchedSelectors.push(`添加按钮: dispatchScan.selectors.ts:43 addButton`);
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

  // 6. 检测"上传"按钮（最终提交，仅检测不点击）
  //    来源：dispatchScan.selectors.ts:65
  let hasUploadButton = false;
  try {
    const count = await page.$$eval(DISPATCH_SCAN_SELECTORS.uploadButton, els => els.length);
    if (count > 0) {
      const btnText = await page.$$eval(DISPATCH_SCAN_SELECTORS.uploadButton, els =>
        els.map(el => (el as HTMLElement).textContent || '').join('|')
      );
      hasUploadButton = true;
      uploadButtonSelectors.push(`上传按钮: dispatchScan.selectors.ts:65 uploadButton (文本: ${btnText.substring(0, 50)})`);
    }
  } catch {
    // 选择器无效，跳过
  }

  return {
    url,
    title,
    isDispatchPage,
    hasCourierSelectInput,
    hasWaybillInput,
    hasAddButton,
    hasTable,
    hasUploadButton,
    matchedSelectors,
    uploadButtonSelectors,
    warnings,
  };
}
