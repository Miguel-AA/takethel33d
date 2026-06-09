import { Link } from 'react-router-dom';
import clsx from 'clsx';
import type { LandingCopy } from '../copy';
import { ArrowRightIcon, CheckIcon } from '../icons';
import { HeroGlow } from '../components/HeroGlow';

// Status pill palette, applied by row index so it stays locale-independent.
const STATUS_STYLES = [
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-700',
  'border-brand-500/30 bg-brand-500/10 text-brand-700',
  'border-amber-500/30 bg-amber-500/10 text-amber-700',
];

export function Hero({ copy }: { copy: LandingCopy['hero'] }) {
  const { mockup } = copy;

  return (
    <section
      aria-labelledby="hero-title"
      className="section-x relative pb-16 pt-14 text-center lg:pb-24 lg:pt-20"
    >
      {/* Subtle, controlled blue glow — floating accents behind the content. */}
      <HeroGlow />

      {/* Centered copy */}
      <div className="mx-auto flex max-w-3xl flex-col items-center">
        <span className="premium-kicker">{copy.badge}</span>
        <h1
          id="hero-title"
          className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl"
        >
          {copy.titleStart}{' '}
          <span className="bg-gradient-to-r from-brand-700 via-brand-600 to-brand-400 bg-clip-text text-transparent">
            {copy.titleEm}
          </span>{' '}
          {copy.titleEnd}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-700">{copy.subtitle}</p>

        <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
          <Link to="/events" className="btn-primary px-7 py-3 text-base">
            {copy.ctaPrimary}
            <ArrowRightIcon className="h-5 w-5" />
          </Link>
          <Link to="/how-it-works" className="btn-secondary px-7 py-3 text-base">
            {copy.ctaSecondary}
          </Link>
        </div>

        <p className="mt-5 flex items-center justify-center gap-2 text-sm font-medium text-slate-600">
          <CheckIcon className="h-4 w-4 text-brand-600" />
          {copy.proof}
        </p>
      </div>

      {/* Lead Pipeline panel — pure presentation, app glass language, demo data. */}
      <div className="relative mx-auto mt-14 max-w-3xl">
        <div
          className="card-lg relative z-10 p-5 text-left sm:p-6"
          role="img"
          aria-label={mockup.label}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-card">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-slate-900">{mockup.label}</span>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {mockup.live}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            {mockup.metrics.map((m) => (
              <div key={m.label} className="rounded-lg border border-white/40 bg-white/40 p-3 backdrop-blur-xl">
                <div className="text-lg font-bold text-slate-900 sm:text-xl">{m.value}</div>
                <div className="mt-0.5 text-[0.7rem] leading-tight text-slate-600">{m.label}</div>
              </div>
            ))}
          </div>

          <ul className="mt-4 space-y-2">
            {mockup.rows.map((r, i) => (
              <li
                key={r.name + r.tag}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/40 bg-white/40 px-3 py-2.5 backdrop-blur-xl transition hover:border-brand-400/40 hover:bg-white/60"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500/10 text-brand-600">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <circle cx="12" cy="8" r="3.2" />
                      <path d="M5 20c0-3 3-5 7-5s7 2 7 5" strokeLinecap="round" />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{r.name}</div>
                    <div className="truncate text-xs text-slate-500">{r.tag}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="hidden text-sm font-semibold text-slate-900 sm:block">{r.value}</span>
                  <span
                    className={clsx(
                      'rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold',
                      STATUS_STYLES[i % STATUS_STYLES.length],
                    )}
                  >
                    {r.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-4 text-center text-[0.7rem] uppercase tracking-wide text-slate-500">{mockup.note}</p>
        </div>

        {/* Soft brand glow behind the panel */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-6 -z-0 rounded-[2rem] bg-brand-500/20 blur-3xl"
        />
      </div>
    </section>
  );
}
