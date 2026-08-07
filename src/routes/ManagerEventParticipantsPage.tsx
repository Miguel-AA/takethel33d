import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { EventEntryDetail } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { useEventEntries, useEventEntry } from '../hooks/useEventEntries';
import { api, ApiError } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { formatDateTime } from '../lib/format';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EntryAnswerValue } from '../components/EntryAnswerValue';
import { EligibilityBadge, EligibilityReason } from '../components/EligibilityBadge';

const PAGE_SIZE = 25;

/**
 * Who has taken part in one event.
 *
 * Read-only. There is no create form, no editing and no export here: this phase
 * builds the domain, and an administrative screen that could alter what
 * somebody submitted needs its own record of who altered it, which does not
 * exist yet.
 *
 * The TABLE deliberately shows no date of birth and no phone number. They are
 * in the detail, behind a click, because a screen an operator leaves open on a
 * shared desk should not put everyone's date of birth on a wall.
 */
export function ManagerEventParticipantsPage() {
  const { t, locale } = useTranslation();
  const { eventId = '' } = useParams();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const list = useEventEntries(eventId, {
    page,
    pageSize: PAGE_SIZE,
    search: search || undefined,
  });

  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            {t('entries.title')}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{t('entries.subtitle')}</p>
        </div>
        <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit shrink-0 text-xs">
          {t('entries.action.backToEvent')}
        </Link>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="entry-search">
          {t('entries.search.label')}
        </label>
        <input
          id="entry-search"
          className="input h-11 max-w-xs rounded-lg"
          placeholder={t('entries.search.placeholder')}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        {list.isFetching && <Spinner />}
        <p className="text-sm text-slate-500">{t('entries.count', { total: String(total) })}</p>
      </div>

      {list.isError && <ErrorBanner message={t('common.error')} />}

      {list.isPending ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          <Spinner /> <span className="ml-2">{t('common.loading')}</span>
        </div>
      ) : total === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">{t('entries.empty')}</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="border-b border-slate-900/10 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.name')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.email')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.submitted')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.version')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.age')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.status')}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t('entries.column.reason')}
                  </th>
                  <th scope="col" className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-900/10">
                {list.data?.items.map((item) => (
                  <tr key={item.entryId}>
                    {/* Every cell is a value somebody typed: rendered as text. */}
                    <td className="break-words px-4 py-3 font-medium text-slate-900">
                      {item.firstName} {item.lastName}
                    </td>
                    <td className="break-all px-4 py-3 text-slate-700">{item.email}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {formatDateTime(item.submittedAt, locale)}
                    </td>
                    <td className="px-4 py-3 text-slate-500">v{item.formVersionNumber}</td>
                    {/* Age AT SUBMISSION. The date of birth stays out of the
                        table on purpose; the age is what explains the verdict. */}
                    <td className="px-4 py-3 tabular-nums text-slate-700">
                      {item.calculatedAge === null ? '—' : item.calculatedAge}
                    </td>
                    <td className="px-4 py-3">
                      <EligibilityBadge status={item.status} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <EligibilityReason code={item.eligibilityReason} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() => setOpenEntryId(item.entryId)}
                      >
                        {t('entries.action.view')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
        <EntryDetailDialog
          eventId={eventId}
          entryId={openEntryId}
          onClose={() => setOpenEntryId(null)}
        />
      )}
    </div>
  );
}

function EntryDetailDialog({
  eventId,
  entryId,
  onClose,
}: {
  eventId: string;
  entryId: string;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const detail = useEventEntry(eventId, entryId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('entries.detail.title')}
      onClick={onClose}
    >
      <div
        className="glass-panel-strong max-h-[85vh] w-full max-w-2xl overflow-y-auto p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-900">{t('entries.detail.title')}</h3>
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>
            {t('entries.action.close')}
          </button>
        </div>

        {detail.isPending ? (
          <p className="mt-6 text-center text-sm text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </p>
        ) : detail.isError || !detail.data ? (
          <div className="mt-4">
            <ErrorBanner
              message={
                detail.error instanceof ApiError && detail.error.status === 404
                  ? t('entries.error.notFound')
                  : t('common.error')
              }
            />
          </div>
        ) : (
          <EntryDetailBody eventId={eventId} detail={detail.data} locale={locale} />
        )}
      </div>
    </div>
  );
}

