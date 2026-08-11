import { useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { usePublishResults } from '../../hooks/useEventResults';
import { PublishConfirmationDialog } from './PublishConfirmationDialog';
import type { AdminEventResults, PublicationBlocker } from '@shared/types';

/**
 * Whether the results are public, and the one action that can change that.
 *
 * TWO STATES, and only one of them offers a button. Once published there is no
 * "unpublish" — not disabled, ABSENT, because a greyed-out control implies a
 * state in which it would work and there is no such state. Withdrawing a
 * publication would mean somebody was publicly named a winner and then unnamed.
 */
export function ResultsPublicationPanel({
  eventId,
  eventSlug,
  results,
}: {
  eventId: string;
  eventSlug: string;
  results: AdminEventResults;
}) {
  const { t, locale } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const publish = usePublishResults(eventId);

  const { publication } = results;

  if (publication) {
    return (
      <section className="card p-5" aria-labelledby="results-publication-heading">
        <h2
          id="results-publication-heading"
          className="text-base font-semibold text-slate-900"
        >
          {t('results.publication.title')}
        </h2>
        <p className="mt-2 text-sm text-emerald-800" data-testid="publication-state">
          {t('results.publication.published', {
            at: formatDateTime(publication.publishedAt, locale),
          })}
          {publication.publishedByName ? ` · ${publication.publishedByName}` : ''}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {t('results.publication.winnerCount', { count: String(publication.winnerCount) })}
        </p>
        <a
          className="btn-secondary mt-4 inline-block w-fit text-xs"
          href={`/e/${encodeURIComponent(eventSlug)}/results`}
          target="_blank"
          rel="noreferrer"
        >
          {t('results.publication.viewPublic')}
        </a>
      </section>
    );
  }

  return (
    <section className="card p-5" aria-labelledby="results-publication-heading">
      <h2 id="results-publication-heading" className="text-base font-semibold text-slate-900">
        {t('results.publication.title')}
      </h2>
      <p className="mt-2 text-sm text-slate-600" data-testid="publication-state">
        {t('results.publication.unpublished')}
      </p>

      {!results.canPublish && results.publishBlocker && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t(blockerKey(results.publishBlocker))}
        </p>
      )}

      <div className="mt-4">
        <button
          type="button"
          className="btn-primary w-full sm:w-auto"
          disabled={!results.canPublish}
          onClick={() => setConfirming(true)}
        >
          {t('results.publication.publish')}
        </button>
      </div>

      {confirming && (
        <PublishConfirmationDialog
          assignments={results.assignments}
          submitting={publish.isPending}
          error={publish.error ? messageFor(publish.error, t) : null}
          onConfirm={() => {
            publish.mutate(undefined, {
              // Closed only on success. A refusal keeps the dialog open with the
              // reason in it, so the operator reads why.
              onSuccess: () => setConfirming(false),
            });
          }}
          onClose={() => {
            publish.reset();
            setConfirming(false);
          }}
        />
      )}
    </section>
  );
}

function blockerKey(blocker: PublicationBlocker): string {
  return `results.blocker.${blocker}`;
}

/**
 * Turns a refusal into something an operator can act on.
 *
 * `RESULTS_ALREADY_PUBLISHED` is not among them, and cannot be: the server
 * answers a retry with the publication rather than an error.
 */
function messageFor(error: Error, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t('common.error');
  switch (error.code) {
    case 'RESULTS_NOT_PUBLISHABLE':
      return error.fields?.blocker === 'EVENT_ARCHIVED'
        ? t('results.blocker.EVENT_ARCHIVED')
        : t('results.blocker.EVENT_NOT_DRAWN');
    case 'RESULTS_CONFLICT':
      return t('results.error.conflict');
    default:
      return t('common.error');
  }
}
