// Persistence for `audit_logs`.
//
// APPEND-ONLY BY CONSTRUCTION: this class exposes `append`, `list` and
// `findById` and nothing else. There is no `update` and no `delete`, so no
// caller — present or future — can rewrite history through the application.
//
// Every value reaches SQL through `.bind()`. Filters are assembled from a fixed
// set of clauses; no client string is ever interpolated into the statement.

import type {
  AuditAction,
  AuditEntityType,
  AuditListQuery,
  AuditLog,
} from '../../shared/types';
import { parseJsonOrNull } from './json';
import { assertIsoTimestamp } from './time';

export interface AuditLogRow {
  id: string;
  actor_admin_id: string | null;
  action: AuditAction;
  entity_type: AuditEntityType;
  entity_id: string | null;
  event_id: string | null;
  previous_data: string | null;
  new_data: string | null;
  metadata: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  request_id: string;
  created_at: string;
}

/** Row shape of the listing query, which joins the actor for display. */
interface AuditLogJoinedRow extends AuditLogRow {
  actor_email: string | null;
  actor_display_name: string | null;
}

const AUDIT_COLUMNS = `a.id, a.actor_admin_id, a.action, a.entity_type, a.entity_id,
  a.event_id, a.previous_data, a.new_data, a.metadata, a.ip_hash, a.user_agent,
  a.request_id, a.created_at`;

const AUDIT_SELECT = `SELECT ${AUDIT_COLUMNS},
    u.email        AS actor_email,
    u.display_name AS actor_display_name
  FROM audit_logs a
  LEFT JOIN admin_users u ON u.id = a.actor_admin_id`;

/**
 * Maps a row to the API shape.
 *
 * JSON columns go through `parseJsonOrNull`, so a corrupt or truncated column
 * degrades to `null` and the entry still renders — an unreadable metadata blob
 * must not make the whole audit page fail.
 */
export function rowToAuditLog(row: AuditLogJoinedRow | AuditLogRow): AuditLog {
  const joined = row as AuditLogJoinedRow;
  return {
    id: row.id,
    actorAdminId: row.actor_admin_id,
    actorEmail: joined.actor_email ?? null,
    actorDisplayName: joined.actor_display_name ?? null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventId: row.event_id,
    previousData: parseJsonOrNull(row.previous_data),
    newData: parseJsonOrNull(row.new_data),
    metadata: parseJsonOrNull(row.metadata),
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** Fully-formed row, ready to insert. Produced by AuditService. */
export interface AuditAppendInput {
  id: string;
  actorAdminId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string | null;
  eventId: string | null;
  previousData: string | null;
  newData: string | null;
  metadata: string | null;
  ipHash: string | null;
  userAgent: string | null;
  requestId: string;
  createdAt: string;
}

const INSERT_SQL = `INSERT INTO audit_logs
    (id, actor_admin_id, action, entity_type, entity_id, event_id,
     previous_data, new_data, metadata, ip_hash, user_agent, request_id, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function bindValues(input: AuditAppendInput): unknown[] {
  return [
    input.id,
    input.actorAdminId,
    input.action,
    input.entityType,
    input.entityId,
    input.eventId,
    input.previousData,
    input.newData,
    input.metadata,
    input.ipHash,
    input.userAgent,
    input.requestId,
    assertIsoTimestamp(input.createdAt, 'createdAt'),
  ];
}

export class AuditRepository {
  constructor(private readonly db: D1Database) {}

  /** Writes one entry. The only mutating operation this class offers. */
  async append(input: AuditAppendInput): Promise<void> {
    await this.db
      .prepare(INSERT_SQL)
      .bind(...bindValues(input))
      .run();
  }

  /**
   * Returns a prepared statement instead of executing it.
   *
   * This is the seam for CRITICAL auditing: a caller puts the audit insert and
   * its business operation into a single `db.batch([...])` so they commit
   * together, rather than leaving a gap where the action happened but the
   * record of it did not.
   */
  appendStatement(input: AuditAppendInput): D1PreparedStatement {
    return this.db.prepare(INSERT_SQL).bind(...bindValues(input));
  }

  /**
   * Like `appendStatement`, but writes nothing unless the IMMEDIATELY PRECEDING
   * statement in the same batch modified at least one row.
   *
   * Needed because a guarded mutation (`UPDATE ... WHERE revision = ?`) can
   * legitimately match zero rows when another writer got there first. Without
   * this, the batch would still commit an audit entry describing a change that
   * never happened. `changes()` reports the row count of the previous
   * statement, and both run inside the batch's single transaction.
   */
  appendStatementIfChanged(input: AuditAppendInput): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_admin_id, action, entity_type, entity_id, event_id,
            previous_data, new_data, metadata, ip_hash, user_agent, request_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE changes() > 0`,
      )
      .bind(...bindValues(input));
  }

  async findById(id: string): Promise<AuditLog | null> {
    const row = await this.db
      .prepare(`${AUDIT_SELECT} WHERE a.id = ? LIMIT 1`)
      .bind(id)
      .first<AuditLogJoinedRow>();
    return row ? rowToAuditLog(row) : null;
  }

  /**
   * Filtered, paginated listing, newest first.
   *
   * Clauses are appended from a closed set and the bindings are collected
   * alongside them, keeping the statement and its parameters in lockstep.
   */
  async list(query: AuditListQuery): Promise<{ items: AuditLog[]; total: number }> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];

    if (query.actorAdminId) {
      clauses.push('a.actor_admin_id = ?');
      bindings.push(query.actorAdminId);
    }
    if (query.action) {
      clauses.push('a.action = ?');
      bindings.push(query.action);
    }
    if (query.entityType) {
      clauses.push('a.entity_type = ?');
      bindings.push(query.entityType);
    }
    if (query.entityId) {
      clauses.push('a.entity_id = ?');
      bindings.push(query.entityId);
    }
    if (query.eventId) {
      clauses.push('a.event_id = ?');
      bindings.push(query.eventId);
    }
    // Both bounds compare as strings, which is chronological because every
    // stored timestamp is fixed-width ISO.
    if (query.from) {
      clauses.push('a.created_at >= ?');
      bindings.push(query.from);
    }
    if (query.to) {
      clauses.push('a.created_at <= ?');
      bindings.push(query.to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM audit_logs a ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();
    const total = totalRow?.total ?? 0;

    // `id DESC` breaks ties, which is what makes paging correct when several
    // rows share a millisecond: without it SQLite may order equal keys
    // differently per query and a row could repeat or vanish between pages.
    //
    // That is the ONLY stability guarantee here. This is offset pagination, so
    // rows arriving between two page requests shift the window: because the
    // order is newest-first, a new row pushes everything down and page 2 will
    // re-show entries the caller already saw on page 1. No row is lost from the
    // table, but the traversal is not a consistent snapshot. Bound the window
    // with `to` when a stable traversal matters.
    const rows = await this.db
      .prepare(
        `${AUDIT_SELECT} ${where}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, query.pageSize, (query.page - 1) * query.pageSize)
      .all<AuditLogJoinedRow>();

    return { items: (rows.results ?? []).map(rowToAuditLog), total };
  }
}
