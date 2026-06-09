import type { LandingCopy } from '../copy';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

export function Trust({ copy }: { copy: LandingCopy['trust'] }) {
  return (
    <section
      id="trust"
      aria-labelledby="trust-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      <SectionHeading
        id="trust-title"
        kicker={copy.kicker}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      {/* Metrics — PLACEHOLDER values, edit in copy.ts before production */}
      <Reveal as="dl" stagger className="glass-panel-strong mt-12 grid grid-cols-2 gap-6 p-6 sm:p-8 lg:grid-cols-4">
        {copy.metrics.map((m) => (
          <div key={m.label} className="text-center">
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

      {/* Logo placeholders */}
      <p className="mt-12 text-center text-sm font-medium uppercase tracking-wide text-slate-500">
        {copy.logosLabel}
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <li
            key={i}
            className="flex h-16 items-center justify-center rounded-lg border border-dashed border-slate-900/15 bg-white/30 text-xs font-semibold uppercase tracking-wide text-slate-400 backdrop-blur-xl"
          >
            {copy.logoPlaceholder}
          </li>
        ))}
      </ul>

      {/* Testimonials — PLACEHOLDER quotes/authors */}
      <Reveal as="ul" stagger className="mt-12 grid gap-5 md:grid-cols-2">
        {copy.testimonials.map((tst, i) => (
          <li key={i} className="card flex flex-col p-6 sm:p-7">
            <span aria-hidden="true" className="font-serif text-4xl leading-none text-brand-400">
              &ldquo;
            </span>
            <blockquote className="mt-2 text-base leading-7 text-slate-800">{tst.quote}</blockquote>
            <figcaption className="mt-5 flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid h-10 w-10 place-items-center rounded-full bg-brand-500/10 font-semibold text-brand-600"
              >
                {tst.author.slice(0, 1)}
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">{tst.author}</span>
                <span className="block text-xs text-slate-500">{tst.role}</span>
              </span>
            </figcaption>
          </li>
        ))}
      </Reveal>

      <p className="mt-8 text-center text-xs text-slate-500">{copy.disclaimer}</p>
    </section>
  );
}
