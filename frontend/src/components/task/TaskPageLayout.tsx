// TaskPageLayout — 统一任务页面布局
// Phase D-2B: 统一标题/描述/状态卡/主内容/操作/日志/结果区
import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import TaskStatCard from './TaskStatCard';

export interface TaskStatCardConfig {
  icon: ReactNode;
  label: string;
  value: string;
  accent?: string;
  highlight?: boolean;
}

interface TaskPageLayoutProps {
  title: string;
  description: string;
  statCards: TaskStatCardConfig[];
  /** 顶部错误提示（如后端不可达） */
  fetchError?: string;
  /** 主内容区（WaybillInput / WorkerSelector 等） */
  mainContent: ReactNode;
  /** 操作按钮区（TaskActionBar） */
  actionBar?: ReactNode;
  /** 日志区（TaskLogPanel） */
  logPanel: ReactNode;
  /** 结果区（ExecutionStatusCard，任务启动后显示） */
  resultPanel?: ReactNode;
}

export default function TaskPageLayout({
  title,
  description,
  statCards,
  fetchError,
  mainContent,
  actionBar,
  logPanel,
  resultPanel,
}: TaskPageLayoutProps) {
  return (
    <div className="space-y-4">
      {fetchError && (
        <div className="px-4 py-3 bg-danger-light text-danger rounded-card text-[13px] flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {fetchError}
        </div>
      )}

      {/* 标题区 */}
      <div className="mb-1">
        <h1 className="text-display tracking-tight text-text-primary">{title}</h1>
        <p className="mt-1 text-[14px] text-text-tertiary">{description}</p>
      </div>

      {/* 状态卡区 */}
      <div className="grid grid-cols-4 gap-3">
        {statCards.map((card, i) => (
          <TaskStatCard
            key={i}
            icon={card.icon}
            label={card.label}
            value={card.value}
            accent={card.accent}
            highlight={card.highlight}
          />
        ))}
      </div>

      {/* 主内容区 */}
      {mainContent}

      {/* 操作按钮区 */}
      {actionBar}

      {/* 日志区 */}
      {logPanel}

      {/* 结果区 */}
      {resultPanel}
    </div>
  );
}
