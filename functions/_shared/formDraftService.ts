// Form draft domain service.
//
// All policy lives here: what the event's state permits, the revision guard,
// per-form limits, what each question type may carry, which questions are
// protected, reordering and preview. HTTP handlers only translate its results.
//
// ATOMICITY: every mutation commits in ONE `db.batch()` shaped as
//
//   [ bump the draft's revision (guarded) ,
//     abort unless that bump matched ,
//     ...the mutation itself ,
//     the audit row (conditional on the mutation) ]
//
// The abort statement is what makes the revision guard real. Without it a stale
// client's bump would match nothing while the mutation that follows committed
// anyway, landing an edit under a revision that never moved.

import type {
  CreateFormOptionInput,
  CreateFormQuestionInput,
  CreateFormStepInput,
  Event,
  EventFormDraft,
  FormPreviewProblem,
  FormPreviewResponse,
  FormQuestion,
  FormQuestionValidation,
  FormStep,
  ReorderFormItem,
  UpdateFormOptionInput,
  UpdateFormQuestionInput,
  UpdateFormStepInput,
  AuditAction,
  AuthenticatedAdmin,
} from '../../shared/types';
import {
  SYSTEM_FIELD_KEY,
  SYSTEM_FIELD_TYPE,
  VALIDATION_KEYS_BY_TYPE,
  canDeleteQuestion,
  editableQuestionFields,
  eventAllowsFormEditing,
  isNamedSystemField,
  isReservedQuestionKey,
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  questionTypeSupportsPlaceholder,
  type FormQuestionType,
  type FormSystemField,
} from '../../shared/formLifecycle';
import {
  FORM_OPTIONS_PER_QUESTION_MAX,
  FORM_QUESTION_KEY_MAX_LENGTH,
  FORM_QUESTIONS_MAX,
  FORM_STEPS_MAX,
} from '../../shared/limits';
import { FormRepository } from './formRepository';
import { EventRepository } from './eventRepository';
import { AuditService } from './auditService';
import { newId } from './ids';
import { nowIso } from './time';
import type { RequestContext } from './requestContext';

export type FormFailure =
  | { code: 'EVENT_NOT_FOUND' }
  | { code: 'FORM_DRAFT_NOT_FOUND' }
  | { code: 'FORM_NOT_EDITABLE'; eventStatus: string }
  | { code: 'FORM_REVISION_CONFLICT' }
  | { code: 'FORM_STEP_NOT_FOUND' }
  | { code: 'FORM_STEP_NOT_EMPTY'; questions: number }
  | { code: 'FORM_QUESTION_NOT_FOUND' }
  | { code: 'FORM_QUESTION_PROTECTED'; reason: string }
  | { code: 'FORM_QUESTION_INVALID'; reason: string }
  | { code: 'FORM_OPTION_NOT_FOUND' }
  | { code: 'FORM_OPTION_NOT_ALLOWED'; type: string }
  | { code: 'FORM_KEY_EXISTS'; key: string }
  | { code: 'FORM_SYSTEM_FIELD_EXISTS'; systemField: string }
  | { code: 'FORM_LIMIT_REACHED'; scope: string; limit: number }
  | { code: 'FORM_ORDER_INVALID'; reason: string };

export type FormResult<T> = { ok: true; value: T } | { ok: false; failure: FormFailure };

interface Actor {
  admin: AuthenticatedAdmin;
  requestContext: RequestContext;
}

interface LoadedDraft {
  event: Event;
  draft: EventFormDraft;
}

/**
 * Turns a constraint failure into the refusal it actually represents.
 *
 * SQLite names the COLUMNS in a unique violation, not the index, so the
 * matching is on those. Anything unrecognised is rethrown: inventing a typed
 * failure for an error we do not understand would hide a real bug.
 */
function mapConstraintError(err: unknown): FormFailure | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/constraint/i.test(message)) return null;

  // The abort guard fired: the revision moved under us.
  if (/event_form_drafts\.revision/.test(message)) {
    return { code: 'FORM_REVISION_CONFLICT' };
  }
  if (/form_questions\.key/.test(message)) {
    return { code: 'FORM_KEY_EXISTS', key: '' };
  }
  if (/form_questions\.system_field/.test(message)) {
    return { code: 'FORM_SYSTEM_FIELD_EXISTS', systemField: '' };
  }
  if (/form_question_options\.value/.test(message)) {
    return { code: 'FORM_QUESTION_INVALID', reason: 'duplicate_option_value' };
  }
  if (/sort_order/.test(message)) {
    return { code: 'FORM_ORDER_INVALID', reason: 'order_changed' };
  }
  return null;
}

