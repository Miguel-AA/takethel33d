// Reusable marketing section: a framed glass container with a centered heading
// and up to 3 icon cards — matching the Home Page section language. Used across
// the interior marketing pages so they feel as developed as the Home Page.
import type { IconName } from '../icons';
import { Icon } from '../icons';
import { SectionHeading } from './SectionHeading';
import { Reveal } from './Reveal';

export interface CardItem {
  icon: IconName;
  title: string;
  body: string;
}

export function CardSection({
  id,
  kicker,
  title,
  subtitle,
  items,
}: {
  id: string;
  kicker: string;
  title: string;
  subtitle?: string;
  items: CardItem[];
}) {
  // Hard cap at 3 cards per section (home-page bubble/card rule).
  const cards = items.slice(0, 3);
  return (
    <section aria-labelledby={id} className="section-x scroll-mt-24 py-12 lg:py-16">
      <Reveal className="glass-panel mx-auto px-6 py-12 sm:px-10 lg:px-14 lg:py-16">
        <SectionHeading id={id} kicker={kicker} title={title} subtitle={subtitle} />
        <Reveal as="ul" stagger className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((item) => (
            <li key={item.title} className="card p-6">
              <span className="grid h-12 w-12 place-items-center rounded-lg border border-brand-400/30 bg-brand-500/10 text-brand-600">
                <Icon name={item.icon} className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-700">{item.body}</p>
            </li>
          ))}
        </Reveal>
      </Reveal>
    </section>
  );
}
