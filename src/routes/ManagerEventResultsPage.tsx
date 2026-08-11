import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../i18n/I18nProvider';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { useEventResults } from '../hooks/useEventResults';
import { useEvent } from '../hooks/useEvents';
import { queryKeys } from '../lib/queryKeys';
import { ResultsSummary } from '../components/results/ResultsSummary';
import { WinnerTable } from '../components/results/WinnerTable';
import { ResultsPublicationPanel } from '../components/results/ResultsPublicationPanel';
import { ArchiveEventPanel } from '../components/results/ArchiveEventPanel';

/**
 * What happened, what has been announced, and how to close the event.
 *
 * A SEPARATE PAGE FROM THE DRAW, deliberately. The draw screen is the evidence
 * of the selection — the algorithm, the candidate hash, the population it
 * consumed — and it stays exactly as phase 11 left it. This is the layer above:
 * the result as an object that can be published and filed away.
 *
 * The page is composition. Every piece of judgement lives somewhere it can be
 * tested without a router: the rules in `shared/resultLifecycle`, the snapshot
 * in the service, the rendering in the components below.
 */
export function ManagerEventResultsPage() {
  const { t } = useTranslation();
  const { eventId = '' } = useParams();
  const qc = useQueryClient();

  const results = useEventResults(eventId);
  // Only for the slug, which the public link needs. The results DTO carries no
  // slug of its own: it is an administrative shape, and the public address is
  // not one of its facts.
  const detail = useEvent(eventId);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {t('results.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{t('results.subtitle')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            to={`/manager/events/${eventId}/draw`}
            className="btn-secondary w-fit text-xs"
          >
            {t('draw.nav')}
          </Link>
          <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit text-xs">
            {t('entries.action.backToEvent')}
          </Link>
        </div>
      </header>

      {results.isLoading && (
        <div className="card flex items-center gap-3 p-6 text-sm text-slate-600">
          <Spinner />
          {t('common.loading')}
        </div>
      )}

      {results.isError && <ErrorBanner message={t('results.error.load')} />}

      {results.data && results.data.draw === null && (
        <div className="card p-8 text-center text-sm text-slate-500">
          {t('results.empty')}
        </div>
      )}

      {results.data && results.data.draw && (
        <>
          <ResultsSummary
            draw={results.data.draw}
            unassignedUnitCount={results.data.unassignedUnitCount}
          />

          <WinnerTable
            assignments={results.data.assignments}
            // The preview column answers "what will the world see?", which is
            // only a live question before publishing. Afterwards the record
            // exists and the public page is one click away.
            showPublicPreview={results.data.publication === null}
          />

          <ResultsPublicationPanel
            eventId={eventId}
            eventSlug={detail.data?.event.slug ?? ''}
            results={results.data}
          />

          <ArchiveEventPanel
            eventId={eventId}
            results={results.data}
            onArchived={() => {
              // Archiving changes the event's status, which changes what this
              // page may offer. Named explicitly rather than left to a prefix
              // match, so the refetch is the one that was intended.
              void qc.invalidateQueries({ queryKey: queryKeys.eventResults(eventId) });
            }}
          />
        </>
      )}
    </div>
  );
}
