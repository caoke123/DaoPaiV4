// Phase 3-G-1: 系统管理合并页面 — 系统总览 / 组织与站点 / 用户信息
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../stores/authStore';
import { getRuntimeStatus, getTaskStats, getCurrentTenant, getTenantSites, getTenantWorkstations, getTenantUsers, type BrowserRuntimeStatus, type TenantInfo, type SiteInfo, type WorkstationInfo, type UserInfo } from '../api/client';
import { Settings, Shield, Activity, CheckCircle, XCircle, AlertTriangle, Clock, Loader2, Monitor, Globe, Users } from 'lucide-react';

// ── 共享组件 ──────────────────────────────────────────

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
    suspended: { icon: AlertTriangle, label: '已暂停', className: 'bg-amber-50 text-amber-700 border-amber-200' },
    expired: { icon: XCircle, label: '已过期', className: 'bg-red-50 text-red-700 border-red-200' },
    deleted: { icon: XCircle, label: '已删除', className: 'bg-red-50 text-red-700 border-red-200' },
    online: { icon: CheckCircle, label: '在线', className: 'bg-green-50 text-green-700 border-green-200' },
    offline: { icon: XCircle, label: '离线', className: 'bg-red-50 text-red-700 border-red-200' },
    unknown: { icon: Clock, label: '未知', className: 'bg-gray-50 text-gray-700 border-gray-200' },
    ready: { icon: CheckCircle, label: '就绪', className: 'bg-green-50 text-green-700 border-green-200' },
    login: { icon: AlertTriangle, label: '待登录', className: 'bg-amber-50 text-amber-700 border-amber-200' },
    p0: { icon: XCircle, label: 'P0异常', className: 'bg-red-50 text-red-700 border-red-200' },
    true: { icon: CheckCircle, label: '启用', className: 'bg-green-50 text-green-700 border-green-200' },
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

function DataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      {children}
    </div>
  );
}

// ── 角色/状态中文映射 ──

const ROLE_LABELS: Record<string, string> = {
  super_admin: '超级管理员',
  tenant_admin: '租户管理员',
  operator: '操作员',
};

const TABS = [
  { key: 'overview', label: '系统总览', icon: Activity },
  { key: 'organization', label: '组织与站点', icon: Globe },
  { key: 'users', label: '用户信息', icon: Users },
];

// ── 主页面 ──────────────────────────────────────────

