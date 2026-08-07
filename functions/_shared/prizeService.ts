// Prize domain service.
//
// All policy lives here: what the event's state permits, revision guards,
// per-event limits, reordering and deletion safety. HTTP handlers only
// translate its typed results.
//
// ATOMICITY: every mutation commits with its audit row in one `db.batch()`.
// Where the mutation is revision-guarded, the audit statement is conditional on
// that guard having matched, so a lost race leaves no record of a change that
// did not happen.

import type {
  CreateEventPrizeInput,
  Event,
  EventPrize,
  EventPrizeListQuery,
  ReorderEventPrizeItem,
  UpdateEventPrizeInput,
  AuditAction,
  AuthenticatedAdmin,
  PrizeTransitionAction,
} from '../../shared/types';
import {
  PRIZE_ACTION_SOURCES,
  PRIZE_ACTION_TARGET,
  editableFieldsFor,
  eventAllows,
  type PrizeEditableField,
} from '../../shared/prizeLifecycle';
import { PRIZES_PER_EVENT_MAX } from '../../shared/limits';
import { PrizeRepository, type PrizeInsertValues } from './prizeRepository';
import { EventRepository } from './eventRepository';
import { AuditService } from './auditService';
import { newId } from './ids';
import { nowIso } from './time';
import type { RequestContext } from './requestContext';

export type PrizeFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'PRIZE_NOT_FOUND' }
  | { code: 'PRIZE_EVENT_NOT_EDITABLE'; eventStatus: string; capability: string }
  | { code: 'PRIZE_CANNOT_BE_EDITED'; fields: string[] }
  | { code: 'PRIZE_INVALID_STATUS'; from: string; action: PrizeTransitionAction }
  | { code: 'PRIZE_ALREADY_ARCHIVED' }
  | { code: 'PRIZE_CANNOT_BE_DELETED'; reason: string }
  | { code: 'PRIZE_LIMIT_REACHED'; limit: number }
  | { code: 'PRIZE_REVISION_CONFLICT' }
  | { code: 'PRIZE_REORDER_CONFLICT' }
  | { code: 'PRIZE_ORDER_INVALID'; reason: string };

export type PrizeResult<T> = { ok: true; value: T } | { ok: false; failure: PrizeFailure };

const ACTION_AUDIT: Record<PrizeTransitionAction, AuditAction> = {
  activate: 'PRIZE_ACTIVATED',
  deactivate: 'PRIZE_DEACTIVATED',
  archive: 'PRIZE_ARCHIVED',
};

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

