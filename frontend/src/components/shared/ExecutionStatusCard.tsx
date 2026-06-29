import { cn } from '../../lib/utils';
import type { ExecutionStatus as ExecutionStatusType } from '../../lib/mock-data';

interface ExecutionStatusProps {
  status: ExecutionStatusType;
  className?: string;
}

const statusLabels = {
  idle: '待执行',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  error: '异常',
};

const statusColors = {
  idle: 'bg-surface-light text-text-tertiary',
  running: 'bg-primary-light text-primary',
  paused: 'bg-warning-light text-warning',
  completed: 'bg-success-light text-success',
  error: 'bg-danger-light text-danger',
};

export default function ExecutionStatusCard({ status, className }: ExecutionStatusProps) {
  return (
    <div className={cn('bg-surface border border-border rounded-card p-5 shadow-sm', className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[14px] font-semibold text-text-primary">执行状态</h3>
        <span className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium',
          statusColors[status.status]
        )}>
          <span className={cn(
            'w-1.5 h-1.5 rounded-full',
            status.status === 'running' ? 'bg-primary animate-pulse' :
            status.status === 'paused' ? 'bg-warning' :
            status.status === 'completed' ? 'bg-success' :
            status.status === 'error' ? 'bg-danger' : 'bg-text-tertiary'
          )} />
          {statusLabels[status.status]}
        </span>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] text-text-secondary font-medium">任务进度</span>
          <span className="text-[14px] font-mono font-semibold text-text-primary">
            {status.progress}%
          </span>
        </div>
        <div className="h-2 bg-surface-light rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-700 ease-out-expo',
              status.progress >= 100 ? 'bg-success' : 'bg-primary'
            )}
            style={{ width: `${status.progress}%` }}
          />
        </div>
        <div className="flex justify-end mt-1">
          <span className="text-[11px] font-mono text-text-tertiary">
            {status.done} / {status.total}
          </span>
        </div>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-4 gap-4">
        <div className="text-center">
          <div className="text-h2 text-success">{status.success}</div>
          <div className="text-[11px] text-text-tertiary mt-0.5">成功运单</div>
        </div>
        <div className="text-center">
          <div className="text-h2 text-danger">{status.failed}</div>
          <div className="text-[11px] text-text-tertiary mt-0.5">失败运单</div>
        </div>
        <div className="text-center">
          <div className="text-h2 text-text-secondary">{status.remaining}</div>
          <div className="text-[11px] text-text-tertiary mt-0.5">剩余运单</div>
        </div>
        <div className="text-center">
          <div className="text-h2 text-text-primary font-mono">{status.eta}</div>
          <div className="text-[11px] text-text-tertiary mt-0.5">预计完成</div>
        </div>
      </div>
    </div>
  );
}
