import { useEffect, useMemo, useState } from 'react';
import { useForm, type Path } from 'react-hook-form';
import { useTranslation } from '../i18n/I18nProvider';
import { slugify } from '@shared/slug';
import type { Event, EventEditableField } from '@shared/types';
import {
  COMMON_TIMEZONES,
  isoToLocalInput,
  localInputToIso,
} from '../lib/eventDateTime';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';

/**
 * Form values are plain strings: `datetime-local` inputs speak wall-clock text,
 * and the conversion to a UTC instant happens on submit, in the EVENT's
 * timezone rather than the browser's.
 */
export interface EventFormValues {
  name: string;
  slug: string;
  description: string;
  bannerUrl: string;
  locationName: string;
  timezone: string;
  registrationOpensAt: string;
  registrationClosesAt: string;
  startsAt: string;
  endsAt: string;
  minimumAge: string;
  maxEntriesPerIdentity: string;
  confirmationTitle: string;
  confirmationMessage: string;
  ineligibleTitle: string;
  ineligibleMessage: string;
}

export interface EventFormSubmit {
  name: string;
  slug?: string;
  timezone: string;
  description: string | null;
  bannerUrl: string | null;
  locationName: string | null;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  minimumAge: number | null;
  maxEntriesPerIdentity: number;
  confirmationTitle: string | null;
  confirmationMessage: string | null;
  ineligibleTitle: string | null;
  ineligibleMessage: string | null;
}

const DEFAULTS: EventFormValues = {
  name: '',
  slug: '',
  description: '',
  bannerUrl: '',
  locationName: '',
  timezone: 'America/New_York',
  registrationOpensAt: '',
  registrationClosesAt: '',
  startsAt: '',
  endsAt: '',
  minimumAge: '',
  maxEntriesPerIdentity: '1',
  confirmationTitle: '',
  confirmationMessage: '',
  ineligibleTitle: '',
  ineligibleMessage: '',
};

function toValues(event: Event): EventFormValues {
  return {
    name: event.name,
    slug: event.slug,
    description: event.description ?? '',
    bannerUrl: event.bannerUrl ?? '',
    locationName: event.locationName ?? '',
    timezone: event.timezone,
    registrationOpensAt: isoToLocalInput(event.registrationOpensAt, event.timezone),
    registrationClosesAt: isoToLocalInput(event.registrationClosesAt, event.timezone),
    startsAt: isoToLocalInput(event.startsAt, event.timezone),
    endsAt: isoToLocalInput(event.endsAt, event.timezone),
    minimumAge: event.minimumAge === null ? '' : String(event.minimumAge),
    maxEntriesPerIdentity: String(event.maxEntriesPerIdentity),
    confirmationTitle: event.confirmationTitle ?? '',
    confirmationMessage: event.confirmationMessage ?? '',
    ineligibleTitle: event.ineligibleTitle ?? '',
    ineligibleMessage: event.ineligibleMessage ?? '',
  };
}

