// InitWindowHandler — 窗口初始化任务处理器
// Phase J: 将"打开窗口→登录→清弹窗→首页DOM验证"包装为 Engine 任务，
//          享受统一的超时控制、取消机制和日志记录。
//
// 业务流程：
//   1. 从 assignment.windowId 获取目标窗口 ID
//   2. 调用 BrowserPool.toggleWindow() 完成 CDP 连接 + 登录 + 弹窗清除全链路
//   3. 【首页就绪验证】严格检查三项：
//      a. URL 是 /dashboard（非登录页/空白页/错误页）
//      b. 核心侧边栏/工作台 DOM 已渲染（.el-menu 或 .app-container）
//      c. 页面无可见弹窗
//   4. 任一检查失败 → throw Error → Engine 标记任务 FAILED
//
// 就绪标准：
//   ✅ CDP 连接成功 → toggleWindow 返回 isConnected=true
//   ✅ URL 包含 /dashboard → 说明登录已成功跳转
//   ✅ .el-menu 或 .app-container 存在 → 核心 UI 已加载
//   ✅ 无可见 .el-dialog__wrapper 或其 visibility 为 hidden → 页面无弹窗阻挡
//
// 失败场景（自动标记 FAILED）：
//   ❌ EasyBR 无法打开窗口 → toggleWindow 抛错
//   ❌ 登录失败/密码错误 → URL 停留在 /login
//   ❌ 首页 DOM 未渲染 → 可能是网络慢或系统异常
//   ❌ 弹窗卡死 → 清除失败，页面无法操作
import { BrowserPool } from '../../../browser/BrowserPool';
import type { TaskHandler } from './TaskHandler';
import type { Assignment, WorkerContext, TaskContext, TaskResult, ProgressFn } from '../types';

/** 首页就绪验证错误 */
export class HomepageNotReadyError extends Error {
  constructor(reason: string) {
    super(`首页就绪验证失败: ${reason}`);
    this.name = 'HomepageNotReadyError';
  }
}

/**
 * 窗口初始化 Handler
 *
 * 与其他 Handler 的关键区别：
 *   - 不处理运单数据（waybillNos 为空）
 *   - 不依赖 Engine 的 getStaffConnection / 窗口锁
 *   - 自行通过 BrowserPool 完成全链路连接
 *   - 必须通过首页 DOM 验证才返回成功
 */
export class InitWindowHandler implements TaskHandler {
  async executeWorker(
    ctx: WorkerContext,
    assignment: Assignment,
    taskContext: TaskContext,
    onProgress: ProgressFn,
  ): Promise<TaskResult> {
    const windowId = assignment.windowId || assignment.waybillNos[0];
    if (!windowId) {
      throw new Error('InitWindowHandler: assignment 缺少 windowId');
    }

    const pool = BrowserPool.getInstance();
    ctx.log('info', `[InitWindow] 开始初始化窗口: ${windowId}`);

    // ── Step 1: 连接窗口（调用 toggleWindow 完成全链路）──
    ctx.log('info', `[InitWindow] 正在连接 CDP → 登录 → 清弹窗...`);
    let toggleResult: { isConnected: boolean };
    try {
      toggleResult = await pool.toggleWindow(windowId);
    } catch (e) {
      throw new Error(`窗口连接失败: ${(e as Error).message}`);
    }

    if (!toggleResult.isConnected) {
      throw new Error('窗口连接失败: toggleWindow 返回 isConnected=false');
    }
    ctx.log('info', `[InitWindow] CDP 连接成功，开始首页就绪验证...`);

    // ── Step 2: 首页就绪验证 ──
    await this.verifyHomepageReady(pool, windowId, ctx);

    // ── Step 3: 报告完成 ──
    const result: TaskResult = { success: true, processed: 1, failed: 0 };
    onProgress(1, []);
    ctx.log('info', `[InitWindow] ✅ 窗口初始化完成，首页就绪 (windowId=${windowId})`);
    return result;
  }

