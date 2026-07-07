/**
 * PlaywrightWindowAdapter — Phase 2-A 兼容适配层
 *
 * 位于上层业务（未来 Handlers）与底层 PlaywrightRuntime 之间。
 *
 * 职责：
 *   1. 包装 PlaywrightRuntime，提供更稳定的接口给上层
 *   2. 强制 tenantId + siteId + windowId 三元组，禁止只传 windowId
 *   3. 遵守 Phase 1-C 窗口生命周期策略：
 *      - 任务完成后 markReady 不关闭 context
 *      - busy 状态不被误抢占
 *      - closeWindow 只用于用户主动关闭或系统关闭
 *   4. 状态码收敛为 AdapterWindowStatus（launching/logging_in → opening, error → failed）
 *
 * 不允许：
 *   - import EasyBRClient
 *   - 调用 connectOverCDP
 *   - 反向依赖 legacy BrowserPool
 */
import { PlaywrightRuntime } from '../playwright-runtime/PlaywrightRuntime';
import { buildRuntimeKey, type PlaywrightWindowStatus } from '../playwright-runtime/types';
import type {
  WindowAdapterOptions,
  WindowReadyResult,
  WorkerPageResult,
  WindowStatusResult,
  AdapterCloseResult,
  AdapterWindowStatus,
  MarkResult,
} from './types';

/**
 * 将 PlaywrightWindowStatus 映射为 AdapterWindowStatus
 *
 * 收敛规则：
 *   launching / logging_in → 'opening'（上层不需要区分启动中和登录中）
 *   error                  → 'failed'
 *   其他                   → 同名
 */
function mapStatus(status: PlaywrightWindowStatus): AdapterWindowStatus {
  switch (status) {
    case 'launching':
    case 'logging_in':
      return 'opening';
    case 'ready':
      return 'ready';
    case 'busy':
      return 'busy';
    case 'login_required':
      return 'login_required';
    case 'closed':
      return 'closed';
    case 'error':
      return 'failed';
    default:
      return 'failed';
  }
}

export class PlaywrightWindowAdapter {
  private runtime: PlaywrightRuntime;

  constructor(runtime: PlaywrightRuntime = PlaywrightRuntime.getInstance()) {
    this.runtime = runtime;
  }

  /**
   * 确保窗口就绪
   *
   * 行为：
   *   1. 如果窗口不存在 → 调用 launchWindow 启动（launched=true）
   *   2. 如果窗口存在 → refreshState 实时检测状态（launched=false）
   *   3. 如果窗口状态为 closed/failed → 重新启动（复用同一 userDataDir，launched=true）
   *   4. 返回当前状态：
   *      - ready：可直接执行任务
   *      - login_required：需要手动登录，不假装 ready
   *      - busy：被其他任务占用，不抢占
   *      - opening：正在启动/登录中
   *
   * 注意：本方法不会自动登录。如果需要自动登录，由上层业务调用 manualLogin。
   */
  async ensureWindowReady(options: WindowAdapterOptions): Promise<WindowReadyResult> {
    const { tenantId, siteId, windowId } = options;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);
    const tag = `[WindowAdapter/${runtimeKey}]`;

    // 1. 检查窗口是否已存在
    const existing = this.runtime.getWindowStateJSON(runtimeKey);
    if (!existing) {
      // 窗口不存在 → 启动
      console.log(`${tag} 窗口不存在，启动新窗口...`);
      const launchResult = await this.runtime.launchWindow({
        tenantId,
        siteId,
        windowId,
        windowName: options.windowName,
        staffName: options.staffName,
        siteName: options.siteName,
        headless: false,
        autoLogin: false, // 适配层不自动登录，由上层决定
      });

      if (!launchResult.success || !launchResult.state) {
        console.error(`${tag} 启动失败: ${launchResult.error}`);
        return {
          runtimeKey,
          status: 'failed',
          userDataDir: '',
          launched: true,
          message: launchResult.error || '启动失败',
        };
      }

      const state = launchResult.state;
      return {
        runtimeKey,
        status: mapStatus(state.status),
        userDataDir: state.userDataDir,
        launched: true,
        currentUrl: state.currentUrl,
        isLoggedIn: state.isLoggedIn,
        message: state.status === 'login_required' ? '需要登录' : undefined,
      };
    }

