import { useTranslation } from '../../i18n/I18nProvider';
import type { AdminParticipantSummaryCounts } from '@shared/types';

/**
 * The counts above the table.
 *
 * `eligible` and `drawEligible` are shown as SEPARATE figures with distinct
 * labels, and that is the whole reason this component exists rather than a
 * single "eligible" number. They answer different questions:
 *
 *   eligible      — how many people qualified when they entered (history)
 *   drawEligible  — how many are still in the running (history AND disposition)
 *
 * An entry that qualified and was later disqualified is counted in the first
 * and not the second. Collapsing them into one figure would give a confidently
 * wrong answer to whichever question the operator actually meant, and the one
 * that matters for a draw is the smaller one.
 */
export function ParticipantSummaryCards({
  summary,
}: {
  summary: AdminParticipantSummaryCounts;
}) {
  const { t } = useTranslation();

  const cards = [
    { key: 'total', value: summary.total, label: t('participants.summary.total') },
    { key: 'eligible', value: summary.eligible, label: t('participants.summary.eligible') },
    {
      key: 'ineligible',
      value: summary.ineligible,
      label: t('participants.summary.ineligible'),
    },
    {
      key: 'disqualified',
      value: summary.disqualified,
      label: t('participants.summary.disqualified'),
      tone: 'text-red-700',
    },
    {
      key: 'drawEligible',
      value: summary.drawEligible,
      label: t('participants.summary.drawEligible'),
      hint: t('participants.summary.drawEligibleHint'),
      tone: 'text-emerald-700',
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <div key={card.key} className="card p-4">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {card.label}
          </dt>
          <dd
            className={`mt-1 text-2xl font-semibold tabular-nums ${card.tone ?? 'text-slate-900'}`}
            data-testid={`participant-count-${card.key}`}
          >
            {card.value}
          </dd>
          {card.hint && <p className="mt-1 text-xs text-slate-500">{card.hint}</p>}
        </div>
      ))}
    </dl>
  );
}
