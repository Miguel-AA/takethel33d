import { useEffect, useRef, useState } from 'react';
import { useForm, type Path, type UseFormRegisterReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { registerSchema, type RegisterInput } from '@shared/schemas';
import { EDUCATION_LEVELS, HOUSING_STATUSES } from '@shared/types';
import { useTranslation } from '../i18n/I18nProvider';
import { useRegister } from '../hooks/useRegister';
import { lookupCityByZip } from '../lib/zipLookup';
import { ErrorBanner } from './ErrorBanner';
import { Spinner } from './Spinner';
import { ApiError } from '../lib/api';

// Field groups per slide. Each step validates only its own fields before
// advancing, so the user is never shown the whole form at once.
const STEP_FIELDS: Array<Array<Path<RegisterInput>>> = [
  ['firstName', 'lastName', 'email', 'phone'],
  ['highestLevelOfEducation', 'age'],
  ['zip', 'city'],
  ['housingStatus', 'ownsVehicle', 'isBusinessOwner'],
  [], // review step
];
const TOTAL_STEPS = STEP_FIELDS.length;

// Maps a yes/no radio to a real boolean, but keeps an UNSELECTED group as
// `undefined` so the schema's required check fires (instead of silently
// defaulting to `false`).
function toTriStateBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

export function RegisterForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mutation = useRegister();
  const [step, setStep] = useState(0);

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    mode: 'onTouched',
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      zip: '',
      city: '',
    },
  });

  // Auto-populate City from a valid ZIP. Updates when the ZIP changes, but never
  // overwrites a city the user typed by hand, and never blocks the form.
  const zip = watch('zip');
  const autoCityRef = useRef('');
  useEffect(() => {
    if (!zip || !/^\d{5}$/.test(zip.trim())) return;
    let cancelled = false;
    void lookupCityByZip(zip).then((city) => {
      if (cancelled || !city) return;
      const current = (getValues('city') ?? '').trim();
      // Fill when empty, or replace a value we previously auto-filled.
      if (current === '' || current === autoCityRef.current) {
        autoCityRef.current = city;
        setValue('city', city, { shouldValidate: false, shouldDirty: true });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [zip, getValues, setValue]);

  async function next() {
    const valid = await trigger(STEP_FIELDS[step]);
    if (valid) setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1));
  }

  function back() {
    setStep((s) => Math.max(0, s - 1));
  }

  async function onSubmit(values: RegisterInput) {
    try {
      const res = await mutation.mutateAsync(values);
      navigate('/confirmacion', {
        state: {
          participantNumber: res.participantNumber,
          attendee: { ...values, createdAt: res.createdAt },
        },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'EMAIL_EXISTS') {
          setError('email', { message: t('register.error.email_exists') });
          setStep(0);
        } else if (err.code === 'VALIDATION_ERROR' && err.fields) {
          for (const [key, message] of Object.entries(err.fields)) {
            setError(key as Path<RegisterInput>, { message });
          }
        }
      }
    }
  }

  const apiError =
    mutation.error instanceof ApiError
      ? mutation.error.code === 'EMAIL_EXISTS'
        ? null
        : mutation.error.code === 'VALIDATION_ERROR'
          ? t('register.error.validation')
          : t('register.error.generic')
      : mutation.isError
        ? t('register.error.generic')
        : null;

  const isLast = step === TOTAL_STEPS - 1;

  return (
    <form className="space-y-6" onSubmit={handleSubmit(onSubmit)} noValidate>
      <StepIndicator step={step} total={TOTAL_STEPS} title={t(`register.step.${step + 1}.title`)} />

      {apiError && <ErrorBanner message={apiError} />}

      {/* STEP 1 — contact info */}
      {step === 0 && (
        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label={t('register.field.firstName')} error={fieldError(t, errors.firstName?.message)} htmlFor="firstName">
            <input id="firstName" autoComplete="given-name" className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.firstName')} {...register('firstName')} />
          </Field>
          <Field label={t('register.field.lastName')} error={fieldError(t, errors.lastName?.message)} htmlFor="lastName">
            <input id="lastName" autoComplete="family-name" className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.lastName')} {...register('lastName')} />
          </Field>
          <Field label={t('register.field.email')} error={fieldError(t, errors.email?.message)} htmlFor="email">
            <input id="email" type="email" autoComplete="email" className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.email')} {...register('email')} />
          </Field>
          <Field label={t('register.field.phone')} error={fieldError(t, errors.phone?.message)} htmlFor="phone">
            <input id="phone" inputMode="tel" autoComplete="tel" className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.phone')} {...register('phone')} />
          </Field>
        </div>
      )}

      {/* STEP 2 — about you */}
      {step === 1 && (
        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label={t('register.field.highestLevelOfEducation')} error={fieldError(t, errors.highestLevelOfEducation?.message)} htmlFor="education">
            <select id="education" className="input h-11 rounded-lg" defaultValue="" {...register('highestLevelOfEducation')}>
              <option value="" disabled>{t('education.default')}</option>
              {EDUCATION_LEVELS.map((level) => (
                <option key={level} value={level}>{t(`education.${level}`)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('register.field.age')} error={fieldError(t, errors.age?.message)} htmlFor="age">
            <input id="age" type="number" inputMode="numeric" min={16} max={120} className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.age')} {...register('age')} />
          </Field>
        </div>
      )}

      {/* STEP 3 — location */}
      {step === 2 && (
        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label={t('register.field.zip')} error={fieldError(t, errors.zip?.message)} htmlFor="zip">
            <input id="zip" inputMode="numeric" autoComplete="postal-code" className="input h-11 rounded-lg"
              placeholder={t('register.placeholder.zip')} {...register('zip')} />
          </Field>
          <Field label={t('register.field.city')} error={fieldError(t, errors.city?.message)} htmlFor="city">
            {/* Read-only: City is filled automatically from the ZIP, not typed. */}
            <input
              id="city"
              readOnly
              autoComplete="address-level2"
              className="input h-11 cursor-not-allowed rounded-lg bg-slate-100 text-slate-600"
              placeholder={t('register.placeholder.city')}
              {...register('city')}
            />
          </Field>
          <p className="text-xs text-slate-500 sm:col-span-2">{t('register.city.hint')}</p>
        </div>
      )}

      {/* STEP 4 — quick questions */}
      {step === 3 && (
        <div className="space-y-5">
          <RadioGroup
            legend={t('register.field.housingStatus')}
            error={fieldError(t, errors.housingStatus?.message)}
            options={HOUSING_STATUSES.map((h) => ({ value: h, label: t(`housing.${h}`) }))}
            reg={register('housingStatus')}
          />
          <RadioGroup
            legend={t('register.field.ownsVehicle')}
            error={fieldError(t, errors.ownsVehicle?.message)}
            options={[
              { value: 'true', label: t('common.yes') },
              { value: 'false', label: t('common.no') },
            ]}
            reg={register('ownsVehicle', { setValueAs: toTriStateBool })}
          />
          <RadioGroup
            legend={t('register.field.isBusinessOwner')}
            error={fieldError(t, errors.isBusinessOwner?.message)}
            options={[
              { value: 'true', label: t('common.yes') },
              { value: 'false', label: t('common.no') },
            ]}
            reg={register('isBusinessOwner', { setValueAs: toTriStateBool })}
          />
        </div>
      )}

      {/* STEP 5 — review */}
      {step === 4 && <ReviewStep values={getValues()} onEdit={setStep} />}

      <div className="flex flex-col gap-3 pt-1 sm:flex-row-reverse sm:items-center">
        {isLast ? (
          <button type="submit" className="btn-primary w-full py-3 text-base sm:w-auto sm:flex-1"
            disabled={isSubmitting || mutation.isPending}>
            {mutation.isPending || isSubmitting ? (
              <><Spinner /> {t('register.submitting')}</>
            ) : (
              <><CheckCircleIcon /> {t('register.submit')}</>
            )}
          </button>
        ) : (
          <button type="button" className="btn-primary w-full py-3 text-base sm:w-auto sm:flex-1" onClick={next}>
            {t('register.step.next')} <ArrowRightIcon />
          </button>
        )}
        {step > 0 && (
          <button type="button" className="btn-secondary w-full py-3 text-base sm:w-auto" onClick={back}
            disabled={mutation.isPending}>
            {t('register.step.back')}
          </button>
        )}
      </div>

      <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-500">
        <LockMiniIcon /> {t('register.privacy')}
      </p>
    </form>
  );
}

// Maps known zod issue codes to friendly, localized messages; otherwise shows
// the raw message (or a generic "required" for empty fields).
function fieldError(
  t: (key: string) => string,
  message?: string,
): string | undefined {
  if (!message) return undefined;
  if (message === 'invalid_phone') return t('register.error.phone');
  if (message === 'invalid_zip') return t('register.error.zip');
  if (/required/i.test(message)) return t('register.error.required');
  return message;
}

function StepIndicator({ step, total, title }: { step: number; total: number; title: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          {t('register.step.label', { current: step + 1, total })}
        </span>
        <span className="text-sm font-semibold text-slate-900">{title}</span>
      </div>
      <div className="mt-2 flex gap-1.5" aria-hidden="true">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={
              'h-1.5 flex-1 rounded-full transition ' +
              (i <= step ? 'bg-brand-500' : 'bg-slate-900/10')
            }
          />
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Renders a RHF-registered radio group. The register() ref is attached to each
// radio so RHF can track and reset the selection.
const RadioGroup = ({
  legend,
  options,
  error,
  reg,
}: {
  legend: string;
  options: Array<{ value: string; label: string }>;
  error?: string;
  reg: UseFormRegisterReturn;
}) => {
  return (
    <fieldset>
      <legend className="label">{legend}</legend>
      <div className="mt-1 grid grid-cols-2 gap-3">
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-brand-400 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-500/10 has-[:checked]:text-brand-800"
          >
            <input
              type="radio"
              value={opt.value}
              name={reg.name}
              onChange={reg.onChange}
              onBlur={reg.onBlur}
              ref={reg.ref}
              className="h-4 w-4 accent-brand-600"
            />
            {opt.label}
          </label>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </fieldset>
  );
};

function ReviewStep({
  values,
  onEdit,
}: {
  values: RegisterInput;
  onEdit: (step: number) => void;
}) {
  const { t } = useTranslation();
  const yesNo = (v: unknown) => (v === true ? t('common.yes') : v === false ? t('common.no') : '—');
  const rows: Array<{ label: string; value: string; step: number }> = [
    { label: t('register.field.firstName'), value: values.firstName || '—', step: 0 },
    { label: t('register.field.lastName'), value: values.lastName || '—', step: 0 },
    { label: t('register.field.email'), value: values.email || '—', step: 0 },
    { label: t('register.field.phone'), value: values.phone || '—', step: 0 },
    {
      label: t('register.field.highestLevelOfEducation'),
      value: values.highestLevelOfEducation ? t(`education.${values.highestLevelOfEducation}`) : '—',
      step: 1,
    },
    { label: t('register.field.age'), value: values.age ? String(values.age) : '—', step: 1 },
    { label: t('register.field.zip'), value: values.zip || '—', step: 2 },
    { label: t('register.field.city'), value: values.city || '—', step: 2 },
    {
      label: t('register.field.housingStatus'),
      value: values.housingStatus ? t(`housing.${values.housingStatus}`) : '—',
      step: 3,
    },
    { label: t('register.field.ownsVehicle'), value: yesNo(values.ownsVehicle), step: 3 },
    { label: t('register.field.isBusinessOwner'), value: yesNo(values.isBusinessOwner), step: 3 },
  ];
  return (
    <div>
      <h3 className="text-base font-semibold text-slate-900">{t('register.review.title')}</h3>
      <dl className="mt-3 divide-y divide-slate-900/10 rounded-lg border border-slate-900/10 bg-white/40">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <dt className="text-slate-500">{r.label}</dt>
            <dd className="flex items-center gap-2 text-right font-medium text-slate-900">
              <span className="break-words">{r.value}</span>
              <button
                type="button"
                className="text-xs font-semibold text-brand-700 underline-offset-2 hover:underline"
                onClick={() => onEdit(r.step)}
              >
                {t('register.review.edit')}
              </button>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function LockMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}
