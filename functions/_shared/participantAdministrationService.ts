// Administering the people who took part.
//
// SEPARATE from `ParticipantRegistrationService` on purpose, and the split is
// the same one phase 8 drew between registration and eligibility: that service
// turns a submission into a record, this one manages records that already
// exist. Putting both in one class would mean the code that writes somebody
// down and the code that removes them from consideration share a file, and a
// change to one would sit next to the other.
//
// WHAT THIS SERVICE MAY DO:      list, summarise, read, disqualify, reinstate.
// WHAT IT MAY NEVER DO:          register, validate a form, compute an age,
//                                re-run eligibility, edit an answer, draw,
//                                assign a prize, delete anything.
//
// THE INVARIANT IT EXISTS TO PROTECT: an entry's verdict — the age it was
// judged at, whether it passed, and why — belongs to the instant it was
// submitted. Disqualification is a later, separate, human decision recorded
// alongside it. Neither mutation below names a verdict column.

import type {
  AdminEventParticipant,
  AdminParticipantListQuery,
  AdminParticipantListResponse,
  AdminParticipantSummaryCounts,
  AuthenticatedAdmin,
  Event,
  EventEntry,
} from '../../shared/types';
import type { EventEntryStatus } from '../../shared/entryLifecycle';
import {
  EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
  canDisqualify,
  canReinstate,
  describeParticipantAdministrativeActions,
  eventAllowsParticipantAdministration,
  isDrawEligible,
  isReinstatableStatus,
  type ParticipantActionBlocker,
} from '../../shared/participantAdministration';

/**
 * Where the mutation sits in every administrative batch.
 *
 * Index 0 is the lifecycle guard, which modifies nothing in the ordinary case,
 * so reading `changes()` from it would report zero for a perfectly successful
 * mutation and turn every write into a phantom revision conflict.
 */
const MUTATION_INDEX = 1;
import { EventRepository } from './eventRepository';
import { EventEntryRepository } from './eventEntryRepository';
import { EntryAnswerRepository } from './entryAnswerRepository';
import { AuditService } from './auditService';
import { nowIso } from './time';
import { logger } from './logger';
import type { RequestContext } from './requestContext';

export type ParticipantAdminFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'EVENT_ENTRY_NOT_FOUND' }
  | { code: 'EVENT_PARTICIPANTS_NOT_EDITABLE'; eventStatus: string }
  | { code: 'ENTRY_ALREADY_DISQUALIFIED' }
  | { code: 'ENTRY_NOT_DISQUALIFIED' }
  | { code: 'ENTRY_NO_RESTORABLE_STATUS' }
  | { code: 'ENTRY_REVISION_CONFLICT'; currentRevision: number }
  | { code: 'ENTRY_UPDATE_FAILED'; reason: string };

export type ParticipantAdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: ParticipantAdminFailure };

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

/** Maps a shared blocker onto the API's typed refusal. */
const BLOCKER_FAILURE: Record<ParticipantActionBlocker, ParticipantAdminFailure['code']> = {
  EVENT_STATE_FORBIDS: 'EVENT_PARTICIPANTS_NOT_EDITABLE',
  ALREADY_DISQUALIFIED: 'ENTRY_ALREADY_DISQUALIFIED',
  NOT_DISQUALIFIED: 'ENTRY_NOT_DISQUALIFIED',
  NO_RESTORABLE_STATUS: 'ENTRY_NO_RESTORABLE_STATUS',
};

