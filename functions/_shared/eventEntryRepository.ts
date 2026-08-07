// Persistence for `event_entries`.
//
// Mutating statements are returned PREPARED, never executed, so a registration
// commits as one batch: participant, entry, answers, audit.
//
// There is no delete and no general update. An entry records that a person took
// part; nothing in this phase may unrecord it. The one write beyond the insert
// is `applyEligibilityStatement`, which exists as a NAMED SEAM for the next
// phase — it touches only the eligibility columns and the status, and cannot
// re-point an entry at another event, participant or form version.

import type { EventEntry, EventEntrySummary } from '../../shared/types';
import {
  EVENT_ENTRY_STATUSES,
  type EventEntryStatus,
} from '../../shared/entryLifecycle';
import {
  ELIGIBILITY_REASON_CODES,
  type EligibilityDecision,
  type EligibilityReasonCode,
} from '../../shared/eligibility';
import { ENTRY_ELIGIBILITY_REASON_MAX_LENGTH } from '../../shared/limits';
import { isIsoTimestamp } from './time';

export interface EventEntryRow {
  id: string;
  event_id: string;
  participant_id: string;
  form_version_id: string;
  status: string;
  calculated_age: number | null;
  age_eligible: number | null;
  overall_eligible: number | null;
  eligibility_reason: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

interface EventEntryJoinedRow extends EventEntryRow {
  first_name: string;
  last_name: string;
  email: string;
  version_number: number;
  answer_count: number;
}

const ENTRY_COLUMNS = `id, event_id, participant_id, form_version_id, status,
  calculated_age, age_eligible, overall_eligible, eligibility_reason,
  submitted_at, created_at, updated_at`;

const VALID_STATUSES = new Set<string>(EVENT_ENTRY_STATUSES);
const VALID_REASONS = new Set<string>(ELIGIBILITY_REASON_CODES);

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`event_entries.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

/** SQLite has no boolean, and this column is nullable: 0, 1 or nothing. */
function nullableFlag(value: number | null, field: string): boolean | null {
  if (value === null) return null;
  const numeric = Number(value);
  if (numeric !== 0 && numeric !== 1) {
    throw new TypeError(`event_entries.${field} is not a boolean flag: ${value}`);
  }
  return numeric === 1;
}

/**
 * Maps a row to the domain shape.
 *
 * Strict for the same reason every mapper here is: a row carrying an unknown
 * status, a negative age or a half-boolean must not reach the eligibility phase
 * and be treated as a decision somebody made. It is a corruption, and it is
 * reported as one.
 */
export function rowToEventEntry(row: EventEntryRow): EventEntry {
  if (!row.id || !row.event_id || !row.participant_id || !row.form_version_id) {
    throw new TypeError('event_entries row is missing its identifiers');
  }
  if (!VALID_STATUSES.has(row.status)) {
    throw new TypeError(`event_entries.status holds an unknown value: ${row.status}`);
  }

  let calculatedAge: number | null = null;
  if (row.calculated_age !== null) {
    const numeric = Number(row.calculated_age);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 130) {
      throw new TypeError(`event_entries.calculated_age is out of range: ${row.calculated_age}`);
    }
    calculatedAge = numeric;
  }

  if (
    row.eligibility_reason !== null &&
    row.eligibility_reason.length > ENTRY_ELIGIBILITY_REASON_MAX_LENGTH
  ) {
    throw new TypeError('event_entries.eligibility_reason is over its limit');
  }

  const ageEligible = nullableFlag(row.age_eligible, 'age_eligible');
  const overallEligible = nullableFlag(row.overall_eligible, 'overall_eligible');

  // Invariants that can be checked from the ROW ALONE. Anything needing the
  // event (was there an age rule at all?) is checked where the event is
  // available — a mapper that guessed would reject legitimate history.
  if (row.eligibility_reason !== null && !VALID_REASONS.has(row.eligibility_reason)) {
    throw new TypeError(
      `event_entries.eligibility_reason holds an unknown value: ${row.eligibility_reason}`,
    );
  }
  if (row.status === 'ELIGIBLE' && overallEligible !== true) {
    throw new TypeError('event_entries.status says ELIGIBLE but overall_eligible does not');
  }
  if (row.status === 'INELIGIBLE' && overallEligible !== false) {
    throw new TypeError('event_entries.status says INELIGIBLE but overall_eligible does not');
  }
  // A verdict of "not eligible" that does not say why is a verdict nobody can
  // explain to the person it excluded.
  if (overallEligible === false && row.eligibility_reason === null) {
    throw new TypeError('event_entries is ineligible without a reason');
  }
  // An age rule that was applied must have had an age to apply to.
  if (ageEligible !== null && calculatedAge === null) {
    throw new TypeError('event_entries judged an age it does not record');
  }

  return {
    id: row.id,
    eventId: row.event_id,
    participantId: row.participant_id,
    formVersionId: row.form_version_id,
    status: row.status as EventEntryStatus,
    calculatedAge,
    ageEligible,
    overallEligible,
    eligibilityReason: row.eligibility_reason as EligibilityReasonCode | null,
    submittedAt: assertTimestamp(row.submitted_at, 'submitted_at'),
    createdAt: assertTimestamp(row.created_at, 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'updated_at'),
  };
}

export interface EventEntryInsertValues {
  id: string;
  eventId: string;
  participantId: string;
  formVersionId: string;
  status: EventEntryStatus;
  /**
   * The verdict, decided BEFORE the row is written.
   *
   * An entry is born decided. Creating it unjudged and updating it afterwards
   * would leave a window — however short — in which a participation exists with
   * no decision attached, and a crash inside that window would leave one
   * forever.
   */
  decision: EligibilityDecision;
  submittedAt: string;
  ipHash: string | null;
  userAgent: string | null;
}

export class EventEntryRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * Unscoped lookup by id.
   *
   * Every ENDPOINT uses `findByEventAndId` instead — an entry is only ever
   * reached through the event it belongs to, which is what stops one event's
   * participants being read by guessing an id. This exists for internal callers
   * that already hold the event.
   */
  async findById(id: string): Promise<EventEntry | null> {
    const row = await this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM event_entries WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<EventEntryRow>();
    return row ? rowToEventEntry(row) : null;
  }

  /** Scoped lookup: an entry id from another event resolves to nothing. */
  async findByEventAndId(eventId: string, entryId: string): Promise<EventEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM event_entries
         WHERE id = ? AND event_id = ? LIMIT 1`,
      )
      .bind(entryId, eventId)
      .first<EventEntryRow>();
    return row ? rowToEventEntry(row) : null;
  }

  /** The duplicate-entry precheck. The unique index is what actually decides. */
  async findByEventAndParticipant(
    eventId: string,
    participantId: string,
  ): Promise<EventEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM event_entries
         WHERE event_id = ? AND participant_id = ? LIMIT 1`,
      )
      .bind(eventId, participantId)
      .first<EventEntryRow>();
    return row ? rowToEventEntry(row) : null;
  }

  async countByEvent(eventId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS total FROM event_entries WHERE event_id = ?')
      .bind(eventId)
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  /** Whether an event has any entries at all. Blocks physical deletion. */
  async hasEntries(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM event_entries WHERE event_id = ? LIMIT 1')
      .bind(eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  /**
   * The participants of one event, newest submission first.
   *
   * The search matches a name or an email and nothing else. Filtering by an
   * ANSWER is deliberately absent: answers are rows keyed by a question that
   * differs per event, and building that filter here would either interpolate a
   * client string into SQL or invent a query language nobody asked for.
   */
  async listByEvent(
    eventId: string,
    query: { page: number; pageSize: number; search: string | null },
  ): Promise<{ items: EventEntrySummary[]; total: number }> {
    const clauses = ['e.event_id = ?'];
    const bindings: unknown[] = [eventId];

    if (query.search) {
      // LIKE treats `%` and `_` as wildcards, so a search for "%" would
      // otherwise match every row. Escaped, with an explicit ESCAPE clause, so
      // the term is matched literally.
      const escaped = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
      const like = `%${escaped}%`;
      clauses.push(
        `(p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR p.email LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      bindings.push(like, like, like);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;

    const totalRow = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM event_entries e
         JOIN participants p ON p.id = e.participant_id
         ${where}`,
      )
      .bind(...bindings)
      .first<{ total: number }>();

    const rows = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS.split(',')
          .map((column) => `e.${column.trim()}`)
          .join(', ')},
                p.first_name, p.last_name, p.email,
                v.version_number,
                (SELECT COUNT(*) FROM event_entry_answers a
                  WHERE a.event_entry_id = e.id) AS answer_count
         FROM event_entries e
         JOIN participants p ON p.id = e.participant_id
         JOIN event_form_versions v ON v.id = e.form_version_id
         ${where}
         ORDER BY e.submitted_at DESC, e.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, query.pageSize, (query.page - 1) * query.pageSize)
      .all<EventEntryJoinedRow>();

    const items = (rows.results ?? []).map((row) => {
      const entry = rowToEventEntry(row);
      return {
        entryId: entry.id,
        participantId: entry.participantId,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        submittedAt: entry.submittedAt,
        status: entry.status,
        // The verdict travels with the row, so the table can show WHY somebody
        // was excluded without a second request per participant.
        calculatedAge: entry.calculatedAge,
        overallEligible: entry.overallEligible,
        eligibilityReason: entry.eligibilityReason,
        formVersionId: entry.formVersionId,
        formVersionNumber: Number(row.version_number),
        answerCount: Number(row.answer_count ?? 0),
      } satisfies EventEntrySummary;
    });

    return { items, total: Number(totalRow?.total ?? 0) };
  }

  insertStatement(values: EventEntryInsertValues): D1PreparedStatement {
    const { decision } = values;
    return this.db
      .prepare(
        `INSERT INTO event_entries
           (id, event_id, participant_id, form_version_id, status,
            calculated_age, age_eligible, overall_eligible, eligibility_reason,
            submitted_at, created_at, updated_at, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.eventId,
        values.participantId,
        values.formVersionId,
        values.status,
        decision.calculatedAge,
        // NULL is not false. "No age rule applied" and "the age rule failed"
        // are different facts, and collapsing them would make every event
        // without an age limit look as though everybody failed one.
        decision.ageEligible === null ? null : decision.ageEligible ? 1 : 0,
        decision.overallEligible ? 1 : 0,
        decision.reasonCode,
        values.submittedAt,
        values.submittedAt,
        values.submittedAt,
        values.ipHash,
        values.userAgent,
      );
  }

  /**
   * Re-states a decision on an entry that already exists.
   *
   * NOT how a participation is decided. Eligibility is computed before the row
   * is written and travels in `insertStatement`, so an entry is never created
   * unjudged and then updated — that sequence has a window in which a
   * participation exists with no verdict, and a failure inside it leaves one
   * permanently.
   *
   * The method survives, narrow, for the administrative correction flow a later
   * phase will need: it can set the eligibility columns and the status, and it
   * cannot touch `event_id`, `participant_id`, `form_version_id` or
   * `submitted_at`. An entry may be re-judged; it may not be re-homed. Nothing
   * in the registration path calls it.
   */
  applyEligibilityStatement(
    entryId: string,
    values: {
      status: EventEntryStatus;
      calculatedAge: number | null;
      ageEligible: boolean | null;
      overallEligible: boolean | null;
      eligibilityReason: string | null;
      at: string;
    },
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE event_entries
            SET status = ?,
                calculated_age = ?,
                age_eligible = ?,
                overall_eligible = ?,
                eligibility_reason = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        values.status,
        values.calculatedAge,
        values.ageEligible === null ? null : values.ageEligible ? 1 : 0,
        values.overallEligible === null ? null : values.overallEligible ? 1 : 0,
        values.eligibilityReason,
        values.at,
        entryId,
      );
  }
}
