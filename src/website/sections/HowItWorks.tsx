import { Fragment } from 'react';
import type { LandingCopy } from '../copy';
import { Icon, ArrowRightIcon } from '../icons';
import { SectionHeading } from '../components/SectionHeading';
import { Reveal } from '../components/Reveal';

export function HowItWorks({ copy }: { copy: LandingCopy['how'] }) {
  return (
    <section
      id="how"
      aria-labelledby="how-title"
      className="section-x scroll-mt-24 py-16 lg:py-24"
    >
      <SectionHeading id="how-title" kicker={copy.kicker} title={copy.title} subtitle={copy.subtitle} />

      <Reveal as="ol" stagger className="mt-14 flex flex-col items-stretch gap-6 md:flex-row md:gap-4">
        {copy.steps.map((step, i) => (
          <Fragment key={step.n}>
            <li className="group relative flex-1">
              <div className="glass-panel flex h-full flex-col items-center p-8 text-center transition duration-300 hover:-translate-y-1 hover:shadow-cardLg">
                <div className="relative">
                  <span className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 text-white shadow-card">
                    {step.icon ? (
                      <Icon name={step.icon} className="h-7 w-7" />
                    ) : (
                      <span className="font-mono text-lg font-bold">{step.n}</span>
                    )}
                  </span>
                  <span className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full border border-white/70 bg-white font-mono text-xs font-bold text-brand-700 shadow-sm">
                    {step.n}
                  </span>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 -z-10 rounded-2xl bg-brand-500/30 blur-xl"
                  />
                </div>
                <h3 className="mt-6 text-lg font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p>
              </div>

              {/* Subtle connector chevron — points down when stacked, right on desktop. */}
              {i < copy.steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1/2 top-full z-10 -translate-x-1/2 translate-y-1 text-brand-400 md:left-full md:top-1/2 md:-translate-y-1/2"
                >
                  <ArrowRightIcon className="h-5 w-5 rotate-90 md:rotate-0" />
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </Reveal>
    </section>
  );
}
