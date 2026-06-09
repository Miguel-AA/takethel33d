import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/I18nProvider';
import { useAttendees } from '../hooks/useAttendees';
import { formatDateTime, formatParticipantNumber } from '../lib/format';
import { api } from '../lib/api';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';
import { AttendeeDetailModal } from './AttendeeDetailModal';
import type { Attendee } from '@shared/types';

const PAGE_SIZE = 25;

export function AttendeeTable() {
  const { t, locale } = useTranslation();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Attendee | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const { data, isLoading, isError, isPlaceholderData } = useAttendees({
    search,
    page,
    pageSize: PAGE_SIZE,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  async function exportCsv() {
    setExporting(true);
    setExportError(false);
    try {
      const first = await api.listAttendees({ search, page: 1, pageSize: 200 });
      const rows = [...first.items];
      const totalPagesForExport = Math.ceil(first.total / first.pageSize);
      for (let nextPage = 2; nextPage <= totalPagesForExport; nextPage++) {
        const next = await api.listAttendees({
          search,
          page: nextPage,
          pageSize: first.pageSize,
        });
        rows.push(...next.items);
      }
      downloadCsv(rows, locale, t);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-slate-900/10 p-4 lg:flex-row lg:items-center lg:justify-between">
        <input
          type="search"
          className="input lg:max-w-sm"
          placeholder={t('dashboard.search.placeholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          {isPlaceholderData && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Spinner /> {t('common.loading')}
            </div>
          )}
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={exportCsv}
            disabled={exporting || !data || data.total === 0}
          >
            {exporting ? (
              <>
                <Spinner /> {t('dashboard.exporting')}
              </>
            ) : (
              <>
                <DownloadIcon /> {t('dashboard.exportCsv')}
              </>
            )}
          </button>
        </div>
      </div>

      {(isError || exportError) && (
        <div className="p-4">
          <ErrorBanner
            message={
              exportError ? t('dashboard.exportError') : t('common.error')
            }
          />
        </div>
      )}

      {isLoading ? (
        <div className="p-6 text-center text-slate-500">
          <Spinner /> <span className="ml-2">{t('common.loading')}</span>
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="p-6 text-center text-sm text-slate-500">
          {t('dashboard.table.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/5 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left">{t('dashboard.table.number')}</th>
                <th className="px-4 py-2 text-left">{t('dashboard.table.nombre')}</th>
                <th className="px-4 py-2 text-left">{t('dashboard.table.email')}</th>
                <th className="px-4 py-2 text-left">{t('dashboard.table.telefono')}</th>
                <th className="px-4 py-2 text-left">{t('dashboard.table.insuranceType')}</th>
                <th className="px-4 py-2 text-left">{t('dashboard.table.createdAt')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-900/10">
              {data?.items.map((a) => (
                <tr
                  key={a.id}
                  className="cursor-pointer transition hover:bg-slate-900/5"
                  onClick={() => setSelected(a)}
                >
                  <td className="px-4 py-2 font-mono text-brand-700">
                    {formatParticipantNumber(a.participantNumber)}
                  </td>
                  <td className="px-4 py-2 font-medium text-slate-900">{a.nombre}</td>
                  <td className="px-4 py-2 text-slate-600">{a.email}</td>
                  <td className="px-4 py-2 text-slate-600">{a.telefono}</td>
                  <td className="px-4 py-2 text-slate-600">
                    {t(`insurance.${a.insuranceType}`)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {formatDateTime(a.createdAt, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-between border-t border-slate-900/10 px-4 py-3 text-xs text-slate-600">
          <span>
            {t('dashboard.pagination.info', {
              page,
              totalPages,
              total: data.total,
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t('dashboard.pagination.prev')}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('dashboard.pagination.next')}
            </button>
          </div>
        </div>
      )}

      {selected && (
        <AttendeeDetailModal
          attendee={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function downloadCsv(
  rows: Attendee[],
  locale: string,
  t: (key: string) => string,
) {
  const headers = [
    '#',
    t('register.field.nombre'),
    t('register.field.email'),
    t('register.field.telefono'),
    t('register.field.insuranceType'),
    t('dashboard.table.createdAt'),
  ];
  const body = rows.map((a) => [
    formatParticipantNumber(a.participantNumber),
    a.nombre,
    a.email,
    a.telefono,
    t(`insurance.${a.insuranceType}`),
    formatDateTime(a.createdAt, locale),
  ]);
  const csv = [headers, ...body].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `take-the-l33d-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string) {
  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
