// Industries — "/industries". Shows the service applies to many kinds of
// business. Generic copy only — no real client names.
import { useLandingCopy } from '../useLandingCopy';
import { Icon } from '../icons';
import { PageHero } from '../components/PageHero';
import { CTASection } from '../components/CTASection';

export function IndustriesPage() {
  const p = useLandingCopy().pages.industries;

  return (
    <>
      <PageHero
        id="industries-page-title"
        kicker={p.hero.kicker}
        title={p.hero.title}
        subtitle={p.hero.subtitle}
      />

      <section
        aria-labelledby="industries-page-title"
        className="section-x py-12 lg:py-16"
      >
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {p.items.map((item) => (
            <li key={item.title} className="card p-6">
              <span className="grid h-12 w-12 place-items-center rounded-lg border border-brand-400/30 bg-brand-500/10 text-brand-600">
                <Icon name={item.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">{item.body}</p>
            </li>
          ))}
        </ul>
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
