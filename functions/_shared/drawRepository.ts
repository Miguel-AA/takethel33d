// Persistence for `draws` and `draw_assignments`.
//
// Mutating statements are returned PREPARED, never executed, so the whole draw
// — the row, every assignment, the audit entry and the event's transition —
// commits in one `db.batch()`. There is no code path here that writes half of
// one.
//
// IMMUTABLE BY CONSTRUCTION, in the same sense `FormVersionRepository` is: this
// class exposes reads and INSERTs and nothing else. There is no update, no
// delete, no reroll and no way to move a winner. That is not a convention; it
// is the absence of the method.

import type { CompletedDraw, DrawAssignment } from '../../shared/types';
import { isIsoTimestamp } from './time';

export interface DrawRow {
  id: string;
  event_id: string;
  completed_at: string;
  executed_by_admin_id: string | null;
  request_id: string | null;
  candidate_count: number;
  prize_unit_count: number;
  assignment_count: number;
  algorithm_version: string;
  candidate_set_hash: string;
  candidate_population_revision: number;
  created_at: string;
}

interface DrawJoinedRow extends DrawRow {
  executed_by_name: string | null;
}

interface AssignmentJoinedRow {
  id: string;
  draw_order: number;
  prize_id: string;
  prize_unit_index: number;
  prize_name_snapshot: string;
  prize_description_snapshot: string | null;
  entry_id: string;
  first_name: string;
  last_name: string;
  email: string;
}