/**
 * Derives an answer key from a label.
 *
 * Operators name questions in prose; the key has to survive an export header
 * and a JSON field. A collision gets a numeric suffix rather than an error,
 * because "what should I call this?" is not a question worth asking twice.
 */
export function deriveQuestionKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFD')
      // Strip combining marks so "Año" becomes "ano", not "a_o".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, FORM_QUESTION_KEY_MAX_LENGTH - 4) || 'question';

  // A key must start with a letter; a label of digits alone would not. A
  // reserved name is treated as already taken, so a question labelled
  // "Constructor" gets `constructor_2` rather than a key nothing can safely use.
  const seed = /^[a-z]/.test(base) ? base : `q_${base}`;
  if (!taken.has(seed) && !isReservedQuestionKey(seed)) return seed;

  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = `${seed}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${seed}_${Date.now()}`;
}

export class FormDraftService {
  private readonly forms: FormRepository;
  private readonly events: EventRepository;
  private readonly audit: AuditService;

  constructor(
    private readonly db: D1Database,
    deps?: { forms?: FormRepository; events?: EventRepository; audit?: AuditService },
  ) {
    this.forms = deps?.forms ?? new FormRepository(db);
    this.events = deps?.events ?? new EventRepository(db);
    this.audit = deps?.audit ?? new AuditService(db);
  }

  get repository(): FormRepository {
    return this.forms;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * The draft for an event, if it has one. READ ONLY.
   *
   * Reading never creates. A GET that writes is a GET a browser prefetch, a
   * double render or a link preview can fire by accident — and here that
   * accident would both write an audit row and make the event undeletable.
   * Creating a form is `ensure()`, reached by an explicit POST.
   */
  async find(eventId: string): Promise<FormResult<{ event: Event; draft: EventFormDraft | null }>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const existing = await this.forms.findDraftByEvent(eventId);
    return {
      ok: true,
      value: { event, draft: existing ? await this.forms.assemble(existing) : null },
    };
  }

  /**
   * Creates the draft for an event, or returns the one already there.
   *
   * IDEMPOTENT by construction: `event_form_drafts.event_id` is unique, so two
   * simultaneous requests cannot both create one. The loser of that race reads
   * the winner's row rather than surfacing a constraint error, which is what
   * makes "start building the form" safe to click twice.
   */
  async ensure(eventId: string, actor: Actor): Promise<FormResult<LoadedDraft>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    const existing = await this.forms.findDraftByEvent(eventId);
    if (existing) {
      return { ok: true, value: { event, draft: await this.forms.assemble(existing) } };
    }

    // Creating it is a mutation like any other: audited, atomic.
    if (!eventAllowsFormEditing(event.status)) {
      return {
        ok: false,
        failure: { code: 'FORM_NOT_EDITABLE', eventStatus: event.status },
      };
    }

