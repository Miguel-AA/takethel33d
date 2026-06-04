import { useTranslation } from '../i18n/I18nProvider';
import { JotformEmbed } from '../components/JotformEmbed';
import { PaperPlane, Sparkle, SunBurst } from '../components/decorations';

export function RegisterPage() {
  const { t } = useTranslation();
  return (
    <div className="relative isolate overflow-hidden bg-slate-50">
      <SunBurst className="absolute -right-28 top-10 h-[28rem] w-[28rem] opacity-80" />
      <PaperPlane className="absolute right-[18%] top-28 hidden h-24 w-48 opacity-70 xl:block" />

      <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
        <header className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-brand-700 shadow-sm">
            <Sparkle className="h-3.5 w-3.5 text-accent-500" />
            {t('register.badge')}
          </div>
          <h1 className="mt-5 text-4xl font-bold leading-tight text-slate-950 sm:text-5xl lg:text-6xl">
            {t('register.title.line1')}{' '}
            <span className="accent-underline text-brand-500">
              {t('register.title.line2')}
            </span>
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
            {t('register.subtitle')}
          </p>
        </header>

        <div className="mt-8 grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.8fr)]">
          <section className="flex flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-cardLg sm:p-7 lg:p-8">
            <div className="mb-6 flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-50 text-brand-600">
                  <UserIcon />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-900">
                    {t('register.formTitle')}
                  </h2>
                  <p className="text-sm text-slate-500">{t('register.formSubtitle')}</p>
                </div>
              </div>
              <div className="inline-flex w-fit items-center gap-2 rounded-full bg-accent-50 px-3 py-1.5 text-xs font-semibold text-accent-800">
                <GiftIcon className="h-4 w-4" />
                {t('register.formPill')}
              </div>
            </div>
            <JotformEmbed />
            <div className="mt-auto pt-6">
              <div className="rounded-2xl border border-brand-100 bg-brand-50 px-4 py-3 text-sm leading-6 text-brand-900">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <InfoIcon />
                  {t('register.disclaimer.title')}
                </div>
                <p>{t('register.disclaimer.body')}</p>
              </div>
            </div>
          </section>

          <aside className="relative overflow-hidden rounded-3xl bg-brand-900 p-6 text-white shadow-cardLg sm:p-7 lg:p-8">
            <div className="absolute -right-16 -top-16 h-52 w-52 rounded-full bg-accent-400/20 blur-3xl" />
            <div className="absolute -bottom-20 left-10 h-56 w-56 rounded-full bg-brand-400/20 blur-3xl" />
            <div className="relative flex h-full flex-col">
              <div className="rounded-2xl border border-white/10 bg-white/8 p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-brand-100">
                      {t('register.giveaway.lead')}
                    </p>
                    <p className="mt-2 text-xl font-bold leading-tight text-white">
                      {t('register.giveaway.highlight')}
                    </p>
                  </div>
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-accent-400 text-brand-950">
                    <GiftIcon className="h-6 w-6" />
                  </div>
                </div>
                <div className="mt-4 flex justify-end">
                  <IpadIllustration className="h-20 w-auto" />
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
                <div className="rounded-2xl bg-white/10 p-4 text-sm leading-6 text-brand-50">
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
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/10 text-accent-300 ring-1 ring-white/10">
        {icon}
      </div>
      <div>
        <div className="font-semibold text-white">{title}</div>
        <p className="text-sm leading-6 text-brand-100">{children}</p>
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
function IpadIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 90" className={className} aria-hidden="true">
      <rect x="22" y="6" width="76" height="62" rx="6" fill="#1e3a5f" />
      <rect x="26" y="10" width="68" height="54" rx="3" fill="#5b9bd5" />
      <path d="M26 38 Q 60 18 94 38 L 94 64 L 26 64 Z" fill="#7eb1dc" />
      <circle cx="86" cy="20" r="3" fill="#f5c518" />
      <rect x="14" y="68" width="92" height="6" rx="3" fill="#dfe7ef" />
      <rect x="22" y="74" width="76" height="3" rx="1.5" fill="#cfd8e3" />
    </svg>
  );
}
