import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, ChevronDown, RotateCw, X, AlertTriangle, LogOut, Trash2,
} from 'lucide-react';
import { useAuth } from '../../stores/authStore';
import {
  launchAllPlaywrightWindows,
  ensurePlaywrightWindow,
  getTaskProgress,
  closePlaywrightWindow,
  resetAllTasks,
  type PlaywrightSiteWindowState,
} from '../../api/client';
import { useWindowState } from '../shared/WindowStateProvider';
import { useTaskExecution } from '../shared/TaskExecutionContext';
import {
  getWindowDisplayStatus,
  canCloseWindow,
  getWindowStatusLabel,
  getWindowKey,
  type DisplayStatus,
} from '../../lib/window-status';

// ═══════ VERSION: v9 — Phase 4-I-3 统一 launch / launch-all 状态流 ═══════
// Phase 4-I-1: 统一窗口状态 Helper（getWindowDisplayStatus）
// Phase 4-I-2: 统一 close 事务（clearRuntimeStateForClose）
// Phase 4-I-3: initializingTasks key 改用 getWindowKey(siteId, employeeName)
//             单窗口/一键启动/close 清理/TTL 清理统一使用 windowKey

interface HeaderProps {
  sidebarCollapsed?: boolean;
}

export default function Header({ sidebarCollapsed }: HeaderProps) {
  const [time, setTime] = useState(new Date());

  // ── 统一状态（来自 WindowStateProvider） ──
  const {
    sites, activeSiteId, setActiveSiteId,
    siteWindows, siteName,
    browserRuntimeStatus, browserRuntimeError,
    refresh: fetchSiteWindows,
    configError,
    runtimeMode, isPlaywright,
  } = useWindowState();

  // ★ P0 安全加固：任务运行中禁止切换站点，防止 UI 当前站点与运行中任务错位
  const { liveStatus } = useTaskExecution();

  // Phase 3-D: 用户认证状态
  const { user, isAuthenticated, logout } = useAuth();

  // ── 初始化中窗口映射 (windowKey → marker/taskId) ──
  // Phase 4-I-3: key 统一使用 getWindowKey(activeSiteId, employeeName) = `${siteId}:${employeeName}`
  //   - 消除跨站点同名员工串扰
  //   - 单窗口/一键启动/close 清理/TTL 清理统一使用同一 key
  const [showSiteSwitcher, setShowSiteSwitcher] = useState(false);
  const [initializingTasks, setInitializingTasks] = useState<Map<string, string>>(new Map());
  const [launching, setLaunching] = useState(false);
  const [launchMsg, setLaunchMsg] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Phase K-3A-2-Prep: 任务重置
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState('');
  const [resetError, setResetError] = useState('');

  const { resetTask } = useTaskExecution();

  // 手动点击刷新按钮：带 loading 视觉反馈
  // 最小显示 400ms，避免请求太快导致旋转动画一闪而过无法感知
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        fetchSiteWindows(),
        new Promise(resolve => setTimeout(resolve, 400)),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, fetchSiteWindows]);

  // Phase K-3A-2-Prep: 清除所有任务数据
  const handleResetTasks = useCallback(async () => {
    if (resetting) return;
    setResetting(true);
    setResetError('');
    setResetMsg('');
    try {
      const result = await resetAllTasks();
      setResetMsg(result.message || '任务数据已清理');
      // 清空前端任务状态
      resetTask();
      // 刷新窗口状态
      await fetchSiteWindows();
    } catch (err) {
      setResetError((err as Error).message || '清理失败');
    } finally {
      setResetting(false);
      setShowResetConfirm(false);
    }
  }, [resetting, resetTask, fetchSiteWindows]);

  // 点击重置按钮：弹出确认框
  const handleResetClick = useCallback(() => {
    setResetError('');
    setResetMsg('');
    setShowResetConfirm(true);
  }, []);

  // ── Phase 4-I-3: 统一 windowKey 与 mark/clear 辅助函数 ──
  //   单窗口启动 / 一键启动 / close 清理 都调用同一组函数，避免 key 不一致
  const getWindowKeyForSw = useCallback((sw: PlaywrightSiteWindowState): string => {
    const staffName = sw.employeeName || sw.windowName;
    return getWindowKey(activeSiteId, staffName);
  }, [activeSiteId]);

  const markInitializing = useCallback((sw: PlaywrightSiteWindowState, marker: string) => {
    const key = getWindowKeyForSw(sw);
    setInitializingTasks(prev => {
      if (prev.get(key) === marker) return prev;
      const next = new Map(prev);
      next.set(key, marker);
      return next;
    });
  }, [getWindowKeyForSw]);

  const clearInitializing = useCallback((sw: PlaywrightSiteWindowState) => {
    const key = getWindowKeyForSw(sw);
    setInitializingTasks(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, [getWindowKeyForSw]);

  // ── Phase 4-D: 悬浮窗口名（用于显示关闭按钮）──
  const [hoveredWindow, setHoveredWindow] = useState<string | null>(null);

  // polling refs
  const taskPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const launchMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const launchCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [launchCooldown, setLaunchCooldown] = useState(false);

  // ── 轮询初始化中任务状态（仅以task.status为依据，不做前端超时熔断） ──
  // playwright 模式的 'pw-ensure' / 'pw-launch-all' 条目为同步 ensure 调用，不走任务轮询
  const pollInitTasks = useCallback(async () => {
    if (initializingTasks.size === 0) return;

    const pending = new Map(initializingTasks);

    for (const [key, taskId] of pending) {
      if (!taskId) continue;
      // playwright 模式单窗口 ensure / launch-all 不产生 taskId，跳过轮询（由 handler 显式清除标记）
      if (taskId.startsWith('pw-')) continue;

      try {
        const progress = await getTaskProgress(taskId);
        if (progress.status === 'done' || progress.status === 'failed' || progress.status === 'cancelled') {
          setInitializingTasks(prev => {
            if (!prev.has(key)) return prev;
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
          fetchSiteWindows();
        }
      } catch { /* 继续轮询 */ }
    }
  }, [initializingTasks, fetchSiteWindows]);

  useEffect(() => {
    taskPollRef.current = setInterval(pollInitTasks, 3000);
    return () => {
      if (taskPollRef.current) clearInterval(taskPollRef.current);
    };
  }, [pollInitTasks]);

  // ★ Phase 4-I-3: TTL 自动释放 — 当 siteWindows 更新时清理 stale initializingTasks
  //   统一规则（不再区分 pw- / legacy）：
  //   - offline → 总是清理（窗口已关闭）
  //   - 后端终态（ready/busy/login_required/failed/degraded）→ 立即清理
  //     * 实现一键启动"先 ready 先变绿"：后端终态优先于 initializing 标记
  //     * getWindowDisplayStatus 的优先级已保证 UI 显示终态，这里清理是状态卫生
  //   - pw-ensure 标记也在此清理，避免 handleInitWindow 异常路径遗漏
  useEffect(() => {
    if (initializingTasks.size === 0) return;
    let changed = false;
    const next = new Map(initializingTasks);
    for (const sw of siteWindows) {
      const key = getWindowKeyForSw(sw);
      if (!next.has(key)) continue;
      const marker = next.get(key) ?? '';

      // offline — 总是清理（窗口已关闭）
      if (sw.status === 'offline') {
        next.delete(key);
        changed = true;
        continue;
      }
      // 后端终态 → 立即清理（实现逐个窗口独立释放）
      if (sw.status === 'ready' || sw.status === 'busy' ||
          sw.status === 'login_required' || sw.status === 'failed' ||
          sw.status === 'degraded') {
        next.delete(key);
        changed = true;
        continue;
      }
      // stale 空 marker 在 connecting 状态也清理（无 taskId 可轮询）
      if (!marker && sw.status === 'connecting') {
        next.delete(key);
        changed = true;
      }
    }
    if (changed) setInitializingTasks(next);
  }, [siteWindows, initializingTasks, getWindowKeyForSw]);

  // ── 时钟 ──
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── 显示提示后自动清除 ──
  useEffect(() => {
    if (launchMsg) {
      launchMsgTimer.current = setTimeout(() => setLaunchMsg(''), 5000);
      return () => {
        if (launchMsgTimer.current) clearTimeout(launchMsgTimer.current);
      };
    }
  }, [launchMsg]);

  useEffect(() => {
    return () => {
      if (launchCooldownRef.current) clearTimeout(launchCooldownRef.current);
    };
  }, []);

  // ── 派生数据 ──
  const activeSite = sites.find(s => s.id === activeSiteId);
  const displaySiteName = activeSite?.name || siteName || activeSiteId;

  // ── 获取单个窗口的显示状态 ──
  // Phase 4-I-1: 统一使用 lib/window-status.ts 的 getWindowDisplayStatus
  //   优先级：busy > 后端终态 > initializing（仅过渡态）> connecting > offline
  //   ready 经 isPlaywrightReallyReady 守卫降级
  // Phase 4-I-3: initializingTasks key 已统一为 getWindowKey(siteId, employeeName)
  const getEffectiveStatus = (w: PlaywrightSiteWindowState): DisplayStatus => {
    return getWindowDisplayStatus(w, {
      isPlaywright,
      isInitializing: initializingTasks.has(getWindowKeyForSw(w)),
    });
  };

  // ── 单点初始化窗口 ──
  const handleInitWindow = async (sw: PlaywrightSiteWindowState) => {
    const staffName = sw.employeeName || sw.windowName;

    markInitializing(sw, 'pw-ensure');
    try {
        const res = await ensurePlaywrightWindow(activeSiteId, staffName);
        setLaunchMsg(
          res.ready ? `Chrome 已就绪：${staffName}`
          : res.status === 'login_required' ? `需登录：${staffName}`
          : res.status === 'busy' ? `窗口执行中：${staffName}`
          : res.status === 'failed' ? `弹窗清理失败：${staffName}`
          : `启动中：${staffName} (${res.status})`,
        );
        clearInitializing(sw);
        await fetchSiteWindows();
      } catch (e) {
        console.error(`[playwright-ensure] ${sw.windowName} 启动失败:`, e);
        setLaunchMsg(`Chrome 启动失败 ${staffName}: ${(e as Error).message}`);
        clearInitializing(sw);
    }
  };

  // ── 一键启动 ──
  const handleLaunchAll = async () => {
    if (launching || launchCooldown || !activeSiteId) return;
    if (launchCooldownRef.current) {
      clearTimeout(launchCooldownRef.current);
      launchCooldownRef.current = null;
    }
    setLaunching(true);
    setLaunchMsg('');

    // ★ Phase 4-I-3: 标记所有待启动窗口为启动中（蓝色 loading）
    //   使用统一 markInitializing（windowKey），与单窗口启动同源
    //   TTL 清理会在各窗口后端进入终态时逐个清理标记，实现"先 ready 先变绿"
    const launchTargets = isPlaywright
      ? siteWindows.filter(w => w.status === 'offline' || w.status === 'degraded' || w.status === 'login_required')
      : siteWindows.filter(w => w.status === 'offline');
    launchTargets.forEach(w => markInitializing(w, 'pw-launch-all'));

    // ★ Phase 4-I-3: 统一清理所有 pw-launch-all 标记（兜底）
    //   正常情况下 TTL 清理已逐个清理，这里处理 API 返回后的残留
    const clearLaunchMarks = () => {
      setInitializingTasks(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, marker] of prev) {
          if (marker === 'pw-launch-all') {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    try {
      // V3 统一使用 Playwright 模式窗口管理（EasyBR legacy 已移除）
      const res = await launchAllPlaywrightWindows(activeSiteId);
      setLaunchMsg(res.message);
      // await 确保状态立即同步，不等下一轮 polling
      await fetchSiteWindows();

      // 启动完成 → 清理所有残留 launch-all 标记
      clearLaunchMarks();

      if (res.timeout || (res.failed === 0 && res.partial > 0 && res.launched === 0)) {
        setLaunchCooldown(true);
        launchCooldownRef.current = setTimeout(() => {
          setLaunchCooldown(false);
          launchCooldownRef.current = null;
        }, 12000);
        setLaunching(false);
        return;
      }

      if (res.partial > 0 || res.failed > 0) {
        setLaunchCooldown(true);
        launchCooldownRef.current = setTimeout(() => {
          setLaunchCooldown(false);
          launchCooldownRef.current = null;
        }, 5000);
      }
    } catch (e) {
      const msg = (e as Error).message || '请求失败';
      setLaunchMsg(`启动失败: ${msg}`);
      console.error('[Header] 一键启动失败:', e);
      // 异常时也清理标记
      clearLaunchMarks();
      setLaunchCooldown(true);
      launchCooldownRef.current = setTimeout(() => {
        setLaunchCooldown(false);
        launchCooldownRef.current = null;
      }, 3000);
    } finally {
      setLaunching(false);
    }
  };

  // ── 关闭窗口 — Phase 4-I-2 close 事务 + Phase 4-I-3 统一 windowKey ──
  const handleCloseWindow = async (sw: PlaywrightSiteWindowState, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const staffName = sw.employeeName || sw.windowName;
      await closePlaywrightWindow(activeSiteId, staffName);
      clearInitializing(sw);
      // await 确保状态立即同步，不等下一轮 polling
      await fetchSiteWindows();
    } catch (err) {
      console.error('[Header] 关闭窗口失败:', err);
      const name = sw.employeeName || sw.windowName;
      setLaunchMsg(`关闭 ${name} 失败: ${(err as Error).message}`);
    }
  };

  // ── 状态 → 颜色映射（Phase 4-I-1: 基于 DisplayStatus） ──
  //   颜色语义与 lib/window-status.ts 的 getWindowStatusTone 一致
  const statusColor: Record<DisplayStatus, string> = {
    offline: 'bg-text-tertiary',
    connecting: 'bg-primary animate-pulse',
    login_required: 'bg-yellow-500',
    ready: 'bg-success',
    busy: 'bg-warning',
    degraded: 'bg-orange-500',
    initializing: 'bg-primary animate-pulse',
    failed: 'bg-red-500',
  };

  // ── 渲染 ──
  const timeStr = time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // ★ Phase 4-B：playwright 模式下，offline/degraded/login_required 均视为需启动
  //   （degraded 可能是 about:blank/多标签页，点击一键启动会触发 ensure 收敛）
  const hasDisconnected = isPlaywright
    ? siteWindows.some(w => w.status === 'offline' || w.status === 'degraded' || w.status === 'login_required')
    : siteWindows.some(w => w.status === 'offline');

  return (
    <header className="topbar h-header">

      {/* ━━━━━ Zone A: 品牌区 ━━━━━ */}
      <div className={`topbar-brand ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="topbar-brand-mark">B</div>
        <div>
          <div className="topbar-brand-name">网点操作中心</div>
        </div>
      </div>

      {/* ━━━━━ Zone B: 中部状态区 ━━━━━ */}
      <div className="topbar-mid">

        {/* 配置加载失败提示 */}
        {configError && (
          <span className="text-[11px] text-danger font-mono">
            无法连接后端服务
          </span>
        )}

        {/* 网点切换下拉 */}
        {sites.length > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => setShowSiteSwitcher(!showSiteSwitcher)}
              className="btn-ghost gap-2"
            >
              <span className="max-w-[100px] truncate">{displaySiteName}</span>
              <ChevronDown
                className={`w-3 h-3 transition-transform ${showSiteSwitcher ? 'rotate-180' : ''}`}
              />
            </button>

            {showSiteSwitcher && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSiteSwitcher(false)} />
                <div className="absolute top-full left-0 mt-1 z-20 bg-surface border border-border rounded-card shadow-panel overflow-hidden min-w-[160px]">
                  {sites.map((site, idx) => (
                    <button
                      key={site.id}
                      onClick={() => {
                        // ★ P0 安全加固：任务运行中禁止切换站点
                        if (liveStatus === 'running') {
                          setLaunchMsg('当前任务正在运行，请等待任务完成后再切换网点');
                          setShowSiteSwitcher(false);
                          return;
                        }
                        setActiveSiteId(site.id);
                        setShowSiteSwitcher(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-[12px] transition-colors ${
                        site.id === activeSiteId
                          ? 'bg-primary-light text-primary font-medium'
                          : 'text-text-secondary hover:bg-surface-light'
                      }`}
                    >
                      <span className="truncate">{site.name}</span>
                      <span className="text-[10px] text-text-tertiary shrink-0 ml-3">{site.windows.length} 个窗口</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 窗口标签：设置中心配置的所有窗口（仅显示员工姓名，站点名已在左侧选择器） */}
        {siteWindows.length === 0 ? (
          <span className="text-[11px] text-text-tertiary shrink-0">暂无窗口配置</span>
        ) : (
          <div className="flex items-center gap-3 shrink-0">
            {siteWindows.map(sw => {
          const effectiveStatus = getEffectiveStatus(sw);
          const displayName = sw.employeeName || sw.windowName;
          const fullLabel = `${displaySiteName} - ${displayName}`;
          const isOffline = effectiveStatus === 'offline';
          const isInitializing = effectiveStatus === 'initializing';
          // Phase 4-D: playwright 模式检查 runtimeKey
          const hasBrowserId = isPlaywright && !!(sw as PlaywrightSiteWindowState).runtimeKey;

          return (
            <span
              key={sw.windowName}
              className={`window-pill relative ${effectiveStatus === 'ready' ? 'online' : ''} ${effectiveStatus === 'connecting' ? 'connecting' : ''} ${effectiveStatus === 'login_required' ? 'login-required' : ''} ${effectiveStatus === 'initializing' ? 'initializing' : ''} ${effectiveStatus === 'busy' ? 'busy' : ''} ${effectiveStatus === 'offline' ? 'offline' : ''} ${effectiveStatus === 'degraded' ? 'degraded' : ''} ${effectiveStatus === 'failed' ? 'failed' : ''}`}
              onMouseEnter={() => setHoveredWindow(sw.windowName)}
              onMouseLeave={() => setHoveredWindow(null)}
              onClick={() => {
                if (isInitializing || launching) return;
                // Phase 4-B：非 ready 非 busy 状态点击重新 ensure
                // （支持 about:blank/多标签页 → 点击 → 自动收敛为 1 个业务页）
                if (effectiveStatus === 'busy' || effectiveStatus === 'ready') return;
                handleInitWindow(sw);
                return;
              }}
              title={`${fullLabel}\n状态：${getWindowStatusLabel(effectiveStatus)}${
                effectiveStatus === 'failed'
                  ? '\n弹窗清理失败，重启后仍未就绪'
                  : effectiveStatus === 'degraded'
                    ? '\nP0 未通过，窗口不稳定'
                    : isOffline
                      ? isPlaywright
                        ? '\n点击启动 Chrome 窗口'
                        : (hasBrowserId ? '\n点击启动' : '\n未匹配到浏览器配置，请先在设置中添加')
                      : isPlaywright
                        ? (effectiveStatus === 'ready'
                            ? '\nChrome 窗口已打开'
                            : '\n点击重新检查并收敛标签页')
                        : '\n点击打开窗口，悬停显示关闭按钮'
              }${
                // ★ Phase 4-B：playwright 模式下追加诊断字段
                isPlaywright ? (() => {
                  const pw = sw as PlaywrightSiteWindowState;
                  const url = pw.currentUrl ?? pw.activePageUrl ?? '';
                  const lines: string[] = [];
                  if (url) lines.push(`\nURL: ${url}`);
                  if (typeof pw.pageCount === 'number') lines.push(`\n标签页: ${pw.pageCount}`);
                  if (typeof pw.p0Passed === 'boolean') {
                    lines.push(`\nP0: ${pw.p0Passed ? '通过' : '未通过'}`);
                  }
                  if (pw.p0FailedReason) lines.push(`\n原因: ${pw.p0FailedReason}`);
                  return lines.join('');
                })() : ''
              }`}
              style={{
                cursor: isInitializing
                  ? 'default'
                  : isPlaywright
                    // playwright 模式：非 ready 非 busy 非 initializing 均可点击重新 ensure
                    ? (effectiveStatus === 'ready' || effectiveStatus === 'busy' ? 'default' : 'pointer')
                    : ((isOffline && hasBrowserId) || (!isOffline && hasBrowserId))
                      ? 'pointer'
                      : 'not-allowed',
                width: '84px',
                minWidth: '84px',
                maxWidth: '84px',
                justifyContent: 'center',
              }}
            >
              {/* 状态点 */}
              {effectiveStatus === 'initializing' ? (
                <Loader2 className="w-[10px] h-[10px] text-primary animate-spin shrink-0" />
              ) : (
                <span className={`pip ${statusColor[effectiveStatus]}`} />
              )}
              <span
                className="text-center"
                style={{
                display: 'inline-block',
                fontSize: '13px',
                lineHeight: 1,
                letterSpacing: displayName.length <= 2 ? '0.12em' : 'normal',
                whiteSpace: 'nowrap',
              }}
              >
                {displayName}
              </span>
              {/* Phase 4-I-1: 关闭按钮 — 基于 canCloseWindow + hasBrowserId */}
              {canCloseWindow(effectiveStatus) && hasBrowserId && (
                <button
                  onClick={(e) => handleCloseWindow(sw, e)}
                  title={`关闭 ${fullLabel}`}
                  className="absolute -top-1 -right-1 z-30 h-3.5 w-3.5 rounded-full border border-slate-200 bg-white text-[9px] text-slate-400 leading-none shadow-sm hover:border-red-300 hover:bg-red-50 hover:text-red-500 transition-colors duration-150"
                  style={{
                    display: hoveredWindow === sw.windowName ? 'inline-flex' : 'none',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    padding: 0,
                    outline: 'none',
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}

            {/* 一键启动按钮 — 仅在有离线窗口时醒目 */}
            {hasDisconnected && (
              <button
                onClick={handleLaunchAll}
                disabled={launching || launchCooldown}
                className={`flex items-center rounded-[6px] text-[12px] font-medium
                  bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shrink-0
                  ${(launching || launchCooldown) ? 'gap-1 px-2 py-1' : 'px-2.5 py-1'}`}
                title={launchCooldown ? '窗口启动中，请稍后' : (isPlaywright ? '一键启动该网点所有未就绪 Chrome 窗口' : '一键启动该网点所有未就绪窗口')}
              >
                {(launching || launchCooldown) && <Loader2 className="w-3 h-3 animate-spin" />}
                <span>{launchCooldown ? '启动中...' : (isPlaywright ? '启动 Chrome' : '一键启动')}</span>
              </button>
            )}

          </div>
        )}

        {/* 启动提示 — 弹性占位 */}
        {launchMsg && (
          <span className="text-[12px] text-text-secondary font-mono truncate">
            {launchMsg}
          </span>
        )}
      </div>

      {/* ━━━━━ Zone C: 右侧工具栏 ━━━━━ */}
      <div className="topbar-right">
        {/* Phase 3-D: 用户状态 + 退出登录 */}
        {isAuthenticated && user && (
          <>
            <span className="text-[12px] text-[var(--text-2)] font-medium">{user.username}</span>
            <button
              onClick={() => logout()}
              className="p-1 rounded hover:bg-[var(--err-soft)] text-[var(--text-3)] hover:text-[var(--err)] transition"
              title="退出登录"
            >
              <LogOut className="w-3 h-3" />
            </button>
            <div className="w-px h-4 bg-[var(--border)]" />
          </>
        )}
        {/* Phase K-3A-2-Prep: 任务重置按钮 */}
        <button
          onClick={handleResetClick}
          disabled={resetting}
          className="p-1 rounded hover:bg-[var(--warn-soft)] text-[var(--text-3)] hover:text-[var(--warn)] transition disabled:opacity-40"
          title="清理任务数据"
        >
          {resetting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Trash2 className="w-3 h-3" />
          )}
        </button>
        {/* 刷新 + 时钟 */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1 rounded hover:bg-surface-light text-text-tertiary transition disabled:opacity-40"
          title="刷新窗口状态"
        >
          <RotateCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
        </button>

        <span className="text-[12px] text-text-secondary font-mono">{timeStr}</span>
      </div>

      {/* Phase 3-D-3: 本地浏览器运行时未就绪提示 */}
      {browserRuntimeStatus !== 'available' && (
        <div className="topbar-banner">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[12px] leading-tight">
            {browserRuntimeStatus === 'unavailable'
              ? '本地浏览器运行时未就绪，请启动本地执行端后重试。任务中心历史数据仍可查看。'
              : '本地浏览器运行时状态异常，部分窗口或任务可能不可用。'}
          </span>
        </div>
      )}
      {/* Phase K-3A-2-Prep: 任务重置确认弹窗 */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onClick={() => { setShowResetConfirm(false); setResetError(''); }}>
          <div className="bg-white rounded-lg shadow-xl p-6 w-[420px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[15px] font-semibold text-[var(--text-1)]">清理任务数据</h3>
              <button
                onClick={() => { setShowResetConfirm(false); setResetError(''); }}
                className="p-1 rounded hover:bg-surface-light text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-[13px] text-[var(--text-2)] leading-relaxed space-y-2 mb-4">
              <p className="text-[var(--warn)] font-medium">确认清理所有任务数据？</p>
              <p>这会删除任务中心历史任务、任务日志和运单执行结果。</p>
              <p>不会删除站点、员工、窗口配置。</p>
            </div>

            {resetMsg && (
              <div className="mb-3 text-[12px] bg-[var(--ok-soft)] text-[var(--ok)] rounded px-3 py-2">
                {resetMsg}
              </div>
            )}
            {resetError && (
              <div className="mb-3 text-[12px] bg-[var(--err-soft)] text-[var(--err)] rounded px-3 py-2">
                清理失败：{resetError}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowResetConfirm(false); setResetError(''); }}
                disabled={resetting}
                className="px-4 py-1.5 text-[13px] rounded border border-[var(--border)] text-[var(--text-2)] hover:bg-surface-light transition disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleResetTasks}
                disabled={resetting}
                className="px-4 py-1.5 text-[13px] rounded bg-[var(--err)] text-white hover:opacity-90 transition disabled:opacity-50 flex items-center gap-1.5"
              >
                {resetting && <Loader2 className="w-3 h-3 animate-spin" />}
                确认清理任务
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
