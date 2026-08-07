import { json } from '../../_shared/responses';
import {
  qualifiedAttendeeColumns,
  rowToAttendeeIso,
  sqliteToIso,
  type AttendeeRow,
} from '../../_shared/db';

type Env = { DB: D1Database };

interface JoinedRow extends AttendeeRow {
  drawn_at: string;
}

// The columns MUST be table-qualified: `raffle_draws` also has an `id`, so an
// unqualified projection makes SQLite reject the statement with
// "ambiguous column name: id" and this endpoint fails for every request.
export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const row = await ctx.env.DB.prepare(
    `SELECT ${qualifiedAttendeeColumns('attendees')},
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
