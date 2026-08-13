import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EVENT_STATUSES } from '@shared/eventLifecycle';
import { useTranslation } from '../i18n/I18nProvider';
import { useEvents } from '../hooks/useEvents';
import { formatInEventZone } from '../lib/eventDateTime';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EventStatusBadge } from '../components/EventStatusBadge';

const PAGE_SIZE = 25;

export function ManagerEventsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived' | 'all'>('active');
  const [sort, setSort] = useState<'createdAt' | 'updatedAt' | 'name' | 'startsAt'>(
    'createdAt',
  );
  const [page, setPage] = useState(1);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Narrowing a filter must return to page 1, or the view can land on a page
  // the filtered set no longer has.
  useEffect(() => {
    setPage(1);
  }, [status, archived, sort]);

  const query = useEvents({
    page,
    pageSize: PAGE_SIZE,
    search: search || undefined,
    status: status || undefined,
    archived,
    sort,
    direction: sort === 'name' ? 'asc' : 'desc',
  });

  const totalPages = query.data?.totalPages ?? 1;

  // "Active events, newest first" is the default view, not a filter. Anything
  // else means the operator narrowed the list themselves.
  const filtersActive = search !== '' || status !== '' || archived !== 'active';

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <span className="accent-underline">{t('events.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('events.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/manager" className="btn-secondary w-fit text-xs">
            {t('audit.backToDashboard')}
          </Link>
          <Link to="/manager/events/new" className="btn-primary w-fit text-xs">
            {t('events.action.new')}
          </Link>
        </div>
      </header>

      <div className="card overflow-hidden">
        <div className="grid gap-3 border-b border-slate-900/10 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="events-search">
              {t('events.filter.search')}
            </label>
            <input
              id="events-search"
              type="search"
              className="input h-11 rounded-lg"
              placeholder={t('events.filter.searchPlaceholder')}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="events-status">
              {t('events.filter.status')}
            </label>
            <select
              id="events-status"
              className="input h-11 rounded-lg"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t('audit.filter.any')}</option>
              {EVENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`event.status.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="events-archived">
              {t('events.filter.archived')}
            </label>
            <select
              id="events-archived"
              className="input h-11 rounded-lg"
              value={archived}
              onChange={(e) => setArchived(e.target.value as 'active' | 'archived' | 'all')}
            >
              <option value="active">{t('events.filter.archived.active')}</option>
              <option value="archived">{t('events.filter.archived.only')}</option>
              <option value="all">{t('events.filter.archived.all')}</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="events-sort">
              {t('events.filter.sort')}
            </label>
            <select
              id="events-sort"
              className="input h-11 rounded-lg"
              value={sort}
              onChange={(e) =>
                setSort(e.target.value as 'createdAt' | 'updatedAt' | 'name' | 'startsAt')
              }
            >
              <option value="createdAt">{t('events.sort.createdAt')}</option>
              <option value="updatedAt">{t('events.sort.updatedAt')}</option>
              <option value="name">{t('events.sort.name')}</option>
              <option value="startsAt">{t('events.sort.startsAt')}</option>
            </select>
          </div>
        </div>

        {query.isError && (
          <div className="p-4">
            <ErrorBanner
              message={
                query.error instanceof ApiError && query.error.code === 'INVALID_QUERY'
                  ? t('events.error.filters')
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
          /* Two different situations wear the same empty table, and telling an
             operator "nothing matches these filters" when they have never
             created an event is how a first run becomes a dead end. When no
             filter is narrowing anything, this is a fresh installation and the
             screen offers the action instead of an explanation. */
          filtersActive ? (
            <div className="p-6 text-center text-sm text-slate-500">{t('events.empty')}</div>
          ) : (
            <div className="p-8 text-center">
              <h2 className="text-lg font-semibold text-slate-900">
                {t('dashboard.events.empty.title')}
              </h2>
              <p className="mx-auto mt-2 max-w-xl text-sm text-slate-600">
                {t('dashboard.events.empty.body')}
              </p>
              <Link to="/manager/events/new" className="btn-primary mt-6 w-fit">
                {t('events.action.new')}
              </Link>
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-900/5 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">{t('events.column.name')}</th>
                  <th className="px-4 py-2 text-left">{t('events.column.status')}</th>
                  <th className="hidden px-4 py-2 text-left md:table-cell">
                    {t('events.column.registrationOpens')}
                  </th>
                  <th className="hidden px-4 py-2 text-left lg:table-cell">
                    {t('events.column.startsAt')}
                  </th>
                  <th className="hidden px-4 py-2 text-left lg:table-cell">
                    {t('events.column.updatedAt')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/10">
                {query.data?.items.map((event) => (
                  <tr
                    key={event.id}
                    className="cursor-pointer transition hover:bg-slate-900/5"
                    onClick={() => navigate(`/manager/events/${event.id}`)}
                  >
                    <td className="px-4 py-2">
                      {/* Rendered as text: an event name is untrusted input. */}
                      <div className="font-medium text-slate-900">{event.name}</div>
                      <div className="font-mono text-xs text-slate-500">{event.slug}</div>
                    </td>
                    <td className="px-4 py-2">
                      <EventStatusBadge status={event.status} />
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-slate-600 md:table-cell">
                      {formatInEventZone(event.registrationOpensAt, event.timezone)}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-slate-600 lg:table-cell">
                      {formatInEventZone(event.startsAt, event.timezone)}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-2 text-slate-500 lg:table-cell">
                      {formatInEventZone(event.updatedAt, event.timezone)}
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
    </div>
  );
}
