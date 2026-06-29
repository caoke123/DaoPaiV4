/**
 * Window Runtime Routes — Phase 4-B
 *
 * 为前端 Header 提供 runtimeMode 感知 + Playwright 窗口状态查询/启动接口。
 *
 * 设计原则：
 *   1. 独立于 routes.ts 业务接口（不修改 routes.ts）
 *   2. 只读复用 SettingsManager / WindowAdapterRegistry / PlaywrightRuntime，不修改核心
 *   3. 不 import EasyBRClient（playwright 模式下 EasyBR 与本路由无关）
 *   4. 返回结构对齐 /api/sites/:siteId/windows，便于前端 WindowStateProvider 复用类型
 *   5. legacy_easybr 模式下前端走原 routes.ts 接口，本路由仅用于 playwright 模式
 *
 * 路由前缀: /api
 *
 * runtimeKey 约定（与 AssignmentEngine.resolvePlaywrightWorkerConnection 保持一致）：
 *   tenantId = 'tenant-default'
 *   siteId   = 内部 Site code（'tiannanda' | 'heyuan'）— 由 settings.json site.name 映射
 *   windowId = `staff-${staffName}`
 *   runtimeKey = `${tenantId}:${siteId}:${windowId}`
 */
import { Router, type Request, type Response } from 'express';
import { getRuntimeMode, type WindowRuntimeMode } from '../config/runtimeMode';
import { SettingsManager } from '../config/SettingsManager';
import { isLoginCapableWindow } from '../config/SettingsManager';
import { WindowAdapterRegistry } from '../window-adapter/WindowAdapterRegistry';
import { PlaywrightRuntime } from '../playwright-runtime/PlaywrightRuntime';
import { DEFAULT_TENANT_ID, buildRuntimeKey } from '../playwright-runtime/types';
import type { Site } from '../db/Database';
import type { AdapterWindowStatus } from '../window-adapter/types';

export const windowRuntimeRouter = Router();

const runtime = PlaywrightRuntime.getInstance();
const adapter = WindowAdapterRegistry.getInstance().getAdapter();

// ── Phase 4-G: 登录弹窗卡死兜底重启 ──
// 每个员工最多重启 1 次，超过后返回 failed / login_required
// ★ Phase 4-I-3: retryKey 改为 siteId:staffName，避免跨站点同名员工串扰
const loginRetryCount = new Map<string, number>();
const MAX_LOGIN_RETRIES = 1;

/**
 * Phase 4-I-3: 生成 loginRetryCount 的隔离 key
 *
 * 格式：`${siteCode}:${staffName}`
 *
 * 作用：避免不同网点同名员工的 retry 计数互相串扰。
 * 所有 loginRetryCount 的 get/set/delete 必须使用此 key。
 */
function getLoginRetryKey(siteCode: string, staffName: string): string {
  return `${siteCode}:${staffName}`;
}

/**
 * Phase 4-G: 判断是否因弹窗卡住导致登录/P0 失败
 *
 * 卡死判定条件（任一满足即判定为卡死）：
 *   - P0 popup_blocking（弹窗遮罩仍然可见）
 *   - 登录超时（20s 内未跳转）
 *   - degraded 且有明确 P0 失败原因
 */
function isLoginDeadlocked(
  p0FailedCheck?: string | null,
  loginMessage?: string,
  loginStatus?: string,
): boolean {
  if (p0FailedCheck === 'popup_blocking') return true;
  if (loginMessage?.includes('20s 内未跳转')) return true;
  if (loginStatus === 'degraded' && p0FailedCheck) return true;
  return false;
}

/**
 * Phase 4-G: 关闭窗口，清除状态，准备重启
 */
async function closeWindowForRetry(
  runtimeKey: string,
  staffName: string,
  siteName: string,
  siteCode: string,
): Promise<void> {
  const retryKey = getLoginRetryKey(siteCode, staffName);
  console.log(`[LoginGuard] 尝试关闭窗口并重新启动：${staffName}（site=${siteCode}），第 ${(loginRetryCount.get(retryKey) ?? 0) + 1} 次`);
  // 关闭浏览器窗口（Phase 4-I-2: 统一 close 事务 + cleanup）
  await runtime.closeWindow(runtimeKey).catch(e => {
    console.warn(`[LoginGuard] 关闭窗口异常（忽略继续）: ${(e as Error).message}`);
  });
  // 清除重试计数中的旧状态
  await new Promise(r => setTimeout(r, 800));
}