function EntryDetailBody({
  eventId,
  detail,
  locale,
}: {
  eventId: string;
  detail: EventEntryDetail;
  locale: string;
}) {
  const { t } = useTranslation();

  /**
   * The version the entry was filled in with.
   *
   * Fetched separately, and only here, so option LABELS can be shown instead of
   * their stored values. A published version never changes, so this is cached
   * indefinitely — and the answer rows do not have to carry a second copy of a
   * label that cannot drift.
   */
  const version = useQuery({
    queryKey: queryKeys.formVersion(eventId, detail.formVersion.id),
    queryFn: () => api.getFormVersion(eventId, detail.formVersion.id),
    staleTime: Infinity,
    retry: false,
  });

  return (
    <div className="mt-4 space-y-5">
      <dl className="divide-y divide-slate-900/10 text-sm">
        <DetailRow
          label={t('entries.field.name')}
          value={`${detail.participant.firstName} ${detail.participant.lastName}`}
        />
        <DetailRow label={t('entries.field.email')} value={detail.participant.email} />
        <DetailRow label={t('entries.field.phone')} value={detail.participant.phone ?? '—'} />
        {/* Kept out of the table on purpose; shown here, where it was asked for. */}
        <DetailRow
          label={t('entries.field.dateOfBirth')}
          value={detail.participant.dateOfBirth ?? '—'}
        />
        <DetailRow
          label={t('entries.field.submitted')}
          value={formatDateTime(detail.entry.submittedAt, locale)}
        />
        <DetailRow
          label={t('entries.field.version')}
          value={`v${detail.formVersion.versionNumber}`}
        />
      </dl>

      <dl className="divide-y divide-slate-900/10 text-sm">
        <div className="grid grid-cols-3 gap-2 py-2">
          <dt className="text-slate-500">{t('entries.field.status')}</dt>
          <dd className="col-span-2">
            <EligibilityBadge status={detail.entry.status} />
          </dd>
        </div>
        {/* Every label says AT SUBMISSION. A decision belongs to the moment it
            was taken: somebody who has had a birthday since is not retroactively
            eligible, and raising the age limit does not retroactively exclude
            anybody. */}
        <DetailRow
          label={t('entries.field.ageAtSubmission')}
          value={detail.entry.calculatedAge === null ? '—' : String(detail.entry.calculatedAge)}
        />
        <DetailRow
          label={t('entries.field.ageEligible')}
          value={
            detail.entry.ageEligible === null
              ? t('entries.ageRule.none')
              : detail.entry.ageEligible
                ? t('common.yes')
                : t('common.no')
          }
        />
        <div className="grid grid-cols-3 gap-2 py-2">
          <dt className="text-slate-500">{t('entries.field.reason')}</dt>
          <dd className="col-span-2">
            <EligibilityReason code={detail.entry.eligibilityReason} />
          </dd>
        </div>
      </dl>

      <section>
        <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('entries.detail.answers')}
        </h4>
        {detail.answers.length === 0 ? (
          <p className="text-sm text-slate-500">{t('entries.detail.noAnswers')}</p>
        ) : (
          <dl className="divide-y divide-slate-900/10 text-sm">
            {detail.answers.map((answer) => (
              <div key={answer.id} className="grid grid-cols-3 gap-2 py-2">
                {/* The label as it read when this was answered, not as it reads now. */}
                <dt className="break-words text-slate-500">{answer.questionLabel}</dt>
                <dd className="col-span-2">
                  <EntryAnswerValue answer={answer} steps={version.data?.version.steps} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words font-medium text-slate-900">{value}</dd>
    </div>
  );
}
