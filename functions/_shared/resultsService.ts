// Turning a draw into a record.
//
// Phase 11 decided who won and made that decision permanent. This service does
// two things with it, and neither may change it: it shows an administrator what
// happened, and it publishes an abbreviated version to the world.
//
// PUBLISHING IS THE SECOND IRREVERSIBLE ACT. There is no `unpublish` here, and
// its absence is deliberate rather than pending: withdrawing a publication would
// mean somebody was publicly named a winner and then unnamed, which is not a
// correction but a second announcement. The database has no delete for it and
// this class has no method for it.
//
// WHAT THIS SERVICE MAY NEVER DO:
//   * run a draw, or change one
//   * replace a winner, reorder an assignment or reassign a prize
//   * recompute eligibility, or read the current prize table as history
//   * publish a full name or an email address
//
// THE SOURCE OF TRUTH IS `draw_assignments`, always. The current prize names are
// not consulted; the current published form is not consulted; the candidate
// population is never re-derived. A publication is a copy of a copy, and each
// copy is what stops an edit travelling forward into a record of something that
// already happened.

import type {
  AdminEventResults,
  AuthenticatedAdmin,
  Event,
  PublicEventResultsDTO,
  ResultFailureCode,
} from '../../shared/types';
import { ACTION_SOURCES } from '../../shared/eventLifecycle';
import {
  archivingWouldDiscardResults,
  canArchiveEvent,
  canPublishResults,
  formatPublicWinnerName,
  publicationState,
  type PublicationBlocker,
} from '../../shared/resultLifecycle';
import { EventRepository } from './eventRepository';
import { DrawRepository } from './drawRepository';
import {
  ResultRepository,
  toPublicationSummary,
  type PublicationItemInsertValues,
  type PublishableAssignment,
} from './resultRepository';
import { AuditService } from './auditService';
import { newId } from './ids';
import { nowIso } from './time';
import { isValidSlug } from '../../shared/slug';
import { logger } from './logger';
import type { RequestContext } from './requestContext';

export type ResultFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'RESULTS_NOT_AVAILABLE' }
  | { code: 'RESULTS_ALREADY_PUBLISHED' }
  | { code: 'RESULTS_NOT_PUBLISHABLE'; blocker: PublicationBlocker; eventStatus: string }
  | { code: 'RESULTS_CONFLICT'; reason: string };

export type ResultOutcome<T> = { ok: true; value: T } | { ok: false; failure: ResultFailure };

/**
 * What `publish()` produced.
 *
 * `created` distinguishes the publication that just happened from the one that
 * had already happened. Both return the same body — a retry is answered with
 * the record rather than a refusal — so the flag is what lets the endpoint say
 * 201 for one and 200 for the other, exactly as the draw endpoint does.
 */
export interface PublishOutcome {
  results: AdminEventResults;
  created: boolean;
}

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

export class ResultsService {
  private readonly events: EventRepository;
  private readonly draws: DrawRepository;
  private readonly results: ResultRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: {
      events?: EventRepository;
      draws?: DrawRepository;
      results?: ResultRepository;
      audit?: AuditService;
    },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.draws = deps?.draws ?? new DrawRepository(db);
    this.results = deps?.results ?? new ResultRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  // -------------------------------------------------------------------------
  // Administrative read
  // -------------------------------------------------------------------------

