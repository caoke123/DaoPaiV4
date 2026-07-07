/**
 * BnsyLoginExecutor — 笨鸟系统自动登录执行器
 *
 * Phase 5-C-4: 执行完整的登录流程——填写账号密码、点击登录、等待跳转、检测登录结果。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不上传密码到 Cloud
 *   - 不写入 task_logs
 *   - 不绕过验证码/滑块/人机验证
 */

import type { Page } from 'playwright-core';
import type { LoginCredential } from '../AgentSettingsLoader';
import { detectBnsyLoginPage } from './BnsyLoginDetector';
import { stableFillInput, stableFillPassword, verifyInputValue } from './StablePageActions';

export interface BnsyLoginResult {
  success: boolean;
  beforeUrl: string;
  afterUrl: string;
  title: string;
  employeeName: string;
  accountMasked: string;
  isLoginPageBefore: boolean;
  isLoginPageAfter: boolean;
  isLoggedIn: boolean;
  message: string;
  warnings: string[];
}

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

// ── 登录页已登录关键词 ──
const LOGGED_IN_KEYWORDS = ['首页', '工作台', '退出', '到件扫描', '派件扫描', '签收录入', '到派一体'];

// ── 验证码/滑块关键词 ──
const CAPTCHA_KEYWORDS = ['验证码', '滑块', '人机验证', '短信验证', '图形验证', '请完成验证'];

export async function loginToBnsy(
  page: Page,
  credential: LoginCredential,
): Promise<BnsyLoginResult> {
  const warnings: string[] = [];

  // 1. 登录前检测
  const before = await detectBnsyLoginPage(page);

  if (!before.isLoginPage) {
    return {
      success: false,
      beforeUrl: before.url,
      afterUrl: before.url,
      title: before.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: false,
      isLoginPageAfter: before.isLoginPage,
      isLoggedIn: before.isLoggedIn,
      message: '当前页面不是登录页，无法执行登录',
      warnings,
    };
  }

  if (before.isLoggedIn) {
    warnings.push('检测到已登录状态，跳过登录流程');
    return {
      success: true,
      beforeUrl: before.url,
      afterUrl: before.url,
      title: before.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: false,
      isLoggedIn: true,
      message: '已处于登录状态，无需重复登录',
      warnings,
    };
  }

  // 2. 查找输入框和按钮
  if (!before.hasUsernameInput || !before.hasPasswordInput || !before.hasLoginButton) {
    warnings.push('登录页表单元素不完整，无法自动登录');
    return {
      success: false,
      beforeUrl: before.url,
      afterUrl: before.url,
      title: before.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: false,
      isLoggedIn: false,
      message: '登录页表单元素不完整，无法自动登录',
      warnings,
    };
  }

  // 3. 填写账号密码 + 点击登录
  try {
    // 3a. 稳定填写账号
    const usernameInput = page.locator('input[placeholder*="账号"], input[type="text"]').first();
    await stableFillInput(usernameInput, credential.loginAccount, { maxRetries: 3 });
    console.log('  [Login] 账号输入校验通过');

    // 3b. 稳定填写密码
    const passwordInput = page.locator('input[type="password"]').first();
    await stableFillPassword(passwordInput, credential.loginPassword, { maxRetries: 3 });
    console.log('  [Login] 密码输入校验通过');

    // 3c. 登录前最终校验：账号 + 密码必须都已填写成功
    const accountOk = await verifyInputValue(usernameInput, credential.loginAccount, { timeoutMs: 2000 });
    const passwordLengthOk = await passwordInput.inputValue().then(v => v.length === credential.loginPassword.length).catch(() => false);
    if (!accountOk || !passwordLengthOk) {
      return {
        success: false,
        beforeUrl: before.url,
        afterUrl: page.url(),
        title: await page.title().catch(() => ''),
        employeeName: credential.employeeName,
        accountMasked: maskAccount(credential.loginAccount),
        isLoginPageBefore: true,
        isLoginPageAfter: false,
        isLoggedIn: false,
        message: `登录前校验失败：账号校验=${accountOk}，密码长度校验=${passwordLengthOk}`,
        warnings,
      };
    }

    // 3d. 等待 Vue 双向绑定完成
    await page.waitForTimeout(500);

    // 3e. 点击登录按钮
    const loginButton = page.locator('button:has-text("登录"), .el-button:has-text("登录")').first();
    await loginButton.click();

    // 4. 等待跳转或页面稳定（最多 15 秒）
    try {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
    } catch {
      // 网络未完全空闲也继续
    }

    // 等待额外时间确保 SPA 渲染完成
    await page.waitForTimeout(3000);
  } catch (err) {
    const msg = (err as Error).message;
    // 不输出密码
    if (msg.includes(credential.loginPassword)) {
      return {
        success: false,
        beforeUrl: before.url,
        afterUrl: page.url(),
        title: await page.title(),
        employeeName: credential.employeeName,
        accountMasked: maskAccount(credential.loginAccount),
        isLoginPageBefore: true,
        isLoginPageAfter: false,
        isLoggedIn: false,
        message: '登录操作异常',
        warnings,
      };
    }
    return {
      success: false,
      beforeUrl: before.url,
      afterUrl: page.url(),
      title: await page.title(),
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: false,
      isLoggedIn: false,
      message: `登录操作失败：${msg}`,
      warnings,
    };
  }

  // 5. 登录后检测
  const after = await detectBnsyLoginPage(page);

  // 5a. 检测验证码/滑块
  if (CAPTCHA_KEYWORDS.some(kw => after.pageTextPreview.includes(kw))) {
    warnings.push('检测到登录保护（验证码/滑块/人机验证），需要人工处理');
    return {
      success: false,
      beforeUrl: before.url,
      afterUrl: after.url,
      title: after.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: after.isLoginPage,
      isLoggedIn: false,
      message: '检测到登录保护，需要人工处理',
      warnings,
    };
  }

  // 5b. 判断登录成功
  const urlNotLogin = !after.url.toLowerCase().includes('login');
  const hasLoggedInKeyword = LOGGED_IN_KEYWORDS.some(kw => after.pageTextPreview.includes(kw));
  const isLoggedIn = urlNotLogin && hasLoggedInKeyword;

  if (isLoggedIn) {
    return {
      success: true,
      beforeUrl: before.url,
      afterUrl: after.url,
      title: after.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: after.isLoginPage,
      isLoggedIn: true,
      message: '登录成功，已进入业务页面',
      warnings,
    };
  }

  // 5c. 登录失败判断
  if (after.isLoginPage) {
    // 检查是否有错误提示
    const errorExists = after.pageTextPreview.includes('错误') ||
      after.pageTextPreview.includes('失败') ||
      after.pageTextPreview.includes('账号或密码');
    return {
      success: false,
      beforeUrl: before.url,
      afterUrl: after.url,
      title: after.title,
      employeeName: credential.employeeName,
      accountMasked: maskAccount(credential.loginAccount),
      isLoginPageBefore: true,
      isLoginPageAfter: true,
      isLoggedIn: false,
      message: errorExists
        ? '登录失败：页面显示错误提示，请检查账号或密码'
        : '登录失败：登录后仍停留在登录页',
      warnings,
    };
  }

  // 跳转到了新页面但未检测到首页特征
  return {
    success: false,
    beforeUrl: before.url,
    afterUrl: after.url,
    title: after.title,
    employeeName: credential.employeeName,
    accountMasked: maskAccount(credential.loginAccount),
    isLoginPageBefore: true,
    isLoginPageAfter: false,
    isLoggedIn: false,
    message: '登录结果不确定：页面已跳转但未检测到业务首页特征',
    warnings,
  };
}