  /**
   * 首页就绪验证（3 项严格检查）
   *
   * 检查顺序：
   *   URL 检查 → DOM 元素检查 → 弹窗检查
   *
   * 每项失败都抛出 HomepageNotReadyError，由 Engine 捕获后标记任务 FAILED。
   */
  private async verifyHomepageReady(
    pool: BrowserPool,
    windowId: string,
    ctx: WorkerContext,
  ): Promise<void> {
    // 从 BrowserPool 内部获取连接（通过 listWindows 找到对应 page）
    const allWindows = pool.listWindows();
    const winInfo = allWindows.find(w => w.id === windowId);
    if (!winInfo || winInfo.is_connected !== 1) {
      throw new HomepageNotReadyError('窗口未在连接池中或已断开');
    }

    // 通过 getStaffConnection 获取连接（如果窗口有 staff_name）
    // 否则通过 toggleWindow 后窗口已在 connections Map 中，需要直接访问
    // BrowserPool 没有直接按 windowId 取 page 的公开方法，但 toggleWindow 后的
    // connections Map 里有该窗口。我们通过 listWindows 找到窗口名，再获取 connection。
    let page: any = null;
    try {
      if (winInfo.staff_name) {
        const conn = await pool.getStaffConnection(winInfo.staff_name, winInfo.site);
        page = conn.page;
      }
    } catch {
      // 窗口可能匿名（init_window 场景允许），通过 else 分支重试
    }

    if (!page) {
      // 回退：直接尝试通过窗口名匹配
      throw new HomepageNotReadyError('无法获取窗口 Page 实例');
    }

    // ── 检查 1: URL 必须是 /dashboard ──
    const currentUrl = page.url();
    ctx.log('info', `[InitWindow][验证] 当前 URL: ${currentUrl}`);

    if (!currentUrl.includes('/dashboard')) {
      if (currentUrl.includes('/login') || currentUrl.includes('Login')) {
        throw new HomepageNotReadyError('登录失败/密码错误，URL 停留在登录页');
      }
      if (currentUrl === 'about:blank' || currentUrl === '') {
        throw new HomepageNotReadyError('页面为空白页，系统可能未加载');
      }
      throw new HomepageNotReadyError(`URL 不是 /dashboard (实际: ${currentUrl})`);
    }
    ctx.log('info', `[InitWindow][验证] ✓ URL 检查通过: /dashboard`);

    // ── 检查 2: 核心侧边栏/工作台 DOM 已渲染 ──
    const SELECTORS = [
      '.el-menu',          // Element UI 侧边菜单
      '.sidebar-container',// 自定义侧边栏
      '.app-container',   // 主应用容器（登录态专属）
      '.main-container',  // 主内容区
    ];

    let domReady = false;
    for (const sel of SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            ctx.log('info', `[InitWindow][验证] ✓ DOM 检查通过: ${sel} 可见`);
            domReady = true;
            break;
          }
        }
      } catch {
        // 选择器不适用，继续尝试下一个
      }
    }

    if (!domReady) {
      throw new HomepageNotReadyError(
        `核心侧边栏/工作台 DOM 未渲染 (选择器: ${SELECTORS.join(', ')})`
      );
    }

    // ── 检查 3: 页面无可见弹窗 ──
    const POPUP_SELECTORS = [
      '.el-dialog__wrapper',
      '.el-message-box__wrapper',
      '.pay-dialog',
      '.v-modal',  // Element UI 蒙层（通常伴随弹窗）
    ];

    for (const sel of POPUP_SELECTORS) {
      try {
        const elements = await page.$$(sel);
        for (const el of elements) {
          const isVisible = await el.isVisible().catch(() => false);
          if (isVisible) {
            throw new HomepageNotReadyError(`页面存在可见弹窗/蒙层: ${sel}`);
          }
        }
      } catch (e) {
        if (e instanceof HomepageNotReadyError) throw e;
        // 选择器查询失败，跳过
      }
    }
    ctx.log('info', `[InitWindow][验证] ✓ 弹窗检查通过: 无可见弹窗/蒙层`);
  }
}
