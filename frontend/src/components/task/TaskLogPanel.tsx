// TaskLogPanel — 实时执行日志组件
// Phase D-2B: 抽取自 ArrivalPage 的实时日志区（header + body + 同类汇总）
import { Info } from 'lucide-react';
import { cn } from '../../lib/utils';

/** UI 层日志条目（统一类型，替代 ArrivalPage.LogEntry / DispatchLogEntry / SignLogEntry） */
export interface TaskLogEntry {
  id: string;
  timestamp: string;
  type: 'success' | 'warning' | 'error' | 'info';
  barcode: string;
  message: string;
  count?: number;
}

interface TaskLogPanelProps {
  logs: TaskLogEntry[];
  /** 实时状态 */
  liveStatus: 'running' | 'paused' | 'idle';
  /** 是否已启动过（用于区分"未开始"和"已完成"） */
  hasStarted: boolean;
  /** 空闲态提示文案 */
  idleHint?: string;
  /** 最新日志置顶：倒序渲染，最新日志出现在主视觉位置 */
  newestFirst?: boolean;
}

/**
 * 同类日志汇总：相同 type + message 的日志合并为一条，末尾标注总数。
 * info/warning 日志保持原样不合并（通常是批次流程日志，每条都有意义）。
 * error/success 日志按 message 分组，同 message 合并为一条，取第一条的时间戳。
 */
function aggregateLogs(logs: TaskLogEntry[]): TaskLogEntry[] {
  const keepTypes = new Set(['info', 'warning']);
  const result: TaskLogEntry[] = [];
  const grouped = new Map<string, TaskLogEntry & { count: number }>();

  for (const log of logs) {
    if (keepTypes.has(log.type)) {
      result.push(log);
    } else {
      const key = `${log.type}::${log.message}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { ...log, count: 1 });
      }
    }
  }

  for (const [, entry] of grouped) {
    result.push(entry);
  }

  return result;
}

export default function TaskLogPanel({
  logs,
  liveStatus,
  hasStarted,
  idleHint = '点击「开始」后显示实时日志',
  newestFirst = false,
}: TaskLogPanelProps) {
  const displayLogs = newestFirst ? [...logs].reverse() : logs;
  return (
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
          {displayLogs.length} 条
        </div>
      </div>

      {/* Log body */}
      <div className="p-3 font-mono text-[13px] max-h-[300px] overflow-y-auto bg-surface-bg">
        {displayLogs.length === 0 && liveStatus === 'idle' && !hasStarted && (
          <div className="py-10 text-center">
            <Info className="w-5 h-5 text-text-tertiary/40 mx-auto mb-2" />
            <p className="text-text-tertiary text-[13px]">{idleHint}</p>
          </div>
        )}
        {displayLogs.length === 0 && liveStatus === 'running' && (
          <div className="py-6 text-center text-text-tertiary text-[13px]">
            等待执行日志...
          </div>
        )}
        {displayLogs.length > 0 && (() => {
          const aggregated = aggregateLogs(displayLogs);
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
  );
}
