import type { LandingCopy } from '../copy';
import { Icon } from '../icons';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

export function Features({ copy }: { copy: LandingCopy['features'] }) {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      <SectionHeading
        id="features-title"
        kicker={copy.kicker}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <Reveal as="ul" stagger className="mt-12 grid gap-5 sm:grid-cols-2">
        {copy.items.map((item) => (
          <li key={item.title} className="card flex items-start gap-4 p-6">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-brand-400/30 bg-brand-500/10 text-brand-600">
              <Icon name={item.icon} className="h-6 w-6" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-slate-700">{item.body}</p>
            </div>
          </li>
        ))}
      </Reveal>
    </section>
  );
}
