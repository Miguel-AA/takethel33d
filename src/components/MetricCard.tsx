import type { ReactNode } from 'react';
import clsx from 'clsx';

export function MetricCard({
  label,
  value,
  hint,
  children,
  className,
}: {
  label: string;
  value?: ReactNode;
  hint?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('card p-4', className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      {value !== undefined && (
        <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
      )}
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
