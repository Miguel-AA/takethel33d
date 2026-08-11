import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { Spinner } from '../Spinner';
import {
  DISQUALIFICATION_REASON_MAX_LENGTH,
  DISQUALIFICATION_REASON_MIN_LENGTH,
} from '@shared/limits';
import type { EventEntryStatus } from '@shared/types';

/**
 * The confirmation for a disposition change.
 *
 * ONE component for both actions, because the interaction is identical and the
 * differences are copy: disqualification asks for a reason, reinstatement
 * states where the entry will land. Two near-identical dialogs would be two
 * places to fix a focus bug.
 *
 * Focus is moved IN on open and returned to the trigger on close, Escape
 * closes, and the confirm button is disabled while the request is in flight so
 * a double-click cannot send two mutations — the second of which would fail on
 * the revision guard anyway, but would show the operator a conflict they did
 * not cause.
 */
export function ParticipantDispositionDialog({
  action,
  reinstatesTo,
  submitting,
  error,
  onConfirm,
  onClose,
}: {
  action: 'DISQUALIFY' | 'REINSTATE';
  /** Where a reinstatement lands. Read from the entry, never recomputed. */
  reinstatesTo: EventEntryStatus | null;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLButtonElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    // Remembered before focus moves, so closing puts the operator back where
    // they were rather than at the top of the document.
    returnFocusTo.current = document.activeElement;
    window.requestAnimationFrame(() => firstFieldRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  const isDisqualify = action === 'DISQUALIFY';
  const trimmed = reason.trim();
  const reasonValid =
    trimmed.length >= DISQUALIFICATION_REASON_MIN_LENGTH &&
    trimmed.length <= DISQUALIFICATION_REASON_MAX_LENGTH;
  const showReasonError = isDisqualify && touched && !reasonValid;

  const title = t(
    isDisqualify ? 'participants.disqualify.title' : 'participants.reinstate.title',
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${reasonId}-title`}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="glass-panel-strong w-full max-w-lg p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={`${reasonId}-title`} className="text-base font-semibold text-slate-900">
          {title}
        </h3>

        <p className="mt-2 text-sm text-slate-600">
          {isDisqualify
            ? t('participants.disqualify.body')
            : t('participants.reinstate.body', {
                // Named explicitly so the operator sees INELIGIBLE when that is
                // where the entry returns, rather than assuming "reinstate"
                // means "eligible".
                status: reinstatesTo ? t(`entries.status.${reinstatesTo}`) : '—',
              })}
        </p>

        {isDisqualify && (
          <div className="mt-4">
            <label className="label" htmlFor={reasonId}>
              {t('participants.disqualify.reasonLabel')}
            </label>
            <p id={`${reasonId}-hint`} className="mb-1 text-xs text-slate-500">
              {t('participants.disqualify.reasonHint')}
            </p>
            <textarea
              id={reasonId}
              ref={firstFieldRef as never}
              className="input rounded-lg"
              rows={3}
              maxLength={DISQUALIFICATION_REASON_MAX_LENGTH}
              value={reason}
              aria-invalid={showReasonError ? true : undefined}
              aria-describedby={
                showReasonError ? `${reasonId}-hint ${reasonId}-error` : `${reasonId}-hint`
              }
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
            />
            {showReasonError && (
              <p id={`${reasonId}-error`} className="mt-1 text-sm text-red-700" role="alert">
                {t('participants.disqualify.reasonRequired')}
              </p>
            )}
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            ref={isDisqualify ? undefined : (firstFieldRef as never)}
            className="btn-primary w-full sm:w-auto"
            disabled={submitting || (isDisqualify && !reasonValid)}
            onClick={() => {
              setTouched(true);
              if (isDisqualify && !reasonValid) return;
              onConfirm(trimmed);
            }}
          >
            {submitting ? <Spinner /> : t('participants.action.confirm')}
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
