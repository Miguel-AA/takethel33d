import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useTranslation } from '../i18n/I18nProvider';
import { LanguageToggle } from './LanguageToggle';
import { Logo } from './Logo';
import { Spinner } from './Spinner';
import { useSession } from '../hooks/useSession';
import { useLogout } from '../hooks/useLogout';

export function Header() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const onManager = location.pathname.startsWith('/manager');

  // Only ask the server who we are on admin routes. Public pages (/events,
  // /confirmacion) would otherwise fire a guaranteed 401 for every visitor.
  const session = useSession({ enabled: onManager });
  const logout = useLogout();
  const admin = session.data?.admin;

  async function onLogout() {
    // Revokes the session server-side; the cache is cleared either way.
    await logout.mutateAsync().catch(() => {});
    navigate('/manager/login', { replace: true });
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx('nav-link', isActive && 'nav-link-active');

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/40 bg-white/55 backdrop-blur-2xl supports-[backdrop-filter]:bg-white/40">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-3 sm:h-20 sm:gap-6 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link to="/events" className="flex min-w-0 items-center" aria-label="TAKE THE L33D">
            <Logo showWordmark />
          </Link>
          <Link
            to="/"
            className="flex shrink-0 items-center gap-1 rounded-full border border-white/40 bg-white/50 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-sm transition hover:border-brand-400/60 hover:text-brand-700 sm:gap-1.5 sm:px-3 sm:text-sm"
            aria-label={t('nav.website')}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="hidden sm:inline">{t('nav.website')}</span>
          </Link>
        </div>

        {!onManager && (
          <nav className="hidden items-center gap-8 md:flex">
            <NavLink to="/events" className={navLinkClass}>
              {t('nav.register')}
            </NavLink>
            <NavLink to="/manager/login" className={navLinkClass}>
              {t('nav.manager')}
            </NavLink>
          </nav>
        )}

        {/* The administrative sections, reachable from every admin page rather
            than only from the dashboard. Rendered ONLY when there is a session:
            a visitor who is not signed in gets no map of the admin surface.
            `end` keeps Dashboard from highlighting on every /manager/* route. */}
        {admin && (
          <nav
            className="hidden items-center gap-6 md:flex"
            aria-label={t('nav.admin')}
          >
            <NavLink to="/manager" end className={navLinkClass}>
              {t('nav.dashboard')}
            </NavLink>
            <NavLink to="/manager/events" className={navLinkClass}>
              {t('events.nav')}
            </NavLink>
            <NavLink to="/manager/audit" className={navLinkClass}>
              {t('audit.nav')}
            </NavLink>
          </nav>
        )}

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LanguageToggle />
          {admin ? (
            <>
              {/* Who is acting is now visible in the panel itself. */}
              <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
                <span className="truncate text-sm font-semibold text-slate-900">
                  {admin.displayName}
                </span>
                <span className="truncate text-xs text-slate-500">{admin.email}</span>
              </div>
              <button
                type="button"
                onClick={onLogout}
                disabled={logout.isPending}
                className="btn-secondary px-3 text-xs sm:px-5"
              >
                {logout.isPending ? (
                  <>
                    <Spinner /> {t('login.signingOut')}
                  </>
                ) : (
                  t('nav.logout')
                )}
              </button>
            </>
          ) : (
            <Link to="/manager/login" className="btn-secondary px-3 text-xs sm:px-5">
              {t('nav.login')}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
