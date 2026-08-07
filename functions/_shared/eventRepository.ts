// Persistence for `events`.
//
// Mutating statements are returned as PREPARED STATEMENTS rather than executed,
// so the caller can commit them in one `db.batch()` alongside the audit row.
// The service, not this class, decides what constitutes a legal change.
//
// Every value reaches SQL through `.bind()`. Sorting resolves through a fixed
// map, so no client string ever becomes a column name.

import type {
  Event,
  EventListQuery,
  EventSortKey,
  EventStatus,
  EventSummary,
} from '../../shared/types';
import { EVENT_STATUSES } from '../../shared/eventLifecycle';
import {
  EVENT_MAX_ENTRIES_MAX,
  EVENT_MAX_ENTRIES_MIN,
  EVENT_MIN_AGE_MAX,
  EVENT_MIN_AGE_MIN,
} from '../../shared/limits';
import { isIsoTimestamp } from './time';

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  banner_url: string | null;
  location_name: string | null;
  timezone: string;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  starts_at: string | null;
  ends_at: string | null;
  minimum_age: number | null;
  max_entries_per_identity: number;
  status: string;
  confirmation_title: string | null;
  confirmation_message: string | null;
  ineligible_title: string | null;
  ineligible_message: string | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  opened_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
  published_form_version_id: string | null;
}

const EVENT_COLUMNS = `id, slug, name, description, banner_url, location_name, timezone,
  registration_opens_at, registration_closes_at, starts_at, ends_at,
  minimum_age, max_entries_per_identity, status,
  confirmation_title, confirmation_message, ineligible_title, ineligible_message,
  revision, created_by, updated_by, created_at, updated_at,
  published_at, opened_at, closed_at, cancelled_at, archived_at,
  published_form_version_id`;

const VALID_STATUSES = new Set<string>(EVENT_STATUSES);

