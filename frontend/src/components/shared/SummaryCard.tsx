import { cn } from '../../lib/utils';
import StatCard from './StatCard';

interface SummaryCardProps {
  stats: Array<{
    label: string;
    value: string;
    sub?: string;
    trend?: 'up' | 'down' | 'flat';
    trendValue?: string;
  }>;
  className?: string;
}

export default function SummaryCard({ stats, className }: SummaryCardProps) {
  return (
    <div className={cn('grid grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      {stats.map((stat, i) => (
        <StatCard key={i} {...stat} />
      ))}
    </div>
  );
}
