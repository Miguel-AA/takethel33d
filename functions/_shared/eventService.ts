// Event lifecycle domain service.
//
// All policy lives here: slug resolution, date rules, per-state edit
// permissions, transitions, duplication and deletion. HTTP handlers only
// translate its typed results into responses.
//
// ATOMICITY: every mutation commits together with its audit row in a single
// `db.batch()`. This is the CRITICAL policy of phase 2, not the best-effort one
// used for login/logout — an event must never change without the record of who
// changed it. Where the mutation is guarded by a revision, the audit statement
// is conditional on that guard having matched, so a lost race leaves no trace
// of a change that did not happen.

import type {
  CreateEventInput,
  DuplicateEventInput,
  Event,
  EventListQuery,
  EventStatus,
  EventTransitionAction,
  UpdateEventInput,
} from '../../shared/types';
import type { AuditAction } from '../../shared/types';
import {
  ACTION_SOURCES,
  ACTION_TARGET,
  EDITABLE_FIELDS_BY_STATUS,
  PUBLISHED_FORM_REQUIRED,
  REQUIRED_FIELDS_FOR_STATUS,
  actionRequiresPublishedForm,
  REQUIRED_TIMESTAMPS_FOR_STATUS,
  TIMING_PRECONDITIONS,
  allowedActions,
  type EventEditableField,
} from '../../shared/eventLifecycle';
import { checkSlug, slugify, withSuffix } from '../../shared/slug';
import { EventRepository, type EventInsertValues } from './eventRepository';
import { PrizeRepository } from './prizeRepository';
import { EventEntryRepository } from './eventEntryRepository';
import { FormVersionRepository } from './formVersionRepository';
import { AuditService } from './auditService';
import { logger } from './logger';
import { isValidTimeZone, DEFAULT_TIMEZONE } from './timezone';
import { newId } from './ids';
import { nowIso, parseStoredTimestamp } from './time';
import type { RequestContext } from './requestContext';
import type { AuthenticatedAdmin } from '../../shared/types';

export type EventFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'EVENT_SLUG_EXISTS' }
  | { code: 'EVENT_SLUG_RESERVED' }
  | { code: 'EVENT_INVALID_SLUG' }
  | { code: 'EVENT_INVALID_TRANSITION'; from: EventStatus; action: EventTransitionAction }
  | { code: 'EVENT_INVALID_DATE_RANGE'; detail: string }
  | { code: 'EVENT_REQUIRED_FIELDS_MISSING'; fields: string[] }
  | { code: 'EVENT_CANNOT_BE_EDITED'; fields: string[] }
  | { code: 'EVENT_CANNOT_BE_DELETED'; reason: string }
  | { code: 'EVENT_REVISION_CONFLICT' }
  | { code: 'EVENT_INVALID_TIMEZONE' }
  | { code: 'EVENT_NOT_READY'; action: EventTransitionAction; fields: string[] }
  | { code: 'EVENT_DUPLICATE_FAILED'; reason: string };

export type EventResult<T> = { ok: true; value: T } | { ok: false; failure: EventFailure };

/** Which operational timestamp each action stamps. */
const ACTION_TIMESTAMP: Record<EventTransitionAction, string | null> = {
  publish: 'published_at',
  open: 'opened_at',
  close: 'closed_at',
  'mark-draw-ready': null,
  cancel: 'cancelled_at',
  archive: 'archived_at',
};

const ACTION_AUDIT: Record<EventTransitionAction, AuditAction> = {
  publish: 'EVENT_PUBLISHED',
  open: 'EVENT_OPENED',
  close: 'EVENT_CLOSED',
  'mark-draw-ready': 'EVENT_MARKED_DRAW_READY',
  cancel: 'EVENT_CANCELLED',
  archive: 'EVENT_ARCHIVED',
};

/** Maximum automatic slug suffixes tried before giving up. */
const MAX_SLUG_ATTEMPTS = 20;

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

