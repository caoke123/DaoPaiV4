import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { AlertCircle, RotateCcw, Play, Trash2, Users, Settings2, ListChecks, Shield, AlertTriangle } from 'lucide-react';
import type { PlaywrightSiteWindowState } from '../api/client';
import { submitTask } from '../api/client';
import { useWindowState } from '../components/shared/WindowStateProvider';
import { useTaskExecution } from '../components/shared/TaskExecutionContext';
import { useRuntimeMode } from '../components/shared/RuntimeModeProvider';
import { useTaskLiveLogs } from '../hooks/useTaskLiveLogs';
import type { ExecutionMode } from '../components/shared/ScanWorkbench';
import type { Assignment } from '../lib/assignment-builder';
import TaskLogDisplay from '../components/shared/TaskLogDisplay';
import {
  getWindowDisplayStatus,
  canSelectAsExecutionWindow,
  getNodeBadge,
  getNodeCardClass,
  getNodeStatusText,
  type DisplayStatus,
} from '../lib/window-status';

const PAGE_SIZE_OPTIONS = [30, 50, 100, 200] as const;
type PageSizeOption = typeof PAGE_SIZE_OPTIONS[number];
const DEFAULT_PAGE_SIZE: PageSizeOption = 100;

const SIGNER_DISTRIBUTION = [
  { name: '本人', percent: 50 },
  { name: '家人', percent: 15 },
  { name: '家门口', percent: 10 },
  { name: '代收点', percent: 25 },
] as const;

/** Phase 1: 指定模式下的签收人选项（与签收策略 4 项一致，不含「前台」） */
const SIGNER_PERSON_OPTIONS = ['本人', '家人', '家门口', '代收点'] as const;
const DEFAULT_SIGNER_PERSON = SIGNER_PERSON_OPTIONS[0];

const WINDOW_COLORS = ['#0060FF', '#009951', '#E68A00', '#8A3FFC', '#E02433', '#2563EB', '#DB6B2E', '#0EA5E9'];
function getWindowColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return WINDOW_COLORS[Math.abs(hash) % WINDOW_COLORS.length];
}

