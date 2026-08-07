// Publishing a form draft as an immutable version.
//
// Deliberately NOT part of FormDraftService: editing and publishing are
// different acts with different guarantees. Editing changes a working copy;
// publishing freezes a copy that somebody will be shown and that must never
// change afterwards.
//
// ATOMICITY: a publication is ONE batch —
//
//   [ abort unless the draft is still at the revision the operator confirmed ,
//     the version row ,
//     every copied step, question and option ,
//     the event's pointer ,
//     the audit row ]
//
// If any part fails, none of it happened. There is no state in which a version
// exists without its structure, an event points at a half-copied form, or a
// publication went unrecorded.

import type {
  AuthenticatedAdmin,
  Event,
  EventFormDraft,
  EventFormVersion,
  FormPublishValidationResponse,
} from '../../shared/types';
import {
  buildFormSnapshot,
  evaluatePublishability,
  hasUnpublishedChanges,
} from '../../shared/formPublishing';
import { FormRepository } from './formRepository';
import {
  FormVersionRepository,
  type FormVersionRecord,
  type VersionOptionValues,
  type VersionQuestionValues,
  type VersionStepValues,
} from './formVersionRepository';
import { EventRepository } from './eventRepository';
import { AuditService } from './auditService';
import { newId } from './ids';
import { nowIso } from './time';
import { serializeJson } from './json';
import { logger } from './logger';
import type { RequestContext } from './requestContext';

export type PublishFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'FORM_DRAFT_NOT_FOUND' }
  | { code: 'FORM_DRAFT_REVISION_CONFLICT' }
  | { code: 'FORM_DRAFT_NOT_PUBLISHABLE'; issues: number }
  | { code: 'FORM_NO_UNPUBLISHED_CHANGES'; versionNumber: number }
  | { code: 'FORM_VERSION_NUMBER_CONFLICT' }
  | { code: 'FORM_VERSION_NOT_FOUND' }
  | { code: 'FORM_VERSION_INVALID'; reason: string }
  | { code: 'FORM_PUBLISH_FAILED'; reason: string };

export type PublishResult<T> = { ok: true; value: T } | { ok: false; failure: PublishFailure };

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

export interface PublishedOutcome {
  version: EventFormVersion;
  draft: EventFormDraft;
  event: Event;
}

