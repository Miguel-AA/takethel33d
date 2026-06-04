import { json } from '../../_shared/responses';
import { rowToAttendeeIso, type AttendeeRow } from '../../_shared/db';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const search = (url.searchParams.get('search') ?? '').trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(
    200,
    Math.max(1, Number(url.searchParams.get('pageSize') ?? '25') || 25),
  );
  const offset = (page - 1) * pageSize;

  let total = 0;
  let items: AttendeeRow[] = [];

  if (search.length > 0) {
    const like = `%${search}%`;
    const numericSearch = /^\d+$/.test(search) ? Number(search) : null;

    const totalRow = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM attendees
       WHERE nombre LIKE ? COLLATE NOCASE
          OR email LIKE ? COLLATE NOCASE
          OR CAST(participant_number AS TEXT) LIKE ?
          OR (? IS NOT NULL AND participant_number = ?)`,
    )
      .bind(like, like, like, numericSearch, numericSearch)
      .first<{ total: number }>();
    total = totalRow?.total ?? 0;

    const rs = await ctx.env.DB.prepare(
      `SELECT id, participant_number, nombre, email, telefono, insurance_type, created_at
       FROM attendees
       WHERE nombre LIKE ? COLLATE NOCASE
          OR email LIKE ? COLLATE NOCASE
          OR CAST(participant_number AS TEXT) LIKE ?
          OR (? IS NOT NULL AND participant_number = ?)
       ORDER BY participant_number DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(like, like, like, numericSearch, numericSearch, pageSize, offset)
      .all<AttendeeRow>();
    items = rs.results ?? [];
  } else {
    const totalRow = await ctx.env.DB.prepare(
      'SELECT COUNT(*) AS total FROM attendees',
    ).first<{ total: number }>();
    total = totalRow?.total ?? 0;

    const rs = await ctx.env.DB.prepare(
      `SELECT id, participant_number, nombre, email, telefono, insurance_type, created_at
       FROM attendees
       ORDER BY participant_number DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(pageSize, offset)
      .all<AttendeeRow>();
    items = rs.results ?? [];
  }

  return json(200, {
    items: items.map(rowToAttendeeIso),
    total,
    page,
    pageSize,
  });
};
