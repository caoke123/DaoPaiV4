import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckCircle, Clock, RotateCw, AlertTriangle,
  Copy, X, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  ArrowUp, ArrowDown, ArrowUpDown,
  PackageOpen, Truck, ClipboardCheck, Loader2,
  Terminal, BarChart3, CopyCheck,
  Settings, Trash2, Search, Filter, FileText, Users, Check, Shield,
  PlayCircle,
} from 'lucide-react';
import {
  getTaskList,
  getTaskStats,
  getTaskSummary,
  getTaskWaybills,
  getTaskStaffSummary,
  getTaskLogsById,
  getTaskProgress,
  getTaskStatus,
  getTaskDeleteStats,
  batchDeleteTasks,
  createArrivalDryRunTask,
  createAgentDispatchTask,
  createAgentIntegratedTask,
  createAgentSignTask,
  type TaskItem,
  type TaskListResponse,
  type TaskStatsResponse,
  type TaskSummaryResponse,
  type TaskLogEntry,
  type WaybillResult,
  type WorkerStat,
  type DeleteStatsResponse,
} from '../api/client';
import { useRuntimeMode } from '../components/shared/RuntimeModeProvider';
import { useWindowState } from '../components/shared/WindowStateProvider';

// ── Phase 3: input_data 解析 ──

interface ParsedInputData {
  executionMode: 'default' | 'designated';
  assignments: Array<{
    staffName?: string;
    targetCourierName?: string;
    targetCourierAccount?: string;
    signerPerson?: string;
  }>;
}

function parseInputData(inputData?: string): ParsedInputData {
  if (!inputData) return { executionMode: 'default', assignments: [] };
  try {
    let data: any;
    if (typeof inputData === 'object') {
      data = inputData;
    } else {
      data = JSON.parse(inputData);
    }
    return {
      executionMode: data.executionMode === 'designated' ? 'designated' : 'default',
      assignments: Array.isArray(data.assignments) ? data.assignments : [],
    };
  } catch {
    return { executionMode: 'default', assignments: [] };
  }
}

function formatExecutionTarget(task: TaskItem): string {
  const parsed = parseInputData(task.inputData);
  const assignments = parsed.assignments;
  const isDesignated = parsed.executionMode === 'designated';
  const staffNames = assignments.map(a => a.staffName).filter(Boolean) as string[];

  if (isDesignated) {
    const target = assignments[0];
    const courier = target?.targetCourierName || '';
    return staffNames.length > 0 && courier
      ? `${staffNames[0]} → ${courier}`
      : (staffNames[0] || '-');
  }

  if (staffNames.length === 0) return '-';
  if (staffNames.length <= 3) {
    return staffNames.join('、');
  }
  return `${staffNames.slice(0, 2).join('、')} 等 ${staffNames.length} 人`;
}

// ── 类型映射（UI 本地类型） ──

type BatchStatus = 'completed' | 'executing' | 'not_started' | 'error';

const statusConfig: Record<BatchStatus, { icon: React.ReactNode; label: string; color: string }> = {
  completed: { icon: <CheckCircle className="w-3.5 h-3.5" />, label: '已完成', color: 'text-success' },
  executing: { icon: <RotateCw className="w-3.5 h-3.5 animate-spin" />, label: '执行中', color: 'text-primary' },
  not_started: { icon: <Clock className="w-3.5 h-3.5" />, label: '未开始', color: 'text-text-tertiary' },
  error: { icon: <AlertTriangle className="w-3.5 h-3.5" />, label: '异常', color: 'text-danger' },
};

const typeIconMap: Record<string, React.ReactNode> = {
  arrive: <PackageOpen className="w-3.5 h-3.5" />,
  arrival: <PackageOpen className="w-3.5 h-3.5" />,
  dispatch: <Truck className="w-3.5 h-3.5" />,
  sign: <ClipboardCheck className="w-3.5 h-3.5" />,
};

const typeLabelMap: Record<string, string> = {
  arrive: '到件扫描',
  arrival: '到件扫描',
  dispatch: '派件扫描',
  sign: '签收录入',
  integrated: '到派一体',
  init_window: '窗口初始化',
  agent_test: '执行电脑测试',
};

function apiStatusToBatchStatus(s: TaskItem['status']): BatchStatus {
  switch (s) {
    case 'done': return 'completed';
    case 'running': return 'executing';
    case 'pending': return 'not_started';
    case 'assigned': return 'executing';
    case 'failed': return 'error';
    case 'cancelled': return 'error';
  }
}

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

