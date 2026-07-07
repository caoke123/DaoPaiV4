// Phase 3-F: 最小租户/站点信息只读管理
import { useEffect, useState } from 'react';
import { getCurrentTenant, getTenantSites, getTenantWorkstations, type TenantInfo, type SiteInfo, type WorkstationInfo } from '../api/client';
import { Building2, Monitor, Globe, Loader2, CheckCircle, XCircle, AlertTriangle, Clock } from 'lucide-react';

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

export default function OrganizationPage() {
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [workstations, setWorkstations] = useState<WorkstationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [tenantResp, sitesResp, wsResp] = await Promise.all([
          getCurrentTenant(),
          getTenantSites(),
          getTenantWorkstations(),
        ]);

        if (cancelled) return;
        setTenant(tenantResp);
        setSites(sitesResp.sites);
        setWorkstations(wsResp.workstations);
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
        <Building2 className="w-5 h-5 text-text-secondary" />
        <h2 className="text-[15px] font-semibold text-text-primary">组织信息</h2>
      </div>

      {/* 1. 当前租户 */}
      <Card title="当前租户" icon={Globe}>
        {tenant ? (
          <div className="space-y-2.5">
            <DataRow label="租户ID">
              <span className="text-[12px] font-mono text-text-secondary">{tenant.id}</span>
            </DataRow>
            <DataRow label="租户名称">
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
          </div>
        ) : (
          <div className="text-[12px] text-text-tertiary">暂无租户数据</div>
        )}
      </Card>

      {/* 2. 站点列表 */}
      <Card title="站点列表" icon={Globe}>
        {sites.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border text-text-tertiary">
                  <th className="text-left py-2 pr-3 font-medium">站点ID</th>
                  <th className="text-left py-2 pr-3 font-medium">站点名称</th>
                  <th className="text-left py-2 pr-3 font-medium">编码</th>
                  <th className="text-left py-2 pr-3 font-medium">状态</th>
                  <th className="text-left py-2 font-medium">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {sites.map(site => (
                  <tr key={site.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-text-secondary">{site.id}</td>
                    <td className="py-2 pr-3 text-text-primary">{site.name}</td>
                    <td className="py-2 pr-3 text-text-secondary">{site.code || '-'}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={site.enabled ? 'active' : 'disabled'} />
                    </td>
                    <td className="py-2 text-text-secondary">{new Date(site.createdAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12px] text-text-tertiary">暂无站点数据</div>
        )}
      </Card>

      {/* 3. 工作站列表 */}
      <Card title="工作站列表" icon={Monitor}>
        {workstations.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border text-text-tertiary">
                  <th className="text-left py-2 pr-3 font-medium">工作站ID</th>
                  <th className="text-left py-2 pr-3 font-medium">名称</th>
                  <th className="text-left py-2 pr-3 font-medium">站点ID</th>
                  <th className="text-left py-2 pr-3 font-medium">状态</th>
                  <th className="text-left py-2 pr-3 font-medium">在线状态</th>
                  <th className="text-left py-2 pr-3 font-medium">浏览器状态</th>
                  <th className="text-left py-2 font-medium">最后心跳</th>
                </tr>
              </thead>
              <tbody>
                {workstations.map(ws => (
                  <tr key={ws.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-text-secondary">{ws.id}</td>
                    <td className="py-2 pr-3 text-text-primary">{ws.name}</td>
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
                    <td className="py-2 text-text-secondary">
                      {ws.lastHeartbeatAt ? new Date(ws.lastHeartbeatAt).toLocaleString('zh-CN') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12px] text-text-tertiary">暂无工作站数据</div>
        )}
      </Card>
    </div>
  );
}