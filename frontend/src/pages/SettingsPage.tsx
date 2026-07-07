import { useState, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye, EyeOff, Trash2, Plus, Shield,
  Lock, Settings, AlertCircle, Check, X, Database, Clock,
  Loader2, AlertTriangle, PencilLine,
} from 'lucide-react';
import PageHeader from '../components/shared/PageHeader';
import SectionCard from '../components/shared/SectionCard';
import ActionButton from '../components/shared/ActionButton';
import { cn } from '../lib/utils';
import { useWindowState } from '../components/shared/WindowStateProvider';
import {
  getSettingsConfig, verifyPin, updateSettingsConfig,
  getDataRetentionConfig, updateDataRetentionConfig, cleanupTasks,
  getRuntimeMode, updateRuntimeMode,
  type SiteConfig,
  type DataRetentionConfig,
} from '../api/client';
import { useRuntimeMode } from '../components/shared/RuntimeModeProvider';

// ── 类型 ──

/** 员工账号（前端编辑状态） */
interface WindowEntry {
  /** Phase 4-B: 窗口名称不再由用户编辑，保存时自动生成 */
  windowName: string;
  employeeName: string;
  username: string;
  /** 明文密码（state 中存明文，API 编码由后端处理）；Phase 4-B 允许为空 */
  password: string;
  /** 浏览器 ID（D-0B: UI 不展示，保留数据兼容） */
  easybrBrowserId: string;
  /** 唯一 key，用于 React key + 密码可见性追踪 */
  _key: string;
}

/** 网点配置（前端编辑状态） */
interface SiteEntry {
  id: string;
  name: string;
  windows: WindowEntry[];
}

// ── 辅助函数 ──

/** 从 API 返回的配置转换为前端编辑状态 */
function configToEntries(sites: SiteConfig[]): SiteEntry[] {
  return sites.map((site) => ({
    ...site,
    windows: site.windows.map((w, wi) => ({
      windowName: w.windowName,
      employeeName: w.employeeName,
      username: w.username,
      password: w.password,
      easybrBrowserId: w.easybrBrowserId || '',
      _key: `${site.id}-${wi}-${Date.now()}`,
    })),
  }));
}

/** 从 API 返回的配置深拷贝（用于 reset） */
function cloneEntries(sites: SiteConfig[]): SiteEntry[] {
  return sites.map((site) => ({
    ...site,
    windows: site.windows.map((w, wi) => ({
      windowName: w.windowName,
      employeeName: w.employeeName,
      username: w.username,
      password: w.password,
      easybrBrowserId: w.easybrBrowserId || '',
      _key: `${site.id}-${wi}-${Date.now()}`,
    })),
  }));
}

