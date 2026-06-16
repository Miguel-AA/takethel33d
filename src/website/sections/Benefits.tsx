import { Link } from 'react-router-dom';
import type { LandingCopy } from '../copy';
import { Icon, ArrowRightIcon } from '../icons';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

export function Benefits({ copy }: { copy: LandingCopy['benefits'] }) {
  return (
    <section
      id="benefits"
      aria-labelledby="benefits-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      {/* Framed container so the section reads as a clear, contained block. */}
      <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <SectionHeading
          id="benefits-title"
          kicker={copy.kicker}
          title={copy.title}
          subtitle={copy.subtitle}
        />

        <Reveal as="ul" stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {copy.items.map((item) => (
            <li key={item.title} className="card p-6">
              <span className="grid h-12 w-12 place-items-center rounded-lg border border-brand-400/30 bg-brand-500/10 text-brand-600">
                <Icon name={item.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">{item.body}</p>
            </li>
          ))}
        </Reveal>

        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <Link to="/events" className="btn-primary px-7 py-3 text-base">
            {copy.ctaPrimary}
            <ArrowRightIcon className="h-5 w-5" />
          </Link>
          <Link to="/how-it-works" className="btn-secondary px-7 py-3 text-base">
            {copy.ctaSecondary}
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
