// Persistence for `event_entry_answers`.
//
// INSERT AND READ ONLY. There is no update and no delete, for the same reason
// there is none for a published version: what somebody answered is what they
// answered. Correcting an answer is an administrative act with its own record,
// and no such act exists yet — so neither does the method that would perform it
// silently.
//
// Rows are written in multi-row INSERTs. A form may carry 200 questions, and one
// statement per answer would make every registration a bet on how many
// statements a single batch will hold.

import type { EventEntryAnswer } from '../../shared/types';
import type { AnswerType, AnswerValue } from '../../shared/formAnswers';
import { FORM_QUESTION_TYPES } from '../../shared/formLifecycle';
import { ANSWER_VALUE_MAX_BYTES } from '../../shared/limits';
import { parseJson, serializeJson } from './json';
import { isIsoTimestamp } from './time';

export interface EntryAnswerRow {
  id: string;
  event_entry_id: string;
  question_id: string;
  question_key: string;
  question_label_snapshot: string;
  answer_type: string;
  answer_value: string | null;
  created_at: string;
}

const ANSWER_COLUMNS = `id, event_entry_id, question_id, question_key,
  question_label_snapshot, answer_type, answer_value, created_at`;

/** Every question type EXCEPT `INFORMATION`, which collects nothing. */
const VALID_ANSWER_TYPES = new Set<string>(
  FORM_QUESTION_TYPES.filter((type) => type !== 'INFORMATION'),
);

/**
 * Reads a stored answer back into a value.
 *
 * Goes through `parseJson`, never `JSON.parse`: the column is TEXT written at
 * some point in the past, so it is untrusted by default and its pollution keys
 * are stripped on the way in. A column that cannot be read is NOT degraded to
 * "no answer" — that would silently turn a reply into a blank, which is exactly
 * the kind of quiet loss an entry exists to prevent.
 */
function parseAnswerValue(raw: string | null, id: string): AnswerValue {
  if (raw === null) {
    throw new TypeError(`event_entry_answers.answer_value is missing for ${id}`);
  }
  const parsed = parseJson(raw, { maxBytes: ANSWER_VALUE_MAX_BYTES });
  if (!parsed.ok) {
    throw new TypeError(`event_entry_answers.answer_value is not readable for ${id}`);
  }

  const value = parsed.value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value as string[];
  }
  throw new TypeError(`event_entry_answers.answer_value holds an unsupported shape for ${id}`);
}

export function rowToEntryAnswer(row: EntryAnswerRow): EventEntryAnswer {
  if (!row.id || !row.event_entry_id || !row.question_id) {
    throw new TypeError('event_entry_answers row is missing its identifiers');
  }
  if (!VALID_ANSWER_TYPES.has(row.answer_type)) {
    throw new TypeError(
      `event_entry_answers.answer_type holds an unknown value: ${row.answer_type}`,
    );
  }
  if (!row.question_key) throw new TypeError('event_entry_answers.question_key is empty');
  if (!row.question_label_snapshot) {
    throw new TypeError('event_entry_answers.question_label_snapshot is empty');
  }
  if (!isIsoTimestamp(row.created_at)) {
    throw new TypeError(
      `event_entry_answers.created_at is not a canonical ISO timestamp: ${row.created_at}`,
    );
  }

  return {
    id: row.id,
    entryId: row.event_entry_id,
    questionId: row.question_id,
    questionKey: row.question_key,
    questionLabel: row.question_label_snapshot,
    type: row.answer_type as AnswerType,
    value: parseAnswerValue(row.answer_value, row.id),
  };
}

export interface EntryAnswerValues {
  id: string;
  entryId: string;
  questionId: string;
  questionKey: string;
  questionLabel: string;
  answerType: AnswerType;
  /** Already serialized; the service refuses anything that would not serialize. */
  answerValue: string;
  at: string;
}

/**
 * Serializes an answer for storage.
 *
 * Returned as a result rather than thrown, because "this value cannot be
 * stored" is something the service must translate into a refusal of the whole
 * submission — never into a row with a hole in it.
 */
export function serializeAnswerValue(
  value: AnswerValue,
): { ok: true; json: string } | { ok: false; reason: string } {
  const serialized = serializeJson(value, ANSWER_VALUE_MAX_BYTES);
  return serialized.ok ? serialized : { ok: false, reason: serialized.reason };
}

export class EntryAnswerRepository {
  constructor(private readonly db: D1Database) {}

  /**
   * The answers of one entry.
   *
   * Ordered by the position of the question in the VERSION — step first, then
   * question — rather than by insertion order. Insertion order is an accident
   * of how a client happened to send the payload; the version's order is how
   * the form actually read to the person filling it in.
   */
  async listByEntry(entryId: string): Promise<EventEntryAnswer[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ANSWER_COLUMNS.split(',')
          .map((column) => `a.${column.trim()}`)
          .join(', ')}
         FROM event_entry_answers a
         JOIN form_questions q ON q.id = a.question_id
         JOIN form_steps s ON s.id = q.step_id
         WHERE a.event_entry_id = ?
         ORDER BY s.sort_order ASC, q.sort_order ASC, a.id ASC`,
      )
      .bind(entryId)
      .all<EntryAnswerRow>();
    return (rows.results ?? []).map(rowToEntryAnswer);
  }

  async countByEntry(entryId: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS total FROM event_entry_answers WHERE event_entry_id = ?')
      .bind(entryId)
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  /**
   * How many rows travel in one INSERT.
   *
   * Same reasoning, and the same conservative number, as publishing: the widest
   * row here binds 8 values, so a chunk stays far below any plausible parameter
   * ceiling while cutting the statement count by this factor.
   */
  private static readonly ROWS_PER_INSERT = 50;

  private static chunk<T>(items: readonly T[]): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += EntryAnswerRepository.ROWS_PER_INSERT) {
      chunks.push(items.slice(index, index + EntryAnswerRepository.ROWS_PER_INSERT));
    }
    return chunks;
  }

  private static placeholders(count: number, width: number): string {
    const row = `(${Array.from({ length: width }, () => '?').join(', ')})`;
    return Array.from({ length: count }, () => row).join(', ');
  }

  insertStatements(rows: readonly EntryAnswerValues[]): D1PreparedStatement[] {
    return EntryAnswerRepository.chunk(rows).map((chunk) =>
      this.db
        .prepare(
          `INSERT INTO event_entry_answers
             (id, event_entry_id, question_id, question_key,
              question_label_snapshot, answer_type, answer_value, created_at)
           VALUES ${EntryAnswerRepository.placeholders(chunk.length, 8)}`,
        )
        .bind(
          ...chunk.flatMap((row) => [
            row.id,
            row.entryId,
            row.questionId,
            row.questionKey,
            row.questionLabel,
            row.answerType,
            row.answerValue,
            row.at,
          ]),
        ),
    );
  }
}
