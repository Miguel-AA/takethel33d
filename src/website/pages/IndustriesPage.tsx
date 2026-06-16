// Industries — "/industries". A full marketing page: hero, the industries we
// support (3 broad categories), how we adapt (3), and a closing CTA to /events.
// Generic copy only — no real client names.
import { useLandingCopy } from '../useLandingCopy';
import { PageHero } from '../components/PageHero';
import { CardSection } from '../components/CardSection';
import { CTASection } from '../components/CTASection';

export function IndustriesPage() {
  const p = useLandingCopy().pages.industries;

  return (
    <>
      <PageHero
        id="industries-page-title"
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

      <CardSection
        id="industries-list"
        kicker={p.industries.kicker}
        title={p.industries.title}
        subtitle={p.industries.subtitle}
        items={p.industries.items}
      />

      <CardSection
        id="industries-adapt"
        kicker={p.adapt.kicker}
        title={p.adapt.title}
        subtitle={p.adapt.subtitle}
        items={p.adapt.items}
      />

      <CTASection
        title={p.cta.title}
        subtitle={p.cta.subtitle}
        primaryLabel={p.cta.primary}
        primaryTo="/events"
        secondaryLabel={p.cta.secondary}
        secondaryTo="/contact"
      />
    </>
  );
}
