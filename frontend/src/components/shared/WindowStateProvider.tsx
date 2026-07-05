// WindowStateProvider — 统一窗口状态管理（D-0B: EasyBR legacy removed）
// 替代 Header、ScanWorkbench、StatusBar 各自的独立轮询
// 单一真理源：V3 Playwright 路径，5s 轮询
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

  // 2. 轮询（5s）— D-0C: 优先 Cloud Agent 上报状态，Playwright fallback
  const fetchSiteWindows = useCallback(async () => {
    if (!activeSiteId) return;
    try {
      // 1. 获取 Playwright 实时运行时状态（最高优先级）
      const playwrightData = await getSitePlaywrightWindows(activeSiteId);
      const pwWindows = playwrightData.windows;
      
      // 2. 获取 Cloud persistent window_status 作为补充
      const cloudData = await getCloudWindowStatus(activeSiteId).catch(() => null);
      
      if (cloudData && cloudData.windows.length > 0) {
        // 合并策略：以 Playwright 运行时为主，Cloud 状态仅在 Playwright 离线时补充
        const merged = pwWindows.map(pw => {
          const cloud = cloudData.windows.find(cw => 
            cw.staffName === pw.staffName || cw.windowId === pw.windowName
          );
          
          // 如果 Playwright 已经是 ready/busy，则完全信任 Playwright
          if (pw.status === 'ready' || pw.status === 'busy') {
            return pw;
          }
          
          // 如果 Playwright 离线但 Cloud 有在线状态，尝试合并（仅作为参考）
          if (cloud && cloud.status !== 'offline') {
            return {
              ...pw,
              status: cloud.status,
              p0Passed: cloud.isDashboardReady,
              currentUrl: cloud.currentUrl || pw.currentUrl,
            } as PlaywrightSiteWindowState;
          }
          
          return pw;
        });
        
        setSiteWindows(merged);
        setSiteName(playwrightData.siteName);
      } else {
        setSiteWindows(pwWindows);
        setSiteName(playwrightData.siteName);
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
