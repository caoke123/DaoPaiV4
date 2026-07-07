/**
 * IntegratedPageDetector — 到派一体扫描页面检测
 *
 * Phase 5-F: 检测到派一体扫描页面核心 DOM 元素。
 *
 * 选择器来源：
 *   backend/operations/selectors/integratedScan.selectors.ts
 *
 * 只检测，不操作。不点击任何按钮，尤其是"上传"提交按钮。
 */

import type { Page } from 'playwright-core';
import { INTEGRATED_SCAN_SELECTORS, INTEGRATED_PAGE_ROUTE } from './integratedSelectors';

export interface IntegratedPageDetectResult {
  url: string;
  title: string;
  isIntegratedPage: boolean;
  hasPrevStationInput: boolean;
  hasIntegratedCheckbox: boolean;
  hasCourierSelectInput: boolean;
  hasWaybillInput: boolean;
  hasAddButton: boolean;
  hasTable: boolean;
  hasUploadButton: boolean;
  matchedSelectors: string[];
  uploadButtonSelectors: string[];
  warnings: string[];
}

// 到派一体页面 URL 路径（来源：PageStateManager.ts:21）
const INTEGRATED_URL_PATTERNS = [
  INTEGRATED_PAGE_ROUTE,
  '/scanning/arrivalscan',
  'arrivalscan',
];

// 到派一体页面关键词
const INTEGRATED_PAGE_KEYWORDS = [
  '到派一体', '到件扫描', '上一站', '运单号',
];

// 结果表格选择器（来源：integratedScan.selectors.ts:105-106）
const TABLE_SELECTORS = [
  'div.arrivalscan_right div.el-table__body-wrapper table tbody tr.el-table__row',
  'div.arrivalscan_right div.el-table__body-wrapper',
  'div.arrivalscan_right .el-table',
];

/**
 * 检测到派一体扫描页面核心 DOM
 *
 * 选择器全部来源于 integratedScan.selectors.ts，不猜测：
 *   - 上一站输入框：prevStationInput
 *   - 到派一体复选框：integratedCheckbox
 *   - 派件员输入框：courierSelectInput
 *   - 运单输入框：waybillInput
 *   - 添加按钮：addButton
 *   - 上传按钮（最终提交）：uploadButton（仅检测，不点击）
 */
export async function detectIntegratedPage(page: Page): Promise<IntegratedPageDetectResult> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 1000) : '';
  });

  const warnings: string[] = [];
  const matchedSelectors: string[] = [];
  const uploadButtonSelectors: string[] = [];

  // 1. 判断是否疑似到派一体页面
  const urlMatch = INTEGRATED_URL_PATTERNS.some(p => url.includes(p));
  const keywordMatch = INTEGRATED_PAGE_KEYWORDS.some(kw => bodyText.includes(kw));
  const isIntegratedPage = urlMatch || keywordMatch;

  if (!isIntegratedPage) {
    warnings.push('当前页面不是到派一体扫描页面');
  }

  // 2. 检测上一站输入框（来源：integratedScan.selectors.ts:27）
  let hasPrevStationInput = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.prevStationInput, els => els.length);
    if (count > 0) {
      hasPrevStationInput = true;
      matchedSelectors.push(`上一站输入框: integratedScan.selectors.ts:27 prevStationInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 3. 检测"到派一体"复选框（来源：integratedScan.selectors.ts:33）
  let hasIntegratedCheckbox = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.integratedCheckbox, els => els.length);
    if (count > 0) {
      hasIntegratedCheckbox = true;
      matchedSelectors.push(`到派一体复选框: integratedScan.selectors.ts:33 integratedCheckbox`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 4. 检测派件员输入框（来源：integratedScan.selectors.ts:44）
  let hasCourierSelectInput = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.courierSelectInput, els => els.length);
    if (count > 0) {
      hasCourierSelectInput = true;
      matchedSelectors.push(`派件员输入框: integratedScan.selectors.ts:44 courierSelectInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 5. 检测运单输入框（来源：integratedScan.selectors.ts:77）
  let hasWaybillInput = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.waybillInput, els => els.length);
    if (count > 0) {
      hasWaybillInput = true;
      matchedSelectors.push(`运单输入框: integratedScan.selectors.ts:77 waybillInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 6. 检测添加按钮（来源：integratedScan.selectors.ts:80）
  let hasAddButton = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.addButton, els => els.length);
    if (count > 0) {
      hasAddButton = true;
      matchedSelectors.push(`添加按钮: integratedScan.selectors.ts:80 addButton`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 7. 检测结果表格
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

  // 8. 检测"上传"按钮（最终提交，仅检测不点击）
  //    来源：integratedScan.selectors.ts:92
  let hasUploadButton = false;
  try {
    const count = await page.$$eval(INTEGRATED_SCAN_SELECTORS.uploadButton, els => els.length);
    if (count > 0) {
      const btnText = await page.$$eval(INTEGRATED_SCAN_SELECTORS.uploadButton, els =>
        els.map(el => (el as HTMLElement).textContent || '').join('|')
      );
      hasUploadButton = true;
      uploadButtonSelectors.push(`上传按钮: integratedScan.selectors.ts:92 uploadButton (文本: ${btnText.substring(0, 50)})`);
    }
  } catch {
    // 选择器无效，跳过
  }

  return {
    url,
    title,
    isIntegratedPage,
    hasPrevStationInput,
    hasIntegratedCheckbox,
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
