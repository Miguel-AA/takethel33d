// Running the draw.
//
// This is the only irreversible act in the system. Every other operation can be
// corrected — an event reopened, a prize re-quantified, a participant
// reinstated — but a draw picks winners, and there is no honest way to pick them
// again. So the whole thing is built around one sentence: EITHER A DRAW HAPPENED
// COMPLETELY, OR IT DID NOT HAPPEN AT ALL.
//
// WHAT THAT MEANS CONCRETELY. The draw row, every assignment, the audit entry
// and the event's transition to DRAW_COMPLETED commit in ONE `db.batch()`.
// There is no state in which winners exist and the event still looks ready to
// draw, no state in which an assignment exists without the draw that produced
// it, and no state in which any of it happened without a record of who did it.
//
// WHAT THIS SERVICE MAY NEVER DO:
//   * recompute eligibility — the verdict belongs to the instant of submission
//   * accept a seed, a candidate list or a winner from a caller
//   * give one participation two prizes, or one prize unit two winners
//   * run twice for one event, under any circumstance
//   * publish results anywhere public
//
// WHY THE RANDOMNESS IS A CONSTRUCTOR DEPENDENCY. Tests need determinism and
// production must never have it. Injecting the source at construction means no
// request, no header and no body can select it — the only way to get a scripted
// draw is to build the service with one, which only a test does.

import type {
  AuthenticatedAdmin,
  DrawReadiness,
  DrawResponse,
  DrawStatusResponse,
  Event,
  EventStatus,
} from '../../shared/types';
import {
  DRAW_ALGORITHM_VERSION,
  EVENT_STATUS_ALLOWING_DRAW,
  countPrizeUnits,
  eventAllowsDraw,
  expandPrizeUnits,
  hashCandidateSet,
  plannedWinnerCount,
  type DrawFailureCode,
  type PrizeUnit,
} from '../../shared/drawLifecycle';
import { DRAW_ASSIGNMENTS_MAX } from '../../shared/limits';
import { EventRepository } from './eventRepository';
import { EventEntryRepository } from './eventEntryRepository';
import { PrizeRepository } from './prizeRepository';
import { DrawRepository, type AssignmentInsertValues } from './drawRepository';
import { AuditService } from './auditService';
import {
  CryptoRandomSource,
  secureShuffle,
  type SecureRandomSource,
} from '../../shared/secureRandom';
import { newId } from './ids';
import { nowIso } from './time';
import { logger } from './logger';
import type { RequestContext } from './requestContext';

export type DrawFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'DRAW_NOT_READY'; eventStatus: EventStatus }
  | { code: 'DRAW_ALREADY_COMPLETED' }
  | { code: 'NO_ELIGIBLE_PARTICIPANTS' }
  | { code: 'NO_ACTIVE_PRIZES' }
  | { code: 'DRAW_POPULATION_CHANGED' }
  | { code: 'DRAW_CONFLICT'; reason: string };

export type DrawResult<T> = { ok: true; value: T } | { ok: false; failure: DrawFailure };

/**
 * What `run()` produced.
 *
 * `created` distinguishes the draw that just happened from the one that had
 * already happened. Both return the SAME body — a retry is answered with the
 * result rather than with a refusal — so the flag is what lets the endpoint say
 * 201 for one and 200 for the other. It is deliberately not in the body: the
 * status code is where "did this request create something?" belongs, and a
 * client that acted on a boolean in the payload would be reading the wrong
 * thing.
 */
export interface DrawRunOutcome {
  response: DrawResponse;
  created: boolean;
}

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

/**
 * Everything the draw resolved before it wrote anything.
 *
 * Assembled in one place so the order of the reads is visible and reviewable —
 * it is load-bearing, and the comment in `resolve()` explains why.
 */
interface ResolvedDraw {
  event: Event;
  candidateIds: string[];
  /** Only the units that could actually be awarded, in the fixed order. */
  units: PrizeUnit[];
  /** The FULL offering, which is what the draw records and the guard asserts. */
  prizeUnitCount: number;
  populationRevision: number;
}

/** A draw that already existed, to be returned instead of being run again. */
interface ReplayedDraw {
  replay: DrawRunOutcome;
}

export class DrawService {
  private readonly events: EventRepository;
  private readonly entries: EventEntryRepository;
  private readonly prizes: PrizeRepository;
  private readonly draws: DrawRepository;
  private readonly audit: AuditService;
  private readonly random: SecureRandomSource;

