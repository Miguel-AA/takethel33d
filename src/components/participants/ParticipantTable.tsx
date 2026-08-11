import { useTranslation } from '../../i18n/I18nProvider';
import { formatDateTime } from '../../lib/format';
import { EligibilityBadge } from '../EligibilityBadge';
import type { AdminParticipantSummary } from '@shared/types';

/**
 * The participants table.
 *
 * TWO COLUMNS FOR WHAT LOOKS LIKE ONE THING, deliberately: "eligibility at
 * submission" is the historical verdict and "current status" is the present
 * disposition. Somebody who qualified and was later disqualified reads
 * "Qualified / Disqualified" across those two cells, which is the truth and is
 * not expressible in one column.
 *
 * NO DATE OF BIRTH AND NO PHONE NUMBER. A table is a screen an operator leaves
 * open on a shared desk; putting everyone's date of birth on a wall is not a
 * trade worth making for a column nobody scans. Both are in the detail panel,
 * behind a click that is audited.
 *
 * Every cell is a value somebody typed, rendered as text through JSX.
 */
export function ParticipantTable({
  items,
  locale,
  onOpen,
}: {
  items: AdminParticipantSummary[];
  locale: string;
  onOpen: (entryId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-left text-sm">
        <thead className="border-b border-slate-900/10 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.participant')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.email')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.eligibility')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.status')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.age')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.submitted')}
            </th>
            <th scope="col" className="px-4 py-3">
              {t('participants.column.version')}
            </th>
            <th scope="col" className="px-4 py-3">
              <span className="sr-only">{t('participants.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-900/10">
          {items.map((item) => (
            <tr key={item.entryId}>
              <td className="break-words px-4 py-3 font-medium text-slate-900">
                {item.firstName} {item.lastName}
              </td>
              <td className="break-all px-4 py-3 text-slate-700">{item.email}</td>
              <td className="px-4 py-3">
                <EligibilityAtSubmission overallEligible={item.overallEligible} />
              </td>
              <td className="px-4 py-3">
                <EligibilityBadge status={item.status} />
              </td>
              {/* The AGE, not the date of birth: a number that explains the
                  verdict rather than the personal data it was derived from. */}
              <td className="px-4 py-3 tabular-nums text-slate-700">
                {item.calculatedAge === null ? '—' : item.calculatedAge}
              </td>
              <td className="px-4 py-3 text-slate-500">
                {formatDateTime(item.submittedAt, locale)}
              </td>
              <td className="px-4 py-3 text-slate-500">v{item.formVersionNumber}</td>
              <td className="px-4 py-3 text-right">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => onOpen(item.entryId)}
                >
                  {t('participants.action.view')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The historical verdict, as words.
 *
 * NULL is "not judged" rather than "did not qualify": an entry recorded before
 * eligibility existed was never assessed, and showing it as a failure would be
 * a claim nobody made.
 */
function EligibilityAtSubmission({ overallEligible }: { overallEligible: boolean | null }) {
  const { t } = useTranslation();

  if (overallEligible === null) {
    return <span className="text-xs text-slate-500">{t('participants.eligibility.unjudged')}</span>;
  }
  return (
    <span
      className={`text-xs font-medium ${
        overallEligible ? 'text-emerald-700' : 'text-amber-800'
      }`}
    >
      {overallEligible
        ? t('participants.eligibility.yes')
        : t('participants.eligibility.no')}
    </span>
  );
}
