import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import StatusBar from './StatusBar';

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="h-screen flex flex-col bg-surface-bg overflow-hidden">
      <Header sidebarCollapsed={sidebarCollapsed} />
      <div className="flex flex-1 min-h-0">
        <Sidebar onCollapsedChange={setSidebarCollapsed} />
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
      <StatusBar />
    </div>
  );
}
