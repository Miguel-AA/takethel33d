import clsx from 'clsx';

export function ErrorBanner({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={clsx(
        'rounded-lg border border-brand-400/30 bg-brand-500/10 px-4 py-3 text-sm text-brand-100 backdrop-blur-xl',
        className,
      )}
    >
      {message}
    </div>
  );
}
