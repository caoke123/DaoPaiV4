// WorkerSelector — 员工选择组件
// Phase D-2D: Dispatch 页面专用，支持启用/禁用员工
import { Users, UserCheck, UserX } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { WindowInfo } from '../../api/client';

interface WorkerSelectorProps {
  /** 所有窗口状态（来自 fetchStatus） */
  windows: WindowInfo[];
  /** 已选中的员工姓名列表 */
  selectedWorkers: string[];
  /** 选择变化回调 */
  onChange: (staffNames: string[]) => void;
}

/**
 * 员工选择器
 *
 * 展示已连接的 staff 窗口，支持勾选/取消勾选。
 * 仅显示 role === 'staff' && isConnected && staffName 非空的窗口。
 */
export default function WorkerSelector({
  windows,
  selectedWorkers,
  onChange,
}: WorkerSelectorProps) {
  // 筛选可用的派件员窗口
  const availableWorkers = windows.filter(
    (w) => w.role === 'staff' && w.isConnected && w.staffName,
  );

  const toggleWorker = (staffName: string) => {
    if (selectedWorkers.includes(staffName)) {
      onChange(selectedWorkers.filter((n) => n !== staffName));
    } else {
      onChange([...selectedWorkers, staffName]);
    }
  };

  const selectAll = () => {
    onChange(availableWorkers.map((w) => w.staffName!));
  };

  const clearAll = () => {
    onChange([]);
  };

  return (
    <div className="bg-surface border border-border rounded-card p-4 shadow-sm flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          <h3 className="text-[14px] font-semibold text-text-primary">派件员选择</h3>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <button
            onClick={selectAll}
            className="text-primary hover:text-primary-hover font-medium transition-colors"
          >
            全选
          </button>
          <span className="text-text-tertiary">|</span>
          <button
            onClick={clearAll}
            className="text-text-tertiary hover:text-danger font-medium transition-colors"
          >
            清空
          </button>
        </div>
      </div>

      {availableWorkers.length === 0 ? (
        <div className="flex-1 py-8 text-center">
          <UserX className="w-6 h-6 text-text-tertiary/40 mx-auto mb-2" />
          <p className="text-[13px] text-text-tertiary">暂无可用派件员</p>
          <p className="text-[11px] text-text-tertiary/60 mt-0.5">
            请先在设置页连接员工窗口
          </p>
        </div>
      ) : (
        <div className="space-y-2 flex-1" style={{ maxHeight: '220px', overflowY: 'auto' }}>
          {availableWorkers.map((w) => {
            const isSelected = selectedWorkers.includes(w.staffName!);
            return (
              <button
                key={w.id}
                onClick={() => toggleWorker(w.staffName!)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 rounded-input border transition-colors text-left',
                  isSelected
                    ? 'border-primary/40 bg-primary-light/20'
                    : 'border-border bg-surface-bg hover:bg-surface-light',
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center font-semibold text-[13px]',
                      isSelected
                        ? 'bg-primary text-white'
                        : 'bg-surface-light text-text-tertiary',
                    )}
                  >
                    {w.staffName![0]}
                  </div>
                  <div>
                    <div className="text-[13px] font-medium text-text-primary">
                      {w.staffName}
                    </div>
                    <div className="text-[11px] text-text-tertiary font-mono">
                      {w.id}
                    </div>
                  </div>
                </div>
                <div className={cn('flex items-center gap-1.5 text-[11px]', isSelected ? 'text-primary' : 'text-text-tertiary')}>
                  <UserCheck className={cn('w-3.5 h-3.5', isSelected ? 'opacity-100' : 'opacity-0')} />
                  {isSelected ? '已选' : '未选'}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {availableWorkers.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border-light text-[11px] text-text-tertiary">
          已选 {selectedWorkers.length} / {availableWorkers.length} 人
        </div>
      )}
    </div>
  );
}
