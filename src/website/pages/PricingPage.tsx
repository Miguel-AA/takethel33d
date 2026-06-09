// Pricing — "/pricing". Placeholder commercial plans (Starter / Growth / Pro).
// Prices are intentionally placeholders ("From ___" / "Contact us") — no invented
// figures. Every plan CTA routes to /contact.
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useLandingCopy } from '../useLandingCopy';
import { CheckIcon } from '../icons';
import { PageHero } from '../components/PageHero';
import { CTASection } from '../components/CTASection';

export function PricingPage() {
  const p = useLandingCopy().pages.pricing;

  return (
    <>
      <PageHero
        id="pricing-page-title"
        kicker={p.hero.kicker}
        title={p.hero.title}
        titleEm={p.hero.titleEm}
        subtitle={p.hero.subtitle}
      />

      <section
        aria-labelledby="pricing-page-title"
        className="section-x py-12 lg:py-16"
      >
        <ul className="grid gap-6 lg:grid-cols-3">
          {p.plans.map((plan) => (
            <li
              key={plan.name}
              className={clsx(
                'card flex flex-col p-7',
                plan.featured && 'ring-2 ring-brand-500/40',
              )}
            >
              {plan.badge && <span className="premium-kicker mb-4 self-start">{plan.badge}</span>}
              <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
              <div className="mt-3 flex items-baseline gap-1">
                <span className="text-3xl font-extrabold tracking-tight text-slate-900">{plan.price}</span>
                {plan.period && <span className="text-sm text-slate-500">{plan.period}</span>}
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600">{plan.description}</p>

              <ul className="mt-5 flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <Link
                to="/contact"
                className={clsx(
                  'mt-6 px-5 py-2.5 text-sm',
                  plan.featured ? 'btn-primary' : 'btn-secondary',
                )}
              >
                {plan.cta}
              </Link>
            </li>
          ))}
        </ul>

        <p className="mt-8 text-center text-xs text-slate-500">{p.note}</p>
      </section>

      <CTASection
        title={p.cta.title}
        subtitle={p.cta.subtitle}
        primaryLabel={p.cta.primary}
        primaryTo="/contact"
        secondaryLabel={p.cta.secondary}
        secondaryTo="/how-it-works"
      />
    </>
  );
}
