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
      <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <SectionHeading id="how-title" kicker={copy.kicker} title={copy.title} subtitle={copy.subtitle} />

        <Reveal as="ol" stagger className="mt-14 flex flex-col items-stretch gap-6 md:flex-row md:gap-4">
          {copy.steps.map((step, i) => (
            <Fragment key={step.n}>
              <li className="group relative flex-1">
                <div className="card flex h-full flex-col items-center p-8 text-center transition duration-300 hover:-translate-y-1 hover:shadow-cardLg">
                  {/* Blue outline icon, integrated into the card — no heavy box. */}
                  <div className="relative flex items-center gap-2 text-brand-600">
                    {step.icon ? (
                      <Icon name={step.icon} className="h-9 w-9" strokeWidth={1.6} />
                    ) : (
                      <span className="font-mono text-2xl font-bold">{step.n}</span>
                    )}
                    <span className="font-mono text-sm font-semibold text-brand-700/80">{step.n}</span>
                  </div>
                  <h3 className="mt-5 text-lg font-semibold text-slate-900">{step.title}</h3>
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
      </Reveal>
    </section>
  );
}
