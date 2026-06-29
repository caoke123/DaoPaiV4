// ArrivalPage.legacy — Phase D-2C 回滚基线
//
// 本文件是 ArrivalPage 的原始实现，在 Phase D-2C 中已被 UnifiedTaskPage(arrivalConfig) 替代。
// 保留此文件作为回滚基线：如需回退，将 App.tsx 中 /arrival 路由改回此组件即可。
//
// 回滚步骤：
//   1. 在 App.tsx 中 import ArrivalPageLegacy from './pages/legacy/ArrivalPage.legacy'
//   2. 将 /arrival 路由的 element 从 <UnifiedTaskPage config={arrivalConfig} /> 改为 <ArrivalPageLegacy />
//
// 原始位置：src/pages/ArrivalPage.tsx
// 归档时间：Phase D-2C
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { MapPin, FileText, CheckCircle2, AlertCircle, Play, Info } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { WindowInfo, OperationResult, TaskLogEntry } from '../../api/client';
import { fetchStatus, submitArriveTask, getTaskProgress, getTaskLogs } from '../../api/client';
import { parseWaybillText } from '../../lib/waybillParser';
import LogViewer from '../../components/shared/LogViewer';
import ExecutionStatusCard from '../../components/shared/ExecutionStatusCard';
import type { ExecutionStatus } from '../../lib/mock-data';

interface LogEntry {
  id: string;
  timestamp: string;
  type: 'success' | 'warning' | 'error' | 'info';
  barcode: string;
  message: string;
  count?: number;
}

/**
 * 同类日志汇总：相同 type + message 的日志合并为一条，末尾标注总数。
 * info/warning 日志保持原样不合并（通常是批次流程日志，每条都有意义）。
 * error/success 日志按 message 分组，同 message 合并为一条，取第一条的时间戳。
 */