export default function SignPage() {
  const execPanelRef = useRef<HTMLDivElement>(null);
  const lastActiveSiteRef = useRef<string | null>(null);

  const { activeSiteId, sites, siteWindows: ctxWindows, siteName, fetchError: ctxFetchError, isPlaywright } = useWindowState();

  // ── 运行模式（Phase 9-dryrun） ──
  const { dryRunMode } = useRuntimeMode();

  // Phase 9.1: 真实执行模式启动二次确认
  const [showRealModeConfirm, setShowRealModeConfirm] = useState(false);

  // ── Phase 1: 执行模式状态 ──
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('default');
  const [targetCourier, setTargetCourier] = useState<string>('');
  const [signerPerson, setSignerPerson] = useState<string>(DEFAULT_SIGNER_PERSON);
  const [modeToastVisible, setModeToastVisible] = useState(false);
  const modeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ★ Phase 4-I-1: 使用 PlaywrightSiteWindowState 保留诊断字段
  const siteWindows: PlaywrightSiteWindowState[] = useMemo(
    () => ctxWindows.filter(w => w.employeeName),
    [ctxWindows],
  );

  const [localFetchError, setLocalFetchError] = useState('');
  const fetchError = ctxFetchError || localFetchError;

  const [selectedWorkers, setSelectedWorkers] = useState<string[]>([]);
  const [workerPageSizes, setWorkerPageSizes] = useState<Record<string, PageSizeOption>>({});

  const {
    taskId, liveStatus, submitting, totalCount, doneCount, successCount, failedCount,
    workerProgress, rate, eta,
    selectedWorkers: ctxSelectedWorkers, allocations: ctxAllocations, taskOrigin,
    startTask: ctxStartTask, resetTask: ctxResetTask, setSubmitting: ctxSetSubmitting,
    restoreTask: ctxRestoreTask,
  } = useTaskExecution();

  // ── Phase 5-G-2: 使用统一日志 Hook ──
  const SUBMIT_API = '/api/operations/sign';
  const belongsToMe = !taskOrigin || taskOrigin === SUBMIT_API;
  const taskActive = !!(belongsToMe && taskId && liveStatus !== 'idle');
  const displayWorkers = taskActive && ctxSelectedWorkers.length > 0 ? ctxSelectedWorkers : selectedWorkers;

  const { allLogs, logsByWorker, globalLogs, isRunning: logsIsRunning } = useTaskLiveLogs({
    taskId: taskActive ? taskId : null,
    enabled: taskActive,
    workers: displayWorkers,
  });

  const getWorkerPageSize = useCallback((name: string): PageSizeOption => {
    return workerPageSizes[name] ?? DEFAULT_PAGE_SIZE;
  }, [workerPageSizes]);

  const setWorkerPageSize = useCallback((name: string, size: PageSizeOption) => {
    setWorkerPageSizes(prev => ({ ...prev, [name]: size }));
  }, []);

  // ★ P0 安全加固：当前站点员工姓名集合，用于过滤可能残留的跨站点员工
  const currentSiteStaffNames = useMemo(
    () => new Set(siteWindows.map(w => w.employeeName)),
    [siteWindows],
  );

  // ── Phase 1: 账号查找表（employeeName → username） ──
  const usernameByEmployee = useMemo(() => {
    const map: Record<string, string> = {};
    const activeSite = sites.find(s => s.id === activeSiteId);
    activeSite?.windows.forEach(w => {
      if (w.employeeName) {
        map[w.employeeName] = w.username || '';
      }
    });
    return map;
  }, [sites, activeSiteId]);

  // 当前站点可选派件员列表（用于指定模式的目标派件员下拉框）
  const courierOptions = useMemo(
    () => siteWindows.map(w => w.employeeName).filter(Boolean) as string[],
    [siteWindows],
  );

  const windowMetaByStaff = useMemo(() => {
    const map: Record<string, PlaywrightSiteWindowState> = {};
    siteWindows.forEach(w => {
      if (w.employeeName) map[w.employeeName] = w;
    });
    return map;
  }, [siteWindows]);

  // 指定模式下：当前选中的执行窗口
  const designatedWindow = executionMode === 'designated' && selectedWorkers.length === 1
    ? selectedWorkers[0]
    : null;

  // 指定模式下：当前选中的目标派件员账号
  const targetCourierAccount = targetCourier ? (usernameByEmployee[targetCourier] || '-') : '-';

  const assignments = useMemo(
    () => {
      // ★ P0 安全加固：只允许当前站点员工参与分配，过滤掉可能残留的旧站点员工
      const validWorkers = selectedWorkers.filter(name => currentSiteStaffNames.has(name));
      const baseAssignments: Assignment[] = validWorkers.map(staffName => ({
        staffName,
        siteId: activeSiteId,
        windowId: windowMetaByStaff[staffName]?.runtimeKey ? `staff-${staffName}` : undefined,
        browserId: windowMetaByStaff[staffName]?.browserId ?? null,
        runtimeKey: windowMetaByStaff[staffName]?.runtimeKey,
        waybillNos: ['SIGN_PREVIEW'],
        pageSize: getWorkerPageSize(staffName),
      }));
      // Phase 2-B: 指定模式下注入 targetCourierName/targetCourierAccount/signerPerson
      if (executionMode === 'designated' && baseAssignments.length === 1) {
        const account = usernameByEmployee[targetCourier] || '';
        baseAssignments[0] = {
          ...baseAssignments[0],
          targetCourierName: targetCourier || baseAssignments[0].staffName,
          targetCourierAccount: account,
          signerPerson: signerPerson as '本人' | '家人' | '家门口' | '代收点',
        };
      }
      return baseAssignments;
    },
    [selectedWorkers, getWorkerPageSize, currentSiteStaffNames, executionMode, targetCourier, usernameByEmployee, signerPerson, activeSiteId, windowMetaByStaff],
  );

  const allocations = useMemo(() => {
    const map: Record<string, number> = {};
    assignments.forEach(a => { map[a.staffName] = a.waybillNos.length; });
    return map;
  }, [assignments]);

  const displayAllocations = belongsToMe
    && Object.keys(ctxAllocations).length > 0
    ? ctxAllocations
    : allocations;

  useEffect(() => {
    if (liveStatus === 'running' && execPanelRef.current) {
      setTimeout(() => {
        execPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
  }, [liveStatus]);

  // ★ P0 安全加固：站点切换时清空任务选择状态，防止跨站点员工混入
  // 切换 activeSiteId 时，旧站点已选员工 / 分页配置 / 任务执行状态必须全部清空
  useEffect(() => {
    if (lastActiveSiteRef.current === null) {
      lastActiveSiteRef.current = activeSiteId;
      return;
    }
    if (lastActiveSiteRef.current === activeSiteId) return;
    lastActiveSiteRef.current = activeSiteId;

    setSelectedWorkers([]);
    setWorkerPageSizes({});
    setLocalFetchError('');
    // Phase 1: 切换站点时重置执行模式状态
    setTargetCourier('');
    setExecutionMode('default');
    setSignerPerson(DEFAULT_SIGNER_PERSON);
    if (modeToastTimerRef.current) {
      clearTimeout(modeToastTimerRef.current);
      setModeToastVisible(false);
    }
    ctxResetTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSiteId]);

  // Phase 5-G-7-2: 页面挂载时从 localStorage + 后端 PG 恢复任务完整状态
  useEffect(() => {
    ctxRestoreTask(SUBMIT_API);
  }, [ctxRestoreTask]);

  // 后端恢复完成后，同步配置区的本地选择态，避免返回页面时“已选 0”。
  useEffect(() => {
    if (taskActive && ctxSelectedWorkers.length > 0 && selectedWorkers.length === 0) {
      setSelectedWorkers([...ctxSelectedWorkers]);
    }
  }, [taskActive, ctxSelectedWorkers, selectedWorkers.length]);

  const toggleWorker = useCallback((name: string, displayStatus: DisplayStatus) => {
    if (liveStatus === 'running') return;
    if (!canSelectAsExecutionWindow(displayStatus)) return;
    setSelectedWorkers(prev => {
      // Phase 1: 指定模式下，单选 — 点击新员工时替换原选择
      if (executionMode === 'designated') {
        if (prev.includes(name) && prev.length === 1) {
          setTargetCourier('');
          return [];
        }
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
    // 指定 → 默认：保留当前单选，清空目标派件员
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

  const doStartTask = useCallback(async () => {
    if (selectedWorkers.length === 0 || !activeSiteId) return;
    // ★ P0 安全加固：提交前再次校验，确保 assignments 只包含当前站点员工
    if (assignments.length === 0) {
      setLocalFetchError('请选择当前网点的员工');
      return;
    }
    // 防御性日志：检测是否有跨站点员工被过滤
    const dropped = selectedWorkers.filter(name => !currentSiteStaffNames.has(name));
    if (dropped.length > 0) {
      console.warn('[SignPage] ⚠️ 检测到跨站点员工已被过滤:', dropped);
    }
    const validWorkers = assignments.map(a => a.staffName);
    ctxSetSubmitting(true);
    setLocalFetchError('');
    try {
      const resp = await submitTask(SUBMIT_API, { site: activeSiteId, executionMode, assignments, dryRunMode });
      if (!resp.taskId) {
        throw new Error('后端未返回任务 ID，无法开始实时日志跟踪');
      }
      ctxStartTask(resp.taskId, validWorkers, allocations, SUBMIT_API);
    } catch (e) {
      setLocalFetchError((e as Error).message || '提交任务失败');
      ctxSetSubmitting(false);
    }
  }, [selectedWorkers, currentSiteStaffNames, activeSiteId, assignments, allocations, ctxStartTask, ctxSetSubmitting, dryRunMode]);

  const handleStart = useCallback(() => {
    if (selectedWorkers.length === 0 || !activeSiteId) return;
    if (!dryRunMode) {
      setShowRealModeConfirm(true);
      return;
    }
    console.log(`[TaskStartTiming] T0 点击启动 ${SUBMIT_API}`);
    doStartTask();
  }, [selectedWorkers, activeSiteId, dryRunMode, doStartTask]);

  const confirmRealStart = useCallback(() => {
    setShowRealModeConfirm(false);
    console.log(`[TaskStartTiming] T0 点击启动 ${SUBMIT_API}`);
    doStartTask();
  }, [doStartTask]);

  const handleReset = useCallback(() => ctxResetTask(), [ctxResetTask]);

  const canStart = !taskOrigin
    && selectedWorkers.length > 0
    && !submitting
    // Phase 1: 指定模式额外校验 — 必须已选择目标派件员 + 签收人
    // Phase 2-B: 指定模式还必须确保目标派件员账号非空
    && (executionMode === 'default' || (
      targetCourier.trim().length > 0
      && (usernameByEmployee[targetCourier] || '') !== ''
      && signerPerson.length > 0
    ));
  const isRunning = belongsToMe && liveStatus === 'running';
  const isIdle = !belongsToMe || liveStatus === 'idle';
  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const logCols = displayWorkers.length <= 1 ? 'cols-1' : displayWorkers.length === 2 ? 'cols-2' : 'cols-3';

  // Phase 4-I-1: getStatusBadge / getCardClass 已迁移到 lib/window-status.ts

  const singleSelected = selectedWorkers.length === 1 ? selectedWorkers[0] : null;
  const pageSizeEditable = singleSelected !== null && !isRunning;

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
            <div className="page-title">签收录入</div>
            <div className="page-sub">
              {dryRunMode
                ? '试运行模式：选择派件员，系统执行到最终确认前停止，不会真实签收'
                : '真实执行模式：选择派件员，系统将执行真实签收操作，请确认运单号无误'}
            </div>
          </div>
          <div className="page-actions">
            {dryRunMode && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] text-[11px] font-medium
                  bg-blue-50 text-blue-600 border border-blue-200"
                title="试运行模式：签收执行到最终确认前停止，不会真实提交"
              >
                <Shield size={11} />
                试运行模式
              </span>
            )}
          </div>
        </div>

        <div className="sign-layout">
          <div className="panel">
            <div className="panel-head">
              <div className="panel-head-left">
                <div className="panel-icon">
                  <Users size={13} />
                </div>
                <div>
                  <div className="panel-title">派件员选择</div>
                  <div className="panel-sub">{executionMode === 'designated' ? '指定模式下仅选择 1 个执行窗口' : '选中窗口将并发执行签收录入'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="panel-badge">
                  已选 {selectedWorkers.length} / {executionMode === 'designated' ? 1 : siteWindows.filter(w => getWindowDisplayStatus(w, { isPlaywright, isInitializing: false }) === 'ready').length}
                </span>
              </div>
            </div>

            {/* Phase 1: 执行模式切换器 */}
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

            <div className="panel-body">
              <div className="nodes-zone exec-mode-enabled">
                <div className="nodes-grid">
                  {siteWindows.map(w => {
                    const isSel = selectedWorkers.includes(w.employeeName);
                    const color = getWindowColor(w.employeeName);
                    // Phase 4-I-1: 统一使用 getWindowDisplayStatus 计算 displayStatus
                    const ds = getWindowDisplayStatus(w, { isPlaywright, isInitializing: false });
                    const badge = getNodeBadge(ds);
                    const ps = getWorkerPageSize(w.employeeName);
                    const canClick = canSelectAsExecutionWindow(ds) && !isRunning;
                    return (
                      <div
                        key={w.employeeName}
                        className={getNodeCardClass(ds, isSel)}
                        onClick={() => canClick && toggleWorker(w.employeeName, ds)}
                        style={canClick ? {} : { cursor: 'not-allowed' }}
                      >
                        <div className={`node-status ${badge.cls}`}>{badge.label}</div>
                        <div className="node-avatar" style={{ background: color }}>{w.employeeName[0]}</div>
                        <div className="node-name">{w.employeeName}</div>
                        <div className="node-alloc">{isSel ? <b>{ps}条/页</b> : getNodeStatusText(ds)}</div>
                        <div className="check-mark">
                          <svg viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="1.5,5 4,7.5 8.5,2.5" />
                          </svg>
                        </div>
                      </div>
                    );
                  })}
                  {siteWindows.length === 0 && (
                    <div style={{ gridColumn: '1 / -1', padding: '24px', textAlign: 'center', color: 'var(--text-3)', fontSize: '13px' }}>
                      暂无可用派件员
                    </div>
                  )}
                </div>
                <div className="nodes-footer">
                  <span className="footer-hint">
                    {executionMode === 'designated' ? '指定模式仅支持单个执行窗口' : '点击卡片选择/取消'}
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
            </div>
          </div>

          <div className="panel sign-right-panel">
            <div className="panel-head">
              <div className="panel-head-left">
                <div className="panel-icon">
                  <Settings2 size={13} />
                </div>
                <div>
                  <div className="panel-title">{executionMode === 'designated' ? '目标派件员' : '签收策略'}</div>
                  <div className="panel-sub">
                    {executionMode === 'designated'
                      ? '指定目标派件员与签收人'
                      : '系统自动按固定比例分配签收人'}
                  </div>
                </div>
              </div>
              <span className="panel-badge">{executionMode === 'designated' ? '指定模式' : '标准模式'}</span>
            </div>
            <div className="panel-body" style={{ gap: '16px' }}>
              {/* ── 默认模式：签收比例 + 条数/页 + 目标派件员(只读) ── */}
              {executionMode === 'default' && (
                <>
                  <div>
                    <div className="sign-section-label">签收比例</div>
                    <div className="sign-distribution">
                      {SIGNER_DISTRIBUTION.map(s => (
                        <div key={s.name} className="sign-dist-item">
                          <span className="sign-dist-name">{s.name}</span>
                          <div className="sign-dist-bar-wrap">
                            <div className="sign-dist-bar" style={{ width: `${s.percent}%` }} />
                          </div>
                          <span className="sign-dist-pct">{s.percent}%</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
                    <div className="sign-section-label">条数/页</div>
                    {selectedWorkers.length === 0 ? (
                      <div style={{ fontSize: '12px', color: 'var(--text-3)', padding: '8px 0' }}>
                        请选择一个派件员
                      </div>
                    ) : selectedWorkers.length > 1 ? (
                      <div style={{ fontSize: '12px', color: 'var(--text-3)', padding: '8px 0' }}>
                        已选择{selectedWorkers.length}个派件员，无法批量修改条数配置
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: 'var(--text-2)', padding: '4px 0 8px' }}>
                        配置 <b style={{ color: 'var(--brand)' }}>{singleSelected}</b> 的每页条数
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {PAGE_SIZE_OPTIONS.map(size => {
                        const isActive = singleSelected !== null && getWorkerPageSize(singleSelected) === size;
                        return (
                          <button
                            key={size}
                            className={isActive ? 'btn-primary' : 'btn-ghost'}
                            onClick={() => singleSelected && setWorkerPageSize(singleSelected, size)}
                            disabled={!pageSizeEditable}
                            style={{ minWidth: '60px' }}
                          >
                            {size}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Phase 1: 默认模式下的目标派件员（只读） */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
                    <div className="sign-section-label">目标派件员</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', marginBottom: '8px' }}>
                      默认模式下，目标派件员与执行窗口一致
                    </div>
                    {selectedWorkers.length === 0 ? (
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
                    )}
                  </div>
                </>
              )}

              {/* ── 指定模式：目标派件员 + 账号 + 签收人 + 条数/页 ── */}
              {executionMode === 'designated' && (
                <>
                  <div>
                    <div className="sign-section-label">目标派件员</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-3)', marginBottom: '8px' }}>
                      执行窗口与目标派件员可不一致
                    </div>
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
                  </div>

                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
                    <div className="sign-section-label">签收人</div>
                    <div className="courier-field-row">
                      <span className="courier-field-label">签收人：</span>
                      <select
                        className="courier-select"
                        value={signerPerson}
                        onChange={e => setSignerPerson(e.target.value)}
                        disabled={isRunning}
                      >
                        {SIGNER_PERSON_OPTIONS.map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
                    <div className="sign-section-label">条数/页</div>
                    {selectedWorkers.length === 1 ? (
                      <div style={{ fontSize: '12px', color: 'var(--text-2)', padding: '4px 0 8px' }}>
                        配置 <b style={{ color: 'var(--brand)' }}>{singleSelected}</b> 的每页条数
                      </div>
                    ) : (
                      <div style={{ fontSize: '12px', color: 'var(--text-3)', padding: '8px 0' }}>
                        请先选择执行窗口
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {PAGE_SIZE_OPTIONS.map(size => {
                        const isActive = singleSelected !== null && getWorkerPageSize(singleSelected) === size;
                        return (
                          <button
                            key={size}
                            className={isActive ? 'btn-primary' : 'btn-ghost'}
                            onClick={() => singleSelected && setWorkerPageSize(singleSelected, size)}
                            disabled={!pageSizeEditable}
                            style={{ minWidth: '60px' }}
                          >
                            {size}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
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
            <Play size={14} />
            <span>
              {canStart
                ? executionMode === 'designated'
                  ? `启动 · 指定 ${selectedWorkers[0]} 执行 · ${signerPerson}签收`
                  : `启动自动签收 · ${selectedWorkers.length} 个派件员`
                : isRunning
                  ? '执行中...'
                  : executionMode === 'designated'
                    ? (selectedWorkers.length === 0 ? '请选择执行窗口' : '请选择目标派件员')
                    : '请选择派件员'}
            </span>
          </button>
        </div>
      </div>

      {/* EXEC PANEL */}
      <div ref={execPanelRef} className={`exec-panel ${belongsToMe && (isRunning || liveStatus === 'completed' || liveStatus === 'error') ? 'entering' : ''}`}>
        <div className="exec-header">
          <div>
            <div className="exec-title">实时执行日志</div>
            <div className="exec-meta">
              {displayWorkers.length > 0
                ? displayWorkers.map(name => `${name} ${getWorkerPageSize(name)}条/页`).join('  ·  ')
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
                {liveStatus === 'completed' ? '签收完成' :
                  liveStatus === 'error' ? '任务失败' :
                    isRunning ? '执行中...' : '等待启动'}
              </span>
            </div>
          </div>
        </div>

        {/* Phase 5-G-5: 系统日志面板已隐藏，业务页只显示员工窗口日志 */}

        {/* 日志区域：0个派件员显示占位；≥1个派件员显示派件员窗口日志 */}
        {displayWorkers.length === 0 ? (
          <div className="log-matrix cols-1">
            <div className="log-card">
              <div className="log-card-head">
                <div className="log-avatar" style={{ background: 'var(--brand)' }}>
                  <ListChecks size={12} />
                </div>
                <div>
                  <div className="log-name">员工窗口日志</div>
                  <div className="log-empno">选择派件员后显示独立窗口日志</div>
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
        ) : (
          <div className={`log-matrix ${logCols}`}>
            {displayWorkers.map(name => {
              const color = getWindowColor(name);
              const wp = workerProgress[name] || { done: 0, total: 1, failed: 0 };
              const logs = logsByWorker[name] || [];
              const pct = wp.total > 0 ? Math.round((wp.done / wp.total) * 100) : 0;
              const ps = getWorkerPageSize(name);
              return (
                <div key={name} className="log-card">
                  <div className="log-card-head">
                    <div className="log-avatar" style={{ background: color }}>{name[0]}</div>
                    <div>
                      <div className="log-name">{name}</div>
                      <div className="log-empno">{ps}条/页</div>
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
                    <TaskLogDisplay taskType="sign" logs={logs} />
                  </div>
                </div>
              );
            })}
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
                当前为<b className="text-orange-600">真实执行模式</b>，本次任务将执行最终签收提交。
              </p>
              <p className="text-[13px] text-gray-600">
                签收是高风险操作，请确认运单号和执行派件员无误。
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
