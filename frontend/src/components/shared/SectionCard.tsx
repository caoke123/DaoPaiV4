import { cn } from '../../lib/utils';

interface SectionCardProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  headerRight?: React.ReactNode;
}

export default function SectionCard({ title, description, children, className, headerRight }: SectionCardProps) {
  return (
    <div className={cn('bg-surface border border-border rounded-card shadow-panel', className)}>
      {(title || headerRight) && (
        <div className="flex items-center justify-between px-5 pt-5 pb-0">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-text-primary tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-text-tertiary">{description}</p>}
          </div>
          {headerRight}
        </div>
      )}
      <div className={cn(title ? 'p-5 pt-4' : 'p-5')}>
        {children}
      </div>
    </div>
  );
}
