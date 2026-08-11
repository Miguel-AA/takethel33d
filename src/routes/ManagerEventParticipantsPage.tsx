import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n/I18nProvider';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import {
  useAdminParticipants,
  useAdminParticipantSummary,
} from '../hooks/useAdminParticipants';
import { ParticipantSummaryCards } from '../components/participants/ParticipantSummaryCards';
import {
  EMPTY_FILTERS,
  ParticipantToolbar,
  type ParticipantFilters,
} from '../components/participants/ParticipantToolbar';
import { ParticipantTable } from '../components/participants/ParticipantTable';
import { ParticipantDetailPanel } from '../components/participants/ParticipantDetailPanel';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Who has taken part in one event, and what has been decided about them.
 *
 * SEARCHING, FILTERING AND PAGING ALL HAPPEN ON THE SERVER. An event with ten
 * thousand participants must not send ten thousand rows so the browser can hide
 * most of them — and a search box that filtered a single downloaded page would
 * quietly lie about what it had found.
 *
 * This page is composition and URL-ish state; every piece of judgement lives
 * somewhere it can be tested without a router: the permissions in
 * `shared/participantAdministration`, the projection in the service, the
 * rendering in the components below.
 */
export function ManagerEventParticipantsPage() {
  const { t, locale } = useTranslation();
  const { eventId = '' } = useParams();

  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState<ParticipantFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  // Debounced so typing does not fire a query per keystroke. The committed
  // value lives in `filters.search`; `searchInput` is what the field shows.
  useEffect(() => {
    const handle = setTimeout(() => {
      setFilters((current) =>
        current.search === searchInput.trim()
          ? current
          : { ...current, search: searchInput.trim() },
      );
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const params = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: filters.search || undefined,
      eligibility: filters.eligibility,
      status: filters.status,
      formVersionId: filters.formVersionId ?? undefined,
    }),
    [filters, page],
  );

  const list = useAdminParticipants(eventId, params);
  const summary = useAdminParticipantSummary(eventId);

  // Only to populate the version filter. A published version never changes, so
  // this is cached for the session.
  const versions = useQuery({
    queryKey: queryKeys.formVersions(eventId),
    queryFn: () => api.listFormVersions(eventId),
    enabled: Boolean(eventId),
    staleTime: Infinity,
  });

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered =
    filters.search !== '' ||
    filters.eligibility !== 'ALL' ||
    filters.status !== 'ALL' ||
    filters.formVersionId !== null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {t('participants.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{t('participants.subtitle')}</p>
        </div>
        <Link
          to={`/manager/events/${eventId}`}
          className="btn-secondary w-fit shrink-0 text-xs"
        >
          {t('entries.action.backToEvent')}
        </Link>
      </header>

      {summary.data && <ParticipantSummaryCards summary={summary.data.summary} />}

      {summary.data && !summary.data.administrationAllowed && (
        <p className="card p-3 text-xs text-slate-600">{t('participants.notEditable')}</p>
      )}

      <ParticipantToolbar
        searchInput={searchInput}
        filters={filters}
        versions={versions.data?.items ?? []}
        busy={list.isFetching}
        onSearchInput={setSearchInput}
        onFilterChange={(next) => {
          setFilters((current) => ({ ...current, ...next }));
          setPage(1);
        }}
        onReset={() => {
          setSearchInput('');
          setFilters(EMPTY_FILTERS);
          setPage(1);
        }}
      />

      {list.isError && <ErrorBanner message={t('common.error')} />}

      {list.isPending ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          <Spinner /> <span className="ml-2">{t('common.loading')}</span>
        </div>
      ) : total === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          {/* "No results" and "no participants" are different facts, and telling
              an operator the event is empty when their filter is simply too
              narrow sends them looking for a bug. */}
          {filtered ? t('participants.noResults') : t('participants.empty')}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <ParticipantTable
            items={list.data?.items ?? []}
            locale={locale}
            onOpen={setOpenEntryId}
          />

          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t border-slate-900/10 px-4 py-3 text-sm">
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                {t('dashboard.pagination.prev')}
              </button>
              <span className="text-slate-500">
                {t('dashboard.pagination.info', {
                  page: String(page),
                  totalPages: String(totalPages),
                  total: String(total),
                })}
              </span>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                {t('dashboard.pagination.next')}
              </button>
            </div>
          )}
        </div>
      )}

      {openEntryId && (
        <ParticipantDetailPanel
          eventId={eventId}
          entryId={openEntryId}
          onClose={() => setOpenEntryId(null)}
        />
      )}
    </div>
  );
}
