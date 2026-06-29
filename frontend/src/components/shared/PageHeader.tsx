import { cn } from '../../lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export default function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between mb-6', className)}>
      <div>
        <h1 className="text-h1 tracking-tight text-text-primary">{title}</h1>
        {description && (
          <p className="mt-1 text-[14px] text-text-tertiary">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