    // 2. 窗口已存在 → 实时刷新状态
    console.log(`${tag} 窗口已存在，刷新状态...`);
    const refreshResult = await this.runtime.refreshState(runtimeKey);
    if (refreshResult.notFound || !refreshResult.state) {
      // ★ Phase 4-I-2: refreshState notFound 说明 page/context 已被清理
      //   典型场景：closeWindow 后 state.status='closed' 但 page=undefined
      //   此时不能直接返回 failed，需要按 existing.status 判断是否需要重启
      const existingStatus = mapStatus(existing.status);
      if (existingStatus === 'closed' || existingStatus === 'failed') {
        console.log(`${tag} 窗口状态为 ${existingStatus}（page 已清理），重新启动...`);
        const launchResult = await this.runtime.launchWindow({
          tenantId,
          siteId,
          windowId,
          windowName: options.windowName,
          staffName: options.staffName,
          siteName: options.siteName,
          headless: false,
          autoLogin: false,
        });

        if (!launchResult.success || !launchResult.state) {
          console.error(`${tag} 重新启动失败: ${launchResult.error}`);
          return {
            runtimeKey,
            status: 'failed',
            userDataDir: existing.userDataDir,
            launched: true,
            message: launchResult.error || '重新启动失败',
          };
        }

        const newState = launchResult.state;
        return {
          runtimeKey,
          status: mapStatus(newState.status),
          userDataDir: newState.userDataDir,
          launched: true,
          currentUrl: newState.currentUrl,
          isLoggedIn: newState.isLoggedIn,
          message: newState.status === 'login_required' ? '需要登录' : undefined,
        };
      }
      // 其他状态（ready/busy 等）下 page 丢失 → 真正异常
      return {
        runtimeKey,
        status: 'failed',
        userDataDir: existing.userDataDir,
        launched: false,
        message: '窗口状态刷新失败',
      };
    }

    const state = refreshResult.state;
    const adapterStatus = mapStatus(state.status);

    // 3. 窗口已关闭或失败 → 重新启动（复用同一 userDataDir，可保持登录态）
    //    符合 Phase 1-C 窗口生命周期策略：closeWindow 后允许通过 ensureWindowReady 重启
    if (adapterStatus === 'closed' || adapterStatus === 'failed') {
      console.log(`${tag} 窗口状态为 ${adapterStatus}，重新启动...`);
      const launchResult = await this.runtime.launchWindow({
        tenantId,
        siteId,
        windowId,
        windowName: options.windowName,
        staffName: options.staffName,
        siteName: options.siteName,
        headless: false,
        autoLogin: false, // 适配层不自动登录，由上层决定
      });

      if (!launchResult.success || !launchResult.state) {
        console.error(`${tag} 重新启动失败: ${launchResult.error}`);
        return {
          runtimeKey,
          status: 'failed',
          userDataDir: state.userDataDir,
          launched: true,
          message: launchResult.error || '重新启动失败',
        };
      }

      const newState = launchResult.state;
      return {
        runtimeKey,
        status: mapStatus(newState.status),
        userDataDir: newState.userDataDir,
        launched: true,
        currentUrl: newState.currentUrl,
        isLoggedIn: newState.isLoggedIn,
        message: newState.status === 'login_required' ? '需要登录' : undefined,
      };
    }

    // 4. 其他状态（ready / login_required / busy / opening）→ 直接返回
    // ★ Phase 4-B：READY 守卫 — 如果状态是 ready 但 P0 未通过，显式跑 P0
    //    场景：用户手动登录后 refreshState 把状态改为 ready，但 P0 未校验
    if (adapterStatus === 'ready' && state.p0Passed !== true) {
      console.log(`${tag} 状态 ready 但 P0 未通过（p0Passed=${state.p0Passed}），执行 P0 检查...`);
      const p0Report = await this.runtime.runP0Check(runtimeKey);
      if (!p0Report.passed) {
        // P0 failed → 不返回 ready，根据失败原因返回 login_required 或 failed
        const failedStatus: AdapterWindowStatus = p0Report.failedCheck === 'url_login' ? 'login_required' : 'failed';
        console.warn(`${tag} P0 未通过 → status=${failedStatus} (${p0Report.failedCheck}: ${p0Report.failedReason})`);
        return {
          runtimeKey,
          status: failedStatus,
          userDataDir: state.userDataDir,
          launched: false,
          currentUrl: p0Report.endUrl,
          isLoggedIn: false,
          message: `P0 未通过: ${p0Report.failedCheck} - ${p0Report.failedReason}`,
        };
      }
      // P0 passed → 重新读取 state（runP0Check 已更新 p0Passed/pageCount 等）
      const updatedState = this.runtime.getWindowStateJSON(runtimeKey);
      if (updatedState) {
        return {
          runtimeKey,
          status: 'ready',
          userDataDir: updatedState.userDataDir,
          launched: false,
          currentUrl: updatedState.currentUrl,
          isLoggedIn: updatedState.isLoggedIn,
          message: undefined,
        };
      }
    }

    let message: string | undefined;
    if (adapterStatus === 'login_required') message = '需要登录';
    else if (adapterStatus === 'busy') message = '窗口正忙，被其他任务占用';
    else if (adapterStatus === 'opening') message = '窗口正在启动或登录中';