/** The four window fields, in the order the rules compare them. */
type DateWindow = Pick<
  Event,
  'registrationOpensAt' | 'registrationClosesAt' | 'startsAt' | 'endsAt'
>;

export class EventLifecycleService {
  private readonly events: EventRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: { events?: EventRepository; audit?: AuditService },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  /**
   * Enforces the ordering rules between the four window timestamps.
   *
   * Only pairs where BOTH values are present are compared: a draft is allowed
   * to be half-filled, and demanding otherwise would make it unusable.
   * Comparison is on parsed epoch milliseconds — every stored value is UTC, so
   * the event's display timezone never enters the arithmetic.
   */
  private validateDates(
    window: DateWindow,
  ): Extract<EventFailure, { code: 'EVENT_INVALID_DATE_RANGE' }> | null {
    const at = (value: string | null) =>
      value === null ? null : parseStoredTimestamp(value);

    const opens = at(window.registrationOpensAt);
    const closes = at(window.registrationClosesAt);
    const starts = at(window.startsAt);
    const ends = at(window.endsAt);

    if (opens !== null && closes !== null && opens >= closes) {
      return {
        code: 'EVENT_INVALID_DATE_RANGE',
        detail: 'registrationOpensAt must be before registrationClosesAt',
      };
    }
    if (starts !== null && ends !== null && starts >= ends) {
      return {
        code: 'EVENT_INVALID_DATE_RANGE',
        detail: 'startsAt must be before endsAt',
      };
    }
    if (opens !== null && starts !== null && opens > starts) {
      return {
        code: 'EVENT_INVALID_DATE_RANGE',
        detail: 'registrationOpensAt must not be after startsAt',
      };
    }
    // Equality is allowed here on purpose: registration closing exactly when
    // the event ends is a legitimate configuration.
    if (closes !== null && ends !== null && closes > ends) {
      return {
        code: 'EVENT_INVALID_DATE_RANGE',
        detail: 'registrationClosesAt must not be after endsAt',
      };
    }
    return null;
  }

  /**
   * Fields a state demands before it can be entered.
   *
   * Covers BOTH the configuration the operator supplies and the operational
   * timestamps that prove a prior step really happened — a row claiming CLOSED
   * without a `closed_at` has not actually been closed.
   */
  private missingFieldsFor(event: Event, status: EventStatus): string[] {
    const required = [
      ...(REQUIRED_FIELDS_FOR_STATUS[status] ?? []),
      ...(REQUIRED_TIMESTAMPS_FOR_STATUS[status] ?? []),
    ];
    return required.filter((field) => {
      const value = event[field as keyof Event];
      return value === null || value === undefined || value === '';
    });
  }

  /**
   * Checks the window still makes sense at the moment of the action.
   *
   * The ordering rules only say the dates agree with each other. This says they
   * agree with NOW: an event cannot be scheduled once its registration opening
   * has passed, and registration cannot be opened after it has already closed
   * or after the event itself has ended.
   */
  private validateTiming(
    event: Event,
    action: EventTransitionAction,
  ): Extract<EventFailure, { code: 'EVENT_NOT_READY' }> | null {
    const rule = TIMING_PRECONDITIONS[action];
    if (!rule) return null;

    const now = Date.now();
    const stale = rule.mustBeFuture.filter((field) => {
      const value = event[field as keyof Event];
      if (typeof value !== 'string') return false; // absent is handled elsewhere
      const instant = parseStoredTimestamp(value);
      return instant !== null && instant <= now;
    });

    return stale.length > 0
      ? { code: 'EVENT_NOT_READY', action, fields: stale }
      : null;
  }