/** 创建一个空的窗口条目 */
function createEmptyWindow(): WindowEntry {
  return {
    windowName: '',  // Phase 4-B: 保存时自动生成
    employeeName: '',
    username: '',
    password: '',  // Phase 4-B: 允许为空
    easybrBrowserId: '',
    _key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

// ── 子组件：PIN 验证 Modal ──

function PinModal({
  open,
  onClose,
  onVerified,
  description = '请输入管理员 PIN 码以保存配置更改',
}: {
  open: boolean;
  onClose: () => void;
  onVerified: () => void;
  description?: string;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPin('');
      setError('');
      setLoading(false);
      // 自动聚焦输入框
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    if (pin.length < 4) {
      setError('PIN 码至少 4 位');
      return;
    }
    setLoading(true);
    setError('');

    try {
      await verifyPin(pin);
      onVerified();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg || 'PIN 码错误，请重试');
      setPin('');
      inputRef.current?.focus();
    }
    setLoading(false);
  }, [pin, onVerified]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSubmit();
      if (e.key === 'Escape') onClose();
    },
    [handleSubmit, onClose],
  );

  if (!open) return null;

  return (
    <AnimatePresence>
      {/* 遮罩 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
        onClick={onClose}
      >
        {/* Modal 卡片 */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ duration: 0.2, ease: [0.19, 1, 0.22, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="bg-surface border border-border rounded-card shadow-lg w-full max-w-md overflow-hidden"
        >
          {/* 头部 */}
          <div className="flex items-center gap-3 px-6 pt-6 pb-0">
            <div className="w-10 h-10 rounded-full bg-primary-light flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="text-h3 text-text-primary">管理员验证</h3>
              <p className="text-[13px] text-text-tertiary mt-0.5">
                {description}
              </p>
            </div>
          </div>

          {/* 输入区 */}
          <div className="px-6 pt-5 pb-2">
            <input
              ref={inputRef}
              type="password"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              placeholder="输入 PIN 码"
              maxLength={16}
              autoComplete="off"
              className="w-full h-12 px-4 bg-surface-bg border border-border rounded-input text-[16px] text-text-primary font-mono tracking-[0.3em] text-center
                         focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary-light
                         transition-colors placeholder:text-text-tertiary placeholder:tracking-normal placeholder:text-[14px]"
            />
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-1.5 mt-2 text-[13px] text-danger"
              >
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {error}
              </motion.p>
            )}
          </div>

          {/* 按钮 */}
          <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-4">
            <ActionButton variant="ghost" size="sm" onClick={onClose} disabled={loading}>
              取消
            </ActionButton>
            <ActionButton variant="primary" size="sm" onClick={handleSubmit} loading={loading}>
              验证并保存
            </ActionButton>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── 子组件：首次初始化引导视图 ──

function InitSetupView({ onInitialized }: { onInitialized: () => void }) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleInit = useCallback(async () => {
    if (pin.length < 4) {
      setError('PIN 码至少 4 位');
      return;
    }
    if (pin !== confirmPin) {
      setError('两次输入的 PIN 码不一致');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const BASE = (import.meta as any).env?.VITE_API_BASE || '';
      const resp = await fetch(`${BASE}/api/settings/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: '请求失败' }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      onInitialized();
    } catch (err) {
      setError((err as Error).message || '初始化失败');
    }
    setLoading(false);
  }, [pin, confirmPin, onInitialized]);

  return (
    <div className="max-w-md mx-auto mt-12">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-surface border border-border rounded-card shadow-sm p-8 text-center"
      >
        <div className="w-14 h-14 rounded-full bg-primary-light flex items-center justify-center mx-auto mb-4">
          <Shield className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-h2 text-text-primary mb-2">系统初始化</h2>
        <p className="text-[14px] text-text-secondary mb-6">
          欢迎使用网点系统。请先设置管理员 PIN 码，用于保护配置安全。
        </p>

        <div className="space-y-4 text-left">
          <div>
            <label className="text-[12px] font-medium text-text-tertiary">设置 PIN 码</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(''); }}
              placeholder="至少 4 位数字"
              maxLength={16}
              className="mt-1 w-full h-11 px-4 bg-surface-bg border border-border rounded-input text-[14px] text-text-primary font-mono
                         focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition-colors"
            />
          </div>
          <div>
            <label className="text-[12px] font-medium text-text-tertiary">确认 PIN 码</label>
            <input
              type="password"
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value); setError(''); }}
              placeholder="再次输入 PIN 码"
              maxLength={16}
              className="mt-1 w-full h-11 px-4 bg-surface-bg border border-border rounded-input text-[14px] text-text-primary font-mono
                         focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary-light transition-colors"
            />
          </div>
        </div>

        {error && (
          <p className="flex items-center justify-center gap-1.5 mt-4 text-[13px] text-danger">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </p>
        )}

        <div className="mt-6">
          <ActionButton variant="primary" size="md" onClick={handleInit} loading={loading} className="w-full justify-center">
            初始化系统
          </ActionButton>
        </div>
      </motion.div>
    </div>
  );
}

// ── 主页面 ──

export default function SettingsPage() {
  // ── 全局状态 ──
  const { refresh: refreshGlobalState } = useWindowState();

  // ── State ──
  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [initialSites, setInitialSites] = useState<SiteEntry[]>([]);
  const [activeSiteIndex, setActiveSiteIndex] = useState(0);
  const [initialized, setInitialized] = useState<boolean | null>(null); // null = loading
  const [dirty, setDirty] = useState(false);

  // PIN Modal
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinAction, setPinAction] = useState<'save-config' | 'toggle-runtime' | 'view-password'>('save-config');

  // 密码可见性 { _key: true }
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [pendingPasswordKey, setPendingPasswordKey] = useState<string | null>(null);

  // 删除确认
  const [deleteWindowTarget, setDeleteWindowTarget] = useState<string | null>(null);
  const [deleteSiteTarget, setDeleteSiteTarget] = useState<number | null>(null);

  // Tab 内联编辑
  const [editingTab, setEditingTab] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [editError, setEditError] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Tab 悬停延迟显示图标
  const [hoveredTab, setHoveredTab] = useState<number | null>(null);
  const hoverEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimers = useCallback(() => {
    if (hoverEnterTimerRef.current) {
      clearTimeout(hoverEnterTimerRef.current);
      hoverEnterTimerRef.current = null;
    }
    if (hoverLeaveTimerRef.current) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
  }, []);

  const handleTabMouseEnter = useCallback((index: number) => {
    clearHoverTimers();
    hoverEnterTimerRef.current = setTimeout(() => {
      setHoveredTab(index);
    }, 1500);
  }, [clearHoverTimers]);

  const handleTabMouseLeave = useCallback(() => {
    clearHoverTimers();
    hoverLeaveTimerRef.current = setTimeout(() => {
      setHoveredTab(null);
    }, 1500);
  }, [clearHoverTimers]);

  useEffect(() => {
    return () => clearHoverTimers();
  }, [clearHoverTimers]);

  // 数据管理
  const [dataRetention, setDataRetention] = useState<DataRetentionConfig>({ retentionDays: 30, cleanupFrequency: 'weekly' });
  const [cleaningNow, setCleaningNow] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);

  // 运行模式
  const { refresh: refreshRuntimeMode } = useRuntimeMode();
  const [dryRunMode, setDryRunMode] = useState<boolean>(true);
  const [runtimeModeLoading, setRuntimeModeLoading] = useState(false);
  const [showDisableDryRunConfirm, setShowDisableDryRunConfirm] = useState(false);
  const [pendingDryRunValue, setPendingDryRunValue] = useState<boolean | null>(null);

  // 保存成功 toast
  const [toast, setToast] = useState<string | null>(null);

  // ── 初始化加载数据 ──
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [data, retention, runtimeRes] = await Promise.all([
          getSettingsConfig(),
          getDataRetentionConfig().catch(() => ({ retentionDays: 30, cleanupFrequency: 'weekly' } as DataRetentionConfig)),
          getRuntimeMode().catch(() => ({ dryRunMode: true, mode: 'dry-run' as const })),
        ]);
        if (cancelled) return;
        setSites(configToEntries(data.sites));
        setInitialSites(cloneEntries(data.sites));
        setDataRetention(retention);
        setDryRunMode(runtimeRes.dryRunMode);
        setInitialized(true);
      } catch (err) {
        if (cancelled) return;
        console.warn('[SettingsPage] 加载配置失败:', (err as Error).message);
        // 404/未初始化 → 显示引导页
        setInitialized(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // ── 站点操作 ──

  const generateNewSiteName = useCallback(() => {
    let maxN = 0;
    for (const s of sites) {
      const m = s.name.match(/^网点\s*(\d+)$/);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `网点 ${maxN + 1}`;
  }, [sites]);

  const addSite = useCallback(() => {
    const newName = generateNewSiteName();
    const newSite: SiteEntry = {
      id: `site-${Date.now()}`,
      name: newName,
      windows: [createEmptyWindow()],
    };
    const newIndex = sites.length;
    clearHoverTimers();
    setHoveredTab(null);
    setSites(prev => [...prev, newSite]);
    setActiveSiteIndex(newIndex);
    setDirty(true);
    // 立即进入编辑态
    setEditingTab(newIndex);
    setEditingValue(newName);
    setIsNewDraft(true);
    setEditError('');
    setTimeout(() => {
      const input = editInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, 80);
  }, [sites, generateNewSiteName, clearHoverTimers]);

  const startEditTab = useCallback((index: number) => {
    const site = sites[index];
    if (!site) return;
    clearHoverTimers();
    setHoveredTab(null);
    setEditingTab(index);
    setEditingValue(site.name);
    setIsNewDraft(false);
    setEditError('');
    setTimeout(() => {
      const input = editInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, 50);
  }, [sites, clearHoverTimers]);

  const validateSiteName = useCallback((name: string, excludeIndex: number): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return '网点名称不能为空';
    const duplicate = sites.some((s, i) => i !== excludeIndex && s.name.trim() === trimmed);
    if (duplicate) return '该网点名称已存在';
    return null;
  }, [sites]);

  const commitEdit = useCallback(() => {
    if (editingTab === null) return;
    const error = validateSiteName(editingValue, editingTab);
    if (error) {
      setEditError(error);
      setTimeout(() => editInputRef.current?.focus(), 0);
      return;
    }
    const trimmed = editingValue.trim();
    setSites(prev => prev.map((s, i) => i === editingTab ? { ...s, name: trimmed } : s));
    setDirty(true);
    setEditingTab(null);
    setEditError('');
    setIsNewDraft(false);
  }, [editingTab, editingValue, validateSiteName]);

  const cancelEdit = useCallback(() => {
    if (editingTab === null) return;
    if (isNewDraft) {
      // Esc 在新建草稿时 → 移除整个 Tab
      const removedIdx = editingTab;
      setSites(prev => prev.filter((_, i) => i !== removedIdx));
      setActiveSiteIndex(prev => {
        if (prev === removedIdx) return Math.max(0, removedIdx - 1);
        if (prev > removedIdx) return prev - 1;
        return prev;
      });
    }
    setEditingTab(null);
    setEditError('');
    setIsNewDraft(false);
  }, [editingTab, isNewDraft]);

  const handleSelectTab = useCallback((index: number) => {
    if (editingTab !== null && editingTab !== index) {
      commitEdit();
    }
    setActiveSiteIndex(index);
    setVisiblePasswords(new Set()); // 切换站点时隐藏所有密码
  }, [editingTab, commitEdit]);

  const removeSite = useCallback(
    (index: number) => {
      clearHoverTimers();
      setHoveredTab(null);
      setSites((prev) => {
        const next = prev.filter((_, i) => i !== index);
        setActiveSiteIndex((a) => {
          if (next.length === 0) return 0;
          if (a === index) return index < next.length ? index : next.length - 1;
          if (a > index) return a - 1;
          return a;
        });
        return next;
      });
      setDeleteSiteTarget(null);
      setDirty(true);
      setEditingTab(prev => {
        if (prev === null) return null;
        if (prev === index) { setIsNewDraft(false); return null; }
        if (prev > index) return prev - 1;
        return prev;
      });
    },
    [clearHoverTimers],
  );

  // ── 窗口操作 ──

  const addWindow = useCallback((siteIndex: number) => {
    setSites((prev) =>
      prev.map((s, i) =>
        i === siteIndex ? { ...s, windows: [...s.windows, createEmptyWindow()] } : s,
      ),
    );
    setDirty(true);
  }, []);

  const removeWindow = useCallback((siteIndex: number, windowKey: string) => {
    setSites((prev) =>
      prev.map((s, i) =>
        i === siteIndex
          ? { ...s, windows: s.windows.filter((w) => w._key !== windowKey) }
          : s,
      ),
    );
    setDeleteWindowTarget(null);
    setDirty(true);
    // 同时清理密码可见性
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      next.delete(windowKey);
      return next;
    });
  }, []);

  const updateWindow = useCallback(
    (siteIndex: number, windowKey: string, field: keyof WindowEntry, value: string) => {
      setSites((prev) =>
        prev.map((s, i) =>
          i === siteIndex
            ? {
                ...s,
                windows: s.windows.map((w) =>
                  w._key === windowKey
                    ? { ...w, [field]: value }
                    : w,
                ),
              }
            : s,
        ),
      );
      setDirty(true);
    },
    [],
  );

  const togglePasswordVisible = useCallback((key: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        // 当前已显示 → 直接隐藏，不需要 PIN
        next.delete(key);
        return next;
      }
      // 当前未显示 → 需要 PIN 校验
      setPendingPasswordKey(key);
      setPinAction('view-password');
      setShowPinModal(true);
      return prev; // 不改变当前状态，等 PIN 验证通过后再改
    });
  }, []);

  // ── 重置 ──

  const handleReset = useCallback(() => {
    clearHoverTimers();
    setHoveredTab(null);
    setSites(cloneEntries(initialSites));
    setDirty(false);
    setVisiblePasswords(new Set());
    setPendingPasswordKey(null);
    setDeleteSiteTarget(null);
    setDeleteWindowTarget(null);
    setEditingTab(null);
    setEditError('');
    setIsNewDraft(false);
    setToast('已还原为初始配置');
    setTimeout(() => setToast(null), 2000);
  }, [initialSites, clearHoverTimers]);

  // ── 保存流程 ──

  const handleSaveClick = useCallback(() => {
    // 如果正在编辑，先校验并提交
    if (editingTab !== null) {
      const error = validateSiteName(editingValue, editingTab);
      if (error) {
        setEditError(error);
        setTimeout(() => editInputRef.current?.focus(), 0);
        return;
      }
      const trimmed = editingValue.trim();
      setSites(prev => prev.map((s, i) => i === editingTab ? { ...s, name: trimmed } : s));
      setEditingTab(null);
      setEditError('');
      setIsNewDraft(false);
    }
    // 使用最新的 sites 数据校验（注意：setSites 是异步的，所以这里直接用当前 sites 做基本校验）
    const sitesToValidate = editingTab !== null
      ? sites.map((s, i) => i === editingTab ? { ...s, name: editingValue.trim() } : s)
      : sites;
    const active = sitesToValidate[activeSiteIndex];
    if (!active) return;
    if (!active.name.trim()) {
      setToast('请输入网点名称');
      setTimeout(() => setToast(null), 2000);
      return;
    }
    for (const w of active.windows) {
      if (!w.employeeName.trim() || !w.username.trim()) {
        setToast('请填写完整的员工信息（员工姓名和登录账号必填）');
        setTimeout(() => setToast(null), 2000);
        return;
      }
    }
    setPinAction('save-config');
    setShowPinModal(true);
  }, [sites, activeSiteIndex, editingTab, editingValue, validateSiteName]);

  // ── 运行模式切换 ──
  const applyRuntimeModeChange = useCallback(async () => {
    if (pendingDryRunValue === null) return;
    setRuntimeModeLoading(true);
    try {
      await updateRuntimeMode(pendingDryRunValue);
      setDryRunMode(pendingDryRunValue);
      await refreshRuntimeMode();
      setToast(pendingDryRunValue ? '已切换到试运行模式' : '已切换到真实执行模式');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`切换失败: ${(err as Error).message}`);
      setTimeout(() => setToast(null), 3000);
    } finally {
      setRuntimeModeLoading(false);
      setPendingDryRunValue(null);
    }
  }, [pendingDryRunValue, refreshRuntimeMode]);

  const handlePinVerified = useCallback(async () => {
    setShowPinModal(false);

    if (pinAction === 'view-password') {
      // PIN 验证通过 → 显示当前请求的密码行
      if (pendingPasswordKey) {
        setVisiblePasswords((prev) => {
          const next = new Set(prev);
          next.add(pendingPasswordKey);
          return next;
        });
        setPendingPasswordKey(null);
      }
      return;
    }

    if (pinAction === 'toggle-runtime') {
      await applyRuntimeModeChange();
      return;
    }

    try {
      // 将编辑数据转为 API 格式（不含 _key）
      // D-0B: windowName 自动生成 = 网点名-员工姓名；browserId 保留旧值
      const config: SiteConfig[] = sites.map((s) => ({
        id: s.id,
        name: s.name,
        windows: s.windows.map((w) => ({
          windowName: w.employeeName ? `${s.name}-${w.employeeName}` : (w.windowName || `${s.name}-未命名`),
          employeeName: w.employeeName,
          username: w.username,
          password: w.password, // 明文，后端负责 Base64 编码；允许为空
          easybrBrowserId: w.easybrBrowserId || undefined,
        })),
      }));

      await updateSettingsConfig(config);

      // 保存成功后更新 initialSites 为当前数据（reset 基准）
      setInitialSites(cloneEntries(config));
      setDirty(false);
      // 刷新全局状态（header网点下拉等）
      refreshGlobalState();
      setToast('配置已保存');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`保存失败: ${(err as Error).message}`);
      setTimeout(() => setToast(null), 3000);
    }
  }, [sites, refreshGlobalState, pinAction, applyRuntimeModeChange, pendingPasswordKey]);

  // ── 数据保留配置 ──
  const handleSaveRetention = useCallback(async () => {
    setSavingRetention(true);
    try {
      await updateDataRetentionConfig(dataRetention);
      setToast('数据保留策略已保存');
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`保存失败: ${(err as Error).message}`);
      setTimeout(() => setToast(null), 3000);
    } finally {
      setSavingRetention(false);
    }
  }, [dataRetention]);

  const handleCleanupNow = useCallback(async () => {
    setShowCleanupConfirm(false);
    setCleaningNow(true);
    try {
      const days = dataRetention.retentionDays === -1 ? 30 : dataRetention.retentionDays;
      const result = await cleanupTasks(days);
      setToast(`清理完成：删除 ${result.deletedTasks} 个任务、${result.deletedWaybills} 条运单、${result.deletedLogs} 条日志`);
      setTimeout(() => setToast(null), 4000);
    } catch {
      setToast('清理失败，请稍后重试');
      setTimeout(() => setToast(null), 3000);
    } finally {
      setCleaningNow(false);
    }
  }, [dataRetention.retentionDays]);

  const handleRuntimeModeToggle = useCallback((newValue: boolean) => {
    if (newValue === dryRunMode) return;
    if (newValue === false) {
      setPendingDryRunValue(newValue);
      setShowDisableDryRunConfirm(true);
    } else {
      setPendingDryRunValue(newValue);
      setPinAction('toggle-runtime');
      setShowPinModal(true);
    }
  }, [dryRunMode]);

  const confirmDisableDryRun = useCallback(() => {
    setShowDisableDryRunConfirm(false);
    setPinAction('toggle-runtime');
    setShowPinModal(true);
  }, []);

  // ── 当前活跃的站点 ──
  const activeSite = sites[activeSiteIndex];

  // ── Loading 态 ──
  if (initialized === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-2 text-text-tertiary text-[14px]">
          <Settings className="w-4 h-4 animate-spin" />
          加载中...
        </div>
      </div>
    );
  }

  // ── 初始化引导视图 ──
  if (initialized === false) {
    return <InitSetupView onInitialized={() => setInitialized(true)} />;
  }

  // ── 正常设置视图 ──
  return (
    <div className="max-w-[1280px] mx-auto">
      <PageHeader
        title="设置中心"
        description="管理网点、员工窗口和登录凭据"
        className="items-end"
        actions={
          <>
            <ActionButton variant="ghost" onClick={handleReset} disabled={!dirty}>
              放弃更改
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleSaveClick}
              disabled={!dirty}
              icon={<Lock className="w-4 h-4" />}
            >
              保存配置
            </ActionButton>
          </>
        }
      />

      {/* ── 站点 Tabs ── */}
      <div className="flex items-center gap-1 mb-6 overflow-x-auto pb-1">
        {sites.map((site, idx) => {
          const isActive = activeSiteIndex === idx;
          const isEditing = editingTab === idx;
          const isDraft = isNewDraft && isEditing;

          return (
            <div key={site.id} className="relative shrink-0">
              {isEditing ? (
                /* ── 编辑态 ── */
                <div className="relative">
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editingValue}
                    onChange={(e) => {
                      setEditingValue(e.target.value);
                      setEditError('');
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onBlur={() => {
                      // 延迟以允许点击其他按钮（如新增、删除）先触发
                      setTimeout(() => {
                        if (editingTab === idx) {
                          commitEdit();
                        }
                      }, 150);
                    }}
                    className={cn(
                      'h-9 px-3 pr-8 rounded-btn text-[13px] font-medium bg-primary text-text-inverted',
                      'border-2 border-primary outline-none shadow-sm',
                      'min-w-[120px]',
                      editError && 'border-danger',
                    )}
                    style={{ width: Math.max(80, editingValue.length * 14 + 40) }}
                    maxLength={30}
                  />
                  {editError && (
                    <motion.div
                      initial={{ opacity: 0, y: -2 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="absolute top-full mt-1 left-0 z-30 bg-danger text-white text-[11px] px-2 py-1 rounded shadow-lg whitespace-nowrap"
                    >
                      {editError}
                    </motion.div>
                  )}
                </div>
              ) : (
                /* ── 展示态 ── */
                <button
                  onClick={() => handleSelectTab(idx)}
                  onMouseEnter={() => handleTabMouseEnter(idx)}
                  onMouseLeave={handleTabMouseLeave}
                  className={cn(
                    'group flex items-center gap-1.5 h-9 px-4 rounded-btn text-[13px] font-medium transition-all duration-150 whitespace-nowrap',
                    isActive
                      ? 'bg-primary text-text-inverted shadow-sm'
                      : 'bg-surface border border-border text-text-secondary hover:bg-surface-light hover:text-text-primary',
                    isDraft && 'italic opacity-70',
                  )}
                >
                  <span className="truncate max-w-[120px]">{site.name || `网点 ${idx + 1}`}</span>
                  {/* 图标仅选中且悬停延迟后显示 */}
                  {isActive && hoveredTab === idx && (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clearHoverTimers();
                          setHoveredTab(null);
                          startEditTab(idx);
                        }}
                        className="w-5 h-5 rounded-full flex items-center justify-center transition-colors
                                   hover:bg-white/20 text-white/70 hover:text-white shrink-0"
                        title="重命名网点"
                      >
                        <PencilLine className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          clearHoverTimers();
                          setHoveredTab(null);
                          setDeleteSiteTarget(idx);
                        }}
                        className="w-5 h-5 rounded-full flex items-center justify-center transition-colors
                                   hover:bg-white/20 text-white/70 hover:text-white shrink-0"
                        title="删除网点"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </button>
              )}
            </div>
          );
        })}

        {/* 新增网点按钮 */}
        <button
          onClick={addSite}
          disabled={editingTab !== null}
          className="shrink-0 flex items-center gap-1.5 h-9 px-3 rounded-btn text-[13px] font-medium text-text-tertiary
                     border border-dashed border-border hover:border-primary hover:text-primary hover:bg-primary-light/50 transition-all
                     disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" />
          新增网点
        </button>
      </div>

      {/* ── 空状态：无网点 ── */}
      {sites.length === 0 ? (
        <div className="bg-surface border border-border rounded-card shadow-sm p-12 text-center mb-6">
          <Settings className="w-12 h-12 mx-auto mb-4 text-text-tertiary opacity-30" />
          <h3 className="text-[15px] font-medium text-text-primary mb-2">暂无网点配置</h3>
          <p className="text-[13px] text-text-tertiary mb-4">请先添加一个网点开始配置</p>
          <button
            onClick={addSite}
            className="inline-flex items-center gap-1.5 px-4 h-9 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            新增网点
          </button>
        </div>
      ) : (
      /* ── 员工账号配置 Card ── */
      <SectionCard
        title="员工账号配置"
        description={`${activeSite?.name || ''} — ${activeSite?.windows.length ?? 0} 名员工`}
        headerRight={
          activeSite ? (
            <ActionButton variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} onClick={() => addWindow(activeSiteIndex)}>
              添加员工
            </ActionButton>
          ) : undefined
        }
        className="mb-6"
      >
        {activeSite && activeSite.windows.length === 0 ? (
          <div className="text-center py-12 text-text-tertiary">
            <Settings className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-[14px]">暂无员工账号</p>
            <p className="text-[12px] mt-1">点击"添加员工"开始配置</p>
          </div>
        ) : activeSite ? (
          <>
            {/* 桌面端：grid 表格视图 (lg+) */}
            <div className="hidden lg:block">
              {/* 表头 */}
              <div
                className="grid border-b border-border"
                style={{ gridTemplateColumns: '140px 160px 150px 72px' }}
              >
                <div className="text-left text-[13px] font-semibold text-text-tertiary uppercase tracking-wider pb-3 px-3">
                  员工姓名
                </div>
                <div className="text-left text-[13px] font-semibold text-text-tertiary uppercase tracking-wider pb-3 px-3">
                  登录账号
                </div>
                <div className="text-left text-[13px] font-semibold text-text-tertiary uppercase tracking-wider pb-3 px-3">
                  登录密码
                </div>
                <div className="text-center text-[13px] font-semibold text-text-tertiary uppercase tracking-wider pb-3 px-2">
                  操作
                </div>
              </div>
              {/* 内容行 */}
              {activeSite.windows.map((w) => (
                <WindowRow
                  key={w._key}
                  entry={w}
                  visible={visiblePasswords.has(w._key)}
                  onTogglePassword={() => togglePasswordVisible(w._key)}
                  onUpdate={(field, value) => updateWindow(activeSiteIndex, w._key, field, value)}
                  onDelete={() => setDeleteWindowTarget(w._key)}
                  onConfirmDelete={() => removeWindow(activeSiteIndex, w._key)}
                  onCancelDelete={() => setDeleteWindowTarget(null)}
                  isDeletePending={deleteWindowTarget === w._key}
                />
              ))}
            </div>

            {/* 移动端：卡片视图 (<lg) */}
            <div className="lg:hidden space-y-4">
              {activeSite.windows.map((w) => (
                <WindowCard
                  key={w._key}
                  entry={w}
                  visible={visiblePasswords.has(w._key)}
                  onTogglePassword={() => togglePasswordVisible(w._key)}
                  onUpdate={(field, value) => updateWindow(activeSiteIndex, w._key, field, value)}
                  onDelete={() => setDeleteWindowTarget(w._key)}
                  onConfirmDelete={() => removeWindow(activeSiteIndex, w._key)}
                  onCancelDelete={() => setDeleteWindowTarget(null)}
                  isDeletePending={deleteWindowTarget === w._key}
                />
              ))}
            </div>
          </>
        ) : null}
      </SectionCard>
      )}

      {/* ── 运行模式 ── */}
      <SectionCard
        title="运行模式"
        description="控制系统是否执行真实业务提交操作"
        className="mb-6"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 rounded-lg"
            style={{
              backgroundColor: dryRunMode ? 'rgba(22, 119, 255, 0.04)' : 'rgba(249, 115, 22, 0.06)',
              border: dryRunMode ? '1px solid rgba(22, 119, 255, 0.15)' : '1px solid rgba(249, 115, 22, 0.25)',
            }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: dryRunMode ? 'rgba(22, 119, 255, 0.1)' : 'rgba(249, 115, 22, 0.15)' }}
              >
                {dryRunMode
                  ? <Shield className="w-5 h-5" style={{ color: '#1677ff' }} />
                  : <AlertTriangle className="w-5 h-5" style={{ color: '#f97316' }} />
                }
              </div>
              <div>
                <div className="text-[14px] font-medium text-text-primary">
                  {dryRunMode ? '试运行模式' : '真实执行模式'}
                </div>
                <div className="text-[12px] text-text-tertiary mt-0.5">
                  {dryRunMode
                    ? '所有任务执行到最终提交前停止，不会产生真实业务变更'
                    : '到件扫描、派件扫描、到派一体、签收录入会执行真实提交操作'
                  }
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {runtimeModeLoading && <Loader2 className="w-4 h-4 animate-spin text-text-tertiary" />}
              <button
                onClick={() => handleRuntimeModeToggle(!dryRunMode)}
                disabled={runtimeModeLoading}
                className={cn(
                  'relative w-11 h-6 rounded-full transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed',
                  dryRunMode ? 'bg-blue-500' : 'bg-orange-500'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform duration-200',
                    dryRunMode ? 'left-0.5' : 'left-[calc(100%-1.375rem)]'
                  )}
                />
              </button>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-surface-bg border border-border">
            <p className="text-[12px] text-text-tertiary leading-relaxed">
              <span className="font-medium text-text-secondary">开启试运行模式：</span>
              到件扫描、派件扫描、到派一体、签收录入都可以执行到最终提交前一步，但不会点击最终提交/确认/保存按钮，不产生真实业务变更。
            </p>
            <p className="text-[12px] text-text-tertiary leading-relaxed mt-2">
              <span className="font-medium text-danger">关闭试运行模式：</span>
              进入真实执行模式，4 个任务允许执行完整提交链路。请确认当前是真实生产环境，并且运单号无误。
            </p>
          </div>
        </div>
      </SectionCard>

      {/* ── 数据管理 ── */}
      <SectionCard
        title="数据管理"
        description="任务记录保留策略和历史数据清理"
        className="mb-6"
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="text-[12px] font-medium text-text-tertiary flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                任务记录保留天数
              </label>
              <select
                value={dataRetention.retentionDays}
                onChange={e => setDataRetention(prev => ({ ...prev, retentionDays: Number(e.target.value) }))}
                className="mt-1 w-full h-10 px-3 bg-surface-bg border border-border rounded-input text-[13px] text-text-primary
                           focus:outline-none focus:border-primary transition-colors"
              >
                <option value={30}>30 天</option>
                <option value={60}>60 天</option>
                <option value={90}>90 天</option>
                <option value={180}>180 天</option>
                <option value={-1}>永久保留</option>
              </select>
            </div>
            <div>
              <label className="text-[12px] font-medium text-text-tertiary">自动清理频率</label>
              <select
                value={dataRetention.cleanupFrequency}
                onChange={e => setDataRetention(prev => ({ ...prev, cleanupFrequency: e.target.value as DataRetentionConfig['cleanupFrequency'] }))}
                className="mt-1 w-full h-10 px-3 bg-surface-bg border border-border rounded-input text-[13px] text-text-primary
                           focus:outline-none focus:border-primary transition-colors"
              >
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
                <option value="off">关闭</option>
              </select>
            </div>
          </div>

          <p className="text-[12px] text-text-tertiary">
            自动清理会同步删除超过保留期限的任务记录、运单结果和执行日志。执行中的任务不会被删除。
          </p>

          <div className="flex items-center gap-3 pt-2">
            <ActionButton
              variant="primary"
              size="sm"
              onClick={handleSaveRetention}
              loading={savingRetention}
            >
              保存保留策略
            </ActionButton>
            <button
              onClick={() => setShowCleanupConfirm(true)}
              disabled={cleaningNow || dataRetention.retentionDays === -1}
              className="flex items-center gap-1.5 px-3 h-8 rounded-btn border border-danger/30 text-[12px] text-danger font-medium
                hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title={dataRetention.retentionDays === -1 ? '当前为永久保留，无需清理' : `立即清理 ${dataRetention.retentionDays} 天前的历史任务`}
            >
              {cleaningNow ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              立即执行清理
            </button>
          </div>
        </div>
      </SectionCard>

      {/* 清理确认弹窗 */}
      {showCleanupConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowCleanupConfirm(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface border border-border rounded-card shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-danger" />
              <h3 className="text-[14px] font-semibold text-text-primary">确认立即清理？</h3>
            </div>
            <p className="text-[12px] text-text-tertiary mb-1">
              将删除 <b className="text-text-primary">{dataRetention.retentionDays}</b> 天前已结束的任务记录。
            </p>
            <p className="text-[12px] text-danger font-medium mb-4">此操作不可恢复。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCleanupConfirm(false)}
                className="px-4 h-8 rounded-btn border border-border text-[12px] text-text-secondary hover:bg-surface-light transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCleanupNow}
                className="px-4 h-8 rounded-btn bg-danger text-white text-[12px] font-medium hover:bg-red-600 transition-colors"
              >
                确认清理
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 关闭试运行二次确认弹窗 */}
      {showDisableDryRunConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { setShowDisableDryRunConfirm(false); setPendingDryRunValue(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-surface border border-border rounded-card shadow-xl p-6 max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-text-primary">确认关闭试运行模式？</h3>
              </div>
            </div>
            <div className="space-y-2 mb-5">
              <p className="text-[13px] text-text-secondary">
                关闭后，到件扫描、派件扫描、到派一体、签收录入将执行真实提交操作。
              </p>
              <p className="text-[13px] text-danger font-medium">
                请确认当前使用的是真实生产环境，并且运单号无误。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowDisableDryRunConfirm(false); setPendingDryRunValue(null); }}
                className="px-4 h-9 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmDisableDryRun}
                className="px-4 h-9 rounded-btn bg-orange-500 text-white text-[13px] font-medium hover:bg-orange-600 transition-colors"
              >
                确认关闭试运行
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除网点确认弹窗 */}
      {deleteSiteTarget !== null && sites[deleteSiteTarget] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setDeleteSiteTarget(null)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface border border-border rounded-card shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-danger" />
              <h3 className="text-[14px] font-semibold text-text-primary">删除网点</h3>
            </div>
            <p className="text-[13px] text-text-secondary mb-1">
              确定删除网点「<b className="text-text-primary">{sites[deleteSiteTarget].name}</b>」吗？
            </p>
            <p className="text-[12px] text-text-tertiary mb-1">
              该网点下的 <b className="text-text-primary">{sites[deleteSiteTarget].windows.length}</b> 个窗口配置将一并删除。
            </p>
            <p className="text-[12px] text-danger font-medium mb-4">此操作不可恢复。</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteSiteTarget(null)}
                className="px-4 h-8 rounded-btn border border-border text-[12px] text-text-secondary hover:bg-surface-light transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => removeSite(deleteSiteTarget)}
                className="px-4 h-8 rounded-btn bg-danger text-white text-[12px] font-medium hover:bg-red-600 transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PIN Modal ── */}
      <PinModal
        open={showPinModal}
        onClose={() => setShowPinModal(false)}
        onVerified={handlePinVerified}
        description={pinAction === 'view-password' ? '请输入管理员 PIN 码以查看密码' : undefined}
      />

      {/* ── Toast 通知 ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-text-primary text-text-inverted
                       text-[14px] px-5 py-3 rounded-btn shadow-lg flex items-center gap-2"
          >
            <Check className="w-4 h-4 text-success shrink-0" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── 子组件：桌面端表格行 ──

function WindowRow({
  entry,
  visible,
  onTogglePassword,
  onUpdate,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  isDeletePending,
}: {
  entry: WindowEntry;
  visible: boolean;
  onTogglePassword: () => void;
  onUpdate: (field: keyof WindowEntry, value: string) => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  isDeletePending: boolean;
}) {
  return (
    <AnimatePresence mode="popLayout">
      <motion.div
        layout
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        className="grid border-b border-border/50 hover:bg-surface-light/50 transition-colors group items-center"
        style={{ gridTemplateColumns: '140px 160px 150px 72px' }}
      >
        <div className="py-3 overflow-hidden">
          <input
            type="text"
            value={entry.employeeName}
            onChange={(e) => onUpdate('employeeName', e.target.value)}
            placeholder="员工姓名"
            className="w-full h-9 px-3 bg-transparent border border-transparent rounded-input text-[13px] text-text-primary
                       hover:border-border focus:outline-none focus:border-primary focus:bg-surface-bg transition-all"
          />
        </div>
        <div className="py-3 overflow-hidden">
          <input
            type="text"
            value={entry.username}
            onChange={(e) => onUpdate('username', e.target.value)}
            placeholder="登录账号"
            className="w-full h-9 px-3 bg-transparent border border-transparent rounded-input text-[13px] text-text-primary
                       hover:border-border focus:outline-none focus:border-primary focus:bg-surface-bg transition-all"
          />
        </div>
        <div className="py-3 pl-1 pr-3 overflow-hidden">
          <div className="flex items-center gap-2 w-full">
            <input
              type={visible ? 'text' : 'password'}
              value={entry.password || ''}
              onChange={(e) => onUpdate('password', e.target.value)}
              placeholder={entry.password ? '••••••••' : '未配置'}
              className="flex-1 min-w-0 h-9 px-2 bg-transparent border border-transparent rounded-input text-[13px] text-text-primary
                         font-mono hover:border-border focus:outline-none focus:border-primary focus:bg-surface-bg transition-all"
            />
            <button
              type="button"
              onClick={onTogglePassword}
              className="w-7 h-7 flex items-center justify-center rounded-btn text-text-tertiary hover:text-text-primary hover:bg-surface-light transition-colors shrink-0"
              title={visible ? '隐藏密码' : '显示密码（需管理员PIN）'}
            >
              {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        <div className="py-3 px-2 flex items-center justify-center">
          {isDeletePending ? (
            <div className="flex items-center justify-center gap-1">
              <button
                onClick={onCancelDelete}
                className="w-7 h-7 flex items-center justify-center rounded-btn text-text-tertiary hover:text-text-primary hover:bg-surface-light transition-colors"
                title="取消"
              >
                <X className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onConfirmDelete}
                className="w-7 h-7 flex items-center justify-center rounded-btn text-danger hover:bg-danger-light transition-colors"
                title="确认删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={onDelete}
              className="w-8 h-8 flex items-center justify-center rounded-btn text-text-tertiary hover:text-danger hover:bg-danger-light transition-colors
                         opacity-0 group-hover:opacity-100"
              title="删除窗口"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

// ── 子组件：移动端卡片 ──

function WindowCard({
  entry,
  visible,
  onTogglePassword,
  onUpdate,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  isDeletePending,
}: {
  entry: WindowEntry;
  visible: boolean;
  onTogglePassword: () => void;
  onUpdate: (field: keyof WindowEntry, value: string) => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  isDeletePending: boolean;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="bg-surface-bg border border-border rounded-card p-4 space-y-3"
    >
      {/* 头部：删除按钮 */}
      <div className="flex items-center justify-end">
        {isDeletePending ? (
          <div className="flex items-center gap-1">
            <button
              onClick={onCancelDelete}
              className="px-3 h-8 text-[12px] text-text-secondary bg-surface border border-border rounded-btn hover:bg-surface-light transition-colors"
            >
              取消
            </button>
            <button
              onClick={onConfirmDelete}
              className="px-3 h-8 text-[12px] text-text-inverted bg-danger rounded-btn hover:bg-danger/90 transition-colors"
            >
              确认删除
            </button>
          </div>
        ) : (
          <button
            onClick={onDelete}
            className="w-8 h-8 flex items-center justify-center rounded-btn text-text-tertiary hover:text-danger hover:bg-danger-light transition-colors"
            title="删除窗口"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* 员工姓名 */}
      <div>
        <label className="text-[11px] font-medium text-text-tertiary">员工姓名</label>
        <input
          type="text"
          value={entry.employeeName}
          onChange={(e) => onUpdate('employeeName', e.target.value)}
          placeholder="员工姓名"
          className="mt-0.5 w-full h-9 px-3 bg-surface border border-border rounded-input text-[13px] text-text-primary
                     focus:outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* 登录账号 */}
      <div>
        <label className="text-[11px] font-medium text-text-tertiary">登录账号</label>
        <input
          type="text"
          value={entry.username}
          onChange={(e) => onUpdate('username', e.target.value)}
          placeholder="登录账号"
          className="mt-0.5 w-full h-9 px-3 bg-surface border border-border rounded-input text-[13px] text-text-primary
                     focus:outline-none focus:border-primary transition-colors"
        />
      </div>

      {/* 登录密码 */}
      <div>
        <label className="text-[11px] font-medium text-text-tertiary">登录密码</label>
        <div className="mt-0.5 flex items-center gap-1">
          <input
            type={visible ? 'text' : 'password'}
            value={entry.password || ''}
            onChange={(e) => onUpdate('password', e.target.value)}
            placeholder={entry.password ? '••••••••' : '未配置'}
            className="flex-1 h-9 px-3 bg-surface border border-border rounded-input text-[13px] text-text-primary font-mono
                       focus:outline-none focus:border-primary transition-colors"
          />
          <button
            type="button"
            onClick={onTogglePassword}
            className="w-9 h-9 flex items-center justify-center rounded-btn text-text-tertiary hover:text-text-primary hover:bg-surface-light transition-colors shrink-0 border border-border"
          >
            {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

    </motion.div>
  );
}