    const at = nowIso();
    const id = newId();
    try {
      await this.db.batch([
        this.forms.createDraftStatement({ id, eventId, actorId: actor.admin.id, at }),
        this.audit.statementFor(
          this.auditEntry('FORM_DRAFT_CREATED', 'FORM', id, eventId, actor, null, {
            id,
            eventId,
            revision: 1,
          }),
        ),
      ]);
    } catch (err) {
      // Someone else got there first. Their draft is as good as ours.
      const message = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE/i.test(message)) throw err;
    }

    const created = await this.forms.findDraftByEvent(eventId);
    if (!created) return { ok: false, failure: { code: 'FORM_DRAFT_NOT_FOUND' } };
    return { ok: true, value: { event, draft: await this.forms.assemble(created) } };
  }

  /** Loads an existing draft for a mutation, refusing a frozen event. */
  private async loadForWrite(
    eventId: string,
    expectedRevision: number,
  ): Promise<FormResult<LoadedDraft>> {
    const event = await this.events.findById(eventId);
    if (!event) return { ok: false, failure: { code: 'EVENT_NOT_FOUND' } };

    if (!eventAllowsFormEditing(event.status)) {
      return {
        ok: false,
        failure: { code: 'FORM_NOT_EDITABLE', eventStatus: event.status },
      };
    }

    const stored = await this.forms.findDraftByEvent(eventId);
    if (!stored) return { ok: false, failure: { code: 'FORM_DRAFT_NOT_FOUND' } };
    if (stored.revision !== expectedRevision) {
      return { ok: false, failure: { code: 'FORM_REVISION_CONFLICT' } };
    }

    return { ok: true, value: { event, draft: await this.forms.assemble(stored) } };
  }

  private auditEntry(
    action: AuditAction,
    entityType: 'FORM' | 'FORM_STEP' | 'FORM_QUESTION' | 'FORM_OPTION',
    entityId: string,
    eventId: string,
    actor: Actor,
    previousData: unknown,
    newData: unknown,
    metadata?: Record<string, unknown>,
  ) {
    return {
      action,
      entityType,
      entityId,
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

  /**
   * Commits a mutation with its revision bump and its audit row.
   *
   * Returns the reloaded draft, so every endpoint answers with the same shape
   * and a client never has to merge a partial response into what it holds.
   */
  private async commit(
    loaded: LoadedDraft,
    expectedRevision: number,
    actor: Actor,
    statements: D1PreparedStatement[],
    audit: ReturnType<FormDraftService['auditEntry']>,
  ): Promise<FormResult<EventFormDraft>> {
    const at = nowIso();
    try {
      await this.db.batch([
        this.forms.touchDraftStatement(loaded.draft.id, expectedRevision, actor.admin.id, at),
        this.forms.abortUnlessChangedStatement(loaded.draft.id),
        ...statements,
        // Conditional on the mutation having matched a row. With no mutation to
        // condition on — an explicit save — the abort guard above is already
        // the only way this batch survives, so the entry is unconditional.
        this.audit.statementFor(audit, { onlyIfPreviousChanged: statements.length > 0 }),
      ]);
    } catch (err) {
      const failure = mapConstraintError(err);
      if (failure) return { ok: false, failure };
      throw err;
    }

    const stored = await this.forms.findDraftByEvent(loaded.draft.eventId);
    if (!stored) return { ok: false, failure: { code: 'FORM_DRAFT_NOT_FOUND' } };
    return { ok: true, value: await this.forms.assemble(stored) };
  }

  /**
   * An explicit checkpoint.
   *
   * Every edit already persists on its own, so this saves no data the builder
   * has not already committed. What it records is INTENT: the operator declared
   * this arrangement finished, and the audit trail says who and when. It also
   * moves the revision, which is how a second administrator's stale editor
   * learns to reload.
   */
  async saveDraft(
    eventId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [],
      this.auditEntry(
        'FORM_DRAFT_UPDATED',
        'FORM',
        draft.id,
        eventId,
        actor,
        { revision: draft.revision },
        { revision: draft.revision + 1 },
        {
          steps: draft.steps.length,
          questions: draft.steps.reduce((sum, step) => sum + step.questions.length, 0),
        },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  async createStep(
    eventId: string,
    input: CreateFormStepInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;

    if (loaded.value.draft.steps.length >= FORM_STEPS_MAX) {
      return {
        ok: false,
        failure: { code: 'FORM_LIMIT_REACHED', scope: 'steps', limit: FORM_STEPS_MAX },
      };
    }

    const at = nowIso();
    const id = newId();
    const values = {
      id,
      ownerType: 'DRAFT' as const,
      ownerId: loaded.value.draft.id,
      title: input.title,
      description: input.description ?? null,
      sortOrder: await this.forms.nextStepOrder(loaded.value.draft.id),
      at,
    };

    return this.commit(
      loaded.value,
      input.expectedRevision,
      actor,
      [this.forms.insertStepStatement(values)],
      this.auditEntry('FORM_STEP_CREATED', 'FORM_STEP', id, eventId, actor, null, values),
    );
  }

  async updateStep(
    eventId: string,
    stepId: string,
    input: UpdateFormStepInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;

    const step = loaded.value.draft.steps.find((candidate) => candidate.id === stepId);
    if (!step) return { ok: false, failure: { code: 'FORM_STEP_NOT_FOUND' } };

    const { expectedRevision, ...patch } = input;
    const at = nowIso();

    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [
        this.forms.updateStepStatement(
          loaded.value.draft.id,
          stepId,
          patch as Record<string, unknown>,
          at,
        ),
      ],
      this.auditEntry(
        'FORM_STEP_UPDATED',
        'FORM_STEP',
        stepId,
        eventId,
        actor,
        { title: step.title, description: step.description },
        { ...patch },
      ),
    );
  }

  /**
   * Removes an EMPTY step.
   *
   * A step holding questions is not deleted with them: losing a page of
   * configuration to one click is not a thing this system does. Emptying it
   * first — by moving or deleting each question — is the deliberate act.
   */
  async deleteStep(
    eventId: string,
    stepId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;

    const step = loaded.value.draft.steps.find((candidate) => candidate.id === stepId);
    if (!step) return { ok: false, failure: { code: 'FORM_STEP_NOT_FOUND' } };

    if (step.questions.length > 0) {
      return {
        ok: false,
        failure: { code: 'FORM_STEP_NOT_EMPTY', questions: step.questions.length },
      };
    }

    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [this.forms.deleteStepStatement(loaded.value.draft.id, stepId)],
      this.auditEntry(
        'FORM_STEP_DELETED',
        'FORM_STEP',
        stepId,
        eventId,
        actor,
        { title: step.title, description: step.description, sortOrder: step.sortOrder },
        null,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  /**
   * Checks a question's shape against its type.
   *
   * Types are not interchangeable: a `YES_NO` with a list of choices, or an
   * `INFORMATION` block marked required, are incoherent rather than merely
   * unusual, and storing them would push the contradiction onto whatever
   * renders the form later.
   */
  private validateShape(
    type: FormQuestionType,
    fields: {
      required?: boolean;
      exportable?: boolean;
      placeholder?: string | null;
      validation?: FormQuestionValidation | null;
      hasOptions: boolean;
    },
  ): FormFailure | null {
    if (fields.hasOptions && !questionTypeSupportsOptions(type)) {
      return { code: 'FORM_OPTION_NOT_ALLOWED', type };
    }
    if (!questionTypeCollectsAnswer(type)) {
      if (fields.required) {
        return { code: 'FORM_QUESTION_INVALID', reason: 'information_cannot_be_required' };
      }
      if (fields.exportable) {
        return { code: 'FORM_QUESTION_INVALID', reason: 'information_cannot_be_exported' };
      }
    }
    if (
      fields.placeholder !== null &&
      fields.placeholder !== undefined &&
      fields.placeholder.length > 0 &&
      !questionTypeSupportsPlaceholder(type)
    ) {
      return { code: 'FORM_QUESTION_INVALID', reason: 'placeholder_not_supported' };
    }
    if (fields.validation) {
      const allowed = VALIDATION_KEYS_BY_TYPE[type];
      const offending = Object.keys(fields.validation).filter((key) => !allowed.includes(key));
      if (offending.length > 0) {
        return {
          code: 'FORM_QUESTION_INVALID',
          reason: `validation_not_supported:${offending.join(',')}`,
        };
      }
    }
    return null;
  }

  async createQuestion(
    eventId: string,
    input: CreateFormQuestionInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const step = draft.steps.find((candidate) => candidate.id === input.stepId);
    if (!step) return { ok: false, failure: { code: 'FORM_STEP_NOT_FOUND' } };

    const existing = draft.steps.flatMap((candidate) => candidate.questions);
    if (existing.length >= FORM_QUESTIONS_MAX) {
      return {
        ok: false,
        failure: { code: 'FORM_LIMIT_REACHED', scope: 'questions', limit: FORM_QUESTIONS_MAX },
      };
    }

    const systemField: FormSystemField = input.systemField ?? 'NONE';

    // A system field is an identity, not a shape: its type and key are fixed so
    // later phases can find it without guessing, and it may appear only once.
    if (isNamedSystemField(systemField)) {
      if (existing.some((question) => question.systemField === systemField)) {
        return { ok: false, failure: { code: 'FORM_SYSTEM_FIELD_EXISTS', systemField } };
      }
      if (input.type !== SYSTEM_FIELD_TYPE[systemField]) {
        return {
          ok: false,
          failure: { code: 'FORM_QUESTION_INVALID', reason: 'system_field_type_fixed' },
        };
      }
    }

    const options = input.options ?? [];
    const shapeFailure = this.validateShape(input.type, {
      required: input.required,
      exportable: input.exportable ?? questionTypeCollectsAnswer(input.type),
      placeholder: input.placeholder,
      validation: input.validation,
      hasOptions: options.length > 0,
    });
    if (shapeFailure) return { ok: false, failure: shapeFailure };

    if (options.length > FORM_OPTIONS_PER_QUESTION_MAX) {
      return {
        ok: false,
        failure: {
          code: 'FORM_LIMIT_REACHED',
          scope: 'options',
          limit: FORM_OPTIONS_PER_QUESTION_MAX,
        },
      };
    }
    if (new Set(options.map((option) => option.value)).size !== options.length) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_INVALID', reason: 'duplicate_option_value' },
      };
    }

    const taken = new Set(existing.map((question) => question.key));
    const key = isNamedSystemField(systemField)
      ? SYSTEM_FIELD_KEY[systemField]
      : (input.key ?? deriveQuestionKey(input.label, taken));
    if (taken.has(key)) return { ok: false, failure: { code: 'FORM_KEY_EXISTS', key } };
    // Re-checked here and not left to the schema: a key is chosen once and then
    // used forever by whatever consumes answers, so the rule belongs with the
    // domain rather than only at the edge that happens to call it today.
    if (isReservedQuestionKey(key)) {
      return { ok: false, failure: { code: 'FORM_QUESTION_INVALID', reason: 'reserved_key' } };
    }

    const at = nowIso();
    const id = newId();
    const values = {
      id,
      ownerType: 'DRAFT' as const,
      ownerId: draft.id,
      stepId: input.stepId,
      key,
      systemField,
      type: input.type,
      label: input.label,
      description: input.description ?? null,
      placeholder: input.placeholder ?? null,
      required: input.required ?? false,
      active: input.active ?? true,
      exportable: (input.exportable ?? true) && questionTypeCollectsAnswer(input.type),
      sortOrder: await this.forms.nextQuestionOrder(input.stepId),
      validation: input.validation ?? null,
      at,
    };

    const statements = [this.forms.insertQuestionStatement(values)];
    options.forEach((option, index) => {
      statements.push(
        this.forms.insertOptionStatement({
          id: newId(),
          questionId: id,
          value: option.value,
          label: option.label,
          sortOrder: index,
          active: true,
          at,
        }),
      );
    });

    return this.commit(
      loaded.value,
      input.expectedRevision,
      actor,
      statements,
      this.auditEntry('FORM_QUESTION_CREATED', 'FORM_QUESTION', id, eventId, actor, null, {
        ...values,
        options: options.map((option) => option.value),
      }),
    );
  }

  async updateQuestion(
    eventId: string,
    questionId: string,
    input: UpdateFormQuestionInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const all = draft.steps.flatMap((step) => step.questions);
    const question = all.find((candidate) => candidate.id === questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    const { expectedRevision, ...patch } = input;

    // A system field's identity is fixed; how it READS is not.
    const allowed = editableQuestionFields(question.systemField);
    const forbidden = Object.keys(patch).filter(
      (field) => field !== 'stepId' && !allowed.includes(field),
    );
    if (forbidden.length > 0) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_PROTECTED', reason: forbidden.join(',') },
      };
    }

    const nextType = (patch.type as FormQuestionType | undefined) ?? question.type;
    const nextRequired = patch.required ?? question.required;
    const nextExportable = patch.exportable ?? question.exportable;
    const nextPlaceholder =
      patch.placeholder === undefined ? question.placeholder : patch.placeholder;
    const nextValidation =
      patch.validation === undefined ? question.validation : patch.validation;

    // Changing the type away from a select would strand its choices, so the
    // choices have to go first — explicitly, by the operator.
    const keepsOptions = questionTypeSupportsOptions(nextType);
    if (!keepsOptions && question.options.length > 0) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_INVALID', reason: 'type_change_would_strand_options' },
      };
    }

    const shapeFailure = this.validateShape(nextType, {
      required: nextRequired,
      exportable: nextExportable,
      placeholder: nextPlaceholder,
      validation: nextValidation,
      hasOptions: question.options.length > 0,
    });
    if (shapeFailure) return { ok: false, failure: shapeFailure };

    if (patch.key !== undefined && patch.key !== question.key) {
      if (all.some((other) => other.id !== questionId && other.key === patch.key)) {
        return { ok: false, failure: { code: 'FORM_KEY_EXISTS', key: patch.key } };
      }
      if (isReservedQuestionKey(patch.key)) {
        return {
          ok: false,
          failure: { code: 'FORM_QUESTION_INVALID', reason: 'reserved_key' },
        };
      }
    }

    // Moving to another step lands at the END of it: the destination has its
    // own ordering, and inserting into the middle of one is what reorder is for.
    const stored: Record<string, unknown> = { ...patch };
    if (patch.stepId !== undefined && patch.stepId !== question.stepId) {
      const destination = draft.steps.find((step) => step.id === patch.stepId);
      if (!destination) return { ok: false, failure: { code: 'FORM_STEP_NOT_FOUND' } };
      stored.sortOrder = await this.forms.nextQuestionOrder(patch.stepId);
    } else {
      delete stored.stepId;
    }

    const at = nowIso();
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [this.forms.updateQuestionStatement(draft.id, questionId, stored, at)],
      this.auditEntry(
        'FORM_QUESTION_UPDATED',
        'FORM_QUESTION',
        questionId,
        eventId,
        actor,
        snapshotQuestion(question),
        { ...patch },
      ),
    );
  }

  async deleteQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const question = draft.steps
      .flatMap((step) => step.questions)
      .find((candidate) => candidate.id === questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    if (!canDeleteQuestion(question.systemField, question.required)) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_PROTECTED', reason: 'required_system_field' },
      };
    }

    // Options carry a RESTRICT key: they go first, in the same transaction.
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [
        this.forms.deleteOptionsOfQuestionStatement(questionId),
        this.forms.deleteQuestionStatement(draft.id, questionId),
      ],
      this.auditEntry(
        'FORM_QUESTION_DELETED',
        'FORM_QUESTION',
        questionId,
        eventId,
        actor,
        // The row is about to disappear, so the entry carries the whole
        // snapshot — it becomes the only evidence the question existed.
        snapshotQuestion(question),
        null,
        { key: question.key, options: question.options.length },
      ),
    );
  }

  /**
   * Copies a question, with its choices, to the end of the same step.
   *
   * The copy is never a system field: those may appear once, and an operator
   * duplicating "Email" wants a second ordinary question, not a conflict.
   */
  async duplicateQuestion(
    eventId: string,
    questionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const all = draft.steps.flatMap((step) => step.questions);
    const source = all.find((candidate) => candidate.id === questionId);
    if (!source) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    if (all.length >= FORM_QUESTIONS_MAX) {
      return {
        ok: false,
        failure: { code: 'FORM_LIMIT_REACHED', scope: 'questions', limit: FORM_QUESTIONS_MAX },
      };
    }

    const taken = new Set(all.map((question) => question.key));
    const key = deriveQuestionKey(`${source.key}_copy`, taken);
    const at = nowIso();
    const id = newId();

    const values = {
      id,
      ownerType: 'DRAFT' as const,
      ownerId: draft.id,
      stepId: source.stepId,
      key,
      systemField: 'NONE' as const,
      type: source.type,
      label: source.label,
      description: source.description,
      placeholder: source.placeholder,
      required: source.required,
      active: source.active,
      exportable: source.exportable,
      sortOrder: await this.forms.nextQuestionOrder(source.stepId),
      validation: source.validation,
      at,
    };

    const statements = [this.forms.insertQuestionStatement(values)];
    source.options.forEach((option, index) => {
      statements.push(
        this.forms.insertOptionStatement({
          id: newId(),
          questionId: id,
          value: option.value,
          label: option.label,
          sortOrder: index,
          active: option.active,
          at,
        }),
      );
    });

    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      statements,
      this.auditEntry('FORM_QUESTION_CREATED', 'FORM_QUESTION', id, eventId, actor, null, values, {
        duplicatedFrom: source.id,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  private findQuestionIn(draft: EventFormDraft, questionId: string): FormQuestion | null {
    return (
      draft.steps.flatMap((step) => step.questions).find((q) => q.id === questionId) ?? null
    );
  }

  async createOption(
    eventId: string,
    questionId: string,
    input: CreateFormOptionInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;

    const question = this.findQuestionIn(loaded.value.draft, questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    if (!questionTypeSupportsOptions(question.type)) {
      return { ok: false, failure: { code: 'FORM_OPTION_NOT_ALLOWED', type: question.type } };
    }
    if (question.options.length >= FORM_OPTIONS_PER_QUESTION_MAX) {
      return {
        ok: false,
        failure: {
          code: 'FORM_LIMIT_REACHED',
          scope: 'options',
          limit: FORM_OPTIONS_PER_QUESTION_MAX,
        },
      };
    }
    if (question.options.some((option) => option.value === input.value)) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_INVALID', reason: 'duplicate_option_value' },
      };
    }

    const at = nowIso();
    const id = newId();
    const values = {
      id,
      questionId,
      value: input.value,
      label: input.label,
      sortOrder: await this.forms.nextOptionOrder(questionId),
      active: input.active ?? true,
      at,
    };

    return this.commit(
      loaded.value,
      input.expectedRevision,
      actor,
      [this.forms.insertOptionStatement(values)],
      this.auditEntry('FORM_OPTION_CREATED', 'FORM_OPTION', id, eventId, actor, null, values, {
        questionId,
      }),
    );
  }

  async updateOption(
    eventId: string,
    questionId: string,
    optionId: string,
    input: UpdateFormOptionInput,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, input.expectedRevision);
    if (!loaded.ok) return loaded;

    const question = this.findQuestionIn(loaded.value.draft, questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    const option = question.options.find((candidate) => candidate.id === optionId);
    if (!option) return { ok: false, failure: { code: 'FORM_OPTION_NOT_FOUND' } };

    const { expectedRevision, ...patch } = input;
    if (
      patch.value !== undefined &&
      question.options.some((other) => other.id !== optionId && other.value === patch.value)
    ) {
      return {
        ok: false,
        failure: { code: 'FORM_QUESTION_INVALID', reason: 'duplicate_option_value' },
      };
    }

    const at = nowIso();
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [
        this.forms.updateOptionStatement(
          questionId,
          optionId,
          patch as Record<string, unknown>,
          at,
        ),
      ],
      this.auditEntry(
        'FORM_OPTION_UPDATED',
        'FORM_OPTION',
        optionId,
        eventId,
        actor,
        { value: option.value, label: option.label, active: option.active },
        { ...patch },
        { questionId },
      ),
    );
  }

  async deleteOption(
    eventId: string,
    questionId: string,
    optionId: string,
    expectedRevision: number,
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;

    const question = this.findQuestionIn(loaded.value.draft, questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    const option = question.options.find((candidate) => candidate.id === optionId);
    if (!option) return { ok: false, failure: { code: 'FORM_OPTION_NOT_FOUND' } };

    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      [this.forms.deleteOptionStatement(questionId, optionId)],
      this.auditEntry(
        'FORM_OPTION_DELETED',
        'FORM_OPTION',
        optionId,
        eventId,
        actor,
        { value: option.value, label: option.label, sortOrder: option.sortOrder },
        null,
        { questionId },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Reordering
  // -------------------------------------------------------------------------

  /**
   * Applies a complete new ordering to one list.
   *
   * As with prizes, the payload must describe EVERY member of that list: a
   * partial order would leave the rest on positions that could collide, and
   * there is no sensible way to infer where they should go.
   */
  private checkOrder(
    items: ReorderFormItem[],
    members: Array<{ id: string }>,
  ): FormFailure | null {
    const known = new Set(members.map((member) => member.id));
    for (const item of items) {
      if (!known.has(item.id)) {
        return { code: 'FORM_ORDER_INVALID', reason: 'unknown_member' };
      }
    }
    if (items.length !== members.length) {
      return { code: 'FORM_ORDER_INVALID', reason: 'incomplete_order' };
    }
    return null;
  }

  async reorderSteps(
    eventId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const invalid = this.checkOrder(items, draft.steps);
    if (invalid) return { ok: false, failure: invalid };

    const at = nowIso();
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      this.forms.reorderStatements('steps', ['DRAFT', draft.id], items, at),
      this.auditEntry(
        'FORM_STEPS_REORDERED',
        'FORM',
        draft.id,
        eventId,
        actor,
        { order: draft.steps.map((step) => ({ id: step.id, sortOrder: step.sortOrder })) },
        { order: items },
      ),
    );
  }

  async reorderQuestions(
    eventId: string,
    expectedRevision: number,
    stepId: string,
    items: ReorderFormItem[],
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;
    const { draft } = loaded.value;

    const step = draft.steps.find((candidate) => candidate.id === stepId);
    if (!step) return { ok: false, failure: { code: 'FORM_STEP_NOT_FOUND' } };

    const invalid = this.checkOrder(items, step.questions);
    if (invalid) return { ok: false, failure: invalid };

    const at = nowIso();
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      this.forms.reorderStatements('questions', [stepId], items, at),
      this.auditEntry(
        'FORM_QUESTIONS_REORDERED',
        'FORM_STEP',
        stepId,
        eventId,
        actor,
        {
          order: step.questions.map((question) => ({
            id: question.id,
            sortOrder: question.sortOrder,
          })),
        },
        { order: items },
        { stepId },
      ),
    );
  }

  async reorderOptions(
    eventId: string,
    questionId: string,
    expectedRevision: number,
    items: ReorderFormItem[],
    actor: Actor,
  ): Promise<FormResult<EventFormDraft>> {
    const loaded = await this.loadForWrite(eventId, expectedRevision);
    if (!loaded.ok) return loaded;

    const question = this.findQuestionIn(loaded.value.draft, questionId);
    if (!question) return { ok: false, failure: { code: 'FORM_QUESTION_NOT_FOUND' } };

    const invalid = this.checkOrder(items, question.options);
    if (invalid) return { ok: false, failure: invalid };

    const at = nowIso();
    return this.commit(
      loaded.value,
      expectedRevision,
      actor,
      this.forms.reorderStatements('options', [questionId], items, at),
      this.auditEntry(
        'FORM_OPTIONS_REORDERED',
        'FORM_QUESTION',
        questionId,
        eventId,
        actor,
        {
          order: question.options.map((option) => ({
            id: option.id,
            sortOrder: option.sortOrder,
          })),
        },
        { order: items },
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Renders the draft as a participant would meet it.
   *
   * Nothing is stored, no participant is created and no answer is accepted —
   * this phase builds the form and stops there. Alongside the rendering it
   * reports every PROBLEM publishing will later refuse, so an operator finds
   * out while they are still editing rather than at the moment they publish.
   */
  buildPreview(draft: EventFormDraft): FormPreviewResponse {
    const problems: FormPreviewProblem[] = [];

    if (draft.steps.length === 0) {
      problems.push({
        code: 'NO_STEPS',
        stepId: null,
        questionId: null,
        detail: 'The form has no steps yet',
      });
    }

    let activeQuestions = 0;

    const steps = draft.steps.map((step) => {
      const visible = step.questions.filter((question) => question.active);
      activeQuestions += visible.length;

      if (step.questions.length === 0) {
        problems.push({
          code: 'EMPTY_STEP',
          stepId: step.id,
          questionId: null,
          detail: step.title,
        });
      }

      for (const question of step.questions) {
        if (questionTypeSupportsOptions(question.type)) {
          const usable = question.options.filter((option) => option.active);
          if (usable.length === 0) {
            problems.push({
              code: 'SELECT_WITHOUT_OPTIONS',
              stepId: step.id,
              questionId: question.id,
              detail: question.label,
            });
          }
        }
        if (question.required && !question.active) {
          problems.push({
            code: 'REQUIRED_QUESTION_INACTIVE',
            stepId: step.id,
            questionId: question.id,
            detail: question.label,
          });
        }
      }

      return {
        id: step.id,
        title: step.title,
        description: step.description,
        questions: visible.map((question) => ({
          id: question.id,
          key: question.key,
          type: question.type,
          label: question.label,
          description: question.description,
          placeholder: question.placeholder,
          required: question.required,
          validation: question.validation,
          options: question.options
            .filter((option) => option.active)
            .map((option) => ({ value: option.value, label: option.label })),
        })),
      };
    });

    if (draft.steps.length > 0 && activeQuestions === 0) {
      problems.push({
        code: 'NO_ACTIVE_QUESTIONS',
        stepId: null,
        questionId: null,
        detail: 'Nothing would be asked',
      });
    }

    return {
      eventId: draft.eventId,
      revision: draft.revision,
      steps,
      problems,
    };
  }
}

/** Everything about a question worth keeping in an audit entry. */
function snapshotQuestion(question: FormQuestion): Record<string, unknown> {
  return {
    id: question.id,
    stepId: question.stepId,
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
    options: question.options.map((option) => ({
      value: option.value,
      label: option.label,
      active: option.active,
    })),
  };
}

export type { FormStep };
