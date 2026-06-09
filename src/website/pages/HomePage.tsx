// Home — "/". First impression: the promise, the benefits, how it works,
// proof, and a closing CTA. Reuses the existing marketing sections, now wired
// to drive B2B lead conversion (/contact) and the app (/events) via the header.
import { useLandingCopy } from '../useLandingCopy';
import { Hero } from '../sections/Hero';
import { Benefits } from '../sections/Benefits';
import { HowItWorks } from '../sections/HowItWorks';
import { Features } from '../sections/Features';
import { Trust } from '../sections/Trust';
import { CTASection } from '../components/CTASection';

export function HomePage() {
  const c = useLandingCopy();

  return (
    <>
      <Hero copy={c.hero} />
      <Benefits copy={c.benefits} />
      <HowItWorks copy={c.how} />
      <Features copy={c.features} />
      <Trust copy={c.trust} />
      <CTASection
        title={c.finalCta.title}
        subtitle={c.finalCta.subtitle}
        primaryLabel={c.finalCta.ctaPrimary}
        primaryTo="/contact"
        secondaryLabel={c.finalCta.ctaSecondary}
        secondaryTo="/how-it-works"
      />
    </>
  );
}
