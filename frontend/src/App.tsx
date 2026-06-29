import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { WindowStateProvider } from './components/shared/WindowStateProvider';
import { TaskExecutionProvider } from './components/shared/TaskExecutionContext';
import { RuntimeModeProvider } from './components/shared/RuntimeModeProvider';
import ArrivalPage from './pages/ArrivalPage';
import DispatchPage from './pages/DispatchPage';
import IntegratedPage from './pages/IntegratedPage';
import SignPage from './pages/SignPage';
import TasksPage from './pages/TasksPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <WindowStateProvider>
      <RuntimeModeProvider>
        <TaskExecutionProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<Navigate to="/arrival" replace />} />
              <Route path="/arrival" element={<ArrivalPage />} />
              <Route path="/dispatch" element={<DispatchPage />} />
              <Route path="/integrated" element={<IntegratedPage />} />
              <Route path="/sign" element={<SignPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </TaskExecutionProvider>
      </RuntimeModeProvider>
    </WindowStateProvider>
  );
}
