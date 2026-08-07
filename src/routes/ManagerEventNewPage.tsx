import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { useCreateEvent } from '../hooks/useEvents';
import { EventForm, type EventFormSubmit } from '../components/EventForm';
import { ApiError } from '../lib/api';

export function ManagerEventNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const create = useCreateEvent();

  async function onSubmit(values: EventFormSubmit) {
    try {
      const event = await create.mutateAsync(values);
      navigate(`/manager/events/${event.id}`, { replace: true });
    } catch {
      /* rendered below */
    }
  }

  const error = create.error;
  const errorMessage = (() => {
    if (!create.isError) return null;
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'EVENT_SLUG_EXISTS':
          return t('event.error.slugExists');
        case 'EVENT_SLUG_RESERVED':
          return t('event.error.slugReserved');
        case 'EVENT_INVALID_SLUG':
          return t('event.error.slugInvalid');
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

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            <span className="accent-underline">{t('events.new.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('events.new.subtitle')}</p>
        </div>
        <Link to="/manager/events" className="btn-secondary w-fit text-xs">
          {t('events.action.backToList')}
        </Link>
      </header>

      <div className="card-lg p-6">
        <EventForm
          submitting={create.isPending}
          errorMessage={errorMessage}
          fieldErrors={error instanceof ApiError ? error.fields : undefined}
          onSubmit={onSubmit}
          onCancel={() => navigate('/manager/events')}
        />
      </div>
    </div>
  );
}
