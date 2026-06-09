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
        <div className="grid gap-10 text-center md:grid-cols-[1.4fr_repeat(3,1fr)] md:text-left">
          {/* Brand */}
          <div className="mx-auto max-w-xs md:mx-0">
            <Link to="/" className="flex items-center justify-center gap-3 md:justify-start" aria-label={PRODUCT_NAME}>
              <img src="/logos/icon.png" alt={`${PRODUCT_NAME} logo`} className="h-9 w-auto" draggable={false} />
              <img src="/logos/wordmark.png" alt={PRODUCT_NAME} className="h-5 w-auto" draggable={false} />
            </Link>
            <p className="mt-4 text-sm leading-6 text-slate-600">{copy.tagline}</p>
          </div>

          {copy.columns.map((col) => (
            <nav
              key={col.title}
              aria-label={col.title}
              className="border-t border-white/40 pt-8 first:border-t-0 first:pt-0 md:border-t-0 md:pt-0"
            >
              <h2 className="text-base font-bold uppercase tracking-wide text-brand-700">{col.title}</h2>
              <ul className="mt-4 space-y-3">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <FooterLinkItem label={link.label} to={link.to} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 border-t border-white/40 pt-6 text-center text-xs text-slate-500">
          © {year} {PRODUCT_NAME}. {copy.rights}
        </div>
      </div>
    </footer>
  );
}
