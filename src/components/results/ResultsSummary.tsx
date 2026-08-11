import { useTranslation } from '../../i18n/I18nProvider';
import { formatDateTime } from '../../lib/format';
import type { CompletedDraw } from '@shared/types';

/**
 * What the draw was made of.
 *
 * The same three counts the draw screen shows, because they are the same three
 * facts — this page is where they are read a week later, next to the decision
 * about whether to publish them.
 *
 * The candidate hash is ADMIN-ONLY and stays that way. It is evidence of which
 * population was consumed, useful to somebody auditing the event and of no use
 * to a visitor; putting it on the public page would add an opaque identifier to
 * a surface whose whole design is to carry as little as possible.
 */
export function ResultsSummary({
  draw,
  unassignedUnitCount,
}: {
  draw: CompletedDraw;
  unassignedUnitCount: number;
}) {
  const { t, locale } = useTranslation();

  const figures = [
    { key: 'candidates', value: draw.candidateCount, label: t('results.summary.candidates') },
    { key: 'units', value: draw.prizeUnitCount, label: t('results.summary.prizeUnits') },
    {
      key: 'winners',
      value: draw.assignmentCount,
      label: t('results.summary.winners'),
      tone: 'text-emerald-700',
    },
  ];

  return (
    <section className="card p-5" aria-labelledby="results-summary-heading">
      <h2 id="results-summary-heading" className="text-base font-semibold text-slate-900">
        {t('results.summary.title')}
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        {t('results.summary.completedAt', { at: formatDateTime(draw.completedAt, locale) })}
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
              data-testid={`results-count-${figure.key}`}
            >
              {figure.value}
            </dd>
          </div>
        ))}
      </dl>

      {unassignedUnitCount > 0 && (
        <p
          className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"
          data-testid="results-unassigned"
        >
          {t('results.summary.unassigned', { count: String(unassignedUnitCount) })}
        </p>
      )}

      <dl className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t('results.summary.algorithm')}</dt>
          <dd className="font-mono">{draw.algorithmVersion}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{t('results.summary.candidateHash')}</dt>
          {/* In full, not truncated: a hash shown as `a1b2…` cannot be compared
              against anything, which is the only thing it is for. */}
          <dd className="break-all font-mono">{draw.candidateSetHash}</dd>
        </div>
      </dl>
    </section>
  );
}