export class FormPublishingService {
  private readonly forms: FormRepository;
  private readonly versions: FormVersionRepository;
  private readonly events: EventRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: {
      forms?: FormRepository;
      versions?: FormVersionRepository;
      events?: EventRepository;
      audit?: AuditService;
    },
  ) {
    this.forms = deps?.forms ?? new FormRepository(db);
    this.versions = deps?.versions ?? new FormVersionRepository(db);
    this.events = deps?.events ?? new EventRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  get repository(): FormVersionRepository {
    return this.versions;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private async loadDraft(eventId: string): Promise<EventFormDraft | null> {
    const stored = await this.forms.findDraftByEvent(eventId);
    return stored ? this.forms.assemble(stored) : null;
  }

  /**
   * The verdict, without touching anything.
   *
   * Nothing is written and no revision moves: an operator may ask "could I
   * publish this?" as often as they like.
   */
  async validate(
    eventId: string,
    expectedDraftRevision?: number,
  ): Promise<PublishResult<FormPublishValidationResponse>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const draft = await this.loadDraft(eventId);
    if (
      expectedDraftRevision !== undefined &&
      draft !== null &&
      draft.revision !== expectedDraftRevision
    ) {
      return { ok: false, failure: { code: 'FORM_DRAFT_REVISION_CONFLICT' } };
    }

    const current = await this.versions.findCurrentPublished(eventId);
    const verdict = evaluatePublishability(draft, event);

    return {
      ok: true,
      value: {
        publishable: verdict.publishable,
        errors: verdict.errors,
        warnings: verdict.warnings,
        draftRevision: draft?.revision ?? null,
        publishedVersionNumber: current?.versionNumber ?? null,
        hasUnpublishedChanges: hasUnpublishedChanges(
          draft?.revision ?? null,
          current?.sourceDraftRevision ?? null,
        ),
      },
    };
  }

  /**
   * The version the event currently serves, structure included.
   *
   * Goes through the SAME consistency check as reading a version by id. Two
   * endpoints that disagreed about one version — one serving it, the other
   * refusing it — would be two different answers to "what is published", which
   * is the one question this whole phase exists to answer unambiguously.
   */
  async currentPublished(eventId: string): Promise<PublishResult<EventFormVersion | null>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const pointer = await this.versions.pointerCondition(eventId);
    if (pointer === 'none') return { ok: true, value: null };
    if (pointer !== 'valid') {
      // The pointer names a version this event does not own, or none at all.
      logger.error('event points at a form version that is not its own', {
        action: 'EVENT_PUBLISHED_FORM_POINTER_INVALID',
        eventId,
        reason: pointer,
      });
      return { ok: false, failure: { code: 'FORM_VERSION_INVALID', reason: pointer } };
    }

    const record = await this.versions.findCurrentPublished(eventId);
    if (!record) return { ok: true, value: null };

    const checked = await this.getVersion(eventId, record.id);
    if (!checked.ok) return checked;
    return { ok: true, value: checked.value.version };
  }

  async listVersions(eventId: string, query: { page: number; pageSize: number }) {
    return this.versions.listByEvent(eventId, query);
  }

  /**
   * One version, with the consistency check between its two representations.
   *
   * The normalized rows are what a renderer reads; the snapshot is evidence of
   * what was published. They must agree. A disagreement is not repaired — it is
   * reported, because silently preferring one would destroy the only signal
   * that something went wrong.
   */
  async getVersion(
    eventId: string,
    versionId: string,
  ): Promise<
    PublishResult<{ version: EventFormVersion; record: FormVersionRecord; current: boolean }>
  > {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const loaded = await this.versions.loadVersion(eventId, versionId);
    if (!loaded) return { ok: false, failure: { code: 'FORM_VERSION_NOT_FOUND' } };

    const mismatch = describeSnapshotMismatch(loaded.record, loaded.version);
    if (mismatch) {
      logger.error('form version snapshot disagrees with its rows', {
        action: 'FORM_VERSION_INCONSISTENT',
        eventId,
        versionId,
        reason: mismatch,
      });
      return { ok: false, failure: { code: 'FORM_VERSION_INVALID', reason: mismatch } };
    }

    return {
      ok: true,
      value: {
        version: loaded.version,
        record: loaded.record,
        current: event.publishedFormVersionId === loaded.record.id,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Rebuilds an editable draft from a published version.
   *
   * NOT part of the ordinary flow: publishing leaves the draft alone, so an
   * operator who publishes and keeps editing never needs this. It exists for
   * the state the ordinary flow cannot produce but reality can — a version
   * exists and the draft does not, after a repair, an import, or a restore
   * that brought back one table and not the other. Without it, such an event
   * would be permanently unpublishable-again: the form people are filling in
   * would be uneditable forever.
   *
   * Deliberately has NO endpoint and no UI. It is an administrative seam,
   * reached deliberately, and it REFUSES to run when a draft already exists —
   * clobbering someone's work-in-progress with an older published copy would
   * be a far worse outcome than the state it repairs.
   *
   * The version is not touched. New ids are minted for the draft's rows, so the
   * copy is a separate document that can be edited without any chance of
   * reaching back into what was published.
   */
  async clonePublishedVersionToDraft(
    eventId: string,
    versionId: string,
    actor: Actor,
  ): Promise<PublishResult<EventFormDraft>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const existing = await this.forms.findDraftByEvent(eventId);
    if (existing) {
      // A draft is the operator's workspace. Never overwrite one.
      return { ok: false, failure: { code: 'FORM_PUBLISH_FAILED', reason: 'draft_exists' } };
    }

    // Scoped: a version id belonging to another event resolves to nothing.
    const source = await this.getVersion(eventId, versionId);
    if (!source.ok) return source;

    const at = nowIso();
    const draftId = newId();
    const statements: D1PreparedStatement[] = [
      this.forms.createDraftStatement({ id: draftId, eventId, actorId: actor.admin.id, at }),
    ];

    for (const step of source.value.version.steps) {
      const stepId = newId();
      statements.push(
        this.forms.insertStepStatement({
          id: stepId,
          ownerType: 'DRAFT',
          ownerId: draftId,
          title: step.title,
          description: step.description,
          sortOrder: step.sortOrder,
          at,
        }),
      );

      for (const question of step.questions) {
        const questionId = newId();
        statements.push(
          this.forms.insertQuestionStatement({
            id: questionId,
            ownerType: 'DRAFT',
            ownerId: draftId,
            stepId,
            key: question.key,
            systemField: question.systemField,
            type: question.type,
            label: question.label,
            description: question.description,
            placeholder: question.placeholder,
            required: question.required,
            active: question.active,
            exportable: question.exportable,
            sortOrder: question.sortOrder,
            validation: question.validation,
            at,
          }),
        );

        for (const option of question.options) {
          statements.push(
            this.forms.insertOptionStatement({
              id: newId(),
              questionId,
              value: option.value,
              label: option.label,
              sortOrder: option.sortOrder,
              active: option.active,
              at,
            }),
          );
        }
      }
    }

    statements.push(
      this.audit.statementFor({
        action: 'FORM_DRAFT_CREATED',
        entityType: 'FORM',
        entityId: draftId,
        eventId,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: null,
        newData: { id: draftId, eventId, revision: 1 },
        metadata: {
          clonedFromVersionId: versionId,
          clonedFromVersionNumber: source.value.version.versionNumber,
        },
      }),
    );

    try {
      await this.db.batch(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/constraint/i.test(message)) {
        return { ok: false, failure: { code: 'FORM_PUBLISH_FAILED', reason: 'constraint' } };
      }
      throw err;
    }

    const rebuilt = await this.loadDraft(eventId);
    if (!rebuilt) return { ok: false, failure: { code: 'FORM_DRAFT_NOT_FOUND' } };
    return { ok: true, value: rebuilt };
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  async publish(
    eventId: string,
    expectedDraftRevision: number,
    actor: Actor,
  ): Promise<PublishResult<PublishedOutcome>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const draft = await this.loadDraft(eventId);
    if (!draft) return { ok: false, failure: { code: 'FORM_DRAFT_NOT_FOUND' } };

    // Publishing what the operator SAW. If the form moved between the
    // confirmation dialog and this request, the answer is no.
    if (draft.revision !== expectedDraftRevision) {
      return { ok: false, failure: { code: 'FORM_DRAFT_REVISION_CONFLICT' } };
    }

    // Already frozen? Asked of EVERY version, not only the newest: if version
    // numbers have advanced past the one that froze this revision, comparing
    // against the latest alone would let the same draft be published twice.
    // The unique index on (event_id, source_draft_revision) is the backstop.
    const alreadyFrozen = await this.versions.findBySourceRevision(eventId, draft.revision);
    if (alreadyFrozen) {
      return {
        ok: false,
        failure: {
          code: 'FORM_NO_UNPUBLISHED_CHANGES',
          versionNumber: alreadyFrozen.versionNumber,
        },
      };
    }
    const latest = await this.versions.findLatest(eventId);

    const verdict = evaluatePublishability(draft, event);
    if (!verdict.publishable) {
      return {
        ok: false,
        failure: { code: 'FORM_DRAFT_NOT_PUBLISHABLE', issues: verdict.errors.length },
      };
    }

    const at = nowIso();
    const versionId = newId();
    const versionNumber = await this.versions.nextVersionNumber(eventId);
    const snapshot = buildFormSnapshot(draft, { versionNumber, publishedAt: at });
    const serialized = serializeJson(snapshot);
    if (!serialized.ok) {
      return {
        ok: false,
        failure: { code: 'FORM_PUBLISH_FAILED', reason: `snapshot_${serialized.reason}` },
      };
    }

    const statements: D1PreparedStatement[] = [
      // The draft must still be where the operator left it when this batch
      // runs, not merely when it was read. Writing NULL into a NOT NULL column
      // is a guaranteed failure, so a race takes the whole publication down
      // rather than freezing a revision nobody confirmed.
      this.forms.abortUnlessRevisionStatement(draft.id, expectedDraftRevision),
      this.versions.insertVersionStatement({
        id: versionId,
        eventId,
        versionNumber,
        sourceDraftRevision: draft.revision,
        publishedBy: actor.admin.id,
        publishedAt: at,
        snapshot: serialized.json,
      }),
    ];

    // COPY, never promote: the draft keeps its own rows and stays editable.
    //
    // Collected first, then written in multi-row inserts. A form may hold
    // twenty thousand rows, and one statement per row would make a publication
    // a bet on how many statements a single batch will carry.
    const stepRows: VersionStepValues[] = [];
    const questionRows: VersionQuestionValues[] = [];
    const optionRows: VersionOptionValues[] = [];

    for (const step of draft.steps) {
      const stepId = newId();
      stepRows.push({
        id: stepId,
        versionId,
        title: step.title,
        description: step.description,
        sortOrder: step.sortOrder,
        at,
      });

      for (const question of step.questions) {
        const questionId = newId();
        const validation =
          question.validation === null ? null : serializeJson(question.validation);
        if (validation !== null && !validation.ok) {
          return {
            ok: false,
            failure: { code: 'FORM_PUBLISH_FAILED', reason: 'validation_not_serializable' },
          };
        }

        questionRows.push({
          id: questionId,
          versionId,
          stepId,
          key: question.key,
          systemField: question.systemField,
          type: question.type,
          label: question.label,
          description: question.description,
          placeholder: question.placeholder,
          required: question.required,
          // Inactive questions travel too, marked: a version is the record of
          // a form, and dropping them would make it disagree with the draft.
          active: question.active,
          exportable: question.exportable,
          sortOrder: question.sortOrder,
          validation: validation === null ? null : validation.json,
          at,
        });

        for (const option of question.options) {
          optionRows.push({
            id: newId(),
            questionId,
            value: option.value,
            label: option.label,
            sortOrder: option.sortOrder,
            active: option.active,
            at,
          });
        }
      }
    }

    statements.push(
      ...this.versions.insertVersionStepsStatements(stepRows),
      ...this.versions.insertVersionQuestionsStatements(questionRows),
      ...this.versions.insertVersionOptionsStatements(optionRows),
    );

    statements.push(this.versions.setPublishedVersionStatement(eventId, versionId));
    statements.push(
      this.audit.statementFor({
        action: 'FORM_VERSION_PUBLISHED',
        entityType: 'FORM_VERSION',
        entityId: versionId,
        eventId,
        actor: {
          id: actor.admin.id,
          email: actor.admin.email,
          displayName: actor.admin.displayName,
        },
        requestContext: actor.requestContext,
        previousData: latest
          ? { versionNumber: latest.versionNumber, sourceDraftRevision: latest.sourceDraftRevision }
          : null,
        // The snapshot itself lives in `schema_snapshot`; storing it twice
        // would double the cost of every publication for no extra evidence.
        newData: {
          versionId,
          versionNumber,
          sourceDraftRevision: draft.revision,
          publishedAt: at,
        },
        metadata: snapshot.summary,
      }),
    );

    try {
      await this.db.batch(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Another publication claimed this number first.
      if (/UNIQUE/i.test(message) && /source_draft_revision/i.test(message)) {
        // Another publication froze this very revision while we were working.
        return {
          ok: false,
          failure: { code: 'FORM_NO_UNPUBLISHED_CHANGES', versionNumber: 0 },
        };
      }
      if (/UNIQUE/i.test(message) && /version_number|form_versions/i.test(message)) {
        return { ok: false, failure: { code: 'FORM_VERSION_NUMBER_CONFLICT' } };
      }
      // The draft moved under us and the abort guard fired.
      if (/NOT NULL/i.test(message) && /event_form_drafts\.revision/.test(message)) {
        return { ok: false, failure: { code: 'FORM_DRAFT_REVISION_CONFLICT' } };
      }
      if (/constraint/i.test(message)) {
        return { ok: false, failure: { code: 'FORM_PUBLISH_FAILED', reason: 'constraint' } };
      }
      throw err;
    }

    const loaded = await this.versions.loadVersion(eventId, versionId);
    const updatedEvent = await this.events.findById(eventId);
    const updatedDraft = await this.loadDraft(eventId);
    if (!loaded || !updatedEvent || !updatedDraft) {
      return { ok: false, failure: { code: 'FORM_PUBLISH_FAILED', reason: 'reload' } };
    }

    return {
      ok: true,
      value: { version: loaded.version, draft: updatedDraft, event: updatedEvent },
    };
  }
}

/**
 * Where a version's snapshot and its rows disagree, or null when they match.
 *
 * Structural only: counts, order and the identity of each question. It is a
 * tripwire for corruption, not a second implementation of equality.
 */
/**
 * Separator for comparing key lists as one string.
 *
 * A character no answer key can contain — keys are lowercase snake_case — so
 * `['a_b']` and `['a', 'b']` can never compare equal. Written as an escape
 * rather than typed literally: a raw control byte in source is invisible in a
 * diff and makes the file read as binary to ordinary tools.
 */
const SEP = '\u0000';

export function describeSnapshotMismatch(
  record: FormVersionRecord,
  version: EventFormVersion,
): string | null {
  const snapshot = record.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return 'snapshot_unreadable';
  if (snapshot.eventId !== version.eventId) return 'event_mismatch';
  if (snapshot.versionNumber !== version.versionNumber) return 'version_number_mismatch';
  if (snapshot.sourceDraftRevision !== version.sourceDraftRevision) {
    return 'source_revision_mismatch';
  }

  const snapshotSteps = snapshot.steps ?? [];
  if (snapshotSteps.length !== version.steps.length) return 'step_count_mismatch';

  const rowQuestions = version.steps.flatMap((step) => step.questions);
  const snapshotQuestions = snapshotSteps.flatMap((step) => step.questions ?? []);
  if (rowQuestions.length !== snapshotQuestions.length) return 'question_count_mismatch';

  // Keys are what an answer is filed under, so they are what must survive.
  const rowKeys = [...rowQuestions.map((question) => question.key)].sort();
  const snapshotKeys = [...snapshotQuestions.map((question) => question.key)].sort();
  if (rowKeys.join(SEP) !== snapshotKeys.join(SEP)) return 'question_key_mismatch';

  const rowOptions = rowQuestions.reduce((sum, question) => sum + question.options.length, 0);
  const snapshotOptions = snapshotQuestions.reduce(
    (sum, question) => sum + (question.options ?? []).length,
    0,
  );
  if (rowOptions !== snapshotOptions) return 'option_count_mismatch';

  return null;
}
