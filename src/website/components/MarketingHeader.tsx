// Multipage marketing header for the public website. Reuses the app's shared
// visual controls (Logo, LanguageToggle) but carries no app/auth logic.
//
// "Events" links into the existing app at /events — it is the app entry point,
// NOT a marketing section, so it's rendered as a distinct secondary button.
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { Logo } from '../../components/Logo';
import { LanguageToggle } from '../../components/LanguageToggle';
import { Icon, ArrowRightIcon, type IconName } from '../icons';
import type { LandingCopy } from '../copy';

function MenuGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

export function MarketingHeader({ nav }: { nav: LandingCopy['nav'] }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  // Close the mobile menu whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock background scroll while the mobile menu is open so it feels like a
  // focused, app-style sheet rather than a floating dropdown.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const links: { to: string; label: string; icon: IconName; end?: boolean }[] = [
    { to: '/', label: nav.home, icon: 'home', end: true },
    { to: '/benefits', label: nav.benefits, icon: 'sparkle' },
    { to: '/how-it-works', label: nav.how, icon: 'funnel' },
    { to: '/industries', label: nav.industries, icon: 'building' },
    { to: '/pricing', label: nav.pricing, icon: 'layers' },
    { to: '/contact', label: nav.contact, icon: 'bell' },
  ];

  // Active tab is highlighted as a soft-blue pill (background + ring + blue text).
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'rounded-full px-3.5 py-2 text-sm font-medium transition',
      isActive
        ? 'bg-brand-500/15 text-brand-700 ring-1 ring-inset ring-brand-500/25'
        : 'text-slate-600 hover:bg-slate-900/5 hover:text-slate-900',
    );

  // Mobile rows are large, full-width tap targets (min ~56px tall) with a
  // leading icon chip and a trailing arrow, styled in the site's glass/brand
  // language. Active row gets the brand gradient.
  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'group flex items-center justify-between gap-3 rounded-xl px-3 py-3 text-base font-semibold transition-all active:scale-[0.98]',
      isActive
        ? 'bg-gradient-to-r from-brand-600 to-brand-500 text-white shadow-card'
        : 'text-slate-700 hover:bg-brand-500/10 hover:text-brand-700',
    );

  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-white/40 bg-white/55 backdrop-blur-2xl supports-[backdrop-filter]:bg-white/40">
      <div className="section-x flex h-16 items-center justify-between gap-3 sm:h-20">
        <Link
          to="/"
          className="flex min-w-0 items-center"
          aria-label="Take the L33d"
          onClick={() => setOpen(false)}
        >
          <Logo showWordmark />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Páginas del sitio">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <LanguageToggle />
          <Link
            to="/events"
            className="hidden btn-secondary px-4 text-xs sm:inline-flex sm:px-5 sm:text-sm"
          >
            {nav.events}
          </Link>
          <Link
            to="/contact"
            className="hidden btn-primary px-4 text-xs lg:inline-flex lg:px-5 lg:text-sm"
          >
            {nav.getLeads}
          </Link>
          <button
            type="button"
            className={clsx(
              'grid h-11 w-11 place-items-center rounded-xl border transition lg:hidden',
              open
                ? 'border-brand-500/30 bg-brand-500/10 text-brand-700'
                : 'border-white/40 bg-white/40 text-slate-700 hover:bg-white/70 hover:text-slate-900',
            )}
            aria-expanded={open}
            aria-controls="marketing-mobile-nav"
            aria-label={nav.menu}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <CloseGlyph /> : <MenuGlyph />}
          </button>
        </div>
      </div>

      {open && (
        <>
          {/* Dimming overlay — tap anywhere outside the links to close. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="animate-menu-overlay fixed inset-x-0 bottom-0 top-16 z-30 cursor-default bg-slate-900/20 backdrop-blur-sm sm:top-20 lg:hidden"
          />
          <nav
            id="marketing-mobile-nav"
            className="animate-menu-panel absolute inset-x-0 top-full z-40 border-t border-white/40 bg-white/85 shadow-cardLg backdrop-blur-2xl lg:hidden"
            aria-label="Páginas del sitio"
          >
            <ul className="section-x flex flex-col gap-1.5 py-4">
              {links.map((l, i) => (
                <li key={l.to} className="animate-menu-item" style={{ animationDelay: `${i * 45}ms` }}>
                  <NavLink to={l.to} end={l.end} onClick={() => setOpen(false)} className={mobileLinkClass}>
                    {({ isActive }) => (
                      <>
                        <span className="flex items-center gap-3">
                          <span
                            className={clsx(
                              'grid h-9 w-9 shrink-0 place-items-center rounded-lg transition',
                              isActive
                                ? 'bg-white/25 text-white'
                                : 'bg-brand-500/10 text-brand-600 group-hover:bg-brand-500/20',
                            )}
                          >
                            <Icon name={l.icon} className="h-5 w-5" />
                          </span>
                          {l.label}
                        </span>
                        <ArrowRightIcon
                          className={clsx(
                            'h-4 w-4 transition',
                            isActive
                              ? 'text-white/90'
                              : '-translate-x-1 text-brand-500 opacity-0 group-hover:translate-x-0 group-hover:opacity-100',
                          )}
                        />
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
              <li
                className="animate-menu-item mt-3 flex flex-col gap-2.5 border-t border-white/50 pt-4"
                style={{ animationDelay: `${links.length * 45}ms` }}
              >
                <Link to="/contact" onClick={() => setOpen(false)} className="btn-primary px-4 py-3 text-base">
                  {nav.getLeads}
                  <ArrowRightIcon className="h-5 w-5" />
                </Link>
                <Link to="/events" onClick={() => setOpen(false)} className="btn-secondary px-4 py-3 text-base">
                  {nav.events}
                </Link>
              </li>
            </ul>
          </nav>
        </>
      )}
    </header>
  );
}
