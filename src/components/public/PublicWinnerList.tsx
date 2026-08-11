import { useTranslation } from '../../i18n/I18nProvider';
import type { PublicWinnerDTO } from '@shared/types';

/**
 * The winners, as the world sees them.
 *
 * A DESCRIPTION LIST, not a table. Each entry is one fact — this person won
 * this thing — and `<dt>`/`<dd>` is exactly that pairing, so a screen reader
 * announces "Maria D., Vape" as a unit rather than reading a grid position by
 * position. A table would imply columns that can be compared, and there is
 * nothing here to compare.
 *
 * WHAT IS NOT SHOWN: an email, a surname, an identifier of any kind. The names
 * arrive already abbreviated — the server wrote them that way at publication —
 * so there is nothing here that could be truncated incorrectly, and nothing to
 * un-abbreviate.
 *
 * Everything renders as TEXT. React escapes by default and no
 * `dangerouslySetInnerHTML` exists on this path, so a prize named
 * `<script>alert(1)</script>` is displayed as those characters.
 */
export function PublicWinnerList({ winners }: { winners: PublicWinnerDTO[] }) {
  const { t } = useTranslation();

  if (winners.length === 0) {
    return <p className="text-center text-sm text-slate-600">{t('publicResults.empty')}</p>;
  }

  // Which prizes were awarded more than once, so a unit number appears only
  // where it distinguishes something rather than reading like a serial number.
  const repeated = new Set(
    winners
      .map((winner) => winner.prizeName)
      .filter((name, index, all) => all.indexOf(name) !== index),
  );

  return (
    <section aria-labelledby="public-winners-heading">
      <h2
        id="public-winners-heading"
        className="text-center text-lg font-semibold text-slate-900"
      >
        {t('publicResults.winners', { count: String(winners.length) })}
      </h2>

      <dl className="mt-4 space-y-3">
        {winners.map((winner, index) => (
          <div
            key={`${winner.displayName}-${winner.prizeName}-${index}`}
            className="glass-panel flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:justify-between"
            data-testid={`public-winner-${index}`}
          >
            <dt className="text-base font-semibold text-slate-900">{winner.displayName}</dt>
            <dd className="text-sm text-slate-700">
              {winner.prizeName}
              {repeated.has(winner.prizeName) && (
                <span className="ml-2 text-xs text-slate-500">
                  {t('publicResults.unit', { index: String(winner.prizeUnitIndex) })}
                </span>
              )}
              {winner.prizeDescription && (
                <span className="mt-1 block text-xs text-slate-500">
                  {winner.prizeDescription}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
