import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { usePublicEvent, useSubmitPublicEntry } from '../hooks/usePublicEvent';
import { usePublicEventResults } from '../hooks/useEventResults';
import { PublicEventHeader } from '../components/public/PublicEventHeader';
import { PublicPrizeList } from '../components/public/PublicPrizeList';
import { PublicFormWizard } from '../components/public/PublicFormWizard';
import { PublicSubmissionResult } from '../components/public/PublicSubmissionResult';
import { Spinner } from '../components/Spinner';
import { ApiError } from '../lib/api';
import type { PublicEntryResponse } from '@shared/types';
import type { SubmittedAnswer } from '@shared/formAnswers';

/**
 * The participant-facing page.
 *
 * NO ADMIN CHROME AND NO AUTH GUARD. It is not wrapped in `ProtectedRoute`, it
 * never reads the session query, and it renders none of the application header
 * — a visitor arriving from a shared link must not meet a log-out button or a
 * dashboard link.
 *
 * It lives at `/e/:eventSlug`, not `/events/:slug`. `/events` is the LEGACY
 * lead-capture page and is untouched: adding a dynamic sibling under the same
 * segment would put a heavily-used legacy route one routing-precedence change
 * away from breaking. A separate, shorter prefix is also better for the thing
 * this URL is actually for — being printed on a flyer.
 */
export function PublicEventPage() {
  const { eventSlug = '' } = useParams();
  const { t } = useTranslation();

  const query = usePublicEvent(eventSlug);
  const mutation = useSubmitPublicEntry(eventSlug);
  const [result, setResult] = useState<PublicEntryResponse | null>(null);

  /**
   * The idempotency key for THIS filled-in form.
   *
   * Minted once and reused for every attempt, which is precisely what makes a
   * retry safe: the same key means the same logical submission, so a network
   * failure followed by a second tap cannot produce two entries. A key minted
   * per click would defeat the entire mechanism.
   */
  const submissionId = useRef<string>(crypto.randomUUID());

  const event = query.data?.event;

  const submissionError = useMemo(() => {
    if (!mutation.error) return null;
    const error = mutation.error;
    if (error instanceof ApiError) {
      const key = `public.error.${error.code}`;
      const translated = t(key);
      // An unrecognised code renders the generic message rather than the raw
      // enum: the public vocabulary is small and closed, and anything outside
      // it is not something to show a visitor.
      if (translated !== key) return translated;
    }
    return t('public.error.PUBLIC_EVENT_UNAVAILABLE');
  }, [mutation.error, t]);

  const onSubmit = useCallback(
    (answers: SubmittedAnswer[]) => {
      if (!event?.formToken) return;
      mutation.mutate(
        {
          formToken: event.formToken,
          submissionId: submissionId.current,
          answers,
        },
        { onSuccess: setResult },
      );
    },
    [event?.formToken, mutation],
  );

  if (query.isLoading) {
    return (
      <Shell>
        <div className="card-lg flex items-center justify-center gap-3 p-12">
          <Spinner />
          <p className="text-slate-600">{t('public.loading')}</p>
        </div>
      </Shell>
    );
  }

  if (query.isError || !event) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Shell>
        <Notice
          title={t(notFound ? 'public.notFound.title' : 'public.unavailable.title')}
          body={t(notFound ? 'public.notFound.body' : 'public.unavailable.body')}
          onRetry={notFound ? undefined : () => query.refetch()}
          retryLabel={t('public.error.retry')}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <PublicEventHeader event={event} />

      {result ? (
        <PublicSubmissionResult result={result} />
      ) : (
        <StatusSection
          event={event}
          submitting={mutation.isPending}
          submissionError={submissionError}
          onSubmit={onSubmit}
        />
      )}

      <PublicPrizeList prizes={event.prizes} />

      {/* Offered only when results have ACTUALLY been published. Deriving it
          from `DRAW_COMPLETED` would advertise a page that does not exist for
          an event whose operator chose to keep the draw private. */}
      <PublicResultsLink slug={eventSlug} />
    </Shell>
  );
}

/**
 * A link to the published winners, when there are any.
 *
 * It asks the results endpoint rather than reading a flag off the event,
 * because "has this been published?" is a fact only the publication can answer
 * — and the endpoint answers 404 for an unpublished draw exactly as it does for
 * an event that was never drawn, so this cannot become an oracle either.
 */
function PublicResultsLink({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const results = usePublicEventResults(slug);

  if (!results.data) return null;

  return (
    <div className="text-center">
      <a className="btn-primary inline-block" href={`/e/${encodeURIComponent(slug)}/results`}>
        {t('publicResults.viewResults')}
      </a>
    </div>
  );
}

function StatusSection({
  event,
  submitting,
  submissionError,
  onSubmit,
}: {
  event: NonNullable<ReturnType<typeof usePublicEvent>['data']>['event'];
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (answers: SubmittedAnswer[]) => void;
}) {
  const { t, locale } = useTranslation();

  switch (event.registrationStatus) {
    case 'OPEN':
      // `form` and `formToken` are non-null exactly when the status is OPEN —
      // the server emits them together or not at all. The guard is here because
      // the type permits null, not because the state is expected.
      return event.form && event.formToken ? (
        <PublicFormWizard
          form={event.form}
          submitting={submitting}
          submissionError={submissionError}
          onSubmit={onSubmit}
        />
      ) : (
        <Notice
          title={t('public.unavailable.title')}
          body={t('public.unavailable.body')}
        />
      );

    case 'UPCOMING': {
      const opens = event.registrationOpensAt
        ? new Intl.DateTimeFormat(locale === 'es' ? 'es-ES' : 'en-US', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: event.timezone,
          }).format(new Date(event.registrationOpensAt))
        : null;

      return (
        <Notice
          title={t('public.upcoming.title')}
          body={
            opens
              ? t('public.upcoming.body', { date: opens })
              : t('public.upcoming.bodyNoDate')
          }
        />
      );
    }

    case 'CLOSED':
      return <Notice title={t('public.closed.title')} body={t('public.closed.body')} />;

    case 'CANCELLED':
      return (
        <Notice title={t('public.cancelled.title')} body={t('public.cancelled.body')} />
      );

    case 'UNAVAILABLE':
      return (
        <Notice title={t('public.unavailable.title')} body={t('public.unavailable.body')} />
      );
  }
}

function Notice({
  title,
  body,
  onRetry,
  retryLabel,
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <section className="card-lg p-8 text-center" role="status">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <p className="mx-auto mt-3 max-w-prose text-slate-700">{body}</p>
      {onRetry && (
        <button type="button" className="btn-secondary mt-6" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </section>
  );
}

/** A narrow, centred column that never scrolls sideways on a small screen. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      {children}
    </div>
  );
}
