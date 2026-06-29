import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { WindowStateProvider } from './components/shared/WindowStateProvider';
import { TaskExecutionProvider } from './components/shared/TaskExecutionContext';
import { RuntimeModeProvider } from './components/shared/RuntimeModeProvider';
import { setOnAuthFailure } from './stores/authStore';
import LoginPage from './pages/LoginPage';
import ArrivalPage from './pages/ArrivalPage';
import DispatchPage from './pages/DispatchPage';
import IntegratedPage from './pages/IntegratedPage';
import SignPage from './pages/SignPage';
import TasksPage from './pages/TasksPage';
import SettingsPage from './pages/SettingsPage';

/** 内部组件：设置 onAuthFailure 导航（需在 Router 内使用 useNavigate） */
function AuthFailureHandler() {
  const navigate = useNavigate();
  useEffect(() => {
    setOnAuthFailure(() => navigate('/login', { replace: true }));
    return () => setOnAuthFailure(null);
  }, [navigate]);
  return null;
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
        {/* 业务页面（AppShell 布局 + Provider） */}
        <Route element={<BusinessLayout />}>
          <Route path="/" element={<Navigate to="/arrival" replace />} />
          <Route path="/arrival" element={<ArrivalPage />} />
          <Route path="/dispatch" element={<DispatchPage />} />
          <Route path="/integrated" element={<IntegratedPage />} />
          <Route path="/sign" element={<SignPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </>
  );
}
