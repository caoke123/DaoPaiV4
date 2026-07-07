// WindowStateProvider — 统一窗口状态管理（D-0B: EasyBR legacy removed）
// 替代 Header、ScanWorkbench、StatusBar 各自的独立轮询
// 单一真理源：V3 Playwright 路径，5s 轮询 + SSE 实时推送 (S2)
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  getSettingsConfig,
  getSitePlaywrightWindows,
  getCloudWindowStatus,
  getWindowRuntimeMode,
  getRuntimeStatus,
  type SiteConfig,
  type PlaywrightSiteWindowState,
  type CloudWindowStatus,
  type WindowRuntimeMode,
  type BrowserRuntimeStatus,
} from '../../api/client';
import { logTrace } from '../../lib/trace';
import { getWindowDisplayStatus, INTERMEDIATE_STATUSES } from '../../lib/window-status';

export interface WindowStateContextValue {
  // 配置
  sites: SiteConfig[];
  activeSiteId: string;
  setActiveSiteId: (id: string) => void;

  // runtimeMode（D-0B: default playwright）
  runtimeMode: WindowRuntimeMode;
  isPlaywright: boolean;

  // 本地浏览器运行时状态
  browserRuntimeStatus: BrowserRuntimeStatus;
  browserRuntimeError: string | null;

  // 窗口数据（playwright 模式下含 p0Passed/pageCount 等诊断字段）
  siteWindows: PlaywrightSiteWindowState[];
  siteName: string;

  // 手动刷新
  refresh: () => void;

  // 派生：用于 StatusBar
  connectedCount: number;   // ready + busy 的窗口数
  windowCount: number;     // 窗口总数
  allReady: boolean;       // 全部 ready

  // 错误
  configError: boolean;
  fetchError: string;
}

const WindowStateContext = createContext<WindowStateContextValue | null>(null);

export function useWindowState(): WindowStateContextValue {
  const ctx = useContext(WindowStateContext);
  if (!ctx) throw new Error('useWindowState 必须用在 <WindowStateProvider> 内');
  return ctx;
}

