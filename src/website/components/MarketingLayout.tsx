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
      {/* pt offsets the fixed header (h-16 sm:h-20) so content starts below it. */}
      <div className="relative isolate pt-16 sm:pt-20">
        <Outlet />
        <MarketingFooter copy={c.footer} />
      </div>
    </>
  );
}
