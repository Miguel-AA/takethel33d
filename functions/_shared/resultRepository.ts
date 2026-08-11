// Persistence for `result_publications` and `result_publication_items`.
//
// Mutating statements are returned PREPARED, never executed, so a publication —
// the row, every announced winner and the audit entry — commits in one
// `db.batch()`. There is no code path here that writes half of one.
//
// INSERT-ONLY, in the same sense `DrawRepository` is. There is no update, no
// delete and no unpublish. That is not a convention this class follows; it is
// the absence of the method, and a caller that wanted to withdraw a publication
// would have to add one first.
//
// The reads FAIL CLOSED. Phase 11's validation found a draw read that silently
// dropped a corrupted row and presented two winners for a three-winner draw;
// the same shape of mistake here would mean announcing an incomplete result to
// the public, so every read below counts what it got and refuses to return a
// publication that does not add up.

import type {
  AdminResultAssignment,
  PublicWinnerDTO,
  ResultPublicationSummary,
} from '../../shared/types';
import { isIsoTimestamp } from './time';

export interface ResultPublicationRow {
  id: string;
  event_id: string;
  draw_id: string;
  published_at: string;
  published_by_admin_id: string | null;
  request_id: string | null;
  winner_count: number;
  created_at: string;
}

interface PublicationJoinedRow extends ResultPublicationRow {
  published_by_name: string | null;
}

interface ItemRow {
  id: string;
  draw_id: string;
  assignment_id: string;
  draw_order: number;
  winner_display_name_snapshot: string;
  prize_name_snapshot: string;
  prize_description_snapshot: string | null;
  prize_unit_index: number;
}

const PUBLICATION_COLUMNS = `id, event_id, draw_id, published_at, published_by_admin_id,
  request_id, winner_count, created_at`;

/**
 * A publication as this layer holds it.
 *
 * `drawId` is INTERNAL. It is what lets a read verify that every announced
 * winner came from this publication's own draw, and it is stripped before the
 * record reaches a client — `AdminEventResults.draw.id` already carries the
 * same value, and the public projection is built field by field from the items.
 */
export interface StoredPublication extends ResultPublicationSummary {
  drawId: string;
}

/** The client-facing shape, named field by field. Never a spread. */
export function toPublicationSummary(
  publication: StoredPublication,
): ResultPublicationSummary {
  return {
    id: publication.id,
    publishedAt: publication.publishedAt,
    publishedByAdminId: publication.publishedByAdminId,
    publishedByName: publication.publishedByName,
    winnerCount: publication.winnerCount,
  };
}

/**
 * Maps a publication row to the domain shape.
 *
 * Strict for the reason every mapper here is strict: a publication claiming no
 * winners, or carrying a malformed instant, is a corruption, and passing it
 * along would let a public page present it as a record of what happened.
 */
export function rowToPublication(
  row: PublicationJoinedRow | ResultPublicationRow,
): StoredPublication {
  if (!row.id || !row.event_id || !row.draw_id) {
    throw new TypeError('result_publications row is missing its identifiers');
  }
  const winnerCount = Number(row.winner_count);
  if (!Number.isInteger(winnerCount) || winnerCount < 1) {
    throw new TypeError(
      `result_publications.winner_count is not a real result: ${row.winner_count}`,
    );
  }
  if (!isIsoTimestamp(row.published_at)) {
    throw new TypeError(
      `result_publications.published_at is not a canonical ISO timestamp: ${row.published_at}`,
    );
  }

  return {
    id: row.id,
    drawId: row.draw_id,
    publishedAt: row.published_at,
    publishedByAdminId: row.published_by_admin_id,
    publishedByName: 'published_by_name' in row ? row.published_by_name : null,
    winnerCount,
  };
}

export interface PublicationInsertValues {
  id: string;
  eventId: string;
  drawId: string;
  publishedAt: string;
  publishedByAdminId: string;
  requestId: string | null;
  winnerCount: number;
}

export interface PublicationItemInsertValues {
  id: string;
  publicationId: string;
  drawId: string;
  assignmentId: string;
  drawOrder: number;
  winnerDisplayNameSnapshot: string;
  prizeNameSnapshot: string;
  prizeDescriptionSnapshot: string | null;
  prizeUnitIndex: number;
  createdAt: string;
}

