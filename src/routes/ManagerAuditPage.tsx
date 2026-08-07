import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '@shared/types';
import type { AuditLog } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { useAuditLog, useAuditLogs } from '../hooks/useAuditLogs';
import { formatDateTime } from '../lib/format';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';

const PAGE_SIZE = 25;

interface Filters {
  action: string;
  entityType: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { action: '', entityType: '', from: '', to: '' };

export function ManagerAuditPage() {
  const { t, locale } = useTranslation();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Changing a filter must return to the first page, otherwise the view can
  // land on a page that no longer exists for the narrowed result set.
  useEffect(() => {
    setPage(1);
  }, [filters.action, filters.entityType, filters.from, filters.to]);

  const query = useAuditLogs({
    page,
    pageSize: PAGE_SIZE,
    action: filters.action || undefined,
    entityType: filters.entityType || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  });

  const totalPages = query.data?.totalPages ?? 1;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <span className="accent-underline">{t('audit.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('audit.subtitle')}</p>
        </div>
        <Link to="/manager" className="btn-secondary w-fit text-xs">
          {t('audit.backToDashboard')}
        </Link>
      </header>

      <div className="card overflow-hidden">
        <div className="grid gap-3 border-b border-slate-900/10 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="audit-action">
              {t('audit.filter.action')}
            </label>
            <select
              id="audit-action"
              className="input h-11 rounded-lg"
              value={filters.action}
              onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
            >
              <option value="">{t('audit.filter.any')}</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="audit-entity">
              {t('audit.filter.entityType')}
            </label>
            <select
              id="audit-entity"
              className="input h-11 rounded-lg"
              value={filters.entityType}
              onChange={(e) => setFilters((f) => ({ ...f, entityType: e.target.value }))}
            >
              <option value="">{t('audit.filter.any')}</option>
              {AUDIT_ENTITY_TYPES.map((entity) => (
                <option key={entity} value={entity}>
                  {entity}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="audit-from">
              {t('audit.filter.from')}
            </label>
            <input
              id="audit-from"
              type="date"
              className="input h-11 rounded-lg"
              value={filters.from}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            />
          </div>

          <div>
            <label className="label" htmlFor="audit-to">
              {t('audit.filter.to')}
            </label>
            <input
              id="audit-to"
              type="date"
              className="input h-11 rounded-lg"
              value={filters.to}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            />
          </div>
        </div>

        {query.isError && (
          <div className="p-4">
            <ErrorBanner
              message={
                query.error instanceof ApiError && query.error.code === 'INVALID_QUERY'
                  ? t('audit.error.filters')
                  : t('common.error')
              }
            />
          </div>
        )}

        {query.isPending ? (
          <div className="p-6 text-center text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </div>
        ) : query.data && query.data.items.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">{t('audit.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/5 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">{t('audit.column.when')}</th>
                  <th className="px-4 py-2 text-left">{t('audit.column.action')}</th>
                  <th className="px-4 py-2 text-left">{t('audit.column.actor')}</th>
                  <th className="hidden px-4 py-2 text-left md:table-cell">
                    {t('audit.column.entity')}
                  </th>
                  <th className="hidden px-4 py-2 text-left lg:table-cell">
                    {t('audit.column.requestId')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/10">
                {query.data?.items.map((entry) => (
                  <tr
                    key={entry.id}
                    className="cursor-pointer transition hover:bg-slate-900/5"
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-slate-600">
                      {formatDateTime(entry.createdAt, locale)}
                    </td>
                    <td className="px-4 py-2 font-medium text-slate-900">{entry.action}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {entry.actorDisplayName ?? t('audit.actor.system')}
                    </td>
                    <td className="hidden px-4 py-2 text-slate-600 md:table-cell">
                      {entry.entityType}
                    </td>
                    <td className="hidden px-4 py-2 font-mono text-xs text-slate-500 lg:table-cell">
                      {entry.requestId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {query.data && query.data.total > 0 && (
          <div className="flex items-center justify-between border-t border-slate-900/10 px-4 py-3 text-xs text-slate-600">
            <span>
              {t('dashboard.pagination.info', {
                page,
                totalPages,
                total: query.data.total,
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
      </div>

      {selectedId && (
        <AuditDetailModal id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function AuditDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const detail = useAuditLog(id);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entry = detail.data;
  const notFound = detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('audit.detail.title')}
      onClick={onClose}
    >
      <div
        className="glass-panel-strong max-h-[85vh] w-full max-w-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-900/10 p-4">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {t('audit.detail.title')}
          </div>
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>
            {t('detail.close')}
          </button>
        </div>

        <div className="p-4">
          {detail.isPending ? (
            <div className="flex items-center gap-2 text-slate-500">
              <Spinner /> {t('common.loading')}
            </div>
          ) : notFound ? (
            <ErrorBanner message={t('audit.detail.notFound')} />
          ) : detail.isError || !entry ? (
            <ErrorBanner message={t('common.error')} />
          ) : (
            <AuditDetailBody entry={entry} locale={locale} t={t} />
          )}
        </div>
      </div>
    </div>
  );
}

function AuditDetailBody({
  entry,
  locale,
  t,
}: {
  entry: AuditLog;
  locale: string;
  t: (key: string) => string;
}) {
  const rows: Array<[string, string]> = [
    [t('audit.column.when'), formatDateTime(entry.createdAt, locale)],
    [t('audit.column.action'), entry.action],
    [t('audit.column.entity'), entry.entityType],
    [t('audit.detail.entityId'), entry.entityId ?? '—'],
    [t('audit.column.actor'), entry.actorDisplayName ?? t('audit.actor.system')],
    [t('audit.detail.actorEmail'), entry.actorEmail ?? '—'],
    [t('audit.column.requestId'), entry.requestId],
  ];

  return (
    <div className="space-y-4">
      <dl className="divide-y divide-slate-900/10">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-3 gap-2 py-2 text-sm">
            <dt className="text-slate-500">{label}</dt>
            <dd className="col-span-2 break-words font-medium text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      {/* Payloads are already redacted server-side; they are rendered as text,
          never as markup, so hostile metadata cannot inject anything. */}
      <JsonBlock label={t('audit.detail.metadata')} value={entry.metadata} />
      <JsonBlock label={t('audit.detail.previous')} value={entry.previousData} />
      <JsonBlock label={t('audit.detail.next')} value={entry.newData} />
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-900/5 p-3 text-xs text-slate-800">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