const DRAW_COLUMNS = `id, event_id, completed_at, executed_by_admin_id, request_id,
  candidate_count, prize_unit_count, assignment_count,
  algorithm_version, candidate_set_hash, candidate_population_revision, created_at`;

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`draws.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

/**
 * Maps a row to the domain shape.
 *
 * Strict for the reason every mapper here is strict: a draw that claims more
 * winners than it had candidates, or carries no algorithm, is a corruption, and
 * passing it along would let a screen present an impossible result as fact. The
 * column CHECKs are the first line of defence; this is the second, for anything
 * a migration or a console session could have written.
 */
export function rowToDraw(row: DrawJoinedRow | DrawRow): CompletedDraw {
  if (!row.id || !row.event_id) {
    throw new TypeError('draws row is missing its identifiers');
  }

  const candidateCount = Number(row.candidate_count);
  const prizeUnitCount = Number(row.prize_unit_count);
  const assignmentCount = Number(row.assignment_count);

  if (!Number.isInteger(candidateCount) || candidateCount < 1) {
    throw new TypeError(`draws.candidate_count is not a real population: ${row.candidate_count}`);
  }
  if (!Number.isInteger(prizeUnitCount) || prizeUnitCount < 1) {
    throw new TypeError(`draws.prize_unit_count is not a real offering: ${row.prize_unit_count}`);
  }
  if (!Number.isInteger(assignmentCount) || assignmentCount < 1) {
    throw new TypeError(`draws.assignment_count is not a real result: ${row.assignment_count}`);
  }
  // A draw cannot have given away more than it had, in either direction.
  if (assignmentCount > candidateCount) {
    throw new TypeError('draws claims more winners than candidates');
  }
  if (assignmentCount > prizeUnitCount) {
    throw new TypeError('draws claims more winners than prize units');
  }
  if (!row.algorithm_version || row.algorithm_version.length === 0) {
    throw new TypeError('draws.algorithm_version is empty');
  }
  if (!row.candidate_set_hash || row.candidate_set_hash.length === 0) {
    throw new TypeError('draws.candidate_set_hash is empty');
  }

  return {
    id: row.id,
    completedAt: assertTimestamp(row.completed_at, 'completed_at'),
    candidateCount,
    prizeUnitCount,
    assignmentCount,
    algorithmVersion: row.algorithm_version,
    candidateSetHash: row.candidate_set_hash,
    executedByAdminId: row.executed_by_admin_id,
    executedByName: 'executed_by_name' in row ? row.executed_by_name : null,
  };
}

export interface DrawInsertValues {
  id: string;
  eventId: string;
  completedAt: string;
  executedByAdminId: string;
  requestId: string | null;
  candidateCount: number;
  prizeUnitCount: number;
  assignmentCount: number;
  algorithmVersion: string;
  candidateSetHash: string;
  candidatePopulationRevision: number;
}

export interface AssignmentInsertValues {
  id: string;
  drawId: string;
  eventId: string;
  prizeId: string;
  entryId: string;
  prizeUnitIndex: number;
  drawOrder: number;
  prizeNameSnapshot: string;
  prizeDescriptionSnapshot: string | null;
  assignedAt: string;
}

export class DrawRepository {
  constructor(private readonly db: D1Database) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The event's draw, if it has run one. Scoped by event throughout. */
  async findByEvent(eventId: string): Promise<CompletedDraw | null> {
    const row = await this.db
      .prepare(
        `SELECT ${DRAW_COLUMNS.split(',')
          .map((column) => `d.${column.trim()}`)
          .join(', ')},
                u.display_name AS executed_by_name
         FROM draws d
         LEFT JOIN admin_users u ON u.id = d.executed_by_admin_id
         WHERE d.event_id = ? LIMIT 1`,
      )
      .bind(eventId)
      .first<DrawJoinedRow>();
    return row ? rowToDraw(row) : null;
  }

  /** Cheap existence check for the precondition; the unique index decides. */
  async hasDraw(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM draws WHERE event_id = ? LIMIT 1')
      .bind(eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  /**
   * The assignments of one draw, in the order they were made.
   *
   * Scoped by BOTH draw and event: an assignment whose `event_id` disagrees
   * with its draw's is a corruption SQLite cannot express a constraint for, and
   * silently including it would show one event's winners on another's screen.
   */
  async listAssignments(eventId: string, drawId: string): Promise<DrawAssignment[]> {
    const rows = await this.db
      .prepare(
        `SELECT a.id, a.draw_order, a.prize_id, a.prize_unit_index,
                a.prize_name_snapshot, a.prize_description_snapshot,
                a.entry_id, p.first_name, p.last_name, p.email
         FROM draw_assignments a
         JOIN event_entries e ON e.id = a.entry_id
         JOIN participants p ON p.id = e.participant_id
         WHERE a.draw_id = ? AND a.event_id = ?
         ORDER BY a.draw_order ASC, a.id ASC`,
      )
      .bind(drawId, eventId)
      .all<AssignmentJoinedRow>();

    const assignments = (rows.results ?? []).map((row) => ({
      id: row.id,
      drawOrder: Number(row.draw_order),
      prize: {
        id: row.prize_id,
        // The SNAPSHOT, never a join to the live prize row: a prize renamed a
        // year later must not rewrite what somebody was told they had won.
        name: row.prize_name_snapshot,
        description: row.prize_description_snapshot,
        unitIndex: Number(row.prize_unit_index),
      },
      winner: {
        entryId: row.entry_id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
      },
    })) satisfies DrawAssignment[];

    // Invariants the unique indexes already enforce, re-checked on the way out
    // so a database that lost them cannot present a draw where one person won
    // twice or one unit was awarded twice.
    const winners = new Set(assignments.map((a) => a.winner.entryId));
    if (winners.size !== assignments.length) {
      throw new TypeError('draw_assignments contains a duplicate winner');
    }
    const units = new Set(assignments.map((a) => `${a.prize.id}#${a.prize.unitIndex}`));
    if (units.size !== assignments.length) {
      throw new TypeError('draw_assignments contains a duplicate prize unit');
    }

    return assignments;
  }

  /** Whether any draw references this event. Blocks physical deletion forever. */
  async hasDrawsForEvent(eventId: string): Promise<boolean> {
    return this.hasDraw(eventId);
  }

  // -------------------------------------------------------------------------
  // Writes — INSERT ONLY
  // -------------------------------------------------------------------------

  insertDrawStatement(values: DrawInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO draws
           (id, event_id, completed_at, executed_by_admin_id, request_id,
            candidate_count, prize_unit_count, assignment_count,
            algorithm_version, candidate_set_hash, candidate_population_revision,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.eventId,
        values.completedAt,
        values.executedByAdminId,
        values.requestId,
        values.candidateCount,
        values.prizeUnitCount,
        values.assignmentCount,
        values.algorithmVersion,
        values.candidateSetHash,
        values.candidatePopulationRevision,
        values.completedAt,
      );
  }

  /**
   * One statement per assignment.
   *
   * Unlike a form publication — which copies thousands of rows and therefore
   * batches them — a draw produces at most one assignment per prize unit, and
   * `PRIZES_PER_EVENT_MAX` times `PRIZE_QUANTITY_MAX` is a bounded, modest
   * number. One statement each keeps the unique-index violation attributable to
   * the assignment that caused it.
   */
  insertAssignmentStatements(rows: readonly AssignmentInsertValues[]): D1PreparedStatement[] {
    return rows.map((row) =>
      this.db
        .prepare(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id,
              prize_unit_index, draw_order,
              prize_name_snapshot, prize_description_snapshot, assigned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.drawId,
          row.eventId,
          row.prizeId,
          row.entryId,
          row.prizeUnitIndex,
          row.drawOrder,
          row.prizeNameSnapshot,
          row.prizeDescriptionSnapshot,
          row.assignedAt,
        ),
    );
  }
}
