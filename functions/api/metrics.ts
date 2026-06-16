import { json } from '../_shared/responses';
import { EDUCATION_LEVELS } from '../../shared/types';
import type {
  EducationBreakdown,
  EducationLevel,
  HousingBreakdown,
  Metrics,
  YesNoBreakdown,
} from '../../shared/types';

type Env = { DB: D1Database };

function emptyEducation(): EducationBreakdown {
  return EDUCATION_LEVELS.reduce((acc, level) => {
    acc[level] = 0;
    return acc;
  }, {} as EducationBreakdown);
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const db = ctx.env.DB;

  const totalRow = await db
    .prepare('SELECT COUNT(*) AS total FROM attendees')
    .first<{ total: number }>();
  const total = totalRow?.total ?? 0;

  const todayRow = await db
    .prepare(
      `SELECT COUNT(*) AS leads_today FROM attendees
       WHERE substr(created_at, 1, 10) = substr(datetime('now'), 1, 10)`,
    )
    .first<{ leads_today: number }>();
  const leadsToday = todayRow?.leads_today ?? 0;

  // Housing status
  const byHousingStatus: HousingBreakdown = { OWNER: 0, RENTER: 0, unknown: 0 };
  const housingRows = await db
    .prepare(
      `SELECT housing_status AS key, COUNT(*) AS count FROM attendees GROUP BY housing_status`,
    )
    .all<{ key: string | null; count: number }>();
  for (const row of housingRows.results ?? []) {
    if (row.key === 'OWNER' || row.key === 'RENTER') byHousingStatus[row.key] = row.count;
    else byHousingStatus.unknown += row.count;
  }

  // Vehicle ownership
  const byVehicle = await yesNoBreakdown(db, 'owns_vehicle');
  // Business owner
  const byBusinessOwner = await yesNoBreakdown(db, 'is_business_owner');

  // Education level
  const byEducation = emptyEducation();
  const eduRows = await db
    .prepare(
      `SELECT highest_level_of_education AS key, COUNT(*) AS count
       FROM attendees WHERE highest_level_of_education IS NOT NULL
       GROUP BY highest_level_of_education`,
    )
    .all<{ key: string; count: number }>();
  for (const row of eduRows.results ?? []) {
    if (row.key in byEducation) byEducation[row.key as EducationLevel] = row.count;
  }

  const response: Metrics = {
    total,
    leadsToday,
    byHousingStatus,
    byVehicle,
    byBusinessOwner,
    byEducation,
    updatedAt: new Date().toISOString(),
  };
  return json(200, response);
};

async function yesNoBreakdown(
  db: D1Database,
  column: 'owns_vehicle' | 'is_business_owner',
): Promise<YesNoBreakdown> {
  const out: YesNoBreakdown = { yes: 0, no: 0, unknown: 0 };
  const rows = await db
    .prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM attendees GROUP BY ${column}`)
    .all<{ key: number | null; count: number }>();
  for (const row of rows.results ?? []) {
    if (row.key === 1) out.yes = row.count;
    else if (row.key === 0) out.no = row.count;
    else out.unknown += row.count;
  }
  return out;
}
