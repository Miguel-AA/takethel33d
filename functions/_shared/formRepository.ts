// Persistence for the form draft, its steps, questions and options.
//
// Mutating statements are returned PREPARED, never executed, so the service can
// commit them in one `db.batch()` together with the draft's revision bump and
// the audit row.
//
// Every value reaches SQL through `.bind()`. The only strings ever interpolated
// are the table and scope names in `reorderStatements`, and those come from a
// closed map in this file — no client string can reach them.

import type {
  EventFormDraft,
  FormQuestion,
  FormQuestionOption,
  FormQuestionValidation,
  FormStep,
} from '../../shared/types';
import {
  FORM_OWNER_TYPES,
  FORM_QUESTION_TYPES,
  FORM_SYSTEM_FIELDS,
  type FormOwnerType,
  type FormQuestionType,
  type FormSystemField,
} from '../../shared/formLifecycle';
import {
  FORM_SORT_ORDER_CEILING,
  FORM_SORT_PARK_OFFSET,
} from '../../shared/limits';
import { isIsoTimestamp } from './time';
import { parseJson, serializeJson } from './json';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface FormDraftRow {
  id: string;
  event_id: string;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface FormStepRow {
  id: string;
  form_owner_type: string;
  form_owner_id: string;
  title: string;
  description: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface FormQuestionRow {
  id: string;
  form_owner_type: string;
  form_owner_id: string;
  step_id: string;
  key: string;
  system_field: string;
  type: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: number;
  active: number;
  exportable: number;
  sort_order: number;
  validation_config: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormOptionRow {
  id: string;
  question_id: string;
  value: string;
  label: string;
  sort_order: number;
  active: number;
  created_at: string;
  updated_at: string;
}

const DRAFT_COLUMNS = 'id, event_id, revision, updated_by, created_at, updated_at';
const STEP_COLUMNS = `id, form_owner_type, form_owner_id, title, description, sort_order,
  created_at, updated_at`;
const QUESTION_COLUMNS = `id, form_owner_type, form_owner_id, step_id, key, system_field, type,
  label, description, placeholder, required, active, exportable, sort_order,
  validation_config, created_at, updated_at`;
const OPTION_COLUMNS = `id, question_id, value, label, sort_order, active,
  created_at, updated_at`;

const VALID_OWNER_TYPES = new Set<string>(FORM_OWNER_TYPES);

/**
 * A published version is IMMUTABLE.
 *
 * This repository serves the editable draft. Handing it a VERSION owner is a
 * programming error, not a user input problem, so it throws rather than
 * returning a typed refusal — the call should never have been written.
 * Guarding here and not only at the routes means a future caller cannot reach
 * a frozen row by taking a different path to the same method.
 */
function assertDraftOwner(ownerType: string, table: string): void {
  if (ownerType !== 'DRAFT') {
    throw new TypeError(`${table} cannot be mutated for owner type ${ownerType}`);
  }
}

/**
 * SQL half of the same rule, for rows reached through a question rather than
 * an owner: an option may only be touched when its question is a draft's.
 */
const OWNED_BY_A_DRAFT = `EXISTS (
  SELECT 1 FROM form_questions q
  WHERE q.id = ? AND q.form_owner_type = 'DRAFT'
)`;
const VALID_QUESTION_TYPES = new Set<string>(FORM_QUESTION_TYPES);
const VALID_SYSTEM_FIELDS = new Set<string>(FORM_SYSTEM_FIELDS);

// ---------------------------------------------------------------------------
// Mappers
//
// Strict on purpose: an unknown type, an out-of-range position, a malformed
// timestamp or unparseable validation THROWS rather than flowing on. The column
// CHECKs are the first line of defence; this is the second, for rows a
// migration or a console session could have written.
// ---------------------------------------------------------------------------

function assertTimestamp(value: string, table: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`${table}.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

function assertSortOrder(value: number, table: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > FORM_SORT_ORDER_CEILING) {
    throw new TypeError(`${table}.sort_order is outside its allowed range: ${value}`);
  }
  return numeric;
}

/** SQLite has no boolean; the column CHECK bounds it to 0 or 1. */
function assertFlag(value: number, table: string, field: string): boolean {
  const numeric = Number(value);
  if (numeric !== 0 && numeric !== 1) {
    throw new TypeError(`${table}.${field} is not a boolean flag: ${value}`);
  }
  return numeric === 1;
}

function assertOwner(row: { form_owner_type: string; form_owner_id: string }, table: string) {
  if (!VALID_OWNER_TYPES.has(row.form_owner_type)) {
    throw new TypeError(`${table}.form_owner_type holds an unknown value: ${row.form_owner_type}`);
  }
  if (!row.form_owner_id) {
    throw new TypeError(`${table} row is missing its owner`);
  }
}

export function rowToFormDraft(row: FormDraftRow): Omit<EventFormDraft, 'steps'> {
  if (!row.id || !row.event_id) {
    throw new TypeError('event_form_drafts row is missing its identifiers');
  }
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TypeError(`event_form_drafts.revision is not a valid token: ${row.revision}`);
  }
  return {
    id: row.id,
    eventId: row.event_id,
    revision,
    updatedBy: row.updated_by,
    createdAt: assertTimestamp(row.created_at, 'event_form_drafts', 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'event_form_drafts', 'updated_at'),
  };
}

export function rowToFormStep(row: FormStepRow): Omit<FormStep, 'questions'> {
  assertOwner(row, 'form_steps');
  if (!row.id) throw new TypeError('form_steps row is missing its identifier');
  return {
    id: row.id,
    ownerType: row.form_owner_type as FormOwnerType,
    ownerId: row.form_owner_id,
    title: row.title,
    description: row.description,
    sortOrder: assertSortOrder(row.sort_order, 'form_steps'),
    createdAt: assertTimestamp(row.created_at, 'form_steps', 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'form_steps', 'updated_at'),
  };
}

/**
 * Parses the stored per-type constraints.
 *
 * A column that cannot be read is NOT degraded to "no validation": that would
 * silently loosen a rule an operator configured, so it throws instead.
 */
function parseValidation(raw: string | null): FormQuestionValidation | null {
  if (raw === null || raw.length === 0) return null;
  const parsed = parseJson(raw);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new TypeError('form_questions.validation_config is not a readable object');
  }
  return parsed.value as FormQuestionValidation;
}

export function rowToFormQuestion(row: FormQuestionRow): Omit<FormQuestion, 'options'> {
  assertOwner(row, 'form_questions');
  if (!row.id || !row.step_id) {
    throw new TypeError('form_questions row is missing its identifiers');
  }
  if (!VALID_QUESTION_TYPES.has(row.type)) {
    throw new TypeError(`form_questions.type holds an unknown value: ${row.type}`);
  }
  if (!VALID_SYSTEM_FIELDS.has(row.system_field)) {
    throw new TypeError(
      `form_questions.system_field holds an unknown value: ${row.system_field}`,
    );
  }
  if (!row.key) throw new TypeError('form_questions.key is empty');

  return {
    id: row.id,
    ownerType: row.form_owner_type as FormOwnerType,
    ownerId: row.form_owner_id,
    stepId: row.step_id,
    key: row.key,
    systemField: row.system_field as FormSystemField,
    type: row.type as FormQuestionType,
    label: row.label,
    description: row.description,
    placeholder: row.placeholder,
    required: assertFlag(row.required, 'form_questions', 'required'),
    active: assertFlag(row.active, 'form_questions', 'active'),
    exportable: assertFlag(row.exportable, 'form_questions', 'exportable'),
    sortOrder: assertSortOrder(row.sort_order, 'form_questions'),
    validation: parseValidation(row.validation_config),
    createdAt: assertTimestamp(row.created_at, 'form_questions', 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'form_questions', 'updated_at'),
  };
}

export function rowToFormOption(row: FormOptionRow): FormQuestionOption {
  if (!row.id || !row.question_id) {
    throw new TypeError('form_question_options row is missing its identifiers');
  }
  return {
    id: row.id,
    questionId: row.question_id,
    value: row.value,
    label: row.label,
    sortOrder: assertSortOrder(row.sort_order, 'form_question_options'),
    active: assertFlag(row.active, 'form_question_options', 'active'),
    createdAt: assertTimestamp(row.created_at, 'form_question_options', 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'form_question_options', 'updated_at'),
  };
}

// ---------------------------------------------------------------------------
// Reorder scopes
//
// The three orderings differ only in which table they touch and what "within"
// means. Everything here is a compile-time constant; no client string can
// become a table or column name.
// ---------------------------------------------------------------------------

type ReorderScope = 'steps' | 'questions' | 'options';

const REORDER_SQL: Record<ReorderScope, { table: string; scope: string }> = {
  steps: { table: 'form_steps', scope: 'form_owner_type = ? AND form_owner_id = ?' },
  questions: { table: 'form_questions', scope: 'step_id = ?' },
  options: { table: 'form_question_options', scope: 'question_id = ?' },
};

export interface FormStepInsert {
  id: string;
  ownerType: FormOwnerType;
  ownerId: string;
  title: string;
  description: string | null;
  sortOrder: number;
  at: string;
}

export interface FormQuestionInsert {
  id: string;
  ownerType: FormOwnerType;
  ownerId: string;
  stepId: string;
  key: string;
  systemField: FormSystemField;
  type: FormQuestionType;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  active: boolean;
  exportable: boolean;
  sortOrder: number;
  validation: FormQuestionValidation | null;
  at: string;
}

export interface FormOptionInsert {
  id: string;
  questionId: string;
  value: string;
  label: string;
  sortOrder: number;
  active: boolean;
  at: string;
}

/** Patch fields mapped to their columns. Nothing outside these maps is writable. */
const STEP_COLUMN_MAP: Record<string, string> = {
  title: 'title',
  description: 'description',
};

const QUESTION_COLUMN_MAP: Record<string, string> = {
  label: 'label',
  key: 'key',
  type: 'type',
  description: 'description',
  placeholder: 'placeholder',
  required: 'required',
  active: 'active',
  exportable: 'exportable',
  validation: 'validation_config',
  stepId: 'step_id',
  sortOrder: 'sort_order',
};

const OPTION_COLUMN_MAP: Record<string, string> = {
  value: 'value',
  label: 'label',
  active: 'active',
};

function toBind(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export class FormRepository {
  constructor(private readonly db: D1Database) {}

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  async findDraftByEvent(eventId: string): Promise<Omit<EventFormDraft, 'steps'> | null> {
    const row = await this.db
      .prepare(`SELECT ${DRAFT_COLUMNS} FROM event_form_drafts WHERE event_id = ? LIMIT 1`)
      .bind(eventId)
      .first<FormDraftRow>();
    return row ? rowToFormDraft(row) : null;
  }

  /** True when any event carries a draft; the event-deletion guard reads this. */
  async hasDraft(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM event_form_drafts WHERE event_id = ? LIMIT 1')
      .bind(eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  createDraftStatement(values: {
    id: string;
    eventId: string;
    actorId: string;
    at: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO event_form_drafts (id, event_id, revision, updated_by, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .bind(values.id, values.eventId, values.actorId, values.at, values.at);
  }

  /**
   * Bumps the form's revision, guarded.
   *
   * EVERY mutation runs this first: a step, a question and an option are all
   * edits to one document, so they share one optimistic-concurrency token.
   * Matching zero rows means another administrator saved while this one was
   * editing.
   */
  touchDraftStatement(
    draftId: string,
    expectedRevision: number,
    actorId: string,
    at: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE event_form_drafts
         SET revision = revision + 1, updated_by = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .bind(actorId, at, draftId, expectedRevision);
  }

  /**
   * Aborts the batch when the preceding statement changed nothing.
   *
   * Placed immediately after `touchDraftStatement`. Without it a stale revision
   * would leave the guard matching zero rows while the mutation that follows
   * committed anyway — the edit would land under a revision that never moved.
   * Writing NULL into a NOT NULL column is a deliberate, guaranteed failure:
   * SQLite raises and the batch's transaction rolls back whole.
   */
  abortUnlessChangedStatement(draftId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE event_form_drafts SET revision = NULL WHERE id = ? AND changes() = 0`,
      )
      .bind(draftId);
  }

  /**
   * Aborts the batch unless the draft is STILL at a given revision.
   *
   * Used by publishing, which must freeze exactly the revision an operator
   * confirmed but must NOT move it — the whole "unpublished changes" flag is
   * that number compared with the version's. Same technique as above: writing
   * NULL into a NOT NULL column is a guaranteed, transactional failure.
   */
  abortUnlessRevisionStatement(draftId: string, expected: number): D1PreparedStatement {
    return this.db
      .prepare('UPDATE event_form_drafts SET revision = NULL WHERE id = ? AND revision <> ?')
      .bind(draftId, expected);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async loadSteps(
    ownerType: FormOwnerType,
    ownerId: string,
  ): Promise<Array<Omit<FormStep, 'questions'>>> {
    const rows = await this.db
      .prepare(
        `SELECT ${STEP_COLUMNS} FROM form_steps
         WHERE form_owner_type = ? AND form_owner_id = ?
         ORDER BY sort_order ASC, id ASC`,
      )
      .bind(ownerType, ownerId)
      .all<FormStepRow>();
    return (rows.results ?? []).map(rowToFormStep);
  }

  async loadQuestions(
    ownerType: FormOwnerType,
    ownerId: string,
  ): Promise<Array<Omit<FormQuestion, 'options'>>> {
    const rows = await this.db
      .prepare(
        `SELECT ${QUESTION_COLUMNS} FROM form_questions
         WHERE form_owner_type = ? AND form_owner_id = ?
         ORDER BY sort_order ASC, id ASC`,
      )
      .bind(ownerType, ownerId)
      .all<FormQuestionRow>();
    return (rows.results ?? []).map(rowToFormQuestion);
  }

  /**
   * Every option belonging to a form, in one query.
   *
   * Joined through `form_questions` rather than sent a list of ids: a form with
   * 200 questions would otherwise mean 200 round trips, and D1 charges for
   * each one.
   */
  async loadOptions(
    ownerType: FormOwnerType,
    ownerId: string,
  ): Promise<FormQuestionOption[]> {
    const rows = await this.db
      .prepare(
        `SELECT o.id, o.question_id, o.value, o.label, o.sort_order, o.active,
                o.created_at, o.updated_at
         FROM form_question_options o
         JOIN form_questions q ON q.id = o.question_id
         WHERE q.form_owner_type = ? AND q.form_owner_id = ?
         ORDER BY o.sort_order ASC, o.id ASC`,
      )
      .bind(ownerType, ownerId)
      .all<FormOptionRow>();
    return (rows.results ?? []).map(rowToFormOption);
  }

  /** Assembles the nested shape the builder renders from. */
  async assemble(draft: Omit<EventFormDraft, 'steps'>): Promise<EventFormDraft> {
    const [steps, questions, options] = await Promise.all([
      this.loadSteps('DRAFT', draft.id),
      this.loadQuestions('DRAFT', draft.id),
      this.loadOptions('DRAFT', draft.id),
    ]);

    const optionsByQuestion = new Map<string, FormQuestionOption[]>();
    for (const option of options) {
      const list = optionsByQuestion.get(option.questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(option.questionId, list);
    }

    // `form_owner_id` is polymorphic and therefore cannot carry a foreign key,
    // so the coherence it would have guaranteed is checked HERE instead: every
    // question of this form must sit in a step of this form. A row that does
    // not — which only a migration or a console session could have written —
    // is reported as corrupt rather than silently vanishing from the builder,
    // because a question nobody can see is a question nobody can fix.
    const ownStepIds = new Set(steps.map((step) => step.id));
    const questionsByStep = new Map<string, FormQuestion[]>();
    for (const question of questions) {
      if (!ownStepIds.has(question.stepId)) {
        throw new TypeError(
          `form_questions.step_id points outside its own form: ${question.id}`,
        );
      }
      const list = questionsByStep.get(question.stepId) ?? [];
      list.push({ ...question, options: optionsByQuestion.get(question.id) ?? [] });
      questionsByStep.set(question.stepId, list);
    }

    return {
      ...draft,
      steps: steps.map((step) => ({
        ...step,
        questions: questionsByStep.get(step.id) ?? [],
      })),
    };
  }

  async findStep(ownerId: string, stepId: string): Promise<Omit<FormStep, 'questions'> | null> {
    const row = await this.db
      .prepare(
        `SELECT ${STEP_COLUMNS} FROM form_steps
         WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ? LIMIT 1`,
      )
      .bind(stepId, ownerId)
      .first<FormStepRow>();
    return row ? rowToFormStep(row) : null;
  }

  /**
   * Scoped lookup. Every handler uses THIS, never an unscoped one, so a
   * question id belonging to another event's form cannot be operated on by
   * guessing it (IDOR).
   */
  async findQuestion(
    ownerId: string,
    questionId: string,
  ): Promise<Omit<FormQuestion, 'options'> | null> {
    const row = await this.db
      .prepare(
        `SELECT ${QUESTION_COLUMNS} FROM form_questions
         WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ? LIMIT 1`,
      )
      .bind(questionId, ownerId)
      .first<FormQuestionRow>();
    return row ? rowToFormQuestion(row) : null;
  }

  /** An option is reached only through a question already scoped to the form. */
  async findOption(questionId: string, optionId: string): Promise<FormQuestionOption | null> {
    const row = await this.db
      .prepare(
        `SELECT ${OPTION_COLUMNS} FROM form_question_options
         WHERE id = ? AND question_id = ? LIMIT 1`,
      )
      .bind(optionId, questionId)
      .first<FormOptionRow>();
    return row ? rowToFormOption(row) : null;
  }

  async optionsOf(questionId: string): Promise<FormQuestionOption[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${OPTION_COLUMNS} FROM form_question_options
         WHERE question_id = ? ORDER BY sort_order ASC, id ASC`,
      )
      .bind(questionId)
      .all<FormOptionRow>();
    return (rows.results ?? []).map(rowToFormOption);
  }

  // -------------------------------------------------------------------------
  // Counts and positions
  // -------------------------------------------------------------------------

  private async count(sql: string, bindings: unknown[]): Promise<number> {
    const row = await this.db
      .prepare(sql)
      .bind(...bindings)
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  countSteps(ownerId: string): Promise<number> {
    return this.count(
      `SELECT COUNT(*) AS total FROM form_steps
       WHERE form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      [ownerId],
    );
  }

  countQuestions(ownerId: string): Promise<number> {
    return this.count(
      `SELECT COUNT(*) AS total FROM form_questions
       WHERE form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      [ownerId],
    );
  }

  countQuestionsInStep(stepId: string): Promise<number> {
    return this.count('SELECT COUNT(*) AS total FROM form_questions WHERE step_id = ?', [
      stepId,
    ]);
  }

  countOptions(questionId: string): Promise<number> {
    return this.count(
      'SELECT COUNT(*) AS total FROM form_question_options WHERE question_id = ?',
      [questionId],
    );
  }

  private async nextOrder(sql: string, bindings: unknown[]): Promise<number> {
    const row = await this.db
      .prepare(sql)
      .bind(...bindings)
      .first<{ next: number }>();
    return Number(row?.next ?? 0);
  }

  nextStepOrder(ownerId: string): Promise<number> {
    return this.nextOrder(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM form_steps
       WHERE form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      [ownerId],
    );
  }

  nextQuestionOrder(stepId: string): Promise<number> {
    return this.nextOrder(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM form_questions WHERE step_id = ?',
      [stepId],
    );
  }

  nextOptionOrder(questionId: string): Promise<number> {
    return this.nextOrder(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM form_question_options
       WHERE question_id = ?`,
      [questionId],
    );
  }

  // -------------------------------------------------------------------------
  // Step statements
  // -------------------------------------------------------------------------

  insertStepStatement(values: FormStepInsert): D1PreparedStatement {
    assertDraftOwner(values.ownerType, 'form_steps');
    return this.db
      .prepare(
        `INSERT INTO form_steps
           (id, form_owner_type, form_owner_id, title, description, sort_order,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.ownerType,
        values.ownerId,
        values.title,
        values.description,
        values.sortOrder,
        values.at,
        values.at,
      );
  }

  updateStepStatement(
    ownerId: string,
    stepId: string,
    patch: Record<string, unknown>,
    at: string,
  ): D1PreparedStatement {
    return this.patchStatement(
      'form_steps',
      STEP_COLUMN_MAP,
      patch,
      at,
      `WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      [stepId, ownerId],
    );
  }

  deleteStepStatement(ownerId: string, stepId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM form_steps
         WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      )
      .bind(stepId, ownerId);
  }

  // -------------------------------------------------------------------------
  // Question statements
  // -------------------------------------------------------------------------

  insertQuestionStatement(values: FormQuestionInsert): D1PreparedStatement {
    assertDraftOwner(values.ownerType, 'form_questions');
    const validation =
      values.validation === null ? null : serializeJson(values.validation);
    if (validation !== null && !validation.ok) {
      throw new TypeError('form_questions.validation_config cannot be serialized');
    }

    return this.db
      .prepare(
        `INSERT INTO form_questions
           (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
            label, description, placeholder, required, active, exportable,
            sort_order, validation_config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.ownerType,
        values.ownerId,
        values.stepId,
        values.key,
        values.systemField,
        values.type,
        values.label,
        values.description,
        values.placeholder,
        values.required ? 1 : 0,
        values.active ? 1 : 0,
        values.exportable ? 1 : 0,
        values.sortOrder,
        validation === null ? null : validation.json,
        values.at,
        values.at,
      );
  }

  updateQuestionStatement(
    ownerId: string,
    questionId: string,
    patch: Record<string, unknown>,
    at: string,
  ): D1PreparedStatement {
    const prepared = { ...patch };
    if ('validation' in prepared) {
      const value = prepared.validation;
      if (value === null || value === undefined) prepared.validation = null;
      else {
        const serialized = serializeJson(value as never);
        if (!serialized.ok) {
          throw new TypeError('form_questions.validation_config cannot be serialized');
        }
        prepared.validation = serialized.json;
      }
    }

    return this.patchStatement(
      'form_questions',
      QUESTION_COLUMN_MAP,
      prepared,
      at,
      `WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      [questionId, ownerId],
    );
  }

  deleteQuestionStatement(ownerId: string, questionId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM form_questions
         WHERE id = ? AND form_owner_type = 'DRAFT' AND form_owner_id = ?`,
      )
      .bind(questionId, ownerId);
  }

  /** Options carry a RESTRICT key, so they go first in the same batch. */
  deleteOptionsOfQuestionStatement(questionId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM form_question_options WHERE question_id = ? AND ${OWNED_BY_A_DRAFT}`,
      )
      .bind(questionId, questionId);
  }

  // -------------------------------------------------------------------------
  // Option statements
  // -------------------------------------------------------------------------

  insertOptionStatement(values: FormOptionInsert): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO form_question_options
           (id, question_id, value, label, sort_order, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.questionId,
        values.value,
        values.label,
        values.sortOrder,
        values.active ? 1 : 0,
        values.at,
        values.at,
      );
  }

  updateOptionStatement(
    questionId: string,
    optionId: string,
    patch: Record<string, unknown>,
    at: string,
  ): D1PreparedStatement {
    return this.patchStatement(
      'form_question_options',
      OPTION_COLUMN_MAP,
      patch,
      at,
      `WHERE id = ? AND question_id = ? AND ${OWNED_BY_A_DRAFT}`,
      [optionId, questionId, questionId],
    );
  }

  deleteOptionStatement(questionId: string, optionId: string): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM form_question_options
         WHERE id = ? AND question_id = ? AND ${OWNED_BY_A_DRAFT}`,
      )
      .bind(optionId, questionId, questionId);
  }

  // -------------------------------------------------------------------------
  // Shared patch builder
  // -------------------------------------------------------------------------

  /**
   * Builds a guarded UPDATE from a whitelisted patch.
   *
   * A key the map does not know is skipped rather than interpolated, which is
   * what keeps a hostile body from naming a column.
   */
  private patchStatement(
    table: string,
    columns: Record<string, string>,
    patch: Record<string, unknown>,
    at: string,
    where: string,
    whereBindings: unknown[],
  ): D1PreparedStatement {
    const assignments: string[] = [];
    const bindings: unknown[] = [];

    for (const [field, value] of Object.entries(patch)) {
      const column = columns[field];
      if (!column) continue;
      assignments.push(`${column} = ?`);
      bindings.push(toBind(value));
    }
    assignments.push('updated_at = ?');
    bindings.push(at);

    return this.db
      .prepare(`UPDATE ${table} SET ${assignments.join(', ')} ${where}`)
      .bind(...bindings, ...whereBindings);
  }

  // -------------------------------------------------------------------------
  // Reordering
  // -------------------------------------------------------------------------

  /**
   * Statements for a whole reorder, in two passes with a guard between them.
   *
   * Identical in shape to the prize reorder, and for the same reason: the
   * unique position index is checked per statement, so writing final positions
   * directly would collide the moment two rows swap. Pass one parks every row
   * at a position no real row can hold; pass two writes the final values
   * against now-empty slots. Both run in one batch, so the parked state is
   * never observable.
   *
   * The guard between them aborts the batch if any row failed to park — which
   * can only mean someone else changed the form — so a lost race commits
   * nothing rather than half an ordering.
   */
  reorderStatements(
    scope: ReorderScope,
    scopeBindings: unknown[],
    items: Array<{ id: string; sortOrder: number }>,
    at: string,
  ): D1PreparedStatement[] {
    // A published version is immutable; nothing about it is ever reordered.
    if (scope === 'steps') assertDraftOwner(String(scopeBindings[0]), 'form_steps');
    const { table, scope: where } = REORDER_SQL[scope];

    const park = items.map((item, index) =>
      this.db
        .prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND ${where}`)
        .bind(FORM_SORT_PARK_OFFSET + index, item.id, ...scopeBindings),
    );

    // Writing NULL into a NOT NULL column is a guaranteed failure; it matches
    // nothing at all when every row parked as expected.
    const guard = this.db
      .prepare(
        `UPDATE ${table} SET sort_order = NULL
         WHERE ${where} AND sort_order >= ?
           AND (SELECT COUNT(*) FROM ${table} WHERE ${where} AND sort_order >= ?) <> ?`,
      )
      .bind(
        ...scopeBindings,
        FORM_SORT_PARK_OFFSET,
        ...scopeBindings,
        FORM_SORT_PARK_OFFSET,
        items.length,
      );

    const settle = items.map((item, index) =>
      this.db
        .prepare(
          `UPDATE ${table} SET sort_order = ?, updated_at = ?
           WHERE id = ? AND ${where} AND sort_order = ?`,
        )
        .bind(
          item.sortOrder,
          at,
          item.id,
          ...scopeBindings,
          FORM_SORT_PARK_OFFSET + index,
        ),
    );

    return [...park, guard, ...settle];
  }
}
