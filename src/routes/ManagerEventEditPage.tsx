import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { useEvent, useUpdateEvent } from '../hooks/useEvents';
import { EventForm, type EventFormSubmit } from '../components/EventForm';
import { ApiError } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';

export function ManagerEventEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { eventId = '' } = useParams();

  const detail = useEvent(eventId);
  const update = useUpdateEvent(eventId);

  async function onSubmit(values: EventFormSubmit) {
    const event = detail.data?.event;
    if (!event) return;

    try {
      await update.mutateAsync({
        ...values,
        // The revision read when the form loaded. If anything changed since,
        // the server refuses rather than letting this overwrite it.
        expectedRevision: event.revision,
      });
      navigate(`/manager/events/${eventId}`);
    } catch {
      /* rendered below */
    }
  }

  const error = update.error;
  const isConflict = error instanceof ApiError && error.code === 'EVENT_REVISION_CONFLICT';

  const errorMessage = (() => {
    if (!update.isError) return null;
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'EVENT_REVISION_CONFLICT':
          return t('event.error.revisionConflict');
        case 'EVENT_CANNOT_BE_EDITED':
          return t('event.error.cannotEdit', { fields: error.fields?.locked ?? '' });
        case 'EVENT_SLUG_EXISTS':
          return t('event.error.slugExists');
        case 'EVENT_SLUG_RESERVED':
          return t('event.error.slugReserved');
        case 'EVENT_INVALID_DATE_RANGE':
          return t('event.error.dateRange');
        case 'VALIDATION_ERROR':
          return t('event.error.validation');
        default:
          return t('common.error');
      }
    }
    return t('common.error');
  })();

  if (detail.isPending) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 text-center text-slate-500 sm:px-6">
        <Spinner /> <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <ErrorBanner message={notFound ? t('event.error.notFound') : t('common.error')} />
      </div>
    );
  }

  const { event, editableFields } = detail.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            <span className="accent-underline">{t('events.edit.title')}</span>
          </h1>
          <p className="mt-2 break-words text-slate-600">{event.name}</p>
        </div>
        <Link to={`/manager/events/${eventId}`} className="btn-secondary w-fit text-xs">
          {t('events.action.backToDetail')}
        </Link>
      </header>

      {isConflict && (
        <div className="card p-4">
          <p className="text-sm text-slate-700">{t('event.error.revisionConflictHelp')}</p>
          <button
            type="button"
            className="btn-secondary mt-3 text-xs"
            onClick={() => void detail.refetch()}
          >
            {t('event.action.reload')}
          </button>
        </div>
      )}

      <div className="card-lg p-6">
        <EventForm
          event={event}
          editableFields={editableFields}
          submitting={update.isPending}
          errorMessage={errorMessage}
          fieldErrors={error instanceof ApiError ? error.fields : undefined}
          onSubmit={onSubmit}
          onCancel={() => navigate(`/manager/events/${eventId}`)}
        />
      </div>
    </div>
  );
}
