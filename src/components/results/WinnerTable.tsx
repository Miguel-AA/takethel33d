import { useTranslation } from '../../i18n/I18nProvider';
import { formatPublicWinnerName } from '@shared/resultLifecycle';
import type { AdminResultAssignment } from '@shared/types';

/**
 * Who won what, as an administrator sees it.
 *
 * FULL NAMES AND EMAIL ADDRESSES, because this is the surface a prize is
 * actually handed over from and there is no way to do that from "Maria D.".
 * What is absent is everything that explains a VERDICT rather than a result:
 * no date of birth, no age, no eligibility reason, no answers. Those belong to
 * the participants screen, behind their own audit trail.
 *
 * The public column shows what the world WILL see, computed with the same
 * function that writes the snapshot — so an operator can check the abbreviation
 * before it becomes permanent, and there is no second implementation to drift.
 */
export function WinnerTable({
  assignments,
  showPublicPreview,
}: {
  assignments: AdminResultAssignment[];
  /** Shown before publishing; redundant afterwards, when the record exists. */
  showPublicPreview: boolean;
}) {
  const { t } = useTranslation();

  if (assignments.length === 0) {
    return <p className="card p-5 text-sm text-slate-600">{t('results.winners.empty')}</p>;
  }

  // Which prizes were awarded more than once, so the unit number is shown only
  // where it distinguishes something.
  const multiUnit = new Set(
    assignments
      .map((assignment) => `${assignment.prize.nameSnapshot}`)
      .filter((name, index, all) => all.indexOf(name) !== index),
  );

  return (
    <section className="card overflow-hidden" aria-labelledby="results-winners-heading">
      <h2
        id="results-winners-heading"
        className="border-b border-slate-200 p-5 text-base font-semibold text-slate-900"
      >
        {t('results.winners.title', { count: String(assignments.length) })}
      </h2>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('results.winners.order')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('results.winners.prize')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('results.winners.winner')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('results.winners.email')}
              </th>
              {showPublicPreview && (
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('results.winners.publicName')}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {assignments.map((assignment) => (
              <tr
                key={`${assignment.drawOrder}`}
                data-testid={`result-row-${assignment.drawOrder}`}
              >
                <td className="px-4 py-3 tabular-nums text-slate-500">
                  {/* 1-based for a reader; `drawOrder` is 0-based on the wire
                      because it indexes the shuffled list. */}
                  {assignment.drawOrder + 1}
                </td>
                <td className="px-4 py-3">
                  <span className="font-medium text-slate-900">
                    {assignment.prize.nameSnapshot}
                  </span>
                  {multiUnit.has(assignment.prize.nameSnapshot) && (
                    <span className="ml-2 text-xs text-slate-500">
                      {t('results.winners.unit', {
                        index: String(assignment.prize.unitIndex),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-900">
                  {assignment.winner.firstName} {assignment.winner.lastName}
                </td>
                <td className="px-4 py-3 text-slate-600">{assignment.winner.email}</td>
                {showPublicPreview && (
                  <td
                    className="px-4 py-3 text-slate-600"
                    data-testid={`result-public-${assignment.drawOrder}`}
                  >
                    {formatPublicWinnerName(assignment.winner) ?? '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
