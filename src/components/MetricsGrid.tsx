import { useTranslation } from '../i18n/I18nProvider';
import { useMetrics } from '../hooks/useMetrics';
import { MetricCard } from './MetricCard';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';
import { formatPercent } from '../lib/format';
import { EDUCATION_LEVELS } from '@shared/types';

function BarRow({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const percent = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between">
        <span className="truncate pr-2 text-slate-600">{label}</span>
        <span className="whitespace-nowrap font-medium text-slate-900">
          {count} · {formatPercent(percent)}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-slate-900/5">
        <div
          className="h-full rounded-full bg-brand-500 shadow-[0_0_14px_rgba(23,71,196,0.40)]"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}

export function MetricsGrid() {
  const { t, locale } = useTranslation();
  const { data, isLoading, isError } = useMetrics();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-slate-500">
        <Spinner />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (isError || !data) {
    return <ErrorBanner message={t('common.error')} />;
  }

  const updatedAtTime = new Date(data.updatedAt).toLocaleTimeString(locale);
  const total = data.total;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label={t('dashboard.metric.total')}
        value={data.total}
        hint={t('dashboard.metric.updatedAt', { time: updatedAtTime })}
      />
      <MetricCard label={t('dashboard.metric.leadsToday')} value={data.leadsToday} />

      <MetricCard label={t('dashboard.metric.housing')}>
        <div className="space-y-2">
          <BarRow label={t('housing.OWNER')} count={data.byHousingStatus.OWNER} total={total} />
          <BarRow label={t('housing.RENTER')} count={data.byHousingStatus.RENTER} total={total} />
        </div>
      </MetricCard>

      <MetricCard label={t('dashboard.metric.vehicle')}>
        <div className="space-y-2">
          <BarRow label={t('common.yes')} count={data.byVehicle.yes} total={total} />
          <BarRow label={t('common.no')} count={data.byVehicle.no} total={total} />
        </div>
      </MetricCard>

      <MetricCard label={t('dashboard.metric.business')}>
        <div className="space-y-2">
          <BarRow label={t('common.yes')} count={data.byBusinessOwner.yes} total={total} />
          <BarRow label={t('common.no')} count={data.byBusinessOwner.no} total={total} />
        </div>
      </MetricCard>

      <MetricCard className="sm:col-span-2 lg:col-span-3" label={t('dashboard.metric.education')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {EDUCATION_LEVELS.filter((level) => data.byEducation[level] > 0).length === 0 && (
            <div className="text-xs text-slate-500">-</div>
          )}
          {EDUCATION_LEVELS.map((level) =>
            data.byEducation[level] > 0 ? (
              <BarRow
                key={level}
                label={t(`education.${level}`)}
                count={data.byEducation[level]}
                total={total}
              />
            ) : null,
          )}
        </div>
      </MetricCard>
    </div>
  );
}
