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
        'rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 backdrop-blur-xl',
        className,
      )}
    >
      {message}
    </div>
  );
}
