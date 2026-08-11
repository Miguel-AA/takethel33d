import { useTranslation } from '../../i18n/I18nProvider';
import { formatDateTime } from '../../lib/format';
import type { CompletedDraw } from '@shared/types';

/**
 * What a completed draw was made of.
 *
 * THE THREE COUNTS ARE SHOWN SEPARATELY, and they are not decoration. A draw
 * with 40 candidates, 12 prize units and 12 winners is a different event from
 * one with 8 candidates, 12 units and 8 winners — in the second, four prizes
 * went unclaimed. An operator asked "why did only eight people win?" a week
 * later needs the answer on the record, not reconstructed.
 *
 * The algorithm version and the candidate hash are shown too. Neither is
 * pretty, and both are the point: they are how somebody answers "which
 * procedure produced this, over which population?" without being able to
 * reproduce the selection itself.
 */
export function DrawSummary({ draw }: { draw: CompletedDraw }) {
  const { t, locale } = useTranslation();

  const figures = [
    {
      key: 'candidates',
      value: draw.candidateCount,
      label: t('draw.summary.candidates'),
      hint: t('draw.summary.candidatesHint'),
    },
    {
      key: 'units',
      value: draw.prizeUnitCount,
      label: t('draw.summary.prizeUnits'),
      hint: t('draw.summary.prizeUnitsHint'),
    },
    {
      key: 'winners',
      value: draw.assignmentCount,
      label: t('draw.summary.winners'),
      hint: t('draw.summary.winnersHint'),
      tone: 'text-emerald-700',
    },
  ];

  return (
    <section className="card p-5" aria-labelledby="draw-summary-heading">
      <h3 id="draw-summary-heading" className="text-base font-semibold text-slate-900">
        {t('draw.summary.title')}
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        {t('draw.summary.completedAt', { at: formatDateTime(draw.completedAt, locale) })}
        {draw.executedByName ? ` · ${draw.executedByName}` : ''}
      </p>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {figures.map((figure) => (
          <div key={figure.key} className="rounded-lg bg-slate-50 p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {figure.label}
            </dt>
            <dd
              className={`mt-1 text-2xl font-semibold tabular-nums ${figure.tone ?? 'text-slate-900'}`}
              data-testid={`draw-count-${figure.key}`}
            >
              {figure.value}
            </dd>
            <p className="mt-1 text-xs text-slate-500">{figure.hint}</p>
          </div>
        ))}
      </dl>

      {draw.assignmentCount < draw.prizeUnitCount && (
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t('draw.summary.unclaimed', {
            count: String(draw.prizeUnitCount - draw.assignmentCount),
          })}
        </p>
      )}

      <dl className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t('draw.summary.algorithm')}</dt>
          <dd className="font-mono">{draw.algorithmVersion}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t('draw.summary.candidateHash')}</dt>
          {/* Wrapped rather than truncated: a hash shown as `a1b2c3…` cannot be
              compared against anything, which is the only thing it is for. */}
          <dd className="break-all font-mono">{draw.candidateSetHash}</dd>
        </div>
      </dl>
    </section>
  );
}
