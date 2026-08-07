import { Navigate } from 'react-router-dom';
import { type ReactNode } from 'react';
import { useSession } from '../hooks/useSession';
import { isSessionEnded } from '../lib/api';
import { Spinner } from '../components/Spinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { useTranslation } from '../i18n/I18nProvider';

/**
 * Gate for administrative routes.
 *
 * There is no local credential to inspect any more, so the decision is made
 * exclusively by `GET /api/manager/me`. While that request is in flight the
 * route renders a spinner rather than its children, so the dashboard never
 * flashes as authenticated before the server has confirmed the session.
 *
 * This is a UX guard only. The authoritative check runs server-side in
 * `functions/_middleware.ts`; every protected endpoint rejects an unauthorized
 * request regardless of what the SPA renders.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const session = useSession();

  if (session.isPending) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-500">
        <Spinner />
        <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }

  if (session.isError) {
    // Only an actual "this session cannot be used" answer sends the user to the
    // login page: absent, invalid, expired, revoked, or a suspended/disabled
    // owner. A network or server failure must NOT masquerade as a logout —
    // that would eject a perfectly valid session on a momentary blip.
    if (isSessionEnded(session.error)) {
      return <Navigate to="/manager/login" replace />;
    }

    return (
      <div className="mx-auto max-w-md px-4 py-14 sm:px-6">
        <div className="card-lg space-y-4 p-7">
          <ErrorBanner message={t('common.error')} />
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => void session.refetch()}
            disabled={session.isFetching}
          >
            {session.isFetching ? (
              <>
                <Spinner /> {t('common.loading')}
              </>
            ) : (
              t('common.retry')
            )}
          </button>
        </div>
      </div>
    );
  }

  if (!session.data) {
    return <Navigate to="/manager/login" replace />;
  }

  return <>{children}</>;
}
