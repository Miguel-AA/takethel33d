import { useEffect } from 'react';
import { useTranslation } from '../i18n/I18nProvider';
import { formatDateTime, formatParticipantNumber } from '../lib/format';
import type { Attendee } from '@shared/types';

export function AttendeeDetailModal({
  attendee,
  onClose,
}: {
  attendee: Attendee;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Array<[string, string]> = [
    [t('register.field.nombre'), attendee.nombre],
    [t('register.field.email'), attendee.email],
    [t('register.field.telefono'), attendee.telefono],
    [t('register.field.insuranceType'), t(`insurance.${attendee.insuranceType}`)],
    [t('dashboard.table.createdAt'), formatDateTime(attendee.createdAt, locale)],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="glass-panel-strong w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-900/10 p-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">
              {t('detail.title')}
            </div>
            <div className="font-mono text-2xl font-semibold text-brand-700">
              #{formatParticipantNumber(attendee.participantNumber)}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onClose}
          >
            {t('detail.close')}
          </button>
        </div>
        <dl className="divide-y divide-slate-900/10 px-4">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-3 gap-2 py-2 text-sm">
              <dt className="text-slate-500">{label}</dt>
              <dd className="col-span-2 font-medium text-slate-900">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="p-4" />
      </div>
    </div>
  );
}
