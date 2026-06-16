import { error, json } from '../../_shared/responses';
import { ATTENDEE_COLUMNS, rowToAttendeeIso, type AttendeeRow } from '../../_shared/db';

type Env = { DB: D1Database };

export const onRequestGet: PagesFunction<Env, 'id'> = async (ctx) => {
  const id = ctx.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    return error(400, 'VALIDATION_ERROR', 'Invalid id');
  }

  const row = await ctx.env.DB.prepare(
    `SELECT ${ATTENDEE_COLUMNS}
     FROM attendees WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AttendeeRow>();

  if (!row) return error(404, 'NOT_FOUND', 'Attendee not found');
  return json(200, rowToAttendeeIso(row));
};
