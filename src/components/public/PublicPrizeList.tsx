import { useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import type { PublicPrizeDTO } from '@shared/types';

/**
 * What is on offer.
 *
 * No odds, no probabilities and no entry counts: this phase has no draw, and a
 * number that looked like a chance of winning would be a claim nobody can
 * stand behind.
 *
 * An event with no active prizes renders nothing at all rather than an empty
 * section — plenty of events legitimately have none, and a heading over a blank
 * space reads as a fault.
 */
export function PublicPrizeList({ prizes }: { prizes: PublicPrizeDTO[] }) {
  const { t } = useTranslation();
  if (prizes.length === 0) return null;

  return (
    <section className="card-lg p-6 sm:p-8" aria-labelledby="public-prizes-heading">
      <h2 id="public-prizes-heading" className="text-xl font-semibold text-slate-900">
        {t('public.prizes.title')}
      </h2>

      <ul className="mt-6 grid gap-5 sm:grid-cols-2">
        {prizes.map((prize) => (
          <li
            key={`${prize.sortOrder}-${prize.name}`}
            className="overflow-hidden rounded-lg border border-slate-900/10 bg-white/60"
          >
            <PrizeImage prize={prize} />
            <div className="p-4">
              <p className="font-semibold text-slate-900">{prize.name}</p>
              {prize.description && (
                <p className="mt-1 text-sm text-slate-600">{prize.description}</p>
              )}
              <p className="mt-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                {prize.quantity === 1
                  ? t('public.prizes.quantityOne')
                  : t('public.prizes.quantity', { count: prize.quantity })}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A prize image that fails quietly.
 *
 * The URL is operator-supplied and points at a third party, so it can rot. A
 * broken image element leaves a torn-page icon and a gap; hiding it on `error`
 * leaves a card that simply has no picture, which is what an operator who never
 * added one gets anyway.
 *
 * The scheme was already constrained to http(s) by the prize mapper, so this is
 * about availability rather than safety.
 */
function PrizeImage({ prize }: { prize: PublicPrizeDTO }) {
  const [broken, setBroken] = useState(false);
  if (!prize.imageUrl || broken) return null;

  return (
    <img
      src={prize.imageUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className="h-40 w-full object-cover"
      onError={() => setBroken(true)}
    />
  );
}