/**
 * Phase 4-G: 执行登录 + P0 守卫 + 弹窗卡死兜底重启
 *
 * 流程：
 *   1. 调用 tryAutoLoginAfterEnsure 登录
 *   2. 登录成功后跑 P0 检查
 *   3. 如果因弹窗卡死失败且 retryCount < MAX_LOGIN_RETRIES → 关闭窗口重启一次
 *   4. 重启后重新执行步骤 1-2
 *   5. 如果 retries 耗尽或非卡死失败 → 返回 degraded / login_required
 *
 * @returns { status, message }
 */
async function performLoginWithP0AndRecovery(
  runtimeKey: string,
  staffName: string,
  siteName: string,
  siteCode: string,
): Promise<{ status: string; message?: string }> {
  // Phase 4-I-3: retryKey 按 siteId:staffName 隔离，避免跨站点同名员工串扰
  const retryKey = getLoginRetryKey(siteCode, staffName);

  // 首次登录尝试
  const loginUpdate = await tryAutoLoginAfterEnsure(
    { runtimeKey, status: 'login_required', launched: true },
    staffName,
    siteName,
  );

  if (loginUpdate.status !== 'ready') {
    // 登录失败（如无凭据/密码错误）— 不重启
    return loginUpdate;
  }

  // 登录成功，跑 P0 检查
  console.log(`[playwright-ensure] ${staffName} 登录后状态 ready，触发 P0 守卫检查...`);
  const p0Report = await runP0CheckSafely(runtimeKey, staffName);

  if (!p0Report || p0Report.passed) {
    // P0 通过 → 正常返回 ready
    return { status: 'ready' };
  }

  // P0 失败 → 判断是否为弹窗卡死
  if (!isLoginDeadlocked(p0Report.failedCheck, loginUpdate.loginMessage, undefined)) {
    // 非卡死型失败（如 url_login）→ 不重启，直接返回
    const failedStatus = p0Report.failedCheck === 'url_login' ? 'login_required' : 'degraded';
    console.warn(`[playwright-ensure] ${staffName} P0 未通过（非卡死）→ ${failedStatus} (${p0Report.failedCheck})`);
    return { status: failedStatus, message: `P0 未通过: ${p0Report.failedCheck} - ${p0Report.failedReason}` };
  }

  // ── 弹窗卡死：检查重试次数 ──
  const retryCount = loginRetryCount.get(retryKey) ?? 0;
  if (retryCount >= MAX_LOGIN_RETRIES) {
    console.error(`[LoginGuard] 重启后仍未 READY：${staffName}（site=${siteCode}），原因：${p0Report.failedCheck}（已重启 ${MAX_LOGIN_RETRIES} 次）`);
    loginRetryCount.delete(retryKey);
    return {
      status: 'failed',
      message: `弹窗清理失败，重启后仍未就绪 (${p0Report.failedCheck})`,
    };
  }

  // ── 执行重启 ──
  console.log(`[LoginGuard] 检测到登录后弹窗卡住：${staffName}（site=${siteCode}） (${p0Report.failedCheck}: ${p0Report.failedReason})`);
  loginRetryCount.set(retryKey, retryCount + 1);

  // 1. 关闭当前窗口
  await closeWindowForRetry(runtimeKey, staffName, siteName, siteCode);

  // 2. 重新启动窗口
  const relaunchResult = await adapter.ensureWindowReady({
    tenantId: DEFAULT_TENANT_ID,
    siteId: siteCode,
    windowId: `staff-${staffName}`,
    staffName,
    siteName,
    windowName: staffName,
  });

  if (relaunchResult.status !== 'login_required' && relaunchResult.status !== 'opening') {
    // 重启后状态异常
    console.error(`[LoginGuard] 重启后窗口状态异常：${staffName}（site=${siteCode}），状态=${relaunchResult.status}`);
    loginRetryCount.delete(retryKey);
    return { status: 'failed', message: `重启后窗口状态异常: ${relaunchResult.status}` };
  }

  // 3. 重新登录
  const retryLoginUpdate = await tryAutoLoginAfterEnsure(
    { runtimeKey: relaunchResult.runtimeKey, status: relaunchResult.status, launched: relaunchResult.launched },
    staffName,
    siteName,
  );

  if (retryLoginUpdate.status !== 'ready') {
    console.error(`[LoginGuard] 重启后仍未 READY：${staffName}（site=${siteCode}），原因：${retryLoginUpdate.status}`);
    loginRetryCount.delete(retryKey);
    return { status: 'failed', message: `弹窗清理失败，重启后登录仍未就绪` };
  }

  // 4. 重新跑 P0
  const retryP0Report = await runP0CheckSafely(relaunchResult.runtimeKey, staffName);

  if (retryP0Report && retryP0Report.passed) {
    console.log(`[LoginGuard] 重启后 READY 通过：${staffName}（site=${siteCode}）`);
    loginRetryCount.delete(retryKey);
    return { status: 'ready' };
  }

  // 重启后仍然失败
  const retryFailedCheck = retryP0Report?.failedCheck ?? 'unknown';
  console.error(`[LoginGuard] 重启后仍未 READY：${staffName}（site=${siteCode}），原因：${retryFailedCheck}（已重启 ${MAX_LOGIN_RETRIES} 次）`);
  loginRetryCount.delete(retryKey);
  return { status: 'failed', message: `弹窗清理失败，重启后仍未就绪 (${retryFailedCheck})` };
}

