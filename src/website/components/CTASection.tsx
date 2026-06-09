// Reusable closing CTA band, styled with the app's glass language. The primary
// action drives B2B conversion (usually /contact); the optional secondary action
// points to another marketing page or the app at /events.
import { Link } from 'react-router-dom';
import { ArrowRightIcon } from '../icons';

export function CTASection({
  title,
  subtitle,
  primaryLabel,
  primaryTo,
  secondaryLabel,
  secondaryTo,
}: {
  title: string;
  subtitle: string;
  primaryLabel: string;
  primaryTo: string;
  secondaryLabel?: string;
  secondaryTo?: string;
}) {
  return (
    <section aria-labelledby="cta-band-title" className="section-x py-16 lg:py-24">
      <div className="glass-panel-strong relative overflow-hidden px-6 py-14 text-center sm:px-12 sm:py-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-16 -top-16 h-48 w-48 rounded-full bg-brand-500/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-20 -right-10 h-56 w-56 rounded-full bg-silver-400/30 blur-3xl"
        />
        <div className="relative">
          <h2
            id="cta-band-title"
            className="mx-auto max-w-2xl text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl"
          >
            {title}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg leading-8 text-slate-700">{subtitle}</p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
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
        </div>
      </div>
    </section>
  );
}
