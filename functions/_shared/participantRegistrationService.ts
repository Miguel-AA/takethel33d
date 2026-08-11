// Turning a set of answers into a participant, an entry and its answers.
//
// This is the whole of phase 7's write path, and it has one shape:
//
//   [ abort unless the event is STILL accepting entries ,
//     the participant (inserted or refreshed) ,
//     the entry ,
//     every answer ,
//     the audit row ]
//
// One `db.batch()`. If any part fails, none of it happened — there is no state
// in which a participant exists without the entry that justified creating them,
// an entry exists without its answers, or somebody took part without a record
// of it.
//
// THE PUBLISHED VERSION IS THE AUTHORITY. The caller sends answers and nothing
// else: no participant object, no version id, no status, no timestamps, no
// snapshots. Everything else is resolved from the event and the version it
// currently serves, because everything else is something a caller could get
// wrong — or lie about.

import type {
  AuthenticatedAdmin,
  Event,
  EventEntry,
  EventEntryDetail,
  EventEntryListQuery,
  EventEntryListResponse,
  FormQuestion,
  Participant,
  SubmittedAnswer,
} from '../../shared/types';
import {
  extractParticipantProfile,
  validateSubmission,
  type AcceptedAnswer,
  type AnswerProblem,
  type AnswerType,
  type ParticipantProfile,
  type SubmissionProblem,
} from '../../shared/formAnswers';
import {
  entryWindowProblem,
  eventAcceptsEntries,
  type EntryWindowProblem,
} from '../../shared/entryLifecycle';
import {
  statusForDecision,
  type EligibilityDecision,
} from '../../shared/eligibility';
import { normalizeEmail } from '../../shared/schemas';
import { EventRepository, type RegistrationRules } from './eventRepository';
import { EligibilityService } from './eligibilityService';
import { FormVersionRepository } from './formVersionRepository';
import { ParticipantRepository } from './participantRepository';
import { EventEntryRepository } from './eventEntryRepository';
import {
  EntryAnswerRepository,
  serializeAnswerValue,
  type EntryAnswerValues,
} from './entryAnswerRepository';
import { AuditService } from './auditService';
import { newId } from './ids';
import { nowIso } from './time';
import { logger } from './logger';
import type { RequestContext } from './requestContext';

export type EntryFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'EVENT_ENTRY_NOT_FOUND' }
  | { code: 'EVENT_NOT_ACCEPTING_ENTRIES'; reason: EntryWindowProblem }
  | { code: 'FORM_VERSION_REQUIRED'; reason: 'none' | 'foreign' | 'missing' | 'empty' }
  | { code: 'FORM_VERSION_INVALID'; reason: string }
  | { code: 'DUPLICATE_FORM_ANSWER'; questionIds: string[] }
  | { code: 'FORM_ANSWER_UNKNOWN_QUESTION'; questionIds: string[] }
  | { code: 'FORM_ANSWER_NOT_ALLOWED'; questionIds: string[]; reason: 'information' | 'inactive' }
  | {
      code: 'FORM_ANSWER_INVALID';
      answers: Array<{ questionId: string; questionKey: string; problem: AnswerProblem }>;
    }
  | {
      code: 'FORM_REQUIRED_ANSWER_MISSING';
      questions: Array<{ questionId: string; questionKey: string }>;
    }
  | { code: 'PARTICIPANT_IDENTITY_CONFLICT'; field: 'dateOfBirth' }
  | { code: 'DATE_OF_BIRTH_INVALID'; problem: string }
  | { code: 'DATE_OF_BIRTH_REQUIRED' }
  | { code: 'EVENT_REGISTRATION_CONFIG_CHANGED' }
  | { code: 'PARTICIPANT_ALREADY_ENTERED'; entryId: string | null }
  // Raised only by an `identityGate` — the public flow's rate limiter, which
  // can only decide once the address is known. The administrative path never
  // installs a gate and therefore never produces this.
  | { code: 'ENTRY_RATE_LIMITED'; retryAfterSeconds: number }
  | { code: 'ENTRY_CREATE_FAILED'; reason: string };

export type EntryResult<T> = { ok: true; value: T } | { ok: false; failure: EntryFailure };

