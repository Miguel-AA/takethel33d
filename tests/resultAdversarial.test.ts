// @vitest-environment node
//
// Attacking the results.
//
// Two threats, not one. The first is the familiar administrative attacker:
// somebody with the button who wants to change what was published, or to
// publish something that was never drawn. The second is new to this phase and
// more important — an ANONYMOUS visitor who wants to learn more about the
// participants than the publication chose to reveal, or to find out whether a
// private draw has happened at all.
//
// Each block names the capability it is trying to obtain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResultsService } from '../functions/_shared/resultsService';
import { ResultRepository } from '../functions/_shared/resultRepository';
import { EventRepository } from '../functions/_shared/eventRepository';
import { setLogSink } from '../functions/_shared/logger';
import { publishResultsSchema } from '../shared/schemas';
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
describe('ATTACK: choose what the public is told', () => {
  it('there is no request field that names a winner or a name', () => {
    expect(publishResultsSchema.safeParse({}).success).toBe(true);
    for (const attempt of [
      { winnerNames: ['Chosen C.'] },
      { displayNames: { x: 'Chosen C.' } },
      { winners: ['entry-1'] },
      { assignmentIds: ['a1'] },
      { prizeNames: ['Something better'] },
      { drawId: 'another-draw' },
      { publishedAt: '2020-01-01T00:00:00.000Z' },
      { winnerCount: 99 },
    ]) {
      expect(publishResultsSchema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(
        false,
      );
    }
  });

  it('the public name is derived, never supplied', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const stored = (
      harness.db.raw
        .prepare('SELECT winner_display_name_snapshot AS name FROM result_publication_items')
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    // Every stored name is the formatter's output for a real participant.
    for (const name of stored) expect(name).toMatch(/^Person\d T\.$/);
    void event;
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: rewrite history after the fact', () => {
  it('the service exposes no way to unpublish', () => {
    const service = new ResultsService(harness.db.d1);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
    expect(
      methods.filter((m) => /unpublish|withdraw|retract|delete|reset|update/i.test(m)),
    ).toEqual([]);
  });

  it('the database refuses to delete a publication or its items', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const publicationId = (
      harness.db.raw.prepare('SELECT id FROM result_publications').get() as { id: string }
    ).id;

    // The items hold the publication in place, and both hold the draw.
    expect(() =>
      harness.db.raw.prepare('DELETE FROM result_publications WHERE id = ?').run(publicationId),
    ).toThrow(/FOREIGN KEY/i);
    void event;
  });

  it('cannot be re-run to produce different names', async () => {
    const { event, entryIds } = await seedPublishedEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    const before = harness.db.raw
      .prepare('SELECT winner_display_name_snapshot AS n FROM result_publication_items ORDER BY n')
      .all();

    // Rename everybody and publish again. The replay returns the record and
    // touches nothing.
    const participantIds = entryIds.map(
      (entryId) =>
        (
          harness.db.raw
            .prepare('SELECT participant_id AS id FROM event_entries WHERE id = ?')
            .get(entryId) as { id: string }
        ).id,
    );
    for (const participantId of participantIds) {
      harness.db.raw
        .prepare("UPDATE participants SET first_name = 'Zed', last_name = 'Zulu' WHERE id = ?")
        .run(participantId);
    }

    await harness.results.publish(event.id, actor());

    const after = harness.db.raw
      .prepare('SELECT winner_display_name_snapshot AS n FROM result_publication_items ORDER BY n')
      .all();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('Zed');
  });

  it('cannot be unlocked by putting the event back to DRAW_COMPLETED', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const first = harness.db.raw.prepare('SELECT id, published_at FROM result_publications').get();

    // A row edited outside the application. The status column is not what
    // guarantees uniqueness; the publication row is.
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_COMPLETED', archived_at = NULL WHERE id = ?")
      .run(event.id);

    const again = await harness.results.publish(event.id, actor());
    expect(again.ok && again.value.created).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(1);
    expect(
      harness.db.raw.prepare('SELECT id, published_at FROM result_publications').get(),
    ).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: publish something that was not drawn', () => {
  it('refuses every state except DRAW_COMPLETED', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });

    for (const status of ['OPEN', 'CLOSED', 'DRAW_READY', 'CANCELLED', 'ARCHIVED']) {
      harness.db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
      const result = await harness.results.publish(event.id, actor());
      expect(result.ok, `publishing from ${status}`).toBe(false);
    }
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(0);
  });

  it('refuses an event whose draw belongs to somebody else', async () => {
    const a = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });
    const b = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });
    const drawB = (
      harness.db.raw
        .prepare('SELECT id FROM draws WHERE event_id = ?')
        .get(b.event.id) as { id: string }
    ).id;

    // Event A's publication naming event B's draw. Every reference exists; only
    // their agreement is wrong, which is what the composite key sees.
    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO result_publications
             (id, event_id, draw_id, published_at, winner_count, created_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), a.event.id, drawB),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses an item whose assignment belongs to another draw', async () => {
    const a = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const b = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });

    const publication = harness.db.raw
      .prepare('SELECT id, draw_id FROM result_publications WHERE event_id = ?')
      .get(a.event.id) as { id: string; draw_id: string };
    const foreignAssignment = (
      harness.db.raw
        .prepare('SELECT id FROM draw_assignments WHERE event_id = ? LIMIT 1')
        .get(b.event.id) as { id: string }
    ).id;

    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES (?, ?, ?, ?, 99, 'Forged F.', 'Forged', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), publication.id, publication.draw_id, foreignAssignment),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: learn something the publication did not reveal', () => {
  it('the public projection never carries an email or a full surname', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 5, prizes: [3] });
    const result = await harness.results.loadPublicResults(event.slug);
    if (!result.ok) throw new Error('unreachable');

    const body = JSON.stringify(result.value);
    expect(body).not.toContain('@');
    expect(body).not.toContain('Test');
    for (const winner of result.value.results.winners) {
      expect(Object.keys(winner).sort()).toEqual([
        'displayName',
        'prizeDescription',
        'prizeName',
        'prizeUnitIndex',
      ]);
    }
  });

  it('cannot be made to leak by adding a column to the stored item', async () => {
    // The projection names its fields rather than spreading, so a column added
    // to `result_publication_items` later cannot travel to the public page.
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    harness.db.raw.exec(
      "ALTER TABLE result_publication_items ADD COLUMN secret_email TEXT DEFAULT 'leak@example.com'",
    );

    const result = await harness.results.loadPublicResults(event.slug);
    if (!result.ok) throw new Error('unreachable');
    expect(JSON.stringify(result.value)).not.toContain('leak@example.com');
    expect(JSON.stringify(result.value)).not.toContain('secret_email');
  });

  it('does not reveal whether a private draw has happened', async () => {
    // The oracle this endpoint must not become. Three very different situations
    // must be indistinguishable from outside.
    const drawn = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });
    const undrawn = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.prepare('DELETE FROM draw_assignments WHERE event_id = ?').run(undrawn.event.id);
    harness.db.raw.prepare('DELETE FROM draws WHERE event_id = ?').run(undrawn.event.id);
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    const answers = await Promise.all([
      harness.results.loadPublicResults(drawn.event.slug),
      harness.results.loadPublicResults(undrawn.event.slug),
      harness.results.loadPublicResults('never-existed-at-all'),
      harness.results.loadPublicResults('NOT..A..SLUG'),
    ]);

    const serialized = answers.map((answer) => JSON.stringify(answer));
    expect(new Set(serialized).size, 'every refusal must be identical').toBe(1);
  });

  it('does not reveal an archived unpublished event either', async () => {
    const drawn = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });
    await archive(harness, drawn.event.id);

    const archivedAnswer = await harness.results.loadPublicResults(drawn.event.slug);
    const unknownAnswer = await harness.results.loadPublicResults('never-existed-at-all');
    expect(JSON.stringify(archivedAnswer)).toBe(JSON.stringify(unknownAnswer));
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: present a partial result as the result', () => {
  it('a publication missing an item fails closed', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [3] });
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM result_publication_items WHERE draw_order = 1');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.results.loadPublicResults(event.slug)).rejects.toThrow(/winners/i);
    await expect(harness.results.loadAdminResults(event.id)).rejects.toThrow();
  });

  it('a publication claiming more winners than it announced fails closed', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });
    harness.db.raw.exec('UPDATE result_publications SET winner_count = 5');

    await expect(harness.results.loadPublicResults(event.slug)).rejects.toThrow(/winners/i);
  });

  it('the repository refuses to read a count it was not given', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const repo = new ResultRepository(harness.db.d1);
    const publication = await repo.findPublicationByEvent(event.id);
    if (!publication) throw new Error('unreachable');

    // The expected count AND the expected draw are required arguments,
    // precisely so a caller cannot read the rows and trust whatever came back.
    await expect(
      repo.loadPublicationItems(publication.id, 99, publication.drawId),
    ).rejects.toThrow(/winners/i);
    await expect(
      repo.loadPublicationItems(publication.id, publication.winnerCount, 'another-draw'),
    ).rejects.toThrow(/item from draw/i);
    await expect(
      repo.loadPublicationItems(publication.id, publication.winnerCount, publication.drawId),
    ).resolves.toHaveLength(publication.winnerCount);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: change the draw through the results', () => {
  it('nothing in this phase writes to the draw tables', async () => {
    // A source-level assertion, because it is the one guarantee that cannot be
    // observed from behaviour alone: an UPDATE that never runs looks exactly
    // like one that does not exist.
    const files = [
      '../functions/_shared/resultsService',
      '../functions/_shared/resultRepository',
    ];
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const file of files) {
      const full = path.resolve(
        process.cwd(),
        `${file.replace('../', '')}.ts`,
      );
      const source = fs.readFileSync(full, 'utf8');
      for (const forbidden of [
        'UPDATE draws',
        'DELETE FROM draws',
        'UPDATE draw_assignments',
        'DELETE FROM draw_assignments',
        'UPDATE participants',
        'UPDATE event_prizes',
      ]) {
        expect(source, `${file} contains ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('publishing leaves every draw row byte-for-byte identical', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });
    const before = {
      draws: harness.db.raw.prepare('SELECT * FROM draws').all(),
      assignments: harness.db.raw.prepare('SELECT * FROM draw_assignments ORDER BY id').all(),
      entries: harness.db.raw.prepare('SELECT * FROM event_entries ORDER BY id').all(),
      prizes: harness.db.raw.prepare('SELECT * FROM event_prizes ORDER BY id').all(),
    };

    await harness.results.publish(event.id, actor());
    await archive(harness, event.id);

    expect(harness.db.raw.prepare('SELECT * FROM draws').all()).toEqual(before.draws);
    expect(harness.db.raw.prepare('SELECT * FROM draw_assignments ORDER BY id').all()).toEqual(
      before.assignments,
    );
    expect(harness.db.raw.prepare('SELECT * FROM event_entries ORDER BY id').all()).toEqual(
      before.entries,
    );
    expect(harness.db.raw.prepare('SELECT * FROM event_prizes ORDER BY id').all()).toEqual(
      before.prizes,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: reopen a closed event', () => {
  it('archiving is terminal in the lifecycle table', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    await archive(harness, event.id);

    for (const action of ['publish', 'open', 'close', 'mark-draw-ready', 'cancel', 'archive']) {
      const result = await harness.events.transition(
        event.id,
        action as never,
        actor() as never,
      );
      expect(result.ok, `${action} from ARCHIVED`).toBe(false);
    }
    expect(
      (await new EventRepository(harness.db.d1).findById(event.id))?.status,
    ).toBe('ARCHIVED');
  });

  it('a second archive writes no second audit row', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    await archive(harness, event.id);
    const attempt = await harness.events.transition(event.id, 'archive', actor() as never);

    expect(attempt.ok).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ARCHIVED'`)).toBe(1);
  });

  it('concurrent archives produce exactly one transition', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        harness.events.transition(event.id, 'archive', actor() as never),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ARCHIVED'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: announce a different number of winners than were drawn', () => {
  it('refuses a publication that is internally consistent but disagrees with its draw', async () => {
    // The subtle one. The publication says two winners and has two items, so
    // every count inside it agrees — and the draw it claims to copy made three
    // assignments. Without a check against the DRAW, this reads as a complete
    // result that quietly drops somebody.
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [3] });

    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM result_publication_items WHERE draw_order = 2');
    harness.db.raw.exec('UPDATE result_publications SET winner_count = 2');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    // Internally consistent: two items, winner_count two.
    const items = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM result_publication_items')
      .get() as { n: number };
    expect(items.n).toBe(2);

    await expect(harness.results.loadAdminResults(event.id)).rejects.toThrow(/announced/i);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: reorder what the public sees', () => {
  it('the public order is the DRAW order, not alphabetical', async () => {
    // Seeded so the two orders genuinely differ: the winner drawn first sorts
    // last by name. An implementation ordering by anything but `draw_order`
    // would present a different sequence — and the sequence is the only thing
    // that says which prize was drawn first.
    const { event } = await seedDrawnEvent(harness, { participants: 3, prizes: [3] });

    const assignments = harness.db.raw
      .prepare('SELECT entry_id, draw_order FROM draw_assignments ORDER BY draw_order ASC')
      .all() as Array<{ entry_id: string; draw_order: number }>;

    // Give the first-drawn winner a name that sorts last, and the last-drawn a
    // name that sorts first.
    const alphabet = ['Zoe', 'Mia', 'Ana'];
    assignments.forEach((assignment, index) => {
      const participantId = (
        harness.db.raw
          .prepare('SELECT participant_id AS id FROM event_entries WHERE id = ?')
          .get(assignment.entry_id) as { id: string }
      ).id;
      harness.db.raw
        .prepare('UPDATE participants SET first_name = ?, last_name = ? WHERE id = ?')
        .run(alphabet[index], 'Test', participantId);
    });

    await harness.results.publish(event.id, actor());
    const published = await harness.results.loadPublicResults(event.slug);
    if (!published.ok) throw new Error('unreachable');

    const names = published.value.results.winners.map((winner) => winner.displayName);
    expect(names).toEqual(['Zoe T.', 'Mia T.', 'Ana T.']);
    // ...which is deliberately NOT alphabetical.
    expect(names).not.toEqual([...names].sort());
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: smuggle a winner in from another draw', () => {
  it('is refused by the composite key, and by the read if the key is gone', async () => {
    const a = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const b = await seedDrawnEvent(harness, { participants: 3, prizes: [2] });

    const publication = harness.db.raw
      .prepare('SELECT id, draw_id FROM result_publications WHERE event_id = ?')
      .get(a.event.id) as { id: string; draw_id: string };
    const foreign = harness.db.raw
      .prepare('SELECT id, draw_id FROM draw_assignments WHERE event_id = ? LIMIT 1')
      .get(b.event.id) as { id: string; draw_id: string };

    const insert = (): void => {
      harness.db.raw
        .prepare(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES (?, ?, ?, ?, 99, 'Smuggled S.', 'Forged', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), publication.id, foreign.draw_id, foreign.id);
    };

    // First line: the composite foreign key refuses it outright.
    expect(insert).toThrow(/FOREIGN KEY/i);

    // Second line, and the one this test exists for. A database can lose its
    // constraints — a restore, a migration tool, a console session — and the
    // row then inserts cleanly. MEASURED BEFORE THE FIX: with `winner_count`
    // adjusted so the count agreed, the public page announced "Smuggled S." as
    // a winner of this event. The count check cannot see it; only the lineage
    // can.
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    insert();
    harness.db.raw
      .prepare('UPDATE result_publications SET winner_count = 3 WHERE id = ?')
      .run(publication.id);
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.results.loadPublicResults(a.event.slug)).rejects.toThrow(
      /item from draw/i,
    );
    // The administrative read also fails closed, one check earlier: it compares
    // the publication against the DRAW it copied, and three announced winners
    // for a two-assignment draw is already impossible before the lineage of any
    // individual row is examined.
    await expect(harness.results.loadAdminResults(a.event.id)).rejects.toThrow(
      /announced 3 winners for a draw of 2/i,
    );
  });

  it('refuses a publication whose items announce one winner twice', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const publication = harness.db.raw
      .prepare('SELECT id, draw_id FROM result_publications')
      .get() as { id: string; draw_id: string };
    const assignment = harness.db.raw
      .prepare('SELECT assignment_id FROM result_publication_items LIMIT 1')
      .get() as { assignment_id: string };

    // The unique index refuses this outright, so the scenario needs a database
    // that has lost it — which is exactly the condition the check exists for.
    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO result_publication_items
             (id, publication_id, draw_id, assignment_id, draw_order,
              winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
           VALUES (?, ?, ?, ?, 77, 'Doubled D.', 'Vape', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), publication.id, publication.draw_id, assignment.assignment_id),
    ).toThrow(/UNIQUE/i);

    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DROP INDEX ux_result_items_assignment');
    harness.db.raw
      .prepare(
        `INSERT INTO result_publication_items
           (id, publication_id, draw_id, assignment_id, draw_order,
            winner_display_name_snapshot, prize_name_snapshot, prize_unit_index, created_at)
         VALUES (?, ?, ?, ?, 77, 'Doubled D.', 'Vape', 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run(crypto.randomUUID(), publication.id, publication.draw_id, assignment.assignment_id);
    harness.db.raw
      .prepare('UPDATE result_publications SET winner_count = 3 WHERE id = ?')
      .run(publication.id);
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.results.loadPublicResults(event.slug)).rejects.toThrow(
      /one winner twice/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: read a publication mid-commit', () => {
  it('sees nothing until every winner is there', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });
    const observations: boolean[] = [];

    const intercepted = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements: unknown[]) => {
          // Read from OUTSIDE the transaction, immediately before it commits.
          const midFlight = await new ResultsService(harness.db.d1).loadPublicResults(
            event.slug,
          );
          observations.push(midFlight.ok);
          return (
            target as unknown as { batch: (s: unknown[]) => Promise<unknown> }
          ).batch(statements);
        };
      },
    }) as D1Database;

    await new ResultsService(intercepted).publish(event.id, actor());

    // Never a subset: unavailable, then complete.
    expect(observations).toEqual([false]);
    const after = await harness.results.loadPublicResults(event.slug);
    expect(after.ok && after.value.results.winners).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: reach a live identity or prize through the public page', () => {
  it('the public read queries neither participants nor prizes nor assignments', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });

    const seen: string[] = [];
    const recording = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (query: string) => {
          seen.push(query.toLowerCase());
          return (target as unknown as { prepare: (q: string) => unknown }).prepare(query);
        };
      },
    }) as D1Database;

    const result = await new ResultsService(recording).loadPublicResults(event.slug);
    expect(result.ok).toBe(true);

    // The strongest statement of "the snapshot is the authority": the tables
    // that could disagree with it are never consulted at all.
    const sql = seen.join('\n');
    expect(sql, 'public read touched participants').not.toContain('participants');
    expect(sql, 'public read touched event_prizes').not.toContain('event_prizes');
    expect(sql, 'public read touched draw_assignments').not.toContain('draw_assignments');
  });

  it('a retry re-derives nothing', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });
    await harness.results.publish(event.id, actor());

    const seen: string[] = [];
    const recording = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (query: string) => {
          seen.push(query.toLowerCase());
          return (target as unknown as { prepare: (q: string) => unknown }).prepare(query);
        };
      },
    }) as D1Database;

    const retry = await new ResultsService(recording).publish(event.id, actor());
    expect(retry.ok && retry.value.created).toBe(false);

    const sql = seen.join('\n');
    expect(sql, 'a retry wrote something').not.toMatch(/insert into result_/);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: leave half a publication behind', () => {
  it.each([
    ['the publication row', 1],
    ['the first item', 2],
    ['a middle item', 3],
    ['the last item', 4],
    ['the audit row', 5],
  ])('rolls everything back when %s fails', async (_label, position) => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });

    // One statement in the batch is replaced with a guaranteed transactional
    // failure — writing NULL into a NOT NULL column — at each position in turn.
    const sabotaged = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements) => {
          const broken = target
            .prepare('UPDATE events SET status = NULL WHERE id = ?')
            .bind(event.id);
          const next = [...statements];
          if (position < next.length) next[position] = broken;
          else next.push(broken);
          return target.batch(next);
        };
      },
    });

    const result = await new ResultsService(sabotaged).publish(event.id, actor());
    expect(result.ok).toBe(false);

    expect(count('SELECT COUNT(*) AS n FROM result_publications'), 'publication').toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM result_publication_items'), 'items').toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_RESULTS_PUBLISHED'"),
      'audit',
    ).toBe(0);
    // ...and the draw is exactly as it was.
    expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: archive without leaving a trace', () => {
  it('leaves the event alone when the audit row cannot be written', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });

    const sabotaged = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements) => {
          const next = [...statements];
          next[next.length - 1] = target
            .prepare('INSERT INTO audit_logs (id, action, entity_type) VALUES (NULL, NULL, NULL)')
            .bind();
          return target.batch(next);
        };
      },
    });

    const { EventLifecycleService } = await import('../functions/_shared/eventService');
    await new EventLifecycleService(sabotaged)
      .transition(event.id, 'archive', actor())
      .catch(() => undefined);

    // "Closed for good, with no record of who closed it" is precisely what the
    // audit table exists to prevent.
    const after = await new EventRepository(harness.db.d1).findById(event.id);
    expect(after?.status).toBe('DRAW_COMPLETED');
    expect(after?.archivedAt).toBeNull();
  });

  it('does not rewrite the moment or the revision on a second attempt', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    await archive(harness, event.id);

    const first = await new EventRepository(harness.db.d1).findById(event.id);
    await harness.events.transition(event.id, 'archive', actor());
    const second = await new EventRepository(harness.db.d1).findById(event.id);

    expect(second?.archivedAt).toBe(first?.archivedAt);
    expect(second?.revision).toBe(first?.revision);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: mutate an archived event through any other surface', () => {
  it('refuses participants, prizes, a new draw and a publication', async () => {
    const { event, entryIds, prizes } = await seedPublishedEvent(harness, {
      participants: 4,
      prizes: [2],
    });
    await archive(harness, event.id);

    const { ParticipantAdministrationService } = await import(
      '../functions/_shared/participantAdministrationService'
    );
    const disqualified = await new ParticipantAdministrationService(harness.db.d1).disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Trying it on after the event closed' },
      actor(),
    );
    expect(disqualified.ok, 'participants must be frozen').toBe(false);

    const { PrizeService } = await import('../functions/_shared/prizeService');
    const renamed = await new PrizeService(harness.db.d1).update(
      event.id,
      prizes[0].id,
      { expectedRevision: prizes[0].revision, name: 'Renamed after archiving' },
      actor(),
    );
    expect(renamed.ok, 'prizes must be frozen').toBe(false);

    // A draw POST replays the EXISTING draw — a read — and creates nothing.
    const drew = await harness.draws.run(event.id, actor());
    expect(drew.ok ? drew.value.created : true, 'no new draw after archiving').toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);

    const republished = await harness.results.publish(event.id, actor());
    expect(republished.ok && republished.value.created).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM result_publications')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: find personal data in the published schema', () => {
  it('there is no identifying column to find', () => {
    const columns = harness.db.raw
      .prepare('PRAGMA table_info(result_publication_items)')
      .all()
      .map((row) => row.name);

    for (const forbidden of [
      'email',
      'first_name',
      'last_name',
      'date_of_birth',
      'phone',
      'participant_id',
      'entry_id',
      'calculated_age',
      'eligibility_reason',
    ]) {
      expect(columns, `items carries ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('leaves the database referentially intact after a publication', async () => {
    await seedPublishedEvent(harness, { participants: 4, prizes: [2] });
    expect(harness.db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: rewrite the assignment the publication copied', () => {
  it('changes nothing about what was announced', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 3, prizes: [2] });
    const before = await harness.results.loadPublicResults(event.slug);

    // The publication is the PUBLIC authority. Even its own upstream snapshot
    // being tampered with must not move it.
    harness.db.raw.exec("UPDATE draw_assignments SET prize_name_snapshot = 'Tampered'");

    const after = await harness.results.loadPublicResults(event.slug);
    if (!before.ok || !after.ok) throw new Error('unreachable');
    expect(after.value).toEqual(before.value);
    expect(JSON.stringify(after.value)).not.toContain('Tampered');
  });
});
