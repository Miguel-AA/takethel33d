import { Link, useParams } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { EventDrawPanel } from '../components/draw/EventDrawPanel';

/**
 * The draw, on a page of its own.
 *
 * NOT a tab on the participants screen and not a button on the event detail,
 * and the separation is deliberate. Every other administrative action lives
 * beside the data it changes, where a click is cheap and reversible. This one
 * cannot be undone, so it does not sit next to a table an operator is scrolling
 * through — reaching it is a decision rather than a reflex.
 *
 * The page itself is composition. Every piece of judgement lives somewhere it
 * can be tested without a router: the arithmetic in `shared/drawLifecycle`, the
 * selection in the service, the rendering in the panel below.
 */
export function ManagerEventDrawPage() {
  const { t } = useTranslation();
  const { eventId = '' } = useParams();

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {t('draw.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{t('draw.subtitle')}</p>
        </div>
        <Link
          to={`/manager/events/${eventId}`}
          className="btn-secondary w-fit shrink-0 text-xs"
        >
          {t('entries.action.backToEvent')}
        </Link>
      </header>

      <EventDrawPanel eventId={eventId} />
    </div>
  );
}