/**
 * Who is acting.
 *
 * `admin` is NULLABLE from phase 9 onward, because a participant registering
 * themselves is a real actor with no administrative identity. The audit trail
 * already models this: `audit_logs.actor_admin_id` is nullable with
 * `ON DELETE SET NULL`, and `AuditService.buildEntry` reads `input.actor?.id ??
 * null`. A public registration is therefore recorded with the same fidelity as
 * an administrative one, attributed to a request rather than to a person.
 */
interface Actor {
  admin: AuthenticatedAdmin | null;
  requestContext: RequestContext;
}

/**
 * What the caller may influence about how a registration is recorded.
 *
 * Deliberately small. Nothing here can change WHAT is decided — the version,
 * the rules and the verdict are all resolved inside — only how the operation is
 * deduplicated and whether an extra refusal applies.
 */
export interface RegistrationOptions {
  /**
   * The public flow's idempotency key. Absent for administrative entries, whose
   * caller is a person in a form and has no client-side retry to collapse.
   */
  submissionId?: string | null;
  /**
   * A veto consulted ONCE, after the identity is known and before anything is
   * written.
   *
   * This exists so the public rate limiter can act on the email address without
   * the handler having to re-resolve the version and re-validate the answers to
   * discover it. Placing it here rather than in the handler keeps ONE
   * implementation of the submission pipeline: the gate is a hook in that
   * pipeline, not a second copy of it.
   */
  identityGate?: (normalizedEmail: string) => Promise<EntryFailure | null>;
}

export interface RegistrationOutcome {
  entry: EventEntry;
  participant: Participant;
  answerCount: number;
  /** The verdict, as it was decided and as it was written. */
  decision: EligibilityDecision;
  /**
   * True when this submission had already been recorded and nothing new was
   * written — no participant, no entry, no answers, no audit row, and no second
   * eligibility evaluation. The result is reconstructed from the stored entry.
   */
  replayed: boolean;
}

/**
 * Where the version came from, resolved once.
 *
 * Resolved ONCE and then carried, never re-resolved mid-operation: if an
 * administrator publishes v2 while this submission is being validated, the
 * entry stays bound to the v1 it was actually validated against. Re-reading the
 * pointer halfway would produce an entry whose answers were checked against one
 * form and recorded against another.
 */
interface ResolvedVersion {
  id: string;
  versionNumber: number;
  questions: FormQuestion[];
  steps: import('../../shared/types').FormStep[];
}

export class ParticipantRegistrationService {
  private readonly events: EventRepository;
  private readonly versions: FormVersionRepository;
  private readonly participants: ParticipantRepository;
  private readonly entries: EventEntryRepository;
  private readonly answers: EntryAnswerRepository;
  private readonly audit: AuditService;
  private readonly eligibility: EligibilityService;

