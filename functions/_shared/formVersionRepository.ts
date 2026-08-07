// Persistence for published form versions.
//
// IMMUTABLE BY CONSTRUCTION: this class exposes reads and INSERTs, and nothing
// else. There is no update and no delete for a version, its steps, its
// questions or its options — so no caller, present or future, can rewrite a
// form somebody has already been shown. That is not a convention; it is the
// absence of a method.
//
// Mutating statements are returned PREPARED, never executed, so the publishing
// service can commit an entire publication — version row, copied structure,
// event pointer and audit row — in one `db.batch()`.

import type {
  EventFormVersion,
  EventFormVersionSummary,
  FormQuestion,
  FormQuestionOption,
  FormStep,
} from '../../shared/types';
import type { FormSchemaSnapshot } from '../../shared/formPublishing';
import { FormRepository } from './formRepository';
import { parseJson } from './json';
import { isIsoTimestamp } from './time';

export interface FormVersionRow {
  id: string;
  event_id: string;
  version_number: number;
  source_draft_revision: number;
  published_by: string;
  published_at: string;
  schema_snapshot: string;
  created_at: string;
}

interface FormVersionJoinedRow extends FormVersionRow {
  publisher_name: string | null;
  step_count: number;
  question_count: number;
}

const VERSION_COLUMNS = `id, event_id, version_number, source_draft_revision,
  published_by, published_at, schema_snapshot, created_at`;

/** The metadata half of a version, without its structure. */
export interface FormVersionRecord {
  id: string;
  eventId: string;
  versionNumber: number;
  sourceDraftRevision: number;
  publishedBy: string;
  publishedAt: string;
  createdAt: string;
  snapshot: FormSchemaSnapshot;
}

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`event_form_versions.${field} is not a canonical ISO timestamp`);
  }
  return value;
}

function boundedInteger(value: number, column: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new TypeError(`event_form_versions.${column} is not a valid counter: ${value}`);
  }
  return numeric;
}

/**
 * Maps a row, parsing its snapshot.
 *
 * A snapshot that cannot be read is NOT degraded to "no snapshot": it is the
 * evidence of what was published, and quietly losing it would leave a version
 * whose history nobody can check.
 */
export function rowToFormVersion(row: FormVersionRow): FormVersionRecord {
  if (!row.id || !row.event_id) {
    throw new TypeError('event_form_versions row is missing its identifiers');
  }
  const parsed = parseJson(row.schema_snapshot);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    throw new TypeError('event_form_versions.schema_snapshot is not a readable object');
  }

  return {
    id: row.id,
    eventId: row.event_id,
    versionNumber: boundedInteger(row.version_number, 'version_number'),
    sourceDraftRevision: boundedInteger(row.source_draft_revision, 'source_draft_revision'),
    publishedBy: row.published_by,
    publishedAt: assertTimestamp(row.published_at, 'published_at'),
    createdAt: assertTimestamp(row.created_at, 'created_at'),
    snapshot: parsed.value as unknown as FormSchemaSnapshot,
  };
}

export interface VersionInsertValues {
  id: string;
  eventId: string;
  versionNumber: number;
  sourceDraftRevision: number;
  publishedBy: string;
  publishedAt: string;
  snapshot: string;
}

export class FormVersionRepository {
  private readonly forms: FormRepository;

  constructor(private readonly db: D1Database) {
    this.forms = new FormRepository(db);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The next version number for an event.
   *
   * Advisory only. Two publications racing here compute the SAME number, and
   * the unique index on (event_id, version_number) is what decides between
   * them — this read cannot be the guard, so it does not pretend to be.
   */
  async nextVersionNumber(eventId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
         FROM event_form_versions WHERE event_id = ?`,
      )
      .bind(eventId)
      .first<{ next: number }>();
    return Number(row?.next ?? 1);
  }

  /** Scoped lookup: a version id from another event resolves to nothing. */
  async findById(eventId: string, versionId: string): Promise<FormVersionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM event_form_versions
         WHERE id = ? AND event_id = ? LIMIT 1`,
      )
      .bind(versionId, eventId)
      .first<FormVersionRow>();
    return row ? rowToFormVersion(row) : null;
  }

