import type { LandingCopy } from '../copy';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

export function WhoWeAre({ copy }: { copy: LandingCopy['whoWeAre'] }) {
  const initials = copy.ceoName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <section
      id="who-we-are"
      aria-labelledby="who-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <SectionHeading
          id="who-title"
          kicker={copy.kicker}
          title={copy.title}
          subtitle={copy.subtitle}
        />

        <Reveal className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
          {/* CEO identity card */}
          <div className="card flex flex-col items-center p-8 text-center">
            <span
              aria-hidden="true"
              className="grid h-24 w-24 place-items-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-2xl font-bold text-white shadow-card"
            >
              {initials}
            </span>
            <h3 className="mt-5 text-xl font-bold text-slate-900">{copy.ceoName}</h3>
            <p className="mt-1 text-sm font-medium text-brand-700">{copy.ceoRole}</p>
          </div>

          {/* Bio */}
          <div className="card p-8">
            <h3 className="text-lg font-semibold text-slate-900">{copy.ceoHeading}</h3>
            <div className="mt-4 space-y-4">
              {copy.ceoParagraphs.map((para, i) => (
                <p key={i} className="text-sm leading-7 text-slate-700">
                  {para}
                </p>
              ))}
            </div>
          </div>
        </Reveal>
      </Reveal>
    </section>
  );
}
