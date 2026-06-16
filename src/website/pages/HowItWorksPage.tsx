// How it works — "/how-it-works". A full marketing page: hero, the 3-step
// process, what makes it different (3), and a closing CTA driving to /events.
import { useLandingCopy } from '../useLandingCopy';
import { PageHero } from '../components/PageHero';
import { CardSection } from '../components/CardSection';
import { CTASection } from '../components/CTASection';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

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
        primaryLabel={p.hero.ctaPrimary}
        primaryTo="/events"
        secondaryLabel={p.hero.ctaSecondary}
        secondaryTo="/pricing"
        proof={p.hero.proof}
      />

      <section aria-labelledby="how-process" className="section-x scroll-mt-24 py-12 lg:py-16">
        <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
          <SectionHeading
            id="how-process"
            kicker={p.process.kicker}
            title={p.process.title}
            subtitle={p.process.subtitle}
          />
          <Reveal as="ol" stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {p.process.steps.slice(0, 3).map((step) => (
              <li key={step.n} className="card flex flex-col p-6">
                {/* Blue outline number — light, integrated, not a heavy box. */}
                <span className="grid h-12 w-12 place-items-center rounded-full border-2 border-brand-500/40 font-mono text-base font-bold text-brand-600">
                  {step.n}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-700">{step.body}</p>
              </li>
            ))}
          </Reveal>
        </Reveal>
      </section>

      <CardSection
        id="how-different"
        kicker={p.different.kicker}
        title={p.different.title}
        subtitle={p.different.subtitle}
        items={p.different.items}
      />

      <CTASection
        title={p.cta.title}
        subtitle={p.cta.subtitle}
        primaryLabel={p.cta.primary}
        primaryTo="/events"
        secondaryLabel={p.cta.secondary}
        secondaryTo="/benefits"
      />
    </>
  );
}
