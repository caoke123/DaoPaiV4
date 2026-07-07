/**
 * ArrivalPageDetector — 到件扫描页面检测
 *
 * Phase 5-D: 检测到件扫描页面核心 DOM 元素。
 * Phase 5-E-1: 严格使用旧执行流程代码的选择器，禁止猜测。
 *
 * 选择器来源：
 *   backend/operations/selectors/arrivalScanBatch.selectors.ts
 *
 * 只检测，不操作。不点击任何按钮，尤其是最终提交按钮。
 */

import type { Page } from 'playwright-core';
import { ARRIVAL_BATCH_SELECTORS, ARRIVAL_PAGE_ROUTE } from './arrivalSelectors';

export interface ArrivalPageDetectResult {
  url: string;
  title: string;
  isArrivalPage: boolean;
  hasWaybillInput: boolean;
  hasPrevStationInput: boolean;
  hasSearchButton: boolean;
  hasTable: boolean;
  hasFinalSubmitButton: boolean;
  matchedSelectors: string[];
  finalSubmitSelectors: string[];
  warnings: string[];
}

// 到件扫描页面 URL 路径（来源：PageStateManager.ts:18）
const ARRIVAL_URL_PATTERNS = [
  ARRIVAL_PAGE_ROUTE,
  '/scanning/arrivalscanBatch',
  'ArrivalscanBatch',
];

// 到件页面关键词
const ARRIVAL_PAGE_KEYWORDS = [
  '到件扫描', '到件', '批量到件', '运单号', '上一站',
];

// 结果表格选择器（来源：ArriveScanBatch.ts:211）
const TABLE_SELECTORS = [
  '.el-table__body-wrapper .el-table__row',
  '.el-table__body-wrapper',
  '.el-table',
];

/**
 * 检测到件扫描页面核心 DOM
 *
 * 选择器全部来源于 arrivalScanBatch.selectors.ts，不猜测：
 *   - 运单输入框：waybillTextarea
 *   - 上一站输入框：prevStationInput
 *   - 查询按钮：queryBtn
 *   - 最终提交按钮：submitBatchBtn
 */
export async function detectArrivalPage(page: Page): Promise<ArrivalPageDetectResult> {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 1000) : '';
  });

  const warnings: string[] = [];
  const matchedSelectors: string[] = [];
  const finalSubmitSelectors: string[] = [];

  // 1. 判断是否疑似到件扫描页面
  const urlMatch = ARRIVAL_URL_PATTERNS.some(p => url.includes(p));
  const keywordMatch = ARRIVAL_PAGE_KEYWORDS.some(kw => bodyText.includes(kw));
  const isArrivalPage = urlMatch || keywordMatch;

  if (!isArrivalPage) {
    warnings.push('当前页面不是到件扫描页面');
  }

  // 2. 检测运单输入框（来源：arrivalScanBatch.selectors.ts:42-43）
  let hasWaybillInput = false;
  try {
    const count = await page.$$eval(ARRIVAL_BATCH_SELECTORS.waybillTextarea, els => els.length);
    if (count > 0) {
      hasWaybillInput = true;
      matchedSelectors.push(`运单输入框: arrivalScanBatch.selectors.ts:42-43 waybillTextarea`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 3. 检测上一站输入框（来源：arrivalScanBatch.selectors.ts:46-47）
  let hasPrevStationInput = false;
  try {
    const count = await page.$$eval(ARRIVAL_BATCH_SELECTORS.prevStationInput, els => els.length);
    if (count > 0) {
      hasPrevStationInput = true;
      matchedSelectors.push(`上一站输入框: arrivalScanBatch.selectors.ts:46-47 prevStationInput`);
    }
  } catch {
    // 选择器无效，跳过
  }

  // 4. 检测查询按钮（来源：arrivalScanBatch.selectors.ts:53-54）
  let hasSearchButton = false;
  try {
    const count = await page.$$eval(ARRIVAL_BATCH_SELECTORS.queryBtn, els => els.length);
    if (count > 0) {
      hasSearchButton = true;
      matchedSelectors.push(`查询按钮: arrivalScanBatch.selectors.ts:53-54 queryBtn`);
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

  // 6. 检测最终提交按钮（来源：arrivalScanBatch.selectors.ts:67-68）
  //    只检测，不点击
  let hasFinalSubmitButton = false;
  try {
    const count = await page.$$eval(ARRIVAL_BATCH_SELECTORS.submitBatchBtn, els => els.length);
    if (count > 0) {
      // 进一步检查按钮文本是否包含"批量到件"
      const btnText = await page.$$eval(ARRIVAL_BATCH_SELECTORS.submitBatchBtn, els =>
        els.map(el => (el as HTMLElement).textContent || '').join('|')
      );
      if (btnText.includes('批量到件') || btnText.includes('到件')) {
        hasFinalSubmitButton = true;
        finalSubmitSelectors.push(`提交按钮: arrivalScanBatch.selectors.ts:67-68 submitBatchBtn (文本: ${btnText.substring(0, 50)})`);
      }
    }
  } catch {
    // 选择器无效，跳过
  }

  return {
    url,
    title,
    isArrivalPage,
    hasWaybillInput,
    hasPrevStationInput,
    hasSearchButton,
    hasTable,
    hasFinalSubmitButton,
    matchedSelectors,
    finalSubmitSelectors,
    warnings,
  };
}