export default function SystemManagementPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => {
    const urlTab = searchParams.get('tab');
    return urlTab && ['overview', 'organization', 'users'].includes(urlTab) ? urlTab : 'overview';
  });

  // 同步 tab 到 URL query param
  const handleTabChange = (newTab: string) => {
    setTab(newTab);
    setSearchParams({ tab: newTab }, { replace: true });
  };

  // ── 系统总览状态 ──
  const [system, setSystem] = useState<{ alive: boolean; authRequired: boolean; runtime: BrowserRuntimeStatus; runtimeError: string | null } | null>(null);
  const [taskStats, setTaskStats] = useState<{ total: number; running: number; done: number; failed: number; pending: number; cancelled: number } | null>(null);

  // ── 组织与站点状态 ──
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [workstations, setWorkstations] = useState<WorkstationInfo[]>([]);

  // ── 用户状态 ──
  const [users, setUsers] = useState<UserInfo[]>([]);

  // ── 加载状态 ──
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [statusResp, statsResp, tenantResp, sitesResp, wsResp, usersResp] = await Promise.all([
          getRuntimeStatus(),
          getTaskStats().catch(() => null),
          getCurrentTenant().catch(() => null),
          getTenantSites().catch(() => null),
          getTenantWorkstations().catch(() => null),
          getTenantUsers().catch(() => null),
        ]);

        if (cancelled) return;

        setSystem({
          alive: statusResp.alive,
          authRequired: statusResp.authRequired ?? false,
          runtime: statusResp.runtime,
          runtimeError: statusResp.runtimeError,
        });
        if (statsResp?.tasks) setTaskStats(statsResp.tasks);
        if (tenantResp) setTenant(tenantResp);
        if (sitesResp?.sites) setSites(sitesResp.sites);
        if (wsResp?.workstations) setWorkstations(wsResp.workstations);
        if (usersResp?.users) setUsers(usersResp.users);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || '加载失败');
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
        <Settings className="w-5 h-5 text-text-secondary" />
        <h2 className="text-[15px] font-semibold text-text-primary">系统管理</h2>
      </div>

      {/* Tab 切换 */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => handleTabChange(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors ${
              tab === t.key
                ? 'bg-white text-text-primary shadow-sm'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab 1: 系统总览 ── */}
      {tab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 当前账号 */}
          <Card title="当前账号" icon={Shield}>
            <div className="space-y-2.5">
              <DataRow label="用户名">
                <span className="text-[13px] font-medium text-text-primary">{user?.username || '未知'}</span>
              </DataRow>
              <DataRow label="角色">
                <StatusBadge status={user?.role || 'operator'} />
              </DataRow>
              <DataRow label="所属机构">
                <span className="text-[13px] font-medium text-text-primary">
                  {user?.tenantId === 'tenant-default' ? '默认机构' : (user?.tenantId || '未知')}
                </span>
              </DataRow>
              <DataRow label="系统编号">
                <span className="text-[11px] font-mono text-text-tertiary">{user?.tenantId || '—'}</span>
              </DataRow>
              <DataRow label="登录状态">
                <StatusBadge status="active" />
              </DataRow>
            </div>
          </Card>

          {/* 系统状态 */}
          <Card title="系统状态" icon={Settings}>
            {system && (
              <div className="space-y-2.5">
                <DataRow label="后端服务">
                  <StatusBadge status={system.alive ? 'available' : 'unavailable'} />
                </DataRow>
                <DataRow label="登录保护">
                  <span className={`text-[12px] font-medium ${system.authRequired ? 'text-green-600' : 'text-text-tertiary'}`}>
                    {system.authRequired ? '已开启' : '未开启'}
                  </span>
                </DataRow>
                <DataRow label="本地运行环境">
                  <StatusBadge status={system.runtime} />
                </DataRow>
                {system.runtimeError && (
                  <div className="text-[11px] text-amber-600 bg-amber-50 px-2 py-1 rounded border border-amber-200">
                    {system.runtimeError}
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* 任务统计 */}
          <Card title="任务统计" icon={Activity}>
            {taskStats ? (
              <div className="space-y-2.5">
                <DataRow label="任务总数">
                  <span className="text-[15px] font-semibold text-text-primary">{taskStats.total}</span>
                </DataRow>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <DataRow label="运行中">
                    <span className="text-[12px] font-medium text-blue-600">{taskStats.running}</span>
                  </DataRow>
                  <DataRow label="待处理">
                    <span className="text-[12px] font-medium text-text-secondary">{taskStats.pending}</span>
                  </DataRow>
                  <DataRow label="已完成">
                    <span className="text-[12px] font-medium text-green-600">{taskStats.done}</span>
                  </DataRow>
                  <DataRow label="已取消">
                    <span className="text-[12px] font-medium text-text-secondary">{taskStats.cancelled}</span>
                  </DataRow>
                  <div className="col-span-2 flex items-center justify-between">
                    <span className="text-[12px] text-text-tertiary">失败</span>
                    <span className="text-[12px] font-medium text-red-600">{taskStats.failed}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-text-tertiary">暂无统计数据</div>
            )}
          </Card>

          {/* 当前阶段 */}
          <Card title="当前阶段" icon={Clock}>
            <div className="text-[12px] text-text-secondary leading-relaxed space-y-2">
              <p>DaoPai V3 Cloud Platform 当前处于<strong>基础认证与管理入口</strong>阶段。</p>
              <p>本地浏览器执行能力后续将迁移到 Local Agent 本地执行端。</p>
              <p className="text-text-tertiary">本地浏览器执行端依赖暂不在本阶段删除，后续专项清理。</p>
            </div>
          </Card>
        </div>
      )}

      {/* ── Tab 2: 组织与站点 ── */}
      {tab === 'organization' && (
        <div className="space-y-5">
          {/* 当前机构 */}
          <Card title="当前机构" icon={Globe}>
            {tenant ? (
              <div className="space-y-2.5">
                <DataRow label="机构名称">
                  <span className="text-[13px] font-medium text-text-primary">{tenant.name}</span>
                </DataRow>
                <DataRow label="状态">
                  <StatusBadge status={tenant.status} />
                </DataRow>
                <DataRow label="最大工作站数">
                  <span className="text-[13px] font-medium text-text-primary">{tenant.maxWorkstations}</span>
                </DataRow>
                {tenant.expiresAt && (
                  <DataRow label="到期时间">
                    <span className="text-[12px] text-text-secondary">{new Date(tenant.expiresAt).toLocaleString('zh-CN')}</span>
                  </DataRow>
                )}
                <DataRow label="创建时间">
                  <span className="text-[12px] text-text-secondary">{new Date(tenant.createdAt).toLocaleString('zh-CN')}</span>
                </DataRow>
                <DataRow label="系统编号">
                  <span className="text-[11px] font-mono text-text-tertiary">{tenant.id}</span>
                </DataRow>
              </div>
            ) : (
              <div className="text-[12px] text-text-tertiary">暂无机构数据</div>
            )}
          </Card>

          {/* 网点列表 */}
          <Card title="网点列表" icon={Globe}>
            {sites.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border text-text-tertiary">
                      <th className="text-left py-2 pr-3 font-medium">网点名称</th>
                      <th className="text-left py-2 pr-3 font-medium">编码</th>
                      <th className="text-left py-2 pr-3 font-medium">状态</th>
                      <th className="text-left py-2 pr-3 font-medium">创建时间</th>
                      <th className="text-left py-2 font-medium">系统编号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sites.map(site => (
                      <tr key={site.id} className="border-b border-border last:border-0">
                        <td className="py-2 pr-3 text-text-primary font-medium">{site.name}</td>
                        <td className="py-2 pr-3 text-text-secondary">{site.code || '-'}</td>
                        <td className="py-2 pr-3">
                          <StatusBadge status={site.enabled ? 'active' : 'disabled'} />
                        </td>
                        <td className="py-2 pr-3 text-text-secondary">{new Date(site.createdAt).toLocaleString('zh-CN')}</td>
                        <td className="py-2 text-[11px] font-mono text-text-tertiary">{site.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[12px] text-text-tertiary">暂无网点数据</div>
            )}
          </Card>

          {/* 工作站列表 */}
          <Card title="执行电脑列表" icon={Monitor}>
            {workstations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-border text-text-tertiary">
                      <th className="text-left py-2 pr-3 font-medium">执行电脑名称</th>
                      <th className="text-left py-2 pr-3 font-medium">所属网点</th>
                      <th className="text-left py-2 pr-3 font-medium">状态</th>
                      <th className="text-left py-2 pr-3 font-medium">在线状态</th>
                      <th className="text-left py-2 pr-3 font-medium">本地运行环境</th>
                      <th className="text-left py-2 pr-3 font-medium">最后在线</th>
                      <th className="text-left py-2 font-medium">系统编号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workstations.map(ws => (
                      <tr key={ws.id} className="border-b border-border last:border-0">
                        <td className="py-2 pr-3 text-text-primary font-medium">{ws.name}</td>
                        <td className="py-2 pr-3 text-text-secondary">{ws.siteId || '-'}</td>
                        <td className="py-2 pr-3">
                          <StatusBadge status={ws.status} />
                        </td>
                        <td className="py-2 pr-3">
                          <StatusBadge status={ws.onlineStatus} />
                        </td>
                        <td className="py-2 pr-3">
                          <StatusBadge status={ws.browserStatus} />
                        </td>
                        <td className="py-2 pr-3 text-text-secondary">
                          {ws.lastHeartbeatAt ? new Date(ws.lastHeartbeatAt).toLocaleString('zh-CN') : '-'}
                        </td>
                        <td className="py-2 text-[11px] font-mono text-text-tertiary">{ws.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-[12px] text-text-tertiary">暂无执行电脑数据</div>
            )}
          </Card>
        </div>
      )}

      {/* ── Tab 3: 用户信息 ── */}
      {tab === 'users' && (
        <Card title={`用户列表 (${users.length})`} icon={Users}>
          {users.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-border text-text-tertiary">
                    <th className="text-left py-2 pr-3 font-medium">用户名</th>
                    <th className="text-left py-2 pr-3 font-medium">角色</th>
                    <th className="text-left py-2 pr-3 font-medium">状态</th>
                    <th className="text-left py-2 pr-3 font-medium">所属机构</th>
                    <th className="text-left py-2 pr-3 font-medium">创建时间</th>
                    <th className="text-left py-2 font-medium">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 text-text-primary font-medium">{u.username}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={u.role} />
                      </td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={u.status} />
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">
                        {u.tenantId === 'tenant-default' ? '默认机构' : u.tenantId}
                        <span className="text-[11px] font-mono text-text-tertiary ml-1">({u.tenantId})</span>
                      </td>
                      <td className="py-2 pr-3 text-text-secondary">{new Date(u.createdAt).toLocaleString('zh-CN')}</td>
                      <td className="py-2 text-text-secondary">{new Date(u.updatedAt).toLocaleString('zh-CN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-[12px] text-text-tertiary">暂无用户数据</div>
          )}
        </Card>
      )}
    </div>
  );
}