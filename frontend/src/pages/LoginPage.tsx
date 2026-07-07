// Phase 3-D: 登录页
//
// 最小登录接入：
//   - 用户名 + 密码表单
//   - 登录中 loading 状态
//   - 错误提示
//   - 登录成功跳转原页面或 /arrival（Phase 3-G-2）

import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../stores/authStore';

export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 从路由 state 获取来源路径（ProtectedRoute 写入）
  const from = (location.state as any)?.from?.pathname || '/arrival';

  // 已登录时跳转
  if (isAuthenticated) {
    navigate(from, { replace: true });
    return null;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await login(username.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError((err as Error).message || '登录失败，请检查网络连接');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="w-full max-w-[360px]">
        {/* Logo / 品牌 */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[var(--brand)] text-white text-xl font-semibold mb-4">
            B
          </div>
          <h1 className="text-xl font-semibold text-[var(--text-1)]">网点操作中心</h1>
          <p className="text-sm text-[var(--text-3)] mt-1">DaoPai V3</p>
        </div>

        {/* 登录表单 */}
        <form onSubmit={handleSubmit} className="bg-[var(--surface)] rounded-card border border-[var(--border)] p-6 shadow-panel">
          {/* 错误提示 */}
          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-[var(--err-soft)] text-[var(--err)] text-sm">
              {error}
            </div>
          )}

          {/* 用户名 */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
              用户名
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoComplete="username"
              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-1)] text-sm placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] transition-colors"
              disabled={loading}
            />
          </div>

          {/* 密码 */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-[var(--text-2)] mb-1.5">
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-1)] text-sm placeholder:text-[var(--text-3)] focus:outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] transition-colors"
              disabled={loading}
            />
          </div>

          {/* 登录按钮 */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-10 rounded-lg bg-[var(--brand)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
