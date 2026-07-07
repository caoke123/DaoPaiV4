import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { cn } from '../../lib/utils';

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: 'up' | 'down' | 'flat';
  trendValue?: string;
  className?: string;
}

export default function StatCard({ label, value, sub, trend, trendValue, className }: StatCardProps) {
  const trendIcon = {
    up: <ArrowUpRight className="w-3.5 h-3.5 text-success" />,
    down: <ArrowDownRight className="w-3.5 h-3.5 text-primary" />,
    flat: <Minus className="w-3.5 h-3.5 text-text-tertiary" />,
  };

  const trendColor = {
    up: 'text-success',
    down: 'text-primary',
    flat: 'text-text-tertiary',
  };

  return (
    <div className={cn(
      'bg-surface border border-border rounded-card p-5 shadow-sm',
      className
    )}>
      <div className="text-[12px] text-text-tertiary font-medium tracking-tight">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-h1 text-text-primary tracking-tight">{value}</span>
        {trend && (
          <span className={cn('flex items-center gap-0.5 text-[12px] font-medium', trendColor[trend])}>
            {trendIcon[trend]}
            {trendValue}
          </span>
        )}
      </div>
      {sub && (
        <div className="mt-1 text-[12px] text-text-tertiary">{sub}</div>
      )}
    </div>
  );
}