  constructor(
    private readonly db: D1Database,
    deps?: {
      events?: EventRepository;
      entries?: EventEntryRepository;
      prizes?: PrizeRepository;
      draws?: DrawRepository;
      audit?: AuditService;
      random?: SecureRandomSource;
    },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.entries = deps?.entries ?? new EventEntryRepository(db);
    this.prizes = deps?.prizes ?? new PrizeRepository(db);
    this.draws = deps?.draws ?? new DrawRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
    // The platform CSPRNG unless a test hands over a scripted one.
    this.random = deps?.random ?? new CryptoRandomSource();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The draw and its assignments, if there is one.
   *
   * Administrative surface only. There is no public results endpoint in this
   * phase, and this method is not the place to grow one: it returns winners'
   * names and email addresses, which is exactly what a public page must not.
   */
  async result(eventId: string): Promise<DrawResult<DrawResponse>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    return { ok: true, value: await this.loadResponse(event) };
  }

  /**
   * The result plus what the confirmation dialog needs to describe what is
   * about to happen.
   *
   * The readiness numbers are INFORMATIONAL. Every one of them is re-resolved
   * inside `run()` and re-asserted at commit time, so a panel that went stale
   * while an operator read it cannot change what the draw actually does — the
   * worst it can do is describe a draw that then refuses to run.
   */
  async status(eventId: string): Promise<DrawResult<DrawStatusResponse>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const response = await this.loadResponse(event);
    const candidateCount = (await this.entries.listDrawEligibleByEvent(eventId)).length;
    // Counted, not expanded: a readiness panel must not allocate one object per
    // unit on offer to display a number.
    const prizeUnitCount = countPrizeUnits(await this.prizes.listActiveByEvent(eventId));

    const blockers: DrawFailureCode[] = [];
    // Checked first and reported alone: once a draw exists, nothing else about
    // readiness is actionable, and listing "no eligible participants" beside it
    // would suggest a fix for a situation that has none.
    if (response.draw !== null || event.status === 'DRAW_COMPLETED') {
      blockers.push('DRAW_ALREADY_COMPLETED');
    } else {
      if (!eventAllowsDraw(event.status)) blockers.push('DRAW_NOT_READY');
      if (candidateCount < 1) blockers.push('NO_ELIGIBLE_PARTICIPANTS');
      if (prizeUnitCount < 1) blockers.push('NO_ACTIVE_PRIZES');
    }

    const readiness: DrawReadiness = {
      eventStatus: event.status,
      candidateCount,
      prizeUnitCount,
      plannedWinnerCount: plannedWinnerCount(candidateCount, prizeUnitCount),
      canRun: blockers.length === 0,
      blockers,
    };

