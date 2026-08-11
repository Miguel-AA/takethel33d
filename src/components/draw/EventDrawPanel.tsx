import { useState } from 'react';
import { useTranslation } from '../../i18n/I18nProvider';
import { ApiError } from '../../lib/api';
import { Spinner } from '../Spinner';
import { ErrorBanner } from '../ErrorBanner';
import { useEventDraw, useRunDraw } from '../../hooks/useEventDraw';
import { DrawConfirmationDialog } from './DrawConfirmationDialog';
import { DrawSummary } from './DrawSummary';
import { DrawAssignmentsList } from './DrawAssignmentsList';
import type { DrawFailureCode } from '@shared/types';

/**
 * The draw screen: either what happened, or what would happen.
 *
 * TWO STATES, NEVER BOTH. Once a draw exists this panel shows the result and
 * offers nothing — no re-run, no reroll, no "draw again", not even disabled.
 * A greyed-out button implies a state in which it would work, and there is no
 * such state: `ux_draws_event` makes a second draw impossible, so offering one
 * would be describing a capability the system does not have.
 *
 * Before a draw, it shows the readiness and exactly one blocker at a time in
 * order of what the operator must fix first. All the judgement about whether a
 * draw can run lives on the server; this renders what it was told.
 */
export function EventDrawPanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);

  const draw = useEventDraw(eventId);
  const run = useRunDraw(eventId);

  if (draw.isLoading) {
    return (
      <div className="card flex items-center gap-3 p-6 text-sm text-slate-600">
        <Spinner />
        {t('common.loading')}
      </div>
    );
  }

  if (draw.isError || !draw.data) {
    return <ErrorBanner message={t('draw.error.load')} />;
  }

  const { draw: completed, assignments, readiness } = draw.data;

  // A completed draw. The result, and nothing that could produce another.
  if (completed) {
    return (
      <div className="space-y-4">
        <DrawSummary draw={completed} />
        <DrawAssignmentsList assignments={assignments} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="card p-5" aria-labelledby="draw-readiness-heading">
        <h3 id="draw-readiness-heading" className="text-base font-semibold text-slate-900">
          {t('draw.readiness.title')}
        </h3>
        <p className="mt-1 text-sm text-slate-600">{t('draw.readiness.body')}</p>

        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Figure
            testId="draw-ready-candidates"
            label={t('draw.readiness.candidates')}
            value={readiness.candidateCount}
          />
          <Figure
            testId="draw-ready-units"
            label={t('draw.readiness.prizeUnits')}
            value={readiness.prizeUnitCount}
          />
          <Figure
            testId="draw-ready-winners"
            label={t('draw.readiness.plannedWinners')}
            value={readiness.plannedWinnerCount}
            tone="text-emerald-700"
          />
        </dl>

        {readiness.blockers.length > 0 && (
          <ul className="mt-4 space-y-2" data-testid="draw-blockers">
            {readiness.blockers.map((blocker) => (
              <li
                key={blocker}
                className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
              >
                {t(blockerKey(blocker))}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6">
          <button
            type="button"
            className="btn-primary w-full sm:w-auto"
            disabled={!readiness.canRun}
            onClick={() => setConfirming(true)}
          >
            {t('draw.action.run')}
          </button>
        </div>
      </section>

      {confirming && (
        <DrawConfirmationDialog
          readiness={readiness}
          submitting={run.isPending}
          error={run.error ? messageFor(run.error, t) : null}
          onConfirm={() => {
            run.mutate(undefined, {
              // Closed only on success. A refusal keeps the dialog open with the
              // reason in it, so the operator reads why rather than watching the
              // panel silently refuse to change.
              onSuccess: () => setConfirming(false),
            });
          }}
          onClose={() => {
            run.reset();
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: number;
  tone?: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg bg-slate-50 p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? 'text-slate-900'}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

/** One key per blocker, so the copy can say what to do rather than what failed. */
function blockerKey(blocker: DrawFailureCode): string {
  return `draw.blocker.${blocker}`;
}

/**
 * Turns a refusal into something an operator can act on.
 *
 * `DRAW_ALREADY_COMPLETED` gets its own message rather than a generic error
 * because it is the one refusal that can mean the draw SUCCEEDED — a lost
 * response, a retry, a second tab. The copy says to reload rather than to try
 * again.
 */
function messageFor(error: Error, t: (key: string) => string): string {
  if (!(error instanceof ApiError)) return t('common.error');
  switch (error.code) {
    case 'DRAW_ALREADY_COMPLETED':
      return t('draw.error.alreadyCompleted');
    case 'DRAW_NOT_READY':
      return t('draw.error.notReady');
    case 'NO_ELIGIBLE_PARTICIPANTS':
      return t('draw.blocker.NO_ELIGIBLE_PARTICIPANTS');
    case 'NO_ACTIVE_PRIZES':
      return t('draw.blocker.NO_ACTIVE_PRIZES');
    case 'DRAW_POPULATION_CHANGED':
      return t('draw.error.populationChanged');
    case 'DRAW_CONFLICT':
      return t('draw.error.conflict');
    default:
      return t('common.error');
  }
}
