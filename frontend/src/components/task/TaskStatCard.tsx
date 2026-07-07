// TaskStatCard — 统一状态卡组件
// Phase D-2B: 合并 ArrivalPage.StatusOverviewCard / DispatchPage.OverviewCard / SignPage.OverviewCard
import { cn } from '../../lib/utils';

interface TaskStatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** 文字颜色类名，如 text-primary / text-success / text-danger */
  accent?: string;
  /** 是否高亮（左侧色条） */
  highlight?: boolean;
  className?: string;
}

export default function TaskStatCard({
  icon,
  label,
  value,
  accent = 'text-text-primary',
  highlight = false,
  className,
}: TaskStatCardProps) {
  return (
    <div className={cn(
      'flex items-center gap-3 bg-surface border rounded-card px-4 py-3 shadow-sm',
      highlight ? 'border-l-[3px]' : 'border-border',
      highlight ? accent.replace('text-', 'border-') + '/50' : '',
      className,
    )}>
      <div className={cn('flex-shrink-0', accent)}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-text-tertiary font-medium leading-tight">{label}</div>
        <div className={cn('text-[18px] font-semibold tracking-tight leading-tight mt-0.5', accent)}>
          {value}
        </div>
      </div>
    </div>
  );
}
