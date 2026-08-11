// Persistence for `event_prizes`.
//
// Mutating statements are returned PREPARED, never executed, so the service can
// commit them in one `db.batch()` together with the audit row.
//
// Every value reaches SQL through `.bind()`. Sorting resolves through a fixed
// map, so no client string ever becomes a column name.

import type {
  EventPrize,
  EventPrizeListQuery,
  EventPrizeSummary,
  EventPrizeSummaryCounts,
  PrizeSortKey,
  PrizeStatus,
} from '../../shared/types';
import { PRIZE_STATUSES } from '../../shared/prizeLifecycle';
import {
  PRIZE_QUANTITY_MAX,
  PRIZE_QUANTITY_MIN,
  PRIZE_SORT_PARK_OFFSET,
  PRIZES_PER_EVENT_MAX,
} from '../../shared/limits';
import { isIsoTimestamp } from './time';

export interface EventPrizeRow {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  quantity: number;
  sort_order: number;
  status: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const PRIZE_COLUMNS = `id, event_id, name, description, image_url, quantity, sort_order,
  status, revision, created_by, updated_by, created_at, updated_at, archived_at`;

const VALID_STATUSES = new Set<string>(PRIZE_STATUSES);

const SORT_COLUMNS: Record<PrizeSortKey, string> = {
  sortOrder: 'sort_order',
  name: 'name',
  quantity: 'quantity',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`event_prizes.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

function boundedInteger(value: number, column: string, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new TypeError(
      `event_prizes.${column} is outside its allowed range (${min}-${max}): ${value}`,
    );
  }
  return numeric;
}

/**
 * Maps a row to the domain shape.
 *
 * Strict on purpose: an unknown status, an out-of-range number, a malformed
 * timestamp or an archived/timestamp mismatch THROWS rather than flowing on.
 * The column CHECKs are the first line of defence; this is the second, for
 * rows a migration or a console session could have written.
 */
export function rowToEventPrize(row: EventPrizeRow): EventPrize {
  if (!VALID_STATUSES.has(row.status)) {
    throw new TypeError(`event_prizes.status holds an unknown value: ${row.status}`);
  }
  if (!row.id || !row.event_id) {
    throw new TypeError('event_prizes row is missing its identifiers');
  }

  boundedInteger(row.quantity, 'quantity', PRIZE_QUANTITY_MIN, PRIZE_QUANTITY_MAX);
  // The parking range is a legitimate transient value mid-batch, so the ceiling
  // here allows it while still rejecting nonsense. Deliberately the SAME bound
  // the column's CHECK carries, so the two cannot drift apart.
  boundedInteger(row.sort_order, 'sort_order', 0, PRIZE_SORT_PARK_OFFSET + PRIZES_PER_EVENT_MAX);
  boundedInteger(row.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);

  const archivedAt = row.archived_at === null ? null : assertTimestamp(row.archived_at, 'archived_at');
  // Status and its timestamp must agree; a mismatch means the row is not
  // trustworthy about its own history.
  if ((row.status === 'ARCHIVED') !== (archivedAt !== null)) {
    throw new TypeError(
      `event_prizes.archived_at disagrees with status ${row.status}`,
    );
  }

  if (row.image_url !== null && row.image_url.length > 0) {
    // A stored scheme other than http/https can only have arrived outside the
    // application, and must never reach an href.
    const lowered = row.image_url.toLowerCase();
    if (!lowered.startsWith('http://') && !lowered.startsWith('https://')) {
      throw new TypeError('event_prizes.image_url holds a non-http(s) value');
    }
  }

  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url,
    quantity: Number(row.quantity),
    sortOrder: Number(row.sort_order),
    status: row.status as PrizeStatus,
    revision: Number(row.revision),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: assertTimestamp(row.created_at, 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'updated_at'),
    archivedAt,
  };
}

export function prizeToSummary(prize: EventPrize): EventPrizeSummary {
  return {
    id: prize.id,
    name: prize.name,
    imageUrl: prize.imageUrl,
    quantity: prize.quantity,
    sortOrder: prize.sortOrder,
    status: prize.status,
    revision: prize.revision,
    updatedAt: prize.updatedAt,
  };
}

export interface PrizeInsertValues {
  id: string;
  eventId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  quantity: number;
  sortOrder: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Patch fields mapped to their columns. Nothing outside this map is writable. */
const UPDATABLE_COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  imageUrl: 'image_url',
  quantity: 'quantity',
};

export class PrizeRepository {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<EventPrize | null> {
    const row = await this.db
      .prepare(`SELECT ${PRIZE_COLUMNS} FROM event_prizes WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<EventPrizeRow>();
    return row ? rowToEventPrize(row) : null;
  }