    return { ok: true, value: { ...response, readiness } };
  }

  private async loadResponse(event: Event): Promise<DrawResponse> {
    const draw = await this.draws.findByEvent(event.id);
    const assignments = draw ? await this.draws.listAssignments(event.id, draw.id) : [];

    // FAIL CLOSED when the result does not add up.
    //
    // The read joins through the entry and the participant and is scoped by
    // event, so a row whose `event_id` was corrupted — or whose winner somehow
    // vanished — is silently EXCLUDED rather than reported. That would present
    // a three-winner draw as a two-winner draw, with no indication that
    // anything was missing, which is the worst possible way to be wrong about
    // who won something. `assignment_count` is what the draw recorded at the
    // moment it happened, so a disagreement means the rows are not the draw.
    if (draw && assignments.length !== draw.assignmentCount) {
      throw new TypeError(
        `draw ${draw.id} recorded ${draw.assignmentCount} assignments but ${assignments.length} are readable`,
      );
    }

    return { draw, assignments, eventStatus: event.status };
  }

  // -------------------------------------------------------------------------
  // The draw
  // -------------------------------------------------------------------------

  async run(eventId: string, actor: Actor): Promise<DrawResult<DrawRunOutcome>> {
    const resolved = await this.resolve(eventId);
    if (!resolved.ok) return resolved;

    // A draw already existed. Answered with the RESULT rather than a refusal,
    // and answered before a single random value is drawn — see `replay`.
    if ('replay' in resolved.value) return { ok: true, value: resolved.value.replay };

    const { event, candidateIds, units, populationRevision, prizeUnitCount } = resolved.value;

    // `units` was already bounded to what could be awarded, so this is the same
    // number `resolve` computed — recomputed here so the ceiling below is
    // guarded against the count and the list disagreeing.
    const winnerCount = plannedWinnerCount(candidateIds.length, units.length);
    if (winnerCount > DRAW_ASSIGNMENTS_MAX) {
      // Refused rather than attempted. A batch this size is beyond what one
      // transaction can be relied upon to carry, and a draw that cannot commit
      // atomically must not commit at all — a partial draw is worse than none.
      logger.error('draw exceeds the atomic commit ceiling', {
        action: 'DRAW_TOO_LARGE',
        eventId,
        requestId: actor.requestContext.requestId,
        plannedWinners: winnerCount,
        ceiling: DRAW_ASSIGNMENTS_MAX,
      });
      return { ok: false, failure: { code: 'DRAW_CONFLICT', reason: 'too_many_assignments' } };
    }

    // THE SELECTION. Everything above this line is reading; everything below is
    // arithmetic on the result. The shuffle is the only source of chance in the
    // system, and it consumes nothing a caller supplied.
    const shuffled = secureShuffle(candidateIds, this.random);
    const winners = shuffled.slice(0, winnerCount);

    const at = nowIso();
    const drawId = newId();
    const candidateSetHash = await hashCandidateSet(candidateIds);

    // Winner i takes unit i, and the units are in a FIXED order. Pairing a
    // shuffled list against a fixed one is a uniform assignment; shuffling both
    // would add a second source of chance without adding any fairness, and
    // would make the result depend on the order SQLite returned prize rows in.
    const assignments: AssignmentInsertValues[] = winners.map((entryId, index) => {
      const unit = units[index];
      return {
        id: newId(),
        drawId,
        eventId,
        prizeId: unit.prizeId,
        entryId,
        prizeUnitIndex: unit.unitIndex,
        drawOrder: index,
        prizeNameSnapshot: unit.nameSnapshot,
        prizeDescriptionSnapshot: unit.descriptionSnapshot,
        assignedAt: at,
      };
    });

    // Belt to the database's braces. The unique indexes are what actually
    // guarantee these, and they are re-checked here so a bug in the pairing
    // above fails loudly in a test rather than surviving to be caught by a
    // constraint at three in the morning.
    assertNoDuplicates(assignments);

    const statements = [
      // [0] Nothing may have moved between resolving and committing. This is
      //     the whole race protection; see `abortUnlessDrawableStatement`.
      this.events.abortUnlessDrawableStatement(eventId, {
        status: EVENT_STATUS_ALLOWING_DRAW,
        populationRevision,
        activePrizeUnits: prizeUnitCount,
      }),
      // [1] The transition, guarded on the status [0] just asserted.
      this.events.completeDrawStatement(eventId, at, actor.admin.id),
      // [2] ...and a hard stop if it somehow did nothing. A zero-row UPDATE is
      //     not an error to SQLite, and "the winners committed but the event
      //     still looks ready to draw" is the one outcome that must be
      //     impossible.
      this.events.abortUnlessStatusStatement(eventId, 'DRAW_COMPLETED'),
      this.draws.insertDrawStatement({
        id: drawId,
        eventId,
        completedAt: at,
        executedByAdminId: actor.admin.id,
        requestId: actor.requestContext.requestId,
        candidateCount: candidateIds.length,
        prizeUnitCount,
        assignmentCount: assignments.length,
        algorithmVersion: DRAW_ALGORITHM_VERSION,
        candidateSetHash,
        candidatePopulationRevision: populationRevision,
      }),
      ...this.draws.insertAssignmentStatements(assignments),
      this.audit.statementFor({
        action: 'DRAW_COMPLETED',
        entityType: 'DRAW',
        entityId: drawId,
        eventId,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: { eventStatus: event.status },
        newData: {
          eventStatus: 'DRAW_COMPLETED',
          drawId,
          candidateCount: candidateIds.length,
          prizeUnitCount,
          assignmentCount: assignments.length,
        },
        // Counts and a hash, never the winners. Naming them here would put a
        // list of people who won something into an append-only table no erasure
        // request can reach — and the assignments themselves already are that
        // record, in a table that can answer for itself.
        metadata: {
          algorithmVersion: DRAW_ALGORITHM_VERSION,
          candidateSetHash,
          candidatePopulationRevision: populationRevision,
        },
        // NOT conditional on a preceding change: every statement in this batch
        // that could no-op is followed by a guard that turns it into a failure,
        // so if the audit row is reachable at all, the draw happened.
      }),
    ];

    try {
      await this.db.batch(statements);
    } catch (err) {
      return this.classifyFailure(err, eventId, populationRevision, actor);
    }
    // NOTE ON RANDOMNESS AND CONCURRENCY. Two simultaneous requests can BOTH
    // reach the shuffle above, because the winner is only decided by the commit
    // below. That is not a defect: one of them persists and the other is
    // answered with the persisted result, so the discarded selection never
    // existed as far as anything outside this function is concerned. What must
    // never consume randomness is a RETRY — a request arriving after a draw
    // exists — and that is why `replay` runs before any of this.

    logger.info('draw completed', {
      action: 'DRAW_COMPLETED',
      eventId,
      drawId,
      requestId: actor.requestContext.requestId,
      // Counts only. A log line naming winners would be a copy of the result in
      // a system with different retention and different access control.
      candidateCount: candidateIds.length,
      prizeUnitCount,
      assignmentCount: assignments.length,
    });

    const after = await this.events.findById(eventId);
    return {
      ok: true,
      value: {
        response: await this.loadResponse(after ?? { ...event, status: 'DRAW_COMPLETED' }),
        created: true,
      },
    };
  }

  /**
   * Reads everything the draw needs, and refuses early where it can.
   *
   * THE ORDER OF THE READS IS LOAD-BEARING. The population counter is captured
   * BEFORE the candidates, never after. Read afterwards, a disqualification
   * landing between the two would leave a stale candidate list paired with a
   * counter that had already moved to match it — the guard would compare equal
   * and the draw would commit winners chosen from a set that no longer existed.
   * Read first, that same interleaving makes the counter disagree at commit
   * time and the draw fails safely. The failure is spurious in that narrow
   * window and it is the direction to be wrong in.
   */
  private async resolve(
    eventId: string,
  ): Promise<DrawResult<ResolvedDraw | ReplayedDraw>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    // THE REPLAY, and it comes BEFORE the lifecycle check on purpose.
    //
    // A second attempt at a draw that already happened is answered with the
    // draw. It is not a failure: the caller asked for this event to be drawn,
    // and it is drawn. A retry after a lost response, a double submit, a second
    // tab — all of them get the same winners, and none of them touches the
    // random source, which is asserted rather than assumed.
    //
    // Placed before the DRAW_COMPLETED / DRAW_READY checks so that an event
    // whose status was tampered with back to DRAW_READY still replays rather
    // than drawing again. The status column is not what guarantees uniqueness;
    // the draw row is.
    const replayed = await this.replay(event);
    if (replayed) return { ok: true, value: { replay: replayed } };

    if (event.status === 'DRAW_COMPLETED') {
      // DRAW_COMPLETED with no draw row is a state the application cannot
      // produce — the two commit together — so this is corruption rather than a
      // second attempt, and it is refused rather than repaired.
      return { ok: false, failure: { code: 'DRAW_ALREADY_COMPLETED' } };
    }
    if (!eventAllowsDraw(event.status)) {
      return { ok: false, failure: { code: 'DRAW_NOT_READY', eventStatus: event.status } };
    }

    const populationRevision = await this.events.populationRevision(eventId);
    const candidateIds = await this.entries.listDrawEligibleByEvent(eventId);
    if (candidateIds.length < 1) {
      return { ok: false, failure: { code: 'NO_ELIGIBLE_PARTICIPANTS' } };
    }

    const prizes = await this.prizes.listActiveByEvent(eventId);
    const prizeUnitCount = countPrizeUnits(prizes);
    if (prizeUnitCount < 1) {
      return { ok: false, failure: { code: 'NO_ACTIVE_PRIZES' } };
    }

    // BOUNDED. Nobody can win more than one unit, so at most one unit per
    // candidate can ever be awarded and the rest never leave the count. The
    // order is fixed, so this is a prefix of the full expansion rather than a
    // different set — the same units, decided the same way.
    const units = expandPrizeUnits(prizes, candidateIds.length);

    return {
      ok: true,
      value: { event, candidateIds, units, prizeUnitCount, populationRevision },
    };
  }

  /**
   * The draw this event already has, packaged as a result.
   *
   * Returns null when there is none — which is the ordinary case and the only
   * one that goes on to consume randomness.
   */
  private async replay(event: Event): Promise<DrawRunOutcome | null> {
    if (!(await this.draws.hasDraw(event.id))) return null;
    return { response: await this.loadResponse(event), created: false };
  }

  /**
   * Works out WHICH guard fired.
   *
   * The database can only report that a constraint failed; it cannot say which
   * of the three conditions in the abort statement was the false one. So the
   * event is re-read and compared against what the draw was computed from. The
   * batch rolled back entirely before any of this, so the re-read is safe and
   * the answer is only used to phrase the refusal.
   */
  private async classifyFailure(
    err: unknown,
    eventId: string,
    populationRevision: number,
    actor: Actor,
  ): Promise<DrawResult<DrawRunOutcome>> {
    const message = err instanceof Error ? err.message : String(err);

    logger.error('draw failed', {
      action: 'DRAW_FAILED',
      eventId,
      requestId: actor.requestContext.requestId,
      // The message only, never a row: a constraint error naming a column is a
      // diagnostic, the values in it are somebody's data.
      errorMessage: message.slice(0, 200),
    });

    // THE LOST RACE. Two administrators pressed the button at the same time;
    // both got past the precheck, both shuffled, and the index let exactly one
    // of them commit. The loser is answered with the winner's draw, not with an
    // error — its own selection was discarded before it was ever visible, and
    // telling the operator "conflict" about an event that has just been drawn
    // successfully would be describing the mechanism rather than the outcome.
    //
    // The event is re-read rather than reused: it has moved to DRAW_COMPLETED
    // in between, and the response must say so.
    if (/UNIQUE/i.test(message) && /draws|ux_draws_event/i.test(message)) {
      const current = await this.events.findById(eventId);
      const replayed = current ? await this.replay(current) : null;
      if (replayed) return { ok: true, value: replayed };
      // The index refused a second draw and none can be read back. That cannot
      // happen through this application, so it is reported rather than papered
      // over.
      return { ok: false, failure: { code: 'DRAW_ALREADY_COMPLETED' } };
    }

    if (/NOT NULL/i.test(message) && /events\.status/.test(message)) {
      const current = await this.events.findById(eventId);
      // The event disappeared between the batch and this read. Impossible while
      // it has entries — `hasDependencies` and the RESTRICT foreign keys both
      // refuse it — so this is reported as the plain truth rather than guessed
      // at.
      if (!current) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

      if (current.status === 'DRAW_COMPLETED') {
        // THE OTHER WAY A CONCURRENT LOSER FAILS, and the one that actually
        // happens. The winner commits its transition first, so the loser's
        // guard sees a status that is no longer DRAW_READY and takes the batch
        // down BEFORE the unique index is ever consulted. Both interleavings
        // reach the same place: the event has been drawn, so the caller is
        // answered with the draw rather than with the mechanism that stopped
        // theirs.
        const replayed = await this.replay(current);
        if (replayed) return { ok: true, value: replayed };
        return { ok: false, failure: { code: 'DRAW_ALREADY_COMPLETED' } };
      }
      if (!eventAllowsDraw(current.status)) {
        return { ok: false, failure: { code: 'DRAW_NOT_READY', eventStatus: current.status } };
      }
      if ((await this.events.populationRevision(eventId)) !== populationRevision) {
        return { ok: false, failure: { code: 'DRAW_POPULATION_CHANGED' } };
      }
      // The state and the population still agree, so what moved was the prize
      // configuration. Reported as a conflict rather than as a readiness
      // problem, because it means something changed underneath rather than
      // never having been right.
      return { ok: false, failure: { code: 'DRAW_CONFLICT', reason: 'prizes_changed' } };
    }

    return { ok: false, failure: { code: 'DRAW_CONFLICT', reason: 'constraint' } };
  }
}

/**
 * Refuses a result that would give one participation two prizes or one prize
 * unit two winners.
 *
 * Thrown, not returned: these cannot happen from a correct pairing of a
 * deduplicated candidate list against a set of distinct units, so reaching this
 * means the code above is wrong rather than the data being inconvenient. The
 * unique indexes would catch it a moment later; this catches it where the
 * message can name the cause.
 */
function assertNoDuplicates(assignments: readonly AssignmentInsertValues[]): void {
  const winners = new Set(assignments.map((a) => a.entryId));
  if (winners.size !== assignments.length) {
    throw new Error('draw produced a duplicate winner');
  }
  const units = new Set(assignments.map((a) => `${a.prizeId}#${a.prizeUnitIndex}`));
  if (units.size !== assignments.length) {
    throw new Error('draw produced a duplicate prize unit');
  }
}
