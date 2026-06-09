// Subtle, controlled blue glow — floating accents behind a hero's content.
// Extracted from the home Hero so every page (marketing + app) shares the
// exact same treatment. Host element must be `relative` (and ideally
// `isolate`) so the `-z-10` layer sits behind the content but above the
// app-wide video background.
export function HeroGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-brand-500/20 blur-3xl" />
      <div className="absolute right-6 top-28 h-44 w-44 rounded-full bg-brand-400/15 blur-3xl sm:right-16" />
      <div className="absolute left-6 top-36 h-40 w-40 rounded-full bg-brand-300/15 blur-3xl sm:left-16" />
    </div>
  );
}
