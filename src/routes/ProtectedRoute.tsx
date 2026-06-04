import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { type ReactNode } from 'react';
import { api } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { getToken } from '../lib/auth';
import { Spinner } from '../components/Spinner';
import { useTranslation } from '../i18n/I18nProvider';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const token = getToken();

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.me(),
    enabled: !!token,
    retry: false,
    staleTime: 60_000,
  });

  if (!token) {
    return <Navigate to="/manager/login" replace />;
  }

  if (meQuery.isLoading) {
    return (
      <div className="flex items-center justify-center p-12 text-slate-500">
        <Spinner />
        <span className="ml-2">{t('common.loading')}</span>
      </div>
    );
  }

  if (meQuery.isError) {
    return <Navigate to="/manager/login" replace />;
  }

  return <>{children}</>;
}
