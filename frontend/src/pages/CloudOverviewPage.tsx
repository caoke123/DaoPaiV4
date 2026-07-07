// Phase 3-E: 最小 Cloud 管理入口 — 云端平台状态总览
import { useEffect, useState } from 'react';
import { useAuth } from '../stores/authStore';
import { getRuntimeStatus, getTaskStats, type BrowserRuntimeStatus } from '../api/client';
import { Cloud, Server, Shield, Activity, CheckCircle, XCircle, AlertTriangle, Clock, Loader2 } from 'lucide-react';

interface SystemStatus {
  alive: boolean;
  authRequired: boolean;
  runtime: BrowserRuntimeStatus;
  runtimeError: string | null;
}

interface TaskStats {
  total: number;
  running: number;
  done: number;
  failed: number;
  pending: number;
  cancelled: number;
}

function Card({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-text-secondary" />
        <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: React.ElementType; label: string; className: string }> = {
    available: { icon: CheckCircle, label: '正常', className: 'bg-green-50 text-green-700 border-green-200' },
    unavailable: { icon: XCircle, label: '未就绪', className: 'bg-red-50 text-red-700 border-red-200' },
    degraded: { icon: AlertTriangle, label: '异常', className: 'bg-amber-50 text-amber-700 border-amber-200' },
    active: { icon: CheckCircle, label: '正常', className: 'bg-green-50 text-green-700 border-green-200' },
    disabled: { icon: XCircle, label: '已禁用', className: 'bg-red-50 text-red-700 border-red-200' },
    super_admin: { icon: Shield, label: '超级管理员', className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
    tenant_admin: { icon: Shield, label: '租户管理员', className: 'bg-blue-50 text-blue-700 border-blue-200' },
    operator: { icon: Activity, label: '操作员', className: 'bg-gray-50 text-gray-700 border-gray-200' },
  };
  const c = config[status] || { icon: Clock, label: status, className: 'bg-gray-50 text-gray-700 border-gray-200' };
  const Icon = c.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${c.className}`}>
      <Icon className="w-3 h-3" />
      {c.label}
    </span>
  );
}

export default function CloudOverviewPage() {
  const { user } = useAuth();
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [statusResp, statsResp] = await Promise.all([
          getRuntimeStatus(),
          getTaskStats().catch(() => null),
        ]);

        if (cancelled) return;

        setSystem({
          alive: statusResp.alive,
          authRequired: statusResp.authRequired ?? false,
          runtime: statusResp.runtime,
          runtimeError: statusResp.runtimeError,
        });

        if (statsResp?.tasks) {
          setTaskStats(statsResp.tasks);
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message || '加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-tertiary">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        <span className="text-[13px]">加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="bg-red-50 border border-red-200 rounded-card px-4 py-3 text-[13px] text-red-700">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-3 mb-1">
        <Cloud className="w-5 h-5 text-text-secondary" />
        <h2 className="text-[15px] font-semibold text-text-primary">云端总览</h2>
      </div>

      {/* 卡片网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* 1. 当前账号 */}
        <Card title="当前账号" icon={Shield}>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-tertiary">用户名</span>
              <span className="text-[13px] font-medium text-text-primary">{user?.username || '未知'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-tertiary">角色</span>
              <StatusBadge status={user?.role || 'operator'} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-tertiary">所属机构</span>
              <span className="text-[12px] font-mono text-text-secondary">{user?.tenantId || '未知'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-text-tertiary">登录状态</span>
              <StatusBadge status="active" />
            </div>
          </div>
        </Card>

        {/* 2. 系统状态 */}
        <Card title="系统状态" icon={Server}>
          {system && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-tertiary">后端服务</span>
                <StatusBadge status={system.alive ? 'available' : 'unavailable'} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-tertiary">登录保护</span>
                <span className={`text-[12px] font-medium ${system.authRequired ? 'text-green-600' : 'text-text-tertiary'}`}>
                  {system.authRequired ? '已开启' : '未开启'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-tertiary">本地运行环境</span>
                <StatusBadge status={system.runtime} />
              </div>
              {system.runtimeError && (
                <div className="text-[11px] text-amber-600 bg-amber-50 px-2 py-1 rounded border border-amber-200">
                  {system.runtimeError}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* 3. 任务统计 */}
        <Card title="任务统计" icon={Activity}>
          {taskStats ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-tertiary">任务总数</span>
                <span className="text-[15px] font-semibold text-text-primary">{taskStats.total}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-text-tertiary">运行中</span>
                  <span className="text-[12px] font-medium text-blue-600">{taskStats.running}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-text-tertiary">待处理</span>
                  <span className="text-[12px] font-medium text-text-secondary">{taskStats.pending}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-text-tertiary">已完成</span>
                  <span className="text-[12px] font-medium text-green-600">{taskStats.done}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-text-tertiary">已取消</span>
                  <span className="text-[12px] font-medium text-text-secondary">{taskStats.cancelled}</span>
                </div>
                <div className="flex items-center justify-between col-span-2">
                  <span className="text-[12px] text-text-tertiary">失败</span>
                  <span className="text-[12px] font-medium text-red-600">{taskStats.failed}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-text-tertiary">暂无统计数据</div>
          )}
        </Card>

        {/* 4. 当前阶段提示 */}
        <Card title="当前阶段" icon={Clock}>
          <div className="text-[12px] text-text-secondary leading-relaxed space-y-2">
            <p>DaoPai V3 Cloud Platform 当前处于<strong>基础认证与管理入口</strong>阶段。</p>
            <p>本地浏览器执行能力后续将迁移到 Local Agent 本地执行端。</p>
            <p className="text-text-tertiary">本地浏览器执行端依赖暂不在本阶段删除，后续专项清理。</p>
          </div>
        </Card>

      </div>
    </div>
  );
}