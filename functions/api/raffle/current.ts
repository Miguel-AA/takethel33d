import { json } from '../../_shared/responses';
import { ATTENDEE_COLUMNS, rowToAttendeeIso, sqliteToIso, type AttendeeRow } from '../../_shared/db';

type Env = { DB: D1Database };

interface JoinedRow extends AttendeeRow {
  drawn_at: string;
}

// ATTENDEE_COLUMNS is unqualified (no table alias); the attendees table is the
// only source of those columns in this join, so they resolve unambiguously.
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const row = await ctx.env.DB.prepare(
    `SELECT ${ATTENDEE_COLUMNS},
            r.drawn_at AS drawn_at
     FROM raffle_draws r
     JOIN attendees ON attendees.id = r.attendee_id
     ORDER BY r.drawn_at DESC, r.id DESC
     LIMIT 1`,
  ).first<JoinedRow>();

  if (!row) return json(200, null);

  return json(200, {
    winner: rowToAttendeeIso(row),
    drawnAt: sqliteToIso(row.drawn_at),
  });
};
