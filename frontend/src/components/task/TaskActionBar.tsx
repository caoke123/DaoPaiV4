// TaskActionBar — 任务操作按钮组件
// Phase D-2B: 统一开始/暂停/继续/停止/重置按钮
import { Play, Pause, Square, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TaskActionBarProps {
  /** 开始任务 */
  onStart: () => void;
  /** 暂停/继续切换（仅 pauseResume=true 时显示） */
  onPauseResume?: () => void;
  /** 停止任务 */
  onStop?: () => void;
  /** 重置任务（完成后显示） */
  onReset?: () => void;
  /** 是否可以开始（运单数 > 0） */
  canStart: boolean;
  /** 是否正在提交 */
  submitting: boolean;
  /** 实时状态 */
  liveStatus: 'running' | 'paused' | 'idle';
  /** 是否已启动过 */
  hasStarted: boolean;
  /** 开始按钮文案 */
  startLabel: string;
  /** 是否启用暂停/继续（来自 TaskPageConfig.features.pauseResume） */
  pauseResumeEnabled?: boolean;
}

/**
 * 任务操作按钮栏
 *
 * 状态机：
 *   idle → 始终显示「开始」按钮（任务完成后可直接开始新任务，与 ArrivalPage 对齐）
 *          若 hasStarted，额外显示「重置」按钮
 *   running/paused + pauseResume → 显示「暂停/继续」+「停止」
 */
export default function TaskActionBar({
  onStart,
  onPauseResume,
  onStop,
  onReset,
  canStart,
  submitting,
  liveStatus,
  hasStarted,
  startLabel,
  pauseResumeEnabled = false,
}: TaskActionBarProps) {
  // 空闲态：始终显示开始按钮（完成后也可直接开始新任务）
  if (liveStatus === 'idle') {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={onStart}
          disabled={!canStart || submitting}
          className={cn(
            'h-12 rounded-full font-medium text-[15px] transition-all duration-150 flex items-center justify-center gap-2',
            hasStarted && onReset ? 'flex-1' : 'w-full',
            !canStart
              ? 'bg-primary text-white opacity-70 cursor-not-allowed'
              : submitting
              ? 'bg-success-light text-success cursor-default'
              : 'bg-primary text-white hover:bg-primary-hover active:scale-[0.98]'
          )}
        >
          <Play className="w-4 h-4" />
          {!canStart ? '请先录入运单数据' : submitting ? '扫描执行中...' : startLabel}
        </button>
        {hasStarted && onReset && (
          <button
            onClick={onReset}
            className="flex items-center justify-center gap-2 px-5 h-12 bg-surface border border-border rounded-full font-medium text-[14px] text-text-secondary hover:bg-surface-bg transition-colors shrink-0"
          >
            <RotateCcw className="w-4 h-4" />
            重置
          </button>
        )}
      </div>
    );
  }

  // 运行/暂停态 + pauseResume：显示暂停/继续 + 停止
  if (pauseResumeEnabled && (liveStatus === 'running' || liveStatus === 'paused')) {
    return (
      <div className="flex items-center gap-3">
        {onPauseResume && (
          <button
            onClick={onPauseResume}
            className={cn(
              'flex items-center gap-2 px-5 h-11 rounded-full font-medium text-[14px] transition-colors',
              liveStatus === 'running'
                ? 'bg-warning-light text-warning hover:bg-warning-light/70'
                : 'bg-success-light text-success hover:bg-success-light/70'
            )}
          >
            {liveStatus === 'running' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {liveStatus === 'running' ? '暂停任务' : '继续任务'}
          </button>
        )}
        {onStop && (
          <button
            onClick={onStop}
            className="flex items-center gap-2 px-5 h-11 bg-danger-light text-danger rounded-full font-medium text-[14px] hover:bg-danger-light/70 transition-colors"
          >
            <Square className="w-4 h-4" />
            停止任务
          </button>
        )}
      </div>
    );
  }

  return null;
}
