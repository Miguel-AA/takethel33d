import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  PRIZE_STATUSES,
  allowedPrizeActions,
  canDeletePrize,
  editableFieldsFor,
  eventAllows,
} from '@shared/prizeLifecycle';
import { PRIZES_PER_EVENT_MAX } from '@shared/limits';
import type { EventPrizeSummary, PrizeTransitionAction, ReorderEventPrizeItem } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import {
  useCreateEventPrize,
  useDeleteEventPrize,
  useEventPrize,
  useEventPrizes,
  usePrizeTransition,
  useReorderEventPrizes,
  useUpdateEventPrize,
} from '../hooks/useEventPrizes';
import { ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { PrizeForm, type PrizeFormSubmit } from '../components/PrizeForm';

/**
 * One page holds every prize an event can have.
 *
 * Reordering submits the COMPLETE live ordering — a partial list is refused by
 * the server, since it cannot infer where the omitted prizes should go. With a
 * smaller page the move buttons would render on page one and then fail to save
 * for any event past that size, so the page is sized to the domain's own
 * ceiling instead. Pagination stays wired up as a backstop.
 */
const PAGE_SIZE = PRIZES_PER_EVENT_MAX;

export function ManagerEventPrizesPage() {
  const { t, locale } = useTranslation();
  const { eventId = '' } = useParams();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [archived, setArchived] = useState<'active' | 'archived' | 'all'>('active');
  const [page, setPage] = useState(1);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Local draft order; only written when the operator saves it. */
  const [draftOrder, setDraftOrder] = useState<EventPrizeSummary[] | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => setPage(1), [status, archived]);

  const list = useEventPrizes(eventId, {
    page,
    pageSize: PAGE_SIZE,
    search: search || undefined,
    status: status || undefined,
    archived,
  });

  const detail = useEventPrize(eventId, editingId);
  const create = useCreateEventPrize(eventId);
  const update = useUpdateEventPrize(eventId);
  const transition = usePrizeTransition(eventId);
  const remove = useDeleteEventPrize(eventId);
  const reorder = useReorderEventPrizes(eventId);

  const eventStatus = list.data?.eventStatus;
  const summary = list.data?.summary;
  const canReorder = eventStatus ? eventAllows(eventStatus, 'reorder') : false;
  const canCreate = eventStatus ? eventAllows(eventStatus, 'create') : false;

  // The draft order is only meaningful for the unfiltered, live list, and only
  // when the whole of it is on screen: the server refuses a partial ordering,
  // so offering a control that could not save would be a lie.
  const reorderable =
    canReorder &&
    archived === 'active' &&
    !search &&
    !status &&
    page === 1 &&
    (list.data?.totalPages ?? 0) <= 1;

  const rows = useMemo(
    () => draftOrder ?? list.data?.items ?? [],
    [draftOrder, list.data],
  );

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'PRIZE_REVISION_CONFLICT':
          return t('prize.error.revisionConflict');
        case 'PRIZE_REORDER_CONFLICT':
          return t('prize.error.reorderConflict');
        case 'PRIZE_EVENT_NOT_EDITABLE':
          return t('prize.error.eventFrozen', { status: err.fields?.eventStatus ?? '' });
        case 'PRIZE_CANNOT_BE_EDITED':
          return t('prize.error.cannotEdit', { fields: err.fields?.locked ?? '' });
        case 'PRIZE_CANNOT_BE_DELETED':
          return t('prize.error.cannotDelete');
        case 'PRIZE_LIMIT_REACHED':
          return t('prize.error.limitReached', { limit: err.fields?.limit ?? '' });
        case 'PRIZE_INVALID_STATUS':
          return t('prize.error.invalidStatus');
        case 'PRIZE_ALREADY_ARCHIVED':
          return t('prize.error.alreadyArchived');
        case 'VALIDATION_ERROR':
          return t('prize.error.validation');
        default:
          return t('common.error');
      }
    }
    return t('common.error');
  }

  async function runAction(
    prize: EventPrizeSummary,
    action: PrizeTransitionAction,
  ): Promise<void> {
    if (action === 'archive' && !window.confirm(t('prize.confirm.archive'))) return;
    setActionError(null);
    try {
      await transition.mutateAsync({
        prizeId: prize.id,
        action,
        expectedRevision: prize.revision,
      });
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function runDelete(prize: EventPrizeSummary): Promise<void> {
    if (!window.confirm(t('prize.confirm.delete'))) return;
    setActionError(null);
    try {
      await remove.mutateAsync({ prizeId: prize.id, expectedRevision: prize.revision });
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  function move(index: number, delta: number): void {
    const current = [...rows];
    const target = index + delta;
    if (target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]];
    setDraftOrder(current);
  }

  async function saveOrder(): Promise<void> {
    if (!draftOrder) return;
    setActionError(null);
    const items: ReorderEventPrizeItem[] = draftOrder.map((prize, index) => ({
      prizeId: prize.id,
      expectedRevision: prize.revision,
      sortOrder: index,
    }));
    try {
      await reorder.mutateAsync(items);
      setDraftOrder(null);
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  const busy =
    transition.isPending || remove.isPending || reorder.isPending || create.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            <span className="accent-underline">{t('prizes.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('prizes.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit text-xs">
            {t('events.action.backToDetail')}
          </Link>
          {canCreate && (
            <button
              type="button"
              className="btn-primary w-fit text-xs"
              onClick={() => setCreating(true)}
            >
              {t('prizes.action.add')}
            </button>
          )}
        </div>
      </header>

      {eventStatus && !eventAllows(eventStatus, 'editEditorial') && (
        <div className="card p-4 text-sm text-amber-700">
          {t('prizes.frozen', { status: t(`event.status.${eventStatus}`) })}
        </div>
      )}

      {actionError && <ErrorBanner message={actionError} />}

      {summary && (
        <section className="card grid gap-3 p-4 sm:grid-cols-4">
          <Stat label={t('prizes.summary.active')} value={summary.activePrizes} />
          <Stat label={t('prizes.summary.inactive')} value={summary.inactivePrizes} />
          <Stat label={t('prizes.summary.archived')} value={summary.archivedPrizes} />
          <Stat label={t('prizes.summary.units')} value={summary.totalActiveUnits} />
          <p className="text-xs text-slate-500 sm:col-span-4">{t('prizes.summary.hint')}</p>
        </section>
      )}

      <div className="card overflow-hidden">
        <div className="grid gap-3 border-b border-slate-900/10 p-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="prizes-search">
              {t('events.filter.search')}
            </label>
            <input
              id="prizes-search"
              type="search"
              className="input h-11 rounded-lg"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="prizes-status">
              {t('events.filter.status')}
            </label>
            <select
              id="prizes-status"
              className="input h-11 rounded-lg"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t('audit.filter.any')}</option>
              {PRIZE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`prize.status.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="prizes-archived">
              {t('events.filter.archived')}
            </label>
            <select
              id="prizes-archived"
              className="input h-11 rounded-lg"
              value={archived}
              onChange={(e) => setArchived(e.target.value as 'active' | 'archived' | 'all')}
            >
              <option value="active">{t('events.filter.archived.active')}</option>
              <option value="archived">{t('events.filter.archived.only')}</option>
              <option value="all">{t('events.filter.archived.all')}</option>
            </select>
          </div>
        </div>

        {list.isError && (
          <div className="p-4">
            <ErrorBanner
              message={
                list.error instanceof ApiError && list.error.code === 'INVALID_QUERY'
                  ? t('events.error.filters')
                  : t('common.error')
              }
            />
          </div>
        )}

        {list.isPending ? (
          <div className="p-6 text-center text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">{t('prizes.empty')}</div>
        ) : (
          <ul className="divide-y divide-slate-900/10">
            {rows.map((prize, index) => {
              const actions = eventStatus
                ? allowedPrizeActions(eventStatus, prize.status)
                : [];
              const deletable = eventStatus
                ? canDeletePrize(eventStatus, prize.status)
                : false;
              const editable = eventStatus
                ? editableFieldsFor(eventStatus, prize.status).length > 0
                : false;

              return (
                <li key={prize.id} className="flex flex-wrap items-center gap-3 p-4">
                  <PrizeThumb url={prize.imageUrl} />

                  <div className="min-w-0 flex-1">
                    {/* Untrusted operator input, rendered as text. */}
                    <div className="break-words font-medium text-slate-900">{prize.name}</div>
                    <div className="text-xs text-slate-500">
                      {t('prize.field.quantity')}: {prize.quantity} · {t('prize.field.order')}:{' '}
                      {prize.sortOrder} · r{prize.revision} ·{' '}
                      {formatDateTime(prize.updatedAt, locale)}
                    </div>
                  </div>

                  <span className="whitespace-nowrap rounded-full bg-slate-900/10 px-2.5 py-1 text-xs font-semibold text-slate-700">
                    {t(`prize.status.${prize.status}`)}
                  </span>

                  <div className="flex flex-wrap gap-1">
                    {reorderable && (
                      <>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          disabled={busy || index === 0}
                          aria-label={t('prize.action.moveUp')}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          disabled={busy || index === rows.length - 1}
                          aria-label={t('prize.action.moveDown')}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                      </>
                    )}
                    {editable && (
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy}
                        onClick={() => setEditingId(prize.id)}
                      >
                        {t('prize.action.edit')}
                      </button>
                    )}
                    {actions.map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy}
                        onClick={() => void runAction(prize, action)}
                      >
                        {t(`prize.action.${action}`)}
                      </button>
                    ))}
                    {deletable && (
                      <button
                        type="button"
                        className="btn-ghost text-xs text-red-700"
                        disabled={busy}
                        onClick={() => void runDelete(prize)}
                      >
                        {t('prize.action.delete')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {draftOrder && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-900/10 bg-brand-500/5 p-4">
            <span className="text-sm text-slate-700">{t('prizes.reorder.pending')}</span>
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={reorder.isPending}
              onClick={() => void saveOrder()}
            >
              {reorder.isPending ? (
                <>
                  <Spinner /> {t('prizes.reorder.saving')}
                </>
              ) : (
                t('prizes.reorder.save')
              )}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={reorder.isPending}
              onClick={() => setDraftOrder(null)}
            >
              {t('prizes.reorder.discard')}
            </button>
          </div>
        )}

        {list.data && list.data.total > 0 && !draftOrder && (
          <div className="flex items-center justify-between border-t border-slate-900/10 px-4 py-3 text-xs text-slate-600">
            <span>
              {t('dashboard.pagination.info', {
                page,
                totalPages: list.data.totalPages,
                total: list.data.total,
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
                disabled={page >= list.data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('dashboard.pagination.next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {creating && (
        <PrizeDialog title={t('prizes.action.add')} onClose={() => setCreating(false)}>
          <PrizeForm
            submitting={create.isPending}
            errorMessage={create.isError ? describeError(create.error) : null}
            fieldErrors={create.error instanceof ApiError ? create.error.fields : undefined}
            onCancel={() => setCreating(false)}
            onSubmit={async (values: PrizeFormSubmit) => {
              try {
                await create.mutateAsync(values);
                setCreating(false);
              } catch {
                /* the dialog stays open with the values intact */
              }
            }}
          />
        </PrizeDialog>
      )}

      {editingId && detail.data && (
        <PrizeDialog title={t('prize.action.edit')} onClose={() => setEditingId(null)}>
          <PrizeForm
            prize={detail.data.prize}
            editableFields={detail.data.editableFields}
            submitting={update.isPending}
            errorMessage={update.isError ? describeError(update.error) : null}
            fieldErrors={update.error instanceof ApiError ? update.error.fields : undefined}
            onCancel={() => setEditingId(null)}
            onSubmit={async (values) => {
              try {
                await update.mutateAsync({
                  prizeId: detail.data.prize.id,
                  input: { ...values, expectedRevision: detail.data.prize.revision },
                });
                setEditingId(null);
              } catch {
                /* kept open so the edit is not lost */
              }
            }}
          />
        </PrizeDialog>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

function PrizeThumb({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div
        className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-slate-900/5 text-slate-400"
        aria-hidden="true"
      >
        ★
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="h-12 w-12 shrink-0 rounded-lg border border-slate-900/10 object-cover"
      onError={() => setBroken(true)}
    />
  );
}

function PrizeDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes it, and focus moves into the dialog on open and back to
  // whatever opened it on close — a modal that leaves focus behind is
  // unusable by keyboard and invisible to a screen reader.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    )?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        ref={panel}
        className="glass-panel-strong w-full max-w-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-base font-semibold text-slate-900">{title}</h3>
        {children}
      </div>
    </div>
  );
}
