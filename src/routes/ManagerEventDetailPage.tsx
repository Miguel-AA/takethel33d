import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EventTransitionAction } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import {
  useDeleteEvent,
  useDuplicateEvent,
  useEvent,
  useEventTransition,
} from '../hooks/useEvents';
import { useAuditLogs } from '../hooks/useAuditLogs';
import { formatInEventZone } from '../lib/eventDateTime';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { EventStatusBadge } from '../components/EventStatusBadge';
import { formatDateTime } from '../lib/format';

/** Actions whose effect cannot be undone get an explicit confirmation. */
const DESTRUCTIVE: ReadonlySet<EventTransitionAction> = new Set(['cancel', 'archive']);

export function ManagerEventDetailPage() {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const { eventId = '' } = useParams();

  const detail = useEvent(eventId);
  const transition = useEventTransition(eventId);
  const duplicate = useDuplicateEvent(eventId);
  const remove = useDeleteEvent();

  const [actionError, setActionError] = useState<string | null>(null);
  const [duplicateOpen, setDuplicateOpen] = useState(false);

  const audit = useAuditLogs({ eventId, pageSize: 25 });

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'EVENT_REVISION_CONFLICT':
          return t('event.error.revisionConflict');
        case 'EVENT_INVALID_TRANSITION':
          return t('event.error.invalidTransition');
        case 'EVENT_REQUIRED_FIELDS_MISSING':
          return t('event.error.missingFields', { fields: err.fields?.missing ?? '' });
        case 'EVENT_NOT_READY':
          // The state allows the action; the configured dates no longer do.
          return t('event.error.notReady', { fields: err.fields?.stale ?? '' });
        case 'EVENT_CANNOT_BE_DELETED':
          return t('event.error.cannotDelete');
        case 'EVENT_INVALID_DATE_RANGE':
          return t('event.error.dateRange');
        default:
          return t('common.error');
      }
    }
    return t('common.error');
  }

  async function runAction(action: EventTransitionAction) {
    const event = detail.data?.event;
    if (!event) return;

    if (DESTRUCTIVE.has(action) && !window.confirm(t(`event.confirm.${action}`))) {
      return;
    }

    setActionError(null);
    try {
      await transition.mutateAsync({ action, expectedRevision: event.revision });
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  async function runDelete() {
    const event = detail.data?.event;
    if (!event) return;
    if (!window.confirm(t('event.confirm.delete'))) return;

    setActionError(null);
    try {
      await remove.mutateAsync({ id: event.id, expectedRevision: event.revision });
      navigate('/manager/events', { replace: true });
    } catch (err) {
      setActionError(describeError(err));
    }
  }

  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-14 text-center text-slate-500 sm:px-6">
        <Spinner /> <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-14 sm:px-6">
        <ErrorBanner message={notFound ? t('event.error.notFound') : t('common.error')} />
        <Link to="/manager/events" className="btn-secondary w-fit text-xs">
          {t('events.action.backToList')}
        </Link>
      </div>
    );
  }

  const { event, availableActions, blockedActions, canDelete, actors } = detail.data;
  const busy = transition.isPending || remove.isPending || duplicate.isPending;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-bold tracking-tight text-slate-900">
              {event.name}
            </h1>
            <EventStatusBadge status={event.status} />
          </div>
          <p className="mt-1 font-mono text-sm text-slate-500">/{event.slug}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link to="/manager/events" className="btn-secondary w-fit text-xs">
            {t('events.action.backToList')}
          </Link>
          <Link
            to={`/manager/events/${event.id}/prizes`}
            className="btn-secondary w-fit text-xs"
          >
            {t('prizes.nav')}
          </Link>
          <Link
            to={`/manager/events/${event.id}/form`}
            className="btn-secondary w-fit text-xs"
          >
            {t('form.nav')}
          </Link>
          <Link
            to={`/manager/events/${event.id}/participants`}
            className="btn-secondary w-fit text-xs"
          >
            {t('entries.nav')}
          </Link>
          <Link to={`/manager/events/${event.id}/edit`} className="btn-primary w-fit text-xs">
            {t('event.action.edit')}
          </Link>
        </div>
      </header>

      {actionError && <ErrorBanner message={actionError} />}

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('event.section.actions')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {availableActions.map((action) => (
            <button
              key={action}
              type="button"
              className={DESTRUCTIVE.has(action) ? 'btn-secondary text-xs' : 'btn-primary text-xs'}
              disabled={busy}
              onClick={() => void runAction(action)}
            >
              {t(`event.action.${action}`)}
            </button>
          ))}

          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={busy}
            onClick={() => setDuplicateOpen(true)}
          >
            {t('event.action.duplicate')}
          </button>

          {canDelete && (
            <button
              type="button"
              className="btn-ghost text-xs text-red-700"
              disabled={busy}
              onClick={() => void runDelete()}
            >
              {t('event.action.delete')}
            </button>
          )}

          {busy && <Spinner />}
        </div>

        {blockedActions.length > 0 && (
          <div className="mt-3 space-y-1">
            {blockedActions.map(({ action, missingFields }) => (
              <p key={action} className="text-xs text-amber-700">
                {t('event.blocked', {
                  action: t(`event.action.${action}`),
                  fields: missingFields.join(', '),
                })}
              </p>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
            {t('event.section.dates')}
          </h2>
          <dl className="divide-y divide-slate-900/10 text-sm">
            <Row label={t('event.field.timezone')} value={event.timezone} />
            <Row
              label={t('event.field.registrationOpensAt')}
              value={formatInEventZone(event.registrationOpensAt, event.timezone, locale)}
            />
            <Row
              label={t('event.field.registrationClosesAt')}
              value={formatInEventZone(event.registrationClosesAt, event.timezone, locale)}
            />
            <Row
              label={t('event.field.startsAt')}
              value={formatInEventZone(event.startsAt, event.timezone, locale)}
            />
            <Row
              label={t('event.field.endsAt')}
              value={formatInEventZone(event.endsAt, event.timezone, locale)}
            />
          </dl>
        </section>

        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
            {t('event.section.rules')}
          </h2>
          <dl className="divide-y divide-slate-900/10 text-sm">
            <Row
              label={t('event.field.minimumAge')}
              value={event.minimumAge === null ? '—' : String(event.minimumAge)}
            />
            <Row
              label={t('event.field.maxEntries')}
              value={String(event.maxEntriesPerIdentity)}
            />
            <Row label={t('event.field.location')} value={event.locationName ?? '—'} />
            <Row label={t('event.field.revision')} value={String(event.revision)} />
            <Row
              label={t('event.field.createdBy')}
              value={actors.createdBy.displayName ?? actors.createdBy.id}
            />
            <Row
              label={t('event.field.updatedBy')}
              value={actors.updatedBy.displayName ?? actors.updatedBy.id}
            />
            <Row
              label={t('event.field.updatedAt')}
              value={formatDateTime(event.updatedAt, locale)}
            />
          </dl>
        </section>
      </div>

      {(event.description || event.confirmationMessage || event.ineligibleMessage) && (
        <section className="card p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
            {t('event.section.messages')}
          </h2>
          {/* All of these are untrusted operator input, rendered as text. */}
          <div className="space-y-3 text-sm text-slate-700">
            {event.description && <p className="whitespace-pre-wrap">{event.description}</p>}
            {event.confirmationMessage && (
              <p className="whitespace-pre-wrap">{event.confirmationMessage}</p>
            )}
            {event.ineligibleMessage && (
              <p className="whitespace-pre-wrap">{event.ineligibleMessage}</p>
            )}
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-900/10 p-4 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('event.section.history')}
        </h2>
        {audit.isPending ? (
          <div className="p-4 text-sm text-slate-500">
            <Spinner /> <span className="ml-2">{t('common.loading')}</span>
          </div>
        ) : audit.data && audit.data.items.length > 0 ? (
          <ul className="divide-y divide-slate-900/10 text-sm">
            {audit.data.items.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                <span className="font-medium text-slate-900">{entry.action}</span>
                <span className="text-slate-500">
                  {entry.actorDisplayName ?? t('audit.actor.system')} ·{' '}
                  {formatDateTime(entry.createdAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-slate-500">{t('audit.empty')}</p>
        )}
      </section>

      {duplicateOpen && (
        <DuplicateDialog
          defaultName={`${event.name} (copy)`}
          pending={duplicate.isPending}
          onClose={() => setDuplicateOpen(false)}
          onConfirm={async (name, slug) => {
            setActionError(null);
            try {
              const created = await duplicate.mutateAsync({
                name: name || undefined,
                slug: slug || undefined,
              });
              setDuplicateOpen(false);
              navigate(`/manager/events/${created.id}`);
            } catch (err) {
              setActionError(
                err instanceof ApiError && err.code === 'EVENT_SLUG_EXISTS'
                  ? t('event.error.slugExists')
                  : describeError(err),
              );
            }
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-words font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function DuplicateDialog({
  defaultName,
  pending,
  onClose,
  onConfirm,
}: {
  defaultName: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (name: string, slug: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState('');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('event.action.duplicate')}
      onClick={onClose}
    >
      <div
        className="glass-panel-strong w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">
          {t('event.duplicate.title')}
        </h3>
        <p className="mt-1 text-sm text-slate-600">{t('event.duplicate.help')}</p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="duplicate-name">
              {t('event.field.name')}
            </label>
            <input
              id="duplicate-name"
              className="input h-11 rounded-lg"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="duplicate-slug">
              {t('event.field.slug')}
            </label>
            <input
              id="duplicate-slug"
              className="input h-11 rounded-lg font-mono"
              placeholder={t('event.duplicate.slugPlaceholder')}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            className="btn-primary text-xs"
            disabled={pending}
            onClick={() => onConfirm(name.trim(), slug.trim())}
          >
            {pending ? (
              <>
                <Spinner /> {t('event.action.duplicating')}
              </>
            ) : (
              t('event.action.duplicate')
            )}
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            {t('event.action.cancelDialog')}
          </button>
        </div>
      </div>
    </div>
  );
}