  constructor(
    private readonly db: D1Database,
    deps?: {
      events?: EventRepository;
      versions?: FormVersionRepository;
      participants?: ParticipantRepository;
      entries?: EventEntryRepository;
      answers?: EntryAnswerRepository;
      audit?: AuditService;
      eligibility?: EligibilityService;
    },
  ) {
    this.events = deps?.events ?? new EventRepository(db);
    this.versions = deps?.versions ?? new FormVersionRepository(db);
    this.participants = deps?.participants ?? new ParticipantRepository(db);
    this.entries = deps?.entries ?? new EventEntryRepository(db);
    this.answers = deps?.answers ?? new EntryAnswerRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
    this.eligibility = deps?.eligibility ?? new EligibilityService();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    eventId: string,
    query: EventEntryListQuery,
  ): Promise<EntryResult<EventEntryListResponse>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const { items, total } = await this.entries.listByEvent(eventId, query);
    return {
      ok: true,
      value: {
        items,
        total,
        page: query.page,
        pageSize: query.pageSize,
        eventStatus: event.status,
        acceptingEntries: entryWindowProblem(event, nowIso()) === null,
      },
    };
  }

  /**
   * One entry in full.
   *
   * Scoped by event throughout: an entry id belonging to another event resolves
   * to nothing, so a guessed id cannot read somebody else's participants.
   */
  async detail(eventId: string, entryId: string): Promise<EntryResult<EventEntryDetail>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const entry = await this.entries.findByEventAndId(eventId, entryId);
    if (!entry) return { ok: false, failure: { code: 'EVENT_ENTRY_NOT_FOUND' } };

    const participant = await this.participants.findById(entry.participantId);
    if (!participant) {
      // Unreachable through the application: the foreign key is RESTRICT and
      // there is no delete. Reaching it means the row was removed outside the
      // application, and an entry with no identity behind it is a record of
      // nothing.
      logger.error('event entry points at a participant that no longer exists', {
        action: 'EVENT_ENTRY_PARTICIPANT_MISSING',
        eventId,
        entryId,
      });
      return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'participant_missing' } };
    }

    // Scoped the same way: the version must be one of THIS event's.
    const version = await this.versions.findById(eventId, entry.formVersionId);
    if (!version) {
      logger.error('event entry points at a version that is not its own event’s', {
        action: 'EVENT_ENTRY_VERSION_FOREIGN',
        eventId,
        entryId,
        versionId: entry.formVersionId,
      });
      return { ok: false, failure: { code: 'FORM_VERSION_INVALID', reason: 'foreign' } };
    }

    return {
      ok: true,
      value: {
        entry,
        participant,
        formVersion: {
          id: version.id,
          versionNumber: version.versionNumber,
          publishedAt: version.publishedAt,
        },
        answers: await this.answers.listByEntry(entry.id),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * The version this event serves, with its structure.
   *
   * Goes through `pointerCondition` rather than reading the column, for the
   * reason phase 6 established: SQLite cannot express "and it must belong to
   * THIS event", so the pointer is resolved rather than trusted. An entry bound
   * to another event's form would be a person answering somebody else's
   * questions.
   */
  private async resolveVersion(eventId: string): Promise<EntryResult<ResolvedVersion>> {
    const condition = await this.versions.pointerCondition(eventId);
    if (condition !== 'valid') {
      if (condition === 'foreign' || condition === 'missing') {
        logger.error('event points at a form version that is not its own', {
          action: 'EVENT_PUBLISHED_FORM_POINTER_INVALID',
          eventId,
          reason: condition,
        });
      }
      return { ok: false, failure: { code: 'FORM_VERSION_REQUIRED', reason: condition } };
    }

    const record = await this.versions.findCurrentPublished(eventId);
    if (!record) return { ok: false, failure: { code: 'FORM_VERSION_REQUIRED', reason: 'none' } };

    const loaded = await this.versions.loadVersion(eventId, record.id);
    if (!loaded) return { ok: false, failure: { code: 'FORM_VERSION_REQUIRED', reason: 'missing' } };

    return {
      ok: true,
      value: {
        id: loaded.version.id,
        versionNumber: loaded.version.versionNumber,
        steps: loaded.version.steps,
        questions: loaded.version.steps.flatMap((step) => step.questions),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Records a participation.
   *
   * The order matters and is not arbitrary: everything that can be refused
   * without touching the database is refused first, so a submission that was
   * never going to work does not create a participant on its way to failing.
   */
  async register(
    eventId: string,
    answers: readonly SubmittedAnswer[],
    actor: Actor,
    options: RegistrationOptions = {},
  ): Promise<EntryResult<RegistrationOutcome>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const resolved = await this.resolveVersion(eventId);
    if (!resolved.ok) return resolved;

    return this.registerAgainstVersion(event, resolved.value, answers, actor, options);
  }

  /**
   * Records a participation against ONE NAMED VERSION.
   *
   * This is the public flow's entry point, and the difference from `register`
   * is the entire reason it exists: `register` asks the event which version it
   * serves RIGHT NOW, while this one is told which version the participant was
   * actually shown. Between a page load and a submission an administrator can
   * publish a new version, and validating the answers against it would judge
   * somebody on questions they were never asked.
   *
   * The version is resolved through `loadVersion`, which is scoped by event —
   * so a version id belonging to another event resolves to nothing, and a
   * forged or leaked identifier cannot make one event serve another's form.
   * That check is not redundant with the token's signature: the signature
   * proves WE minted the pair, and this proves the pair is still coherent.
   */
  async registerWithResolvedVersion(
    eventId: string,
    versionId: string,
    answers: readonly SubmittedAnswer[],
    actor: Actor,
    options: RegistrationOptions = {},
  ): Promise<EntryResult<RegistrationOutcome>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const loaded = await this.versions.loadVersion(eventId, versionId);
    if (!loaded) {
      // The version named by a signed token does not belong to this event, or
      // no longer exists. Reported as a version problem rather than a token
      // problem: the token verified, so what is wrong is the data behind it.
      return { ok: false, failure: { code: 'FORM_VERSION_REQUIRED', reason: 'missing' } };
    }

    const version: ResolvedVersion = {
      id: loaded.version.id,
      versionNumber: loaded.version.versionNumber,
      steps: loaded.version.steps,
      questions: loaded.version.steps.flatMap((step) => step.questions),
    };

    return this.registerAgainstVersion(event, version, answers, actor, options);
  }

  /**
   * The one pipeline both entry points share.
   *
   * Everything that decides anything lives here — window, validation, identity,
   * eligibility, persistence, audit — so the administrative and public flows
   * cannot drift into two subtly different sets of rules. The ONLY thing the
   * callers differ on is which version they arrive with.
   */
  private async registerAgainstVersion(
    event: Event,
    version: ResolvedVersion,
    answers: readonly SubmittedAnswer[],
    actor: Actor,
    options: RegistrationOptions,
  ): Promise<EntryResult<RegistrationOutcome>> {
    const submissionId = options.submissionId ?? null;

    // The replay check comes FIRST, before the window is examined.
    //
    // That ordering is deliberate and is the whole meaning of idempotency: a
    // submission that already succeeded stays succeeded. Somebody whose entry
    // was recorded at 16:59 and who retries at 17:01, after registration
    // closed, must be told what happened to their submission — not that they
    // are too late for something they already did.
    if (submissionId !== null) {
      const existing = await this.entries.findByEventAndSubmissionId(event.id, submissionId);
      if (existing) return this.replay(existing);
    }

    // THE authoritative instant. Captured once and used for the window, the
    // event's local date, the age, `submitted_at` and the in-batch guard — so a
    // submission that spans local midnight cannot be judged against one day and
    // recorded against another.
    const now = new Date();
    const at = now.toISOString();

    const window = entryWindowProblem(event, at);
    if (window !== null) {
      return { ok: false, failure: { code: 'EVENT_NOT_ACCEPTING_ENTRIES', reason: window } };
    }

    const eventId = event.id;

    // Every answer is checked against the FROZEN structure — never the draft,
    // which an operator may be editing right now.
    const submission = validateSubmission(version.steps, answers);
    if (!submission.ok) {
      return { ok: false, failure: describeSubmissionFailure(submission.problems) };
    }

    const profile = extractParticipantProfile(submission.accepted);
    if (!profile.ok) {
      // Publishing guarantees these three exist, active and required, so this
      // means the stored version is not what publishing would have produced.
      logger.error('published version is missing a required system field', {
        action: 'FORM_VERSION_SYSTEM_FIELD_MISSING',
        eventId,
        versionId: version.id,
        reason: profile.missing.join(','),
      });
      return { ok: false, failure: { code: 'FORM_VERSION_INVALID', reason: 'system_fields' } };
    }

    // The decision is made from the event's rules and the FROZEN version, at
    // the one instant this operation owns. It is computed before anything is
    // written, so the entry can be born decided.
    const verdict = this.eligibility.evaluate({
      event,
      versionSteps: version.steps,
      dateOfBirth: profile.profile.dateOfBirth,
      now,
    });
    if (!verdict.ok) {
      switch (verdict.failure.code) {
        case 'DATE_OF_BIRTH_INVALID':
          return {
            ok: false,
            failure: { code: 'DATE_OF_BIRTH_INVALID', problem: verdict.failure.problem },
          };
        case 'DATE_OF_BIRTH_REQUIRED':
          return { ok: false, failure: { code: 'DATE_OF_BIRTH_REQUIRED' } };
        case 'FORM_INVALID':
          return {
            ok: false,
            failure: { code: 'FORM_VERSION_INVALID', reason: verdict.failure.reason },
          };
        case 'EVENT_TIMEZONE_INVALID':
          return {
            ok: false,
            failure: { code: 'FORM_VERSION_INVALID', reason: 'event_timezone' },
          };
      }
    }

    const rows = this.buildAnswerRows(submission.accepted, at);
    if (!rows.ok) return rows;

    // The identity is known now, and nothing has been written yet — the only
    // point at which a rate limiter keyed on the email can refuse without
    // either guessing the address or having already created a participant.
    if (options.identityGate) {
      const refusal = await options.identityGate(normalizeEmail(profile.profile.email));
      if (refusal) return { ok: false, failure: refusal };
    }

    return this.commit(
      event,
      version,
      profile.profile,
      rows.value,
      verdict.decision,
      at,
      actor,
      submissionId,
    );
  }

  /**
   * Rebuilds the result of a submission that was already recorded.
   *
   * Nothing is written and nothing is recomputed: the verdict is read back off
   * the row it was stored on. That is what makes a retry genuinely idempotent
   * rather than merely repeatable — re-running the eligibility rule could
   * legitimately produce a different answer today (the person has had a
   * birthday, or the organiser changed the minimum age), and returning that
   * would mean the same submission had two outcomes.
   */
  private async replay(entry: EventEntry): Promise<EntryResult<RegistrationOutcome>> {
    const participant = await this.participants.findById(entry.participantId);
    if (!participant) {
      logger.error('replayed entry points at a participant that no longer exists', {
        action: 'EVENT_ENTRY_PARTICIPANT_MISSING',
        eventId: entry.eventId,
        entryId: entry.id,
      });
      return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'participant_missing' } };
    }

    const decision = decisionFromEntry(entry);
    if (decision === null) {
      // Only reachable for a row recorded before eligibility existed, which by
      // definition carries no submission id and so cannot be replayed. Refused
      // rather than invented: fabricating a verdict for a participation nobody
      // judged is worse than admitting the row cannot be summarised.
      logger.error('replayed entry carries no decision to reconstruct', {
        action: 'EVENT_ENTRY_REPLAY_UNDECIDED',
        eventId: entry.eventId,
        entryId: entry.id,
      });
      return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'replay_undecided' } };
    }

    return {
      ok: true,
      value: {
        entry,
        participant,
        answerCount: await this.answers.countByEntry(entry.id),
        decision,
        replayed: true,
      },
    };
  }

  /** Serializes every accepted answer, refusing the submission if any cannot be. */
  private buildAnswerRows(
    accepted: readonly AcceptedAnswer[],
    at: string,
  ): EntryResult<Array<Omit<EntryAnswerValues, 'entryId'>>> {
    const rows: Array<Omit<EntryAnswerValues, 'entryId'>> = [];

    for (const answer of accepted) {
      const serialized = serializeAnswerValue(answer.value);
      if (!serialized.ok) {
        return {
          ok: false,
          failure: { code: 'ENTRY_CREATE_FAILED', reason: `answer_${serialized.reason}` },
        };
      }
      rows.push({
        id: newId(),
        questionId: answer.question.id,
        // Copied from the VERSION, never from the request: a caller that could
        // choose its own key or type could file an answer under someone else's
        // question, or claim a text reply was a consent.
        questionKey: answer.question.key,
        questionLabel: answer.question.label,
        answerType: answer.question.type as AnswerType,
        answerValue: serialized.json,
        at,
      });
    }

    return { ok: true, value: rows };
  }

  /**
   * Resolves the identity and commits everything in one batch.
   *
   * Retried ONCE, and only for the specific race it exists to survive: two
   * submissions from the same address arriving together, where both see "no
   * such participant" and both try to create one. The unique index lets exactly
   * one win; the loser re-reads the winner's row and continues as an existing
   * identity — which then meets the duplicate-entry constraint if it is the
   * same event, and succeeds if it is a different one.
   */
  private async commit(
    event: Event,
    version: ResolvedVersion,
    profile: ParticipantProfile,
    answerRows: Array<Omit<EntryAnswerValues, 'entryId'>>,
    decision: EligibilityDecision,
    at: string,
    actor: Actor,
    submissionId: string | null,
    attempt = 0,
  ): Promise<EntryResult<RegistrationOutcome>> {
    const normalizedEmail = normalizeEmail(profile.email);
    const existing = await this.participants.findByNormalizedEmail(normalizedEmail);

    if (existing) {
      const conflict = identityConflict(existing, profile);
      if (conflict) {
        // Never resolved silently. Two different dates of birth for one address
        // means either a typo or two people sharing an inbox, and guessing
        // which would either corrupt a record or decide somebody's eligibility
        // on data they did not give.
        return { ok: false, failure: { code: 'PARTICIPANT_IDENTITY_CONFLICT', field: conflict } };
      }

      // Cheap refusal before building a batch that the index would refuse
      // anyway. The constraint is still what decides; this only makes the
      // ordinary case a clean 409 instead of a caught error.
      const already = await this.entries.findByEventAndParticipant(event.id, existing.id);
      if (already) {
        // IS IT OURS? An entry already exists for this identity, but if it
        // carries THIS submission's key then it is not somebody else's
        // participation — it is this very submission, already recorded.
        //
        // Reachable when two simultaneous retries race: the loser re-reads the
        // winner's identity, and without this check the duplicate-identity
        // precheck would fire before the submission index ever got a chance,
        // and a person double-tapping Submit would be told they had already
        // entered rather than shown their result.
        if (submissionId !== null && already.submissionId === submissionId) {
          return this.replay(already);
        }
        return {
          ok: false,
          failure: { code: 'PARTICIPANT_ALREADY_ENTERED', entryId: already.id },
        };
      }
    }

    const participantId = existing?.id ?? newId();
    const entryId = newId();
    const rules: RegistrationRules = {
      minimumAge: event.minimumAge,
      timezone: event.timezone,
    };
    // Null for a public registration: there is no administrator behind it. The
    // audit row still records the action, the entity, the event, the request id
    // and the hashed IP — it simply has nobody to attribute it to, which is the
    // truth rather than a gap.
    const auditActor = actor.admin
      ? {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        }
      : null;

    const statements: D1PreparedStatement[] = [
      // The event must still be accepting entries when this batch RUNS, not
      // merely when it was read — and it must still carry the RULES the verdict
      // above was computed from. An operator raising the minimum age or moving
      // the event to another timezone in between would otherwise leave a stored
      // decision that no configuration ever produced.
      this.events.abortUnlessAcceptingEntriesStatement(event.id, at, rules),
      existing
        ? this.participants.updateProfileStatement(participantId, {
            email: profile.email,
            firstName: profile.firstName,
            lastName: profile.lastName,
            phone: profile.phone,
            dateOfBirth: profile.dateOfBirth,
            at,
          })
        : this.participants.insertStatement({
            id: participantId,
            email: profile.email,
            normalizedEmail,
            firstName: profile.firstName,
            lastName: profile.lastName,
            phone: profile.phone,
            dateOfBirth: profile.dateOfBirth,
            at,
          }),
      this.entries.insertStatement({
        id: entryId,
        eventId: event.id,
        participantId,
        // The version resolved at the start of this operation, not re-read now.
        formVersionId: version.id,
        // Born decided: the status and the verdict are written by the same
        // statement that creates the row.
        status: statusForDecision(decision),
        decision,
        // Travels in the SAME statement that creates the entry, so the unique
        // index is what arbitrates a concurrent retry. A key written afterwards
        // would leave a window in which two batches both believed they were
        // first.
        submissionId,
        submittedAt: at,
        ipHash: actor.requestContext.ipHash,
        userAgent: actor.requestContext.userAgent,
      }),
      ...this.answers.insertStatements(
        answerRows.map((row) => ({ ...row, entryId })),
      ),
      // What happened to the IDENTITY, and what happened to the EVENT are two
      // different facts about two different entities. One row cannot be both
      // without making the trail ambiguous later.
      this.audit.statementFor({
        action: existing ? 'PARTICIPANT_UPDATED' : 'PARTICIPANT_CREATED',
        entityType: 'PARTICIPANT',
        entityId: participantId,
        eventId: event.id,
        actor: auditActor,
        requestContext: actor.requestContext,
        // No name, no email, no phone, no date of birth. The audit table is
        // append-only and deliberately never deleted; putting a person's
        // details in it would create a second copy of their data that no
        // erasure request could ever reach. The identity row is the copy.
        newData: { participantId, entryId },
      }),
      this.audit.statementFor({
        action: 'EVENT_ENTRY_CREATED',
        entityType: 'EVENT_ENTRY',
        entityId: entryId,
        eventId: event.id,
        actor: auditActor,
        requestContext: actor.requestContext,
        // One row carries the whole registration, decision included: two rows
        // for one act would have to be read together to mean anything, and one
        // of them could be the one that failed to write.
        newData: {
          entryId,
          participantId,
          formVersionId: version.id,
          formVersionNumber: version.versionNumber,
          answerCount: answerRows.length,
          participantCreated: existing === null,
          status: statusForDecision(decision),
          calculatedAge: decision.calculatedAge,
          ageEligible: decision.ageEligible,
          overallEligible: decision.overallEligible,
          eligibilityReason: decision.reasonCode,
        },
        // The AGE, never the date of birth. One is a number that explains a
        // decision; the other is the personal data the decision was made from,
        // and the audit table is append-only and never deleted.
        metadata: { eventStatus: event.status, minimumAge: event.minimumAge },
      }),
    ];

    try {
      await this.db.batch(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // THE SAME SUBMISSION ARRIVED TWICE AT ONCE.
      //
      // Checked FIRST, before the duplicate-identity case, because it is the
      // more specific of the two and they overlap: a genuine double-tap trips
      // both indexes, and answering ALREADY_ENTERED to somebody retrying their
      // own submission would be both wrong and alarming.
      //
      // Losing this race is not an error. The whole batch — entry, answers and
      // BOTH audit rows — rolled back, so the winner's write is the only one
      // that happened, and re-reading it produces exactly the result the winner
      // received. That is why the audit row is inside the batch rather than
      // written alongside it.
      if (
        submissionId !== null &&
        /UNIQUE/i.test(message) &&
        /submission_id/i.test(message)
      ) {
        const winner = await this.entries.findByEventAndSubmissionId(
          event.id,
          submissionId,
        );
        if (winner) return this.replay(winner);
        return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'submission_race' } };
      }

      // Somebody else registered this identity for this event first.
      if (/UNIQUE/i.test(message) && /event_entries|event_id, participant_id/i.test(message)) {
        const winner = await this.entries.findByEventAndParticipant(event.id, participantId);
        // Same question as in the precheck above: the row that beat us may be
        // this submission itself, arriving twice at once.
        if (submissionId !== null && winner && winner.submissionId === submissionId) {
          return this.replay(winner);
        }
        return {
          ok: false,
          failure: { code: 'PARTICIPANT_ALREADY_ENTERED', entryId: winner?.id ?? null },
        };
      }

      // Somebody else created this identity a moment ago. Re-read and continue;
      // once only, because a second collision on a re-read means something
      // other than a race.
      if (/UNIQUE/i.test(message) && /normalized_email|participants/i.test(message)) {
        if (attempt === 0) {
          return this.commit(
            event,
            version,
            profile,
            answerRows,
            decision,
            at,
            actor,
            submissionId,
            attempt + 1,
          );
        }
        return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'identity_race' } };
      }

      // The abort guard fired. It covers two different things, so the answer
      // is decided by re-reading the event rather than guessing: either it
      // stopped accepting entries, or its registration rules were edited out
      // from under the decision that had already been computed.
      if (/NOT NULL/i.test(message) && /events\.status/.test(message)) {
        const current = await this.events.findById(event.id);
        const rulesChanged =
          current !== null &&
          (current.minimumAge !== rules.minimumAge || current.timezone !== rules.timezone);
        return rulesChanged
          ? { ok: false, failure: { code: 'EVENT_REGISTRATION_CONFIG_CHANGED' } }
          : {
              ok: false,
              failure: { code: 'EVENT_NOT_ACCEPTING_ENTRIES', reason: 'EVENT_NOT_OPEN' },
            };
      }

      if (/constraint/i.test(message)) {
        return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'constraint' } };
      }
      throw err;
    }

    const entry = await this.entries.findByEventAndId(event.id, entryId);
    const participant = await this.participants.findById(participantId);
    if (!entry || !participant) {
      return { ok: false, failure: { code: 'ENTRY_CREATE_FAILED', reason: 'reload' } };
    }

    return {
      ok: true,
      value: {
        entry,
        participant,
        answerCount: answerRows.length,
        decision,
        replayed: false,
      },
    };
  }
}

