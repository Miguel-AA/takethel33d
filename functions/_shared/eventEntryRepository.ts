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

import type {
  AdminParticipantListQuery,
  AdminParticipantSummary,
  AdminParticipantSummaryCounts,
  EventEntry,
  EventEntrySummary,
} from '../../shared/types';
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
  submission_id: string | null;
  revision: number;
  disqualified_at: string | null;
  disqualified_by_admin_id: string | null;
  disqualification_reason: string | null;
  pre_disqualification_status: string | null;
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
  submission_id, revision, disqualified_at, disqualified_by_admin_id,
  disqualification_reason, pre_disqualification_status,
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
    // NULL for every administrative entry and for every row predating phase 9.
    // `?? null` rather than a bare read because a database that has not yet run
    // migration 0014 returns `undefined` for the column rather than throwing,
    // and an `undefined` here would serialize into JSON as a missing key.
    submissionId: row.submission_id ?? null,
    // Defaults to 1 rather than throwing when the column is absent: a database
    // that has not yet run 0015 still reads, and a missing concurrency token is
    // safest treated as "the first version".
    revision: row.revision === undefined || row.revision === null ? 1 : Number(row.revision),
    disqualifiedAt: row.disqualified_at ?? null,
    disqualifiedByAdminId: row.disqualified_by_admin_id ?? null,
    disqualificationReason: row.disqualification_reason ?? null,
    preDisqualificationStatus:
      (row.pre_disqualification_status as EventEntryStatus | null) ?? null,
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
  /**
   * The public flow's idempotency key, when the entry came from there.
   *
   * Optional and defaulted to NULL so the administrative path — which has no
   * client-side retry to deduplicate — is unchanged and does not have to
   * mention it.
   */
  submissionId?: string | null;
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

  // -------------------------------------------------------------------------
  // Administration (phase 10)
  // -------------------------------------------------------------------------

  /**
   * Builds the WHERE fragment the administrative listing and its aggregates
   * share.
   *
   * ONE definition, used by both, because a summary that counted a different
   * population from the table beneath it would be worse than no summary. Every
   * value reaches SQL through `.bind()`; the only interpolation is of literal
   * fragments this file wrote itself.
   */
  private adminFilters(
    eventId: string,
    query: Pick<AdminParticipantListQuery, 'search' | 'eligibility' | 'status' | 'formVersionId'>,
  ): { where: string; bindings: unknown[] } {
    const clauses = ['e.event_id = ?'];
    const bindings: unknown[] = [eventId];

    if (query.search) {
      // LIKE treats `%` and `_` as wildcards, so a search for "%" would
      // otherwise match every row and hand a caller the whole table. They are
      // escaped along with the escape character itself, and an explicit ESCAPE
      // clause is declared, so the term matches literally.
      const escaped = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
      const like = `%${escaped}%`;
      clauses.push(
        `(p.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR p.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR p.email LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR (p.first_name || ' ' || p.last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      bindings.push(like, like, like, like);
    }

    // The HISTORICAL verdict. Deliberately independent of `status`: an entry
    // that qualified and was later disqualified still matches ELIGIBLE here,
    // because it did qualify. The two filters answer different questions and
    // combining them is the caller's choice, not this function's.
    if (query.eligibility === 'ELIGIBLE') clauses.push('e.overall_eligible = 1');
    else if (query.eligibility === 'INELIGIBLE') clauses.push('e.overall_eligible = 0');

    if (query.status !== 'ALL') {
      clauses.push('e.status = ?');
      bindings.push(query.status);
    }

    if (query.formVersionId) {
      clauses.push('e.form_version_id = ?');
      bindings.push(query.formVersionId);
    }

    return { where: `WHERE ${clauses.join(' AND ')}`, bindings };
  }

  /** The participants table, filtered, searched and paginated in SQL. */
  async listAdminByEvent(
    eventId: string,
    query: AdminParticipantListQuery,
  ): Promise<{ items: AdminParticipantSummary[]; total: number }> {
    const { where, bindings } = this.adminFilters(eventId, query);

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
         -- Newest first, with the id as a tie-breaker. Without it two entries
         -- sharing a submission instant could swap places between pages and a
         -- row would be shown twice or not at all.
         ORDER BY e.submitted_at DESC, e.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, query.pageSize, (query.page - 1) * query.pageSize)
      .all<EventEntryJoinedRow>();

    const items = (rows.results ?? []).map((row) => {
      const entry = rowToEventEntry(row);
      return {
        entryId: entry.id,
        revision: entry.revision,
        participantId: entry.participantId,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        status: entry.status,
        overallEligible: entry.overallEligible,
        calculatedAge: entry.calculatedAge,
        eligibilityReason: entry.eligibilityReason,
        submittedAt: entry.submittedAt,
        formVersionId: entry.formVersionId,
        formVersionNumber: Number(row.version_number),
        answerCount: Number(row.answer_count ?? 0),
        // The fact of a disqualification, not its reason or its author: those
        // belong to the detail, behind a click and an audit row.
        disqualifiedAt: entry.disqualifiedAt,
      } satisfies AdminParticipantSummary;
    });

    return { items, total: Number(totalRow?.total ?? 0) };
  }

  /**
   * Every count above the table, in ONE query.
   *
   * Conditional sums rather than five round trips, and certainly rather than
   * fetching every entry to count them in JavaScript — an event with ten
   * thousand participants would download ten thousand rows to display six
   * numbers.
   */
  async aggregateByEvent(eventId: string): Promise<AdminParticipantSummaryCounts> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN overall_eligible = 1 THEN 1 ELSE 0 END) AS eligible,
           SUM(CASE WHEN overall_eligible = 0 THEN 1 ELSE 0 END) AS ineligible,
           SUM(CASE WHEN status = 'SUBMITTED' THEN 1 ELSE 0 END) AS submitted,
           SUM(CASE WHEN status = 'DISQUALIFIED' THEN 1 ELSE 0 END) AS disqualified,
           -- What a draw would take. BOTH conditions: the historical verdict
           -- AND the current disposition.
           SUM(CASE WHEN status = 'ELIGIBLE' AND overall_eligible = 1 THEN 1 ELSE 0 END)
             AS draw_eligible
         FROM event_entries WHERE event_id = ?`,
      )
      .bind(eventId)
      .first<Record<string, number | null>>();

    return {
      total: Number(row?.total ?? 0),
      eligible: Number(row?.eligible ?? 0),
      ineligible: Number(row?.ineligible ?? 0),
      submitted: Number(row?.submitted ?? 0),
      disqualified: Number(row?.disqualified ?? 0),
      drawEligible: Number(row?.draw_eligible ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // The draw (phase 11)
  // -------------------------------------------------------------------------

  /**
   * The entries a draw is allowed to consider.
   *
   * THE PREDICATE IS EXACTLY THE CERTIFIED ONE — `status = 'ELIGIBLE' AND
   * overall_eligible = 1` — the same pair `aggregateByEvent` counts as
   * `draw_eligible` and the same pair `isDrawEligible` applies in the shared
   * layer. Three places, one rule, and that is deliberate: the number an
   * operator was shown before confirming and the population the draw actually
   * takes must be the same number, not two that usually agree.
   *
   * WHY NOT `status <> 'INELIGIBLE'`: it would sweep in SUBMITTED entries that
   * were never judged and DISQUALIFIED ones an administrator removed on
   * purpose. WHY NOT `eligibility_reason`: it explains a verdict, it is not the
   * verdict, and a row with a reason attached can be eligible or not.
   *
   * BOTH conditions, never one. `overall_eligible = 1` alone would include
   * somebody disqualified an hour ago, because disqualification deliberately
   * does not touch the historical verdict. `status = 'ELIGIBLE'` alone would
   * rely on the two columns never disagreeing, which `rowToEventEntry` enforces
   * for rows this application wrote and cannot enforce for any other.
   *
   * Ordered by id so the candidate list is DETERMINISTIC before it is shuffled.
   * SQLite's natural row order is an implementation detail, and a draw whose
   * input order came from the storage engine would have a second, unexamined
   * source of chance in it.
   *
   * Returns IDS ONLY. Nothing here needs a name, an email or an answer to pick
   * a winner, and not loading them means they cannot be logged, hashed or
   * accidentally returned.
   */
  async listDrawEligibleByEvent(eventId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT id FROM event_entries
          WHERE event_id = ?
            AND status = 'ELIGIBLE'
            AND overall_eligible = 1
          ORDER BY id ASC`,
      )
      .bind(eventId)
      .all<{ id: string }>();

    return (rows.results ?? []).map((row) => row.id);
  }

  /**
   * One entry with its identity, its version number and its disqualifier.
   *
   * Scoped by event throughout, so an entry id belonging to another event
   * resolves to nothing rather than to somebody else's record.
   */
  async findAdminDetail(
    eventId: string,
    entryId: string,
  ): Promise<{
    entry: EventEntry;
    participant: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phone: string | null;
      dateOfBirth: string | null;
    };
    formVersionNumber: number;
    disqualifiedByName: string | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS.split(',')
          .map((column) => `e.${column.trim()}`)
          .join(', ')},
                p.first_name, p.last_name, p.email, p.phone, p.date_of_birth,
                v.version_number,
                u.display_name AS disqualified_by_name
         FROM event_entries e
         JOIN participants p ON p.id = e.participant_id
         JOIN event_form_versions v ON v.id = e.form_version_id
         LEFT JOIN admin_users u ON u.id = e.disqualified_by_admin_id
         WHERE e.id = ? AND e.event_id = ? LIMIT 1`,
      )
      .bind(entryId, eventId)
      .first<
        EventEntryJoinedRow & {
          phone: string | null;
          date_of_birth: string | null;
          disqualified_by_name: string | null;
        }
      >();

    if (!row) return null;

    return {
      entry: rowToEventEntry(row),
      participant: {
        id: row.participant_id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        dateOfBirth: row.date_of_birth,
      },
      formVersionNumber: Number(row.version_number),
      disqualifiedByName: row.disqualified_by_name,
    };
  }

  /**
   * Removes a participation from consideration, guarded by revision.
   *
   * `revision = revision + 1` together with `WHERE revision = ?` is the
   * lost-update protection: a second administrator working from a stale copy
   * matches ZERO rows instead of overwriting what the first one wrote — and the
   * value they would overwrite is `pre_disqualification_status`, the one field
   * that cannot be reconstructed from anything else.
   *
   * `WHERE ... event_id = ?` as well as `id = ?`: an entry is only ever reached
   * through the event that owns it, so a guessed id from another event modifies
   * nothing.
   *
   * `status <> 'DISQUALIFIED'` is in the WHERE rather than only in the service,
   * so a concurrent disqualification cannot slip between the check and the
   * write and have the second one overwrite the first one's recorded previous
   * status with 'DISQUALIFIED'.
   *
   * NOTE WHAT IS ABSENT: `calculated_age`, `age_eligible`, `overall_eligible`
   * and `eligibility_reason` are not in the SET list. The verdict is history.
   */
  disqualifyStatement(values: {
    eventId: string;
    entryId: string;
    expectedRevision: number;
    reason: string;
    adminId: string;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE event_entries
            SET pre_disqualification_status = status,
                status = 'DISQUALIFIED',
                disqualified_at = ?,
                disqualified_by_admin_id = ?,
                disqualification_reason = ?,
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?
            AND event_id = ?
            AND revision = ?
            AND status <> 'DISQUALIFIED'`,
      )
      .bind(
        values.at,
        values.adminId,
        values.reason,
        values.at,
        values.entryId,
        values.eventId,
        values.expectedRevision,
      );
  }

  /**
   * Puts one back, to the status it recorded — never to a recomputed one.
   *
   * `status = pre_disqualification_status` is the whole point: the destination
   * comes from the row, so an entry that never qualified returns to INELIGIBLE
   * and one recorded before eligibility existed returns to SUBMITTED. Nothing
   * here consults the event's current `minimum_age`, its timezone, or today's
   * date.
   *
   * The disposition columns are cleared in the same statement, because the
   * coherence trigger refuses a row that is not disqualified but still carries
   * one. The evidence that it happened lives in the audit trail, which is
   * append-only and cannot be cleared.
   */
  reinstateStatement(values: {
    eventId: string;
    entryId: string;
    expectedRevision: number;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE event_entries
            SET status = pre_disqualification_status,
                pre_disqualification_status = NULL,
                disqualified_at = NULL,
                disqualified_by_admin_id = NULL,
                disqualification_reason = NULL,
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?
            AND event_id = ?
            AND revision = ?
            AND status = 'DISQUALIFIED'
            AND pre_disqualification_status IN ('ELIGIBLE', 'INELIGIBLE', 'SUBMITTED')`,
      )
      .bind(
        values.at,
        values.entryId,
        values.eventId,
        values.expectedRevision,
      );
  }

  insertStatement(values: EventEntryInsertValues): D1PreparedStatement {
    const { decision } = values;
    return this.db
      .prepare(
        `INSERT INTO event_entries
           (id, event_id, participant_id, form_version_id, status,
            calculated_age, age_eligible, overall_eligible, eligibility_reason,
            submission_id, submitted_at, created_at, updated_at, ip_hash, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        values.submissionId ?? null,
        values.submittedAt,
        values.submittedAt,
        values.submittedAt,
        values.ipHash,
        values.userAgent,
      );
  }

  /**
   * The entry a public submission already produced, if this key has been seen.
   *
   * Scoped by event as well as by key. The unique index is global — a key is a
   * client-minted UUID and collisions across events are not expected — but a
   * lookup that ignored the event would let a key obtained from one event's
   * response be replayed against another to discover whether it existed.
   *
   * This is the FAST PATH only. It can lose a race against a simultaneous
   * retry, which is precisely why `ux_event_entries_submission_id` exists: the
   * index decides, this read just avoids the common case doing any work.
   */
  async findByEventAndSubmissionId(
    eventId: string,
    submissionId: string,
  ): Promise<EventEntry | null> {
    const row = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM event_entries
         WHERE event_id = ? AND submission_id = ? LIMIT 1`,
      )
      .bind(eventId, submissionId)
      .first<EventEntryRow>();
    return row ? rowToEventEntry(row) : null;
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
