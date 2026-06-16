import { useTranslation } from '../i18n/I18nProvider';
import { RegisterForm } from '../components/RegisterForm';

export function RegisterPage() {
  const { t } = useTranslation();
  return (
    <div className="relative isolate overflow-hidden">
      <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-12">
        <header className="glass-panel-strong flex w-full flex-col items-center px-6 py-12 text-center sm:px-12 sm:py-16">
          <div className="premium-kicker">
            <BadgeCheckIcon />
            {t('register.badge')}
          </div>
          <h1 className="mt-6 max-w-3xl text-4xl font-bold leading-tight text-slate-900 sm:text-5xl lg:text-6xl">
            {t('register.title.line1')}{' '}
            <span className="accent-underline text-brand-600">
              {t('register.title.line2')}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
            {t('register.subtitle')}
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-2">
            <TrustChip label={t('register.trust.secure')} />
            <TrustChip label={t('register.trust.clear')} />
            <TrustChip label={t('register.trust.followup')} />
          </div>
        </header>

        <div className="mt-8 grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.8fr)]">
          <section className="glass-panel-strong flex flex-col p-5 sm:p-7 lg:p-8">
            <div className="mb-6 flex flex-col gap-4 border-b border-slate-900/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-lg border border-brand-400/30 bg-brand-500/10 text-brand-600">
                  <UserIcon />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {t('register.formTitle')}
                  </h2>
                  <p className="text-sm text-slate-500">{t('register.formSubtitle')}</p>
                </div>
              </div>
              <div className="inline-flex w-fit items-center gap-2 whitespace-nowrap rounded-full border border-brand-400/30 bg-brand-500/10 px-3 py-1.5 text-xs font-semibold text-brand-700">
                <GiftIcon className="h-4 w-4" />
                {t('register.formPill')}
              </div>
            </div>
            <RegisterForm />
            <div className="mt-auto pt-6">
              <div className="rounded-lg border border-brand-400/20 bg-brand-500/10 px-4 py-3 text-sm leading-6 text-brand-700">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <InfoIcon />
                  {t('register.disclaimer.title')}
                </div>
                <p>{t('register.disclaimer.body')}</p>
              </div>
            </div>
          </section>

          <aside className="glass-panel relative overflow-hidden p-6 text-slate-900 sm:p-7 lg:p-8">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-slate-900/10 to-transparent" />
            <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-brand-400/40 to-transparent" />
            <div className="relative flex h-full flex-col">
              <div className="rounded-lg border border-white/30 bg-white/25 p-5 shadow-sm backdrop-blur-2xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-brand-700">
                      {t('register.giveaway.lead')}
                    </p>
                    <p className="mt-2 text-xl font-bold leading-tight text-slate-900">
                      {t('register.giveaway.highlight')}
                    </p>
                  </div>
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-brand-600 text-white shadow-card">
                    <GiftIcon className="h-6 w-6" />
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <GiftCardIllustration className="h-20 w-auto" />
                </div>
              </div>

              <div className="mt-6 space-y-4">
                <FeatureRow icon={<BoltIcon />} title={t('register.feature.instant.title')}>
                  {t('register.feature.instant.body')}
                </FeatureRow>
                <FeatureRow icon={<LockIcon />} title={t('register.feature.secure.title')}>
                  {t('register.feature.secure.body')}
                </FeatureRow>
                <FeatureRow icon={<TeamIcon />} title={t('register.feature.team.title')}>
                  {t('register.feature.team.body')}
                </FeatureRow>
              </div>

              <div className="mt-6">
                <div className="rounded-lg border border-white/30 bg-white/25 p-4 text-sm leading-6 text-slate-700 backdrop-blur-2xl">
                  {t('register.sidebar.note')}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-500/10 text-brand-600 ring-1 ring-slate-900/5">
        {icon}
      </div>
      <div>
        <div className="font-semibold text-slate-900">{title}</div>
        <p className="text-sm leading-6 text-slate-600">{children}</p>
      </div>
    </div>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 5a1.2 1.2 0 1 1 0 2.4A1.2 1.2 0 0 1 12 7zm1 10h-2v-6h2v6z" />
    </svg>
  );
}
function GiftIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="8" width="18" height="13" rx="2" />
      <path d="M3 12h18M12 8v13M8 8c0-2 1.5-4 4-4 2.5 0 4 2 4 4M8 8c-2 0-3-1-3-2.5S6 3 7.5 3c2 0 4.5 3 4.5 5" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 1 1 8 0v4" />
    </svg>
  );
}
function TeamIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3 20c0-3 3-5 6-5s6 2 6 5M14 20c0-2 2-4 4-4s4 2 4 4" />
    </svg>
  );
}
function GiftCardIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 90" className={className} aria-hidden="true">
      {/* Card body */}
      <rect x="16" y="26" width="88" height="54" rx="8" fill="#101b30" stroke="#1747c4" strokeOpacity="0.4" />
      <rect x="16" y="38" width="88" height="9" fill="#1747c4" opacity="0.85" />
      <rect x="26" y="58" width="26" height="8" rx="2" fill="#4f7cf0" opacity="0.9" />
      <rect x="26" y="70" width="40" height="4" rx="2" fill="#c9ced4" opacity="0.5" />
      {/* Ribbon + bow */}
      <rect x="56" y="26" width="8" height="54" fill="#84a8fb" opacity="0.9" />
      <path
        d="M60 26 C 48 12 40 20 48 26 M60 26 C 72 12 80 20 72 26"
        fill="none"
        stroke="#84a8fb"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="60" cy="26" r="4" fill="#4f7cf0" />
    </svg>
  );
}

function TrustChip({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-white/40 bg-white/55 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur-xl">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-brand-600" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M20 7 10 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </div>
  );
}

function BadgeCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-brand-600" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M12 3 5 6v5c0 4.5 3 7.8 7 10 4-2.2 7-5.5 7-10V6l-7-3Z" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
