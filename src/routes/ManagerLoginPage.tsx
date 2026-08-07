import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useNavigate } from 'react-router-dom';
import { adminLoginSchema, type AdminLoginSchemaInput } from '@shared/schemas';
import { useTranslation } from '../i18n/I18nProvider';
import { useLogin } from '../hooks/useLogin';
import { useSession } from '../hooks/useSession';
import { ApiError } from '../lib/api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Spinner } from '../components/Spinner';

export function ManagerLoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useLogin();
  const session = useSession();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AdminLoginSchemaInput>({
    resolver: zodResolver(adminLoginSchema),
    mode: 'onTouched',
    defaultValues: { email: '', password: '' },
  });

  // An already-authenticated admin never sees the form. The session query is
  // the only way to know, so wait for it to settle first.
  if (session.isSuccess && session.data) {
    return <Navigate to="/manager" replace />;
  }

  async function onSubmit(values: AdminLoginSchemaInput) {
    try {
      await login.mutateAsync(values);
      navigate('/manager', { replace: true });
    } catch {
      /* error rendered below */
    }
  }

  const errorMessage = (() => {
    if (!login.isError) return null;
    const err = login.error;
    if (err instanceof ApiError) {
      switch (err.code) {
        // Login never distinguishes "unknown email" from "wrong password" —
        // the backend returns the same code for both, on purpose.
        case 'INVALID_CREDENTIALS':
        case 'INVALID_PASSWORD':
          return t('login.error.invalidCredentials');
        case 'ADMIN_SUSPENDED':
          return t('login.error.suspended');
        case 'ADMIN_DISABLED':
          return t('login.error.disabled');
        case 'RATE_LIMIT':
          return t('login.error.rateLimit');
        case 'VALIDATION_ERROR':
          return t('login.error.invalidCredentials');
        default:
          if (err.status >= 500) return t('login.error.config');
          return t('login.error.network');
      }
    }
    return t('login.error.network');
  })();

  const pending = login.isPending || isSubmitting;

  return (
    <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <div className="card-lg p-7">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          <span className="accent-underline">{t('login.title')}</span>
        </h1>
        <p className="mt-2 text-sm text-slate-600">{t('login.subtitle')}</p>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          {errorMessage && <ErrorBanner message={errorMessage} />}

          <div>
            <label htmlFor="email" className="label">
              {t('login.email')}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className="input"
              placeholder={t('login.emailPlaceholder')}
              aria-invalid={errors.email ? 'true' : undefined}
              aria-describedby={errors.email ? 'email-error' : undefined}
              autoFocus
              {...register('email')}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="mt-1 text-xs text-red-600">
                {t('login.error.emailRequired')}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="label">
              {t('login.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              aria-invalid={errors.password ? 'true' : undefined}
              aria-describedby={errors.password ? 'password-error' : undefined}
              {...register('password')}
            />
            {errors.password && (
              <p id="password-error" role="alert" className="mt-1 text-xs text-red-600">
                {t('login.error.passwordRequired')}
              </p>
            )}
          </div>

          <button type="submit" className="btn-primary w-full" disabled={pending}>
            {pending ? (
              <>
                <Spinner /> {t('login.submitting')}
              </>
            ) : (
              t('login.submit')
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
