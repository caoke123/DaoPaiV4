/**
 * BnsyLoginDetector — 笨鸟登录页 DOM 识别与登录前安全检测
 *
 * Phase 5-C-3: 识别登录页元素（账号输入框、密码输入框、登录按钮），
 * 判断是否已登录，为后续 Phase 5-C-4 登录 DRY-RUN 做准备。
 *
 * 只检测，不操作。不输入账号密码，不点击登录。
 */

import type { Page } from 'playwright-core';

export interface LoginPageDetectResult {
  url: string;
  title: string;
  isLoginPage: boolean;
  isLoggedIn: boolean;
  hasUsernameInput: boolean;
  hasPasswordInput: boolean;
  hasLoginButton: boolean;
  usernameSelectors: string[];
  passwordSelectors: string[];
  loginButtonSelectors: string[];
  pageTextPreview: string;
  warnings: string[];
}

// ── 候选选择器 ──────────────────────────────────────────

const USERNAME_SELECTORS = [
  'input[placeholder*="账号"]',
  'input[placeholder*="用户名"]',
  'input[placeholder*="手机号"]',
  'input[placeholder*="员工"]',
  'input[type="text"]',
  'input:not([type])',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[placeholder*="密码"]',
];

const LOGIN_BUTTON_SELECTORS = [
  'button:has-text("登录")',
  '.el-button:has-text("登录")',
  'button[type="submit"]',
  'input[type="submit"]',
];

const LOGGED_IN_KEYWORDS = ['首页', '工作台', '退出', '到件扫描', '派件扫描', '签收录入', '到派一体'];

// ── 检测函数 ────────────────────────────────────────────

export async function detectBnsyLoginPage(page: Page): Promise<LoginPageDetectResult> {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 500) : '';
  });

  const warnings: string[] = [];

  // 1. 识别账号输入框
  const usernameSelectors: string[] = [];
  let hasUsernameInput = false;
  for (const sel of USERNAME_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        usernameSelectors.push(sel);
        hasUsernameInput = true;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 2. 识别密码输入框
  const passwordSelectors: string[] = [];
  let hasPasswordInput = false;
  for (const sel of PASSWORD_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        passwordSelectors.push(sel);
        hasPasswordInput = true;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 3. 识别登录按钮
  const loginButtonSelectors: string[] = [];
  let hasLoginButton = false;
  for (const sel of LOGIN_BUTTON_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        loginButtonSelectors.push(sel);
        hasLoginButton = true;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 补充：页面文本包含"登录"也视为有登录按钮
  if (!hasLoginButton && bodyText.includes('登录')) {
    hasLoginButton = true;
    loginButtonSelectors.push('(文本匹配: "登录")');
  }

  // 4. 判断是否登录页
  const urlHasLogin = url.toLowerCase().includes('login');
  const textHasLogin = bodyText.includes('登录');
  const textHasAccount = bodyText.includes('账号') || bodyText.includes('用户名');
  const isLoginPage = urlHasLogin || textHasLogin || textHasAccount || hasPasswordInput;

  // 5. 判断是否已登录
  const urlNotLogin = !urlHasLogin;
  const hasLoggedInKeyword = LOGGED_IN_KEYWORDS.some(kw => bodyText.includes(kw));
  let isLoggedIn = urlNotLogin && hasLoggedInKeyword;

  // 如果同时存在 password input，优先判断为未登录
  if (isLoggedIn && hasPasswordInput) {
    isLoggedIn = false;
    warnings.push('页面同时存在密码输入框和已登录关键词，优先判断为未登录');
  }

  // 6. 生成 warnings
  if (!hasUsernameInput) {
    warnings.push('未明确检测到账号输入框，请人工确认页面结构是否变化');
  }
  if (!hasPasswordInput) {
    warnings.push('未明确检测到密码输入框，请人工确认页面结构是否变化');
  }
  if (!hasLoginButton) {
    warnings.push('未明确检测到登录按钮，请人工确认页面结构是否变化');
  }

  return {
    url,
    title,
    isLoginPage,
    isLoggedIn,
    hasUsernameInput,
    hasPasswordInput,
    hasLoginButton,
    usernameSelectors,
    passwordSelectors,
    loginButtonSelectors,
    pageTextPreview: bodyText.substring(0, 200),
    warnings,
  };
}