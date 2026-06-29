import { cn } from '../../lib/utils';

interface ActionButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'pill';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  className?: string;
}

const variants = {
  primary: 'bg-primary text-text-inverted hover:bg-primary-hover active:scale-[0.98]',
  secondary: 'bg-surface text-text-primary border border-border hover:bg-surface-bg',
  ghost: 'text-text-secondary hover:bg-surface-light hover:text-text-primary',
  danger: 'bg-danger text-text-inverted hover:bg-danger/90 active:scale-[0.98]',
  pill: 'bg-primary text-text-inverted hover:bg-primary-hover rounded-full active:scale-[0.98]',
};

const sizes = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-5 text-[14px]',
  lg: 'h-12 px-8 text-[14px]',
};

const radiusMap = {
  primary: 'rounded-btn',
  secondary: 'rounded-btn',
  ghost: 'rounded-btn',
  danger: 'rounded-btn',
  pill: 'rounded-full',
};

export default function ActionButton({
  children,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  className,
}: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 font-medium transition-all duration-150 focus-ring',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        radiusMap[variant],
        className
      )}
    >
      {loading ? (
        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      ) : icon ? (
        <span className="w-4 h-4">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}
