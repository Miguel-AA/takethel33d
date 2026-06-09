import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { useLogin } from '../hooks/useLogin';
import { ApiError } from '../lib/api';
import { ErrorBanner } from '../components/ErrorBanner';
import { Spinner } from '../components/Spinner';
import { isAuthenticated } from '../lib/auth';

export function ManagerLoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const login = useLogin();

  if (isAuthenticated()) {
    return <Navigate to="/manager" replace />;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await login.mutateAsync(password);
      navigate('/manager', { replace: true });
    } catch {
      /* error rendered below */
    }
  }

  const errorMessage =
    login.error instanceof ApiError && login.error.code === 'INVALID_PASSWORD'
      ? t('login.error')
      : login.error instanceof ApiError && login.error.code === 'RATE_LIMIT'
        ? t('login.error.rateLimit')
        : login.error instanceof ApiError && login.error.status >= 500
          ? t('login.error.config')
      : login.isError
        ? t('login.error.network')
        : null;

  return (
    <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
      <div className="card-lg p-7">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          <span className="accent-underline">{t('login.title')}</span>
        </h1>
        <p className="mt-2 text-sm text-slate-600">{t('login.subtitle')}</p>

        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          {errorMessage && <ErrorBanner message={errorMessage} />}
          <div>
            <label htmlFor="password" className="label">
              {t('login.password')}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              required
            />
          </div>
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={login.isPending || !password}
          >
            {login.isPending ? (
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
