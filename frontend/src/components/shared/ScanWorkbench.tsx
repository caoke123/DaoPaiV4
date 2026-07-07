// ScanWorkbench — 统一扫描工作台
// 到件扫描 / 派件扫描 / 到派一体 三个页面共用此组件
// 唯一差异：submitApi 指向后端不同的 Playwright 任务路由
// Phase 9-dryrun: 右上角显示运行模式 Tag，真实模式隐藏"测试数据"按钮
// Phase 5-G-2: 使用 useTaskLiveLogs 统一日志获取，SSE + PG 轮询合并
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AlertCircle, RotateCcw, Wand2, Trash2, Shield, AlertTriangle, ListChecks } from 'lucide-react';
import { submitTask } from '../../api/client';
import { useWindowState } from '../shared/WindowStateProvider';
import { useTaskExecution } from '../shared/TaskExecutionContext';
import { useRuntimeMode } from '../shared/RuntimeModeProvider';
import { useTaskLiveLogs } from '../../hooks/useTaskLiveLogs';
import type { PlaywrightSiteWindowState } from '../../api/client';
import type { TaskType } from '../../lib/task-log-display/types';
import TaskLogDisplay from './TaskLogDisplay';
import { buildAssignments } from '../../lib/assignment-builder';
import {
  getWindowDisplayStatus,
  canSelectAsExecutionWindow,
  getNodeBadge,
  getNodeCardClass,
  getNodeStatusText,
  type DisplayStatus,
} from '../../lib/window-status';

/** 项目支持的签收人选项（与后端 SUPPORTED_SIGNERS 保持一致） */
const SUPPORTED_SIGNERS = [
  '本人',
  '家人',
  '家门口',
  '前台',
  '代收点',
] as const;

/** 执行模式：默认 / 指定 */
export type ExecutionMode = 'default' | 'designated';

export interface ScanWorkbenchProps {
  taskType: TaskType;
  title: string;
  description: string;
  submitApi: string;
  /** 隐藏运单输入（签收模式：无需录入运单，直接选择员工执行） */
  hideWaybillInput?: boolean;
  /** 启用执行模式切换（Phase 1：派件扫描 / 到派一体 启用，到件扫描不启用） */
  enableExecutionMode?: boolean;
}

// 运单解析防抖延迟
const PARSE_DEBOUNCE_MS = 300;

/**
 * 目标派件员能力判断（语义等价于后端 SettingsManager.isTargetableEmployee）
 * 只要 employeeName + username 非空即可，不要求 password / easybrBrowserId / 窗口状态。
 * 仅用于"目标派件员下拉框"，不用于"执行窗口"判断。
 */
function isTargetableEmployee(w: { employeeName?: string; username?: string } | undefined | null): boolean {
  return !!(
    w &&
    String(w.employeeName || '').trim() &&
    String(w.username || '').trim()
  );
}

const WINDOW_COLORS = ['#0060FF', '#009951', '#E68A00', '#8A3FFC', '#E02433', '#2563EB', '#DB6B2E', '#0EA5E9'];
function getWindowColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return WINDOW_COLORS[Math.abs(hash) % WINDOW_COLORS.length];
}

function generateMagicWaybills(count: number = 50): string {
  const prefix = '559999';
  const waybills: string[] = [];
  for (let i = 1; i <= count; i++) {
    const serial = String(i).padStart(8, '0');
    waybills.push(`${prefix}${serial}`);
  }
  return waybills.join('\n');
}

