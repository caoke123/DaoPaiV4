import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PackageOpen, Truck, ClipboardCheck, LayoutList, Settings, Combine,
  ChevronLeft, ChevronRight, MonitorCog,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { NAV_ITEMS } from '../../lib/mock-data';
import { useAuth } from '../../stores/authStore';

const iconMap: Record<string, React.ElementType> = {
  PackageOpen, Truck, ClipboardCheck, LayoutList, Settings, Combine, MonitorCog,
};

interface Props {
  onCollapsedChange?: (collapsed: boolean) => void;
}

export default function Sidebar({ onCollapsedChange }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Phase 3-G-2: 按角色过滤导航项
  const filteredItems = NAV_ITEMS.filter(item => {
    if (!item.roles || item.roles.length === 0) return true;
    return user && item.roles.includes(user.role);
  });

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 64 : 200 }}
      transition={{ duration: 0.2, ease: [0.19, 1, 0.22, 1] }}
      className="bg-surface border-r border-border flex flex-col overflow-hidden shrink-0"
    >
      {/* Navigation items */}
      <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
        {filteredItems.map(item => {
          if (item.type === 'section') {
            return (
              <div key={item.key} className="pt-3 pb-1 first:pt-0">
                <AnimatePresence mode="wait">
                  {!collapsed && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-3"
                    >
                      {item.label}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          }

          if (item.type === 'separator') {
            return (
              <div key={item.key} className="py-1">
                <div className="h-px bg-border mx-2" />
              </div>
            );
          }

          const Icon = item.icon ? iconMap[item.icon] : null;
          const isActive = item.path ? location.pathname === item.path : false;
          return (
            <button
              key={item.key}
              onClick={() => item.path && navigate(item.path)}
              className={cn(
                'w-full flex items-center rounded-btn transition-all duration-150',
                collapsed ? 'justify-center px-0 h-10' : 'px-3 h-10 gap-3',
                isActive
                  ? 'bg-primary-light text-primary font-medium'
                  : 'text-text-secondary hover:bg-surface-light hover:text-text-primary'
              )}
              title={collapsed ? item.label : undefined}
            >
              {Icon && <Icon className="w-5 h-5 shrink-0" />}
              <AnimatePresence mode="wait">
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    className="text-[13px] text-left whitespace-nowrap overflow-hidden"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className={cn(
        'border-t border-border px-3 py-2',
        collapsed && 'px-2'
      )}>
        <button
          onClick={() => { const next = !collapsed; setCollapsed(next); onCollapsedChange?.(next); }}
          className="w-full flex items-center justify-center h-8 rounded-btn hover:bg-surface-light text-text-tertiary transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </motion.aside>
  );
}
