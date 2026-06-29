import { useState } from 'react';
import { Calendar } from 'lucide-react';
import PageHeader from '../components/shared/PageHeader';
import ActionButton from '../components/shared/ActionButton';
import StatCard from '../components/shared/StatCard';
import LogViewer from '../components/shared/LogViewer';
import WorkspaceLayout from '../components/workspace/WorkspaceLayout';
import { MOCK_LOGS, MOCK_STATS } from '../lib/mock-data';

export default function LogsPage() {
  const [filter, setFilter] = useState<'today' | 'yesterday' | 'week' | 'all'>('today');

  const logStats = [
    ...MOCK_STATS,
    { label: 'Total Errors', value: '6', trend: 'down' as const, trendValue: '-40%' },
  ];

  return (
    <WorkspaceLayout>
      <PageHeader
        title="Task Logs"
        description="Execution timeline and operation history"
      />

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        {logStats.slice(0, 5).map((stat, i) => (
          <StatCard key={i} {...stat} />
        ))}
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-text-tertiary" />
        {(['today', 'yesterday', 'week', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
              filter === f
                ? 'bg-primary text-white'
                : 'bg-surface text-text-tertiary border border-border hover:border-primary/30'
            }`}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Log viewer */}
      <LogViewer
        logs={MOCK_LOGS}
        autoScroll={false}
        streaming={false}
        maxHeight="calc(100vh - 340px)"
      />
    </WorkspaceLayout>
  );
}