/** One assignment, as the publication builder needs it. */
export interface PublishableAssignment {
  assignmentId: string;
  drawId: string;
  drawOrder: number;
  prizeNameSnapshot: string;
  prizeDescriptionSnapshot: string | null;
  prizeUnitIndex: number;
  entryId: string;
  firstName: string;
  lastName: string;
  email: string;
}

export class ResultRepository {
  constructor(private readonly db: D1Database) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The event's publication, if its results have been announced. */
  async findPublicationByEvent(eventId: string): Promise<StoredPublication | null> {
    const row = await this.db
      .prepare(
        `SELECT ${PUBLICATION_COLUMNS.split(',')
          .map((column) => `p.${column.trim()}`)
          .join(', ')},
                u.display_name AS published_by_name
         FROM result_publications p
         LEFT JOIN admin_users u ON u.id = p.published_by_admin_id
         WHERE p.event_id = ? LIMIT 1`,
      )
      .bind(eventId)
      .first<PublicationJoinedRow>();
    return row ? rowToPublication(row) : null;
  }

  /** The publication of one draw. Distinct from the event lookup on purpose. */
  async findPublicationByDraw(drawId: string): Promise<StoredPublication | null> {
    const row = await this.db
      .prepare(`SELECT ${PUBLICATION_COLUMNS} FROM result_publications WHERE draw_id = ? LIMIT 1`)
      .bind(drawId)
      .first<ResultPublicationRow>();
    return row ? rowToPublication(row) : null;
  }

  /** Cheap existence check. The unique indexes are what actually decide. */
  async hasPublication(eventId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS present FROM result_publications WHERE event_id = ? LIMIT 1')
      .bind(eventId)
      .first<{ present: number }>();
    return row !== null;
  }