function formatDuration(startIso: string, endIso?: string | null): string {
  try {
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    const ms = Math.max(0, end - start);
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours}时${minutes % 60}分`;
  } catch {
    return '-';
  }
}

// ── 日志级别颜色 ──

const logLevelStyles: Record<string, { dot: string; text: string; labelColor: string; label: string }> = {
  info:    { dot: 'bg-[#1677ff]', text: 'text-text-primary', labelColor: 'text-[#1677ff] bg-[#1677ff]/10', label: '信息' },
  success: { dot: 'bg-success',    text: 'text-text-primary', labelColor: 'text-success bg-success/10',    label: '成功' },
  warning: { dot: 'bg-warning',    text: 'text-text-primary', labelColor: 'text-warning bg-warning/10',    label: '警告' },
  error:   { dot: 'bg-danger',     text: 'text-danger',       labelColor: 'text-danger bg-danger/10',      label: '失败' },
};

// ── 小型 Toast ──

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-gray-900 text-white px-5 py-2.5 rounded-lg shadow-lg text-[13px] flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
      <CopyCheck className="w-4 h-4 text-green-400" />
      {message}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// 详情抽屉（4 Tabs 布局）
// ══════════════════════════════════════════════════════════════

type DrawerTab = 'info' | 'staff' | 'anomaly' | 'logs';

function TaskDetailDrawer({
  task,
  onClose,
}: {
  task: TaskItem;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<DrawerTab>(
    task.status === 'pending' || task.status === 'running' ? 'logs' : 'info'
  );

  // ── 实时任务状态（从 PG 轮询，避免父组件 selectedTask 冻结快照导致轮询不启动）──
  const [liveStatus, setLiveStatus] = useState<TaskItem['status']>(task.status);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Tab1 任务信息数据 ──
  const [summary, setSummary] = useState<TaskSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [workerCount, setWorkerCount] = useState(0);

  // ── Tab2 执行人员数据 ──
  const [workers, setWorkers] = useState<WorkerStat[]>([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [expandedStaff, setExpandedStaff] = useState<string | null>(null);
  const [staffWaybills, setStaffWaybills] = useState<WaybillResult[]>([]);
  const [staffWaybillsLoading, setStaffWaybillsLoading] = useState(false);

  // ── Tab3 异常运单 ──
  const [anomalyWaybills, setAnomalyWaybills] = useState<WaybillResult[]>([]);
  const [anomalyTotal, setAnomalyTotal] = useState(0);
  const [anomalyLoading, setAnomalyLoading] = useState(false);

  // ── Tab4 执行日志 ──
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Toast ──
  const [toastMsg, setToastMsg] = useState('');

  // ── 加载任务信息 ──
  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const [summaryData, staffData] = await Promise.all([
        getTaskSummary(task.id),
        getTaskStaffSummary(task.id),
      ]);
      setSummary(summaryData);
      setWorkerCount(staffData.workers.length);
    } catch {
      setSummary(null);
      setWorkerCount(0);
    } finally {
      setSummaryLoading(false);
    }
  }, [task.id]);

  // ── 加载执行人员列表 ──
  const loadWorkers = useCallback(async () => {
    setWorkersLoading(true);
    try {
      const data = await getTaskStaffSummary(task.id);
      setWorkers(data.workers);
    } catch {
      setWorkers([]);
    } finally {
      setWorkersLoading(false);
    }
  }, [task.id]);

  // ── 展开某员工运单 ──
  const toggleStaffExpand = useCallback(async (staffName: string) => {
    if (expandedStaff === staffName) {
      setExpandedStaff(null);
      setStaffWaybills([]);
      return;
    }
    setExpandedStaff(staffName);
    setStaffWaybillsLoading(true);
    try {
      const data = await getTaskWaybills(task.id, undefined, staffName);
      setStaffWaybills(data.waybills);
    } catch {
      setStaffWaybills([]);
    } finally {
      setStaffWaybillsLoading(false);
    }
  }, [task.id, expandedStaff]);

  // ── 加载异常运单 ──
  const loadAnomaly = useCallback(async () => {
    setAnomalyLoading(true);
    try {
      const data = await getTaskWaybills(task.id, 'FAILED');
      setAnomalyWaybills(data.waybills);
      setAnomalyTotal(data.total);
    } catch {
      setAnomalyWaybills([]);
      setAnomalyTotal(0);
    } finally {
      setAnomalyLoading(false);
    }
  }, [task.id]);

  // ── 加载日志 ──
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const data = await getTaskLogsById(task.id, 500);
      // 按 timestamp ASC 排序，确保时间正序
      const sortedLogs = [...data.logs].sort((a, b) => a.timestamp - b.timestamp);
      setLogs(sortedLogs);
      setLogsTotal(data.total);
    } catch {
      setLogs([]);
      setLogsTotal(0);
    } finally {
      setLogsLoading(false);
    }
  }, [task.id]);

  // ── 初始化：加载任务信息 ──
  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // ── 切换 Tab 时加载对应数据 ──
  useEffect(() => {
    if (activeTab === 'staff' && workers.length === 0) loadWorkers();
    if (activeTab === 'anomaly' && anomalyWaybills.length === 0) loadAnomaly();
    if (activeTab === 'logs') loadLogs();
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 实时状态轮询：从 PG 获取最新 status，驱动日志轮询 ──
  // 任务状态可能为 pending / assigned / running / done / failed / cancelled
  // pending/assigned/running 阶段都需要持续轮询日志
  useEffect(() => {
    // 初始即认为可能是执行中，立即查一次状态
    let cancelled = false;
    const pollStatus = async () => {
      try {
        const s = await getTaskStatus(task.id);
        if (cancelled) return;
        setLiveStatus(s.status as TaskItem['status']);
      } catch {
        // 忽略，下次再试
      }
    };
    pollStatus();
    statusPollRef.current = setInterval(pollStatus, 2000);
    return () => {
      cancelled = true;
      if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; }
    };
  }, [task.id]);

  // ── 日志轮询：activeTab=logs 且任务未结束时持续轮询 ──
  useEffect(() => {
    const isRunning = liveStatus === 'pending' || liveStatus === 'assigned' || liveStatus === 'running';
    if (activeTab === 'logs' && isRunning) {
      // 立即拉一次，再启动定时轮询
      loadLogs();
      pollTimerRef.current = setInterval(loadLogs, 1500);
      return () => {
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      };
    } else {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      // 任务结束时（done/failed/cancelled）再拉一次最终日志，确保完整
      if (activeTab === 'logs' && (liveStatus === 'done' || liveStatus === 'failed' || liveStatus === 'cancelled')) {
        loadLogs();
      }
    }
  }, [activeTab, liveStatus, loadLogs]);

  // ── 日志自动滚动 ──
  useEffect(() => {
    if (activeTab === 'logs' && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [logs, activeTab]);

  // ── 一键复制所有异常运单号 ──
  const copyAnomalyBarcodes = (list: WaybillResult[]) => {
    const barcodes = list.filter(r => !r.success).map(r => r.waybillNo);
    if (barcodes.length === 0) return;
    copyToClipboard(barcodes.join('\n'));
    setToastMsg(`已复制 ${barcodes.length} 个异常单号`);
  };

  // ── Tab 定义 ──
   const tabs: { key: DrawerTab; label: string; icon: React.ReactNode; count?: number; dataAttr?: string }[] = [
     { key: 'info', label: '任务信息', icon: <BarChart3 className="w-3.5 h-3.5" /> },
     { key: 'staff', label: '执行人员', icon: <ClipboardCheck className="w-3.5 h-3.5" />, count: workerCount },
     { key: 'anomaly', label: '异常运单', icon: <AlertTriangle className="w-3.5 h-3.5" />, count: task.failCount, dataAttr: 'data-drawer-anomaly-tab' as const },
     { key: 'logs', label: '执行日志', icon: <Terminal className="w-3.5 h-3.5" /> },
   ];

  return (
    <>
      <div className="w-full bg-surface border-l border-border flex flex-col h-full overflow-hidden rounded-tl-2xl rounded-bl-2xl" style={{ boxShadow: '0 12px 48px rgba(0,0,0,0.12)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <div className="text-[15px] font-semibold text-text-primary">
              {typeLabelMap[task.type] || task.type} · {task.siteName || task.site}
            </div>
            <div className="text-[12px] text-text-tertiary font-mono mt-0.5">{formatDate(task.createdAt)}</div>
            {(() => {
              const parsed = parseInputData(task.inputData);
              if (parsed.executionMode === 'designated') {
                const target = parsed.assignments[0];
                const parts: string[] = ['指定模式', `${target?.staffName || '-'}窗口 → ${target?.targetCourierName || '-'} / ${target?.targetCourierAccount || '-'}`];
                if (task.type === 'sign' && target?.signerPerson) {
                  parts.push(`${target.signerPerson}签收`);
                }
                return <div className="text-[12px] text-text-secondary mt-1">{parts.join('｜')}</div>;
              }
              return <div className="text-[12px] text-text-secondary mt-1">默认模式｜执行窗口与目标派件员一致</div>;
            })()}
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-btn hover:bg-surface-light text-text-tertiary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              {...(tab.dataAttr ? { [tab.dataAttr]: true } : {})}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <span className={`ml-0.5 px-1.5 py-px rounded-full text-[10px] font-bold ${
                  tab.key === 'anomaly' ? 'bg-danger/15 text-danger' : 'bg-primary/10 text-primary'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-auto">
          {/* ═══════════════ Tab1 任务信息 ═══════════════ */}
          {activeTab === 'info' && (
            <div className="p-5 space-y-4">
              {summaryLoading ? (
                <div className="flex items-center justify-center py-12 text-text-tertiary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : summary ? (
                <>
                  {/* 卡片一：任务信息 */}
                  <div className="rounded-xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
                    <div className="text-[12px] font-semibold text-text-tertiary mb-4 flex items-center gap-1.5">
                      <BarChart3 className="w-3.5 h-3.5" />
                      任务信息
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
                      <div>
                        <div className="text-text-tertiary mb-1">任务类型</div>
                        <div className="text-text-primary font-medium">{typeLabelMap[summary.type] || summary.type}</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">任务状态</div>
                        <div>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_COLOR[summary.status] || 'text-text-tertiary bg-border'}`}>
                            {STATUS_ICON[summary.status]}
                            {STATUS_LABEL[summary.status] || summary.status}
                          </span>
                        </div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">创建时间</div>
                        <div className="text-text-primary font-mono text-[11px]">{formatDate(summary.createdAt)}</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">完成时间</div>
                        <div className="text-text-primary font-mono text-[11px]">
                          {summary.finishedAt ? formatDate(summary.finishedAt) : '—'}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <div className="text-text-tertiary mb-1">耗时</div>
                        <div className="text-text-primary font-mono">{formatDuration(summary.createdAt, summary.finishedAt)}</div>
                      </div>
                    </div>
                    {(() => {
                      const parsed = parseInputData(task.inputData);
                      const target = parsed.assignments[0];
                      return (
                        <div className="mt-4 pt-4 border-t border-border">
                          <div className="text-[11px] font-semibold text-text-tertiary mb-3">执行模式</div>
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                            <div>
                              <span className="text-text-tertiary">模式</span>
                              <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${parsed.executionMode === 'designated' ? 'bg-[#0060FF]/10 text-[#004CCC]' : 'bg-[#f5f5f5] text-text-tertiary'}`}>
                                {parsed.executionMode === 'designated' ? '指定模式' : '默认模式'}
                              </span>
                            </div>
                            {parsed.executionMode === 'designated' ? (
                              <>
                                <div>
                                  <span className="text-text-tertiary">执行窗口</span>
                                  <span className="ml-2 text-text-primary font-medium">{target?.staffName || '-'}</span>
                                </div>
                                <div>
                                  <span className="text-text-tertiary">目标派件员</span>
                                  <span className="ml-2 text-text-primary font-medium">{target?.targetCourierName || '-'}</span>
                                </div>
                                <div>
                                  <span className="text-text-tertiary">目标账号</span>
                                  <span className="ml-2 text-text-primary font-mono">{target?.targetCourierAccount || '-'}</span>
                                </div>
                                {task.type === 'sign' && target?.signerPerson && (
                                  <div>
                                    <span className="text-text-tertiary">签收人</span>
                                    <span className="ml-2 text-text-primary font-medium">{target.signerPerson}</span>
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="col-span-2">
                                <span className="text-text-tertiary">说明：</span>
                                <span className="text-text-secondary">执行窗口与目标派件员一致</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* 卡片二：执行结果 */}
                  <div className="rounded-xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
                    <div className="text-[12px] font-semibold text-text-tertiary mb-4 flex items-center gap-1.5">
                      <CopyCheck className="w-3.5 h-3.5" />
                      执行结果
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-[12px]">
                      <div>
                        <div className="text-text-tertiary mb-1">总运单</div>
                        <div className="text-text-primary font-mono font-semibold text-[15px]">{summary.totalCount}</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">参与员工</div>
                        <div className="text-text-primary font-mono font-semibold text-[15px]">{workerCount} 人</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">成功</div>
                        <div className="text-success font-mono font-semibold text-[15px]">{summary.successCount}</div>
                      </div>
                      <div>
                        <div className="text-text-tertiary mb-1">失败</div>
                        <div className="text-danger font-mono font-semibold text-[15px]">{summary.failedCount}</div>
                      </div>
                      {summary.partialCount > 0 && (
                        <div>
                          <div className="text-text-tertiary mb-1">部分成功</div>
                          <div className="text-warning font-mono font-semibold text-[15px]">{summary.partialCount}</div>
                        </div>
                      )}
                      {summary.unknownCount > 0 && (
                        <div>
                          <div className="text-text-tertiary mb-1">待核实</div>
                          <div className="text-text-tertiary font-mono font-semibold text-[15px]">{summary.unknownCount}</div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-12">
                  <div className="text-[13px] text-text-tertiary mb-1">任务详情数据不可用</div>
                  <div className="text-[11px] text-text-tertiary/60">PostgreSQL 服务暂不可达，不影响任务列表浏览</div>
                </div>
              )}
            </div>
          )}

          {/* ═══════════════ Tab2 执行人员 ═══════════════ */}
          {activeTab === 'staff' && (
            <div className="p-5">
              {workersLoading ? (
                <div className="flex items-center justify-center py-12 text-text-tertiary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : workers.length === 0 ? (
                <div className="text-center py-16 text-text-tertiary">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <div className="text-[13px]">暂无员工数据</div>
                </div>
              ) : (
                <div className="rounded-xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
                  {workers.map(w => {
                    const isExpanded = expandedStaff === w.staffName;
                    return (
                      <div key={w.staffName} className="border-b border-[#f0f0f0] last:border-b-0">
                        <button
                          onClick={() => toggleStaffExpand(w.staffName)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-[#fafafa] transition-colors"
                        >
                          <div className="w-9 h-9 rounded-full bg-[#1677ff]/10 flex items-center justify-center text-[#1677ff] text-[13px] font-semibold shrink-0">
                            {w.staffName.charAt(0)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-text-primary">{w.staffName}</div>
                            <div className="text-[11px] text-text-tertiary mt-0.5">
                              成功 <span className="text-success font-semibold">{w.successCount}</span> / 共 {w.total}
                              {w.failCount > 0 && (
                                <span className="text-danger ml-2 font-medium">异常 {w.failCount}</span>
                              )}
                            </div>
                          </div>
                          {isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-text-tertiary shrink-0" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-text-tertiary shrink-0" />
                          )}
                        </button>

                        {isExpanded && (
                          <div className="bg-[#fafafa] border-t border-[#f0f0f0]">
                            {staffWaybillsLoading ? (
                              <div className="flex items-center justify-center py-8 text-text-tertiary">
                                <Loader2 className="w-4 h-4 animate-spin" />
                              </div>
                            ) : staffWaybills.length === 0 ? (
                              <div className="text-center text-text-tertiary text-[12px] py-6">暂无运单数据</div>
                            ) : (
                              <div>
                                {staffWaybills.map((r, i) => (
                                  <div
                                    key={i}
                                    className={`flex items-center gap-2.5 px-5 py-2.5 text-[12px] border-b border-[#f0f0f0] last:border-b-0 ${
                                      !r.success ? 'bg-red-500/5' : (r.dryRun ? 'bg-blue-500/5' : '')
                                    }`}
                                  >
                                    {r.dryRun ? (
                                      <Shield className="w-3.5 h-3.5 text-[#1677ff] shrink-0" />
                                    ) : r.success ? (
                                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                                    ) : (
                                      <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0" />
                                    )}
                                    <span className="text-text-primary font-mono text-[11px] w-[140px] shrink-0 truncate">{r.waybillNo}</span>
                                    <span className={`ml-auto text-right truncate ${
                                      r.dryRun ? 'text-[#1677ff] font-medium' :
                                      r.success ? 'text-text-tertiary' : 'text-danger font-medium'
                                    }`}>
                                      {r.dryRun
                                        ? (r.message || '试运行跳过提交')
                                        : r.success ? (r.message || '成功') : (r.message || '失败')}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ═══════════════ Tab3 异常运单 ═══════════════ */}
          {activeTab === 'anomaly' && (
            <div className="p-5">
              {anomalyLoading && anomalyWaybills.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-text-tertiary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : anomalyWaybills.length === 0 ? (
                <div className="text-center py-16 text-text-tertiary">
                  <CheckCircle className="w-8 h-8 mx-auto mb-2 text-success/50" />
                  <div className="text-[13px]">无异常运单</div>
                  <div className="text-[11px] mt-1">任务执行过程中未产生失败记录</div>
                </div>
              ) : (
                <div className="rounded-xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-[#f0f0f0] bg-white">
                    <button
                      onClick={() => copyAnomalyBarcodes(anomalyWaybills)}
                      disabled={anomalyWaybills.filter(r => !r.success).length === 0}
                      className="flex items-center gap-1.5 px-3 h-8 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[12px] font-medium hover:bg-danger/15 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      复制异常单号
                    </button>
                    <span className="ml-auto text-[12px] text-text-tertiary">共 <span className="font-semibold text-text-primary">{anomalyTotal}</span> 条</span>
                  </div>
                  <div>
                    {anomalyWaybills.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2.5 px-4 py-3 text-[12px] border-b border-[#f0f0f0] last:border-b-0 hover:bg-[#fafafa] transition-colors bg-red-500/5"
                      >
                        <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
                        <span className="text-text-primary font-mono text-[11px] w-[140px] shrink-0 truncate">{r.waybillNo}</span>
                        {r.staffName && (
                          <span className="text-text-tertiary text-[11px] px-2 py-0.5 rounded bg-[#f5f7fa] w-[60px] shrink-0 truncate text-center">{r.staffName}</span>
                        )}
                        <span className="ml-auto text-[12px] text-right text-danger font-medium max-w-[180px] truncate">
                          {r.message || '失败'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══════════════ Tab4 执行日志（时间线） ═══════════════ */}
          {activeTab === 'logs' && (
            <div className="p-5">
              {/* TC-05B: 顶部统计摘要卡 */}
              {(task.status === 'done' || task.status === 'failed' || task.doneCount > 0) && logs.length > 0 && (() => {
                const tSuccess = (task.doneCount || 0) - (task.failCount || 0);
                const tFailed = task.failCount || 0;
                const tTotal = task.totalCount || task.doneCount || 0;
                const tStart = task.createdAt ? new Date(task.createdAt).getTime() : 0;
                const tEnd = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
                const duration = tStart > 0 ? Math.max(0, Math.round((tEnd - tStart) / 1000)) : 0;
                const durStr = duration >= 60 ? `${Math.floor(duration / 60)}分${duration % 60}秒` : `${duration}秒`;
                return (
                  <div className="grid grid-cols-4 gap-3 mb-4">
                    <div className="rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-sm">
                      <div className="text-[11px] text-text-tertiary mb-1">成功</div>
                      <div className="text-[20px] font-bold text-success leading-none">{Math.max(0, tSuccess)}</div>
                    </div>
                    <div className="rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-sm">
                      <div className="text-[11px] text-text-tertiary mb-1">失败</div>
                      <div className={`text-[20px] font-bold leading-none ${tFailed > 0 ? 'text-danger' : 'text-text-tertiary'}`}>{tFailed}</div>
                    </div>
                    <div className="rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-sm">
                      <div className="text-[11px] text-text-tertiary mb-1">总数</div>
                      <div className="text-[20px] font-bold text-text-primary leading-none">{tTotal}</div>
                    </div>
                    <div className="rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-sm">
                      <div className="text-[11px] text-text-tertiary mb-1">耗时</div>
                      <div className="text-[20px] font-bold text-text-primary leading-none">{durStr}</div>
                    </div>
                  </div>
                );
              })()}

              {logsLoading && logs.length === 0 ? (
                <div className="flex items-center justify-center py-16 text-text-tertiary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                </div>
              ) : logs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-text-tertiary">
                  <div className="w-14 h-14 rounded-2xl bg-[#f5f7fa] flex items-center justify-center mb-3">
                    <FileText className="w-6 h-6 text-text-tertiary/60" />
                  </div>
                  <div className="text-[14px] font-medium text-text-secondary">等待执行日志...</div>
                  <div className="text-[12px] text-text-tertiary mt-1">
                    {liveStatus === 'pending' ? '任务排队中，等待 Agent 拉取' :
                     liveStatus === 'assigned' ? '任务已分配，等待执行日志' :
                     liveStatus === 'running' ? '任务执行中，日志即将到达' :
                     '该任务尚未产生执行记录'}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-[#e5e7eb] bg-white shadow-sm overflow-hidden">
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-[#f0f0f0] bg-white">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                      <span className="text-[12px] font-medium text-text-primary">执行日志</span>
                    </div>
                    {(liveStatus === 'pending' || liveStatus === 'assigned' || liveStatus === 'running') && (
                      <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[11px] font-medium">实时更新</span>
                    )}
                    <button
                      onClick={loadLogs}
                      disabled={logsLoading}
                      className="ml-auto flex items-center gap-1 px-2 h-7 rounded-md text-[11px] text-text-tertiary hover:bg-[#f5f7fa] hover:text-text-secondary transition-colors"
                    >
                      <RotateCw className={`w-3 h-3 ${logsLoading ? 'animate-spin' : ''}`} />
                      刷新
                    </button>
                  </div>
                  <div
                    ref={logsContainerRef}
                    className="max-h-[60vh] overflow-auto py-3"
                  >
                    <div className="relative pl-10 pr-5">
                      <div className="absolute left-[22px] top-2 bottom-2 w-px bg-[#e5e7eb]" />
                      {logs.map((log) => {
                        const level = (log.level || 'info').toLowerCase();
                        const style = logLevelStyles[level] || logLevelStyles.info;
                        const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
                        return (
                          <div key={log.id} className="relative py-2.5 group">
                            <span className={`absolute left-[-22px] top-[14px] w-2.5 h-2.5 rounded-full ${style.dot} ring-4 ring-white z-[1]`} />
                            <div className="flex items-start gap-3">
                              <div className="flex flex-col shrink-0">
                                <span className="font-mono text-[11px] text-text-tertiary leading-5">{time}</span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className={`inline-flex items-center px-1.5 py-px rounded text-[10px] font-semibold ${style.labelColor}`}>
                                    {style.label}
                                  </span>
                                  {log.source && (
                                    <span className="text-[10px] text-text-tertiary">{log.source}</span>
                                  )}
                                </div>
                                <div className={`text-[12px] leading-relaxed break-words ${style.text}`}>
                                  {log.message}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="px-4 py-2 border-t border-[#f0f0f0] bg-[#fafafa] text-[11px] text-text-tertiary flex items-center justify-between">
                    <span>共 {logsTotal} 条记录</span>
                    {(liveStatus === 'pending' || liveStatus === 'assigned' || liveStatus === 'running') && (
                      <span className="flex items-center gap-1 text-primary">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                        实时同步中
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toastMsg && <Toast message={toastMsg} onDone={() => setToastMsg('')} />}
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// 主页面 — TC-05A 运营任务控制台
// ══════════════════════════════════════════════════════════════

const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'arrive', label: '到件扫描' },
  { value: 'arrival', label: '到件扫描' },
  { value: 'dispatch', label: '派件扫描' },
  { value: 'sign', label: '签收录入' },
  { value: 'integrated', label: '综合任务' },
  { value: 'init_window', label: '窗口初始化' },
  { value: 'agent_test', label: '执行电脑测试' },
];

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'running', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'pending', label: '待处理' },
];

type SortColumn = 'createdAt' | 'type' | 'site' | 'status' | 'staffCount' | 'totalCount' | 'failCount';
type SortDir = 'asc' | 'desc';

function sortTasksForTable(tasks: TaskItem[], col: SortColumn, dir: SortDir): TaskItem[] {
  return [...tasks].sort((a, b) => {
    let va: string | number, vb: string | number;
    switch (col) {
      case 'createdAt':
        va = new Date(a.createdAt).getTime();
        vb = new Date(b.createdAt).getTime();
        break;
      case 'type':
        va = a.type;
        vb = b.type;
        break;
      case 'site':
        va = a.site;
        vb = b.site;
        break;
      case 'status':
        va = (STATUS_PRIORITY[a.status] ?? 9);
        vb = (STATUS_PRIORITY[b.status] ?? 9);
        break;
      case 'staffCount':
        va = a.staffCount ?? 0;
        vb = b.staffCount ?? 0;
        break;
      case 'totalCount':
        va = a.totalCount;
        vb = b.totalCount;
        break;
      case 'failCount':
        va = a.failCount;
        vb = b.failCount;
        break;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

const STATUS_PRIORITY: Record<string, number> = {
  running: 0, failed: 1, pending: 2, done: 3, cancelled: 4,
};

const STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  running: '进行中',
  failed: '失败',
  cancelled: '已取消',
  pending: '待处理',
};

const STATUS_COLOR: Record<string, string> = {
  done: 'text-success bg-success/10',
  running: 'text-primary bg-primary/10',
  failed: 'text-danger bg-danger/10',
  cancelled: 'text-text-tertiary bg-border',
  pending: 'text-text-tertiary bg-border',
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle className="w-3 h-3" />,
  running: <RotateCw className="w-3 h-3 animate-spin" />,
  failed: <AlertTriangle className="w-3 h-3" />,
  cancelled: <X className="w-3 h-3" />,
  pending: <Clock className="w-3 h-3" />,
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<TaskStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ── Phase M-2B: 接入设置中心运行模式开关 ──
  const { dryRunMode } = useRuntimeMode();

  // ── Phase M-3B: 动态站点上下文，替代硬编码 siteId ──
  const { activeSiteId, sites, siteName: ctxSiteName } = useWindowState();
  const currentSiteName = sites.find(s => s.id === activeSiteId)?.name || ctxSiteName;
  const currentSiteId = activeSiteId;

  useEffect(() => {
    if (selectedTask) {
      setDrawerOpen(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setDrawerOpen(true)));
    } else {
      setDrawerOpen(false);
    }
  }, [selectedTask?.id]);

  // ── 筛选 ──
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // ── 分页 ──
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  // ── 排序 ──
  const [sortCol, setSortCol] = useState<SortColumn>('createdAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // ── 管理工具 ──
  const [showAdminMenu, setShowAdminMenu] = useState(false);

  // ── 删除模式 ──
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [deleteStats, setDeleteStats] = useState<DeleteStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // ── Toast ──
  const [toastMsg, setToastMsg] = useState('');

  // ── Phase 5-E: 到件 DRY-RUN 创建 ──
  const [showDryRunModal, setShowDryRunModal] = useState(false);
  const [dryRunWaybills, setDryRunWaybills] = useState('TEST000000001\nTEST000000002');
  const [dryRunCreating, setDryRunCreating] = useState(false);

  // ── Phase 5-E: 派件 DRY-RUN 创建 ──
  const [showDispatchModal, setShowDispatchModal] = useState(false);
  const [dispatchWaybills, setDispatchWaybills] = useState('TEST000000001\nTEST000000002');
  const [dispatchCreating, setDispatchCreating] = useState(false);

  // ── Phase 5-E: 到派一体 DRY-RUN 创建 ──
  const [showIntegratedModal, setShowIntegratedModal] = useState(false);
  const [integratedWaybills, setIntegratedWaybills] = useState('TEST000000001\nTEST000000002');
  const [integratedCreating, setIntegratedCreating] = useState(false);

  // ── Phase 5-E: 签收 DRY-RUN 创建 ──
  const [showSignModal, setShowSignModal] = useState(false);
  const [signWaybills, setSignWaybills] = useState('TEST000000001\nTEST000000002');
  const [signCreating, setSignCreating] = useState(false);

  // ── 判断任务是否可删除 ──
  const isTaskDeletable = (task: TaskItem) =>
    task.status !== 'running' && task.status !== 'pending';

  // ── 进入/退出删除模式 ──
  const enterDeleteMode = () => {
    setShowAdminMenu(false);
    setDeleteMode(true);
    setSelectedTaskIds(new Set());
    setDeleteStats(null);
    setSelectedTask(null);
  };
  const exitDeleteMode = () => {
    setDeleteMode(false);
    setSelectedTaskIds(new Set());
    setDeleteStats(null);
    setShowDeleteConfirm(false);
  };

  // ── 切换单个任务选中 ──
  const toggleTaskSelection = (taskId: string, selected: boolean) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (selected) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  // ── 选中ID变化时获取删除统计 ──
  useEffect(() => {
    if (!deleteMode) return;
    const ids = Array.from(selectedTaskIds);
    if (ids.length === 0) {
      setDeleteStats(null);
      return;
    }
    setStatsLoading(true);
    getTaskDeleteStats(ids)
      .then(setDeleteStats)
      .catch(() => setDeleteStats(null))
      .finally(() => setStatsLoading(false));
  }, [selectedTaskIds, deleteMode]);

  // ── 翻页时清空选中 ──
  useEffect(() => {
    if (deleteMode) setSelectedTaskIds(new Set());
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 执行批量删除 ──
  const handleBatchDelete = async () => {
    setShowDeleteConfirm(false);
    setDeleting(true);
    try {
      const ids = Array.from(selectedTaskIds);
      const result = await batchDeleteTasks(ids);
      const msg = result.skipped > 0
        ? `已删除 ${result.success} 个任务（${result.skipped} 个执行中任务已跳过）`
        : `已删除 ${result.success} 个任务`;
      setToastMsg(msg);
      exitDeleteMode();
      await loadTasks();
    } catch {
      setToastMsg('删除失败，请稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  const loadTasks = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const [data, statsData] = await Promise.all([
        getTaskList(PAGE_SIZE, searchQuery || undefined, typeFilter || undefined, statusFilter || undefined, page),
        getTaskStats(),
      ]);
      setTasks(data.tasks);
      setTotal(data.total);
      setStats(statsData);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '未知错误';
      if (msg.includes('fetch') || msg.includes('Failed to fetch') || msg.includes('连接到')) {
        setError('无法连接到后端服务');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [searchQuery, typeFilter, statusFilter, page]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // ── 搜索：回车触发 ──
  const handleSearch = (value: string) => {
    setSearchInput(value);
    setSearchQuery(value);
    setPage(1);
  };

  // ── 筛选变更 ──
  const handleTypeChange = (value: string) => {
    setTypeFilter(value);
    setPage(1);
  };
  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    setPage(1);
  };

  const handleSelectTask = (task: TaskItem) => {
    setSelectedTask(prev => prev?.id === task.id ? null : task);
  };

  // ── 排序切换 ──
  const handleSort = (col: SortColumn) => {
    if (sortCol === col) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  // ── 统计（服务端聚合） ──
  const taskTotal = stats?.tasks.total ?? 0;
  const runningCount = stats?.tasks.running ?? 0;
  const doneCount = stats?.tasks.done ?? 0;
  const failedCount = stats?.tasks.failed ?? 0;

  // ── 分页 ──
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── 客户端排序 ──
  const sortedTasks = sortTasksForTable(tasks, sortCol, sortDir);

  // ── 当前页全选/取消全选 ──
  const allDeletableSelected = sortedTasks.length > 0
    && sortedTasks.filter(isTaskDeletable).every(t => selectedTaskIds.has(t.id));
  const someDeletableSelected = sortedTasks.filter(isTaskDeletable).some(t => selectedTaskIds.has(t.id));

  const toggleSelectAll = () => {
    if (allDeletableSelected) {
      setSelectedTaskIds(prev => {
        const next = new Set(prev);
        sortedTasks.filter(isTaskDeletable).forEach(t => next.delete(t.id));
        return next;
      });
    } else {
      setSelectedTaskIds(prev => {
        const next = new Set(prev);
        sortedTasks.filter(isTaskDeletable).forEach(t => next.add(t.id));
        return next;
      });
    }
  };

  // ── 渲染排序图标 ──
  const sortIcon = (col: SortColumn) => {
    if (sortCol !== col) return <ArrowUpDown className="w-3 h-3 text-text-tertiary/40" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 text-primary" /> : <ArrowDown className="w-3 h-3 text-primary" />;
  };

  const totalPagesValid = totalPages > 0 ? totalPages : 1;

  // ── 创建任务成功后立即打开详情抽屉，让用户看到实时日志 ──
  const openTaskDrawer = (taskId: string, type: TaskItem['type'], siteName: string, waybillCount: number) => {
    const tempTask: TaskItem = {
      id: taskId,
      type,
      site: currentSiteId,
      siteName,
      status: 'pending',
      totalCount: waybillCount,
      doneCount: 0,
      failCount: 0,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    setSelectedTask(tempTask);
  };

  // ── Phase 5-E: 创建到件浏览器 DRY-RUN 任务 ──
  const handleCreateDryRun = async () => {
    if (!currentSiteId) { setToastMsg('无法获取当前网点，请先在设置中配置网点'); return; }
    const waybills = dryRunWaybills
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (waybills.length === 0) {
      setToastMsg('请输入至少一条运单号');
      return;
    }
    setDryRunCreating(true);
    try {
      const resp = await createArrivalDryRunTask({
        siteId: currentSiteId,
        siteName: currentSiteName,
        waybills,
        options: { prevStation: '天津分拨中心', batchSize: 200 },
        dryRunMode,
      });
      setToastMsg(`到件 DRY-RUN 任务已创建：${resp.taskId.slice(0, 8)}...`);
      setShowDryRunModal(false);
      openTaskDrawer(resp.taskId, 'arrival', currentSiteName, waybills.length);
      setTimeout(() => loadTasks(), 500);
    } catch (e) {
      setToastMsg(`创建失败：${(e as Error).message}`);
    } finally {
      setDryRunCreating(false);
    }
  };

  // ── Phase 5-E: 创建派件浏览器 DRY-RUN 任务 ──
  const handleCreateDispatch = async () => {
    if (!currentSiteId) { setToastMsg('无法获取当前网点，请先在设置中配置网点'); return; }
    const waybills = dispatchWaybills
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (waybills.length === 0) {
      setToastMsg('请输入至少一条运单号');
      return;
    }
    setDispatchCreating(true);
    try {
      const resp = await createAgentDispatchTask({
        siteId: currentSiteId,
        siteName: currentSiteName,
        courierName: '肖飞',
        waybills,
        options: { prevStation: '天津分拨中心', batchSize: 200 },
        dryRunMode,
      });
      setToastMsg(`派件 DRY-RUN 任务已创建：${resp.taskId.slice(0, 8)}...`);
      setShowDispatchModal(false);
      openTaskDrawer(resp.taskId, 'dispatch', currentSiteName, waybills.length);
      setTimeout(() => loadTasks(), 500);
    } catch (e) {
      setToastMsg(`创建失败：${(e as Error).message}`);
    } finally {
      setDispatchCreating(false);
    }
  };

  // ── Phase 5-E: 创建到派一体浏览器 DRY-RUN 任务 ──
  const handleCreateIntegrated = async () => {
    if (!currentSiteId) { setToastMsg('无法获取当前网点，请先在设置中配置网点'); return; }
    const waybills = integratedWaybills
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (waybills.length === 0) {
      setToastMsg('请输入至少一条运单号');
      return;
    }
    setIntegratedCreating(true);
    try {
      const resp = await createAgentIntegratedTask({
        siteId: currentSiteId,
        siteName: currentSiteName,
        courierName: '肖飞',
        waybills,
        options: { prevStation: '天津分拨中心', batchSize: 200 },
        dryRunMode,
      });
      setToastMsg(`到派一体 DRY-RUN 任务已创建：${resp.taskId.slice(0, 8)}...`);
      setShowIntegratedModal(false);
      openTaskDrawer(resp.taskId, 'integrated', currentSiteName, waybills.length);
      setTimeout(() => loadTasks(), 500);
    } catch (e) {
      setToastMsg(`创建失败：${(e as Error).message}`);
    } finally {
      setIntegratedCreating(false);
    }
  };

  // ── Phase 5-E: 创建签收浏览器 DRY-RUN 任务 ──
  const handleCreateSign = async () => {
    if (!currentSiteId) { setToastMsg('无法获取当前网点，请先在设置中配置网点'); return; }
    const waybills = signWaybills
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    if (waybills.length === 0) {
      setToastMsg('请输入至少一条运单号');
      return;
    }
    setSignCreating(true);
    try {
      const resp = await createAgentSignTask({
        siteId: currentSiteId,
        siteName: currentSiteName,
        courierName: '肖飞',
        waybills,
        options: { prevStation: '天津分拨中心', batchSize: 200 },
        dryRunMode,
      });
      setToastMsg(`签收 DRY-RUN 任务已创建：${resp.taskId.slice(0, 8)}...`);
      setShowSignModal(false);
      openTaskDrawer(resp.taskId, 'sign', currentSiteName, waybills.length);
      setTimeout(() => loadTasks(), 500);
    } catch (e) {
      setToastMsg(`创建失败：${(e as Error).message}`);
    } finally {
      setSignCreating(false);
    }
  };

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-h1 text-text-primary">任务中心</h2>
          <p className="text-[14px] text-text-tertiary mt-0.5">运营任务控制台 · 共 {taskTotal} 条任务记录</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setShowAdminMenu(!showAdminMenu)}
              className="flex items-center gap-1.5 px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors"
            >
              <Settings className="w-3.5 h-3.5" />
              管理工具
            </button>
            {showAdminMenu && !deleteMode && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowAdminMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-surface border border-border rounded-card shadow-lg py-1 w-[140px]">
                  <button
                    onClick={enterDeleteMode}
                    className="flex items-center gap-2 w-full px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-bg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-danger" />
                    进入删除模式
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setShowDryRunModal(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            到件 DRY-RUN
          </button>
          <button
            onClick={() => setShowDispatchModal(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            派件 DRY-RUN
          </button>
          <button
            onClick={() => setShowIntegratedModal(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            到派一体 DRY-RUN
          </button>
          <button
            onClick={() => setShowSignModal(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors"
          >
            <PlayCircle className="w-3.5 h-3.5" />
            签收 DRY-RUN
          </button>
          <button
            onClick={() => loadTasks()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors disabled:opacity-50"
          >
            <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      </div>

      {/* ── 删除模式栏 ── */}
      {deleteMode && (
        <div className="flex items-center justify-between px-4 h-10 rounded-card bg-danger/8 border border-danger/25">
          <div className="flex items-center gap-3">
            <Trash2 className="w-4 h-4 text-danger" />
            <span className="text-[13px] font-medium text-danger">删除模式</span>
            <span className="text-[12px] text-text-tertiary">
              已选择 <b className="text-danger">{selectedTaskIds.size}</b> 个任务
            </span>
            {statsLoading && <Loader2 className="w-3 h-3 animate-spin text-text-tertiary" />}
          </div>
          <div className="flex items-center gap-3">
            {deleteStats && deleteStats.taskCount > 0 && (
              <div className="flex items-center gap-3 text-[11px] text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <span className="text-text-tertiary">到件扫描</span>
                  <b className="text-text-primary">{deleteStats.typeBreakdown.inbound ?? 0}</b>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-text-tertiary">派件扫描</span>
                  <b className="text-text-primary">{deleteStats.typeBreakdown.dispatch ?? 0}</b>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-text-tertiary">到派一体</span>
                  <b className="text-text-primary">{deleteStats.typeBreakdown.integrated ?? 0}</b>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-text-tertiary">签收录入</span>
                  <b className="text-text-primary">{deleteStats.typeBreakdown.signin ?? 0}</b>
                </span>
                <span className="text-text-tertiary">|</span>
                <span>任务 <b className="text-danger">{deleteStats.taskCount}</b></span>
                <span>运单 <b className="text-danger">{deleteStats.waybillCount}</b></span>
                <span>日志 <b className="text-danger">{deleteStats.logCount}</b></span>
              </div>
            )}
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={selectedTaskIds.size === 0 || deleting}
              className="flex items-center gap-1 px-3 h-7 rounded-btn bg-danger text-white text-[12px] font-medium
                hover:bg-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              删除选中
            </button>
            <button
              onClick={exitDeleteMode}
              className="px-3 h-7 rounded-btn border border-border text-[12px] text-text-secondary hover:bg-surface-light transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && deleteStats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowDeleteConfirm(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-surface border border-border rounded-card shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-danger" />
              <h3 className="text-[14px] font-semibold text-text-primary">确认删除选中的任务？</h3>
            </div>
            <div className="text-[12px] text-text-tertiary mb-1 space-y-0.5">
              <p>任务记录：<b className="text-text-primary">{deleteStats.taskCount}</b> 条</p>
              <p>运单结果：<b className="text-text-primary">{deleteStats.waybillCount}</b> 条</p>
              <p>执行日志：<b className="text-text-primary">{deleteStats.logCount}</b> 条</p>
            </div>
            <p className="text-[12px] text-danger font-medium mt-3">此操作不可恢复。</p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 h-8 rounded-btn border border-border text-[12px] text-text-secondary hover:bg-surface-light transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleBatchDelete}
                className="px-4 h-8 rounded-btn bg-danger text-white text-[12px] font-medium hover:bg-red-600 transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Task 2: 统计卡（4列压缩，单行） ═══ */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '任务总数', value: taskTotal, color: 'text-text-primary' },
          { label: '进行中', value: runningCount, color: 'text-primary' },
          { label: '已完成', value: doneCount, color: 'text-success' },
          { label: '已失败', value: failedCount, color: 'text-danger' },
        ].map(card => (
          <div key={card.label} className="bg-surface border border-border rounded-card px-4 py-2.5 shadow-panel flex items-center justify-between">
            <span className="text-[12px] text-text-tertiary font-medium">{card.label}</span>
            <span className={`text-[20px] font-semibold tracking-tight ${card.color}`}>
              {loading ? '-' : card.value}
            </span>
          </div>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-card bg-danger/10 border border-danger/30 text-danger text-[13px]">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ═══ Task 4: 搜索与筛选工具栏 ═══ */}
      <div className="flex items-center gap-3">
        {/* 搜索框 */}
        <div className="relative flex-1 max-w-[360px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(e.currentTarget.value); }}
            placeholder="搜索任务 / 员工 / 运单号"
            className="w-full h-8 pl-9 pr-8 rounded-btn border border-border bg-surface text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-primary/50 transition-colors"
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(''); setSearchQuery(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-secondary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* 类型筛选 */}
        <div className="relative">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <select
            value={typeFilter}
            onChange={e => handleTypeChange(e.target.value)}
            className="appearance-none h-8 pl-8 pr-6 rounded-btn border border-border bg-surface text-[13px] text-text-primary focus:outline-none focus:border-primary/50 cursor-pointer"
          >
            {TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-tertiary pointer-events-none" />
        </div>

        {/* 状态筛选 */}
        <div className="relative">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
          <select
            value={statusFilter}
            onChange={e => handleStatusChange(e.target.value)}
            className="appearance-none h-8 pl-8 pr-6 rounded-btn border border-border bg-surface text-[13px] text-text-primary focus:outline-none focus:border-primary/50 cursor-pointer"
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-tertiary pointer-events-none" />
        </div>

        {/* Results count */}
        {!loading && (
          <span className="text-[12px] text-text-tertiary whitespace-nowrap">
            共 {total} 条
          </span>
        )}
      </div>

      {/* ═══ Task 3: 任务列表 Table（高度跟随数据，分页紧贴底部） ═══ */}
      <div className="bg-surface border border-border rounded-card shadow-panel overflow-hidden relative">
        <div className="px-6 pt-5 relative">
          {loading && tasks.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-text-tertiary">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              <span className="text-[13px]">加载中...</span>
            </div>
          ) : sortedTasks.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-text-tertiary">
              <div className="text-center">
                <PackageOpen className="w-8 h-8 mx-auto mb-2 opacity-30" />
                {searchQuery || typeFilter || statusFilter ? (
                  <>
                    <div className="text-[13px] mb-1">未找到匹配任务</div>
                    <div className="text-[11px]">请尝试调整筛选条件</div>
                  </>
                ) : (
                  <>
                    <div className="text-[13px] mb-1">暂无任务</div>
                    <div className="text-[11px]">请在到件扫描 / 派件扫描 / 签收录入页面创建任务</div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <table className="w-full text-[14px] border-separate border-spacing-0">
              <thead>
                <tr>
                  {deleteMode && (
                    <th className="w-10 px-2 pb-3 pt-1 text-center border-b border-border">
                      <input
                        type="checkbox"
                        checked={allDeletableSelected}
                        ref={el => {
                          if (el) el.indeterminate = !allDeletableSelected && someDeletableSelected;
                        }}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 rounded border-border text-primary focus:ring-primary/30 cursor-pointer accent-primary"
                      />
                    </th>
                  )}
                  <th className="px-3 pb-3 pt-1 pl-[15px] text-[13px] font-semibold text-text-tertiary uppercase tracking-wider whitespace-nowrap text-left border-b border-border cursor-pointer hover:text-text-secondary select-none" onClick={() => handleSort('createdAt')} style={{ width: '150px' }}>
                    <span className="inline-flex items-center gap-1">创建时间 {sortIcon('createdAt')}</span>
                  </th>
                  <Th onClick={() => handleSort('site')} width="100px">网点 {sortIcon('site')}</Th>
                  <Th onClick={() => handleSort('type')} width="110px">任务 {sortIcon('type')}</Th>
                  <Th align="left" width="100px">模式</Th>
                  <Th align="left">执行对象</Th>
                  <Th onClick={() => handleSort('status')} width="110px">状态 {sortIcon('status')}</Th>
                  <Th onClick={() => handleSort('totalCount')} align="right" width="90px">运单数 {sortIcon('totalCount')}</Th>
                  <Th onClick={() => handleSort('failCount')} align="right" width="80px">异常 {sortIcon('failCount')}</Th>
                  <Th align="right" width="80px">操作</Th>
                </tr>
              </thead>
              <tbody>
                {sortedTasks.map(task => {
                  const isSelected = selectedTask?.id === task.id;
                  const isChecked = selectedTaskIds.has(task.id);
                  const deletable = isTaskDeletable(task);
                  const statusLabel = STATUS_LABEL[task.status] || task.status;
                  const statusCls = STATUS_COLOR[task.status] || 'text-text-tertiary bg-border';

                  return (
                    <tr
                      key={task.id}
                      onClick={() => {
                        if (deleteMode) return;
                        handleSelectTask(task);
                      }}
                      className={`transition-colors ${
                        deleteMode ? 'cursor-default' : 'cursor-pointer'
                      } ${
                        isChecked
                          ? 'bg-[#fef2f2]'
                          : isSelected
                            ? 'bg-[#f0f7ff]'
                            : 'hover:bg-[#fafafa]'
                      }`}
                      style={{ height: 44 }}
                    >
                      {deleteMode && (
                        <td className="px-2 text-center border-b border-border" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={!deletable}
                            onChange={e => toggleTaskSelection(task.id, e.target.checked)}
                            title={deletable ? '' : '执行中任务不可删除'}
                            className="w-4 h-4 rounded border-border text-primary focus:ring-primary/30 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                          />
                        </td>
                      )}
                      <Td isSelected={isSelected || isChecked} isFirst={!deleteMode}>
                        <span className="font-mono text-[11px] text-text-tertiary">
                          {formatDate(task.createdAt)}
                        </span>
                      </Td>
                      <Td isSelected={isSelected}>
                        <span className="text-text-secondary">{task.siteName || task.site}</span>
                      </Td>
                      <Td isSelected={isSelected}>
                        <span className="text-text-primary font-medium">
                          {typeLabelMap[task.type] || task.type}
                        </span>
                      </Td>
                      <Td isSelected={isSelected}>
                        {(() => {
                          const parsed = parseInputData(task.inputData);
                          const isDesignated = parsed.executionMode === 'designated';
                          return isDesignated
                            ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#0060FF]/10 text-[#004CCC]">指定模式</span>
                            : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#f5f5f5] text-text-tertiary">默认模式</span>;
                        })()}
                      </Td>
                      <Td isSelected={isSelected}>
                        <span className="text-text-primary text-[12px]">{formatExecutionTarget(task)}</span>
                      </Td>
                      <Td isSelected={isSelected}>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${statusCls}`}>
                          {STATUS_ICON[task.status]}
                          {statusLabel}
                        </span>
                      </Td>
                      <Td align="right" isSelected={isSelected}>
                        <span className="font-mono text-text-primary">{task.totalCount}</span>
                      </Td>
                      <Td align="right" isSelected={isSelected}>
                        <span className={`font-mono font-semibold ${task.failCount > 0 ? 'text-danger' : 'text-text-tertiary'}`}>
                          {task.failCount}
                        </span>
                      </Td>
                      <Td align="right" isSelected={isSelected || isChecked} isLast>
                        {!deleteMode && (
                          <button
                            onClick={e => { e.stopPropagation(); handleSelectTask(task); }}
                            className="text-[12px] text-primary hover:text-primary/80 font-medium transition-colors"
                          >
                            详情
                          </button>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {loading && tasks.length > 0 && (
            <div className="absolute inset-0 bg-white/60 flex items-center justify-center pointer-events-none">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 h-[58px] border-t border-border bg-surface text-[13px] text-text-secondary">
          <span className="text-text-tertiary">共 <span className="font-semibold text-text-primary">{total}</span> 条记录</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="w-10 h-10 flex items-center justify-center rounded-[10px] text-text-secondary hover:bg-[#f5f7fa] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: totalPagesValid }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPagesValid || Math.abs(p - page) <= 1)
              .map((p, i, arr) => (
                <span key={p} className="flex items-center">
                  {i > 0 && arr[i - 1] !== p - 1 && <span className="px-1 text-text-tertiary select-none">…</span>}
                  <button
                    onClick={() => setPage(p)}
                    className={`min-w-[40px] h-10 px-2 rounded-[10px] text-[13px] font-medium transition-colors ${
                      p === page
                        ? 'bg-[#1677ff] text-white shadow-sm'
                        : 'text-text-secondary hover:bg-[#f5f7fa]'
                    }`}
                  >
                    {p}
                  </button>
                </span>
              ))}
            <button
              onClick={() => setPage(p => Math.min(totalPagesValid, p + 1))}
              disabled={page >= totalPagesValid || loading}
              className="w-10 h-10 flex items-center justify-center rounded-[10px] text-text-secondary hover:bg-[#f5f7fa] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <span className="text-text-tertiary">每页 <span className="font-medium text-text-primary">{PAGE_SIZE}</span> 条</span>
        </div>
      </div>

      {/* Deleting spinner */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/20" />
          <div className="relative bg-surface border border-border rounded-card shadow-xl px-6 py-4 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-danger" />
            <span className="text-[13px] text-text-primary">正在删除任务...</span>
          </div>
        </div>
      )}

      {/* Toast */}
      {toastMsg && <Toast message={toastMsg} onDone={() => setToastMsg('')} />}

      {/* Task Detail Drawer — rendered via portal */}
      {selectedTask &&
        createPortal(
          <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedTask(null)}>
            <div
              className="absolute inset-0 bg-black/40 transition-opacity"
              style={{
                opacity: drawerOpen ? 1 : 0,
                transitionDuration: '150ms',
                transitionTimingFunction: 'ease-out',
              }}
            />
            <div
              className="relative z-10 flex h-full pt-16"
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '45%',
                minWidth: 720,
                maxWidth: 960,
                transform: drawerOpen ? 'translateX(0)' : 'translateX(48px)',
                opacity: drawerOpen ? 1 : 0,
                transition: 'transform 320ms cubic-bezier(0.22,1,0.36,1), opacity 320ms cubic-bezier(0.22,1,0.36,1)',
              }}
            >
              <div className="flex h-[calc(100vh-64px)] w-full">
                <TaskDetailDrawer
                  task={selectedTask}
                  onClose={() => setSelectedTask(null)}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ── Phase 5-E: 到件 DRY-RUN 创建弹窗 ── */}
      {showDryRunModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => !dryRunCreating && setShowDryRunModal(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 bg-surface rounded-card shadow-xl border border-border w-[480px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-[16px] font-semibold text-text-primary">创建到件扫描 DRY-RUN 任务</h3>
              <button
                onClick={() => !dryRunCreating && setShowDryRunModal(false)}
                className="w-7 h-7 flex items-center justify-center rounded-btn hover:bg-surface-light text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">运单号（每行一条）</label>
                <textarea
                  value={dryRunWaybills}
                  onChange={(e) => setDryRunWaybills(e.target.value)}
                  disabled={dryRunCreating}
                  rows={5}
                  className="w-full px-3 py-2 text-[13px] border border-border rounded-btn bg-surface-bg resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60"
                  placeholder="TEST000000001&#10;TEST000000002"
                />
                <p className="text-[12px] text-text-tertiary mt-1">网点：{currentSiteName} · 上一站：天津分拨中心 · 浏览器 DRY-RUN 模式（不点击最终提交）</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-surface-bg rounded-b-card">
              <button
                onClick={() => setShowDryRunModal(false)}
                disabled={dryRunCreating}
                className="px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateDryRun}
                disabled={dryRunCreating}
                className="flex items-center gap-1.5 px-4 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {dryRunCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                {dryRunCreating ? '创建中...' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 5-E: 派件 DRY-RUN 创建弹窗 ── */}
      {showDispatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => !dispatchCreating && setShowDispatchModal(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 bg-surface rounded-card shadow-xl border border-border w-[480px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-[16px] font-semibold text-text-primary">创建派件扫描 DRY-RUN 任务</h3>
              <button
                onClick={() => !dispatchCreating && setShowDispatchModal(false)}
                className="w-7 h-7 flex items-center justify-center rounded-btn hover:bg-surface-light text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">运单号（每行一条）</label>
                <textarea
                  value={dispatchWaybills}
                  onChange={(e) => setDispatchWaybills(e.target.value)}
                  disabled={dispatchCreating}
                  rows={5}
                  className="w-full px-3 py-2 text-[13px] border border-border rounded-btn bg-surface-bg resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60"
                  placeholder="TEST000000001&#10;TEST000000002"
                />
                <p className="text-[12px] text-text-tertiary mt-1">网点：{currentSiteName} · 派件员：肖飞 · 浏览器 DRY-RUN 模式（不点击最终提交）</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-surface-bg rounded-b-card">
              <button
                onClick={() => setShowDispatchModal(false)}
                disabled={dispatchCreating}
                className="px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateDispatch}
                disabled={dispatchCreating}
                className="flex items-center gap-1.5 px-4 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {dispatchCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                {dispatchCreating ? '创建中...' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 5-E: 到派一体 DRY-RUN 创建弹窗 ── */}
      {showIntegratedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => !integratedCreating && setShowIntegratedModal(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 bg-surface rounded-card shadow-xl border border-border w-[480px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-[16px] font-semibold text-text-primary">创建到派一体 DRY-RUN 任务</h3>
              <button
                onClick={() => !integratedCreating && setShowIntegratedModal(false)}
                className="w-7 h-7 flex items-center justify-center rounded-btn hover:bg-surface-light text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">运单号（每行一条）</label>
                <textarea
                  value={integratedWaybills}
                  onChange={(e) => setIntegratedWaybills(e.target.value)}
                  disabled={integratedCreating}
                  rows={5}
                  className="w-full px-3 py-2 text-[13px] border border-border rounded-btn bg-surface-bg resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60"
                  placeholder="TEST000000001&#10;TEST000000002"
                />
                <p className="text-[12px] text-text-tertiary mt-1">网点：{currentSiteName} · 派件员：肖飞 · 浏览器 DRY-RUN 模式（不点击最终提交）</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-surface-bg rounded-b-card">
              <button
                onClick={() => setShowIntegratedModal(false)}
                disabled={integratedCreating}
                className="px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateIntegrated}
                disabled={integratedCreating}
                className="flex items-center gap-1.5 px-4 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {integratedCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                {integratedCreating ? '创建中...' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase 5-E: 签收 DRY-RUN 创建弹窗 ── */}
      {showSignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => !signCreating && setShowSignModal(false)}>
          <div className="absolute inset-0 bg-black/40" />
          <div
            className="relative z-10 bg-surface rounded-card shadow-xl border border-border w-[480px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-[16px] font-semibold text-text-primary">创建签收录入 DRY-RUN 任务</h3>
              <button
                onClick={() => !signCreating && setShowSignModal(false)}
                className="w-7 h-7 flex items-center justify-center rounded-btn hover:bg-surface-light text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">运单号（每行一条）</label>
                <textarea
                  value={signWaybills}
                  onChange={(e) => setSignWaybills(e.target.value)}
                  disabled={signCreating}
                  rows={5}
                  className="w-full px-3 py-2 text-[13px] border border-border rounded-btn bg-surface-bg resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-60"
                  placeholder="TEST000000001&#10;TEST000000002"
                />
                <p className="text-[12px] text-text-tertiary mt-1">网点：{currentSiteName} · 派件员：肖飞 · 浏览器 DRY-RUN 模式（不点击最终提交）</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-surface-bg rounded-b-card">
              <button
                onClick={() => setShowSignModal(false)}
                disabled={signCreating}
                className="px-3 h-8 rounded-btn border border-border text-[13px] text-text-secondary hover:bg-surface-light transition-colors disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={handleCreateSign}
                disabled={signCreating}
                className="flex items-center gap-1.5 px-4 h-8 rounded-btn bg-primary text-white text-[13px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {signCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                {signCreating ? '创建中...' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Table helper components ──

function Th({ children, onClick, align, width }: { children: React.ReactNode; onClick?: () => void; align?: 'left' | 'right'; width?: string }) {
  return (
    <th
      className={`px-3 pb-3 pt-1 text-[13px] font-semibold text-text-tertiary uppercase tracking-wider whitespace-nowrap border-b border-border ${onClick ? 'cursor-pointer hover:text-text-secondary select-none' : ''} ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={onClick}
      style={width ? { width } : undefined}
    >
      <span className="inline-flex items-center gap-1">{children}</span>
    </th>
  );
}

function Td({ children, align, isSelected, isFirst, isLast }: { children: React.ReactNode; align?: 'left' | 'right'; isSelected?: boolean; isFirst?: boolean; isLast?: boolean }) {
  return (
    <td
      className={`px-3 whitespace-nowrap border-b border-border/60 ${align === 'right' ? 'text-right' : 'text-left'} ${
        isFirst ? 'border-l-[3px]' : 'border-l-0'
      } ${isFirst && isSelected ? 'border-l-primary' : isFirst ? 'border-l-transparent' : ''}`}
      style={{ verticalAlign: 'middle' }}
    >
      {children}
    </td>
  );
}
