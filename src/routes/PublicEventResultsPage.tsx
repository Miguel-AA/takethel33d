import { useParams } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { Spinner } from '../components/Spinner';
import { usePublicEventResults } from '../hooks/useEventResults';
import { PublicResultsHeader } from '../components/public/PublicResultsHeader';
import { PublicWinnerList } from '../components/public/PublicWinnerList';

/**
 * The published winners of one event.
 *
 * NO AUTHENTICATION, no administrative chrome, and no way in from the manager
 * shell. It is reached by a URL somebody was given — the same short address the
 * registration page uses, with `/results` on the end — and it outlives the
 * event: an archived event has no public page any more, and its published
 * results are still here.
 *
 * FOUR STATES, and two of them are deliberately the same. "This event has not
 * been drawn" and "this event was drawn privately and never published" both
 * render as "no results" — telling them apart would make this page an oracle
 * for whether a private draw has happened, which is exactly what an operator
 * withholds by not publishing.
 */
export function PublicEventResultsPage() {
  const { t, locale } = useTranslation();
  const { eventSlug = '' } = useParams();

  const results = usePublicEventResults(eventSlug);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      {results.isLoading && (
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-slate-600">
          <Spinner />
          {t('publicResults.loading')}
        </div>
      )}

      {results.isError && (
        <div className="glass-panel p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">
            {t('publicResults.unavailable.title')}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {t('publicResults.unavailable.body')}
          </p>
        </div>
      )}

      {results.data && (
        <div className="space-y-8">
          <PublicResultsHeader
            eventName={results.data.event.name}
            publishedAt={results.data.results.publishedAt}
            locale={locale}
          />
          <PublicWinnerList winners={results.data.results.winners} />
        </div>
      )}
    </main>
  );
}
