import { useMemo } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
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
import { MarketingLayout } from './website/components/MarketingLayout';
import { HomePage } from './website/pages/HomePage';
import { BenefitsPage } from './website/pages/BenefitsPage';
import { HowItWorksPage } from './website/pages/HowItWorksPage';
import { IndustriesPage } from './website/pages/IndustriesPage';
import { PricingPage } from './website/pages/PricingPage';
import { ContactPage } from './website/pages/ContactPage';
import { clearToken } from './lib/auth';

// Public marketing website routes render their own header (src/website via
// MarketingLayout), so the app chrome (Header) is hidden on them.
const MARKETING_PATHS = new Set([
  '/',
  '/landing',
  '/benefits',
  '/how-it-works',
  '/industries',
  '/pricing',
  '/contact',
]);

function AppLayout() {
  const location = useLocation();
  const showAppHeader = !MARKETING_PATHS.has(location.pathname);

  return (
    <div className="premium-app flex min-h-full flex-col">
      {/* App-wide video background (no overlay — glass comes from the cards). */}
      <div
        className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        aria-hidden="true"
      >
        <video
          ref={(el) => {
            if (el) el.playbackRate = 1.5;
          }}
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = 1.5;
          }}
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
        >
          <source src="/taketheleedbg.mp4" type="video/mp4" />
        </video>
        {/* Very light frosted-glass wall over the video — faint blur + tint. */}
        <div className="absolute inset-0 bg-white/5 backdrop-blur-[2px]" />
      </div>

      {showAppHeader && <Header />}

      {/* When the fixed app header is shown, offset main by its height (h-16 sm:h-20).
          Marketing routes have no app header here — their own fixed MarketingHeader
          is offset inside MarketingLayout instead. */}
      <main className={`flex-1 ${showAppHeader ? 'pt-16 sm:pt-20' : ''}`}>
        <Routes>
          {/* Public multipage marketing website (shares MarketingLayout: its
              own header + footer). All copy lives under src/website. */}
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<HomePage />} />
            {/* Kept as an alias of the website home. */}
            <Route path="/landing" element={<HomePage />} />
            <Route path="/benefits" element={<BenefitsPage />} />
            <Route path="/how-it-works" element={<HowItWorksPage />} />
            <Route path="/industries" element={<IndustriesPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/contact" element={<ContactPage />} />
          </Route>
          {/* The existing lead-acquisition app (previously at "/"). */}
          <Route path="/events" element={<RegisterPage />} />
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
  );
}

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
          <AppLayout />
        </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
}
