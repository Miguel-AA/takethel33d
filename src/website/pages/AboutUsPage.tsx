// About Us — "/about-us". Company intro, About our CEO (reuses the exact CEO
// copy from the shared `whoWeAre` block), the team section, our values (3), and
// a closing CTA to /events.
import { useLandingCopy } from '../useLandingCopy';
import { PageHero } from '../components/PageHero';
import { CardSection } from '../components/CardSection';
import { CTASection } from '../components/CTASection';
import { Reveal } from '../components/Reveal';

export function AboutUsPage() {
  const c = useLandingCopy();
  const p = c.pages.about;
  const ceo = c.whoWeAre;
  const initials = ceo.ceoName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('');

  return (
    <>
      <PageHero
        id="about-page-title"
        kicker={p.hero.kicker}
        title={p.hero.title}
        titleEm={p.hero.titleEm}
        subtitle={p.hero.subtitle}
        primaryLabel={p.hero.ctaPrimary}
        primaryTo="/events"
        secondaryLabel={p.hero.ctaSecondary}
        secondaryTo="/how-it-works"
        proof={p.hero.proof}
      />

      {/* About our CEO */}
      <section aria-labelledby="about-ceo" className="section-x scroll-mt-24 py-12 lg:py-16">
        <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
            <div className="card flex flex-col items-center p-8 text-center">
              <span
                aria-hidden="true"
                className="grid h-24 w-24 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-2xl font-bold text-white shadow-card"
              >
                {initials}
              </span>
              <h2 id="about-ceo" className="mt-5 text-xl font-bold text-slate-900">
                {ceo.ceoName}
              </h2>
              <p className="mt-1 text-sm font-medium text-brand-700">{ceo.ceoRole}</p>
            </div>
            <div className="card p-8">
              <h3 className="text-lg font-semibold text-slate-900">{ceo.ceoHeading}</h3>
              <div className="mt-4 space-y-4">
                {ceo.ceoParagraphs.map((para, i) => (
                  <p key={i} className="text-sm leading-7 text-slate-700">
                    {para}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      {/* About the team */}
      <section aria-labelledby="about-team" className="section-x scroll-mt-24 py-12 lg:py-16">
        <Reveal className="glass-panel mx-auto px-6 py-12 text-center sm:px-10 lg:px-14 lg:py-16">
          <h2
            id="about-team"
            className="mx-auto max-w-2xl text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl"
          >
            {p.team.heading}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-700">{p.team.body}</p>
        </Reveal>
      </section>

      {/* What we believe */}
      <CardSection
        id="about-values"
        kicker={p.values.kicker}
        title={p.values.title}
        items={p.values.items}
      />

      <CTASection
        title={p.cta.title}
        subtitle={p.cta.subtitle}
        primaryLabel={p.cta.primary}
        primaryTo="/events"
        secondaryLabel={p.cta.secondary}
        secondaryTo="/how-it-works"
      />
    </>
  );
}
