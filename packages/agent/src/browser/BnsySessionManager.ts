/**
 * BnsySessionManager — 笨鸟登录状态保持
 *
 * Phase 5-C-5: 检测当前是否已登录，复用已有登录态；
 * 未登录时自动调用 loginToBnsy 登录，然后验证 Dashboard P0。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不上传密码到 Cloud
 *   - 不写入 task_logs
 */

import type { Page } from 'playwright-core';
import type { LoginCredential } from '../AgentSettingsLoader';
import { detectBnsyDashboardP0, type DashboardP0Result } from './BnsyDashboardDetector';
import { logTrace } from '../trace';
import { loginToBnsy } from './BnsyLoginExecutor';

export interface EnsureLoginResult {
  success: boolean;
  reusedSession: boolean;
  loginAttempted: boolean;
  dashboard: DashboardP0Result;
  message: string;
  warnings: string[];
}

/**
 * 清理页面可见阻塞弹窗
 *
 * 策略：
 *   1. 扫描可见弹窗（.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"]）
 *   2. 尝试点击关闭按钮：取消、确定、我知道了、关闭、×、知道了
 *   3. 不点击任何业务按钮（到件/派件/签收/提交/批量/保存业务数据）
 *   4. 每次点击后等待 500-800ms
 *   5. 最多循环 5 轮
 *   6. 每轮重新检测
 */
export async function cleanBlockingPopups(page: Page): Promise<{ cleaned: boolean; actions: string[] }> {
  const actions: string[] = [];

  // 安全关闭按钮文本（不包含业务关键词）
  const SAFE_CLOSE_TEXTS = ['取消', '确定', '我知道了', '关闭', '×', '知道了'];

  // 业务关键词黑名单：如果按钮文本包含这些词，禁止点击
  const BUSINESS_BLACKLIST = ['到件', '派件', '签收', '提交', '批量', '保存业务数据', '确认提交'];

  for (let round = 0; round < 5; round++) {
    try {
      const result = await page.evaluate(({ safeTexts, blacklist }) => {
        // 检查是否有可见弹窗
        const popupSelectors = ['.el-dialog__wrapper', '.el-message-box__wrapper', '[role="dialog"]'];
        let hasVisiblePopup = false;

        for (const sel of popupSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const style = window.getComputedStyle(el as HTMLElement);
            if (style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetWidth > 0) {
              hasVisiblePopup = true;
              break;
            }
          }
          if (hasVisiblePopup) break;
        }

        if (!hasVisiblePopup) return { closed: false, action: '无可见弹窗' };

        // 尝试在可见弹窗中找安全关闭按钮
        for (const sel of popupSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const style = window.getComputedStyle(el as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden' || (el as HTMLElement).offsetWidth === 0) continue;

            const btns = el.querySelectorAll('button, .el-button, [class*="btn"]');
            for (const btn of btns) {
              const text = (btn.textContent || '').replace(/\s+/g, '');

              // 检查黑名单
              const isBlacklisted = blacklist.some((kw: string) => text.includes(kw));
              if (isBlacklisted) continue;

              // 检查是否安全关闭按钮
              const isSafeClose = safeTexts.some((st: string) => text === st || text.includes(st));
              if (isSafeClose) {
                (btn as HTMLElement).click();
                return { closed: true, action: `点击了"${text}"按钮关闭弹窗` };
              }
            }
          }
        }

        return { closed: false, action: '未找到安全关闭按钮' };
      }, { safeTexts: SAFE_CLOSE_TEXTS, blacklist: BUSINESS_BLACKLIST });

      if (result.closed) {
        actions.push(`第${round + 1}轮: ${result.action}`);
        await page.waitForTimeout(500 + Math.random() * 300);
      } else {
        // 没有找到可关闭的弹窗，退出循环
        if (result.action === '无可见弹窗') {
          actions.push(`第${round + 1}轮: ${result.action}`);
          break;
        }
        actions.push(`第${round + 1}轮: ${result.action}，停止清理`);
        break;
      }
    } catch {
      actions.push(`第${round + 1}轮: 清理出错，停止`);
      break;
    }
  }

  return { cleaned: actions.length > 0, actions };
}

