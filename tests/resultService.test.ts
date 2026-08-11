// @vitest-environment node
//
// Publishing and archiving against real SQL: the real migrations, the real
// unique indexes, the real batch.
//
// The property every test here circles: A PUBLICATION IS A COPY TAKEN AT ONE
// INSTANT. Nothing edited afterwards — a participant's name, a prize's name,
// the event's own state — may reach back and change what was announced.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResultsService } from '../functions/_shared/resultsService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { setLogSink } from '../functions/_shared/logger';
import { formatPublicWinnerName } from '../shared/resultLifecycle';
import {
  archive,
  createResultHarness,
  resultActor,
  seedDrawnEvent,
  seedPublishedEvent,
  type ResultHarness,
} from './helpers/resultFlow';

let harness: ResultHarness;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createResultHarness();
});
afterEach(() => {
  setLogSink(null);
  harness.close();
});

const actor = () => resultActor(harness);
const count = (sql: string) => (harness.db.raw.prepare(sql).get() as { n: number }).n;

// ---------------------------------------------------------------------------
describe('the administrative view', () => {
  it('reports nothing before a draw', async () => {
    const { event } = await seedDrawnEvent(harness);
    harness.db.raw.exec('DELETE FROM draw_assignments');
    harness.db.raw.exec('DELETE FROM draws');
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_READY' WHERE id = ?")
      .run(event.id);

    const result = await harness.results.loadAdminResults(event.id);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.draw).toBeNull();
    expect(result.value.assignments).toEqual([]);
    expect(result.value.publication).toBeNull();
    expect(result.value.publicationState).toBe('UNPUBLISHED');
    expect(result.value.canPublish).toBe(false);
    expect(result.value.publishBlocker).toBe('EVENT_NOT_DRAWN');
  });

  it('reports the draw and its winners once it has run', async () => {
    const { event, draw } = await seedDrawnEvent(harness, { participants: 6, prizes: [2, 1] });

    const result = await harness.results.loadAdminResults(event.id);
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.eventStatus).toBe('DRAW_COMPLETED');
    expect(result.value.draw?.id).toBe(draw.id);
    expect(result.value.assignments).toHaveLength(3);
    expect(result.value.publication).toBeNull();
    expect(result.value.canPublish).toBe(true);
    expect(result.value.canArchive).toBe(true);
    expect(result.value.archivingWouldDiscardResults).toBe(true);
  });

  it('counts unassigned units from the DRAW, not from today’s prizes', async () => {
    const { event, prizes } = await seedDrawnEvent(harness, { participants: 2, prizes: [5] });

    // Somebody edits the prize table afterwards. The historical arithmetic must
    // not move: five units were on offer and two were won, whatever the prize
    // says now.
    harness.db.raw.prepare('UPDATE event_prizes SET quantity = 99 WHERE id = ?').run(prizes[0].id);

    const result = await harness.results.loadAdminResults(event.id);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.draw?.prizeUnitCount).toBe(5);
    expect(result.value.draw?.assignmentCount).toBe(2);
    expect(result.value.unassignedUnitCount).toBe(3);
  });

  it('carries what an operator needs and nothing that explains a verdict', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });
    const result = await harness.results.loadAdminResults(event.id);
    if (!result.ok) throw new Error('unreachable');

    const serialized = JSON.stringify(result.value);
    expect(result.value.assignments[0].winner.email).toContain('@');
    for (const forbidden of [
      'dateOfBirth',
      'calculatedAge',
      'ageEligible',
      'eligibilityReason',
      'phone',
      'answers',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('fails closed when an assignment has gone missing', async () => {
    // The lesson phase 11's validation left: a read that silently returns fewer
    // rows than the record claims presents an incomplete result as the result.
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [3] });
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM draw_assignments WHERE draw_order = 1');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.results.loadAdminResults(event.id)).rejects.toThrow(/assignments/i);
  });
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  it('creates one publication with one item per winner', async () => {
    const { event, draw } = await seedDrawnEvent(harness, { participants: 6, prizes: [3] });

    const result = await harness.results.publish(event.id, actor());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    expect(result.value.created).toBe(true);
    expect(result.value.results.publication?.winnerCount).toBe(3);
    expect(result.value.results.publicationState).toBe('PUBLISHED');
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items')).toBe(3);

    // The three numbers that must always agree.
    const publication = harness.db.raw
      .prepare('SELECT winner_count AS n FROM result_publications')
      .get() as { n: number };
    expect(publication.n).toBe(draw.assignmentCount);
  });

  it('writes exactly one audit row, naming who published', async () => {
    const { event } = await seedDrawnEvent(harness);
    const result = await harness.results.publish(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    const rows = harness.db.raw
      .prepare(
        `SELECT entity_type, entity_id, actor_admin_id, new_data
           FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'`,
      )
      .all() as Array<Record<string, string>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('RESULT_PUBLICATION');
    expect(rows[0].entity_id).toBe(result.value.results.publication?.id);
    expect(rows[0].actor_admin_id).toBe(harness.admin.id);
    expect(JSON.parse(rows[0].new_data).winnerCount).toBe(2);
  });

  it('records no names in the audit, not even abbreviated ones', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });

    const row = harness.db.raw
      .prepare(
        `SELECT previous_data, new_data, metadata FROM audit_logs
          WHERE action = 'EVENT_RESULTS_PUBLISHED'`,
      )
      .get() as Record<string, string | null>;
    const serialized = Object.values(row).join('');

    for (const leak of ['Person', '@example.com', 'Test']) {
      expect(serialized, leak).not.toContain(leak);
    }
    expect(serialized).toContain('winnerCount');
    void event;
  });

  it('computes each public name once, with the shared formatter', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });

    const names = (
      harness.db.raw
        .prepare(
          `SELECT winner_display_name_snapshot AS name FROM result_publication_items
            ORDER BY draw_order ASC`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    // The fixture registers "Person0 Test", "Person1 Test"...
    for (const name of names) expect(name).toMatch(/^Person\d T\.$/);
    expect(names[0]).toBe(
      formatPublicWinnerName({ firstName: names[0].split(' ')[0], lastName: 'Test' }),
    );
    void event;
  });

  it('copies the prize name from the ASSIGNMENT, not from the prize table', async () => {
    const { event, prizes } = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });

    // Renaming before publication proves the source. If the publication read
    // `event_prizes`, this new name would appear in it.
    harness.db.raw
      .prepare('UPDATE event_prizes SET name = ? WHERE id = ?')
      .run('Renamed before publishing', prizes[0].id);

    await harness.results.publish(event.id, actor());

    const stored = (
      harness.db.raw
        .prepare('SELECT prize_name_snapshot AS name FROM result_publication_items')
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(new Set(stored)).toEqual(new Set(['Prize 1']));
  });

  it('refuses an event that has not been drawn', async () => {
    const { event } = await seedDrawnEvent(harness);
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM draw_assignments');
    harness.db.raw.exec('DELETE FROM draws');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');
    harness.db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    const result = await harness.results.publish(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'RESULTS_NOT_PUBLISHABLE') {
      expect(result.failure.blocker).toBe('EVENT_NOT_DRAWN');
    }
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(0);
  });

  it('the schema will not let a participant have a blank name in the first place', async () => {
    // Worth stating, because it is why the guard below has to be exercised
    // through a stub: `participants.last_name` carries a non-blank CHECK, so
    // the condition cannot be created by editing the table.
    const { entryIds } = await seedDrawnEvent(harness, { participants: 2 });
    const participantId = (
      harness.db.raw
        .prepare('SELECT participant_id AS id FROM event_entries WHERE id = ?')
        .get(entryIds[0]) as { id: string }
    ).id;

    expect(() =>
      harness.db.raw
        .prepare("UPDATE participants SET last_name = ' ' WHERE id = ?")
        .run(participantId),
    ).toThrow(/CHECK/i);
  });

  it('refuses a winner whose name cannot be formatted, and writes nothing', async () => {
    // A publication is permanent; a placeholder inside one would be permanent
    // too. Better to refuse and let somebody fix the row.
    //
    // The unformattable name is injected at the repository seam because the
    // schema forbids it in the table — so this asserts what the SERVICE does
    // when the formatter declines, which is the part that could be got wrong.
    const { event } = await seedDrawnEvent(harness, { participants: 3, prizes: [3] });
    const { ResultRepository } = await import('../functions/_shared/resultRepository');
    const real = new ResultRepository(harness.db.d1);

    const blanking = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      loadPublishableAssignments: async (eventId: string, drawId: string) => {
        const rows = await real.loadPublishableAssignments(eventId, drawId);
        return rows.map((row, index) => (index === 1 ? { ...row, lastName: '  ' } : row));
      },
    });

    const result = await new ResultsService(harness.db.d1, { results: blanking }).publish(
      event.id,
      actor(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'RESULTS_CONFLICT') {
      expect(result.failure.reason).toBe('winner_name_unavailable');
    }
    // Not a partial publication with two of the three winners in it.
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items')).toBe(0);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'`),
    ).toBe(0);
  });

  it('leaves the draw untouched', async () => {
    const { event, draw } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });
    const before = harness.db.raw
      .prepare('SELECT * FROM draw_assignments ORDER BY draw_order')
      .all();

    await harness.results.publish(event.id, actor());

    const after = harness.db.raw
      .prepare('SELECT * FROM draw_assignments ORDER BY draw_order')
      .all();
    expect(after).toEqual(before);
    const drawRow = harness.db.raw
      .prepare('SELECT assignment_count AS n FROM draws WHERE id = ?')
      .get(draw.id) as { n: number };
    expect(drawRow.n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('a publication is a copy, taken once', () => {
  it('does not change when a participant corrects their name', async () => {
    const { event, entryIds } = await seedPublishedEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    const before = await harness.results.loadPublicResults(event.slug);
    if (!before.ok) throw new Error('unreachable');

    const participantId = (
      harness.db.raw
        .prepare('SELECT participant_id AS id FROM event_entries WHERE id = ?')
        .get(entryIds[0]) as { id: string }
    ).id;
    harness.db.raw.exec('DROP TRIGGER IF EXISTS trg_participants_immutable_identity');
    harness.db.raw
      .prepare("UPDATE participants SET first_name = 'Renamed', last_name = 'Entirely' WHERE id = ?")
      .run(participantId);

    const after = await harness.results.loadPublicResults(event.slug);
    if (!after.ok) throw new Error('unreachable');
    expect(after.value).toEqual(before.value);
    expect(JSON.stringify(after.value)).not.toContain('Renamed');
  });

  it('does not change when a prize is renamed', async () => {
    const { event, prizes } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const before = await harness.results.loadPublicResults(event.slug);
    if (!before.ok) throw new Error('unreachable');

    harness.db.raw
      .prepare('UPDATE event_prizes SET name = ?, description = ? WHERE id = ?')
      .run('Renamed a year later', 'Rewritten', prizes[0].id);

    const after = await harness.results.loadPublicResults(event.slug);
    if (!after.ok) throw new Error('unreachable');
    expect(after.value).toEqual(before.value);
    expect(JSON.stringify(after.value)).not.toContain('Renamed a year later');
  });
});

// ---------------------------------------------------------------------------
describe('publishing is idempotent', () => {
  it('answers a retry with the same publication', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });

    const first = await harness.results.publish(event.id, actor());
    if (!first.ok) throw new Error('unreachable');
    const second = await harness.results.publish(event.id, actor());
    const third = await harness.results.publish(event.id, actor());

    expect(second.ok && second.value.created).toBe(false);
    expect(third.ok && third.value.created).toBe(false);
    if (second.ok) {
      expect(second.value.results.publication?.id).toBe(first.value.results.publication?.id);
      // The INSTANT is part of the record, and a retry must not move it.
      expect(second.value.results.publication?.publishedAt).toBe(
        first.value.results.publication?.publishedAt,
      );
    }

    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items')).toBe(3);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'`),
    ).toBe(1);
  });

  it('does not rebuild the public names on a retry', async () => {
    const { event, entryIds } = await seedPublishedEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    const before = harness.db.raw
      .prepare('SELECT id, winner_display_name_snapshot FROM result_publication_items ORDER BY id')
      .all();

    // A name change between the two attempts must not appear in the second.
    const participantId = (
      harness.db.raw
        .prepare('SELECT participant_id AS id FROM event_entries WHERE id = ?')
        .get(entryIds[0]) as { id: string }
    ).id;
    harness.db.raw.exec('DROP TRIGGER IF EXISTS trg_participants_immutable_identity');
    harness.db.raw
      .prepare("UPDATE participants SET last_name = 'Zzz' WHERE id = ?")
      .run(participantId);

    await harness.results.publish(event.id, actor());

    const after = harness.db.raw
      .prepare('SELECT id, winner_display_name_snapshot FROM result_publication_items ORDER BY id')
      .all();
    expect(after).toEqual(before);
  });

  it('commits exactly one publication across concurrent attempts', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 8, prizes: [3] });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => harness.results.publish(event.id, actor())),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);

    const ids = results.map((r) => (r.ok ? r.value.results.publication?.id : 'FAILED'));
    expect(new Set(ids).size, 'every caller must converge on one publication').toBe(1);

    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items')).toBe(3);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'`),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the public read', () => {
  it('is unavailable before publication, whatever has happened privately', async () => {
    // A slug nobody has used, an event that was never drawn and an event drawn
    // but unpublished must be indistinguishable — otherwise this endpoint tells
    // anybody who asks whether a private draw has happened.
    const drawn = await seedDrawnEvent(harness);
    const unknown = await harness.results.loadPublicResults('no-such-event-anywhere');
    const private_ = await harness.results.loadPublicResults(drawn.event.slug);

    expect(unknown.ok).toBe(false);
    expect(private_.ok).toBe(false);
    if (!unknown.ok && !private_.ok) {
      expect(private_.failure).toEqual(unknown.failure);
      expect(private_.failure.code).toBe('RESULTS_NOT_AVAILABLE');
    }
  });

  it('returns the winners in draw order once published', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 6, prizes: [3] });

    const result = await harness.results.loadPublicResults(event.slug);
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.event).toEqual({ slug: event.slug, name: event.name });
    expect(result.value.results.winners).toHaveLength(3);

    const admin = await harness.results.loadAdminResults(event.id);
    if (!admin.ok) throw new Error('unreachable');
    // Same order as the draw, position for position.
    expect(result.value.results.winners.map((w) => w.prizeName)).toEqual(
      admin.value.assignments.map((a) => a.prize.nameSnapshot),
    );
  });

  it('carries no identifier, no email and no full surname', async () => {
    const { event, entryIds, draw } = await seedPublishedEvent(harness, {
      participants: 4,
      prizes: [2],
    });
    const result = await harness.results.loadPublicResults(event.slug);
    if (!result.ok) throw new Error('unreachable');

    const serialized = JSON.stringify(result.value);
    for (const leak of [
      ...entryIds,
      draw.id,
      draw.candidateSetHash,
      draw.algorithmVersion,
      '@example.com',
      'email',
      'entryId',
      'assignmentId',
      'participantId',
      'candidateCount',
      'dateOfBirth',
      'phone',
    ]) {
      expect(serialized, `public results leaked ${leak}`).not.toContain(leak);
    }
    // The surname survives only as an initial.
    expect(serialized).not.toContain('"Test"');
    for (const winner of result.value.results.winners) {
      expect(winner.displayName).toMatch(/^Person\d T\.$/);
    }
  });

  it('fails closed when the items no longer match the record', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [3] });
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM result_publication_items WHERE draw_order = 1');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.results.loadPublicResults(event.slug)).rejects.toThrow(/winners/i);
  });
});

// ---------------------------------------------------------------------------
describe('archiving', () => {
  it('is permitted with a publication, and the results stay public', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });
    const before = await harness.results.loadPublicResults(event.slug);

    await archive(harness, event.id);

    const after = await harness.results.loadPublicResults(event.slug);
    expect(after.ok).toBe(true);
    if (after.ok && before.ok) expect(after.value).toEqual(before.value);
    expect(
      (await new EventRepository(harness.db.d1).findById(event.id))?.status,
    ).toBe('ARCHIVED');
  });

  it('is permitted without one, and the results stay private forever', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });
    await archive(harness, event.id);

    // The door is closed in both directions: nothing to see, and no way to
    // publish it now.
    const publicRead = await harness.results.loadPublicResults(event.slug);
    expect(publicRead.ok).toBe(false);

    const attempt = await harness.results.publish(event.id, actor());
    expect(attempt.ok).toBe(false);
    if (!attempt.ok && attempt.failure.code === 'RESULTS_NOT_PUBLISHABLE') {
      expect(attempt.failure.blocker).toBe('EVENT_ARCHIVED');
    }
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(0);
  });

  it('keeps the administrative history readable afterwards', async () => {
    const { event, draw } = await seedPublishedEvent(harness, { participants: 5, prizes: [3] });
    const before = await harness.results.loadAdminResults(event.id);
    await archive(harness, event.id);
    const after = await harness.results.loadAdminResults(event.id);

    if (!before.ok || !after.ok) throw new Error('unreachable');
    expect(after.value.draw?.id).toBe(draw.id);
    expect(after.value.assignments).toEqual(before.value.assignments);
    expect(after.value.publication).toEqual(before.value.publication);
    expect(after.value.eventStatus).toBe('ARCHIVED');
    expect(after.value.canArchive).toBe(false);
    expect(after.value.canPublish).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('publish against archive', () => {
  it('refuses a publication that loses the race to an archive', async () => {
    // The interleaving forced deterministically: the event is archived while
    // the publication batch is in flight. There must be no outcome in which an
    // archived event acquires a publication.
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });

    let fired = false;
    const intercepted = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements: unknown[]) => {
          if (!fired) {
            fired = true;
            harness.db.raw
              .prepare(
                `UPDATE events SET status = 'ARCHIVED',
                    archived_at = '2026-01-01T00:00:00.000Z', revision = revision + 1
                  WHERE id = ?`,
              )
              .run(event.id);
          }
          return (
            target as unknown as { batch: (s: unknown[]) => Promise<unknown> }
          ).batch(statements);
        };
      },
    }) as D1Database;

    const result = await new ResultsService(intercepted).publish(event.id, actor());

    expect(fired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'RESULTS_NOT_PUBLISHABLE') {
      expect(result.failure.blocker).toBe('EVENT_ARCHIVED');
    }

    // Nothing at all: no publication, no items, no audit row.
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items')).toBe(0);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'`),
    ).toBe(0);
  });

  it('lets an archive that loses the race proceed anyway', async () => {
    // The other ordering. Publishing first is not a reason to refuse an
    // archive — the two are compatible, and the final state is an archived
    // event with public results.
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });
    await archive(harness, event.id);

    const result = await harness.results.loadAdminResults(event.id);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.eventStatus).toBe('ARCHIVED');
    expect(result.value.publicationState).toBe('PUBLISHED');
  });
});

// ---------------------------------------------------------------------------
describe('nothing published can be removed', () => {
  it('the database refuses to delete a publication’s draw or event', async () => {
    const { event, draw } = await seedPublishedEvent(harness);

    for (const sql of [
      `DELETE FROM draws WHERE id = '${draw.id}'`,
      `DELETE FROM events WHERE id = '${event.id}'`,
      `DELETE FROM draw_assignments`,
    ]) {
      expect(() => harness.db.raw.prepare(sql).run(), sql).toThrow(/FOREIGN KEY/i);
    }
  });

  it('the repository exposes no way to undo one', async () => {
    const { ResultRepository } = await import('../functions/_shared/resultRepository');
    const repo = new ResultRepository(harness.db.d1);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(
      methods.filter((m) => /delete|remove|update|unpublish|reset|withdraw/i.test(m)),
    ).toEqual([]);
  });
});
