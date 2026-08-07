import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nProvider';
import { MetricsGrid } from '../components/MetricsGrid';
import { AttendeeTable } from '../components/AttendeeTable';
import { RafflePanel } from '../components/RafflePanel';

export function ManagerDashboardPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-7xl space-y-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            <span className="accent-underline">{t('dashboard.title')}</span>
          </h1>
          <p className="mt-2 text-slate-600">{t('dashboard.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/manager/events" className="btn-primary w-fit text-xs">
            {t('events.nav')}
          </Link>
          <Link to="/manager/audit" className="btn-secondary w-fit text-xs">
            {t('audit.nav')}
          </Link>
        </div>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('dashboard.section.metrics')}
        </h2>
        <MetricsGrid />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('dashboard.section.raffle')}
        </h2>
        <RafflePanel />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-brand-700">
          {t('dashboard.section.attendees')}
        </h2>
        <AttendeeTable />
      </section>
    </div>
  );
}
