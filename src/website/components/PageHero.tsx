// Interior marketing-page hero. Mirrors the home Hero's heading treatment —
// premium kicker, large two-tone title (black with a blue-gradient emphasis),
// and lead subtitle — wrapped in the same frosted glass-panel-strong container
// used by the home Hero and the app register hero, so every page opens with the
// same look. Pages may also pass per-page CTA buttons and a proof line, which
// render exactly like the home Hero's; the live mockup stays home-only.
import { Link } from 'react-router-dom';
import { ArrowRightIcon, CheckIcon } from '../icons';
import { Reveal } from './Reveal';

export function PageHero({
  id,
  kicker,
  title,
  titleEm,
  subtitle,
  primaryLabel,
  primaryTo,
  secondaryLabel,
  secondaryTo,
  proof,
}: {
  /** id applied to the <h1> so the following section can reference it via aria-labelledby */
  id: string;
  kicker: string;
  title: string;
  /** Phrase within `title` shown in the blue gradient (must be an exact substring of `title`). */
  titleEm?: string;
  subtitle?: string;
  /** Primary CTA: both label and target must be set for the button to render. */
  primaryLabel?: string;
  primaryTo?: string;
  /** Secondary CTA: both label and target must be set for the button to render. */
  secondaryLabel?: string;
  secondaryTo?: string;
  /** Short reassurance line shown under the buttons, with a check icon. */
  proof?: string;
}) {
  return (
    <section className="section-x relative isolate pb-12 pt-14 lg:pb-16 lg:pt-20">
      <Reveal className="glass-panel-strong mx-auto flex flex-col items-center px-6 py-12 text-center sm:px-12 sm:py-16">
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

        {primaryLabel && primaryTo && (
          <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Link to={primaryTo} className="btn-primary px-7 py-3 text-base">
              {primaryLabel}
              <ArrowRightIcon className="h-5 w-5" />
            </Link>
            {secondaryLabel && secondaryTo && (
              <Link to={secondaryTo} className="btn-secondary px-7 py-3 text-base">
                {secondaryLabel}
              </Link>
            )}
          </div>
        )}

        {proof && (
          <p className="mt-5 flex items-center justify-center gap-2 text-sm font-medium text-slate-600">
            <CheckIcon className="h-4 w-4 text-brand-600" />
            {proof}
          </p>
        )}
      </Reveal>
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