export function WindowStateProvider({ children }: { children: ReactNode }) {
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [activeSiteId, setActiveSiteId] = useState<string>('');
  const [runtimeMode, setRuntimeMode] = useState<WindowRuntimeMode>('playwright');
  const [siteWindows, setSiteWindows] = useState<PlaywrightSiteWindowState[]>([]);
  const [siteName, setSiteName] = useState('');
  const [configError, setConfigError] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [browserRuntimeStatus, setBrowserRuntimeStatus] = useState<BrowserRuntimeStatus>('unavailable');
  const [browserRuntimeError, setBrowserRuntimeError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 0. 加载 runtimeMode（页面加载时获取一次；后端 .env 切换后需刷新页面）
  const loadRuntimeMode = useCallback(async () => {
    try {
      const res = await getWindowRuntimeMode();
      setRuntimeMode(res.runtimeMode);
      console.log(`[WindowStateProvider] runtimeMode=${res.runtimeMode}`);
    } catch (e) {
      // D-0B: EasyBR removed, default to playwright
      setRuntimeMode('playwright');
      console.warn('[WindowStateProvider] 获取 runtimeMode 失败，回退 playwright:', (e as Error).message);
    }
  }, []);

  // 1. 加载配置
  const loadConfig = useCallback(async () => {
    try {
      const res = await getSettingsConfig();
      setSites(res.sites);
      setConfigError(false);
      if (res.sites.length > 0) {
        setActiveSiteId(prev =>
          prev && res.sites.find(s => s.id === prev) ? prev : res.sites[0].id,
        );
      } else {
        setActiveSiteId('');
      }
      return res.sites;
    } catch {
      setConfigError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    loadRuntimeMode();
    loadConfig();
  }, [loadRuntimeMode, loadConfig]);

  // 0.5. 轮询本地浏览器运行时状态（30s 间隔）
  useEffect(() => {
    const fetchRuntime = async () => {
      try {
        const status = await getRuntimeStatus();
        setBrowserRuntimeStatus(status.runtime);
        setBrowserRuntimeError(status.runtimeError);
      } catch {
        // 静默失败，保持上次状态
      }
    };
    fetchRuntime();
    const timer = setInterval(fetchRuntime, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 2. 获取窗口列表 — S2-Fix: 始终以设置中心配置为基，Cloud 状态仅做覆盖
  const fetchSiteWindows = useCallback(async () => {
    if (!activeSiteId) return;
    try {
      // 并行获取：设置中心完整列表 + Cloud 持久化状态
      const [pwData, cloudData] = await Promise.all([
        getSitePlaywrightWindows(activeSiteId).catch(() => null),
        getCloudWindowStatus(activeSiteId).catch(() => null),
      ]);

      // 构建 Cloud 状态 Map (key: windowId)
      const cloudMap = new Map<string, CloudWindowStatus>();
      if (cloudData?.windows) {
        for (const cw of cloudData.windows) {
          cloudMap.set(cw.windowId, cw);
        }
      }

      if (pwData && pwData.windows.length > 0) {
        // M5-2B: Agent（Cloud）状态为权威源，设置中心只提供窗口列表
        // PG windowId = settings windowName (e.g. "天南大-肖飞"), match directly
        const merged = pwData.windows.map(w => {
          const cloudStatus = cloudMap.get(w.windowName);
          if (cloudStatus) {
            return {
              ...w,
              status: cloudStatus.status,
              statusText: cloudStatus.statusText,
              p0Passed: cloudStatus.isDashboardReady,
              isLoginPage: cloudStatus.isLoginPage,
              currentUrl: cloudStatus.currentUrl || (w as any).currentUrl || '',
              isProcessAlive: cloudStatus.isProcessAlive,
              lastError: cloudStatus.lastError,
              commandId: cloudStatus.commandId || (w as any).commandId,
            } as PlaywrightSiteWindowState;
          }
          // 无 Agent 数据 → 显示离线（而非保持旧 Cloud 执行链的"未启动"）
          // M5-2: 但如果当前是中间状态（启动中/连接中/检查中等），不要覆盖回 offline
          const currentWindow = siteWindows.find(
            sw => (sw as any).windowName === w.windowName || (sw as any).id === (w as any).id,
          );
          if (currentWindow) {
            const currentStatus = getWindowDisplayStatus((currentWindow as any).status);
            if (INTERMEDIATE_STATUSES.has(currentStatus)) {
              // Keep the SSE-applied intermediate status, do not overwrite with offline
              return currentWindow;
            }
          }
          const hasAnyCloudData = cloudMap.size > 0;
          return hasAnyCloudData
            ? { ...w, status: 'offline' as const }
            : w;
        });
        setSiteWindows(merged as PlaywrightSiteWindowState[]);
        setSiteName(pwData.siteName);
      } else if (cloudData && cloudData.windows.length > 0) {
        // 设置中心无数据时的降级路径
        setSiteWindows(cloudData.windows.map((w: CloudWindowStatus) => ({
          windowId: w.windowId,
          staffName: w.staffName,
          runtimeKey: `${w.siteId}-${w.workstationId}-${w.windowId}`,
          status: w.status,
          p0Passed: w.isDashboardReady,
          pageCount: w.isDashboardReady ? 1 : 0,
          currentUrl: w.currentUrl || '',
          tenantId: (w as any).tenantId || '',
          siteId: w.siteId,
          siteName: '',
          windowName: w.windowId,
          employeeName: w.staffName,
          browserId: null,
          p0Check: { required: true },
          cachedStatus: null,
          lastStatusCheckAt: null,
        } as unknown as PlaywrightSiteWindowState)));
        setSiteName('');
      } else {
        setSiteWindows([]);
      }
      setFetchError('');
    } catch (e) {
      setFetchError('无法连接到后端服务');
    }
  }, [activeSiteId]);

  useEffect(() => {
    fetchSiteWindows();
    pollRef.current = setInterval(fetchSiteWindows, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSiteWindows]);

  // ── S2: SSE 实时事件订阅 ──
  useEffect(() => {
    if (!activeSiteId) return;

    const url = `${window.location.origin}/api/cloud/windows/events?siteId=${encodeURIComponent(activeSiteId)}`;
    let es: EventSource | null = null;

    const connect = () => {
      es = new EventSource(url);
      console.log(`[SSE] 连接 ${url}`);
      logTrace('window-state', 'sse_connect', { siteId: activeSiteId, url });

      es.addEventListener('agent_connected', () => {
        console.log('[SSE] agent_connected, 刷新');
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'agent_connected' });
        fetchSiteWindows();
      });

      es.addEventListener('agent_disconnected', () => {
        console.log('[SSE] agent_disconnected, 刷新');
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'agent_disconnected' });
        fetchSiteWindows();
      });

      es.addEventListener('command_claimed', () => {
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'command_claimed' });
        fetchSiteWindows();
      });

      es.addEventListener('command_running', () => {
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'command_running' });
        fetchSiteWindows();
      });

      es.addEventListener('command_done', () => {
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'command_done' });
        fetchSiteWindows();
      });

      es.addEventListener('command_failed', () => {
        logTrace('window-state', 'sse_event', { siteId: activeSiteId, event: 'command_failed' });
        fetchSiteWindows();
      });

      es.addEventListener('window_status_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          logTrace('window-state', 'sse_event', {
            siteId: activeSiteId,
            event: 'window_status_updated',
            windowId: data.windowId,
            status: data.status,
          });
          setSiteWindows(prev =>
            prev.map(w => {
              // M5-2B: Agent reports windowId as "staff-{name}", match both formats
              const matchName = w.windowName === data.windowId;
              const matchStaffKey = `staff-${w.windowName}` === data.windowId;
              const matchEmployee = (w as any).employeeName === data.windowId || `staff-${(w as any).employeeName}` === data.windowId;
              const isMatch = matchName || matchStaffKey || matchEmployee;
              return isMatch
                ? {
                    ...w,
                    status: data.status,
                    statusText: data.statusText || w.statusText || '',
                    p0Passed: data.status === 'ready' || data.isDashboardReady === true,
                    isLoginPage: data.isLoginPage || (w as any).isLoginPage || false,
                    commandId: data.commandId || (w as any).commandId,
                    windowName: data.windowId || w.windowName,
                  }
                : w;
            }),
          );
        } catch {
          // malformed data, ignore
        }
      });

      es.onerror = () => {
        console.warn('[SSE] 连接断开，将自动重连');
        logTrace('window-state', 'sse_error', { siteId: activeSiteId });
        es?.close();
        es = null;
        // SSE auto-reconnect via browser
        setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      es?.close();
    };
  }, [activeSiteId, fetchSiteWindows]);

  // 3. 派生数据（用于 StatusBar）
  const readyCount = siteWindows.filter(w => w.status === 'ready').length;
  const busyCount = siteWindows.filter(w => w.status === 'busy').length;
  const connectingCount = siteWindows.filter(w => w.status === 'connecting' || w.status === 'connected').length;
  const connectedCount = readyCount + busyCount + connectingCount;
  const windowCount = siteWindows.length;
  const allReady = windowCount > 0 && readyCount === windowCount;

  const refresh = useCallback(async () => {
    await loadRuntimeMode();
    await loadConfig();
    await fetchSiteWindows();
  }, [loadRuntimeMode, loadConfig, fetchSiteWindows]);

  const value: WindowStateContextValue = {
    sites,
    activeSiteId,
    setActiveSiteId,
    runtimeMode,
    isPlaywright: runtimeMode === 'playwright',
    browserRuntimeStatus,
    browserRuntimeError,
    siteWindows,
    siteName,
    refresh,
    connectedCount,
    windowCount,
    allReady,
    configError,
    fetchError,
  };

  return (
    <WindowStateContext.Provider value={value}>
      {children}
    </WindowStateContext.Provider>
  );
}
