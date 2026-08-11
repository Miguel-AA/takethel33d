import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { Spinner } from '../Spinner';
import { useEventTransition } from '../../hooks/useEvents';
import type { AdminEventResults } from '@shared/types';

/**
 * Closing the event for good.
 *
 * The warning is the point. Archiving is terminal — no action returns an event
 * from ARCHIVED — and publishing afterwards is refused, so this is the last
 * moment anybody can choose whether these results are ever made public. An
 * operator who archives an unpublished draw has decided, permanently, that
 * nobody outside will see it, and the dialog says so in those words rather than
 * in the language of state machines.
 */
export function ArchiveEventPanel({
  eventId,
  results,
  onArchived,
}: {
  eventId: string;
  results: AdminEventResults;
  onArchived: () => void;
}) {
  const { t, locale } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const transition = useEventTransition(eventId);

  if (results.archivedAt || results.eventStatus === 'ARCHIVED') {
    return (
      <section className="card p-5" aria-labelledby="results-archive-heading">
        <h2 id="results-archive-heading" className="text-base font-semibold text-slate-900">
          {t('results.archive.title')}
        </h2>
        <p className="mt-2 text-sm text-slate-600" data-testid="archive-state">
          {results.archivedAt
            ? t('results.archive.archivedAt', {
                at: formatDateTime(results.archivedAt, locale),
              })
            : t('results.archive.archived')}
        </p>
      </section>
    );
  }

  return (
    <section className="card p-5" aria-labelledby="results-archive-heading">
      <h2 id="results-archive-heading" className="text-base font-semibold text-slate-900">
        {t('results.archive.title')}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{t('results.archive.body')}</p>

      <div className="mt-4">
        <button
          type="button"
          className="btn-secondary w-full sm:w-auto"
          disabled={!results.canArchive}
          onClick={() => setConfirming(true)}
        >
          {t('results.archive.action')}
        </button>
      </div>

      {confirming && (
        <ArchiveConfirmationDialog
          discardsResults={results.archivingWouldDiscardResults}
          submitting={transition.isPending}
          error={transition.error ? messageFor(transition.error, t) : null}
          onConfirm={() => {
            transition.mutate(
              { action: 'archive' },
              {
                onSuccess: () => {
                  setConfirming(false);
                  onArchived();
                },
              },
            );
          }}
          onClose={() => {
            transition.reset();
            setConfirming(false);
          }}
        />
      )}
    </section>
  );
}

function ArchiveConfirmationDialog({
  discardsResults,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  discardsResults: boolean;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    window.requestAnimationFrame(() => confirmRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose, submitting]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${titleId}-body`}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="glass-panel-strong w-full max-w-lg p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="text-base font-semibold text-slate-900">
          {t('results.archive.confirmTitle')}
        </h3>
        <p id={`${titleId}-body`} className="mt-2 text-sm text-slate-600">
          {t('results.archive.confirmBody')}
        </p>

        {discardsResults && (
          <p
            className="mt-4 rounded-lg bg-red-50 p-3 text-sm font-medium text-red-900"
            data-testid="archive-discard-warning"
          >
            {t('results.archive.unpublishedWarning')}
          </p>
        )}

        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {t('results.archive.irreversible')}
        </p>

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            ref={confirmRef}
            className="btn-primary w-full sm:w-auto"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? <Spinner /> : t('results.archive.confirm')}
          </button>
          <button
            type="button"
            className="btn-secondary w-full sm:w-auto"
            disabled={submitting}
            onClick={onClose}
          >
            {t('participants.action.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function messageFor(error: Error, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t('common.error');
  if (error.code === 'EVENT_INVALID_TRANSITION') return t('results.archive.notAllowed');
  return t('common.error');
}
