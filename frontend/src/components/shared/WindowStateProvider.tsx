// WindowStateProvider — 统一窗口状态管理（第 3 批：前端收敛）
// 替代 Header、ScanWorkbench、StatusBar 各自的独立轮询
// 单一真理源：按 runtimeMode 分支数据源，5s 轮询
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  getSettingsConfig,
  getSiteWindows,
  getSitePlaywrightWindows,
  getWindowRuntimeMode,
  type SiteConfig,
  type SiteWindowState,
  type PlaywrightSiteWindowState,
  type WindowRuntimeMode,
} from '../../api/client';

export interface WindowStateContextValue {
  // 配置
  sites: SiteConfig[];
  activeSiteId: string;
  setActiveSiteId: (id: string) => void;

  // runtimeMode（playwright / legacy_easybr）
  runtimeMode: WindowRuntimeMode;
  isPlaywright: boolean;

  // 4 态窗口数据（playwright 模式下含 p0Passed/pageCount 等诊断字段）
  siteWindows: PlaywrightSiteWindowState[];
  siteName: string;
  easybrAbnormal: boolean;
  easybrMessage: string;

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
  const [runtimeMode, setRuntimeMode] = useState<WindowRuntimeMode>('legacy_easybr');
  const [siteWindows, setSiteWindows] = useState<SiteWindowState[]>([]);
  const [siteName, setSiteName] = useState('');
  const [easybrAbnormal, setEasybrAbnormal] = useState(false);
  const [easybrMessage, setEasybrMessage] = useState('');
  const [configError, setConfigError] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 0. 加载 runtimeMode（页面加载时获取一次；后端 .env 切换后需刷新页面）
  const loadRuntimeMode = useCallback(async () => {
    try {
      const res = await getWindowRuntimeMode();
      setRuntimeMode(res.runtimeMode);
      console.log(`[WindowStateProvider] runtimeMode=${res.runtimeMode}`);
    } catch (e) {
      // 获取失败默认 legacy_easybr（安全回退）
      setRuntimeMode('legacy_easybr');
      console.warn('[WindowStateProvider] 获取 runtimeMode 失败，回退 legacy_easybr:', (e as Error).message);
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

  // 2. 单一轮询（5s）— 按 runtimeMode 分支数据源
  const fetchSiteWindows = useCallback(async () => {
    if (!activeSiteId) return;
    try {
      if (runtimeMode === 'playwright') {
        // playwright 模式：走新接口，不依赖 EasyBR
        const data = await getSitePlaywrightWindows(activeSiteId);
        setSiteWindows(data.windows);
        setSiteName(data.siteName);
        // playwright 模式下 EasyBR 状态无关，强制清空异常标记
        setEasybrAbnormal(false);
        setEasybrMessage('');
      } else {
        // legacy_easybr 模式：走原接口，保留 EasyBR 健康状态
        const data = await getSiteWindows(activeSiteId);
        setSiteWindows(data.windows);
        setSiteName(data.siteName);
        setEasybrAbnormal(data.easybrHealth?.reconnectNeeded ?? false);
        setEasybrMessage(data.easybrHealth?.message ?? '');
      }
      setFetchError('');
    } catch (e) {
      setFetchError('无法连接到后端服务');
    }
  }, [activeSiteId, runtimeMode]);

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
  const degradedCount = siteWindows.filter(w => w.status === 'degraded').length;
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
    siteWindows,
    siteName,
    easybrAbnormal,
    easybrMessage,
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