/**
 * Reads a stored verdict back off an entry.
 *
 * The four eligibility columns ARE an `EligibilityDecision` — the mapper
 * already refuses a row whose status and flags disagree, and migration 0013's
 * triggers refuse to write one — so this is a projection, not a re-derivation.
 * Returns null only for a row that carries no verdict at all, which means a
 * phase 7 participation recorded before eligibility existed.
 */
function decisionFromEntry(entry: EventEntry): EligibilityDecision | null {
  if (entry.overallEligible === null || entry.eligibilityReason === null) return null;
  return {
    calculatedAge: entry.calculatedAge,
    ageEligible: entry.ageEligible,
    overallEligible: entry.overallEligible,
    reasonCode: entry.eligibilityReason,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a submission contradicts an identity that already exists.
 *
 * Only the date of birth counts. A name change is ordinary — people marry,
 * correct a typo, or use a different form of their name — and a phone number is
 * not identity at all. A date of birth is different: it is the input to an age
 * rule, so accepting a new one silently would let somebody change whether they
 * qualify, and rejecting the update silently would judge them on a value they
 * did not give.
 */
function identityConflict(
  existing: Participant,
  profile: ParticipantProfile,
): 'dateOfBirth' | null {
  if (profile.dateOfBirth === null || existing.dateOfBirth === null) return null;
  return profile.dateOfBirth === existing.dateOfBirth ? null : 'dateOfBirth';
}

/**
 * Picks the failure that best describes what is wrong with a submission.
 *
 * Structural problems come first: a payload that names a question twice, or a
 * question that is not in this form, is malformed in a way that makes every
 * later complaint about it noise. "You did not answer this" is reported last,
 * because it is only meaningful once the rest of the payload made sense.
 */
function describeSubmissionFailure(
  problems: readonly SubmissionProblem[],
): EntryFailure {
  const duplicates = problems.filter((problem) => problem.code === 'DUPLICATE_ANSWER');
  if (duplicates.length > 0) {
    return {
      code: 'DUPLICATE_FORM_ANSWER',
      questionIds: duplicates.map((problem) => problem.questionId),
    };
  }

  const unknown = problems.filter((problem) => problem.code === 'UNKNOWN_QUESTION');
  if (unknown.length > 0) {
    return {
      code: 'FORM_ANSWER_UNKNOWN_QUESTION',
      questionIds: unknown.map((problem) => problem.questionId),
    };
  }

  const notAllowed = problems.filter((problem) => problem.code === 'NOT_ALLOWED');
  if (notAllowed.length > 0) {
    return {
      code: 'FORM_ANSWER_NOT_ALLOWED',
      questionIds: notAllowed.map((problem) => problem.questionId),
      reason: (notAllowed[0] as { reason: 'information' | 'inactive' }).reason,
    };
  }

  const invalid = problems.filter((problem) => problem.code === 'INVALID_ANSWER');
  if (invalid.length > 0) {
    return {
      code: 'FORM_ANSWER_INVALID',
      answers: invalid.map((problem) => {
        const detail = problem as {
          questionId: string;
          questionKey: string;
          problem: AnswerProblem;
        };
        return {
          questionId: detail.questionId,
          questionKey: detail.questionKey,
          problem: detail.problem,
        };
      }),
    };
  }

  const missing = problems.filter((problem) => problem.code === 'REQUIRED_MISSING');
  return {
    code: 'FORM_REQUIRED_ANSWER_MISSING',
    questions: missing.map((problem) => {
      const detail = problem as { questionId: string; questionKey: string };
      return { questionId: detail.questionId, questionKey: detail.questionKey };
    }),
  };
}

/** Re-exported so callers can ask the same question the service asks. */
export { eventAcceptsEntries };