export function EventForm({
  event,
  editableFields,
  submitting,
  errorMessage,
  fieldErrors,
  onSubmit,
  onCancel,
}: {
  event?: Event;
  /** Fields the current state permits. Everything else renders read-only. */
  editableFields?: readonly string[];
  submitting: boolean;
  errorMessage?: string | null;
  fieldErrors?: Record<string, string>;
  onSubmit: (values: EventFormSubmit) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const isEdit = Boolean(event);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isDirty },
  } = useForm<EventFormValues>({
    mode: 'onTouched',
    defaultValues: event ? toValues(event) : DEFAULTS,
  });

  const timezone = watch('timezone');
  const name = watch('name');
  const [slugTouched, setSlugTouched] = useState(isEdit);

  // Server-side field errors are surfaced on the matching input.
  useEffect(() => {
    if (!fieldErrors) return;
    for (const [field, message] of Object.entries(fieldErrors)) {
      setError(field as Path<EventFormValues>, { message });
    }
  }, [fieldErrors, setError]);

  // While creating, the slug follows the name until the operator edits it.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    setValue('slug', slugify(name ?? ''), { shouldDirty: false });
  }, [name, slugTouched, isEdit, setValue]);

  // Warns before losing an in-progress edit on a real page unload.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const canEdit = useMemo(() => {
    if (!editableFields) return () => true;
    const allowed = new Set(editableFields);
    return (field: EventEditableField) => allowed.has(field);
  }, [editableFields]);

  function submit(values: EventFormValues) {
    const zone = values.timezone;
    const toIso = (raw: string) => (raw ? localInputToIso(raw, zone) : null);
    const orNull = (raw: string) => {
      const trimmed = raw.trim();
      return trimmed.length === 0 ? null : trimmed;
    };

    onSubmit({
      name: values.name.trim(),
      slug: values.slug.trim() === '' ? undefined : values.slug.trim(),
      timezone: zone,
      description: orNull(values.description),
      bannerUrl: orNull(values.bannerUrl),
      locationName: orNull(values.locationName),
      registrationOpensAt: toIso(values.registrationOpensAt),
      registrationClosesAt: toIso(values.registrationClosesAt),
      startsAt: toIso(values.startsAt),
      endsAt: toIso(values.endsAt),
      minimumAge: values.minimumAge === '' ? null : Number(values.minimumAge),
      maxEntriesPerIdentity: Number(values.maxEntriesPerIdentity || '1'),
      confirmationTitle: orNull(values.confirmationTitle),
      confirmationMessage: orNull(values.confirmationMessage),
      ineligibleTitle: orNull(values.ineligibleTitle),
      ineligibleMessage: orNull(values.ineligibleMessage),
    });
  }

  const field = (key: EventEditableField) => ({
    disabled: !canEdit(key),
    ...register(key as Path<EventFormValues>),
  });

  return (
    <form className="space-y-8" onSubmit={handleSubmit(submit)} noValidate>
      {errorMessage && <ErrorBanner message={errorMessage} />}

      <Section title={t('event.section.general')}>
        <Field label={t('event.field.name')} htmlFor="name" error={errors.name?.message}>
          <input
            id="name"
            className="input h-11 rounded-lg"
            aria-invalid={errors.name ? 'true' : undefined}
            {...field('name')}
            {...register('name', { required: t('event.error.nameRequired') })}
            disabled={!canEdit('name')}
          />
        </Field>

        <Field
          label={t('event.field.slug')}
          htmlFor="slug"
          error={errors.slug?.message}
          hint={canEdit('slug') ? t('event.hint.slug') : t('event.hint.slugLocked')}
        >
          <input
            id="slug"
            className="input h-11 rounded-lg font-mono"
            {...register('slug')}
            disabled={!canEdit('slug')}
            onChange={(e) => {
              setSlugTouched(true);
              void register('slug').onChange(e);
            }}
          />
        </Field>

        <Field
          label={t('event.field.description')}
          htmlFor="description"
          error={errors.description?.message}
        >
          <textarea id="description" rows={3} className="input rounded-lg" {...field('description')} />
        </Field>

        <Field label={t('event.field.location')} htmlFor="locationName">
          <input id="locationName" className="input h-11 rounded-lg" {...field('locationName')} />
        </Field>

        <Field
          label={t('event.field.bannerUrl')}
          htmlFor="bannerUrl"
          error={errors.bannerUrl?.message}
          hint={t('event.hint.bannerUrl')}
        >
          <input
            id="bannerUrl"
            type="url"
            inputMode="url"
            className="input h-11 rounded-lg"
            {...field('bannerUrl')}
          />
        </Field>
      </Section>

      <Section title={t('event.section.dates')}>
        <Field label={t('event.field.timezone')} htmlFor="timezone" hint={t('event.hint.timezone')}>
          <select id="timezone" className="input h-11 rounded-lg" {...field('timezone')}>
            {COMMON_TIMEZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>

        <p className="text-xs text-slate-500 sm:col-span-2">
          {t('event.hint.datesInZone', { timezone })}
        </p>

        <Field label={t('event.field.registrationOpensAt')} htmlFor="registrationOpensAt">
          <input
            id="registrationOpensAt"
            type="datetime-local"
            className="input h-11 rounded-lg"
            {...field('registrationOpensAt')}
          />
        </Field>
        <Field label={t('event.field.registrationClosesAt')} htmlFor="registrationClosesAt">
          <input
            id="registrationClosesAt"
            type="datetime-local"
            className="input h-11 rounded-lg"
            {...field('registrationClosesAt')}
          />
        </Field>
        <Field label={t('event.field.startsAt')} htmlFor="startsAt">
          <input
            id="startsAt"
            type="datetime-local"
            className="input h-11 rounded-lg"
            {...field('startsAt')}
          />
        </Field>
        <Field label={t('event.field.endsAt')} htmlFor="endsAt">
          <input
            id="endsAt"
            type="datetime-local"
            className="input h-11 rounded-lg"
            {...field('endsAt')}
          />
        </Field>
      </Section>

      <Section title={t('event.section.rules')}>
        <Field
          label={t('event.field.minimumAge')}
          htmlFor="minimumAge"
          error={errors.minimumAge?.message}
          hint={t('event.hint.minimumAge')}
        >
          <input
            id="minimumAge"
            type="number"
            min={0}
            max={130}
            className="input h-11 rounded-lg"
            {...field('minimumAge')}
          />
        </Field>
        <Field
          label={t('event.field.maxEntries')}
          htmlFor="maxEntriesPerIdentity"
          error={errors.maxEntriesPerIdentity?.message}
        >
          <input
            id="maxEntriesPerIdentity"
            type="number"
            min={1}
            max={1000}
            className="input h-11 rounded-lg"
            {...field('maxEntriesPerIdentity')}
          />
        </Field>
      </Section>

      <Section title={t('event.section.messages')}>
        <Field label={t('event.field.confirmationTitle')} htmlFor="confirmationTitle">
          <input id="confirmationTitle" className="input h-11 rounded-lg" {...field('confirmationTitle')} />
        </Field>
        <Field label={t('event.field.confirmationMessage')} htmlFor="confirmationMessage">
          <textarea
            id="confirmationMessage"
            rows={2}
            className="input rounded-lg"
            {...field('confirmationMessage')}
          />
        </Field>
        <Field label={t('event.field.ineligibleTitle')} htmlFor="ineligibleTitle">
          <input id="ineligibleTitle" className="input h-11 rounded-lg" {...field('ineligibleTitle')} />
        </Field>
        <Field label={t('event.field.ineligibleMessage')} htmlFor="ineligibleMessage">
          <textarea
            id="ineligibleMessage"
            rows={2}
            className="input rounded-lg"
            {...field('ineligibleMessage')}
          />
        </Field>
      </Section>

      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <button type="submit" className="btn-primary sm:w-auto" disabled={submitting}>
          {submitting ? (
            <>
              <Spinner /> {t('event.action.saving')}
            </>
          ) : isEdit ? (
            t('event.action.save')
          ) : (
            t('event.action.create')
          )}
        </button>
        {onCancel && (
          <button type="button" className="btn-secondary sm:w-auto" onClick={onCancel}>
            {t('event.action.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
        {title}
      </legend>
      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
