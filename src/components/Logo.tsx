import clsx from 'clsx';

export function Logo({
  className,
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <div
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-brand-400/40 bg-black/70 text-[0.68rem] font-black uppercase leading-none text-white shadow-card"
        aria-hidden="true"
      >
        L33D
      </div>
      {showText && (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-base font-bold text-white sm:text-lg">
            Take the L33d
          </span>
          <span className="hidden text-[0.68rem] font-semibold uppercase tracking-wide text-brand-200 sm:block">
            Premium Leads
          </span>
        </span>
      )}
    </div>
  );
}