  /**
   * The announced winners of one publication, in draw order.
   *
   * THREE CHECKS, and each closes a different way of being wrong. They are
   * separate because a database can lose its constraints — a restore, a
   * migration tool, a console session with `PRAGMA foreign_keys = OFF` — and
   * this read is the last thing between such a row and a public page that
   * outlives the event.
   *
   *   COUNT — `expectedCount` is a required argument, not an option. Phase 11's
   *   validation found a read that silently returned fewer rows than the record
   *   claimed; a disagreement THROWS rather than producing a shorter list,
   *   because an incomplete winner list is worse than an error — it looks like
   *   an answer.
   *
   *   LINEAGE — every item must belong to the publication's OWN draw. Measured
   *   before this existed: an item carrying another draw's `draw_id` and
   *   `assignment_id` was inserted with the foreign keys off, `winner_count`
   *   was adjusted to match, and the read announced "Smuggled S." as a winner
   *   of this event. The count check cannot see it, because the count was
   *   correct. Only the lineage can.
   *
   *   POSITION — the unique index already forbids two items sharing a place;
   *   this is the second line, for a database that lost it.
   */
  async loadPublicationItems(
    publicationId: string,
    expectedCount: number,
    expectedDrawId: string,
  ): Promise<ItemRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT id, draw_id, assignment_id, draw_order, winner_display_name_snapshot,
                prize_name_snapshot, prize_description_snapshot, prize_unit_index
         FROM result_publication_items
         WHERE publication_id = ?
         ORDER BY draw_order ASC, id ASC`,
      )
      .bind(publicationId)
      .all<ItemRow>();

    const items = rows.results ?? [];
    if (items.length !== expectedCount) {
      throw new TypeError(
        `publication ${publicationId} recorded ${expectedCount} winners but ${items.length} are readable`,
      );
    }

    const foreign = items.find((item) => item.draw_id !== expectedDrawId);
    if (foreign) {
      throw new TypeError(
        `publication ${publicationId} contains an item from draw ${foreign.draw_id}`,
      );
    }

    const positions = new Set(items.map((item) => Number(item.draw_order)));
    if (positions.size !== items.length) {
      throw new TypeError(`publication ${publicationId} has two winners in one position`);
    }

    // One item per assignment. The index guarantees it; a database that lost
    // the index would otherwise let one winner be announced twice.
    const assignments = new Set(items.map((item) => item.assignment_id));
    if (assignments.size !== items.length) {
      throw new TypeError(`publication ${publicationId} announces one winner twice`);
    }

    return items;
  }

  /** The public projection: an abbreviated name and a prize, nothing else. */
  async loadPublicResults(
    publicationId: string,
    expectedCount: number,
    expectedDrawId: string,
  ): Promise<PublicWinnerDTO[]> {
    const items = await this.loadPublicationItems(
      publicationId,
      expectedCount,
      expectedDrawId,
    );
    // Built field by field from the SNAPSHOT columns. No spread, so a column
    // added to this table later cannot travel to a public page by accident.
    return items.map((item) => ({
      displayName: item.winner_display_name_snapshot,
      prizeName: item.prize_name_snapshot,
      prizeDescription: item.prize_description_snapshot,
      prizeUnitIndex: Number(item.prize_unit_index),
    }));
  }

  /**
   * The assignments a publication would be built from.
   *
   * Read from `draw_assignments` and joined to the participant only for the
   * NAME — the prize comes from the assignment's own snapshot, never from
   * `event_prizes`, so an edit made since the draw cannot reach the
   * publication.
   *
   * Scoped by draw AND event, and the count is checked by the caller: a missing
   * row here would mean publishing a result that omits a winner.
   */
  async loadPublishableAssignments(
    eventId: string,
    drawId: string,
  ): Promise<PublishableAssignment[]> {
    const rows = await this.db
      .prepare(
        `SELECT a.id AS assignment_id, a.draw_id, a.draw_order,
                a.prize_name_snapshot, a.prize_description_snapshot, a.prize_unit_index,
                a.entry_id, p.first_name, p.last_name, p.email
         FROM draw_assignments a
         JOIN event_entries e ON e.id = a.entry_id
         JOIN participants p ON p.id = e.participant_id
         WHERE a.draw_id = ? AND a.event_id = ?
         ORDER BY a.draw_order ASC, a.id ASC`,
      )
      .bind(drawId, eventId)
      .all<{
        assignment_id: string;
        draw_id: string;
        draw_order: number;
        prize_name_snapshot: string;
        prize_description_snapshot: string | null;
        prize_unit_index: number;
        entry_id: string;
        first_name: string;
        last_name: string;
        email: string;
      }>();

    return (rows.results ?? []).map((row) => ({
      assignmentId: row.assignment_id,
      drawId: row.draw_id,
      drawOrder: Number(row.draw_order),
      prizeNameSnapshot: row.prize_name_snapshot,
      prizeDescriptionSnapshot: row.prize_description_snapshot,
      prizeUnitIndex: Number(row.prize_unit_index),
      entryId: row.entry_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
    }));
  }

  /** The administrative projection of one assignment set. */
  toAdminAssignments(rows: readonly PublishableAssignment[]): AdminResultAssignment[] {
    return rows.map((row) => ({
      drawOrder: row.drawOrder,
      prize: {
        nameSnapshot: row.prizeNameSnapshot,
        descriptionSnapshot: row.prizeDescriptionSnapshot,
        unitIndex: row.prizeUnitIndex,
      },
      winner: {
        entryId: row.entryId,
        firstName: row.firstName,
        lastName: row.lastName,
        email: row.email,
      },
    }));
  }

  /** Whether any publication depends on this event. Blocks physical deletion. */
  async hasPublicationsForEvent(eventId: string): Promise<boolean> {
    return this.hasPublication(eventId);
  }

  // -------------------------------------------------------------------------
  // Writes — INSERT ONLY
  // -------------------------------------------------------------------------

  insertPublicationStatement(values: PublicationInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO result_publications
           (id, event_id, draw_id, published_at, published_by_admin_id,
            request_id, winner_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.eventId,
        values.drawId,
        values.publishedAt,
        values.publishedByAdminId,
        values.requestId,
        values.winnerCount,
        values.publishedAt,
      );
  }

  /**
   * One statement per announced winner.
   *
   * Bounded by `DRAW_ASSIGNMENTS_MAX`, which phase 11 already applies to the
   * draw itself — a publication can never have more items than the draw it
   * copies, so the batch here is bounded by the same ceiling without needing a
   * second one.
   */
  insertPublicationItemStatements(
    rows: readonly PublicationItemInsertValues[],
  ): D1PreparedStatement[] {
    return rows.map((row) =>
      this.db
        .prepare(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot,
              prize_description_snapshot, prize_unit_index, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.publicationId,
          row.drawId,
          row.assignmentId,
          row.drawOrder,
          row.winnerDisplayNameSnapshot,
          row.prizeNameSnapshot,
          row.prizeDescriptionSnapshot,
          row.prizeUnitIndex,
          row.createdAt,
        ),
    );
  }
}
