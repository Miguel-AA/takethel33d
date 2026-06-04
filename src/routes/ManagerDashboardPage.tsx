import { useTranslation } from '../i18n/I18nProvider';
import { MetricsGrid } from '../components/MetricsGrid';
import { AttendeeTable } from '../components/AttendeeTable';
import { RafflePanel } from '../components/RafflePanel';

export function ManagerDashboardPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          <span className="accent-underline">{t('dashboard.title')}</span>
        </h1>
        <p className="mt-2 text-slate-300">{t('dashboard.subtitle')}</p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-200">
          {t('dashboard.section.metrics')}
        </h2>
        <MetricsGrid />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-200">
          {t('dashboard.section.raffle')}
        </h2>
        <RafflePanel />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-200">
          {t('dashboard.section.attendees')}
        </h2>
        <AttendeeTable />
      </section>
    </div>
  );
}
