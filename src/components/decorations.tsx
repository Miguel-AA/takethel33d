import clsx from 'clsx';

export function PaperPlane({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 220 120"
      className={clsx('pointer-events-none select-none', className)}
      aria-hidden="true"
    >
      <path
        d="M 8 96 Q 60 30 130 56 T 210 26"
        stroke="#9cc6e8"
        strokeWidth="2.5"
        strokeDasharray="3 6"
        strokeLinecap="round"
        fill="none"
      />
      <g transform="translate(170 14) rotate(18)">
        <path
          d="M 0 18 L 40 0 L 32 22 L 16 16 Z"
          fill="#5b9bd5"
        />
        <path d="M 16 16 L 24 30 L 32 22 Z" fill="#386ba0" />
      </g>
    </svg>
  );
}

export function CloudPuff({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 80"
      className={clsx('pointer-events-none select-none', className)}
      aria-hidden="true"
    >
      <ellipse cx="40" cy="50" rx="32" ry="22" fill="#e5eef7" />
      <ellipse cx="80" cy="42" rx="40" ry="28" fill="#e5eef7" />
      <ellipse cx="120" cy="52" rx="32" ry="22" fill="#e5eef7" />
    </svg>
  );
}

export function SunBurst({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'pointer-events-none select-none rounded-full bg-accent-200/60 blur-2xl',
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function Sparkle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx('pointer-events-none select-none', className)}
      aria-hidden="true"
    >
      <path
        d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z"
        fill="#f5c518"
      />
    </svg>
  );
}