/**
 * Phase 4-G: 安全执行 P0 检查（含异常捕获）
 */
async function runP0CheckSafely(
  runtimeKey: string,
  staffName: string,
): Promise<{ passed: boolean; failedCheck: string; failedReason: string; endUrl: string } | null> {
  try {
    return await runtime.runP0Check(runtimeKey);
  } catch (e) {
    console.error(`[playwright-ensure] ${staffName} P0 检查异常: ${(e as Error).message}`);
    return null;
  }
}

// ── 前端 WindowState 类型对齐（与 frontend/src/api/client.ts 一致） ──
// 本地定义，避免修改 backend/types/api-contracts.ts
type WindowState = 'offline' | 'connecting' | 'login_required' | 'connected' | 'ready' | 'busy' | 'degraded' | 'failed';

/**
 * 将 AdapterWindowStatus 映射为前端 WindowState
 *
 * 映射规则（Phase 4-B）：
 *   closed        → offline      （离线）
 *   opening       → connecting    （启动中）
 *   login_required→ login_required（待登录）
 *   ready         → ready         （就绪）
 *   busy          → busy          （执行中）
 *   failed        → degraded     （异常/不稳定）
 */
function mapAdapterToFrontend(s: AdapterWindowStatus): WindowState {
  switch (s) {
    case 'ready': return 'ready';
    case 'busy': return 'busy';
    case 'login_required': return 'login_required';
    case 'opening': return 'connecting';
    case 'closed': return 'offline';
    case 'failed': return 'degraded';
    default: return 'offline';
  }
}

/**
 * 将 settings.json 的 site.name 映射为内部 Site code
 *
 * 与 routes.ts normalizeSiteToCode 逻辑一致（复制以避免修改 routes.ts）。
 * 用于生成与 AssignmentEngine 一致的 runtimeKey。
 */
function normalizeSiteNameToCode(siteName: string): Site {
  if (siteName.includes('天南大')) return 'tiannanda';
  if (siteName.includes('和苑')) return 'heyuan';
  // 未知站点：回退使用 siteName 本身作为 siteId（与 engine 抛错不同，
  // 这里宽松处理以支持测试站点；运行时找不到窗口状态会显示 offline）
  return siteName as Site;
}

/**
 * 从 SettingsManager 解析明文凭据
 *
 * SettingsManager.loadConfig 已对 password 做 base64 解码，这里直接取明文。
 * 与 PlaywrightRuntime.lookupCredentialFromSettings 逻辑一致（复制以避免修改核心）。
 *
 * 注意：本函数不读取 BNSY_TEST_USERNAME/BNSY_TEST_PASSWORD 环境变量。
 * 凭据来源仅限 settings.json，符合"测试账号通过 settings.json 管理"的约定。
 */
async function resolveCredentialFromSettings(
  staffName: string,
  siteName?: string,
): Promise<{ account: string; password: string } | null> {
  const sm = SettingsManager.getInstance();
  const config = await sm.getConfig();
  if (!config?.sites) return null;

  for (const site of config.sites) {
    if (siteName && site.name !== siteName && site.id !== siteName) continue;
    for (const w of site.windows) {
      if (w.employeeName === staffName || w.windowName === staffName) {
        if (w.username && w.password) {
          return { account: w.username, password: w.password };
        }
      }
    }
  }
  return null;
}

