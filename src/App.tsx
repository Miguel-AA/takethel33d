import { useCallback, useMemo, useState } from 'react';
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
import { ManagerAuditPage } from './routes/ManagerAuditPage';
import { ManagerEventsPage } from './routes/ManagerEventsPage';
import { ManagerEventNewPage } from './routes/ManagerEventNewPage';
import { ManagerEventDetailPage } from './routes/ManagerEventDetailPage';
import { ManagerEventEditPage } from './routes/ManagerEventEditPage';
import { ManagerEventPrizesPage } from './routes/ManagerEventPrizesPage';
import { ManagerEventFormBuilderPage } from './routes/ManagerEventFormBuilderPage';
import { ManagerEventParticipantsPage } from './routes/ManagerEventParticipantsPage';
import { ProtectedRoute } from './routes/ProtectedRoute';
import { MarketingLayout } from './website/components/MarketingLayout';
import { HomePage } from './website/pages/HomePage';
import { BenefitsPage } from './website/pages/BenefitsPage';
import { HowItWorksPage } from './website/pages/HowItWorksPage';
import { IndustriesPage } from './website/pages/IndustriesPage';
import { AboutUsPage } from './website/pages/AboutUsPage';
import { PricingPage } from './website/pages/PricingPage';
import { ContactPage } from './website/pages/ContactPage';
import { clearLegacyToken } from './lib/auth';
import { queryKeys } from './lib/queryKeys';
import { isSessionEnded } from './lib/api';

// Public marketing website routes render their own header (src/website via
// MarketingLayout), so the app chrome (Header) is hidden on them.
const MARKETING_PATHS = new Set([
  '/',
  '/landing',
  '/benefits',
  '/how-it-works',
  '/industries',
  '/about-us',
  '/pricing',
  '/contact',
]);

// App-wide video background (glass comes from the cards). On devices that block
// muted autoplay — most commonly iOS Low Power Mode — Safari shows a native
// play-button placeholder. We detect the blocked play() promise and swap the
// <video> for a static poster frame so the background stays clean (no play glyph).
function VideoBackground() {
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const attach = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    // Set the muted *property* (not just the attribute) — React doesn't always
    // reflect `muted` to the DOM property, and browsers require it for autoplay.
    el.muted = true;
    el.playbackRate = 1.5;
    const attempt = el.play();
    if (attempt && typeof attempt.then === 'function') {
      attempt.catch(() => setAutoplayBlocked(true));
    }
  }, []);

  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {autoplayBlocked ? (
        <img
          src="/taketheleedbg-poster.jpg"
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <video
          ref={attach}
          poster="/taketheleedbg-poster.jpg"
          className="h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = 1.5;
          }}
        >
          <source src="/taketheleedbg.mp4" type="video/mp4" />
        </video>
      )}
      {/* Frosted-glass wall over the video — a soft gray tint that reads a touch
          darker than plain white without dimming the page. */}
      <div className="absolute inset-0 bg-slate-900/12 backdrop-blur-[2px]" />
    </div>
  );
}

function AppLayout() {
  const location = useLocation();
  const showAppHeader = !MARKETING_PATHS.has(location.pathname);

  return (
    <div className="premium-app flex min-h-full flex-col">
      <VideoBackground />

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
            <Route path="/about-us" element={<AboutUsPage />} />
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
          <Route
            path="/manager/audit"
            element={
              <ProtectedRoute>
                <ManagerAuditPage />
              </ProtectedRoute>
            }
          />
          {/* Event administration. The public `/events` lead-capture page above
              is a different, legacy feature and is untouched. */}
          <Route
            path="/manager/events"
            element={
              <ProtectedRoute>
                <ManagerEventsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/new"
            element={
              <ProtectedRoute>
                <ManagerEventNewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/:eventId"
            element={
              <ProtectedRoute>
                <ManagerEventDetailPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/:eventId/edit"
            element={
              <ProtectedRoute>
                <ManagerEventEditPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/:eventId/prizes"
            element={
              <ProtectedRoute>
                <ManagerEventPrizesPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/:eventId/form"
            element={
              <ProtectedRoute>
                <ManagerEventFormBuilderPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/manager/events/:eventId/participants"
            element={
              <ProtectedRoute>
                <ManagerEventParticipantsPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// One-time cleanup of the bearer token the pre-cookie implementation stored in
// localStorage. Those tokens can no longer authenticate anything (migration
// 0005 dropped `manager_sessions`), but a leftover credential-shaped value is
// exactly what moving to an HttpOnly cookie was meant to eliminate.
clearLegacyToken();

const SESSION_QUERY_HASH = JSON.stringify(queryKeys.session);

function createQueryClient(): QueryClient {
  const queryCache = new QueryCache({
    onError: (err, query) => {
      // A 401 on ANY admin query (attendees, metrics, raffle) means the session
      // ended mid-visit: expired, revoked from another device, or the admin was
      // suspended. Drop the cached session so ProtectedRoute stops rendering
      // the dashboard.
      if (!isSessionEnded(err)) return;

      // `setQueryData(key, undefined)` is a NO-OP in React Query v5 — an
      // undefined value is treated as "no update" — so the stale session would
      // survive and ProtectedRoute would keep rendering the dashboard.
      // removeQueries actually evicts it.
      client.removeQueries({ queryKey: queryKeys.session });

      // The session query redirects through ProtectedRoute instead, and the
      // login page must never bounce to itself.
      const onLoginPage = window.location.pathname === '/manager/login';
      const isSessionQuery = query.queryHash === SESSION_QUERY_HASH;
      if (
        !onLoginPage &&
        !isSessionQuery &&
        window.location.pathname.startsWith('/manager')
      ) {
        window.location.assign('/manager/login');
      }
    },
  });

  const client = new QueryClient({
    queryCache,
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

  return client;
}

export function App() {
  const queryClient = useMemo(createQueryClient, []);

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
