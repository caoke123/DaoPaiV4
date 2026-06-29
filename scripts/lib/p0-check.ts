/**
 * p0-check — Phase 2-D-Run 三次修正
 *
 * 测试脚本侧 P0 检查 HTTP 客户端。
 * 调用后端 POC API /api/playwright-poc/window/p0-check 执行 P0 检查。
 *
 * 后端 P0Verifier.ts 复用了原项目 BrowserPool.verifyReady + ensureNoPopup 逻辑。
 *
 * 用途：
 *   在自动登录后、提交 sign 任务前执行 P0 检查。
 *   P0 通过才允许提交 sign 任务；P0 不通过直接失败，不提交 sign。
 */
import type { P0Report } from '../../backend/playwright-runtime/P0Verifier';

export interface P0CheckOptions {
  baseUrl: string;          // 后端基础 URL，如 http://localhost:3200
  pocBase: string;          // POC API 基础 URL，如 http://localhost:3200/api/playwright-poc
  tenantId: string;
  siteId: string;           // POC 层 siteId（内部 Site code: tiannanda/heyuan）
  windowId: string;
}

export interface P0CheckResponse {
  success: boolean;
  runtimeKey?: string;
  report?: P0Report;
  error?: string;
}

/**
 * 调用后端 P0 检查接口
 *
 * POST /api/playwright-poc/window/p0-check
 * Body: { tenantId, siteId, windowId }
 *
 * 返回 P0Report 或错误。
 */
export async function runP0Check(opts: P0CheckOptions): Promise<P0CheckResponse> {
  const url = `${opts.pocBase}/window/p0-check`;
  const body = {
    tenantId: opts.tenantId,
    siteId: opts.siteId,
    windowId: opts.windowId,
  };

  console.log(`\n  [p0-check] 调用 P0 检查: POST ${url}`);
  console.log(`  [p0-check] 请求体: tenantId=${opts.tenantId}, siteId=${opts.siteId}, windowId=${opts.windowId}`);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));

    if (resp.status === 200 && data?.success === true && data?.report) {
      const report = data.report as P0Report;
      console.log(`  [p0-check] ✓ P0 检查完成: passed=${report.passed}, failedCheck=${report.failedCheck || 'N/A'}`);
      console.log(`  [p0-check]   startUrl=${report.startUrl}`);
      console.log(`  [p0-check]   endUrl=${report.endUrl}`);
      console.log(`  [p0-check]   isDashboard=${report.isDashboard}, isLoginPage=${report.isLoginPage}`);
      console.log(`  [p0-check]   hasCoreDom=${report.hasCoreDom}, hasBlockingPopup=${report.hasBlockingPopup}`);
      console.log(`  [p0-check]   popupDismissAttempted=${report.popupDismissAttempted}`);
      console.log(`  [p0-check]   rounds=${report.rounds.length}`);
      return { success: true, runtimeKey: data.runtimeKey, report };
    }

    console.error(`  [p0-check] ✗ P0 检查调用失败: http=${resp.status}, error=${data?.error || 'N/A'}`);
    return { success: false, error: `http=${resp.status}, error=${data?.error || 'N/A'}` };
  } catch (e) {
    console.error(`  [p0-check] ✗ P0 检查网络异常: ${(e as Error).message}`);
    return { success: false, error: (e as Error).message };
  }
}
