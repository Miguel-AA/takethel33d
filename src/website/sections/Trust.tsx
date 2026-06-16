import type { LandingCopy } from '../copy';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

// "L33D Stats" — social proof through numbers (no client logos), with an honest
// bridge into a future Google Reviews integration. No fake reviews are shown.
export function Trust({ copy }: { copy: LandingCopy['stats'] }) {
  return (
    <section
      id="stats"
      aria-labelledby="stats-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <SectionHeading
          id="stats-title"
          kicker={copy.kicker}
          title={copy.title}
          subtitle={copy.subtitle}
        />

        {/* Metrics — PLACEHOLDER values, edit in copy.ts before production */}
        <Reveal as="dl" stagger className="mt-12 grid grid-cols-2 gap-6 lg:grid-cols-4">
          {copy.metrics.map((m) => (
            <div key={m.label} className="card p-6 text-center">
              <dt className="sr-only">{m.label}</dt>
              <dd>
                <span className="block text-3xl font-extrabold tracking-tight text-brand-600 sm:text-4xl">
                  {m.value}
                </span>
                <span className="mt-1 block text-sm text-slate-600">{m.label}</span>
              </dd>
            </div>
          ))}
        </Reveal>

        {/* Visual bridge into the (future) Google Reviews area. Honest copy:
            no reviews are fabricated; this is a clearly-labeled placeholder. */}
        <Reveal className="mt-12">
          <div className="mx-auto flex max-w-xl items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-brand-400/50" />
            <GoogleGlyph className="h-6 w-6" />
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-brand-400/50" />
          </div>
          <div className="card mx-auto mt-6 max-w-xl p-7 text-center">
            <div className="flex items-center justify-center gap-1 text-amber-400" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <StarGlyph key={i} className="h-5 w-5" />
              ))}
            </div>
            <h3 className="mt-4 text-lg font-semibold text-slate-900">{copy.reviews.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{copy.reviews.subtitle}</p>
            <p className="mt-1 text-xs text-slate-500">{copy.reviews.note}</p>
            <a
              href="#"
              className="btn-secondary mt-5 inline-flex px-5 py-2.5 text-sm"
              aria-disabled="true"
            >
              <GoogleGlyph className="h-4 w-4" />
              {copy.reviews.cta}
            </a>
          </div>
        </Reveal>

        <p className="mt-8 text-center text-xs text-slate-500">{copy.disclaimer}</p>
      </Reveal>
    </section>
  );
}

function StarGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.9 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9 2.9-6z" />
    </svg>
  );
}

function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.2c0-.6-.1-1.2-.2-1.8H12v3.4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.1z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.7-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
      <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9l3.3-2.6z" />
      <path fill="#EA4335" d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6.1 12 6.1z" />
    </svg>
  );
}