export class PrizeService {
  private readonly prizes: PrizeRepository;
  private readonly events: EventRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: { prizes?: PrizeRepository; events?: EventRepository; audit?: AuditService },
  ) {
    this.prizes = deps?.prizes ?? new PrizeRepository(db);
    this.events = deps?.events ?? new EventRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  get repository(): PrizeRepository {
    return this.prizes;
  }

  // -------------------------------------------------------------------------
  // Shared loading + guards
  // -------------------------------------------------------------------------

  /**
   * Loads the event and the prize together, scoped.
   *
   * The prize is always fetched BY EVENT: a prize id belonging to another event
   * resolves to "not found", never to someone else's row.
   */
  private async load(
    eventId: string,
    prizeId?: string,
  ): Promise<
    | { ok: true; event: Event; prize: EventPrize | null }
    | { ok: false; failure: PrizeFailure }
  > {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    if (prizeId === undefined) return { ok: true, event, prize: null };

    const prize = await this.prizes.findByEventAndId(eventId, prizeId);
    if (!prize) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };
    return { ok: true, event, prize };
  }

  private requireCapability(
    event: Event,
    capability: Parameters<typeof eventAllows>[1],
  ): PrizeFailure | null {
    return eventAllows(event.status, capability)
      ? null
      : {
          code: 'PRIZE_EVENT_NOT_EDITABLE',
          eventStatus: event.status,
          capability,
        };
  }

  private auditFor(
    action: AuditAction,
    prizeId: string,
    eventId: string,
    actor: Actor,
    previousData: unknown,
    newData: unknown,
    metadata?: Record<string, unknown>,
  ) {
    return {
      action,
      entityType: 'PRIZE' as const,
      entityId: prizeId,
      eventId,
      actor: {
        id: actor.admin.id,
        email: actor.admin.email,
        displayName: actor.admin.displayName,
      },
      requestContext: actor.requestContext,
      previousData,
      newData,
      metadata: metadata ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(eventId: string, query: EventPrizeListQuery) {
    return this.prizes.list(eventId, query);
  }

  async summarize(eventId: string) {
    return this.prizes.summarize(eventId);
  }

  async findPrize(eventId: string, prizeId: string): Promise<EventPrize | null> {
    return this.prizes.findByEventAndId(eventId, prizeId);
  }

  async findEvent(eventId: string): Promise<Event | null> {
    return this.events.findById(eventId);
  }

  /** Why a prize cannot be deleted, or null when it can. */
  async deletionBlocker(event: Event, prize: EventPrize): Promise<string | null> {
    if (!eventAllows(event.status, 'delete')) return 'event_not_editable';
    if (prize.status === 'ARCHIVED') return 'archived';
    if (await this.prizes.hasAssignments(prize.id)) return 'has_assignments';
    return null;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(
    eventId: string,
    input: CreateEventPrizeInput,
    actor: Actor,
  ): Promise<PrizeResult<EventPrize>> {
    const loaded = await this.load(eventId);
    if (!loaded.ok) return loaded;

    const denied = this.requireCapability(loaded.event, 'create');
    if (denied) return { ok: false, failure: denied };

    const existing = await this.prizes.countByEvent(eventId);
    if (existing >= PRIZES_PER_EVENT_MAX) {
      return { ok: false, failure: { code: 'PRIZE_LIMIT_REACHED', limit: PRIZES_PER_EVENT_MAX } };
    }

    const at = nowIso();
    const sortOrder = input.sortOrder ?? (await this.prizes.nextSortOrder(eventId));

    const values: PrizeInsertValues = {
      id: newId(),
      eventId,
      name: input.name,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      quantity: input.quantity,
      sortOrder,
      createdBy: actor.admin.id,
      updatedBy: actor.admin.id,
      createdAt: at,
      updatedAt: at,
    };

    try {
      await this.db.batch([
        this.prizes.insertStatement(values),
        this.audit.statementFor(
          this.auditFor('PRIZE_CREATED', values.id, eventId, actor, null, values),
        ),
      ]);
    } catch (err) {
      // The partial UNIQUE index is authoritative: two concurrent creates can
      // compute the same next position, and the loser is told to retry rather
      // than silently landing on a duplicate slot.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message) && /sort_order|event_position/i.test(message)) {
        return { ok: false, failure: { code: 'PRIZE_REORDER_CONFLICT' } };
      }
      throw err;
    }

    const created = await this.prizes.findById(values.id);
    if (!created) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };
    return { ok: true, value: created };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    eventId: string,
    prizeId: string,
    input: UpdateEventPrizeInput,
    actor: Actor,
  ): Promise<PrizeResult<EventPrize>> {
    const loaded = await this.load(eventId, prizeId);
    if (!loaded.ok) return loaded;
    const { event, prize } = loaded;
    if (!prize) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };

    const { expectedRevision, ...patch } = input;
    if (prize.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }
    if (prize.status === 'ARCHIVED') {
      return { ok: false, failure: { code: 'PRIZE_ALREADY_ARCHIVED' } };
    }

    // The allowed set narrows as the event progresses: renaming stays possible
    // while OPEN, changing how many units exist does not.
    const allowed = editableFieldsFor(event.status, prize.status);
    const requested = Object.keys(patch) as PrizeEditableField[];
    const forbidden = requested.filter((field) => !allowed.includes(field));
    if (forbidden.length > 0) {
      // Reported, never silently dropped — an operator must not believe a
      // change saved when it did not.
      return { ok: false, failure: { code: 'PRIZE_CANNOT_BE_EDITED', fields: forbidden } };
    }

    const at = nowIso();
    const results = await this.db.batch([
      this.prizes.updateStatement(
        eventId,
        prizeId,
        expectedRevision,
        patch as Record<string, unknown>,
        actor.admin.id,
        at,
      ),
      this.audit.statementFor(
        this.auditFor('PRIZE_UPDATED', prizeId, eventId, actor, prize, {
          ...prize,
          ...patch,
          updatedAt: at,
          revision: prize.revision + 1,
        }),
        { onlyIfPreviousChanged: true },
      ),
    ]);

    if ((results[0]?.meta?.changes ?? 0) === 0) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }

    const updated = await this.prizes.findByEventAndId(eventId, prizeId);
    if (!updated) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };
    return { ok: true, value: updated };
  }

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  async transition(
    eventId: string,
    prizeId: string,
    action: PrizeTransitionAction,
    actor: Actor,
    expectedRevision?: number,
  ): Promise<PrizeResult<EventPrize>> {
    const loaded = await this.load(eventId, prizeId);
    if (!loaded.ok) return loaded;
    const { event, prize } = loaded;
    if (!prize) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };

    if (expectedRevision !== undefined && prize.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }

    const denied = this.requireCapability(event, action);
    if (denied) return { ok: false, failure: denied };

    if (!PRIZE_ACTION_SOURCES[action].includes(prize.status)) {
      // Repeating an action lands here: activating an already-active prize is a
      // typed refusal, not a silent revision bump.
      return {
        ok: false,
        failure:
          prize.status === 'ARCHIVED'
            ? { code: 'PRIZE_ALREADY_ARCHIVED' }
            : { code: 'PRIZE_INVALID_STATUS', from: prize.status, action },
      };
    }

    const target = PRIZE_ACTION_TARGET[action];
    const at = nowIso();

    const results = await this.db.batch([
      this.prizes.statusStatement(
        eventId,
        prizeId,
        prize.revision,
        prize.status,
        target,
        actor.admin.id,
        at,
      ),
      this.audit.statementFor(
        this.auditFor(
          ACTION_AUDIT[action],
          prizeId,
          eventId,
          actor,
          { status: prize.status, revision: prize.revision },
          { status: target, revision: prize.revision + 1 },
          { action },
        ),
        { onlyIfPreviousChanged: true },
      ),
    ]);

    if ((results[0]?.meta?.changes ?? 0) === 0) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }

    const updated = await this.prizes.findByEventAndId(eventId, prizeId);
    if (!updated) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };
    return { ok: true, value: updated };
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async remove(
    eventId: string,
    prizeId: string,
    actor: Actor,
    expectedRevision?: number,
  ): Promise<PrizeResult<{ id: string }>> {
    const loaded = await this.load(eventId, prizeId);
    if (!loaded.ok) return loaded;
    const { event, prize } = loaded;
    if (!prize) return { ok: false, failure: { code: 'PRIZE_NOT_FOUND' } };

    if (expectedRevision !== undefined && prize.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }

    const blocker = await this.deletionBlocker(event, prize);
    if (blocker === 'event_not_editable') {
      return {
        ok: false,
        failure: {
          code: 'PRIZE_EVENT_NOT_EDITABLE',
          eventStatus: event.status,
          capability: 'delete',
        },
      };
    }
    if (blocker) {
      return { ok: false, failure: { code: 'PRIZE_CANNOT_BE_DELETED', reason: blocker } };
    }

    const results = await this.db.batch([
      this.prizes.deleteStatement(eventId, prizeId, prize.revision),
      this.audit.statementFor(
        // The row is about to disappear, so the audit entry carries the whole
        // snapshot — it becomes the only remaining evidence it existed.
        this.auditFor('PRIZE_DELETED', prizeId, eventId, actor, prize, null, {
          name: prize.name,
          quantity: prize.quantity,
        }),
        { onlyIfPreviousChanged: true },
      ),
    ]);

    if ((results[0]?.meta?.changes ?? 0) === 0) {
      return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
    }
    return { ok: true, value: { id: prizeId } };
  }

  // -------------------------------------------------------------------------
  // Reorder
  // -------------------------------------------------------------------------

  /**
   * Applies a complete new ordering.
   *
   * The payload must describe EVERY live prize of the event: a partial reorder
   * would leave the remaining prizes on positions that could collide with the
   * new ones, and there is no sensible way to infer where they should go.
   */
  async reorder(
    eventId: string,
    items: ReorderEventPrizeItem[],
    actor: Actor,
  ): Promise<PrizeResult<EventPrize[]>> {
    const loaded = await this.load(eventId);
    if (!loaded.ok) return loaded;

    const denied = this.requireCapability(loaded.event, 'reorder');
    if (denied) return { ok: false, failure: denied };

    const live = await this.prizes.listLiveByEvent(eventId);
    const liveIds = new Set(live.map((prize) => prize.id));

    for (const item of items) {
      if (!liveIds.has(item.prizeId)) {
        // Either it belongs to another event, does not exist, or is archived.
        return {
          ok: false,
          failure: { code: 'PRIZE_ORDER_INVALID', reason: 'unknown_or_archived_prize' },
        };
      }
    }
    if (items.length !== live.length) {
      return {
        ok: false,
        failure: { code: 'PRIZE_ORDER_INVALID', reason: 'incomplete_order' },
      };
    }

    // Revisions are checked BEFORE the batch, not only by the in-statement
    // guards, so the common stale-client case never writes anything.
    //
    // It is NOT sufficient on its own: another writer can still land between
    // this read and the batch. That window is closed inside the batch by the
    // repository's abort guard, which rolls everything back the moment a single
    // prize fails to park — so a race can never commit a partial ordering or an
    // audit row for a reorder that did not fully happen.
    const byId = new Map(live.map((prize) => [prize.id, prize]));
    for (const item of items) {
      if (byId.get(item.prizeId)?.revision !== item.expectedRevision) {
        return { ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } };
      }
    }

    const previousOrder = live.map((prize) => ({ id: prize.id, sortOrder: prize.sortOrder }));
    const at = nowIso();

    const statements = this.prizes.reorderStatements(eventId, items, actor.admin.id, at);
    const auditStatement = this.audit.statementFor(
      {
        action: 'PRIZES_REORDERED',
        // A collective change belongs to the EVENT, not to any one prize —
        // reusing PRIZE_UPDATED per row would misrepresent what happened.
        entityType: 'EVENT',
        entityId: eventId,
        eventId,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: { order: previousOrder },
        newData: {
          order: items.map((item) => ({ id: item.prizeId, sortOrder: item.sortOrder })),
        },
        metadata: { prizeIds: items.map((item) => item.prizeId) },
      },
      { onlyIfPreviousChanged: true },
    );

    let results: D1Result[];
    try {
      results = await this.db.batch([...statements, auditStatement]);
    } catch (err) {
      // The batch aborted, so nothing was written. Reaching here means another
      // writer moved a prize under us: either the in-batch guard fired or the
      // partial UNIQUE index refused a position that was no longer free. Both
      // are the same thing to a caller — reload and try again.
      const message = err instanceof Error ? err.message : String(err);
      if (/constraint/i.test(message)) {
        return { ok: false, failure: { code: 'PRIZE_REORDER_CONFLICT' } };
      }
      throw err;
    }

    // Every parking statement must have matched; a single miss means someone
    // else moved a prize and the whole ordering is stale. The in-batch guard
    // has already rolled such a batch back unless NOTHING parked at all, which
    // is what this catches — with nothing committed either way.
    const parked = results.slice(0, items.length);
    if (parked.some((result) => (result?.meta?.changes ?? 0) === 0)) {
      return { ok: false, failure: { code: 'PRIZE_REORDER_CONFLICT' } };
    }

    return { ok: true, value: await this.prizes.listLiveByEvent(eventId) };
  }
}
