// Shared, centered section heading: kicker chip + title + optional subtitle.
// Reuses the app's `.premium-kicker` and `accent-underline` visual tokens.

export function SectionHeading({
  id,
  kicker,
  title,
  subtitle,
  emphasis,
}: {
  /** id applied to the <h2> so a section can reference it via aria-labelledby */
  id: string;
  kicker: string;
  title: string;
  subtitle?: string;
  /** optional trailing word/phrase rendered with the blue accent underline */
  emphasis?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <span className="premium-kicker">{kicker}</span>
      <h2
        id={id}
        className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl"
      >
        {title}
        {emphasis && (
          <>
            {' '}
            <span className="accent-underline text-brand-600">{emphasis}</span>
          </>
        )}
      </h2>
      {subtitle && <p className="mt-4 text-lg leading-8 text-slate-700">{subtitle}</p>}
    </div>
  );
}