export async function ensureBnsyLoggedIn(
  page: Page,
  credential: LoginCredential,
): Promise<EnsureLoginResult> {
  const warnings: string[] = [];

  // 1. 先检测当前 Dashboard P0
  const tP0 = Date.now();
  logTrace('bnsy-login', 'p0_check_start', {
    credentialStaff: credential.employeeName,
  });
  const before = await detectBnsyDashboardP0(page);
  logTrace('bnsy-login', 'p0_first_check_done', {
    durationMs: Date.now() - tP0,
    status: before.status,
    isLoggedIn: before.isLoggedIn,
    hasCoreDom: before.hasCoreDom,
    hasBlockedPopup: before.hasBlockedPopup,
  });

  if (before.status === 'READY') {
    return {
      success: true,
      reusedSession: true,
      loginAttempted: false,
      dashboard: before,
      message: '已有登录态，Dashboard 就绪，无需重新登录',
      warnings,
    };
  }

  if (before.status === 'BLOCKED_POPUP') {
    console.log('  检测到阻塞弹窗，尝试清理...');
    const tPopup = Date.now();
    const cleanResult = await cleanBlockingPopups(page);
    logTrace('bnsy-login', 'popup_cleanup_done', {
      durationMs: Date.now() - tPopup,
      cleaned: cleanResult.cleaned,
      actionCount: cleanResult.actions.length,
    });
    if (cleanResult.actions.length > 0) {
      console.log(`  弹窗清理动作: ${cleanResult.actions.join('; ')}`);
    }

    const afterClean = await detectBnsyDashboardP0(page);
    if (afterClean.status === 'READY') {
      return {
        success: true,
        reusedSession: true,
        loginAttempted: false,
        dashboard: afterClean,
        message: '弹窗已关闭，Dashboard 就绪',
        warnings,
      };
    }

    warnings.push(`Dashboard 存在阻塞弹窗，无法自动关闭。清理动作: ${cleanResult.actions.join('; ') || '无'}`);
    return {
      success: false,
      reusedSession: false,
      loginAttempted: false,
      dashboard: afterClean,
      message: 'Dashboard 存在阻塞弹窗，无法自动关闭',
      warnings,
    };
  }

  if (before.status === 'LOGIN_REQUIRED') {
    // 2. 需要登录，调用 loginToBnsy
    console.log('  未登录，开始自动登录...');
    const loginResult = await loginToBnsy(page, credential);

    if (!loginResult.success) {
      warnings.push(...loginResult.warnings);
      return {
        success: false,
        reusedSession: false,
        loginAttempted: true,
        dashboard: {
          status: 'LOGIN_FAILED',
          url: loginResult.afterUrl,
          title: loginResult.title,
          isLoggedIn: false,
          isDashboard: false,
          hasCoreDom: false,
          hasBlockedPopup: false,
          coreSelectorsMatched: [],
          popupSelectorsMatched: [],
          pageTextPreview: '',
          message: loginResult.message,
          warnings: loginResult.warnings,
        },
        message: `登录失败：${loginResult.message}`,
        warnings,
      };
    }

    // 3. 登录成功，再次检测 Dashboard P0
    console.log('  登录成功，检测 Dashboard P0...');
    let after = await detectBnsyDashboardP0(page);

    // 登录后如果有阻塞弹窗，尝试清理
    if (after.status === 'BLOCKED_POPUP') {
      console.log('  登录后检测到阻塞弹窗，尝试清理...');
      const cleanResult = await cleanBlockingPopups(page);
      if (cleanResult.actions.length > 0) {
        console.log(`  弹窗清理动作: ${cleanResult.actions.join('; ')}`);
      }
      after = await detectBnsyDashboardP0(page);
    }

    if (after.status === 'READY') {
      return {
        success: true,
        reusedSession: false,
        loginAttempted: true,
        dashboard: after,
        message: '登录成功，Dashboard 就绪',
        warnings,
      };
    }

    // 登录后仍不是 READY
    warnings.push(`登录后 Dashboard 状态为 ${after.status}：${after.message}`);
    return {
      success: false,
      reusedSession: false,
      loginAttempted: true,
      dashboard: after,
      message: `登录成功但 Dashboard 未就绪：${after.message}`,
      warnings,
    };
  }

  // 4. 其他状态（PAGE_NOT_READY / LOGIN_FAILED / UNKNOWN）
  warnings.push(`Dashboard 状态异常：${before.status} - ${before.message}`);
  return {
    success: false,
    reusedSession: false,
    loginAttempted: false,
    dashboard: before,
    message: `Dashboard 状态异常：${before.message}`,
    warnings,
  };
}