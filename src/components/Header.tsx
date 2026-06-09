import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useTranslation } from '../i18n/I18nProvider';
import { LanguageToggle } from './LanguageToggle';
import { Logo } from './Logo';
import { clearToken, isAuthenticated } from '../lib/auth';

export function Header() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const onManager = location.pathname.startsWith('/manager');
  const authed = isAuthenticated();

  function logout() {
    clearToken();
    navigate('/manager/login');
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

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LanguageToggle />
          {onManager && authed ? (
            <button
              type="button"
              onClick={logout}
              className="btn-secondary px-3 text-xs sm:px-5"
            >
              {t('nav.logout')}
            </button>
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
