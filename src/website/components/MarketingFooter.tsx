// Footer for the marketing website. Wires its link columns to real routes
// (internal "/..." paths render as <Link>; placeholders render as <a>).
import { Link } from 'react-router-dom';
import type { LandingCopy } from '../copy';

const PRODUCT_NAME = 'Take the L33d';

function FooterLinkItem({ label, to }: { label: string; to: string }) {
  const cls = 'text-sm text-slate-600 transition hover:text-brand-700';
  return to.startsWith('/') ? (
    <Link to={to} className={cls}>
      {label}
    </Link>
  ) : (
    <a href={to} className={cls}>
      {label}
    </a>
  );
}

export function MarketingFooter({ copy }: { copy: LandingCopy['footer'] }) {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-8 border-t border-white/40 bg-white/30 backdrop-blur-2xl">
      <div className="section-x py-12">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          {/* Brand */}
          <div className="max-w-xs">
            <Link to="/" className="flex items-center gap-3" aria-label={PRODUCT_NAME}>
              <img src="/logos/icon.png" alt={`${PRODUCT_NAME} logo`} className="h-9 w-auto" draggable={false} />
              <img src="/logos/wordmark.png" alt={PRODUCT_NAME} className="h-5 w-auto" draggable={false} />
            </Link>
            <p className="mt-4 text-sm leading-6 text-slate-600">{copy.tagline}</p>
          </div>

          {/* Link columns: tidy grid on mobile, individual grid tracks on desktop */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:contents">
            {copy.columns.map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{col.title}</h2>
                <ul className="mt-4 space-y-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <FooterLinkItem label={link.label} to={link.to} />
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-10 border-t border-white/40 pt-6 text-center text-xs text-slate-500 md:text-left">
          © {year} {PRODUCT_NAME}. {copy.rights}
        </div>
      </div>
    </footer>
  );
}
