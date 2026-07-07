import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { WindowStateProvider } from './components/shared/WindowStateProvider';
import { TaskExecutionProvider } from './components/shared/TaskExecutionContext';
import { RuntimeModeProvider } from './components/shared/RuntimeModeProvider';
import { setOnAuthFailure, ProtectedRoute, useAuth } from './stores/authStore';
import LoginPage from './pages/LoginPage';
import ArrivalPage from './pages/ArrivalPage';
import DispatchPage from './pages/DispatchPage';
import IntegratedPage from './pages/IntegratedPage';
import SignPage from './pages/SignPage';
import TasksPage from './pages/TasksPage';
import SettingsPage from './pages/SettingsPage';
import SystemManagementPage from './pages/SystemManagementPage';

/** 内部组件：设置 onAuthFailure 导航（需在 Router 内使用 useNavigate） */
function AuthFailureHandler() {
  const navigate = useNavigate();
  useEffect(() => {
    setOnAuthFailure(() => navigate('/login', { replace: true }));
    return () => setOnAuthFailure(null);
  }, [navigate]);
  return null;
}

/** 根路径重定向：未登录→/login，已登录→/arrival */
function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return null;
  return <Navigate to={isAuthenticated ? '/arrival' : '/login'} replace />;
}

/** 旧路由兼容：/cloud → /system?tab=overview, /organization → /system?tab=organization, /users → /system?tab=users */
function LegacyRedirect({ tab }: { tab: string }) {
  return <Navigate to={`/system?tab=${tab}`} replace />;
}

/** 业务页面布局（含 Provider 包装） */
function BusinessLayout() {
  return (
    <WindowStateProvider>
      <RuntimeModeProvider>
        <TaskExecutionProvider>
          <AppShell />
        </TaskExecutionProvider>
      </RuntimeModeProvider>
    </WindowStateProvider>
  );
}

export default function App() {
  return (
    <>
      <AuthFailureHandler />
      <Routes>
        {/* 登录页（独立布局，无 Header/Sidebar，不挂载 Provider） */}
        <Route path="/login" element={<LoginPage />} />

        {/* 受保护的业务页面 */}
        <Route element={<ProtectedRoute><BusinessLayout /></ProtectedRoute>}>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/arrival" element={<ArrivalPage />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/integrated" element={<IntegratedPage />} />
          <Route path="/sign" element={<SignPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/system" element={<SystemManagementPage />} />
          {/* 旧路由兼容 */}
          <Route path="/cloud" element={<LegacyRedirect tab="overview" />} />
          <Route path="/organization" element={<LegacyRedirect tab="organization" />} />
          <Route path="/users" element={<LegacyRedirect tab="users" />} />
        </Route>

        {/* 未匹配路由 → 根路径 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}