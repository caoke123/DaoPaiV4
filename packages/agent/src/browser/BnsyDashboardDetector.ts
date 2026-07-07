/**
 * BnsyDashboardDetector — 笨鸟 Dashboard P0 检测
 *
 * Phase 5-C-5: 检测笨鸟系统 Dashboard 是否真正可用。
 * 判断核心 DOM 存在、无阻塞弹窗、已登录且进入业务首页。
 *
 * 只检测，不操作。不点击弹窗按钮，不点击业务菜单。
 */

import type { Page } from 'playwright-core';

export type DashboardReadyStatus =
  | 'READY'
  | 'LOGIN_REQUIRED'
  | 'LOGIN_FAILED'
  | 'BLOCKED_POPUP'
  | 'PAGE_NOT_READY'
  | 'UNKNOWN';

export interface DashboardP0Result {
  status: DashboardReadyStatus;
  url: string;
  title: string;
  isLoggedIn: boolean;
  isDashboard: boolean;
  hasCoreDom: boolean;
  hasBlockedPopup: boolean;
  coreSelectorsMatched: string[];
  popupSelectorsMatched: string[];
  pageTextPreview: string;
  message: string;
  warnings: string[];
}

export interface DashboardSnapshot {
  url: string;
  title: string;
  bodyText: string;
  hasPasswordInput: boolean;
  coreSelectorsMatched: string[];
  popupSelectorsMatched: string[];
}

// ── 核心 DOM 选择器 ──
export const CORE_DOM_SELECTORS = [
  '.el-menu',
  '.app-container',
  '.sidebar',
  '.layout',
  '.main-container',
  '#app',
];

// ── 阻塞弹窗选择器 ──
export const BLOCKING_POPUP_SELECTORS = [
  '.el-dialog__wrapper',
  '.el-message-box__wrapper',
  '.el-overlay',
  '[role="dialog"]',
];

// ── Dashboard 页面关键词 ──
export const DASHBOARD_KEYWORDS = [
  '首页', '工作台', '到件扫描', '派件扫描', '签收录入', '到派一体', '退出',
  'dashboard',
];

export function classifyDashboardSnapshot(snapshot: DashboardSnapshot): DashboardP0Result {
  const warnings: string[] = [];
  const coreSelectorsMatched = snapshot.coreSelectorsMatched || [];
  const popupSelectorsMatched = snapshot.popupSelectorsMatched || [];
  const hasCoreDom = coreSelectorsMatched.length > 0;
  const hasBlockedPopup = popupSelectorsMatched.length > 0;
  const url = snapshot.url || '';
  const title = snapshot.title || '';
  const bodyText = snapshot.bodyText || '';

  const urlHasLogin = url.toLowerCase().includes('/login');
  const isLoggedIn = (!urlHasLogin && !snapshot.hasPasswordInput) ||
    (urlHasLogin && !snapshot.hasPasswordInput && title.includes('首页'));
  const urlHasDashboard = url.toLowerCase().includes('dashboard');
  const hasDashboardKeyword = DASHBOARD_KEYWORDS.some(kw => bodyText.includes(kw));
  const isDashboard = urlHasDashboard || hasDashboardKeyword || title.includes('首页');

  let status: DashboardReadyStatus;

  if (isLoggedIn && hasCoreDom && !hasBlockedPopup) {
    status = 'READY';
  } else if (isLoggedIn && hasBlockedPopup) {
    status = 'BLOCKED_POPUP';
    warnings.push('检测到阻塞弹窗，需要人工处理或关闭弹窗后再检测');
  } else if (isLoggedIn && !isDashboard && !hasBlockedPopup) {
    status = 'PAGE_NOT_READY';
    warnings.push('已登录但未检测到 Dashboard 首页特征');
  } else if (snapshot.hasPasswordInput) {
    status = 'LOGIN_REQUIRED';
  } else if (urlHasLogin && !snapshot.hasPasswordInput && !title.includes('首页')) {
    status = 'LOGIN_REQUIRED';
  } else {
    status = 'UNKNOWN';
    warnings.push('无法确定 Dashboard 状态');
  }

  const messages: Record<DashboardReadyStatus, string> = {
    READY: 'Dashboard 就绪，可执行任务',
    LOGIN_REQUIRED: '未登录，需要先登录',
    LOGIN_FAILED: '登录失败或登录态异常',
    BLOCKED_POPUP: 'Dashboard 存在阻塞弹窗，需要先处理',
    PAGE_NOT_READY: '已登录但页面不是 Dashboard 首页',
    UNKNOWN: '无法确定 Dashboard 状态',
  };

  return {
    status,
    url,
    title,
    isLoggedIn,
    isDashboard,
    hasCoreDom,
    hasBlockedPopup,
    coreSelectorsMatched,
    popupSelectorsMatched,
    pageTextPreview: bodyText.substring(0, 200),
    message: messages[status],
    warnings,
  };
}

export async function detectBnsyDashboardP0(page: Page): Promise<DashboardP0Result> {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 500) : '';
  });

  const coreSelectorsMatched: string[] = [];
  const popupSelectorsMatched: string[] = [];

  // 1. 检测核心 DOM
  let hasCoreDom = false;
  for (const sel of CORE_DOM_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        coreSelectorsMatched.push(sel);
        hasCoreDom = true;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 2. 检测阻塞弹窗（仅检测可见的，隐藏 DOM 模板不计入）
  let hasBlockedPopup = false;
  for (const sel of BLOCKING_POPUP_SELECTORS) {
    try {
      const visibleCount = await page.$$eval(sel, els =>
        els.filter(el => {
          const style = window.getComputedStyle(el as HTMLElement);
          return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetWidth > 0;
        }).length
      );
      if (visibleCount > 0) {
        popupSelectorsMatched.push(sel);
        hasBlockedPopup = true;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  const hasPasswordInput = await (async () => {
    try {
      const count = await page.$$eval('input[type="password"]', els => els.length);
      return count > 0;
    } catch {
      return false;
    }
  })();

  return classifyDashboardSnapshot({
    url,
    title,
    bodyText,
    hasPasswordInput,
    coreSelectorsMatched,
    popupSelectorsMatched,
  });
}
