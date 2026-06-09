// Scroll-reveal wrapper. Fades + slides its content in the first time it scrolls
// into view (via IntersectionObserver), then disconnects. Two modes:
//   - default: animates the wrapper element itself.
//   - stagger: animates each DIRECT child in sequence (use on a grid/list so its
//     cards cascade in). Pair with `as="ul"` etc. to keep the element semantics.
// Honors prefers-reduced-motion (handled in CSS). On browsers without
// IntersectionObserver it renders fully visible immediately.
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import clsx from 'clsx';

export function Reveal({
  children,
  className,
  as,
  stagger = false,
  delay = 0,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** Element/tag to render (default 'div'); use 'ul'/'ol'/'section' to preserve semantics. */
  as?: ElementType;
  /** Cascade the direct children in instead of the wrapper as a whole. */
  stagger?: boolean;
  /** Extra delay (ms) before this element animates — ignored in stagger mode. */
  delay?: number;
  [key: string]: unknown;
}) {
  const Tag = as ?? 'div';
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          obs.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -8% 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={clsx(
        stagger ? ['reveal-stagger', shown && 'is-in'] : ['reveal', shown && 'reveal-in'],
        className,
      )}
      style={!stagger && delay ? { transitionDelay: `${delay}ms` } : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}