/** Sort keys mapped to real columns. Nothing outside this map reaches SQL. */
const SORT_COLUMNS: Record<EventSortKey, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
  startsAt: 'starts_at',
};

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`events.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

function optionalTimestamp(value: string | null, field: string): string | null {
  if (value === null) return null;
  return assertTimestamp(value, field);
}

/** Bounded integer column, or a controlled error naming the column. */
function boundedInteger(
  value: number,
  column: string,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new TypeError(
      `events.${column} is outside its allowed range (${min}-${max}): ${value}`,
    );
  }
  return numeric;
}

/**
 * Maps a row to the domain shape.
 *
 * Deliberately strict: an unknown status, a malformed timestamp or an
 * out-of-range number THROWS rather than being passed along. The column CHECK
 * constraints are the first line of defence, but a row written by a migration,
 * a console session or a future bug must not reach the state machine carrying
 * a state it does not model or a revision that would break the concurrency
 * guard. Messages name the offending column and carry no stack.
 */
export function rowToEvent(row: EventRow): Event {
  if (!VALID_STATUSES.has(row.status)) {
    throw new TypeError(`events.status holds an unknown value: ${row.status}`);
  }

  // A revision below 1 would make every optimistic-concurrency comparison
  // meaningless, since the guard matches on it.
  boundedInteger(row.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
  boundedInteger(
    row.max_entries_per_identity,
    'max_entries_per_identity',
    EVENT_MAX_ENTRIES_MIN,
    EVENT_MAX_ENTRIES_MAX,
  );
  if (row.minimum_age !== null) {
    boundedInteger(row.minimum_age, 'minimum_age', EVENT_MIN_AGE_MIN, EVENT_MIN_AGE_MAX);
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    bannerUrl: row.banner_url,
    locationName: row.location_name,
    timezone: row.timezone,
    registrationOpensAt: optionalTimestamp(row.registration_opens_at, 'registration_opens_at'),
    registrationClosesAt: optionalTimestamp(row.registration_closes_at, 'registration_closes_at'),
    startsAt: optionalTimestamp(row.starts_at, 'starts_at'),
    endsAt: optionalTimestamp(row.ends_at, 'ends_at'),
    minimumAge: row.minimum_age === null ? null : Number(row.minimum_age),
    maxEntriesPerIdentity: Number(row.max_entries_per_identity),
    status: row.status as EventStatus,
    confirmationTitle: row.confirmation_title,
    confirmationMessage: row.confirmation_message,
    ineligibleTitle: row.ineligible_title,
    ineligibleMessage: row.ineligible_message,
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: assertTimestamp(row.created_at, 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'updated_at'),
    publishedAt: optionalTimestamp(row.published_at, 'published_at'),
    openedAt: optionalTimestamp(row.opened_at, 'opened_at'),
    closedAt: optionalTimestamp(row.closed_at, 'closed_at'),
    cancelledAt: optionalTimestamp(row.cancelled_at, 'cancelled_at'),
    archivedAt: optionalTimestamp(row.archived_at, 'archived_at'),
    // The version this event currently serves. Null until it has published one.
    publishedFormVersionId: row.published_form_version_id ?? null,
  };
}

export function eventToSummary(event: Event): EventSummary {
  return {
    id: event.id,
    slug: event.slug,
    name: event.name,
    status: event.status,
    timezone: event.timezone,
    registrationOpensAt: event.registrationOpensAt,
    startsAt: event.startsAt,
    revision: event.revision,
    updatedAt: event.updatedAt,
    archivedAt: event.archivedAt,
  };
}

/**
 * The registration contract of an event: the settings a submission is judged
 * against, and the ones a concurrent edit must not be allowed to change
 * underneath it.
 *
 * The window and the status are checked from the instant; these two are checked
 * by VALUE, because a decision computed from `minimum_age = 21` in
 * `America/New_York` is only meaningful if those were still the rules when it
 * was written down.
 */
export interface RegistrationRules {
  minimumAge: number | null;
  timezone: string;
}

/** Full column set for an insert. */
export interface EventInsertValues {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  bannerUrl: string | null;
  locationName: string | null;
  timezone: string;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  minimumAge: number | null;
  maxEntriesPerIdentity: number;
  status: EventStatus;
  confirmationTitle: string | null;
  confirmationMessage: string | null;
  ineligibleTitle: string | null;
  ineligibleMessage: string | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Column names that a patch may set, mapped from the domain field name. */
const UPDATABLE_COLUMNS: Record<string, string> = {
  name: 'name',
  slug: 'slug',
  description: 'description',
  bannerUrl: 'banner_url',
  locationName: 'location_name',
  timezone: 'timezone',
  registrationOpensAt: 'registration_opens_at',
  registrationClosesAt: 'registration_closes_at',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  minimumAge: 'minimum_age',
  maxEntriesPerIdentity: 'max_entries_per_identity',
  confirmationTitle: 'confirmation_title',
  confirmationMessage: 'confirmation_message',
  ineligibleTitle: 'ineligible_title',
  ineligibleMessage: 'ineligible_message',
};

export class EventRepository {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<Event | null> {
    const row = await this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<EventRow>();
    return row ? rowToEvent(row) : null;
  }

  async findBySlug(slug: string): Promise<Event | null> {
    const row = await this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE slug = ? LIMIT 1`)
      .bind(slug)
      .first<EventRow>();
    return row ? rowToEvent(row) : null;
  }

  async slugExists(slug: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM events WHERE slug = ? LIMIT 1')
      .bind(slug)
      .first<{ present: number }>();
    return row !== null;
  }

  /** Statement that inserts a new event. Combine with the audit statement. */
  insertStatement(values: EventInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO events
           (id, slug, name, description, banner_url, location_name, timezone,
            registration_opens_at, registration_closes_at, starts_at, ends_at,
            minimum_age, max_entries_per_identity, status,
            confirmation_title, confirmation_message, ineligible_title, ineligible_message,
            revision, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.slug,
        values.name,
        values.description,
        values.bannerUrl,
        values.locationName,
        values.timezone,
        values.registrationOpensAt,
        values.registrationClosesAt,
        values.startsAt,
        values.endsAt,
        values.minimumAge,
        values.maxEntriesPerIdentity,
        values.status,
        values.confirmationTitle,
        values.confirmationMessage,
        values.ineligibleTitle,
        values.ineligibleMessage,
        values.createdBy,
        values.updatedBy,
        values.createdAt,
        values.updatedAt,
      );
  }

  /**
   * Statement that applies a patch, guarded by the revision the caller read.
   *
   * `revision = revision + 1` and `WHERE revision = ?` together are the
   * lost-update protection: a writer working from a stale copy matches zero
   * rows instead of overwriting whatever landed in between.
   */
  updateStatement(
    id: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
    actorId: string,
    updatedAt: string,
  ): D1PreparedStatement {
    const assignments: string[] = [];
    const bindings: unknown[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const column = UPDATABLE_COLUMNS[field];
      // Unknown fields never reach SQL; the schema already rejected them, and
      // this map is the second gate.
      if (!column) continue;
      assignments.push(`${column} = ?`);
      bindings.push(value ?? null);
    }

    assignments.push('updated_by = ?', 'updated_at = ?', 'revision = revision + 1');
    bindings.push(actorId, updatedAt);

    return this.db
      .prepare(
        `UPDATE events SET ${assignments.join(', ')} WHERE id = ? AND revision = ?`,
      )
      .bind(...bindings, id, expectedRevision);
  }

  /** Statement that performs a state transition, guarded by revision. */
  transitionStatement(
    id: string,
    expectedRevision: number,
    status: EventStatus,
    timestampColumn: string | null,
    at: string,
    actorId: string,
  ): D1PreparedStatement {
    const assignments = ['status = ?', 'updated_by = ?', 'updated_at = ?'];
    const bindings: unknown[] = [status, actorId, at];

    if (timestampColumn) {
      // Only ever set once: re-archiving must not rewrite the original moment.
      assignments.push(`${timestampColumn} = COALESCE(${timestampColumn}, ?)`);
      bindings.push(at);
    }
    assignments.push('revision = revision + 1');

    return this.db
      .prepare(
        `UPDATE events SET ${assignments.join(', ')} WHERE id = ? AND revision = ?`,
      )
      .bind(...bindings, id, expectedRevision);
  }

  /**
   * Statement that takes a batch down unless the event is still accepting
   * entries AT THE MOMENT THE BATCH RUNS.
   *
   * Checking `status === 'OPEN'` in the service is necessary but not
   * sufficient: between that read and the commit, an operator can close the
   * event or its registration window can end. This is the same technique the
   * form guards use — writing NULL into a NOT NULL column is a guaranteed,
   * transactional failure — so a registration that loses that race writes
   * nothing at all rather than landing in a closed event.
   *
   * It modifies NOTHING when the event is still open: the WHERE clause matches
   * only the cases that must abort. The window semantics are the same ones
   * `entryWindowProblem` applies, and the comparisons are string comparisons
   * because the stored instants are fixed-width ISO.
   */
  abortUnlessAcceptingEntriesStatement(
    id: string,
    nowIso: string,
    rules: RegistrationRules,
  ): D1PreparedStatement {
    const clauses = [
      "status <> 'OPEN'",
      '(registration_opens_at IS NOT NULL AND registration_opens_at > ?)',
      '(registration_closes_at IS NOT NULL AND registration_closes_at <= ?)',
    ];
    const bindings: unknown[] = [nowIso, nowIso];

    {
      // The rules the DECISION was made from must still be the rules when it is
      // written. An operator raising the minimum age, or moving the event to
      // another timezone, between the evaluation and the commit would otherwise
      // leave a stored verdict that no configuration ever produced.
      //
      // Compared by VALUE, not by the event's revision: publishing a new form
      // version also bumps the revision, and a publication must not invalidate
      // a submission that already resolved a version correctly. These four
      // columns are exactly the registration contract, and nothing else.
      clauses.push(
        rules.minimumAge === null
          ? 'minimum_age IS NOT NULL'
          : '(minimum_age IS NULL OR minimum_age <> ?)',
      );
      if (rules.minimumAge !== null) bindings.push(rules.minimumAge);

      clauses.push('timezone <> ?');
      bindings.push(rules.timezone);
    }

    return this.db
      .prepare(`UPDATE events SET status = NULL WHERE id = ? AND (${clauses.join(' OR ')})`)
      .bind(id, ...bindings);
  }

  /** Statement that physically removes a draft, guarded by revision and status. */
  deleteStatement(id: string, expectedRevision: number): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM events WHERE id = ? AND revision = ? AND status = 'DRAFT'`,
      )
      .bind(id, expectedRevision);
  }

  /**
   * Reports whether anything depends on this event.
   *
   * Prizes count REGARDLESS of their status: an archived prize is still
   * configuration that belongs to this event, and deleting the event would
   * orphan it. A form draft counts for the same reason — it is the registration
   * flow someone built. A published VERSION counts most of all: it is the
   * record of what people were actually asked, and that survives permanently
   * even if the draft is ever removed. The audit trail deliberately does not
   * count: it must survive deletion by design.
   *
   * An ENTRY counts most of all, and counts explicitly rather than being left
   * to the published version that usually accompanies it: it is the record that
   * a real person took part, and it must be impossible to erase as a side
   * effect of tidying up an event.
   *
   * The database enforces all of them (`event_prizes.event_id`,
   * `event_form_drafts.event_id`, `event_form_versions.event_id` and
   * `event_entries.event_id` are RESTRICT); this check exists so the API can
   * answer with a typed refusal instead of letting a foreign-key error surface
   * as a 500.
   */
  async hasDependencies(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS present WHERE EXISTS (
           SELECT 1 FROM event_prizes WHERE event_id = ?
         ) OR EXISTS (
           SELECT 1 FROM event_form_drafts WHERE event_id = ?
         ) OR EXISTS (
           SELECT 1 FROM event_form_versions WHERE event_id = ?
         ) OR EXISTS (
           SELECT 1 FROM event_entries WHERE event_id = ?
         )`,
      )
      .bind(eventId, eventId, eventId, eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  async list(query: EventListQuery): Promise<{ items: EventSummary[]; total: number }> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (query.status) {
      clauses.push('status = ?');
      bindings.push(query.status);
    }

    // Archived events are operational history, not day-to-day work, so they are
    // excluded unless asked for.
    if (query.archived === 'active') {
      clauses.push("status <> 'ARCHIVED'");
    } else if (query.archived === 'archived') {
      clauses.push("status = 'ARCHIVED'");
    }

    if (query.search) {
      // LIKE treats `%` and `_` as wildcards, so a search for "%" would
      // otherwise match every row. They are escaped (along with the escape
      // character itself) and an explicit ESCAPE clause is declared, so the
      // term is matched literally.
      const escaped = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
      const like = `%${escaped}%`;
      clauses.push(
        `(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR slug LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      bindings.push(like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM events ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();
    const total = totalRow?.total ?? 0;

    const column = SORT_COLUMNS[query.sort] ?? SORT_COLUMNS.createdAt;
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';

    const rows = await this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events ${where}
         ORDER BY ${column} ${direction}, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, query.pageSize, (query.page - 1) * query.pageSize)
      .all<EventRow>();

    return {
      items: (rows.results ?? []).map((row) => eventToSummary(rowToEvent(row))),
      total,
    };
  }
}