    return {
      runtimeKey,
      status: adapterStatus,
      userDataDir: state.userDataDir,
      launched: false,
      currentUrl: state.currentUrl,
      isLoggedIn: state.isLoggedIn,
      message,
    };
  }

  /**
   * 获取 worker page（进程内调用，不通过 HTTP 返回）
   *
   * 行为：
   *   1. 检查窗口是否存在，不存在返回 status='closed' + message
   *   2. 检查状态：
   *      - ready → 返回 page
   *      - busy → 返回 page（允许同任务继续操作）+ message 提示
   *      - login_required → 不返回 page，提示需要登录
   *      - opening → 不返回 page，提示等待
   *      - closed/failed → 不返回 page
   *
   * 注意：本方法不会抢占 busy 窗口。如果窗口是其他任务标记的 busy，
   * 上层应先检查 status 再决定是否使用 page。
   */
  async getWorkerPage(options: WindowAdapterOptions): Promise<WorkerPageResult> {
    const { tenantId, siteId, windowId } = options;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);

    const state = this.runtime.getWindowStateJSON(runtimeKey);
    if (!state) {
      return {
        runtimeKey,
        status: 'closed',
        message: `窗口 ${runtimeKey} 不存在或未启动`,
      };
    }

    const adapterStatus = mapStatus(state.status);
    const page = this.runtime.getPage(runtimeKey);

    if (adapterStatus === 'ready' || adapterStatus === 'busy') {
      return {
        runtimeKey,
        status: adapterStatus,
        page,
        currentUrl: state.currentUrl,
        isLoggedIn: state.isLoggedIn,
        message: adapterStatus === 'busy' ? '窗口当前为 busy 状态' : undefined,
      };
    }

    // 非 ready/busy 状态不返回 page
    let message: string;
    switch (adapterStatus) {
      case 'login_required':
        message = '需要登录后才能获取 page';
        break;
      case 'opening':
        message = '窗口正在启动或登录中，请稍后';
        break;
      case 'closed':
        message = '窗口已关闭';
        break;
      case 'failed':
        message = '窗口状态异常';
        break;
      default:
        message = '窗口不可用';
    }

    return {
      runtimeKey,
      status: adapterStatus,
      currentUrl: state.currentUrl,
      isLoggedIn: state.isLoggedIn,
      message,
    };
  }

  /**
   * 标记窗口为 busy（任务开始前调用）
   *
   * 行为：
   *   - 窗口不存在 → 返回 notFound
   *   - 窗口已关闭 → 返回 success=false
   *   - 窗口已是 busy → 幂等返回 success=true
   *   - 其他状态 → 设置为 busy
   */
  async markBusy(runtimeKey: string): Promise<MarkResult> {
    const result = await this.runtime.markBusy(runtimeKey);
    if (result.notFound) {
      return { success: false, runtimeKey, status: 'closed', message: result.message };
    }
    if (!result.success) {
      return {
        success: false,
        runtimeKey,
        status: result.status ? mapStatus(result.status) : 'failed',
        message: result.message,
      };
    }
    return {
      success: true,
      runtimeKey,
      status: result.status ? mapStatus(result.status) : 'busy',
      message: result.message,
    };
  }

  /**
   * 标记窗口为 ready（任务结束后调用）
   *
   * **不关闭 context**，窗口保持打开。
   * 遵循 Phase 1-C 窗口生命周期策略。
   */
  async markReady(runtimeKey: string): Promise<MarkResult> {
    const result = await this.runtime.markReady(runtimeKey);
    if (result.notFound) {
      return { success: false, runtimeKey, status: 'closed', message: result.message };
    }
    if (!result.success) {
      return {
        success: false,
        runtimeKey,
        status: result.status ? mapStatus(result.status) : 'failed',
        message: result.message,
      };
    }
    return {
      success: true,
      runtimeKey,
      status: result.status ? mapStatus(result.status) : 'ready',
      message: result.message,
    };
  }

  /**
   * 刷新窗口状态（实时检测 page，更新缓存）
   */
  async refreshStatus(options: WindowAdapterOptions): Promise<WindowStatusResult> {
    const { tenantId, siteId, windowId } = options;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);

    const refreshResult = await this.runtime.refreshState(runtimeKey);
    if (refreshResult.notFound || !refreshResult.state) {
      return {
        runtimeKey,
        status: 'closed',
        userDataDir: '',
        message: undefined,
      } as WindowStatusResult;
    }

    const state = refreshResult.state;
    return {
      runtimeKey,
      status: mapStatus(state.status),
      userDataDir: state.userDataDir,
      currentUrl: state.currentUrl,
      isLoggedIn: state.isLoggedIn,
      isLoginPage: state.isLoginPage,
      lastUpdated: state.lastUpdated,
    };
  }

  /**
   * 关闭窗口（幂等）
   *
   * 仅用于：
   *   - 用户主动关闭
   *   - 系统退出（优雅停机）
   *   - 浏览器异常
   *   - 管理员操作
   *
   * **不用于任务完成**。任务完成后应调用 markReady。
   */
  async closeWindow(options: WindowAdapterOptions): Promise<AdapterCloseResult> {
    const { tenantId, siteId, windowId } = options;
    const runtimeKey = buildRuntimeKey(tenantId, siteId, windowId);

    const result = await this.runtime.closeWindow(runtimeKey);
    return {
      success: result.success,
      alreadyClosed: result.alreadyClosed,
      status: mapStatus(result.status),
      runtimeKey,
    };
  }
}
