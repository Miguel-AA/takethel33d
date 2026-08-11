import { useEffect, useId, useRef } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../Spinner';
import { formatPublicWinnerName } from '@shared/resultLifecycle';
import type { AdminResultAssignment } from '@shared/types';

/**
 * The confirmation before results become public.
 *
 * It SHOWS THE PREVIEW rather than describing it. An operator about to publish
 * needs to see "Miguel F." — the actual string that will be written — because
 * the one thing they can still do is stop. The preview is computed with
 * `formatPublicWinnerName`, the same function that writes the snapshot, so
 * there is no second implementation that could show something reassuring and
 * store something else.
 *
 * The names are NOT EDITABLE. A publication is a copy of a decision, and an
 * operator typing over one would be publishing something nobody won.
 *
 * Unlike the draw's dialog this does not demand a typed phrase. The acts are
 * different: a draw picks winners at random and cannot be repeated, while
 * publishing announces a result that already exists and that the operator has
 * been looking at. It is irreversible and it is not a surprise, so it is
 * confirmed with a deliberate click on a button that says what it does.
 */
export function PublishConfirmationDialog({
  assignments,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  assignments: AdminResultAssignment[];
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
      // Escape closes, but only while nothing is in flight: dismissing mid
      // request would leave the operator with no idea whether it happened.
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
        className="glass-panel-strong flex max-h-[90vh] w-full max-w-lg flex-col p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="text-base font-semibold text-slate-900">
          {t('results.publish.title')}
        </h3>

        <p id={`${titleId}-body`} className="mt-2 text-sm text-slate-600">
          {t('results.publish.body', { count: String(assignments.length) })}
        </p>

        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {t('results.publish.irreversible')}
        </p>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {t('results.publish.previewTitle')}
          </h4>
          <ul className="mt-2 space-y-1 text-sm" data-testid="publish-preview">
            {assignments.map((assignment) => (
              <li
                key={assignment.drawOrder}
                className="flex flex-wrap justify-between gap-2 rounded bg-slate-50 px-3 py-2"
              >
                <span className="font-medium text-slate-900">
                  {formatPublicWinnerName(assignment.winner) ?? '—'}
                </span>
                <span className="text-slate-600">{assignment.prize.nameSnapshot}</span>
              </li>
            ))}
          </ul>
        </div>

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
            // Disabled while in flight. A double-click would be a second attempt
            // at an irreversible act — the server answers it with the existing
            // publication, but the client should not be making it.
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? <Spinner /> : t('results.publish.confirm')}
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
