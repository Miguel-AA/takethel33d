// How it works — "/how-it-works". The process, simply: define the goal, attract
// opportunities, organize the leads, receive actionable prospects, follow up
// and convert.
import { useLandingCopy } from '../useLandingCopy';
import { PageHero } from '../components/PageHero';
import { CTASection } from '../components/CTASection';

export function HowItWorksPage() {
  const p = useLandingCopy().pages.how;

  return (
    <>
      <PageHero
        id="how-page-title"
        kicker={p.hero.kicker}
        title={p.hero.title}
        titleEm={p.hero.titleEm}
        subtitle={p.hero.subtitle}
      />

      <section
        aria-labelledby="how-page-title"
        className="section-x py-12 lg:py-16"
      >
        <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {p.steps.map((step) => (
            <li key={step.n} className="glass-panel flex flex-col p-6">
              <span className="grid h-12 w-12 place-items-center rounded-lg bg-brand-600 font-mono text-base font-bold text-white shadow-card">
                {step.n}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <CTASection
        title={p.cta.title}
        subtitle={p.cta.subtitle}
        primaryLabel={p.cta.primary}
        primaryTo="/contact"
        secondaryLabel={p.cta.secondary}
        secondaryTo="/pricing"
      />
    </>
  );
}
