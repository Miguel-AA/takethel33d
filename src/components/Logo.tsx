import clsx from 'clsx';

export function Logo({
  className,
  showWordmark = false,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <img
        src="/logos/icon.png"
        alt="TAKE THE L33D"
        className="h-9 w-auto shrink-0 sm:h-10"
        draggable={false}
      />
      {showWordmark && (
        <img
          src="/logos/wordmark.png"
          alt="TAKE THE L33D"
          className="hidden h-[1.15rem] w-auto sm:block sm:h-6"
          draggable={false}
        />
      )}
    </div>
  );
}
