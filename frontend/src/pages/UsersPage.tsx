// Phase 3-G: 最小用户信息只读管理
import { useEffect, useState } from 'react';
import { getTenantUsers, type UserInfo } from '../api/client';
import { Users, Loader2, CheckCircle, XCircle, Shield } from 'lucide-react';

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

const ROLE_LABELS: Record<string, string> = {
  super_admin: '超级管理员',
  tenant_admin: '租户管理员',
  operator: '操作员',
};

const ROLE_STYLES: Record<string, string> = {
  super_admin: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  tenant_admin: 'bg-blue-50 text-blue-700 border-blue-200',
  operator: 'bg-gray-50 text-gray-700 border-gray-200',
};

const STATUS_LABELS: Record<string, string> = {
  active: '正常',
  disabled: '已禁用',
};

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  disabled: 'bg-red-50 text-red-700 border-red-200',
};

function Badge({ label, className, icon: Icon }: { label: string; className: string; icon: React.ElementType }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${className}`}>
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resp = await getTenantUsers();
        if (cancelled) return;
        setUsers(resp.users);
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
        <Users className="w-5 h-5 text-text-secondary" />
        <h2 className="text-[15px] font-semibold text-text-primary">用户信息</h2>
      </div>

      {/* 用户列表 */}
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
                {users.map(user => (
                  <tr key={user.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 text-text-primary font-medium">{user.username}</td>
                    <td className="py-2 pr-3">
                      <Badge
                        label={ROLE_LABELS[user.role] || user.role}
                        className={ROLE_STYLES[user.role] || 'bg-gray-50 text-gray-700 border-gray-200'}
                        icon={Shield}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Badge
                        label={STATUS_LABELS[user.status] || user.status}
                        className={STATUS_STYLES[user.status] || 'bg-gray-50 text-gray-700 border-gray-200'}
                        icon={user.status === 'active' ? CheckCircle : XCircle}
                      />
                    </td>
                    <td className="py-2 pr-3 font-mono text-text-secondary">
                        {user.tenantId === 'tenant-default' ? '默认机构' : user.tenantId}
                      </td>
                    <td className="py-2 pr-3 text-text-secondary">{new Date(user.createdAt).toLocaleString('zh-CN')}</td>
                    <td className="py-2 text-text-secondary">{new Date(user.updatedAt).toLocaleString('zh-CN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12px] text-text-tertiary">暂无用户数据</div>
        )}
      </Card>
    </div>
  );
}