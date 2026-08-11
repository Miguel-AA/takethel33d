import { useTranslation } from '../../i18n/I18nProvider';
import type { DrawAssignment } from '@shared/types';

/**
 * Who won what.
 *
 * ORDERED BY THE DRAW ORDER, not by prize and not by name. The sequence is part
 * of what happened, and re-sorting it alphabetically would quietly discard the
 * one piece of information that says which assignment was made first.
 *
 * The prize name comes from the assignment's SNAPSHOT, taken when it was won.
 * Renaming a prize afterwards changes the prize; it does not change what
 * somebody was told they had won.
 *
 * A table, with real headers, because this is tabular data and a grid of `div`s
 * announces nothing useful to a screen reader.
 */
export function DrawAssignmentsList({ assignments }: { assignments: DrawAssignment[] }) {
  const { t } = useTranslation();

  // Which prizes were awarded more than once. Used to decide whether the unit
  // number is worth showing at all.
  const multiUnit = new Set(
    assignments
      .map((assignment) => assignment.prize.id)
      .filter((id, index, all) => all.indexOf(id) !== index),
  );

  if (assignments.length === 0) {
    return (
      <p className="card p-5 text-sm text-slate-600">{t('draw.assignments.empty')}</p>
    );
  }

  return (
    <section className="card overflow-hidden" aria-labelledby="draw-assignments-heading">
      <h3
        id="draw-assignments-heading"
        className="border-b border-slate-200 p-5 text-base font-semibold text-slate-900"
      >
        {t('draw.assignments.title', { count: String(assignments.length) })}
      </h3>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('draw.assignments.order')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('draw.assignments.prize')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('draw.assignments.winner')}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                {t('draw.assignments.email')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {assignments.map((assignment) => (
              <tr key={assignment.id} data-testid={`draw-assignment-${assignment.drawOrder}`}>
                <td className="px-4 py-3 tabular-nums text-slate-500">
                  {/* 1-based for a reader; `drawOrder` is 0-based on the wire
                      because it indexes the shuffled list. */}
                  {assignment.drawOrder + 1}
                </td>
                <td className="px-4 py-3">
                  <span className="font-medium text-slate-900">{assignment.prize.name}</span>
                  {/* Only for multi-unit prizes: "Vape #1" when there is exactly
                      one vape is noise that reads like a serial number. */}
                  {multiUnit.has(assignment.prize.id) && (
                    <span className="ml-2 text-xs text-slate-500">
                      {t('draw.assignments.unit', {
                        index: String(assignment.prize.unitIndex),
                      })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-900">
                  {assignment.winner.firstName} {assignment.winner.lastName}
                </td>
                <td className="px-4 py-3 text-slate-600">{assignment.winner.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