  /**
   * Everything the results screen shows, at every stage.
   *
   * Answers for an event that has not been drawn (`draw: null`), one that has
   * (`publication: null`), one that has been published, and one that has been
   * archived — the last returning exactly the same history as before it was
   * closed. Archiving files an event away; it does not edit it.
   */
  async loadAdminResults(eventId: string): Promise<ResultOutcome<AdminEventResults>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    return { ok: true, value: await this.project(event) };
  }

  private async project(event: Event): Promise<AdminEventResults> {
    const draw = await this.draws.findByEvent(event.id);
    const publication = await this.results.findPublicationByEvent(event.id);

    const rows = draw
      ? await this.results.loadPublishableAssignments(event.id, draw.id)
      : [];

    // FAIL CLOSED, the lesson phase 11's validation left. The draw records how
    // many assignments it made; if fewer are readable, something has been lost
    // and a screen showing the remainder would present an incomplete result as
    // the result.
    if (draw && rows.length !== draw.assignmentCount) {
      throw new TypeError(
        `draw ${draw.id} recorded ${draw.assignmentCount} assignments but ${rows.length} are readable`,
      );
    }
    // And a publication must agree with the draw it copied.
    if (publication && draw && publication.winnerCount !== draw.assignmentCount) {
      throw new TypeError(
        `publication ${publication.id} announced ${publication.winnerCount} winners for a draw of ${draw.assignmentCount}`,
      );
    }
    if (publication) {
      // Reads the items purely to assert they are all there AND that every one
      // of them came from this publication's own draw. The administrative view
      // renders from the assignments — the publication is a copy of them — but
      // a publication whose rows have gone missing, or acquired a row from
      // somewhere else, must not be reported as intact.
      await this.results.loadPublicationItems(
        publication.id,
        publication.winnerCount,
        publication.drawId,
      );
    }

    const permission = canPublishResults({
      eventStatus: event.status,
      hasDraw: draw !== null,
      hasPublication: publication !== null,
    });

    return {
      eventStatus: event.status,
      draw,
      assignments: this.results.toAdminAssignments(rows),
      // Arithmetic on the DRAW's own numbers. Recomputing this from today's
      // prize quantities would answer a different question — "how many units
      // exist now?" — and would change every time somebody edited a prize.
      unassignedUnitCount: draw ? draw.prizeUnitCount - draw.assignmentCount : 0,
      // Named field by field: `drawId` is internal to the repository layer
      // and `draw.id` above already carries it.
      publication: publication ? toPublicationSummary(publication) : null,
      publicationState: publicationState(publication),
      canPublish: permission.allowed,
      publishBlocker: permission.allowed ? null : permission.blocker,
      canArchive: canArchiveEvent({
        eventStatus: event.status,
        archiveSources: ACTION_SOURCES.archive,
      }),
      archivingWouldDiscardResults: archivingWouldDiscardResults({
        hasDraw: draw !== null,
        hasPublication: publication !== null,
      }),
      archivedAt: event.archivedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  async publish(eventId: string, actor: Actor): Promise<ResultOutcome<PublishOutcome>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    // THE REPLAY, first. A second attempt at a publication that already exists
    // is answered with the publication: the caller asked for these results to be
    // public, and they are public. A retry after a lost response, a double
    // submit or a second tab gets the same record — the same names, the same
    // instant — because nothing is recomputed.
    if (await this.results.hasPublication(eventId)) {
      return { ok: true, value: { results: await this.project(event), created: false } };
    }

    const draw = await this.draws.findByEvent(eventId);
    const permission = canPublishResults({
      eventStatus: event.status,
      hasDraw: draw !== null,
      hasPublication: false,
    });
    if (!permission.allowed || !draw) {
      return {
        ok: false,
        failure: {
          code: 'RESULTS_NOT_PUBLISHABLE',
          blocker: permission.allowed ? 'NO_DRAW' : permission.blocker,
          eventStatus: event.status,
        },
      };
    }

    const rows = await this.results.loadPublishableAssignments(eventId, draw.id);
    if (rows.length !== draw.assignmentCount) {
      // Publishing an incomplete result would announce a draw that omits a
      // winner, permanently. Refused rather than published in part.
      logger.error('publication refused: assignments do not match the draw', {
        action: 'RESULTS_PUBLISH_INCOHERENT',
        eventId,
        drawId: draw.id,
        requestId: actor.requestContext.requestId,
        recorded: draw.assignmentCount,
        readable: rows.length,
      });
      return {
        ok: false,
        failure: { code: 'RESULTS_CONFLICT', reason: 'assignment_count_mismatch' },
      };
    }

    const at = nowIso();
    const publicationId = newId();

    const items = this.buildItems(rows, publicationId, draw.id, at);
    if (!items.ok) return items;

    const statements = [
      // [0] The lifecycle, re-asserted AT COMMIT TIME.
      //
      //     This is the publish-versus-archive race, and it is decided here.
      //     An event that reached ARCHIVED between the check above and this
      //     batch no longer holds DRAW_COMPLETED, so the guard writes NULL into
      //     a NOT NULL column and the whole batch fails — leaving an archived
      //     event with no publication rather than a publication inside a closed
      //     event. There is no interleaving that produces both.
      this.events.abortUnlessStatusStatement(eventId, 'DRAW_COMPLETED'),
      this.results.insertPublicationStatement({
        id: publicationId,
        eventId,
        drawId: draw.id,
        publishedAt: at,
        publishedByAdminId: actor.admin.id,
        requestId: actor.requestContext.requestId,
        winnerCount: rows.length,
      }),
      ...this.results.insertPublicationItemStatements(items.value),
      this.audit.statementFor({
        action: 'EVENT_RESULTS_PUBLISHED',
        entityType: 'RESULT_PUBLICATION',
        entityId: publicationId,
        eventId,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: { published: false },
        newData: { published: true, publicationId, drawId: draw.id, winnerCount: rows.length },
        // Counts and identifiers. NEVER the names, not even the abbreviated
        // ones: `audit_logs` is append-only and never deleted, so a list of
        // people who won something in it is a copy no erasure request could
        // ever reach — and the publication itself is already that record, in a
        // table that can answer for itself.
        metadata: { eventStatus: event.status },
      }),
    ];

    try {
      await this.db.batch(statements);
    } catch (err) {
      return this.classifyFailure(err, event, actor);
    }

    logger.info('results published', {
      action: 'EVENT_RESULTS_PUBLISHED',
      eventId,
      drawId: draw.id,
      publicationId,
      requestId: actor.requestContext.requestId,
      // A count, never a name. A log line listing winners would be a copy of
      // the result in a system with different retention and different access.
      winnerCount: rows.length,
    });

    const after = await this.events.findById(eventId);
    return {
      ok: true,
      value: { results: await this.project(after ?? event), created: true },
    };
  }

  /**
   * Turns assignments into the rows a publication is made of.
   *
   * THE PUBLIC NAME IS COMPUTED HERE, ONCE. After this it is a stored string,
   * and every later read returns that string — so a participant correcting
   * their surname changes their record and does not change what was announced.
   *
   * A name that cannot be formatted FAILS THE WHOLE PUBLICATION. The alternative
   * would be a placeholder inside a permanent record, and a publication that
   * says "Anonymous" because a row was malformed is worse than one that did not
   * happen: the second can be fixed.
   */
  private buildItems(
    rows: readonly PublishableAssignment[],
    publicationId: string,
    drawId: string,
    at: string,
  ): ResultOutcome<PublicationItemInsertValues[]> {
    const items: PublicationItemInsertValues[] = [];

    for (const row of rows) {
      const displayName = formatPublicWinnerName({
        firstName: row.firstName,
        lastName: row.lastName,
      });
      if (displayName === null) {
        logger.error('publication refused: a winner has no usable name', {
          action: 'RESULTS_PUBLISH_UNNAMEABLE',
          publicationId,
          // The identifier, never the name that failed to format.
          assignmentId: row.assignmentId,
        });
        return {
          ok: false,
          failure: { code: 'RESULTS_CONFLICT', reason: 'winner_name_unavailable' },
        };
      }

      items.push({
        id: newId(),
        publicationId,
        drawId,
        assignmentId: row.assignmentId,
        drawOrder: row.drawOrder,
        winnerDisplayNameSnapshot: displayName,
        // COPIED FROM THE ASSIGNMENT. The current `event_prizes` row is not
        // consulted, so a prize renamed after the draw cannot rewrite what was
        // announced.
        prizeNameSnapshot: row.prizeNameSnapshot,
        prizeDescriptionSnapshot: row.prizeDescriptionSnapshot,
        prizeUnitIndex: row.prizeUnitIndex,
        createdAt: at,
      });
    }

    return { ok: true, value: items };
  }

  /**
   * Works out which guard fired.
   *
   * The database can only report that a constraint failed. The batch rolled back
   * entirely before any of this, so re-reading is safe and the answer is only
   * used to phrase the refusal.
   */
  private async classifyFailure(
    err: unknown,
    event: Event,
    actor: Actor,
  ): Promise<ResultOutcome<PublishOutcome>> {
    const message = err instanceof Error ? err.message : String(err);

    logger.error('results publication failed', {
      action: 'RESULTS_PUBLISH_FAILED',
      eventId: event.id,
      requestId: actor.requestContext.requestId,
      // The message only, never a row.
      errorMessage: message.slice(0, 200),
    });

    // THE LOST RACE. Two administrators pressed the button at the same time;
    // the unique index let exactly one commit. The loser is answered with the
    // winner's publication — its own would have been identical apart from the
    // instant, and telling somebody "conflict" about results that have just
    // been published successfully describes the mechanism rather than the
    // outcome.
    if (/UNIQUE/i.test(message) && /result_publications/i.test(message)) {
      const current = await this.events.findById(event.id);
      if (current && (await this.results.hasPublication(event.id))) {
        return { ok: true, value: { results: await this.project(current), created: false } };
      }
      return { ok: false, failure: { code: 'RESULTS_ALREADY_PUBLISHED' } };
    }

    // The lifecycle guard fired: the event left DRAW_COMPLETED while this was
    // committing — in practice, it was archived. Nothing was written.
    if (/NOT NULL/i.test(message) && /events\.status/.test(message)) {
      const current = await this.events.findById(event.id);
      const status = current?.status ?? event.status;
      return {
        ok: false,
        failure: {
          code: 'RESULTS_NOT_PUBLISHABLE',
          blocker: status === 'ARCHIVED' ? 'EVENT_ARCHIVED' : 'EVENT_NOT_DRAWN',
          eventStatus: status,
        },
      };
    }

    return { ok: false, failure: { code: 'RESULTS_CONFLICT', reason: 'constraint' } };
  }

  // -------------------------------------------------------------------------
  // The public read
  // -------------------------------------------------------------------------

  /**
   * The published winners of one event, by slug.
   *
   * DELIBERATELY NOT ROUTED THROUGH `publicVisibility`. That rule hides an
   * ARCHIVED event's registration page, and correctly — there is nothing to
   * register for. A published result is a different thing: it was announced on
   * purpose, and filing the event away afterwards must not retract it. So the
   * only question this asks is "is there a publication?".
   *
   * ONE REFUSAL FOR EVERYTHING ELSE. A slug nobody has used, an event that has
   * not been drawn, and an event whose draw was run but never published all
   * answer NOT_AVAILABLE. Distinguishing them would turn this endpoint into an
   * oracle for whether a private draw has happened — which is exactly the
   * information an operator is choosing to withhold by not publishing.
   */
  async loadPublicResults(slug: string): Promise<ResultOutcome<PublicEventResultsDTO>> {
    if (!isValidSlug(slug)) return { ok: false, failure: { code: 'RESULTS_NOT_AVAILABLE' } };

    const event = await this.events.findBySlug(slug);
    if (!event) return { ok: false, failure: { code: 'RESULTS_NOT_AVAILABLE' } };

    const publication = await this.results.findPublicationByEvent(event.id);
    if (!publication) return { ok: false, failure: { code: 'RESULTS_NOT_AVAILABLE' } };

    // Throws if the rows do not add up. A partial winner list must never reach
    // a public page: it looks like the answer and is not.
    const winners = await this.results.loadPublicResults(
      publication.id,
      publication.winnerCount,
      publication.drawId,
    );

    // Built by NAME, field by field. No spread anywhere on this path, so a
    // column added to either table later cannot travel to the public page by
    // accident — the mistake `toPublicEventDto` was written to prevent in phase
    // 9, applied to the one surface that outlives the event itself.
    return {
      ok: true,
      value: {
        event: { slug: event.slug, name: event.name },
        results: { publishedAt: publication.publishedAt, winners },
      },
    };
  }
}

export type { ResultFailureCode };
