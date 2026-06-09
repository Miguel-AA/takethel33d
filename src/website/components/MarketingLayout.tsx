// Shared layout for every marketing page: marketing header + routed page
// content (<Outlet>) + footer. Scrolls to the top on each route change so the
// multipage site behaves like real page navigation.
import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useLandingCopy } from '../useLandingCopy';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';

export function MarketingLayout() {
  const c = useLandingCopy();
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <>
      <MarketingHeader nav={c.nav} />
      <div className="relative isolate">
        <Outlet />
        <MarketingFooter copy={c.footer} />
      </div>
    </>
  );
}
