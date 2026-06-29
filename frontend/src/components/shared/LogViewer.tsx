import { useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '../../lib/utils';
import {
  CheckCircle, AlertTriangle, XCircle, Info,
  Filter, Play, Pause,
} from 'lucide-react';
import type { MockLogEntry } from '../../lib/mock-data';

interface LogViewerProps {
  logs: MockLogEntry[];
  autoScroll?: boolean;
  streaming?: boolean;
  maxHeight?: string;
  className?: string;
  /** Show live status indicator in header */
  liveStatus?: 'running' | 'paused' | 'idle';
  onPauseResume?: () => void;
}

const typeStyles = {
  success: { icon: CheckCircle, color: 'text-success' },
  warning: { icon: AlertTriangle, color: 'text-warning' },
  error: { icon: XCircle, color: 'text-danger' },
  info: { icon: Info, color: 'text-primary' },
};

const typeLabels = {
  success: '成功',
  warning: '警告',
  error: '失败',
  info: '信息',
};

/** Rough height per log line: 13px font * 1.7 leading + 6px vertical padding ≈ 28px */
const LINE_HEIGHT = 28;

export default function LogViewer({
  logs,
  autoScroll = true,
  streaming = false,
  maxHeight = '500px',
  className,
  liveStatus,
  onPauseResume,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'success' | 'warning' | 'error' | 'info'>('all');
  const [maxVisible, setMaxVisible] = useState(15);
  const [streamIndex, setStreamIndex] = useState(0);

  const filteredLogs = logs.filter(l => filter === 'all' || l.type === filter);

  // Calculate how many lines fit in the container
  const updateMaxVisible = useCallback(() => {
    if (containerRef.current) {
      const containerHeight = containerRef.current.clientHeight;
      const padTop = 12; // p-3
      const availableHeight = containerHeight - padTop * 2;
      const lines = Math.floor(availableHeight / LINE_HEIGHT);
      setMaxVisible(lines > 0 ? lines : 10);
    }
  }, []);

  useEffect(() => {
    updateMaxVisible();
    const observer = new ResizeObserver(updateMaxVisible);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateMaxVisible, filteredLogs.length]);

  // Streaming simulation
  useEffect(() => {
    if (!streaming || liveStatus !== 'running') return;
    const interval = setInterval(() => {
      setStreamIndex(prev => Math.min(prev + 1, filteredLogs.length));
    }, 600);
    return () => clearInterval(interval);
  }, [streaming, liveStatus, filteredLogs.length]);

  // Only show the latest N entries; when streaming, gradually reveal
  const displayCount = streaming && liveStatus === 'running' ? streamIndex : filteredLogs.length;
  const visibleLogs = filteredLogs.slice(Math.max(0, displayCount - maxVisible), displayCount);

  const statusLabel = {
    running: '执行中',
    paused: '已暂停',
    idle: '待执行',
  };

  return (
    <div className={cn('bg-surface border border-border rounded-card overflow-hidden', className)}>
      {/* Header bar */}
      <div className="flex items-center px-4 py-2.5 border-b border-border-light">
        {/* Live status indicator */}
        {liveStatus && (
          <div className="flex items-center gap-2 mr-4">
            <span className={cn(
              'w-2 h-2 rounded-full',
              liveStatus === 'running' ? 'bg-success animate-pulse' :
              liveStatus === 'paused' ? 'bg-warning' : 'bg-text-tertiary'
            )} />
            <span className="text-[12px] font-medium text-text-secondary">
              实时执行日志
            </span>
            <span className={cn(
              'text-[11px] px-2 py-0.5 rounded-full font-medium',
              liveStatus === 'running' ? 'bg-success-light text-success' :
              liveStatus === 'paused' ? 'bg-warning-light text-warning' : 'bg-surface-light text-text-tertiary'
            )}>
              {statusLabel[liveStatus]}
            </span>
          </div>
        )}

        {onPauseResume && (
          <button
            onClick={onPauseResume}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors',
              liveStatus === 'running'
                ? 'bg-warning-light text-warning hover:bg-warning-light/70'
                : 'bg-success-light text-success hover:bg-success-light/70'
            )}
          >
            {liveStatus === 'running' ? (
              <><Pause className="w-3 h-3" /> 暂停</>
            ) : (
              <><Play className="w-3 h-3" /> 继续</>
            )}
          </button>
        )}

        {/* Filter chips */}
        <div className="flex items-center gap-1.5 ml-auto">
          <Filter className="w-3 h-3 text-text-tertiary" />
          {(['all', 'success', 'warning', 'error', 'info'] as const).map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setStreamIndex(0); }}
              className={cn(
                'px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors duration-150',
                filter === f
                  ? 'bg-primary text-white'
                  : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-light'
              )}
            >
              {f === 'all' ? '全部' : typeLabels[f]}
            </button>
          ))}
          <span className="text-[11px] text-text-tertiary font-mono ml-1">
            {filteredLogs.length}
          </span>
        </div>
      </div>

      {/* Log content — no scrollbar, only latest entries */}
      <div
        ref={containerRef}
        className="overflow-hidden font-mono text-[13px] leading-[1.7]"
        style={{ maxHeight }}
      >
        <div className="p-3">
          {visibleLogs.map((log) => {
            const style = typeStyles[log.type];
            const Icon = style.icon;
            return (
              <div
                key={log.id}
                className="flex items-center gap-3 py-[3px] px-1 rounded-sm hover:bg-surface-bg/50 transition-colors"
              >
                {/* Timestamp */}
                <span className="text-text-tertiary text-[11px] shrink-0 w-[52px] select-none">
                  {log.timestamp}
                </span>

                {/* Status icon */}
                <Icon className={cn('w-3.5 h-3.5 shrink-0', style.color)} />

                {/* Barcode */}
                <span className={cn(
                  'font-medium w-[120px] shrink-0',
                  log.type === 'error' ? 'text-danger' : 'text-text-primary'
                )}>
                  {log.barcode}
                </span>

                {/* Message */}
                <span className={cn(
                  log.type === 'error' ? 'text-danger' :
                  log.type === 'warning' ? 'text-warning' :
                  log.type === 'success' ? 'text-success' : 'text-text-secondary'
                )}>
                  {log.message}
                </span>
              </div>
            );
          })}

          {visibleLogs.length === 0 && (
            <div className="py-8 text-center text-text-tertiary text-[13px]">
              {filteredLogs.length === 0 ? '暂无日志' : '收起后仅显示最新日志'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
