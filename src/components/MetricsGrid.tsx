import { useTranslation } from '../i18n/I18nProvider';
import { useMetrics } from '../hooks/useMetrics';
import { MetricCard } from './MetricCard';
import { Spinner } from './Spinner';
import { ErrorBanner } from './ErrorBanner';
import { formatPercent } from '../lib/format';
import type { InsuranceType } from '@shared/types';

function BarRow({
  label,
  count,
  percent,
}: {
  label: string;
  count: number;
  percent: number;
}) {
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between">
        <span className="truncate pr-2 text-slate-300">{label}</span>
        <span className="whitespace-nowrap font-medium text-white">
          {count} · {formatPercent(percent)}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-brand-500 shadow-[0_0_18px_rgba(225,29,46,0.55)]"
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  );
}

const INSURANCE_TYPES: InsuranceType[] = ['HOUSE', 'AUTO', 'LIFE'];

export function MetricsGrid() {
  const { t, locale } = useTranslation();
  const { data, isLoading, isError } = useMetrics();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-slate-400">
        <Spinner />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (isError || !data) {
    return <ErrorBanner message={t('common.error')} />;
  }

  const updatedAtTime = new Date(data.updatedAt).toLocaleTimeString(locale);

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label={t('dashboard.metric.total')}
        value={data.total}
        hint={t('dashboard.metric.updatedAt', { time: updatedAtTime })}
      />
      <MetricCard
        label={t('dashboard.metric.leadsToday')}
        value={data.leadsToday}
      />
      <MetricCard
        className="sm:col-span-2"
        label={t('dashboard.metric.insuranceType')}
      >
        <div className="space-y-2">
          {INSURANCE_TYPES.every((k) => data.byInsuranceType[k] === 0) && (
            <div className="text-xs text-slate-400">-</div>
          )}
          {INSURANCE_TYPES.map((k) =>
            data.byInsuranceType[k] > 0 ? (
              <BarRow
                key={k}
                label={t(`insurance.${k}`)}
                count={data.byInsuranceType[k]}
                percent={data.insuranceTypePercent[k]}
              />
            ) : null,
          )}
        </div>
      </MetricCard>
    </div>
  );
}
