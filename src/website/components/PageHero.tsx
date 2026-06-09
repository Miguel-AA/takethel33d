// Interior marketing-page hero. Mirrors the home Hero's heading treatment —
// premium kicker, large two-tone title (black with a blue-gradient emphasis),
// and lead subtitle — wrapped in the same frosted glass-panel-strong container
// used by the home Hero and the app register hero, so every page opens with the
// same look. The home-only content blocks (CTA buttons, the live mockup)
// intentionally stay on the home Hero.

export function PageHero({
  id,
  kicker,
  title,
  titleEm,
  subtitle,
}: {
  /** id applied to the <h1> so the following section can reference it via aria-labelledby */
  id: string;
  kicker: string;
  title: string;
  /** Phrase within `title` shown in the blue gradient (must be an exact substring of `title`). */
  titleEm?: string;
  subtitle?: string;
}) {
  return (
    <section className="section-x relative isolate pb-12 pt-14 lg:pb-16 lg:pt-20">
      <div className="glass-panel-strong mx-auto flex max-w-4xl flex-col items-center px-6 py-12 text-center sm:px-12 sm:py-16">
        <span className="premium-kicker">{kicker}</span>
        <h1
          id={id}
          className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl"
        >
          {renderEmphasis(title, titleEm)}
        </h1>
        {subtitle && (
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-700">{subtitle}</p>
        )}
      </div>
    </section>
  );
}

// Renders `title` with `em` highlighted in the brand blue gradient (same treatment
// as the home hero), leaving the rest in the heading's black. Falls back to the
// plain black title when `em` is absent or not found within `title`.
function renderEmphasis(title: string, em?: string) {
  if (!em) return title;
  const i = title.indexOf(em);
  if (i === -1) return title;
  return (
    <>
      {title.slice(0, i)}
      <span className="bg-gradient-to-r from-brand-700 via-brand-600 to-brand-400 bg-clip-text text-transparent">
        {em}
      </span>
      {title.slice(i + em.length)}
    </>
  );
}
