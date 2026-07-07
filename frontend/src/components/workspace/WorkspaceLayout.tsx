import { cn } from '../../lib/utils';

interface WorkspaceLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export default function WorkspaceLayout({ children, className }: WorkspaceLayoutProps) {
  return (
    <div className={cn('space-y-6', className)}>
      {children}
    </div>
  );
}