/**
 * 在 adapter.ensureWindowReady 之后触发自动登录
 *
 * Phase 4-B：adapter 层强制 autoLogin=false（不修改 adapter 核心），
 * 因此 ensure 返回 login_required 时由本路由层调用 runtime.manualLogin
 * 完成登录。登录成功后状态由 login_required → ready。
 *
 * 凭据仅从 settings.json 获取（与 PlaywrightRuntime.resolveCredential 一致）。
 *
 * @returns 更新后的状态字符串（'ready' | 'login_required' | 原 status）
 */
async function tryAutoLoginAfterEnsure(
  ensureResult: { runtimeKey: string; status: string; launched: boolean },
  staffName: string,
  siteName: string,
): Promise<{ status: string; loginMessage?: string }> {
  if (ensureResult.status !== 'login_required') {
    return { status: ensureResult.status };
  }

  const cred = await resolveCredentialFromSettings(staffName, siteName);
  if (!cred) {
    return { status: 'login_required', loginMessage: '未找到凭据' };
  }

  try {
    const loginResult = await runtime.manualLogin(ensureResult.runtimeKey, cred);
    if (loginResult.success) {
      console.log(`[autoLogin] ${staffName} 登录成功，状态 ready`);
      return { status: 'ready' };
    }
    console.warn(`[autoLogin] ${staffName} 登录失败: ${loginResult.message}`);
    return { status: 'login_required', loginMessage: loginResult.message };
  } catch (e) {
    console.error(`[autoLogin] ${staffName} 登录异常: ${(e as Error).message}`);
    return { status: 'login_required', loginMessage: (e as Error).message };
  }
}

// ═══════════════════════════════════════════════════════════
// GET /api/runtime-mode — 只读返回当前窗口运行模式
// ═══════════════════════════════════════════════════════════
windowRuntimeRouter.get('/api/runtime-mode', (_req: Request, res: Response) => {
  const runtimeMode: WindowRuntimeMode = getRuntimeMode();
  console.log(`[runtime-mode] mode=${runtimeMode}`);
  res.json({ runtimeMode });
});