export default function ScanWorkbench({ taskType, title, description, submitApi, hideWaybillInput = false, enableExecutionMode = false }: ScanWorkbenchProps) {
  const execPanelRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActiveSiteRef = useRef<string | null>(null);

  // ── 统一窗口状态（来自 WindowStateProvider） ──
  const { activeSiteId, sites, siteWindows: ctxWindows, siteName, fetchError: ctxFetchError, isPlaywright } = useWindowState();

  // ── 运行模式（Phase 9-dryrun） ──
  const { dryRunMode } = useRuntimeMode();

  // Phase 9.1: 真实执行模式启动二次确认
  const [showRealModeConfirm, setShowRealModeConfirm] = useState(false);

  // ★ Phase 4-I-1: 使用 PlaywrightSiteWindowState 保留诊断字段（p0Passed/pageCount 等）
  const siteWindows: PlaywrightSiteWindowState[] = useMemo(
    () => ctxWindows.filter(w => w.employeeName),
    [ctxWindows],
  );
  
  // ★ 合并上下文错误和本地错误
  const [localFetchError, setLocalFetchError] = useState('');
  const fetchError = ctxFetchError || localFetchError;

  const [waybillInput, setWaybillInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');
  const [validWaybills, setValidWaybills] = useState<string[]>([]);
  const [dupCount, setDupCount] = useState(0);
  const [badCount, setBadCount] = useState(0);

  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [selectedSigner, setSelectedSigner] = useState<string>(SUPPORTED_SIGNERS[0]);

  // ── Phase 1: 执行模式状态 ──
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('default');
  const [targetCourier, setTargetCourier] = useState<string>('');
  const [modeToastVisible, setModeToastVisible] = useState(false);
  const modeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    taskId, liveStatus, submitting, totalCount, doneCount, successCount, failedCount,
    workerProgress, rate, eta,
    selectedWorkers: ctxSelectedWorkers, allocations: ctxAllocations, taskOrigin,
    startTask: ctxStartTask, resetTask: ctxResetTask, setSubmitting: ctxSetSubmitting,
    restoreTask: ctxRestoreTask,
  } = useTaskExecution();

  // ── Phase 5-G-2: 使用统一日志 Hook ──
  const belongsToMe = !taskOrigin || taskOrigin === submitApi;
  const taskActive = !!(belongsToMe && taskId && liveStatus !== 'idle');
  const displayWorkers = taskActive && ctxSelectedWorkers.length > 0 ? ctxSelectedWorkers : selectedWorkers;

  const { allLogs, logsByWorker, globalLogs, isRunning: logsIsRunning } = useTaskLiveLogs({
    taskId: taskActive ? taskId : null,
    enabled: taskActive,
    workers: displayWorkers,
  });

  const validCount = hideWaybillInput ? selectedWorkers.length : validWaybills.length;

  // ★ P0 安全加固：当前站点员工姓名集合，用于过滤可能残留的跨站点员工
  const currentSiteStaffNames = useMemo(
    () => new Set(siteWindows.map(w => w.employeeName)),
    [siteWindows],
  );

  // ── Phase 1: 账号查找表（employeeName → username） ──
  // 从 sites 配置中查找当前站点员工的账号信息
  const activeSiteConfig = useMemo(
    () => sites.find(s => s.id === activeSiteId),
    [sites, activeSiteId],
  );

  const usernameByEmployee = useMemo(() => {
    const map: Record<string, string> = {};
    activeSiteConfig?.windows.forEach(w => {
      if (w.employeeName) {
        map[w.employeeName] = w.username || '';
      }
    });
    return map;
  }, [activeSiteConfig]);

  // 当前站点可选派件员列表（用于指定模式的目标派件员下拉框）
  // ★ Phase 4-C 修复: 目标派件员数据源来自 settings 配置（isTargetableEmployee：employeeName + username），
  //   不再复用 siteWindows（窗口状态列表，会被后端 isLoginCapableWindow 过滤掉无密码员工）。
  //   执行窗口仍使用 siteWindows + canSelectAsExecutionWindow，二者分离。
  const courierOptions = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of activeSiteConfig?.windows ?? []) {
      if (!isTargetableEmployee(w)) continue;
      if (seen.has(w.employeeName)) continue;
      seen.add(w.employeeName);
      result.push(w.employeeName);
    }
    return result;
  }, [activeSiteConfig]);

  // 指定模式下：当前选中的执行窗口
  const designatedWindow = executionMode === 'designated' && selectedWorkers.length === 1
    ? selectedWorkers[0]
    : null;

  // 指定模式下：当前选中的目标派件员账号
  const targetCourierAccount = targetCourier ? (usernameByEmployee[targetCourier] || '-') : '-';

  const windowMetaByStaff = useMemo(() => {
    const map: Record<string, PlaywrightSiteWindowState> = {};
    siteWindows.forEach(w => {
      if (w.employeeName) map[w.employeeName] = w;
    });
    return map;
  }, [siteWindows]);

  const assignments = useMemo(
    () => {
      // ★ P0 安全加固：只允许当前站点员工参与分配，过滤掉可能残留的旧站点员工
      const validWorkers = selectedWorkers.filter(name => currentSiteStaffNames.has(name));
      const baseAssignments = hideWaybillInput
        ? validWorkers.map(staffName => ({ staffName, waybillNos: ['SIGN_PREVIEW'], signer: selectedSigner }))
        : buildAssignments(validWorkers, validWaybills);
      const normalizedAssignments = baseAssignments.map(a => {
        const w = windowMetaByStaff[a.staffName];
        return {
          ...a,
          siteId: activeSiteId,
          windowId: w?.runtimeKey ? `staff-${a.staffName}` : undefined,
          browserId: w?.browserId ?? null,
          runtimeKey: w?.runtimeKey,
        };
      });
      // Phase 2-B: 指定模式下注入 targetCourierName/targetCourierAccount
      if (executionMode === 'designated' && normalizedAssignments.length === 1) {
        const account = usernameByEmployee[targetCourier] || '';
        normalizedAssignments[0] = {
          ...normalizedAssignments[0],
          targetCourierName: targetCourier || baseAssignments[0].staffName,
          targetCourierAccount: account,
        };
      }
      return normalizedAssignments;
    },
    [selectedWorkers, validWaybills, hideWaybillInput, selectedSigner, currentSiteStaffNames, executionMode, targetCourier, usernameByEmployee, activeSiteId, windowMetaByStaff],
  );

  const allocations = useMemo(() => {
    const map: Record<string, number> = {};
    assignments.forEach(a => { map[a.staffName] = a.waybillNos.length; });
    return map;
  }, [assignments]);

  const displayAllocations = taskActive && Object.keys(ctxAllocations).length > 0 ? ctxAllocations : allocations;
  const isRunning = belongsToMe && liveStatus === 'running';
  const isIdle = !belongsToMe || liveStatus === 'idle';
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const colsClass = displayWorkers.length <= 1 ? 'cols-1' : displayWorkers.length === 2 ? 'cols-2' : 'cols-3';

  // 运单输入防抖：waybillInput 即时更新保证输入流畅，debouncedInput 延迟 300ms 用于解析
  const handleInputChange = useCallback((value: string) => {
    setWaybillInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedInput(value);
    }, PARSE_DEBOUNCE_MS);
  }, []);

  // 运单解析（基于防抖后的输入）：两步空格策略
  useEffect(() => {
    const raw = debouncedInput.trim();
    if (!raw) {
      setValidWaybills([]);
      setDupCount(0);
      setBadCount(0);
      return;
    }
    // 1. 按换行/逗号分割（明确的单号分隔符）
    const lines = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    const seen = new Set<string>();
    const valid: string[] = [];
    let dc = 0;
    let bc = 0;
    const isValid = (s: string) => /^5\d{13}$|^BN\d{14}$/i.test(s);
    lines.forEach(line => {
      // 2. 先尝试整行去掉空格后是否是一个合法单号（支持 "7720 6729 6332 280" 中间有空格的单号）
      const cleaned = line.replace(/\s+/g, '');
      if (!cleaned) return;
      if (isValid(cleaned)) {
        if (seen.has(cleaned)) dc++;
        else { seen.add(cleaned); valid.push(cleaned); }
        return;
      }
      // 3. 整行不合法，则按空格拆分，逐段校验（支持同行空格分隔多个单号）
      const segments = line.split(/\s+/).map(s => s.trim()).filter(Boolean);
      let lineHasValid = false;
      segments.forEach(seg => {
        if (isValid(seg)) {
          lineHasValid = true;
          if (seen.has(seg)) dc++;
          else { seen.add(seg); valid.push(seg); }
        }
      });
      if (!lineHasValid) bc++;
    });
    setValidWaybills(valid);
    setDupCount(dc);
    setBadCount(bc);
  }, [debouncedInput]);

  // ★ P0 安全加固：站点切换时清空任务选择状态，防止跨站点员工混入
  // 切换 activeSiteId 时，旧站点已选员工 / 运单 / 任务执行状态必须全部清空
  useEffect(() => {
    if (lastActiveSiteRef.current === null) {
      lastActiveSiteRef.current = activeSiteId;
      return;
    }
    if (lastActiveSiteRef.current === activeSiteId) return;
    lastActiveSiteRef.current = activeSiteId;

    setSelectedWorkers([]);
    setWaybillInput('');
    setDebouncedInput('');
    setValidWaybills([]);
    setDupCount(0);
    setBadCount(0);
    setLocalFetchError('');
    // Phase 1: 切换站点时重置执行模式状态
    setTargetCourier('');
    setExecutionMode('default');
    if (modeToastTimerRef.current) {
      clearTimeout(modeToastTimerRef.current);
      setModeToastVisible(false);
    }
    ctxResetTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSiteId]);

  // ★ 窗口状态轮询由 WindowStateProvider 统一管理，任务轮询由 TaskExecutionContext 处理

  // Phase 5-G-7-2: 页面挂载时从 localStorage + 后端 PG 恢复任务完整状态
  useEffect(() => {
    if (submitApi) {
      ctxRestoreTask(submitApi);
    }
  }, [submitApi, ctxRestoreTask]);

  // 后端恢复完成后，同步配置区的本地选择态，避免返回页面时“已选 0”。
  useEffect(() => {
    if (taskActive && ctxSelectedWorkers.length > 0 && selectedWorkers.length === 0) {
      setSelectedWorkers([...ctxSelectedWorkers]);
    }
  }, [taskActive, ctxSelectedWorkers, selectedWorkers.length]);

  // 任务执行面板自动滚动
  useEffect(() => {
    if (liveStatus === 'running' && execPanelRef.current) {
      setTimeout(() => {
        execPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
  }, [liveStatus]);

  const toggleWorker = useCallback((name: string, displayStatus: DisplayStatus) => {
    if (liveStatus === 'running') return;
    if (!canSelectAsExecutionWindow(displayStatus)) return;
    setSelectedWorkers(prev => {
      // Phase 1: 指定模式下，单选 — 点击新员工时替换原选择
      if (executionMode === 'designated') {
        // 同一员工再次点击 → 取消选择 + 清空目标派件员
        if (prev.includes(name) && prev.length === 1) {
          setTargetCourier('');
          return [];
        }
        // 切换到新员工 → 同步初始化目标派件员（用户可后续通过下拉框修改）
        setTargetCourier(name);
        return [name];
      }
      // 默认模式：保持多选
      return prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
    });
  }, [liveStatus, executionMode]);

  // Phase 1: 切换执行模式
  const handleSwitchMode = useCallback((mode: ExecutionMode) => {
    if (mode === executionMode) return;
    if (liveStatus === 'running') return;

    // 默认 → 指定：若已多选，只保留第一个，并显示轻提示
    if (mode === 'designated' && selectedWorkers.length > 1) {
      const first = selectedWorkers[0];
      setSelectedWorkers([first]);
      setTargetCourier(first);
      setModeToastVisible(true);
      if (modeToastTimerRef.current) clearTimeout(modeToastTimerRef.current);
      modeToastTimerRef.current = setTimeout(() => setModeToastVisible(false), 2400);
    }
    // 指定 → 默认：保留当前单选，清空目标派件员（默认模式下与执行窗口一致）
    if (mode === 'default') {
      setTargetCourier('');
    }
    setExecutionMode(mode);
  }, [executionMode, selectedWorkers, liveStatus]);

  const selectAllOnline = useCallback(() => {
    // Phase 4-I-1: 使用统一 displayStatus 判断 ready
    const ready = siteWindows
      .filter(w => getWindowDisplayStatus(w, { isPlaywright, isInitializing: false }) === 'ready')
      .map(w => w.employeeName);
    setSelectedWorkers(ready);
  }, [siteWindows, isPlaywright]);

  const handleMagicFill = () => {
    handleInputChange(generateMagicWaybills(50));
  };

  const handleClearInput = () => {
    setWaybillInput('');
    setDebouncedInput('');
  };

  const doStartTask = useCallback(async () => {
    if (validCount === 0 || selectedWorkers.length === 0 || !activeSiteId) return;
    // ★ P0 安全加固：提交前再次校验，确保 assignments 只包含当前站点员工
    if (assignments.length === 0) {
      setLocalFetchError('请选择当前网点的员工');
      return;
    }
    // 防御性日志：检测是否有跨站点员工被过滤（正常情况下 Fix1 已清空，此处为兜底）
    const dropped = selectedWorkers.filter(name => !currentSiteStaffNames.has(name));
    if (dropped.length > 0) {
      console.warn('[ScanWorkbench] ⚠️ 检测到跨站点员工已被过滤:', dropped);
    }
    const validWorkers = assignments.map(a => a.staffName);
    ctxSetSubmitting(true);
    setLocalFetchError('');
    try {
      // Phase 5-G-3-2: 传递 dryRunMode 给后端，后端写入 inputData.browserDryRun，Agent Executor 校验通过后执行
      const resp = await submitTask(submitApi, { site: activeSiteId, executionMode, assignments, dryRunMode });
      if (!resp.taskId) {
        throw new Error('后端未返回任务 ID，无法开始实时日志跟踪');
      }
      ctxStartTask(resp.taskId, validWorkers, allocations, submitApi);
    } catch (e) {
      setLocalFetchError((e as Error).message || '提交任务失败');
      ctxSetSubmitting(false);
    }
  }, [validCount, selectedWorkers, currentSiteStaffNames, activeSiteId, assignments, allocations, submitApi, ctxStartTask, ctxSetSubmitting, dryRunMode]);

  const handleStart = useCallback(() => {
    if (validCount === 0 || selectedWorkers.length === 0 || !activeSiteId) return;
    if (!dryRunMode) {
      setShowRealModeConfirm(true);
      return;
    }
    console.log(`[TaskStartTiming] T0 点击启动 ${submitApi}`);
    doStartTask();
  }, [validCount, selectedWorkers, activeSiteId, dryRunMode, doStartTask, submitApi]);

  const confirmRealStart = useCallback(() => {
    setShowRealModeConfirm(false);
    console.log(`[TaskStartTiming] T0 点击启动 ${submitApi}`);
    doStartTask();
  }, [doStartTask, submitApi]);

  const handleReset = useCallback(() => {
    ctxResetTask();
  }, [ctxResetTask]);

  const canStart = !taskOrigin
    && selectedWorkers.length > 0
    && !submitting
    && (hideWaybillInput || validCount > 0)
    // Phase 1: 指定模式额外校验 — 必须已选择目标派件员
    // Phase 2-B: 指定模式还必须确保目标派件员账号非空
    && (executionMode === 'default' || (
      targetCourier.trim().length > 0 && (usernameByEmployee[targetCourier] || '') !== ''
    ));

  return (
    <div style={{ minHeight: '100%', position: 'relative', maxWidth: '1440px', margin: '0 auto' }}>

      <div className={`config-panel ${isRunning ? 'exiting' : ''}`}>

        {fetchError && (
          <div style={{
            padding: '10px 14px',
            background: 'var(--err-soft)',
            borderRadius: 'var(--r-lg)',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: 'var(--err)',
          }}>
            <AlertCircle style={{ width: 16, height: 16 }} />
            {fetchError}
          </div>
        )}

        <div className="page-header">
          <div className="page-title-wrap">
            <div className="page-title">{title}</div>
            <div className="page-sub">{description}</div>
          </div>
          <div className="page-actions">
            {dryRunMode && (
              <>
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[11px] font-medium
                    bg-blue-50 text-blue-600 border border-blue-200"
                  title="试运行模式：所有任务只执行到最终提交前，不会真实提交"
                >
                  <Shield size={11} />
                  试运行模式
                </span>
                {!hideWaybillInput && (
                  <button className="btn-ghost" onClick={handleMagicFill}>
                    <Wand2 size={12} />
                    测试数据
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="workbench">
          {!hideWaybillInput && (
            <div className="panel">
              <div className="panel-head">
                <div className="panel-head-left">
                  <div className="panel-icon">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V5L10 2z" />
                      <path d="M10 2v3h3M5 8h6M5 11h4" />
                    </svg>
                  </div>
                  <div>
                    <div className="panel-title">批量运单录入</div>
                    <div className="panel-sub">粘贴 · 自动去重 · 实时解析</div>
                  </div>
                </div>
                <span className="panel-badge">{validCount} 条就绪</span>
              </div>
              <div className="panel-body">
                <div className="textarea-wrap">
                  <textarea
                    value={waybillInput}
                    onChange={e => handleInputChange(e.target.value)}
                    placeholder={`粘贴笨鸟运单号，支持换行、空格、逗号分隔\n单号中的空格会自动去除\n\n55400037581233\nBN55400037581233`}
                    spellCheck={false}
                    disabled={isRunning}
                  />
                  <div className="textarea-foot">
                    <div className="parse-counts">
                      <span>已识别 <span className="val">{validCount}</span></span>
                      <span>重复 <span className="warn-c">{dupCount}</span></span>
                      <span>非法 <span className="err">{badCount}</span></span>
                    </div>
                    <button className="foot-btn" onClick={handleClearInput} disabled={isRunning}>
                      清空
                    </button>
                  </div>
                </div>

                {selectedWorkers.length > 0 && validCount > 0 && (
                  <div className="alloc-bar-wrap">
                    <div className="alloc-bar-label">分配预览</div>
                    <div className="alloc-track">
                      {selectedWorkers.map(name => {
                        const cnt = allocations[name] || 0;
                        const color = getWindowColor(name);
                        return <div key={name} className="alloc-track-seg" style={{ flex: cnt, background: color, opacity: 0.75 }} />;
                      })}
                    </div>
                    <div className="alloc-names">
                      {selectedWorkers.map(name => {
                        const cnt = allocations[name] || 0;
                        const color = getWindowColor(name);
                        return <span key={name}><b style={{ color }}>{name}</b> {cnt}</span>;
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {hideWaybillInput && (
            <div className="panel" style={{ gridColumn: '1 / -1' }}>
              <div className="panel-head">
                <div className="panel-head-left">
                  <div className="panel-icon">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 2v12h10V4l-2-2H3z" />
                      <path d="M7 7h2M7 10h6" />
                    </svg>
                  </div>
                  <div>
                    <div className="panel-title">签收人选择</div>
                    <div className="panel-sub">选择本次批量签收使用的签收人类型</div>
                  </div>
                </div>
                <span className="panel-badge">当前：{selectedSigner}</span>
              </div>
              <div className="panel-body">
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {SUPPORTED_SIGNERS.map(signer => (
                    <button
                      key={signer}
                      className={selectedSigner === signer ? 'btn-primary' : 'btn-ghost'}
                      onClick={() => setSelectedSigner(signer)}
                      disabled={isRunning}
                      style={{ minWidth: '80px' }}
                    >
                      {signer}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="panel" style={hideWaybillInput ? { gridColumn: '1 / -1' } : undefined}>
            <div className="panel-head">
              <div className="panel-head-left">
                <div className="panel-icon">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="2" />
                    <circle cx="3" cy="4" r="1.5" />
                    <circle cx="13" cy="4" r="1.5" />
                    <circle cx="3" cy="12" r="1.5" />
                    <circle cx="13" cy="12" r="1.5" />
                  </svg>
                </div>
                <div>
                  <div className="panel-title">{hideWaybillInput ? '选择签收窗口' : '执行节点分配'}</div>
                  <div className="panel-sub">{hideWaybillInput ? '选中窗口将并发执行签收录入' : '选中窗口自动拆分运单'}</div>
                </div>
              </div>
              <span className="panel-badge">
                已选 {selectedWorkers.length} / {executionMode === 'designated' ? 1 : siteWindows.filter(w => getWindowDisplayStatus(w, { isPlaywright, isInitializing: false }) === 'ready').length}
              </span>
            </div>

            {/* Phase 1: 执行模式切换器（仅在 enableExecutionMode 时渲染） */}
            {enableExecutionMode && (
              <div className="exec-mode-switcher">
                <span className="exec-mode-label">执行模式</span>
                <div className="exec-mode-tabs">
                  <button
                    type="button"
                    className={`exec-mode-tab ${executionMode === 'default' ? 'active' : ''}`}
                    onClick={() => handleSwitchMode('default')}
                    disabled={isRunning}
                  >
                    默认模式
                  </button>
                  <button
                    type="button"
                    className={`exec-mode-tab ${executionMode === 'designated' ? 'active' : ''}`}
                    onClick={() => handleSwitchMode('designated')}
                    disabled={isRunning}
                  >
                    指定模式
                  </button>
                </div>
              </div>
            )}

            <div className="panel-body">
              <div className={`nodes-zone ${enableExecutionMode ? 'exec-mode-enabled' : ''}`}>
                <div className="nodes-grid">
                  {siteWindows.map(w => {
                    const isSel = selectedWorkers.includes(w.employeeName);
                    const alloc = isSel ? (allocations[w.employeeName] || 0) : 0;
                    const color = getWindowColor(w.employeeName);
                    // Phase 4-I-1: 统一使用 getWindowDisplayStatus 计算 displayStatus
                    const ds = getWindowDisplayStatus(w, { isPlaywright, isInitializing: false });
                    const badge = getNodeBadge(ds);
                    const canSelect = canSelectAsExecutionWindow(ds);
                    return (
                      <div
                        key={w.employeeName}
                        className={getNodeCardClass(ds, isSel)}
                        onClick={() => canSelect && toggleWorker(w.employeeName, ds)}
                        style={canSelect ? {} : { cursor: 'not-allowed' }}
                      >
                        <div className={`node-status ${badge.cls}`}>{badge.label}</div>
                        <div className="node-avatar" style={{ background: color }}>{w.employeeName[0]}</div>
                        <div className="node-name">{w.employeeName}</div>
                        <div className="node-alloc">
                          {isSel ? (
                            alloc > 0 ? <b>{alloc} 单</b> : <span style={{ color: 'var(--accent)' }}>已选择</span>
                          ) : getNodeStatusText(ds)}
                        </div>
                        <div className="check-mark">
                          <svg viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1.5,5 4,7.5 8.5,2.5" />
                          </svg>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="nodes-footer">
                  <span className="footer-hint">
                    {executionMode === 'designated' ? '指定模式仅支持单个执行窗口' : '自动负载均衡 ±15%'}
                  </span>
                  {/* 默认模式：保留全选在线；指定模式：完全隐藏按钮（已有 footer-hint 提示文案） */}
                  {executionMode === 'default' && (
                    <button
                      className="foot-btn"
                      onClick={selectAllOnline}
                      disabled={isRunning}
                    >
                      全选在线
                    </button>
                  )}
                </div>
              </div>

              {/* Phase 1: 目标派件员面板（仅在 enableExecutionMode 时渲染） */}
              {enableExecutionMode && (
                <div className="target-courier-panel">
                  <div className="target-courier-title">目标派件员</div>
                  <div className="target-courier-sub">
                    {executionMode === 'default'
                      ? '默认模式下，目标派件员与执行窗口一致'
                      : '执行窗口与目标派件员可不一致'}
                  </div>

                  {/* 默认模式：只读映射 */}
                  {executionMode === 'default' && (
                    selectedWorkers.length === 0 ? (
                      <div className="courier-empty-hint">请先选择执行窗口</div>
                    ) : selectedWorkers.length === 1 ? (
                      <>
                        <div className="courier-field-row">
                          <span className="courier-field-label">执行窗口：</span>
                          <span className="courier-field-value">{selectedWorkers[0]}</span>
                        </div>
                        <div className="courier-field-row">
                          <span className="courier-field-label">目标派件员：</span>
                          <span className="courier-field-value">{selectedWorkers[0]}</span>
                        </div>
                        <div className="courier-field-row">
                          <span className="courier-field-label">账号：</span>
                          <span className="courier-field-value mono">
                            {usernameByEmployee[selectedWorkers[0]] || '-'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="courier-mapping-list">
                        {selectedWorkers.map(name => (
                          <div key={name} className="courier-mapping-row">
                            <span className="courier-mapping-name">{name}</span>
                            <span className="courier-mapping-arrow">→</span>
                            <span className="courier-mapping-target">{name}</span>
                            <span className="courier-mapping-account">
                              账号：{usernameByEmployee[name] || '-'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {/* 指定模式：可编辑下拉框 + 账号自动展示 */}
                  {executionMode === 'designated' && (
                    <>
                      {!designatedWindow && (
                        <div className="courier-empty-hint">请先选择执行窗口</div>
                      )}
                      <div className="courier-field-row">
                        <span className="courier-field-label">目标派件员：</span>
                        <select
                          className="courier-select"
                          value={targetCourier}
                          onChange={e => setTargetCourier(e.target.value)}
                          disabled={isRunning || !designatedWindow}
                        >
                          <option value="">请选择派件员</option>
                          {courierOptions.map(name => (
                            <option key={name} value={name}>{name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="courier-field-row">
                        <span className="courier-field-label">账号：</span>
                        <span className="courier-field-value mono">{targetCourierAccount}</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Phase 1: 切换模式时的轻提示 */}
        {modeToastVisible && (
          <div className="mode-toast visible">指定模式仅支持单个执行窗口</div>
        )}

        <div style={{ padding: '0' }}>
          <button className="launch-btn" disabled={!canStart} onClick={handleStart}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="4,2 14,8 4,14" />
            </svg>
            <span>
              {canStart
                ? hideWaybillInput
                  ? `启动 · ${selectedWorkers.length} 窗口并发签收`
                  : executionMode === 'designated'
                    ? `启动 · 指定 ${selectedWorkers[0]} 执行 · ${validCount} 条运单`
                    : `启动 · ${selectedWorkers.length} 窗口并发 · ${validCount} 条运单`
                : hideWaybillInput
                  ? '请选择签收窗口'
                  : executionMode === 'designated'
                    ? (selectedWorkers.length === 0 ? '请选择执行窗口' : '请选择目标派件员')
                    : '启动分布式扫描'}
            </span>
          </button>
        </div>
      </div>

      {/* EXEC PANEL — 始终渲染，belongsToMe 控制可见性 */}
      <div ref={execPanelRef} className={`exec-panel ${belongsToMe && (isRunning || liveStatus === 'completed' || liveStatus === 'error') ? 'entering' : ''}`}>
        <div className="exec-header">
          <div>
            <div className="exec-title">实时执行日志</div>
            <div className="exec-meta">
              {displayWorkers.length > 0
                ? displayWorkers.map(name => `${name} ${displayAllocations[name] || 0}单`).join('  ·  ')
                : '—'}
              {siteName ? `  ·  ${siteName}` : ''}
            </div>
          </div>
          <div className="exec-controls">
            {isRunning && (
              <button className="btn-sm" onClick={handleReset}>
                <Trash2 size={12} />
                清空日志
              </button>
            )}
            {(liveStatus === 'completed' || liveStatus === 'error') && (
              <button className="btn-sm" onClick={handleReset} style={{ color: 'var(--ok)', borderColor: 'var(--ok-soft)' }}>
                <RotateCcw size={12} />
                完成并返回
              </button>
            )}
          </div>
        </div>

        <div className="global-progress-wrap">
          <div className="gp-stat">
            <div className="gp-val">{doneCount}</div>
            <div className="gp-label">已完成</div>
          </div>
          <div className="gp-divider" />
          <div className="gp-stat">
            <div className="gp-val">{totalCount}</div>
            <div className="gp-label">总计</div>
          </div>
          <div className="gp-divider" />
          <div className="gp-stat">
            <div className="gp-val" style={{ color: 'var(--ok)' }}>{successCount}</div>
            <div className="gp-label">成功</div>
          </div>
          <div className="gp-divider" />
          <div className="gp-stat">
            <div className="gp-val" style={{ color: 'var(--err)' }}>{failedCount}</div>
            <div className="gp-label">失败</div>
          </div>
          <div className="gp-divider" />
          <div className="gp-stat">
            <div className="gp-val">{isRunning ? rate : '—'}</div>
            <div className="gp-label">单/分钟</div>
          </div>
          <div className="gp-divider" />
          <div className="gp-stat">
            <div className="gp-val">{isRunning && eta != null ? (eta > 0 ? `${eta}m` : '<1m') : '—'}</div>
            <div className="gp-label">预计剩余</div>
          </div>
          <div className="gp-bar-wrap">
            <div className="gp-bar-track">
              <div
                className="gp-bar-fill"
                style={{
                  width: `${progressPct}%`,
                  background: liveStatus === 'error' ? 'var(--err)' : 'var(--text-1)',
                }}
              />
            </div>
            <div className="gp-bar-label">
              <span>{progressPct}%</span>
              <span>
                {liveStatus === 'completed' ? '扫描完成' :
                  liveStatus === 'error' ? '任务失败' :
                    isRunning ? '执行中...' : '刚刚启动'}
              </span>
            </div>
          </div>
        </div>

        {/* Phase 5-G-5: 系统日志面板已隐藏，业务页只显示员工窗口日志 */}

        {displayWorkers.length > 0 ? (
          <div className={`log-matrix ${colsClass}`}>
            {displayWorkers.map(name => {
              const color = getWindowColor(name);
              const wp = workerProgress[name] || { done: 0, total: displayAllocations[name] || 0, failed: 0 };
              const logs = logsByWorker[name] || [];
              const pct = wp.total > 0 ? Math.round((wp.done / wp.total) * 100) : 0;
              return (
                <div key={name} className="log-card">
                  <div className="log-card-head">
                    <div className="log-avatar" style={{ background: color }}>{name[0]}</div>
                    <div>
                      <div className="log-name">{name}</div>
                      <div className="log-empno">{siteName || ''}</div>
                    </div>
                    <div className="log-progress-right">
                      <span className="log-count"><b>{wp.done}</b>/{wp.total}</span>
                      <span className="log-pct">{pct}%</span>
                    </div>
                  </div>
                  <div className="log-progress-bar">
                    <div className="log-progress-fill" style={{ width: `${pct}%`, background: color }} />
                  </div>
                  <div className="log-body">
                    <TaskLogDisplay taskType={taskType} logs={logs} />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="log-matrix cols-1">
            <div className="log-card">
              <div className="log-card-head">
                <div className="log-avatar" style={{ background: 'var(--brand)' }}>
                  <ListChecks size={12} />
                </div>
                <div>
                  <div className="log-name">员工窗口日志</div>
                  <div className="log-empno">选择节点后显示分窗口日志</div>
                </div>
              </div>
              <div className="log-progress-bar">
                <div className="log-progress-fill" style={{ width: '0%', background: 'var(--text-3)' }} />
              </div>
              <div className="log-body">
                <div className="log-line" style={{ opacity: 0.5 }}>
                  <span className="log-ts">--:--:--</span>
                  <span className="log-lv info">INFO</span>
                  <span className="log-msg">等待员工窗口日志...</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Phase 9.1: 真实执行模式启动确认 */}
      {showRealModeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowRealModeConfirm(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative bg-white border border-[#e5e7eb] rounded-xl shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <h3 className="text-[15px] font-semibold text-gray-900">真实执行模式确认</h3>
              </div>
            </div>
            <div className="space-y-2 mb-5">
              <p className="text-[13px] text-gray-600">
                当前为<b className="text-orange-600">真实执行模式</b>，本次任务将执行最终提交。
              </p>
              <p className="text-[13px] text-gray-600">
                请确认运单号和执行窗口无误。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRealModeConfirm(false)}
                className="px-4 h-9 rounded-lg border border-gray-200 text-[13px] text-gray-600 hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmRealStart}
                className="px-4 h-9 rounded-lg bg-orange-500 text-white text-[13px] font-medium hover:bg-orange-600 transition-colors"
              >
                确认启动
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
