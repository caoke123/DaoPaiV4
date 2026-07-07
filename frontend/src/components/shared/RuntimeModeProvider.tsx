// RuntimeModeProvider — Phase 9-dryrun 全局运行模式管理
// 单一真理源：GET /api/runtime/mode，页面加载时获取，设置中心切换后刷新
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getRuntimeMode, updateRuntimeMode, type RuntimeMode } from '../../api/client';

export interface RuntimeModeContextValue {
  dryRunMode: boolean;
  mode: RuntimeMode;
  loading: boolean;
  refresh: () => Promise<void>;
  setMode: (dryRunMode: boolean) => Promise<boolean>;
}

const RuntimeModeContext = createContext<RuntimeModeContextValue | null>(null);

export function useRuntimeMode(): RuntimeModeContextValue {
  const ctx = useContext(RuntimeModeContext);
  if (!ctx) throw new Error('useRuntimeMode 必须用在 <RuntimeModeProvider> 内');
  return ctx;
}

export function RuntimeModeProvider({ children }: { children: ReactNode }) {
  const [dryRunMode, setDryRunMode] = useState<boolean>(true);
  const [mode, setModeState] = useState<RuntimeMode>('dry-run');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await getRuntimeMode();
      setDryRunMode(res.dryRunMode);
      setModeState(res.mode);
    } catch {
      setDryRunMode(true);
      setModeState('dry-run');
    } finally {
      setLoading(false);
    }
  }, []);

  const setMode = useCallback(async (newDryRun: boolean): Promise<boolean> => {
    try {
      const res = await updateRuntimeMode(newDryRun);
      if (res.success) {
        setDryRunMode(res.dryRunMode);
        setModeState(res.mode);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <RuntimeModeContext.Provider value={{ dryRunMode, mode, loading, refresh, setMode }}>
      {children}
    </RuntimeModeContext.Provider>
  );
}