// ═══════════════════════════════════════════════════════════
// GET /api/sites/:siteId/playwright-windows — 返回该网点 Playwright 窗口状态
// ═══════════════════════════════════════════════════════════
// 返回结构与 /api/sites/:siteId/windows 对齐（不含 easybrHealth）
// 仅查询 PlaywrightWindowStateStore 缓存，不触发窗口启动
windowRuntimeRouter.get('/api/sites/:siteId/playwright-windows', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const sm = SettingsManager.getInstance();

    // getConfig() 在未初始化时抛 NOT_INITIALIZED，这里优雅降级为空列表
    let config;
    try {
      config = await sm.getConfig();
    } catch {
      return res.json({ siteId, siteName: '', windows: [], runtimeMode: 'playwright' as const });
    }

    if (!config.initialized) {
      return res.json({ siteId, siteName: '', windows: [], runtimeMode: 'playwright' as const });
    }

    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    const siteCode = normalizeSiteNameToCode(site.name);
    // ★ Phase 4-C: 只返回可登录员工（有密码），无密码员工不参与窗口状态管理
    const loginCapableWindows = site.windows.filter(isLoginCapableWindow);
    console.log(`[playwright-windows] siteId=${siteId} siteName=${site.name} siteCode=${siteCode} totalWindows=${site.windows.length} loginCapable=${loginCapableWindows.length}`);

    const windows = loginCapableWindows.map(w => {
      const staffName = w.employeeName || w.windowName;
      const windowId = `staff-${staffName}`;
      const runtimeKey = buildRuntimeKey(DEFAULT_TENANT_ID, siteCode, windowId);

      // 只读取缓存状态，不触发 refreshState（避免每次轮询都打开页面检测）
      const cached = runtime.getWindowStateJSON(runtimeKey);

      let status: WindowState;
      if (!cached) {
        // 窗口未启动 → offline
        status = 'offline';
      } else {
        // 映射 PlaywrightWindowStatus → AdapterWindowStatus → WindowState
        // 复用 adapter 的 mapStatus 收敛逻辑（通过 refreshStatus 不可取，会触发页面检测）
        // 这里直接按 PlaywrightWindowStatus 映射
        const pwStatus = cached.status;
        let adapterStatus: AdapterWindowStatus;
        switch (pwStatus) {
          case 'launching':
          case 'logging_in':
            adapterStatus = 'opening';
            break;
          case 'ready':
            adapterStatus = 'ready';
            break;
          case 'busy':
            adapterStatus = 'busy';
            break;
          case 'login_required':
            adapterStatus = 'login_required';
            break;
          case 'closed':
            adapterStatus = 'closed';
            break;
          case 'error':
            adapterStatus = 'failed';
            break;
          default:
            adapterStatus = 'failed';
        }
        status = mapAdapterToFrontend(adapterStatus);
      }

      console.log(
        `[playwright-windows] ${staffName} | runtimeKey=${runtimeKey} | ` +
        `pwStatus=${cached?.status ?? '(未启动)'} → frontend=${status}`,
      );

      return {
        windowName: w.windowName,
        employeeName: w.employeeName,
        // browserId 在 playwright 模式下无意义，置 null（前端据此跳过 EasyBR open-browser）
        browserId: null,
        status,
        // 标记为 playwright 模式窗口，前端可据此区分点击行为
        runtimeMode: 'playwright' as const,
        runtimeKey,
        // ★ Phase 4-B READY 守卫诊断字段（前端据此收紧 READY 判断）
        currentUrl: cached?.currentUrl ?? '',
        pageCount: cached?.pageCount ?? 0,
        activePageUrl: cached?.activePageUrl ?? cached?.currentUrl ?? '',
        p0Passed: cached?.p0Passed ?? false,
        p0FailedCheck: cached?.p0FailedCheck ?? null,
        p0FailedReason: cached?.p0FailedReason ?? null,
      };
    });

    res.json({
      siteId,
      siteName: site.name,
      windows,
      // playwright 模式下不返回 easybrHealth（EasyBR 不是当前 runtime）
      runtimeMode: 'playwright' as const,
    });
  } catch (e) {
    console.error(`[GET /api/sites/${req.params.siteId}/playwright-windows] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/sites/:siteId/playwright-windows/launch-all — 启动该网点所有 offline 窗口
// ═══════════════════════════════════════════════════════════
// 调用 adapter.ensureWindowReady 启动所有未就绪窗口
// 不依赖 EasyBR，headed=true / keepOpen=true 由 adapter 生命周期保证
windowRuntimeRouter.post('/api/sites/:siteId/playwright-windows/launch-all', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const sm = SettingsManager.getInstance();
    const config = await sm.getConfig();

    if (!config.initialized) {
      return res.status(400).json({ error: '系统尚未完成 PIN 初始化' });
    }

    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    const siteCode = normalizeSiteNameToCode(site.name);
    // ★ Phase 4-C: 只启动可登录员工（有密码），无密码员工不能作为执行窗口
    const loginCapableWindows = site.windows.filter(isLoginCapableWindow);
    const totalWindows = site.windows.length;
    const skippedNoPassword = site.windows.length - loginCapableWindows.length;
    if (skippedNoPassword > 0) {
      console.log(`[playwright-launch-all] 跳过 ${skippedNoPassword} 个无密码员工（仅目标派件员）`);
    }

    // 筛选需要启动的窗口（offline / closed / failed）
    const toLaunch = loginCapableWindows.map(w => {
      const staffName = w.employeeName || w.windowName;
      const windowId = `staff-${staffName}`;
      const runtimeKey = buildRuntimeKey(DEFAULT_TENANT_ID, siteCode, windowId);
      const cached = runtime.getWindowStateJSON(runtimeKey);
      const pwStatus = cached?.status;
      const needsLaunch =
        !cached ||
        pwStatus === 'closed' ||
        pwStatus === 'error' ||
        pwStatus === 'launching' && (Date.now() - cached.lastUpdated > 60_000); // 启动卡住超过 60s 视为需要重启
      return { windowName: w.windowName, staffName, windowId, runtimeKey, needsLaunch, cached };
    });

    const launchTargets = toLaunch.filter(t => t.needsLaunch);
    console.log(`[playwright-launch-all] siteId=${siteId} total=${totalWindows} toLaunch=${launchTargets.length}`);

    const results: {
      windowName: string;
      staffName: string;
      runtimeKey: string;
      status: string;
      ready: boolean;
      message?: string;
    }[] = [];

    let launched = 0;
    let failed = 0;
    let ready = 0;

    // 串行启动（避免并发启动多个 Chrome 实例导致资源竞争）
    for (const target of launchTargets) {
      try {
        const r = await adapter.ensureWindowReady({
          tenantId: DEFAULT_TENANT_ID,
          siteId: siteCode,
          windowId: target.windowId,
          staffName: target.staffName,
          siteName: site.name,
          windowName: target.windowName,
        });

        // Phase 4-G：登录 + P0 守卫 + 弹窗卡死兜底重启
        const loginResult = await performLoginWithP0AndRecovery(
          r.runtimeKey,
          target.staffName,
          site.name,
          siteCode,
        );
        const finalStatus = loginResult.status;

        const isReady = finalStatus === 'ready';
        if (isReady) ready++;
        if (r.launched) launched++;
        results.push({
          windowName: target.windowName,
          staffName: target.staffName,
          runtimeKey: target.runtimeKey,
          status: finalStatus,
          ready: isReady,
          message: loginResult.message || r.message,
        });
        console.log(`[playwright-launch-all] ${target.staffName} ensure=${r.status} final=${finalStatus} launched=${r.launched} ready=${isReady}`);
      } catch (e) {
        failed++;
        const errMsg = (e as Error).message;
        results.push({
          windowName: target.windowName,
          staffName: target.staffName,
          runtimeKey: target.runtimeKey,
          status: 'failed',
          ready: false,
          message: errMsg,
        });
        console.error(`[playwright-launch-all] ${target.staffName} 启动失败: ${errMsg}`);
      }
    }

    // 已就绪窗口（无需启动）也计入 ready
    for (const t of toLaunch.filter(t => !t.needsLaunch)) {
      const status = mapAdapterToFrontend(
        (() => {
          switch (t.cached!.status) {
            case 'launching':
            case 'logging_in': return 'opening';
            case 'ready': return 'ready';
            case 'busy': return 'busy';
            case 'login_required': return 'login_required';
            case 'closed': return 'closed';
            case 'error': return 'failed';
            default: return 'failed';
          }
        })(),
      );
      if (status === 'ready') ready++;
      results.push({
        windowName: t.windowName,
        staffName: t.staffName,
        runtimeKey: t.runtimeKey,
        status,
        ready: status === 'ready',
      });
    }

    const success = failed === 0 && ready === totalWindows;
    const message = failed > 0
      ? `启动完成（成功 ${launched}，失败 ${failed}）`
      : `启动完成（已就绪 ${ready}/${totalWindows}）`;

    res.json({
      launched,
      failed,
      partial: failed > 0 ? 1 : 0,
      total: totalWindows,
      timeout: false,
      success,
      message,
      windows: results,
      runtimeMode: 'playwright' as const,
    });
  } catch (e) {
    console.error(`[POST /api/sites/${req.params.siteId}/playwright-windows/launch-all] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/sites/:siteId/playwright-windows/ensure — 单窗口 ensure-ready
// ═══════════════════════════════════════════════════════════
// Body: { staffName }
// 启动单个员工的 Chrome 窗口（headed=true, keepOpen=true 由 adapter 保证）
windowRuntimeRouter.post('/api/sites/:siteId/playwright-windows/ensure', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const { staffName } = req.body || {};
    if (!staffName || typeof staffName !== 'string') {
      return res.status(400).json({ error: '缺少 staffName 参数' });
    }

    const sm = SettingsManager.getInstance();
    const config = await sm.getConfig();
    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    const siteCode = normalizeSiteNameToCode(site.name);
    const windowId = `staff-${staffName}`;
    const runtimeKey = buildRuntimeKey(DEFAULT_TENANT_ID, siteCode, windowId);

    // 查找窗口配置（用于 windowName）
    const w = site.windows.find(win => (win.employeeName || win.windowName) === staffName);

    // ★ Phase 4-C: 无密码员工不能作为执行窗口启动
    if (w && !isLoginCapableWindow(w)) {
      return res.status(400).json({
        error: '该员工未配置登录密码，不能作为执行窗口启动',
        staffName,
        success: false,
        launched: false,
      });
    }

    const result = await adapter.ensureWindowReady({
      tenantId: DEFAULT_TENANT_ID,
      siteId: siteCode,
      windowId,
      staffName,
      siteName: site.name,
      windowName: w?.windowName,
    });

    // ── Phase 4-G: 登录 + P0 守卫 + 弹窗卡死兜底重启 ──
    // 先检查 busy 状态（busy 窗口不允许重启）
    const currentState = runtime.getWindowStateJSON(result.runtimeKey);
    if (currentState?.status === 'busy') {
      console.log(`[LoginGuard] ${staffName} 窗口 busy，跳过登录和重启`);
      return res.json({
        success: true,
        runtimeKey: result.runtimeKey,
        status: 'busy',
        ready: false,
        launched: false,
        currentUrl: currentState.currentUrl,
        isLoggedIn: currentState.isLoggedIn,
        message: '窗口正忙，被其他任务占用',
        runtimeMode: 'playwright' as const,
        pageCount: currentState.pageCount ?? 0,
        activePageUrl: currentState.activePageUrl ?? '',
        p0Passed: currentState.p0Passed ?? false,
        p0FailedCheck: currentState.p0FailedCheck ?? null,
        p0FailedReason: currentState.p0FailedReason ?? null,
      });
    }

    // Phase 4-G: 登录 + 兜底重启（最多 MAX_LOGIN_RETRIES 次）
    const loginResult = await performLoginWithP0AndRecovery(
      result.runtimeKey,
      staffName,
      site.name,
      siteCode,
    );

    // 读取最新 state（含 P0 诊断字段）
    const finalState = runtime.getWindowStateJSON(result.runtimeKey);

    console.log(`[playwright-ensure] staffName=${staffName} ensure=${result.status} final=${loginResult.status} launched=${result.launched} ready=${loginResult.status === 'ready'} p0Passed=${finalState?.p0Passed ?? false}`);

    res.json({
      success: loginResult.status === 'ready' || loginResult.status === 'login_required' || loginResult.status === 'busy',
      runtimeKey: result.runtimeKey,
      status: loginResult.status,
      ready: loginResult.status === 'ready',
      launched: result.launched,
      currentUrl: finalState?.currentUrl ?? result.currentUrl,
      isLoggedIn: finalState?.isLoggedIn ?? result.isLoggedIn,
      message: loginResult.message || result.message,
      runtimeMode: 'playwright' as const,
      // ★ Phase 4-B READY 守卫诊断字段
      pageCount: finalState?.pageCount ?? 0,
      activePageUrl: finalState?.activePageUrl ?? '',
      p0Passed: finalState?.p0Passed ?? false,
      p0FailedCheck: finalState?.p0FailedCheck ?? null,
      p0FailedReason: finalState?.p0FailedReason ?? null,
    });
  } catch (e) {
    console.error(`[POST /api/sites/${req.params.siteId}/playwright-windows/ensure] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/sites/:siteId/playwright-windows/close — Phase 4-D 关闭窗口
// ═══════════════════════════════════════════════════════════
// Body: { staffName }
// 关闭指定员工的 Chrome 窗口（仅关闭浏览器窗口，不删除配置）
windowRuntimeRouter.post('/api/sites/:siteId/playwright-windows/close', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.params;
    const { staffName } = req.body || {};
    if (!staffName || typeof staffName !== 'string') {
      return res.status(400).json({ error: '缺少 staffName 参数' });
    }

    const sm = SettingsManager.getInstance();
    const config = await sm.getConfig();
    const site = config.sites.find(s => s.id === siteId);
    if (!site) {
      return res.status(404).json({ error: `网点 ${siteId} 未配置` });
    }

    const siteCode = normalizeSiteNameToCode(site.name);
    const windowId = `staff-${staffName}`;
    const runtimeKey = buildRuntimeKey(DEFAULT_TENANT_ID, siteCode, windowId);

    // 检查是否为 busy 状态
    const state = runtime.getWindowStateJSON(runtimeKey);
    if (state?.status === 'busy') {
      return res.status(409).json({
        success: false,
        error: `窗口 ${staffName} 正在执行任务，不能关闭`,
      });
    }

    const result = await runtime.closeWindow(runtimeKey);
    console.log(`[POST /playwright-windows/close] ${staffName} runtimeKey=${runtimeKey} success=${result.success} alreadyClosed=${result.alreadyClosed}`);

    res.json({
      success: result.success,
      alreadyClosed: result.alreadyClosed ?? false,
      status: result.status,
    });
  } catch (e) {
    console.error(`[POST /api/sites/${req.params.siteId}/playwright-windows/close] 失败:`, (e as Error).message);
    res.status(500).json({ error: (e as Error).message });
  }
});
