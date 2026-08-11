import { useTranslation } from '../../i18n/I18nProvider';
import { formatDateTime } from '../../lib/format';

/**
 * The heading of a public results page.
 *
 * The event's name and when the winners were announced, and nothing else. There
 * is no status, no countdown and no call to register: this page is reached
 * after everything has happened, and it may still be reached years later, after
 * the event has been archived and its registration page has stopped existing.
 */
export function PublicResultsHeader({
  eventName,
  publishedAt,
  locale,
}: {
  eventName: string;
  publishedAt: string;
  locale: string;
}) {
  const { t } = useTranslation();

  return (
    <header className="text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">
        {t('publicResults.eyebrow')}
      </p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        {eventName}
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        {t('publicResults.publishedAt', { at: formatDateTime(publishedAt, locale) })}
      </p>
    </header>
  );
}