  /**
   * Scoped lookup. Every handler uses THIS, never `findById`, so a prize id
   * from another event cannot be operated on by guessing it (IDOR).
   */
  async findByEventAndId(eventId: string, prizeId: string): Promise<EventPrize | null> {
    const row = await this.db
      .prepare(
        `SELECT ${PRIZE_COLUMNS} FROM event_prizes WHERE id = ? AND event_id = ? LIMIT 1`,
      )
      .bind(prizeId, eventId)
      .first<EventPrizeRow>();
    return row ? rowToEventPrize(row) : null;
  }

  /** Every non-archived prize of an event, in display order. */
  async listLiveByEvent(eventId: string): Promise<EventPrize[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${PRIZE_COLUMNS} FROM event_prizes
         WHERE event_id = ? AND status <> 'ARCHIVED'
         ORDER BY sort_order ASC, id ASC`,
      )
      .bind(eventId)
      .all<EventPrizeRow>();
    return (rows.results ?? []).map(rowToEventPrize);
  }

  /**
   * The prizes actually on offer, in display order.
   *
   * ACTIVE only — narrower than `listLiveByEvent`, which also returns INACTIVE.
   * That distinction is the whole point: INACTIVE is an operator parking a
   * prize they are still deciding about, and the administrative list must show
   * it while the public page must not advertise it.
   */
  async listActiveByEvent(eventId: string): Promise<EventPrize[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${PRIZE_COLUMNS} FROM event_prizes
         WHERE event_id = ? AND status = 'ACTIVE'
         ORDER BY sort_order ASC, id ASC`,
      )
      .bind(eventId)
      .all<EventPrizeRow>();
    return (rows.results ?? []).map(rowToEventPrize);
  }

  /** Total prizes on an event, archived included (the per-event limit). */
  async countByEvent(eventId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS total FROM event_prizes WHERE event_id = ?')
      .bind(eventId)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  /** Counts and unit total for the admin summary. */
  async summarize(eventId: string): Promise<EventPrizeSummaryCounts> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) AS inactive,
           SUM(CASE WHEN status = 'ARCHIVED' THEN 1 ELSE 0 END) AS archived,
           SUM(CASE WHEN status = 'ACTIVE' THEN quantity ELSE 0 END) AS units
         FROM event_prizes WHERE event_id = ?`,
      )
      .bind(eventId)
      .first<{
        total: number;
        active: number | null;
        inactive: number | null;
        archived: number | null;
        units: number | null;
      }>();

    return {
      totalPrizes: Number(row?.total ?? 0),
      activePrizes: Number(row?.active ?? 0),
      inactivePrizes: Number(row?.inactive ?? 0),
      archivedPrizes: Number(row?.archived ?? 0),
      totalActiveUnits: Number(row?.units ?? 0),
    };
  }

  /** Units across ACTIVE prizes — the DRAW_READY precondition. */
  async countActiveUnits(eventId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS units
         FROM event_prizes WHERE event_id = ? AND status = 'ACTIVE'`,
      )
      .bind(eventId)
      .first<{ units: number }>();
    return Number(row?.units ?? 0);
  }

  /** Next free position, ignoring archived prizes (they left the ordering). */
  async nextSortOrder(eventId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
         FROM event_prizes WHERE event_id = ? AND status <> 'ARCHIVED'`,
      )
      .bind(eventId)
      .first<{ next: number }>();
    return Number(row?.next ?? 0);
  }

  /**
   * Whether anything downstream depends on this prize.
   *
   * THE SEAM PHASE 4 LEFT, NOW FILLED. Until `draw_assignments` existed the
   * honest answer was `false`, and this method returned it without pretending to
   * check a table that was not there. The table exists now, so it asks.
   *
   * A prize somebody won cannot be deleted, ever. `draw_assignments.prize_id` is
   * RESTRICT, so the database refuses it too; this exists so the API can answer
   * with a typed refusal instead of letting a foreign-key error surface as a
   * 500 — and so the UI can hide a button the server would reject.
   */
  async hasAssignments(prizeId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM draw_assignments WHERE prize_id = ? LIMIT 1')
      .bind(prizeId)
      .first<{ present: number }>();
    return row !== null;
  }

  insertStatement(values: PrizeInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO event_prizes
           (id, event_id, name, description, image_url, quantity, sort_order,
            status, revision, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.eventId,
        values.name,
        values.description,
        values.imageUrl,
        values.quantity,
        values.sortOrder,
        values.createdBy,
        values.updatedBy,
        values.createdAt,
        values.updatedAt,
      );
  }

  /** Guarded patch; matches zero rows when the revision moved on. */
  updateStatement(
    eventId: string,
    prizeId: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
    actorId: string,
    updatedAt: string,
  ): D1PreparedStatement {
    const assignments: string[] = [];
    const bindings: unknown[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const column = UPDATABLE_COLUMNS[field];
      if (!column) continue; // never trust a key the map does not know
      assignments.push(`${column} = ?`);
      bindings.push(value ?? null);
    }
    assignments.push('updated_by = ?', 'updated_at = ?', 'revision = revision + 1');
    bindings.push(actorId, updatedAt);

    return this.db
      .prepare(
        `UPDATE event_prizes SET ${assignments.join(', ')}
         WHERE id = ? AND event_id = ? AND revision = ? AND status <> 'ARCHIVED'`,
      )
      .bind(...bindings, prizeId, eventId, expectedRevision);
  }

  /**
   * Guarded status change.
   *
   * `fromStatus` is part of the WHERE, so a repeated activate/deactivate
   * matches nothing instead of quietly bumping the revision.
   */
  statusStatement(
    eventId: string,
    prizeId: string,
    expectedRevision: number,
    fromStatus: PrizeStatus,
    toStatus: PrizeStatus,
    actorId: string,
    at: string,
  ): D1PreparedStatement {
    const archivedAt = toStatus === 'ARCHIVED' ? at : null;
    return this.db
      .prepare(
        `UPDATE event_prizes
         SET status = ?, archived_at = ?, updated_by = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND event_id = ? AND revision = ? AND status = ?`,
      )
      .bind(toStatus, archivedAt, actorId, at, prizeId, eventId, expectedRevision, fromStatus);
  }

  deleteStatement(
    eventId: string,
    prizeId: string,
    expectedRevision: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM event_prizes
         WHERE id = ? AND event_id = ? AND revision = ? AND status <> 'ARCHIVED'`,
      )
      .bind(prizeId, eventId, expectedRevision);
  }

  /**
   * Statements for a whole reorder, in two passes with a guard between them.
   *
   * The partial UNIQUE index on (event_id, sort_order) is checked per statement,
   * so writing final positions directly would collide the moment two prizes
   * swap. Pass one parks every prize at a position no real prize can hold; pass
   * two writes the final values against now-empty slots. Both passes run in one
   * batch, so the parked state is never observable.
   *
   * Only the FIRST pass carries the revision guard; the second matches on the
   * parked position, which only the first pass could have set.
   *
   * BETWEEN THE PASSES sits an abort guard. Without it, a prize whose revision
   * moved between the service's pre-check and this batch simply fails to park,
   * and the remaining prizes still settle — committing a PARTIAL reorder (plus
   * its audit row) that the service then reports as a conflict. The guard turns
   * that into what it must be: nothing at all.
   */
  reorderStatements(
    eventId: string,
    items: Array<{ prizeId: string; expectedRevision: number; sortOrder: number }>,
    actorId: string,
    at: string,
  ): D1PreparedStatement[] {
    const park = items.map((item, index) =>
      this.db
        .prepare(
          `UPDATE event_prizes SET sort_order = ?
           WHERE id = ? AND event_id = ? AND revision = ? AND status <> 'ARCHIVED'`,
        )
        .bind(PRIZE_SORT_PARK_OFFSET + index, item.prizeId, eventId, item.expectedRevision),
    );

    /**
     * Aborts the batch unless EVERY prize parked.
     *
     * Writing NULL into a NOT NULL column is a deliberate, guaranteed failure:
     * SQLite raises, the batch's transaction rolls back, and neither the moved
     * positions nor the audit row survive. When all parks landed, the count
     * equals the payload length and this matches no rows at all.
     *
     * The all-missed case (count 0) needs no abort: nothing parked, so nothing
     * settles either, and the batch commits empty — which the service reports
     * as a conflict on its own.
     */
    const guard = this.db
      .prepare(
        `UPDATE event_prizes SET sort_order = NULL
         WHERE event_id = ? AND sort_order >= ?
           AND (SELECT COUNT(*) FROM event_prizes
                WHERE event_id = ? AND sort_order >= ?) <> ?`,
      )
      .bind(eventId, PRIZE_SORT_PARK_OFFSET, eventId, PRIZE_SORT_PARK_OFFSET, items.length);

    const settle = items.map((item, index) =>
      this.db
        .prepare(
          `UPDATE event_prizes
           SET sort_order = ?, updated_by = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND event_id = ? AND sort_order = ?`,
        )
        .bind(
          item.sortOrder,
          actorId,
          at,
          item.prizeId,
          eventId,
          PRIZE_SORT_PARK_OFFSET + index,
        ),
    );

    return [...park, guard, ...settle];
  }

  async list(
    eventId: string,
    query: EventPrizeListQuery,
  ): Promise<{ items: EventPrizeSummary[]; total: number }> {
    const clauses = ['event_id = ?'];
    const bindings: unknown[] = [eventId];

    if (query.status) {
      clauses.push('status = ?');
      bindings.push(query.status);
    }
    // Archived prizes are history; they stay out unless asked for.
    if (query.archived === 'active') clauses.push("status <> 'ARCHIVED'");
    else if (query.archived === 'archived') clauses.push("status = 'ARCHIVED'");

    if (query.search) {
      // `%` and `_` are LIKE wildcards; escaped so the term matches literally.
      const escaped = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
      const like = `%${escaped}%`;
      clauses.push(
        `(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR description LIKE ? ESCAPE '\\' COLLATE NOCASE)`,
      );
      bindings.push(like, like);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM event_prizes ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();
    const total = totalRow?.total ?? 0;

    const column = SORT_COLUMNS[query.sort] ?? SORT_COLUMNS.sortOrder;
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC';

    const rows = await this.db
      .prepare(
        `SELECT ${PRIZE_COLUMNS} FROM event_prizes ${where}
         ORDER BY ${column} ${direction}, id ASC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, query.pageSize, (query.page - 1) * query.pageSize)
      .all<EventPrizeRow>();

    return {
      items: (rows.results ?? []).map((row) => prizeToSummary(rowToEventPrize(row))),
      total,
    };
  }
}
