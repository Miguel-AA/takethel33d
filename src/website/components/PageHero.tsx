// Interior marketing-page hero. Mirrors the home Hero's heading treatment —
// premium kicker, large gradient title, lead subtitle, and the shared blue
// glow — so every page opens with the same look. The home-only content blocks
// (CTA buttons, the live mockup) intentionally stay on the home Hero.
import { HeroGlow } from './HeroGlow';

export function PageHero({
  id,
  kicker,
  title,
  subtitle,
}: {
  /** id applied to the <h1> so the following section can reference it via aria-labelledby */
  id: string;
  kicker: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <section className="section-x relative isolate pb-12 pt-14 text-center lg:pb-16 lg:pt-20">
      {/* Same controlled blue glow used behind the home hero. */}
      <HeroGlow />

      <div className="mx-auto flex max-w-3xl flex-col items-center">
        <span className="premium-kicker">{kicker}</span>
        <h1
          id={id}
          className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl"
        >
          <span className="bg-gradient-to-r from-brand-700 via-brand-600 to-brand-400 bg-clip-text text-transparent">
            {title}
          </span>
        </h1>
        {subtitle && (
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-700">{subtitle}</p>
        )}
      </div>
    </section>
  );
}
