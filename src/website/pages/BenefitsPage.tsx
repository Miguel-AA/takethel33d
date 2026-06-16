// Benefits — "/benefits". A full marketing page: hero, core benefits (3),
// why it matters (3), and a closing CTA. Conversion-focused, driving to /events.
import { useLandingCopy } from '../useLandingCopy';
import { PageHero } from '../components/PageHero';
import { CardSection } from '../components/CardSection';
import { CTASection } from '../components/CTASection';

export function BenefitsPage() {
  const p = useLandingCopy().pages.benefits;

  return (
    <>
      <PageHero
        id="benefits-page-title"
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
        id="benefits-core"
        kicker={p.core.kicker}
        title={p.core.title}
        subtitle={p.core.subtitle}
        items={p.core.items}
      />

      <CardSection
        id="benefits-why"
        kicker={p.why.kicker}
        title={p.why.title}
        subtitle={p.why.subtitle}
        items={p.why.items}
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
