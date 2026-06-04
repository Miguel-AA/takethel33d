import { json } from '../_shared/responses';
import type {
  InsuranceTypeBreakdown,
  Metrics,
} from '@shared/types';

type Env = { DB: D1Database };

function emptyBreakdown(): InsuranceTypeBreakdown {
  return { HOUSE: 0, AUTO: 0, LIFE: 0 };
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const totalRow = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS total FROM attendees',
  ).first<{ total: number }>();
  const total = totalRow?.total ?? 0;

  const todayRow = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS leads_today FROM attendees
     WHERE substr(created_at, 1, 10) = substr(datetime('now'), 1, 10)`,
  ).first<{ leads_today: number }>();
  const leadsToday = todayRow?.leads_today ?? 0;

  const insuranceRows = await ctx.env.DB.prepare(
    `SELECT insurance_type AS key, COUNT(*) AS count
     FROM attendees GROUP BY insurance_type`,
  ).all<{ key: string; count: number }>();

  const byInsuranceType = emptyBreakdown();
  for (const row of insuranceRows.results ?? []) {
    if (row.key in byInsuranceType) {
      byInsuranceType[row.key as keyof InsuranceTypeBreakdown] = row.count;
    }
  }

  const insuranceTypePercent = emptyBreakdown();
  if (total > 0) {
    (Object.keys(byInsuranceType) as Array<keyof InsuranceTypeBreakdown>).forEach((k) => {
      insuranceTypePercent[k] = (byInsuranceType[k] / total) * 100;
    });
  }

  const response: Metrics = {
    total,
    leadsToday,
    byInsuranceType,
    insuranceTypePercent,
    updatedAt: new Date().toISOString(),
  };
  return json(200, response);
};
