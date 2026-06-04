import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { registerSchema, type RegisterInput } from '@shared/schemas';
import { useTranslation } from '../i18n/I18nProvider';
import { useRegister } from '../hooks/useRegister';
import { ErrorBanner } from './ErrorBanner';
import { Spinner } from './Spinner';
import { ApiError } from '../lib/api';
import type { InsuranceType } from '@shared/types';

const insuranceTypes: InsuranceType[] = ['HOUSE', 'AUTO', 'LIFE'];

export function RegisterForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mutation = useRegister();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      nombre: '',
      email: '',
      telefono: '',
      insuranceType: 'AUTO',
    },
  });

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
        } else if (err.code === 'VALIDATION_ERROR' && err.fields) {
          for (const [key, message] of Object.entries(err.fields)) {
            setError(key as keyof RegisterInput, { message });
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

  return (
    <form className="space-y-5" onSubmit={handleSubmit(onSubmit)} noValidate>
      {apiError && <ErrorBanner message={apiError} />}

      <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field label={t('register.field.nombre')} error={errors.nombre?.message} htmlFor="nombre">
          <input
            id="nombre"
            className="input h-11 rounded-lg"
            placeholder={t('register.placeholder.nombre')}
            {...register('nombre')}
          />
        </Field>
        <Field label={t('register.field.email')} error={errors.email?.message} htmlFor="email">
          <input
            id="email"
            type="email"
            autoComplete="email"
            className="input h-11 rounded-lg"
            placeholder={t('register.placeholder.email')}
            {...register('email')}
          />
        </Field>

        <Field label={t('register.field.telefono')} error={errors.telefono?.message} htmlFor="telefono">
          <input
            id="telefono"
            inputMode="tel"
            autoComplete="tel"
            className="input h-11 rounded-lg"
            placeholder={t('register.placeholder.telefono')}
            {...register('telefono')}
          />
        </Field>
        <Field label={t('register.field.insuranceType')} htmlFor="insuranceType">
          <select id="insuranceType" className="input h-11 rounded-lg" {...register('insuranceType')}>
            {insuranceTypes.map((it) => (
              <option key={it} value={it}>
                {t(`insurance.${it}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <button
        type="submit"
        className="btn-primary w-full mt-2 py-3 text-base"
        disabled={isSubmitting || mutation.isPending}
      >
        {mutation.isPending || isSubmitting ? (
          <>
            <Spinner /> {t('register.submitting')}
          </>
        ) : (
          <>
            <CheckCircleIcon /> {t('register.submit')}
          </>
        )}
      </button>

      <p className="flex items-center justify-center gap-1 text-center text-xs text-slate-500">
        <LockMiniIcon /> {t('register.privacy')}
      </p>
    </form>
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
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
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
function LockMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}
