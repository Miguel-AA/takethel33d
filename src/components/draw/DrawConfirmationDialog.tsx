import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../Spinner';
import type { DrawReadiness } from '@shared/types';

/**
 * The confirmation before the one irreversible act in the system.
 *
 * DELIBERATELY HARDER THAN THE OTHER DIALOGS, and the reason is not caution for
 * its own sake. Every other confirmation in this application guards something
 * that can be undone: a disqualification can be reinstated, an event can be
 * reopened, a prize can be reactivated. A draw cannot be re-run — the schema
 * makes a second one impossible — so a mis-click here is permanent in a way no
 * other mis-click is.
 *
 * So it asks for a typed confirmation rather than a click. It is the same
 * pattern a repository host uses for deleting a repository, for the same
 * reason: it makes the action impossible to perform by muscle memory, and it
 * forces the operator to read a sentence that names what is about to happen.
 *
 * The numbers shown come from the server's readiness. They are informational —
 * the draw re-resolves all of them and re-asserts them at commit time — so a
 * panel that went stale while somebody read it cannot change what happens. The
 * worst it can do is promise a draw that then refuses to run.
 */
export function DrawConfirmationDialog({
  readiness,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  readiness: DrawReadiness;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [typed, setTyped] = useState('');

  const inputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);

  const phrase = t('draw.confirm.phrase');

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    window.requestAnimationFrame(() => inputRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      // Escape closes, but only while nothing is in flight: dismissing the
      // dialog mid-request would leave the operator with no idea whether the
      // draw happened.
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose, submitting]);

  // Trimmed and case-insensitive. The point is deliberate confirmation, not a
  // typing test, and refusing "SORTEAR " for a trailing space would only teach
  // the operator to fight the field.
  const confirmed = typed.trim().toLocaleLowerCase() === phrase.toLocaleLowerCase();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${fieldId}-title`}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="glass-panel-strong w-full max-w-lg p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={`${fieldId}-title`} className="text-base font-semibold text-slate-900">
          {t('draw.confirm.title')}
        </h3>

        <p className="mt-2 text-sm text-slate-600">
          {t('draw.confirm.body', {
            candidates: String(readiness.candidateCount),
            winners: String(readiness.plannedWinnerCount),
          })}
        </p>

        {readiness.plannedWinnerCount < readiness.prizeUnitCount && (
          <p className="mt-2 text-sm text-amber-900">
            {t('draw.confirm.unclaimed', {
              count: String(readiness.prizeUnitCount - readiness.plannedWinnerCount),
            })}
          </p>
        )}

        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm font-medium text-amber-900">
          {t('draw.confirm.irreversible')}
        </p>

        <div className="mt-4">
          <label className="label" htmlFor={fieldId}>
            {t('draw.confirm.typeLabel', { phrase })}
          </label>
          <input
            id={fieldId}
            ref={inputRef}
            className="input rounded-lg"
            type="text"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            // Disabled while in flight as well as while unconfirmed. A
            // double-click would be a second attempt at an operation that must
            // happen exactly once — the server would refuse it, but the operator
            // would be shown a conflict for a draw that actually succeeded.
            disabled={submitting || !confirmed}
            onClick={onConfirm}
          >
            {submitting ? <Spinner /> : t('draw.confirm.run')}
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