  /**
   * Whether a version belongs to an event.
   *
   * SQLite cannot express "the pointer must reference a version OF THIS EVENT"
   * — that needs a composite foreign key. This is the application's half of
   * that constraint, and the only route by which a pointer is ever set.
   */
  async versionBelongsToEvent(eventId: string, versionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        'SELECT 1 AS present FROM event_form_versions WHERE id = ? AND event_id = ? LIMIT 1',
      )
      .bind(versionId, eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  /**
   * Whether the event's pointer names a version that is genuinely its own.
   *
   * SQLite can only guarantee that the pointer names SOME version — a composite
   * foreign key against (id, event_id) is not expressible. So a row edited
   * outside the application could leave event A serving event B's form, which
   * is the single most damaging thing this table could get wrong: people would
   * be shown, and answer, a form belonging to someone else's event.
   *
   * Returns the pointer's condition rather than a boolean, so a caller can tell
   * "nothing published" apart from "published something impossible".
   *
   * `empty` covers a version whose structure has been destroyed underneath it.
   * Publishing guarantees at least the three identity questions, so a version
   * with none is not a form anyone should be sent to — and announcing an event
   * on the strength of it would advertise a door with nothing behind it.
   */
  async pointerCondition(
    eventId: string,
  ): Promise<'none' | 'valid' | 'foreign' | 'missing' | 'empty'> {
    const row = await this.db
      .prepare(
        `SELECT e.published_form_version_id AS pointer,
                v.event_id AS owner,
                (SELECT COUNT(*) FROM form_questions q
                  WHERE q.form_owner_type = 'VERSION'
                    AND q.form_owner_id = v.id) AS questions
         FROM events e
         LEFT JOIN event_form_versions v ON v.id = e.published_form_version_id
         WHERE e.id = ? LIMIT 1`,
      )
      .bind(eventId)
      .first<{ pointer: string | null; owner: string | null; questions: number | null }>();

    if (!row || row.pointer === null) return 'none';
    if (row.owner === null) return 'missing';
    if (row.owner !== eventId) return 'foreign';
    return Number(row.questions ?? 0) > 0 ? 'valid' : 'empty';
  }

  /** The version the event currently serves, if any. */
  async findCurrentPublished(eventId: string): Promise<FormVersionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT v.id, v.event_id, v.version_number, v.source_draft_revision,
                v.published_by, v.published_at, v.schema_snapshot, v.created_at
         FROM events e
         JOIN event_form_versions v ON v.id = e.published_form_version_id
         WHERE e.id = ? LIMIT 1`,
      )
      .bind(eventId)
      .first<FormVersionRow>();
    return row ? rowToFormVersion(row) : null;
  }

  /**
   * The version that froze a given draft revision, if one already did.
   *
   * Asked before publishing so "nothing has changed" is answered by looking at
   * every version, not only the newest one.
   */
  async findBySourceRevision(
    eventId: string,
    sourceDraftRevision: number,
  ): Promise<FormVersionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM event_form_versions
         WHERE event_id = ? AND source_draft_revision = ? LIMIT 1`,
      )
      .bind(eventId, sourceDraftRevision)
      .first<FormVersionRow>();
    return row ? rowToFormVersion(row) : null;
  }

  /** The most recent publication, whether or not it is the one being served. */
  async findLatest(eventId: string): Promise<FormVersionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM event_form_versions
         WHERE event_id = ? ORDER BY version_number DESC LIMIT 1`,
      )
      .bind(eventId)
      .first<FormVersionRow>();
    return row ? rowToFormVersion(row) : null;
  }

  /** History, newest first, with the counts the list renders. */
  async listByEvent(
    eventId: string,
    query: { page: number; pageSize: number },
  ): Promise<{ items: EventFormVersionSummary[]; total: number; currentVersionId: string | null }> {
    const totalRow = await this.db
      .prepare('SELECT COUNT(*) AS total FROM event_form_versions WHERE event_id = ?')
      .bind(eventId)
      .first<{ total: number }>();

    const currentRow = await this.db
      .prepare('SELECT published_form_version_id AS id FROM events WHERE id = ? LIMIT 1')
      .bind(eventId)
      .first<{ id: string | null }>();
    const currentVersionId = currentRow?.id ?? null;

    const rows = await this.db
      .prepare(
        `SELECT v.id, v.event_id, v.version_number, v.source_draft_revision,
                v.published_by, v.published_at, v.schema_snapshot, v.created_at,
                u.display_name AS publisher_name,
                (SELECT COUNT(*) FROM form_steps s
                  WHERE s.form_owner_type = 'VERSION' AND s.form_owner_id = v.id) AS step_count,
                (SELECT COUNT(*) FROM form_questions q
                  WHERE q.form_owner_type = 'VERSION' AND q.form_owner_id = v.id) AS question_count
         FROM event_form_versions v
         LEFT JOIN admin_users u ON u.id = v.published_by
         WHERE v.event_id = ?
         ORDER BY v.version_number DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(eventId, query.pageSize, (query.page - 1) * query.pageSize)
      .all<FormVersionJoinedRow>();

    const items = (rows.results ?? []).map((row) => {
      const record = rowToFormVersion(row);
      return {
        id: record.id,
        versionNumber: record.versionNumber,
        sourceDraftRevision: record.sourceDraftRevision,
        publishedBy: record.publishedBy,
        publishedByName: row.publisher_name ?? null,
        publishedAt: record.publishedAt,
        currentPublished: record.id === currentVersionId,
        stepCount: Number(row.step_count ?? 0),
        questionCount: Number(row.question_count ?? 0),
      } satisfies EventFormVersionSummary;
    });

    return { items, total: Number(totalRow?.total ?? 0), currentVersionId };
  }

  /**
   * The frozen structure of a version, from the normalized rows.
   *
   * The rows are the RUNTIME source; the snapshot is evidence. Loading goes
   * through the same assembler the draft uses, so a version that has been
   * corrupted across owners raises the same controlled error a draft would.
   */
  async loadVersionStructure(versionId: string): Promise<FormStep[]> {
    const [steps, questions, options] = await Promise.all([
      this.forms.loadSteps('VERSION', versionId),
      this.forms.loadQuestions('VERSION', versionId),
      this.forms.loadOptions('VERSION', versionId),
    ]);

    const optionsByQuestion = new Map<string, FormQuestionOption[]>();
    for (const option of options) {
      optionsByQuestion.set(option.questionId, [
        ...(optionsByQuestion.get(option.questionId) ?? []),
        option,
      ]);
    }

    const ownStepIds = new Set(steps.map((step) => step.id));
    const questionsByStep = new Map<string, FormQuestion[]>();
    for (const question of questions) {
      if (!ownStepIds.has(question.stepId)) {
        throw new TypeError(
          `form_questions.step_id points outside its own version: ${question.id}`,
        );
      }
      questionsByStep.set(question.stepId, [
        ...(questionsByStep.get(question.stepId) ?? []),
        { ...question, options: optionsByQuestion.get(question.id) ?? [] },
      ]);
    }

    return steps.map((step) => ({
      ...step,
      questions: questionsByStep.get(step.id) ?? [],
    }));
  }

  /** Metadata plus structure, as the API returns it. */
  async loadVersion(
    eventId: string,
    versionId: string,
  ): Promise<{ record: FormVersionRecord; version: EventFormVersion } | null> {
    const record = await this.findById(eventId, versionId);
    if (!record) return null;

    const steps = await this.loadVersionStructure(record.id);
    return {
      record,
      version: {
        id: record.id,
        eventId: record.eventId,
        versionNumber: record.versionNumber,
        sourceDraftRevision: record.sourceDraftRevision,
        publishedBy: record.publishedBy,
        publishedAt: record.publishedAt,
        createdAt: record.createdAt,
        steps,
      },
    };
  }

  /** Whether an event has ever published. Blocks physical deletion forever. */
  async hasVersions(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM event_form_versions WHERE event_id = ? LIMIT 1')
      .bind(eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  // -------------------------------------------------------------------------
  // Writes — INSERT ONLY
  // -------------------------------------------------------------------------

  insertVersionStatement(values: VersionInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO event_form_versions
           (id, event_id, version_number, source_draft_revision, published_by,
            published_at, schema_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.eventId,
        values.versionNumber,
        values.sourceDraftRevision,
        values.publishedBy,
        values.publishedAt,
        values.snapshot,
        values.publishedAt,
      );
  }

  /**
   * How many rows travel in one INSERT.
   *
   * Publishing copies a whole form, and a form may hold 20 steps, 200 questions
   * and 100 options each — twenty thousand rows. One statement per row would be
   * twenty thousand statements in a single batch, which is a bet on a limit
   * nothing here documents. Multi-row inserts keep the publication a SINGLE
   * atomic batch while cutting the statement count by this factor.
   *
   * 50 is deliberately conservative: the widest row here binds 17 values, so a
   * chunk stays under 900 bound parameters — far below any plausible ceiling.
   */
  private static readonly ROWS_PER_INSERT = 50;

  private static chunk<T>(items: T[]): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += FormVersionRepository.ROWS_PER_INSERT) {
      chunks.push(items.slice(index, index + FormVersionRepository.ROWS_PER_INSERT));
    }
    return chunks;
  }

  /** `(?, ?, …), (?, ?, …)` for `count` rows of `width` columns. */
  private static placeholders(count: number, width: number): string {
    const row = `(${Array.from({ length: width }, () => '?').join(', ')})`;
    return Array.from({ length: count }, () => row).join(', ');
  }

  /** Every step of a version, in as few statements as the chunk size allows. */
  insertVersionStepsStatements(rows: VersionStepValues[]): D1PreparedStatement[] {
    return FormVersionRepository.chunk(rows).map((chunk) =>
      this.db
        .prepare(
          `INSERT INTO form_steps
             (id, form_owner_type, form_owner_id, title, description, sort_order,
              created_at, updated_at)
           VALUES ${FormVersionRepository.placeholders(chunk.length, 8)}`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            row.id,
            'VERSION',
            row.versionId,
            row.title,
            row.description,
            row.sortOrder,
            row.at,
            row.at,
          ]),
        ),
    );
  }

  insertVersionQuestionsStatements(rows: VersionQuestionValues[]): D1PreparedStatement[] {
    return FormVersionRepository.chunk(rows).map((chunk) =>
      this.db
        .prepare(
          `INSERT INTO form_questions
             (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
              label, description, placeholder, required, active, exportable,
              sort_order, validation_config, created_at, updated_at)
           VALUES ${FormVersionRepository.placeholders(chunk.length, 17)}`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            row.id,
            'VERSION',
            row.versionId,
            row.stepId,
            row.key,
            row.systemField,
            row.type,
            row.label,
            row.description,
            row.placeholder,
            row.required ? 1 : 0,
            row.active ? 1 : 0,
            row.exportable ? 1 : 0,
            row.sortOrder,
            row.validation,
            row.at,
            row.at,
          ]),
        ),
    );
  }

  insertVersionOptionsStatements(rows: VersionOptionValues[]): D1PreparedStatement[] {
    return FormVersionRepository.chunk(rows).map((chunk) =>
      this.db
        .prepare(
          `INSERT INTO form_question_options
             (id, question_id, value, label, sort_order, active, created_at, updated_at)
           VALUES ${FormVersionRepository.placeholders(chunk.length, 8)}`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            row.id,
            row.questionId,
            row.value,
            row.label,
            row.sortOrder,
            row.active ? 1 : 0,
            row.at,
            row.at,
          ]),
        ),
    );
  }

  /** Points the event at a version. Only ever one that was just created. */
  setPublishedVersionStatement(eventId: string, versionId: string): D1PreparedStatement {
    return this.db
      .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
      .bind(versionId, eventId);
  }
}

// ---------------------------------------------------------------------------
// Bulk copies
//
// The values publishing collects before writing them. One statement per row
// would make a publication a bet on how many statements a batch will carry, so
// rows go in groups; these types are what a group is made of.
//
// There is deliberately no single-row equivalent. An INSERT into a VERSION
// table that nothing calls is write surface nobody exercises and nobody tests,
// which is exactly what "immutable by construction" cannot afford to keep.
// ---------------------------------------------------------------------------

export interface VersionStepValues {
  id: string;
  versionId: string;
  title: string;
  description: string | null;
  sortOrder: number;
  at: string;
}

export interface VersionQuestionValues {
  id: string;
  versionId: string;
  stepId: string;
  key: string;
  systemField: string;
  type: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  active: boolean;
  exportable: boolean;
  sortOrder: number;
  validation: string | null;
  at: string;
}

export interface VersionOptionValues {
  id: string;
  questionId: string;
  value: string;
  label: string;
  sortOrder: number;
  active: boolean;
  at: string;
}
