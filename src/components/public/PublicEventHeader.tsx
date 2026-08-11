import { useTranslation } from '../../i18n/I18nProvider';
import type { PublicEventDTO } from '@shared/types';

/**
 * The event, as a visitor meets it.
 *
 * Every value is rendered as TEXT through JSX, never through
 * `dangerouslySetInnerHTML`. Names, descriptions and location strings are
 * operator-written free text, and a client who pastes a script tag into an
 * event name must get a harmless string on the page rather than a payload.
 */
export function PublicEventHeader({ event }: { event: PublicEventDTO }) {
  const { t, locale } = useTranslation();

  const formatDate = (iso: string | null): string | null => {
    if (!iso) return null;
    // Rendered IN THE EVENT'S ZONE, not the visitor's: "doors at 19:00" means
    // 19:00 where the event is, and showing somebody their own local time for a
    // date they will travel to is how people arrive on the wrong day.
    return new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-US', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: event.timezone,
    }).format(new Date(iso));
  };

  const starts = formatDate(event.startsAt);
  const closes = formatDate(event.registrationClosesAt);

  return (
    <header className="card-lg overflow-hidden">
      {event.bannerUrl && (
        <img
          src={event.bannerUrl}
          alt=""
          // Decorative: the event name is already the heading below, so
          // announcing the banner again would be noise. A broken URL simply
          // leaves the element empty rather than breaking the layout.
          aria-hidden="true"
          className="h-40 w-full object-cover sm:h-56"
        />
      )}

      <div className="p-6 sm:p-8">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{event.name}</h1>

        {event.description && (
          <p className="mt-3 whitespace-pre-line text-slate-700">{event.description}</p>
        )}

        <dl className="mt-6 grid gap-4 sm:grid-cols-2">
          {starts && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('public.event.when')}
              </dt>
              <dd className="mt-1 text-sm text-slate-800">{starts}</dd>
            </div>
          )}
          {event.locationName && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('public.event.where')}
              </dt>
              <dd className="mt-1 text-sm text-slate-800">{event.locationName}</dd>
            </div>
          )}
          {closes && event.registrationStatus === 'OPEN' && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t('public.event.registrationCloses')}
              </dt>
              <dd className="mt-1 text-sm text-slate-800">{closes}</dd>
            </div>
          )}
        </dl>

        {event.minimumAge !== null && (
          // INFORMATIONAL ONLY. The client never decides eligibility; it says
          // what the rule is so somebody is not surprised by the outcome.
          <p className="mt-6 rounded-lg bg-slate-900/5 px-4 py-3 text-sm text-slate-700">
            {t('public.event.minimumAge', { age: event.minimumAge })}
          </p>
        )}
      </div>
    </header>
  );
}
