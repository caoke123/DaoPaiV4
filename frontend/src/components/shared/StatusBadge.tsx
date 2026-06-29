import { cn } from '../../lib/utils';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

interface StatusBadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-surface-light text-text-secondary',
  success: 'bg-success-light text-success',
  warning: 'bg-warning-light text-warning',
  danger: 'bg-danger-light text-danger',
  info: 'bg-primary-light text-primary',
};

export default function StatusBadge({ children, variant = 'default', className }: StatusBadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-[6px] text-[11px] font-medium',
      variantStyles[variant],
      className
    )}>
      {children}
    </span>
  );
}