  /** Resolves a slug, auto-suffixing only when it was generated, not supplied. */
  private async resolveSlug(
    explicit: string | undefined,
    name: string,
  ): Promise<EventResult<string>> {
    if (explicit !== undefined) {
      const checked = checkSlug(explicit);
      if (!checked.ok) {
        return {
          ok: false,
          failure: {
            code: checked.reason === 'reserved' ? 'EVENT_SLUG_RESERVED' : 'EVENT_INVALID_SLUG',
          },
        };
      }
      // An explicit slug is the operator's decision: a collision is reported,
      // never silently renamed behind their back.
      if (await this.events.slugExists(checked.slug)) {
        return { ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } };
      }
      return { ok: true, value: checked.slug };
    }

    const base = slugify(name);
    const checked = checkSlug(base);
    if (!checked.ok) {
      // A name of only punctuation or reserved wording cannot yield a usable
      // address; the operator must choose one.
      return { ok: false, failure: { code: 'EVENT_INVALID_SLUG' } };
    }

    if (!(await this.events.slugExists(checked.slug))) {
      return { ok: true, value: checked.slug };
    }
    for (let attempt = 2; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const candidate = withSuffix(checked.slug, attempt);
      if (!(await this.events.slugExists(candidate))) {
        return { ok: true, value: candidate };
      }
    }
    return { ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  findById(id: string): Promise<Event | null> {
    return this.events.findById(id);
  }

  list(query: EventListQuery) {
    return this.events.list(query);
  }

  /**
   * Actions permitted right now, split by whether their data is complete.
   *
   * `activePrizeUnits` lets the caller fold in the prize precondition without
   * this method having to query — the detail endpoint already knows the number.
   * When omitted the prize rule is not evaluated, which suits callers that only
   * care about the event's own fields.
   */
  describeActions(
    event: Event,
    options: {
      activePrizeUnits?: number;
      publishedFormValid?: boolean;
      drawEligibleCount?: number;
    } = {},
  ): {
    available: EventTransitionAction[];
    blocked: Array<{ action: EventTransitionAction; missingFields: string[] }>;
  } {
    const available: EventTransitionAction[] = [];
    const blocked: Array<{ action: EventTransitionAction; missingFields: string[] }> = [];

    for (const action of allowedActions(event.status)) {
      const missing = this.missingFieldsFor(event, ACTION_TARGET[action]);
      // A stale window blocks the action just as surely as a missing field, so
      // the UI must see it too — otherwise it would offer a button the server
      // is guaranteed to refuse.
      const timing = this.validateTiming(event, action);
      const blockers = [...missing, ...(timing?.fields ?? [])];

      // The draw needs something to give away.
      if (
        action === 'mark-draw-ready' &&
        options.activePrizeUnits !== undefined &&
        options.activePrizeUnits < 1
      ) {
        blockers.push('ACTIVE_PRIZE_REQUIRED');
      }

      // ...and somebody to give it to. Declaring an event ready to draw when
      // nothing could be drawn moves it into a state whose only exit is a draw
      // that is guaranteed to refuse — and DRAW_READY is a one-way door, since
      // no action returns an event to CLOSED. Surfacing it here means the
      // operator is told before they walk through it rather than afterwards.
      if (
        action === 'mark-draw-ready' &&
        options.drawEligibleCount !== undefined &&
        options.drawEligibleCount < 1
      ) {
        blockers.push('ELIGIBLE_PARTICIPANT_REQUIRED');
      }

      // Announcing an event means people will be asked to fill something in.
      //
      // A non-null pointer is NOT enough: SQLite cannot guarantee it names a
      // version of THIS event, so a caller that knows resolves it and passes
      // the verdict. Without that verdict the check falls back to the weaker
      // test, which is why every caller that can resolve it does.
      const hasForm =
        options.publishedFormValid ?? event.publishedFormVersionId !== null;
      if (actionRequiresPublishedForm(action) && !hasForm) {
        blockers.push(PUBLISHED_FORM_REQUIRED);
      }

      if (blockers.length === 0) available.push(action);
      else blocked.push({ action, missingFields: blockers });
    }
    return { available, blocked };
  }

  /**
   * Physical deletion is only for a pristine draft.
   *
   * "Pristine" means more than DRAFT: an event that was published and somehow
   * returned to draft would still carry operational timestamps, and erasing it
   * would erase history. The timestamps are the evidence, so they are checked
   * directly rather than trusting the status alone.
   */
  canDelete(event: Event): { ok: true } | { ok: false; reason: string } {
    if (event.status !== 'DRAFT') return { ok: false, reason: 'not_a_draft' };
    if (event.publishedAt) return { ok: false, reason: 'was_published' };
    if (event.openedAt) return { ok: false, reason: 'was_opened' };
    if (event.closedAt) return { ok: false, reason: 'was_closed' };
    if (event.cancelledAt) return { ok: false, reason: 'was_cancelled' };
    if (event.archivedAt) return { ok: false, reason: 'was_archived' };
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  async create(input: CreateEventInput, actor: Actor): Promise<EventResult<Event>> {
    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    if (!isValidTimeZone(timezone)) {
      return { ok: false, failure: { code: 'EVENT_INVALID_TIMEZONE' } };
    }

    const slug = await this.resolveSlug(input.slug, input.name);
    if (!slug.ok) return slug;

    const window: DateWindow = {
      registrationOpensAt: input.registrationOpensAt ?? null,
      registrationClosesAt: input.registrationClosesAt ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    };
    const dateFailure = this.validateDates(window);
    if (dateFailure) return { ok: false, failure: dateFailure };

    const at = nowIso();
    const values: EventInsertValues = {
      id: newId(),
      slug: slug.value,
      name: input.name,
      description: input.description ?? null,
      bannerUrl: input.bannerUrl ?? null,
      locationName: input.locationName ?? null,
      timezone,
      ...window,
      minimumAge: input.minimumAge ?? null,
      maxEntriesPerIdentity: input.maxEntriesPerIdentity ?? 1,
      status: 'DRAFT',
      confirmationTitle: input.confirmationTitle ?? null,
      confirmationMessage: input.confirmationMessage ?? null,
      ineligibleTitle: input.ineligibleTitle ?? null,
      ineligibleMessage: input.ineligibleMessage ?? null,
      createdBy: actor.admin.id,
      updatedBy: actor.admin.id,
      createdAt: at,
      updatedAt: at,
    };

    return this.commitCreate(values, actor, 'EVENT_CREATED', null);
  }

  /** Shared by create and duplicate: insert + audit in one transaction. */
  private async commitCreate(
    values: EventInsertValues,
    actor: Actor,
    action: AuditAction,
    duplicatedFromEventId: string | null,
  ): Promise<EventResult<Event>> {
    const auditStatement = this.audit.statementFor({
      action,
      entityType: 'EVENT',
      entityId: values.id,
      eventId: values.id,
      actor: {
        id: actor.admin.id,
        email: actor.admin.email,
        displayName: actor.admin.displayName,
      },
      requestContext: actor.requestContext,
      previousData: null,
      newData: values,
      metadata: duplicatedFromEventId ? { duplicatedFromEventId } : null,
    });

    try {
      await this.db.batch([this.events.insertStatement(values), auditStatement]);
    } catch (err) {
      // The UNIQUE index is authoritative: a slug that passed the pre-check can
      // still lose a race with a concurrent create.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message) && /slug/i.test(message)) {
        return { ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } };
      }
      throw err;
    }

    const created = await this.events.findById(values.id);
    if (!created) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };
    return { ok: true, value: created };
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    id: string,
    input: UpdateEventInput,
    actor: Actor,
  ): Promise<EventResult<Event>> {
    const existing = await this.events.findById(id);
    if (!existing) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const { expectedRevision, ...patch } = input;
    if (existing.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    const allowed = EDITABLE_FIELDS_BY_STATUS[existing.status];
    const requested = Object.keys(patch) as EventEditableField[];
    const forbidden = requested.filter((field) => !allowed.includes(field));
    if (forbidden.length > 0) {
      // Reported rather than silently dropped: quietly ignoring a field would
      // let an operator believe a change was saved when it was not.
      return { ok: false, failure: { code: 'EVENT_CANNOT_BE_EDITED', fields: forbidden } };
    }

    if (patch.timezone !== undefined && !isValidTimeZone(patch.timezone)) {
      return { ok: false, failure: { code: 'EVENT_INVALID_TIMEZONE' } };
    }

    if (patch.slug !== undefined) {
      const checked = checkSlug(patch.slug);
      if (!checked.ok) {
        return {
          ok: false,
          failure: {
            code: checked.reason === 'reserved' ? 'EVENT_SLUG_RESERVED' : 'EVENT_INVALID_SLUG',
          },
        };
      }
      if (checked.slug !== existing.slug && (await this.events.slugExists(checked.slug))) {
        return { ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } };
      }
    }

    // Dates are validated against the RESULTING event, not the patch alone: a
    // single new date must be consistent with the three already stored.
    const merged: DateWindow = {
      registrationOpensAt:
        patch.registrationOpensAt !== undefined
          ? patch.registrationOpensAt
          : existing.registrationOpensAt,
      registrationClosesAt:
        patch.registrationClosesAt !== undefined
          ? patch.registrationClosesAt
          : existing.registrationClosesAt,
      startsAt: patch.startsAt !== undefined ? patch.startsAt : existing.startsAt,
      endsAt: patch.endsAt !== undefined ? patch.endsAt : existing.endsAt,
    };
    const dateFailure = this.validateDates(merged);
    if (dateFailure) return { ok: false, failure: dateFailure };

    const at = nowIso();
    const updateStatement = this.events.updateStatement(
      id,
      expectedRevision,
      patch as Record<string, unknown>,
      actor.admin.id,
      at,
    );
    const auditStatement = this.audit.statementFor(
      {
        action: 'EVENT_UPDATED',
        entityType: 'EVENT',
        entityId: id,
        eventId: id,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: existing,
        newData: { ...existing, ...patch, updatedAt: at, revision: existing.revision + 1 },
      },
      // Skips the audit row if the guarded UPDATE matched nothing.
      { onlyIfPreviousChanged: true },
    );

    let changed = 0;
    try {
      const results = await this.db.batch([updateStatement, auditStatement]);
      changed = results[0]?.meta?.changes ?? 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message) && /slug/i.test(message)) {
        return { ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } };
      }
      throw err;
    }

    if (changed === 0) {
      // Another writer moved the revision between the read and the write.
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    const updated = await this.events.findById(id);
    if (!updated) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };
    return { ok: true, value: updated };
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  async transition(
    id: string,
    action: EventTransitionAction,
    actor: Actor,
    expectedRevision?: number,
  ): Promise<EventResult<Event>> {
    const existing = await this.events.findById(id);
    if (!existing) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    if (!ACTION_SOURCES[action].includes(existing.status)) {
      return {
        ok: false,
        failure: {
          code: 'EVENT_INVALID_TRANSITION',
          from: existing.status,
          action,
        },
      };
    }

    const target = ACTION_TARGET[action];
    const missing = this.missingFieldsFor(existing, target);
    if (missing.length > 0) {
      return { ok: false, failure: { code: 'EVENT_REQUIRED_FIELDS_MISSING', fields: missing } };
    }

    // The window must still make sense at the moment of the transition, not
    // merely when it was last saved.
    const dateFailure = this.validateDates(existing);
    if (dateFailure) return { ok: false, failure: dateFailure };

    // ...and it must still make sense relative to NOW.
    const timingFailure = this.validateTiming(existing, action);
    if (timingFailure) return { ok: false, failure: timingFailure };

    // Re-checked at the moment of the transition, not merely when the button
    // rendered. And checked properly: the pointer must name a version that
    // BELONGS to this event. A row edited outside the application could leave
    // this event pointing at somebody else's form, and scheduling on that basis
    // would announce an event whose registration form is another event's.
    if (actionRequiresPublishedForm(action)) {
      const pointer = await new FormVersionRepository(this.db).pointerCondition(id);
      if (pointer !== 'valid') {
        if (pointer !== 'none') {
          logger.error('event points at a form version that is not its own', {
            action: 'EVENT_PUBLISHED_FORM_POINTER_INVALID',
            eventId: id,
            reason: pointer,
            requestId: actor.requestContext.requestId,
          });
        }
        return {
          ok: false,
          failure: { code: 'EVENT_NOT_READY', action, fields: [PUBLISHED_FORM_REQUIRED] },
        };
      }
    }

    // A draw with nothing to give away is not a draw. Checked at the moment of
    // the transition, so deactivating the last prize after the button rendered
    // still blocks it.
    if (action === 'mark-draw-ready') {
      const units = await new PrizeRepository(this.db).countActiveUnits(id);
      if (units < 1) {
        return {
          ok: false,
          failure: {
            code: 'EVENT_NOT_READY',
            action,
            fields: ['ACTIVE_PRIZE_REQUIRED'],
          },
        };
      }

      // And a draw with nobody in it is not a draw either. Re-counted at the
      // moment of the transition for the same reason the units are: the last
      // eligible participant can be disqualified after the button rendered.
      //
      // The count comes from `aggregateByEvent`, so it is the SAME predicate
      // the draw itself will apply — `status = 'ELIGIBLE' AND
      // overall_eligible = 1` — rather than a second one that agrees today.
      const { drawEligible } = await new EventEntryRepository(this.db).aggregateByEvent(id);
      if (drawEligible < 1) {
        return {
          ok: false,
          failure: {
            code: 'EVENT_NOT_READY',
            action,
            fields: ['ELIGIBLE_PARTICIPANT_REQUIRED'],
          },
        };
      }
    }

    // The stored timezone is re-checked here, not just on write: a row edited
    // outside the application must not be able to enter a live state carrying
    // a zone the runtime cannot resolve.
    if (!isValidTimeZone(existing.timezone)) {
      return { ok: false, failure: { code: 'EVENT_INVALID_TIMEZONE' } };
    }

    const at = nowIso();
    const revision = existing.revision;

    const transitionStatement = this.events.transitionStatement(
      id,
      revision,
      target,
      ACTION_TIMESTAMP[action],
      at,
      actor.admin.id,
    );
    const auditStatement = this.audit.statementFor(
      {
        action: ACTION_AUDIT[action],
        entityType: 'EVENT',
        entityId: id,
        eventId: id,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: { status: existing.status, revision: existing.revision },
        newData: { status: target, revision: revision + 1 },
        metadata: { action },
      },
      { onlyIfPreviousChanged: true },
    );

    // The counts above were read before this batch. Between the read and the
    // commit an administrator can disqualify the last eligible participant, and
    // DRAW_READY is a state with no way back — so the preconditions are
    // re-asserted INSIDE the transaction, first, where losing the race writes
    // nothing instead of stranding the event.
    const guards =
      action === 'mark-draw-ready'
        ? [this.events.abortUnlessDrawableConfigurationStatement(id)]
        : [];
    const mutationIndex = guards.length;

    let results: D1Result[];
    try {
      results = await this.db.batch([...guards, transitionStatement, auditStatement]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // The guard fired: the configuration stopped satisfying the transition
      // while it was being committed. Nothing was written — the whole batch
      // rolled back — so this is a clean refusal rather than a failure, and the
      // caller is told which precondition it was from the CURRENT counts.
      if (/NOT NULL/i.test(message) && /events\.status/.test(message)) {
        const units = await new PrizeRepository(this.db).countActiveUnits(id);
        return {
          ok: false,
          failure: {
            code: 'EVENT_NOT_READY',
            action,
            fields: [units < 1 ? 'ACTIVE_PRIZE_REQUIRED' : 'ELIGIBLE_PARTICIPANT_REQUIRED'],
          },
        };
      }

      logger.error('event transition failed', {
        action: 'EVENT_TRANSITION_FAILED',
        eventId: id,
        requestId: actor.requestContext.requestId,
        // The message only, never the row.
        errorMessage: message.slice(0, 200),
      });
      throw err;
    }

    if ((results[mutationIndex]?.meta?.changes ?? 0) === 0) {
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    const updated = await this.events.findById(id);
    if (!updated) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };
    return { ok: true, value: updated };
  }

  // -------------------------------------------------------------------------
  // Duplicate
  // -------------------------------------------------------------------------

  async duplicate(
    id: string,
    input: DuplicateEventInput,
    actor: Actor,
  ): Promise<EventResult<Event>> {
    const source = await this.events.findById(id);
    if (!source) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const name = input.name ?? `${source.name} (copy)`;
    const slug = await this.resolveSlug(input.slug, name);
    if (!slug.ok) return slug;

    // Dates are NOT copied by default: a duplicate is a fresh event, and
    // inheriting a window that has already passed would produce a draft that
    // can never be opened. When asked for, only still-future dates carry over.
    const now = Date.now();
    const keep = (value: string | null): string | null => {
      if (!input.copyDates || value === null) return null;
      const at = parseStoredTimestamp(value);
      return at !== null && at > now ? value : null;
    };

    const window: DateWindow = {
      registrationOpensAt: keep(source.registrationOpensAt),
      registrationClosesAt: keep(source.registrationClosesAt),
      startsAt: keep(source.startsAt),
      endsAt: keep(source.endsAt),
    };
    const dateFailure = this.validateDates(window);
    if (dateFailure) {
      return { ok: false, failure: { code: 'EVENT_DUPLICATE_FAILED', reason: dateFailure.detail } };
    }

    const at = nowIso();
    const values: EventInsertValues = {
      id: newId(),
      slug: slug.value,
      name,
      description: source.description,
      bannerUrl: source.bannerUrl,
      locationName: source.locationName,
      timezone: source.timezone,
      ...window,
      minimumAge: source.minimumAge,
      maxEntriesPerIdentity: source.maxEntriesPerIdentity,
      // Always a fresh draft: never the source's state, operational timestamps
      // or original author.
      status: 'DRAFT',
      confirmationTitle: source.confirmationTitle,
      confirmationMessage: source.confirmationMessage,
      ineligibleTitle: source.ineligibleTitle,
      ineligibleMessage: source.ineligibleMessage,
      createdBy: actor.admin.id,
      updatedBy: actor.admin.id,
      createdAt: at,
      updatedAt: at,
    };

    return this.commitCreate(values, actor, 'EVENT_DUPLICATED', source.id);
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async remove(
    id: string,
    actor: Actor,
    expectedRevision?: number,
  ): Promise<EventResult<{ id: string }>> {
    const existing = await this.events.findById(id);
    if (!existing) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    const deletable = this.canDelete(existing);
    if (!deletable.ok) {
      return { ok: false, failure: { code: 'EVENT_CANNOT_BE_DELETED', reason: deletable.reason } };
    }
    if (await this.events.hasDependencies(id)) {
      return {
        ok: false,
        failure: { code: 'EVENT_CANNOT_BE_DELETED', reason: 'has_dependencies' },
      };
    }

    const deleteStatement = this.events.deleteStatement(id, existing.revision);
    const auditStatement = this.audit.statementFor(
      {
        action: 'EVENT_DELETED',
        entityType: 'EVENT',
        entityId: id,
        eventId: id,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        // The row is about to disappear, so the audit entry carries the whole
        // snapshot — it becomes the only remaining evidence the event existed.
        previousData: existing,
        newData: null,
        metadata: { slug: existing.slug, name: existing.name },
      },
      { onlyIfPreviousChanged: true },
    );

    const results = await this.db.batch([deleteStatement, auditStatement]);
    if ((results[0]?.meta?.changes ?? 0) === 0) {
      return { ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } };
    }

    return { ok: true, value: { id } };
  }
}
