import { json } from '../../_shared/responses';
import { rowToAttendeeIso, sqliteToIso, type AttendeeRow } from '../../_shared/db';

type Env = { DB: D1Database };

interface JoinedRow extends AttendeeRow {
  drawn_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const row = await ctx.env.DB.prepare(
    `SELECT a.id, a.participant_number, a.nombre, a.email, a.telefono,
            a.insurance_type, a.created_at,
            r.drawn_at AS drawn_at
     FROM raffle_draws r
     JOIN attendees a ON a.id = r.attendee_id
     ORDER BY r.drawn_at DESC, r.id DESC
     LIMIT 1`,
  ).first<JoinedRow>();

  if (!row) return json(200, null);

  return json(200, {
    winner: rowToAttendeeIso(row),
    drawnAt: sqliteToIso(row.drawn_at),
  });
};
