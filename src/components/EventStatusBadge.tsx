import type { EventStatus } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * Colour carries meaning here, so the label is always present too — status is
 * never communicated by colour alone.
 */
const TONE: Record<EventStatus, string> = {
  DRAFT: 'bg-slate-900/10 text-slate-700',
  SCHEDULED: 'bg-brand-500/15 text-brand-700',
  OPEN: 'bg-emerald-500/15 text-emerald-700',
  CLOSED: 'bg-amber-500/15 text-amber-700',
  DRAW_READY: 'bg-indigo-500/15 text-indigo-700',
  DRAW_COMPLETED: 'bg-indigo-500/25 text-indigo-800',
  CANCELLED: 'bg-red-500/15 text-red-700',
  ARCHIVED: 'bg-slate-900/15 text-slate-600',
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[status]}`}
    >
      {t(`event.status.${status}`)}
    </span>
  );
}
