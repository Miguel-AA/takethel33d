import type { EligibilityReasonCode, EventEntryStatus } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * Colours for what was decided.
 *
 * `SUBMITTED` is grey rather than green: an entry recorded before eligibility
 * existed was never judged, and showing it as though it passed would be a
 * claim nobody made. Those rows are history and are deliberately not
 * recomputed — a decision belongs to the moment it was taken.
 */
const TONE: Record<EventEntryStatus, string> = {
  ELIGIBLE: 'bg-emerald-500/10 text-emerald-700',
  INELIGIBLE: 'bg-amber-500/10 text-amber-800',
  DISQUALIFIED: 'bg-red-500/10 text-red-700',
  SUBMITTED: 'bg-slate-900/5 text-slate-600',
};

export function EligibilityBadge({ status }: { status: EventEntryStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}
      // The colour carries meaning, so the meaning is also in the text.
    >
      {t(`entries.status.${status}`)}
    </span>
  );
}

/**
 * Why a participation was decided the way it was.
 *
 * Rendered from the CODE through i18n, never by printing the code: an operator
 * explaining an exclusion to the person it affected should not have to
 * translate `AGE_REQUIREMENT_NOT_MET` in their head. An unrecognised code falls
 * back to the code itself, because showing something true and ugly beats
 * showing nothing.
 */
export function EligibilityReason({ code }: { code: EligibilityReasonCode | null }) {
  const { t } = useTranslation();
  if (code === null) return <span className="text-slate-400">—</span>;

  const key = `entries.reason.${code}`;
  const label = t(key);
  return <span className="text-slate-700">{label === key ? code : label}</span>;
}
