// Audit domain service.
//
// One entry point for writing history. It validates the action and entity
// type, redacts every payload, stamps identity/request/time, and persists.
//
// FAILURE POLICY — two explicit modes, because the right answer differs:
//
//   * `record()`     — BEST-EFFORT. Used for security events (login, logout).
//                      A failed audit write must never break authentication:
//                      refusing to log someone out because an INSERT failed
//                      would turn an observability problem into a security
//                      one. Failures are reported through the structured
//                      logger, never silently swallowed, and never surfaced to
//                      the client.
//
//   * `statementFor()` — CRITICAL. Returns a prepared statement so a caller can
//                      commit the audit row together with its operation in a
//                      single `db.batch([...])`. Later phases use this for
//                      draws and event mutations, where "it happened but was
//                      not recorded" is unacceptable.

import type {
  AuditAction,
  AuditEntityType,
  AuditListQuery,
  AuditLog,
  AuditWriteInput,
} from '../../shared/types';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../../shared/types';
import { AuditRepository, type AuditAppendInput } from './auditRepository';
import { redact, redactObject } from './redact';
import { serializeJson } from './json';
import { newId } from './ids';
import { nowIso } from './time';
import { describeError, logger } from './logger';
import type { RequestContext } from './requestContext';
import {
  AUDIT_ENTITY_ID_MAX_LENGTH,
  USER_AGENT_MAX_LENGTH,
} from '../../shared/limits';

const VALID_ACTIONS = new Set<string>(AUDIT_ACTIONS);
const VALID_ENTITY_TYPES = new Set<string>(AUDIT_ENTITY_TYPES);

export interface AuditRecordInput extends AuditWriteInput {
  requestContext: RequestContext;
}

export type AuditRecordResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_action' | 'invalid_entity_type' | 'write_failed' };

/**
 * Serializes a payload for storage after redaction.
 *
 * Returns null for absent values and for anything that cannot be represented
 * or is oversized — an audit row with a missing detail is far better than a
 * failed write that loses the event entirely.
 */
/** Truncates an optional string to a column's ceiling. */
function bound(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function prepareJsonColumn(
  value: unknown,
  field: string,
  requestId: string,
): string | null {
  if (value === null || value === undefined) return null;

  const serialized = serializeJson(redact(value));
  if (!serialized.ok) {
    logger.warn('audit payload dropped', {
      requestId,
      action: 'AUDIT_PAYLOAD_DROPPED',
      field,
      reason: serialized.reason,
    });
    return null;
  }
  return serialized.json;
}

export class AuditService {
  private readonly repository: AuditRepository;

  constructor(db: D1Database, repository?: AuditRepository) {
    this.repository = repository ?? new AuditRepository(db);
  }

  /** Builds the fully-redacted row without touching the database. */
  buildEntry(input: AuditRecordInput): AuditAppendInput | null {
    if (!VALID_ACTIONS.has(input.action)) return null;
    if (!VALID_ENTITY_TYPES.has(input.entityType)) return null;

    const { requestContext } = input;
    const requestId = requestContext.requestId;

    return {
      id: newId(),
      actorAdminId: input.actor?.id ?? null,
      action: input.action,
      entityType: input.entityType,
      // Bounded defensively. An unbounded identifier would either bloat an
      // append-only table or, once a column CHECK exists, fail the insert and
      // lose the event outright — truncating keeps the record.
      entityId: bound(input.entityId, AUDIT_ENTITY_ID_MAX_LENGTH),
      eventId: bound(input.eventId, AUDIT_ENTITY_ID_MAX_LENGTH),
      previousData: prepareJsonColumn(input.previousData, 'previousData', requestId),
      newData: prepareJsonColumn(input.newData, 'newData', requestId),
      metadata: prepareJsonColumn(redactObject(input.metadata), 'metadata', requestId),
      // Already a hash; the raw IP never reaches this layer.
      ipHash: requestContext.ipHash,
      // Re-truncated here rather than trusting the context: the column has a
      // 512-character CHECK, and an over-long value would fail the insert.
      userAgent: bound(requestContext.userAgent, USER_AGENT_MAX_LENGTH),
      requestId,
      createdAt: nowIso(),
    };
  }

  /**
   * BEST-EFFORT write. Never throws, never blocks the caller's operation.
   */
  async record(input: AuditRecordInput): Promise<AuditRecordResult> {
    const entry = this.buildEntry(input);

    if (!entry) {
      // A bad action/entity is a programming error, not a user input problem.
      logger.error('audit rejected: unknown action or entity type', {
        requestId: input.requestContext.requestId,
        action: String(input.action),
        entityType: String(input.entityType),
      });
      return {
        ok: false,
        reason: VALID_ACTIONS.has(input.action)
          ? 'invalid_entity_type'
          : 'invalid_action',
      };
    }

    try {
      await this.repository.append(entry);
      return { ok: true, id: entry.id };
    } catch (err) {
      // Surfaced loudly in logs, invisible to the client.
      logger.error('audit write failed', {
        requestId: entry.requestId,
        action: entry.action,
        entityType: entry.entityType,
        ...describeError(err),
      });
      return { ok: false, reason: 'write_failed' };
    }
  }

  /**
   * CRITICAL write. Returns a statement for inclusion in a `db.batch([...])`
   * so the audit row commits atomically with the operation it describes.
   *
   * `onlyIfPreviousChanged` makes the insert conditional on the preceding
   * statement in the batch having modified a row — use it after a guarded
   * mutation, so a revision conflict does not leave behind an audit entry for
   * a change that never occurred.
   */
  statementFor(
    input: AuditRecordInput,
    options: { onlyIfPreviousChanged?: boolean } = {},
  ): D1PreparedStatement {
    const entry = this.buildEntry(input);
    if (!entry) {
      throw new TypeError(
        `Unknown audit action "${input.action}" or entity type "${input.entityType}"`,
      );
    }
    return options.onlyIfPreviousChanged
      ? this.repository.appendStatementIfChanged(entry)
      : this.repository.appendStatement(entry);
  }

  findById(id: string): Promise<AuditLog | null> {
    return this.repository.findById(id);
  }

  list(query: AuditListQuery): Promise<{ items: AuditLog[]; total: number }> {
    return this.repository.list(query);
  }
}

/** Type guards used by the query parser and the API layer. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && VALID_ACTIONS.has(value);
}

export function isAuditEntityType(value: unknown): value is AuditEntityType {
  return typeof value === 'string' && VALID_ENTITY_TYPES.has(value);
}