export class ParticipantAdministrationService {
  private readonly events: EventRepository;
  private readonly entries: EventEntryRepository;
  private readonly answers: EntryAnswerRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: {
      events?: EventRepository;
      entries?: EventEntryRepository;
      answers?: EntryAnswerRepository;
      audit?: AuditService;
    },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.entries = deps?.entries ?? new EventEntryRepository(db);
    this.answers = deps?.answers ?? new EntryAnswerRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    eventId: string,
    query: AdminParticipantListQuery,
  ): Promise<ParticipantAdminResult<AdminParticipantListResponse>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const { items, total } = await this.entries.listAdminByEvent(eventId, query);

    return {
      ok: true,
      value: {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        eventStatus: event.status,
        // Reported so the table can hide actions the server would refuse,
        // rather than the client re-deriving the lifecycle rule.
        administrationAllowed: eventAllowsParticipantAdministration(event.status),
      },
    };
  }

  async summary(eventId: string): Promise<
    ParticipantAdminResult<{
      summary: AdminParticipantSummaryCounts;
      eventStatus: Event['status'];
      administrationAllowed: boolean;
    }>
  > {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    return {
      ok: true,
      value: {
        summary: await this.entries.aggregateByEvent(eventId),
        eventStatus: event.status,
        administrationAllowed: eventAllowsParticipantAdministration(event.status),
      },
    };
  }

  /**
   * One participant's file.
   *
   * The answers are read for the entry, and the version they are interpreted
   * against is the entry's OWN `form_version_id` — never the version the event
   * currently publishes. Somebody who filled in v1 must be shown what v1 asked.
   */
  async detail(
    eventId: string,
    entryId: string,
  ): Promise<ParticipantAdminResult<{ participant: AdminEventParticipant; event: Event }>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const found = await this.entries.findAdminDetail(eventId, entryId);
    if (!found) return { ok: false, failure: { code: 'EVENT_ENTRY_NOT_FOUND' } };

    return {
      ok: true,
      value: { participant: this.project(event, found, await this.answers.listByEntry(entryId)), event },
    };
  }

  /** Assembles the detail DTO from the pieces, with the actions resolved. */
  private project(
    event: Event,
    found: NonNullable<Awaited<ReturnType<EventEntryRepository['findAdminDetail']>>>,
    answers: AdminEventParticipant['answers'],
  ): AdminEventParticipant {
    const { entry, participant, formVersionNumber, disqualifiedByName } = found;

    return {
      entryId: entry.id,
      entryRevision: entry.revision,
      participant,
      entry: {
        status: entry.status,
        submittedAt: entry.submittedAt,
        formVersionId: entry.formVersionId,
        formVersionNumber,
        calculatedAge: entry.calculatedAge,
        ageEligible: entry.ageEligible,
        overallEligible: entry.overallEligible,
        eligibilityReason: entry.eligibilityReason,
        disposition:
          entry.status === 'DISQUALIFIED' &&
          entry.disqualifiedAt !== null &&
          entry.disqualificationReason !== null &&
          isReinstatableStatus(entry.preDisqualificationStatus)
            ? {
                disqualifiedAt: entry.disqualifiedAt,
                disqualifiedByAdminId: entry.disqualifiedByAdminId,
                disqualifiedByName,
                reason: entry.disqualificationReason,
                preDisqualificationStatus: entry.preDisqualificationStatus,
              }
            : null,
      },
      answers,
      actions: describeParticipantAdministrativeActions({
        eventStatus: event.status,
        entryStatus: entry.status,
        preDisqualificationStatus: entry.preDisqualificationStatus,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async disqualify(
    eventId: string,
    entryId: string,
    input: { expectedRevision: number; reason: string },
    actor: Actor,
  ): Promise<ParticipantAdminResult<AdminEventParticipant>> {
    const context = await this.loadForMutation(eventId, entryId);
    if (!context.ok) return context;
    const { event, entry } = context.value;

    const permission = canDisqualify({
      eventStatus: event.status,
      entryStatus: entry.status,
      preDisqualificationStatus: entry.preDisqualificationStatus,
    });
    if (!permission.allowed) return this.refuse(permission.blocker, event.status);

    // Checked here as well as in the statement's WHERE. This one produces the
    // clean typed answer for the ordinary case; the WHERE clause is what
    // survives a concurrent writer arriving between the two.
    if (entry.revision !== input.expectedRevision) {
      return {
        ok: false,
        failure: { code: 'ENTRY_REVISION_CONFLICT', currentRevision: entry.revision },
      };
    }

    const at = nowIso();
    const reason = input.reason.trim();

    return this.commit(
      eventId,
      entryId,
      entry,
      [
        // FIRST in the batch. The permission check above read the event a
        // moment ago; this re-asserts it AT COMMIT TIME, so an event that
        // reaches DRAW_COMPLETED in between takes the whole batch down instead
        // of letting a disqualification land on a population a draw has already
        // consumed.
        this.events.abortUnlessParticipantsAdministrableStatement(
          eventId,
          EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
        ),
        this.entries.disqualifyStatement({
          eventId,
          entryId,
          expectedRevision: input.expectedRevision,
          reason,
          adminId: actor.admin.id,
          at,
        }),
        this.audit.statementFor(
          {
            action: 'EVENT_ENTRY_DISQUALIFIED',
            entityType: 'EVENT_ENTRY',
            entityId: entryId,
            eventId,
            actor: {
              id: actor.admin.id,
              email: actor.admin.email,
              displayName: actor.admin.displayName,
            },
            requestContext: actor.requestContext,
            // Identifiers and statuses only. No name, no email, no date of
            // birth, no answers: the audit table is append-only and never
            // deleted, so a copy of somebody's details in it is a copy no
            // erasure request could ever reach.
            previousData: { status: entry.status, revision: entry.revision },
            newData: {
              status: 'DISQUALIFIED',
              revision: entry.revision + 1,
              preDisqualificationStatus: entry.status,
            },
            // The reason IS recorded: it is the justification for an
            // administrative act, and a trail without it cannot answer "why was
            // this person removed?". It is operator-written text about a
            // decision, not personal data the participant supplied.
            metadata: { reason, eventStatus: event.status },
          },
          // Writes nothing if the guarded UPDATE matched no row, so a lost race
          // cannot leave behind an audit entry for a change that never happened.
          { onlyIfPreviousChanged: true },
        ),
        // LAST, and only when the candidate set actually moved.
        //
        // Somebody who was never draw-eligible leaving the running changes
        // nothing a draw would take, and bumping the counter for them would
        // invalidate a draw in flight for no reason. Placed after the audit
        // insert because `changes()` reads the most recent modification, and
        // that insert is itself conditional on the mutation having landed — so
        // the counter advances exactly when the disqualification did.
        ...(isDrawEligible(entry)
          ? [this.events.bumpPopulationRevisionStatement(eventId)]
          : []),
      ],
      'disqualify',
    );
  }

  async reinstate(
    eventId: string,
    entryId: string,
    input: { expectedRevision: number },
    actor: Actor,
  ): Promise<ParticipantAdminResult<AdminEventParticipant>> {
    const context = await this.loadForMutation(eventId, entryId);
    if (!context.ok) return context;
    const { event, entry } = context.value;

    const permission = canReinstate({
      eventStatus: event.status,
      entryStatus: entry.status,
      preDisqualificationStatus: entry.preDisqualificationStatus,
    });
    if (!permission.allowed) return this.refuse(permission.blocker, event.status);

    if (entry.revision !== input.expectedRevision) {
      return {
        ok: false,
        failure: { code: 'ENTRY_REVISION_CONFLICT', currentRevision: entry.revision },
      };
    }

    // Read off the ROW, never recomputed. Running the age rule again would
    // answer a different question — against today's date and today's minimum
    // age — and could hand somebody a different verdict from the one they were
    // originally given.
    const restoredTo = entry.preDisqualificationStatus as EventEntryStatus;

    return this.commit(
      eventId,
      entryId,
      entry,
      [
        // Same guard, same reason: a reinstatement is a change to the
        // population and must not slip past a state transition either.
        this.events.abortUnlessParticipantsAdministrableStatement(
          eventId,
          EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
        ),
        this.entries.reinstateStatement({
          eventId,
          entryId,
          expectedRevision: input.expectedRevision,
          at: nowIso(),
        }),
        this.audit.statementFor(
          {
            action: 'EVENT_ENTRY_REINSTATED',
            entityType: 'EVENT_ENTRY',
            entityId: entryId,
            eventId,
            actor: {
              id: actor.admin.id,
              email: actor.admin.email,
              displayName: actor.admin.displayName,
            },
            requestContext: actor.requestContext,
            previousData: {
              status: 'DISQUALIFIED',
              revision: entry.revision,
              // The reason the entry was removed, preserved in the trail at the
              // moment it stops being recorded on the row.
              reason: entry.disqualificationReason,
            },
            newData: { status: restoredTo, revision: entry.revision + 1 },
            metadata: { eventStatus: event.status },
          },
          { onlyIfPreviousChanged: true },
        ),
        // Only when the entry is coming BACK INTO the running. Restoring
        // somebody to SUBMITTED or INELIGIBLE changes nothing a draw would
        // take. The destination is read off the row, exactly as the statement
        // reads it — never recomputed.
        ...(isDrawEligible({ status: restoredTo, overallEligible: entry.overallEligible })
          ? [this.events.bumpPopulationRevisionStatement(eventId)]
          : []),
      ],
      'reinstate',
    );
  }

  // -------------------------------------------------------------------------
  // Shared plumbing
  // -------------------------------------------------------------------------

  private async loadForMutation(
    eventId: string,
    entryId: string,
  ): Promise<ParticipantAdminResult<{ event: Event; entry: EventEntry }>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    // Scoped by event: an entry id from another event resolves to nothing, so a
    // guessed id is a 404 rather than a mutation. Reported the same way a
    // missing entry is, because "it exists but not here" is itself information.
    const entry = await this.entries.findByEventAndId(eventId, entryId);
    if (!entry) return { ok: false, failure: { code: 'EVENT_ENTRY_NOT_FOUND' } };

    return { ok: true, value: { event, entry } };
  }

  private refuse(
    blocker: ParticipantActionBlocker,
    eventStatus: string,
  ): ParticipantAdminResult<never> {
    const code = BLOCKER_FAILURE[blocker];
    return {
      ok: false,
      failure:
        code === 'EVENT_PARTICIPANTS_NOT_EDITABLE'
          ? { code, eventStatus }
          : ({ code } as ParticipantAdminFailure),
    };
  }

  /**
   * Commits a mutation and its audit row as ONE batch.
   *
   * All or nothing: if the audit insert fails, the status change is rolled back
   * with it. An administrative act that happened without a record of who
   * performed it is exactly what the audit table exists to prevent, so
   * "recorded but unattributed" is not an acceptable outcome.
   *
   * A guarded UPDATE matching zero rows is NOT an error — it is the concurrency
   * guard working. The batch still commits (having changed nothing, since the
   * audit row is conditional on the update), and the caller is told the
   * revision moved.
   */
  private async commit(
    eventId: string,
    entryId: string,
    before: EventEntry,
    statements: D1PreparedStatement[],
    action: 'disqualify' | 'reinstate',
  ): Promise<ParticipantAdminResult<AdminEventParticipant>> {
    let changed = 0;
    try {
      const results = await this.db.batch(statements);
      // Index 1: the guard occupies index 0 and never modifies a row while the
      // event is still administrable.
      changed = Number(results[MUTATION_INDEX]?.meta?.changes ?? 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // The lifecycle guard fired: the event left an administrable state
      // between the permission check and the commit. Nothing was written — the
      // whole batch rolled back — so this is a clean refusal rather than a
      // failure.
      if (/NOT NULL/i.test(message) && /events\.status/.test(message)) {
        const current = await this.events.findById(eventId);
        return {
          ok: false,
          failure: {
            code: 'EVENT_PARTICIPANTS_NOT_EDITABLE',
            eventStatus: current?.status ?? 'UNKNOWN',
          },
        };
      }

      logger.error('participant administration failed', {
        action: `PARTICIPANT_${action.toUpperCase()}_FAILED`,
        eventId,
        entryId,
        // The message only, never the row: a constraint error naming a column
        // is a diagnostic; the values in it are somebody's data.
        errorMessage: message.slice(0, 200),
      });
      return { ok: false, failure: { code: 'ENTRY_UPDATE_FAILED', reason: 'constraint' } };
    }

    if (changed === 0) {
      // Somebody else acted between the read and the write. Re-read so the
      // caller is told the CURRENT revision rather than the one they sent.
      const current = await this.entries.findByEventAndId(eventId, entryId);
      return {
        ok: false,
        failure: {
          code: 'ENTRY_REVISION_CONFLICT',
          currentRevision: current?.revision ?? before.revision,
        },
      };
    }

    const reloaded = await this.detail(eventId, entryId);
    if (!reloaded.ok) {
      return { ok: false, failure: { code: 'ENTRY_UPDATE_FAILED', reason: 'reload' } };
    }
    return { ok: true, value: reloaded.value.participant };
  }
}