function aggregateLogs(logs: LogEntry[]): LogEntry[] {
  const keepTypes = new Set(['info', 'warning']);
  const result: LogEntry[] = [];
  const grouped = new Map<string, LogEntry & { count: number }>();

  for (const log of logs) {
    if (keepTypes.has(log.type)) {
      // info/warning 日志不合并
      result.push(log);
    } else {
      // error/success 日志按 message 分组
      const key = `${log.type}::${log.message}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { ...log, count: 1 });
      }
    }
  }

  // 将分组后的日志加入结果，放在最后
  for (const [, entry] of grouped) {
    result.push(entry);
  }

  return result;
}

function taskLogToEntry(log: TaskLogEntry): LogEntry {
  const ts = new Date(log.timestamp);
  const timeStr = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
  return {
    id: log.id,
    timestamp: timeStr,
    type: log.level as LogEntry['type'],
    barcode: log.source,
    message: log.message,
  };
}

function resultToLog(r: OperationResult, idx: number): LogEntry {
  const ts = new Date(r.timestamp);
  const timeStr = `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
  return {
    id: `result-${idx}-${r.timestamp}`,
    timestamp: timeStr,
    type: r.success ? 'success' : 'error',
    barcode: r.waybillNo,
    message: r.message,
  };
}

export default function ArrivalPageLegacy() {
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [fetchError, setFetchError] = useState('');

  const [waybillInput, setWaybillInput] = useState('');
  const [debouncedInput, setDebouncedInput] = useState('');

  const [taskId, setTaskId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'running' | 'paused' | 'idle'>('idle');
  const [hasStarted, setHasStarted] = useState(false);

  const [execution, setExecution] = useState<ExecutionStatus>({
    progress: 0, total: 0, done: 0, success: 0, failed: 0, remaining: 0,
    eta: '--', status: 'idle',
  });

  const [logs, setLogs] = useState<LogEntry[]>([]);

  const handleInputChange = useCallback((value: string) => {
    setWaybillInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedInput(value);
    }, 300);
  }, []);

  const parsed = useMemo(() => parseWaybillText(debouncedInput), [debouncedInput]);
  const waybills = parsed.valid;
  const invalidWaybills = parsed.invalid;
  const validCount = parsed.valid.length;
  const invalidCount = parsed.invalid.length;

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetchStatus();
        setWindows(data.windows || []);
        const firstAdmin = data.windows?.find(
          (w: WindowInfo) => w.role === 'admin' && w.isConnected
        );
        if (firstAdmin) currentSiteRef.current = firstAdmin.site || 'tiannanda';
        setFetchError('');
      } catch {
        setFetchError('无法连接到后端服务');
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!taskId || liveStatus !== 'running') return;

    pollRef.current = setInterval(async () => {
      try {
        const [p, taskLogs] = await Promise.all([
          getTaskProgress(taskId),
          getTaskLogs(taskId, 100),
        ]);

        const success = p.done - p.failCount;
        setExecution({
          progress: p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
          total: p.total,
          done: p.done,
          success,
          failed: p.failCount,
          remaining: p.total - p.done,
          eta: '--',
          status: p.status === 'done' ? 'completed' : p.status === 'failed' ? 'error' : 'running',
        });

        const resultLogs = p.results.map(resultToLog);
        const executionLogs = taskLogs.map(taskLogToEntry);
        const allLogs = [...executionLogs, ...resultLogs].sort((a, b) => b.id.localeCompare(a.id));
        setLogs(allLogs);

        if (p.status === 'done' || p.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          setLiveStatus('idle');
          setSubmitting(false);
        }
      } catch { /* 轮询失败静默 */ }
    }, 2000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [taskId, liveStatus]);

  const currentSiteRef = useRef('tiannanda');
  const firstAdmin = windows.find(w => w.role === 'admin' && w.isConnected);
  const selectedSite = firstAdmin?.site || currentSiteRef.current;
  const branchName = '天津分拨中心';

  const handleStart = useCallback(async () => {
    if (waybills.length === 0) return;

    setHasStarted(true);
    setSubmitting(true);
    setLiveStatus('running');
    setFetchError('');
    setLogs([]);

    try {
      const resp = await submitArriveTask(selectedSite as 'tiannanda' | 'heyuan', waybills);
      setTaskId(resp.taskId);
    } catch (e) {
      setFetchError((e as Error).message || '提交任务失败');
      setLiveStatus('idle');
      setSubmitting(false);
    }
  }, [waybills, selectedSite]);

  const handlePauseResume = useCallback(() => {
    setLiveStatus(prev => prev === 'running' ? 'paused' : 'running');
  }, []);

  const previewValid = waybills.slice(0, 20);
  const previewInvalid = invalidWaybills.slice(0, 10);

  return (
    <div className="space-y-4">
      {fetchError && (
        <div className="px-4 py-3 bg-danger-light text-danger rounded-card text-[13px] flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {fetchError}
        </div>
      )}

      <div className="mb-1">
        <h1 className="text-display tracking-tight text-text-primary">到件扫描</h1>
        <p className="mt-1 text-[14px] text-text-tertiary">
          批量扫描到件信息，自动识别并录入系统
        </p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatusOverviewCard
          icon={<MapPin className="w-4 h-4" />}
          label="上一级网点"
          value={branchName}
          accent="text-primary"
        />
        <StatusOverviewCard
          icon={<FileText className="w-4 h-4" />}
          label="已识别运单"
          value={String(parsed.totalCount)}
          accent="text-text-primary"
        />
        <StatusOverviewCard
          icon={<CheckCircle2 className="w-4 h-4" />}
          label="有效运单"
          value={String(validCount)}
          accent="text-success"
          highlight
        />
        <StatusOverviewCard
          icon={<AlertCircle className="w-4 h-4" />}
          label="异常运单"
          value={String(invalidCount)}
          accent={invalidCount > 0 ? 'text-danger' : 'text-text-tertiary'}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col">
          <h3 className="text-[14px] font-semibold text-text-primary mb-3">批量运单录入</h3>
          <textarea
            value={waybillInput}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="请输入运单号，&#10;支持Excel整列复制后直接粘贴。"
            className="w-full resize-none bg-surface-bg border border-border rounded-input p-3 text-[14px] font-mono text-text-primary placeholder:text-text-tertiary/60 focus:outline-none focus:border-primary transition-colors flex-1"
          />
          <div className="flex items-center justify-between mt-2 text-[12px] text-text-tertiary shrink-0">
            <span>支持换行、Tab、逗号，空格 等分隔</span>
            {waybillInput.trim() && (
              <button
                onClick={() => { setWaybillInput(''); setDebouncedInput(''); }}
                className="text-text-secondary hover:text-danger font-medium transition-colors"
              >
                清空
              </button>
            )}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col">
          <h3 className="text-[14px] font-semibold text-text-primary mb-3">运单预览</h3>

          {parsed.totalCount > 0 ? (
            <>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[12px] text-text-tertiary">已识别</span>
                <span className="text-[20px] font-semibold text-success">{validCount}</span>
                <span className="text-[12px] text-text-tertiary">条有效运单</span>
                {invalidCount > 0 && (
                  <>
                    <span className="text-[12px] text-text-tertiary">，</span>
                    <span className="text-[20px] font-semibold text-danger">{invalidCount}</span>
                    <span className="text-[12px] text-text-tertiary">条异常</span>
                  </>
                )}
              </div>

              <div className="bg-surface-bg rounded-input p-2 flex-1" style={{ minHeight: '160px', overflowY: 'auto' }}>
                {previewValid.length > 0 && (
                  <>
                    <div className="text-[10px] text-text-tertiary mb-1 px-1">有效</div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {previewValid.map((wb, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center px-2 py-0.5 rounded-full bg-success-light text-success border border-success/20 text-[11px] font-mono"
                        >
                          {wb}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                {previewInvalid.length > 0 && (
                  <>
                    <div className="text-[10px] text-danger mb-1 px-1">异常（格式不符）</div>
                    <div className="flex flex-wrap gap-1.5">
                      {previewInvalid.map((wb, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center px-2 py-0.5 rounded-full bg-danger-light text-danger border border-danger/20 text-[11px] font-mono"
                          title={`原始值: ${wb}`}
                        >
                          {wb}
                        </span>
                      ))}
                    </div>
                  </>
                )}
                {parsed.totalCount > 30 && (
                  <div className="text-[11px] text-text-tertiary text-center mt-2">
                    ...共 {parsed.totalCount} 条
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 py-8 text-center">
              <FileText className="w-6 h-6 text-text-tertiary/40 mx-auto mb-2" />
              <p className="text-[13px] text-text-tertiary">请录入运单号</p>
              <p className="text-[11px] text-text-tertiary/60 mt-0.5">系统将自动识别并校验运单</p>
            </div>
          )}

          <button
            onClick={handleStart}
            disabled={validCount === 0 || submitting}
            className={cn(
              'w-full h-12 rounded-full font-medium text-[15px] transition-all duration-150 flex items-center justify-center gap-2 mt-3',
              validCount === 0
                ? 'bg-primary text-white opacity-70 cursor-not-allowed'
                : submitting
                ? 'bg-success-light text-success cursor-default'
                : 'bg-primary text-white hover:bg-primary-hover active:scale-[0.98]'
            )}
          >
            <Play className="w-4 h-4" />
            {validCount === 0 ? '请先录入运单数据' : submitting ? '扫描执行中...' : '开始到件扫描'}
          </button>
        </div>
      </div>

      {/* ── Live Execution Log ── */}
      <div className="bg-surface border border-border rounded-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center px-4 py-2.5 border-b border-border-light">
          <div className="flex items-center gap-2">
            <span className={cn(
              'w-2 h-2 rounded-full',
              liveStatus === 'running' ? 'bg-success animate-pulse' :
              liveStatus === 'paused' ? 'bg-warning' : 'bg-text-tertiary'
            )} />
            <span className="text-[12px] font-medium text-text-secondary">实时执行日志</span>
            {liveStatus === 'running' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-success-light text-success">
                执行中
              </span>
            )}
            {liveStatus === 'paused' && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-warning-light text-warning">
                已暂停
              </span>
            )}
            {liveStatus === 'idle' && hasStarted && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-surface-light text-text-tertiary">
                已完成
              </span>
            )}
          </div>
          <div className="ml-auto text-[11px] text-text-tertiary font-mono">
            {logs.length} 条
          </div>
        </div>

        {/* Log body */}
        <div className="p-3 font-mono text-[13px] max-h-[300px] overflow-y-auto bg-surface-bg">
          {logs.length === 0 && liveStatus === 'idle' && !hasStarted && (
            <div className="py-10 text-center">
              <Info className="w-5 h-5 text-text-tertiary/40 mx-auto mb-2" />
              <p className="text-text-tertiary text-[13px]">点击「开始到件扫描」后显示实时日志</p>
            </div>
          )}
          {logs.length === 0 && liveStatus === 'running' && (
            <div className="py-6 text-center text-text-tertiary text-[13px]">
              等待执行日志...
            </div>
          )}
          {logs.length > 0 && (() => {
            // 同类错误汇总：相同 message 的 error 日志合并显示，末尾标注总数
            const aggregated = aggregateLogs(logs);
            return aggregated.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-3 py-[3px] px-1 rounded-sm hover:bg-surface/50 transition-colors"
              >
                <span className="text-text-tertiary text-[11px] shrink-0 w-[52px] select-none">
                  {log.timestamp}
                </span>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded shrink-0 font-medium',
                  log.type === 'info' ? 'bg-primary-light text-primary' :
                  log.type === 'warning' ? 'bg-warning-light text-warning' :
                  log.type === 'error' ? 'bg-danger-light text-danger' : 'bg-success-light text-success'
                )}>
                  {log.type === 'info' ? 'INFO' : log.type === 'warning' ? 'WARN' : log.type === 'error' ? 'ERROR' : 'OK'}
                </span>
                <span className="text-text-tertiary text-[11px] shrink-0 w-[80px] truncate" title={log.barcode}>
                  {log.barcode}
                </span>
                <span className={cn(
                  'flex-1',
                  log.type === 'error' ? 'text-danger' :
                  log.type === 'warning' ? 'text-warning' : 'text-text-secondary'
                )}>
                  {log.message}
                  {(log.count ?? 0) > 1 && (
                    <span className="ml-2 text-[11px] text-text-tertiary font-normal">
                      (共{log.count}条)
                    </span>
                  )}
                </span>
              </div>
            ));
          })()}
        </div>
      </div>

      {hasStarted && <ExecutionStatusCard status={execution} />}
    </div>
  );
}

function StatusOverviewCard({ icon, label, value, accent, highlight }: {
  icon: React.ReactNode; label: string; value: string; accent: string; highlight?: boolean;
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 bg-surface border rounded-card px-4 py-3 shadow-sm',
      highlight ? 'border-l-[3px]' : 'border-border',
      highlight ? accent.replace('text-', 'border-') + '/50' : ''
    )}>
      <div className={cn('flex-shrink-0', accent)}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-text-tertiary font-medium leading-tight">{label}</div>
        <div className={cn('text-[18px] font-semibold tracking-tight leading-tight mt-0.5', accent)}>{value}</div>
      </div>
    </div>
  );
}
