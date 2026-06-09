import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { I18nProvider } from './i18n/I18nProvider';
import { Header } from './components/Header';
import { RegisterPage } from './routes/RegisterPage';
import { ConfirmationPage } from './routes/ConfirmationPage';
import { ManagerLoginPage } from './routes/ManagerLoginPage';
import { ManagerDashboardPage } from './routes/ManagerDashboardPage';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { clearToken } from './lib/auth';

export function App() {
  const queryClient = useMemo(() => {
    return new QueryClient({
      queryCache: new QueryCache({
        onError: (err) => {
          if ((err as Error & { status?: number }).status === 401) {
            clearToken();
            if (
              window.location.pathname.startsWith('/manager') &&
              window.location.pathname !== '/manager/login'
            ) {
              window.location.assign('/manager/login');
            }
          }
        },
      }),
      defaultOptions: {
        queries: {
          retry: (failureCount, err) => {
            const status = (err as Error & { status?: number }).status;
            if (status === 401 || status === 404) return false;
            return failureCount < 2;
          },
          refetchOnWindowFocus: true,
          staleTime: 1000,
        },
      },
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <BrowserRouter>
          <div className="premium-app flex min-h-full flex-col">
            {/* App-wide video background (no overlay — glass comes from the cards). */}
            <div
              className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
              aria-hidden="true"
            >
              <video
                className="h-full w-full object-cover"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
              >
                <source src="/taketheleedbg.mp4" type="video/mp4" />
              </video>
            </div>
            <Header />
            <main className="flex-1">
              <Routes>
                <Route path="/" element={<RegisterPage />} />
                <Route path="/confirmacion" element={<ConfirmationPage />} />
                <Route path="/manager/login" element={<ManagerLoginPage />} />
                <Route
                  path="/manager"
                  element={
                    <ProtectedRoute>
                      <ManagerDashboardPage />
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </div>
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
