// @vitest-environment node
//
// PrizeService and PrizeRepository against the real migrated schema, including
// the two-phase reorder, audit atomicity and concurrency.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrizeService } from '../functions/_shared/prizeService';
import { PrizeRepository, rowToEventPrize, type EventPrizeRow } from '../functions/_shared/prizeRepository';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import { eventAllows } from '../shared/prizeLifecycle';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type {
  AuthenticatedAdmin,
  Event,
  EventPrize,
  EventPrizeListQuery,
} from '../shared/types';

let db: TestDatabase;
let prizeService: PrizeService;
let prizeRepo: PrizeRepository;
let eventService: EventLifecycleService;
let admin: AuthenticatedAdmin;
let event: Event;

const REQUEST: RequestContext = {
  requestId: 'req-prizes',
  ipHash: 'c'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/prizes',
};

const BASE_QUERY: EventPrizeListQuery = {
  page: 1,
  pageSize: 100,
  status: null,
  archived: 'all',
  search: null,
  sort: 'sortOrder',
  direction: 'asc',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function auditRows() {
  return db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
}

function setEventStatus(status: string) {
  db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
}

async function addPrize(overrides: Record<string, unknown> = {}): Promise<EventPrize> {
  const result = await prizeService.create(
    event.id,
    { name: 'Vape', quantity: 1, ...overrides } as never,
    actor(),
  );
  if (!result.ok) throw new Error(`create failed: ${result.failure.code}`);
  return result.value;
}

/**
 * Gives an event a published form version.
 *
 * Since phase 6, `publish` and `open` require one: announcing an event means
 * people will be asked to fill something in. Inserted directly — the form
 * domain has its own suites, and this is only scaffolding.
 */
function seedPublishedForm(eventId: string): string {
  const existing = db.raw
    .prepare('SELECT id FROM event_form_versions WHERE event_id = ? LIMIT 1')
    .get(eventId) as { id: string } | undefined;
  if (existing) return existing.id;

  const now = new Date().toISOString();
  const versionId = crypto.randomUUID();
  const publisher = (
    db.raw.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }
  ).id;
  db.raw
    .prepare(
      `INSERT INTO event_form_versions
         (id, event_id, version_number, source_draft_revision, published_by,
          published_at, schema_snapshot, created_at)
       VALUES (?, ?, 1, 1, ?, ?, '{"snapshotVersion":1}', ?)`,
    )
    .run(versionId, eventId, publisher, now, now);
  // A published version must have structure: since phase 6 an event pointing at
  // an empty one counts as having no published form at all.
  const stepId = crypto.randomUUID();
  db.raw
    .prepare(
      `INSERT INTO form_steps
         (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
       VALUES (?, 'VERSION', ?, 'About you', 0, ?, ?)`,
    )
    .run(stepId, versionId, now, now);
  db.raw
    .prepare(
      `INSERT INTO form_questions
         (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
          label, required, sort_order, created_at, updated_at)
       VALUES (?, 'VERSION', ?, ?, 'email', 'EMAIL', 'EMAIL', 'Email', 1, 0, ?, ?)`,
    )
    .run(crypto.randomUUID(), versionId, stepId, now, now);

  db.raw
    .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
    .run(versionId, eventId);
  return versionId;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  prizeService = new PrizeService(db.d1);
  prizeRepo = new PrizeRepository(db.d1);
  eventService = new EventLifecycleService(db.d1);

  const created = await new AdminRepository(db.d1).create({
    email: 'ada@example.com',
    normalizedEmail: normalizeEmail('ada@example.com'),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword('a-strong-admin-password'),
  });
  if (created.kind !== 'created') throw new Error('admin seed failed');
  admin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionId: 'session-1',
  };

  const madeEvent = await eventService.create(
    {
      name: 'Grand Opening Smoke Shop',
      registrationOpensAt: at(1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    actor(),
  );
  if (!madeEvent.ok) throw new Error('event seed failed');
  event = madeEvent.value;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('create', () => {
  it('stores an ACTIVE prize at revision 1, appended to the end', async () => {
    const first = await addPrize({ name: 'Vape' });
    const second = await addPrize({ name: 'Grinder' });

    expect(first.status).toBe('ACTIVE');
    expect(first.revision).toBe(1);
    expect(first.sortOrder).toBe(0);
    expect(second.sortOrder).toBe(1);
    expect(first.createdBy).toBe(admin.id);
    expect(first.archivedAt).toBeNull();
  });

  it('writes the prize and its audit row in ONE transaction', async () => {
    const prize = await addPrize();
    const created = auditRows().filter((r) => r.action === 'PRIZE_CREATED');
    expect(created).toHaveLength(1);
    expect(created[0].entity_type).toBe('PRIZE');
    expect(created[0].entity_id).toBe(prize.id);
    expect(created[0].event_id).toBe(event.id);
    expect(created[0].actor_admin_id).toBe(admin.id);
  });

  it('rolls the prize back when the audit insert fails', async () => {
    db.raw.exec('DROP TABLE audit_logs');
    await expect(addPrize()).rejects.toThrow();
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM event_prizes').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('enforces the per-event limit', async () => {
    // Seed to the limit directly; going through the service 100 times is slow
    // and adds nothing.
    const now = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      db.raw
        .prepare(
          `INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(`p${i}`, event.id, `Prize ${i}`, i, admin.id, admin.id, now, now);
    }

    const result = await prizeService.create(event.id, { name: 'One too many', quantity: 1 }, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_LIMIT_REACHED');
  });

  it('404s for an unknown event', async () => {
    const result = await prizeService.create(
      '11111111-1111-4111-8111-111111111111',
      { name: 'X', quantity: 1 },
      actor(),
    );
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_NOT_FOUND' } });
  });
});

// ---------------------------------------------------------------------------
describe('event status governs every prize operation', () => {
  it.each(EVENT_STATUSES)('create is allowed from %s only when the table says so', async (status) => {
    setEventStatus(status);
    const result = await prizeService.create(event.id, { name: 'X', quantity: 1 }, actor());
    expect(result.ok, status).toBe(eventAllows(status, 'create'));
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_EVENT_NOT_EDITABLE');
  });

  it('permits editorial edits but freezes quantity while OPEN', async () => {
    const prize = await addPrize();
    setEventStatus('OPEN');

    const editorial = await prizeService.update(
      event.id,
      prize.id,
      { expectedRevision: 1, name: 'Renamed vape' },
      actor(),
    );
    expect(editorial.ok).toBe(true);

    const quantity = await prizeService.update(
      event.id,
      prize.id,
      { expectedRevision: 2, quantity: 9 },
      actor(),
    );
    expect(quantity.ok).toBe(false);
    if (!quantity.ok) {
      expect(quantity.failure.code).toBe('PRIZE_CANNOT_BE_EDITED');
      if (quantity.failure.code === 'PRIZE_CANNOT_BE_EDITED') {
        expect(quantity.failure.fields).toContain('quantity');
      }
    }
  });

  it.each(['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED', 'ARCHIVED'] as const)(
    'freezes everything once %s',
    async (status) => {
      const prize = await addPrize();
      setEventStatus(status);

      const edit = await prizeService.update(
        event.id,
        prize.id,
        { expectedRevision: 1, name: 'Nope' },
        actor(),
      );
      expect(edit.ok).toBe(false);

      const deactivate = await prizeService.transition(event.id, prize.id, 'deactivate', actor());
      expect(deactivate.ok).toBe(false);

      const removed = await prizeService.remove(event.id, prize.id, actor());
      expect(removed.ok).toBe(false);
    },
  );

  it('lets a cancelled event only archive', async () => {
    const prize = await addPrize();
    setEventStatus('CANCELLED');

    const archived = await prizeService.transition(event.id, prize.id, 'archive', actor());
    expect(archived.ok).toBe(true);

    const another = await addPrize().catch(() => null);
    expect(another).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('update', () => {
  it('bumps the revision and audits both snapshots', async () => {
    const prize = await addPrize({ name: 'Vape', description: 'Old' });
    const result = await prizeService.update(
      event.id,
      prize.id,
      { expectedRevision: 1, name: 'Vape Pro', description: 'New' },
      actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Vape Pro');
    expect(result.value.revision).toBe(2);

    const updated = auditRows().filter((r) => r.action === 'PRIZE_UPDATED');
    expect(updated).toHaveLength(1);
    expect(String(updated[0].previous_data)).toContain('Vape');
    expect(String(updated[0].new_data)).toContain('Vape Pro');
  });

  it('refuses a stale revision without touching the row or the trail', async () => {
    const prize = await addPrize();
    await prizeService.update(event.id, prize.id, { expectedRevision: 1, name: 'First' }, actor());

    const stale = await prizeService.update(
      event.id,
      prize.id,
      { expectedRevision: 1, name: 'Second' },
      actor(),
    );
    expect(stale).toEqual({ ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } });

    const current = await prizeRepo.findById(prize.id);
    expect(current?.name).toBe('First');
    expect(auditRows().filter((r) => r.action === 'PRIZE_UPDATED')).toHaveLength(1);
  });

  it('refuses to edit an archived prize', async () => {
    const prize = await addPrize();
    await prizeService.transition(event.id, prize.id, 'archive', actor());

    const result = await prizeService.update(
      event.id,
      prize.id,
      { expectedRevision: 2, name: 'Nope' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_ALREADY_ARCHIVED');
  });

  it('refuses a prize belonging to another event (IDOR)', async () => {
    const prize = await addPrize();
    const otherEvent = await eventService.create({ name: 'Other event' }, actor());
    if (!otherEvent.ok) throw new Error('other event failed');

    const result = await prizeService.update(
      otherEvent.value.id,
      prize.id,
      { expectedRevision: 1, name: 'Stolen' },
      actor(),
    );
    // Scoped lookup: it simply does not exist under that event.
    expect(result).toEqual({ ok: false, failure: { code: 'PRIZE_NOT_FOUND' } });

    const untouched = await prizeRepo.findById(prize.id);
    expect(untouched?.name).toBe('Vape');
  });
});

// ---------------------------------------------------------------------------
describe('status transitions', () => {
  it('deactivates and reactivates, auditing each', async () => {
    const prize = await addPrize();

    const off = await prizeService.transition(event.id, prize.id, 'deactivate', actor());
    expect(off.ok && off.value.status).toBe('INACTIVE');

    const on = await prizeService.transition(event.id, prize.id, 'activate', actor());
    expect(on.ok && on.value.status).toBe('ACTIVE');
    if (on.ok) expect(on.value.revision).toBe(3);

    const actions = auditRows().map((r) => r.action);
    expect(actions).toContain('PRIZE_DEACTIVATED');
    expect(actions).toContain('PRIZE_ACTIVATED');
  });

  it('refuses a repeated action rather than bumping the revision', async () => {
    const prize = await addPrize();
    const result = await prizeService.transition(event.id, prize.id, 'activate', actor());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_INVALID_STATUS');

    const current = await prizeRepo.findById(prize.id);
    expect(current?.revision).toBe(1);
  });

  it('archives with a timestamp and blocks everything afterwards', async () => {
    const prize = await addPrize();
    const archived = await prizeService.transition(event.id, prize.id, 'archive', actor());

    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.status).toBe('ARCHIVED');
    expect(archived.value.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    for (const action of ['activate', 'deactivate', 'archive'] as const) {
      const again = await prizeService.transition(event.id, prize.id, action, actor());
      expect(again.ok, action).toBe(false);
      if (!again.ok) expect(again.failure.code).toBe('PRIZE_ALREADY_ARCHIVED');
    }
  });

  it('an archived prize stops counting toward active units', async () => {
    const keep = await addPrize({ name: 'Keep', quantity: 3 });
    const drop = await addPrize({ name: 'Drop', quantity: 5 });
    expect(await prizeRepo.countActiveUnits(event.id)).toBe(8);

    await prizeService.transition(event.id, drop.id, 'archive', actor());
    expect(await prizeRepo.countActiveUnits(event.id)).toBe(3);

    await prizeService.transition(event.id, keep.id, 'deactivate', actor());
    expect(await prizeRepo.countActiveUnits(event.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('delete', () => {
  it('removes a prize and keeps its snapshot in the trail', async () => {
    const prize = await addPrize({ name: 'Doomed', quantity: 4 });
    const result = await prizeService.remove(event.id, prize.id, actor());
    expect(result.ok).toBe(true);

    expect(await prizeRepo.findById(prize.id)).toBeNull();

    const deleted = auditRows().find((r) => r.action === 'PRIZE_DELETED');
    const snapshot = JSON.parse(String(deleted?.previous_data));
    expect(snapshot.name).toBe('Doomed');
    expect(snapshot.quantity).toBe(4);
    expect(deleted?.new_data).toBeNull();
  });

  it('refuses to delete an archived prize', async () => {
    const prize = await addPrize();
    await prizeService.transition(event.id, prize.id, 'archive', actor());

    const result = await prizeService.remove(event.id, prize.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_CANNOT_BE_DELETED');
    expect(await prizeRepo.findById(prize.id)).not.toBeNull();
  });

  it('honours expectedRevision', async () => {
    const prize = await addPrize();
    const result = await prizeService.remove(event.id, prize.id, actor(), 99);
    expect(result).toEqual({ ok: false, failure: { code: 'PRIZE_REVISION_CONFLICT' } });
    expect(await prizeRepo.findById(prize.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('reorder', () => {
  async function threePrizes() {
    const a = await addPrize({ name: 'A' });
    const b = await addPrize({ name: 'B' });
    const c = await addPrize({ name: 'C' });
    return { a, b, c };
  }

  it('reverses the order without violating the unique position index', async () => {
    const { a, b, c } = await threePrizes();

    const result = await prizeService.reorder(
      event.id,
      [
        { prizeId: c.id, expectedRevision: c.revision, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 1 },
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 2 },
      ],
      actor(),
    );

    expect(result.ok).toBe(true);
    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(live.map((prize) => prize.name)).toEqual(['C', 'B', 'A']);
    // No prize is left parked in the staging range.
    expect(live.every((prize) => prize.sortOrder < 1000)).toBe(true);
  });

  it('swaps two adjacent prizes — the case a naive write would collide on', async () => {
    const { a, b, c } = await threePrizes();
    const result = await prizeService.reorder(
      event.id,
      [
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 0 },
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 1 },
        { prizeId: c.id, expectedRevision: c.revision, sortOrder: 2 },
      ],
      actor(),
    );
    expect(result.ok).toBe(true);
    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(live.map((p) => p.name)).toEqual(['B', 'A', 'C']);
  });

  it('bumps every revision and writes ONE aggregate audit row', async () => {
    const { a, b, c } = await threePrizes();
    await prizeService.reorder(
      event.id,
      [
        { prizeId: c.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
        { prizeId: a.id, expectedRevision: 1, sortOrder: 2 },
      ],
      actor(),
    );

    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(live.every((prize) => prize.revision === 2)).toBe(true);

    // One row for the whole operation, not one per prize.
    const reordered = auditRows().filter((r) => r.action === 'PRIZES_REORDERED');
    expect(reordered).toHaveLength(1);
    expect(reordered[0].entity_type).toBe('EVENT');
    expect(reordered[0].event_id).toBe(event.id);
    expect(String(reordered[0].previous_data)).toContain('order');
  });

  it('refuses a stale revision and writes nothing at all', async () => {
    const { a, b, c } = await threePrizes();
    await prizeService.update(event.id, a.id, { expectedRevision: 1, name: 'A2' }, actor());

    const result = await prizeService.reorder(
      event.id,
      [
        { prizeId: c.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
        { prizeId: a.id, expectedRevision: 1, sortOrder: 2 }, // stale
      ],
      actor(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('PRIZE_REVISION_CONFLICT');

    // Crucially: no prize moved, and none was left parked.
    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(live.map((p) => p.sortOrder)).toEqual([0, 1, 2]);
    expect(auditRows().filter((r) => r.action === 'PRIZES_REORDERED')).toHaveLength(0);
  });

  it('refuses a partial order', async () => {
    const { a, b } = await threePrizes();
    const result = await prizeService.reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
      ],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'PRIZE_ORDER_INVALID') {
      expect(result.failure.reason).toBe('incomplete_order');
    }
  });

  it('refuses an archived or foreign prize in the payload', async () => {
    const { a, b, c } = await threePrizes();
    await prizeService.transition(event.id, c.id, 'archive', actor());

    const withArchived = await prizeService.reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
        { prizeId: c.id, expectedRevision: 2, sortOrder: 2 },
      ],
      actor(),
    );
    expect(withArchived.ok).toBe(false);

    const other = await eventService.create({ name: 'Other' }, actor());
    if (!other.ok) throw new Error('other event failed');
    const foreign = await prizeService.reorder(
      other.value.id,
      [{ prizeId: a.id, expectedRevision: 1, sortOrder: 0 }],
      actor(),
    );
    expect(foreign.ok).toBe(false);
  });

  it('archiving frees a position for the remaining prizes', async () => {
    const { a, b, c } = await threePrizes();
    await prizeService.transition(event.id, b.id, 'archive', actor());

    // b held position 1; the partial index means a live prize may take it.
    const result = await prizeService.reorder(
      event.id,
      [
        { prizeId: c.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
      ],
      actor(),
    );
    expect(result.ok).toBe(true);
    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(live.map((p) => p.name)).toEqual(['C', 'A']);
  });
});

// ---------------------------------------------------------------------------
describe('listing and summary', () => {
  it('summarises counts and active units', async () => {
    await addPrize({ name: 'A', quantity: 2 });
    const b = await addPrize({ name: 'B', quantity: 3 });
    const c = await addPrize({ name: 'C', quantity: 5 });
    await prizeService.transition(event.id, b.id, 'deactivate', actor());
    await prizeService.transition(event.id, c.id, 'archive', actor());

    expect(await prizeRepo.summarize(event.id)).toEqual({
      totalPrizes: 3,
      activePrizes: 1,
      inactivePrizes: 1,
      archivedPrizes: 1,
      totalActiveUnits: 2,
    });
  });

  it('excludes archived by default and filters by status', async () => {
    await addPrize({ name: 'Live' });
    const gone = await addPrize({ name: 'Gone' });
    await prizeService.transition(event.id, gone.id, 'archive', actor());

    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, archived: 'active' })).total).toBe(1);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, archived: 'archived' })).total).toBe(1);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, archived: 'all' })).total).toBe(2);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, status: 'ACTIVE' })).total).toBe(1);
  });

  it('never leaks prizes from another event', async () => {
    await addPrize({ name: 'Mine' });
    const other = await eventService.create({ name: 'Other' }, actor());
    if (!other.ok) throw new Error('other event failed');
    await prizeService.create(other.value.id, { name: 'Theirs', quantity: 1 }, actor());

    const mine = await prizeRepo.list(event.id, BASE_QUERY);
    expect(mine.items.map((p) => p.name)).toEqual(['Mine']);
  });

  it('escapes LIKE wildcards in search', async () => {
    await addPrize({ name: '100% Cotton' });
    await addPrize({ name: 'under_score' });
    await addPrize({ name: 'Plain' });

    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, search: '%' })).total).toBe(1);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, search: '_' })).total).toBe(1);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, search: '\\' })).total).toBe(0);
    expect((await prizeRepo.list(event.id, { ...BASE_QUERY, search: 'Plain' })).total).toBe(1);
  });

  it('survives SQL injection in search', async () => {
    await addPrize({ name: 'Safe' });
    for (const search of ["' OR '1'='1", "'; DROP TABLE event_prizes;--"]) {
      expect((await prizeRepo.list(event.id, { ...BASE_QUERY, search })).total, search).toBe(0);
    }
    const alive = db.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='event_prizes'")
      .get() as { n: number };
    expect(alive.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('mapper', () => {
  function row(overrides: Partial<EventPrizeRow> = {}): EventPrizeRow {
    return {
      id: 'p1',
      event_id: 'e1',
      name: 'Prize',
      description: null,
      image_url: null,
      quantity: 1,
      sort_order: 0,
      status: 'ACTIVE',
      revision: 1,
      created_by: 'u1',
      updated_by: 'u1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      archived_at: null,
      ...overrides,
    };
  }

  it('accepts a well-formed row', () => {
    expect(rowToEventPrize(row()).status).toBe('ACTIVE');
  });

  it.each([
    ['unknown status', { status: 'GONE' }, /unknown value/i],
    ['lowercase status', { status: 'active' }, /unknown value/i],
    ['quantity 0', { quantity: 0 }, /quantity/i],
    ['quantity over max', { quantity: 5000 }, /quantity/i],
    ['negative sort order', { sort_order: -1 }, /sort_order/i],
    ['revision 0', { revision: 0 }, /revision/i],
    ['naive timestamp', { created_at: '2026-01-01 00:00:00' }, /canonical ISO/i],
    ['empty id', { id: '' }, /identifiers/i],
    ['empty event id', { event_id: '' }, /identifiers/i],
    [
      'archived without timestamp',
      { status: 'ARCHIVED', archived_at: null },
      /archived_at disagrees/i,
    ],
    [
      'timestamp without archived status',
      { status: 'ACTIVE', archived_at: '2026-01-01T00:00:00.000Z' },
      /archived_at disagrees/i,
    ],
    ['javascript image url', { image_url: 'javascript:alert(1)' }, /non-http/i],
    ['data image url', { image_url: 'data:text/html,x' }, /non-http/i],
    ['file image url', { image_url: 'file:///etc/passwd' }, /non-http/i],
    ['relative image url', { image_url: '/uploads/prize.png' }, /non-http/i],
    ['protocol-relative image url', { image_url: '//evil.example/x.png' }, /non-http/i],
    ['uppercased hostile scheme', { image_url: 'JavaScript:alert(1)' }, /non-http/i],
    ['sort order above the parking range', { sort_order: 99_000_000 }, /sort_order/i],
  ])('rejects %s', (_label, overrides, pattern) => {
    expect(() => rowToEventPrize(row(overrides as Partial<EventPrizeRow>))).toThrow(pattern);
  });

  it('names the column without leaking a stack', () => {
    try {
      rowToEventPrize(row({ status: 'GONE' }));
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('status');
      expect(message.split('\n')).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
describe('event integration', () => {
  it('an event holding prizes cannot be deleted, in any prize status', async () => {
    const prize = await addPrize();
    const events = new EventRepository(db.d1);

    for (const action of [null, 'deactivate', 'archive'] as const) {
      if (action) await prizeService.transition(event.id, prize.id, action, actor());
      expect(await events.hasDependencies(event.id), String(action)).toBe(true);

      const removed = await eventService.remove(event.id, actor());
      expect(removed.ok, String(action)).toBe(false);
      if (!removed.ok && removed.failure.code === 'EVENT_CANNOT_BE_DELETED') {
        expect(removed.failure.reason).toBe('has_dependencies');
      }
    }
  });

  it('an event with no prizes is still deletable', async () => {
    expect(await new EventRepository(db.d1).hasDependencies(event.id)).toBe(false);
    const removed = await eventService.remove(event.id, actor());
    expect(removed.ok).toBe(true);
  });

  it('the database refuses to orphan prizes even outside the service', async () => {
    await addPrize();
    expect(() =>
      db.raw.prepare('DELETE FROM events WHERE id = ?').run(event.id),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
describe('DRAW_READY requires something to give away', () => {
  async function closeEvent() {
    seedPublishedForm(event.id);
    await eventService.transition(event.id, 'open', actor());
    await eventService.transition(event.id, 'close', actor());
  }

  it('is refused with no prizes at all', async () => {
    await closeEvent();
    const result = await eventService.transition(event.id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'EVENT_NOT_READY') {
      expect(result.failure.fields).toContain('ACTIVE_PRIZE_REQUIRED');
    }
  });

  it('is refused when every prize is inactive or archived', async () => {
    const inactive = await addPrize({ name: 'Off' });
    const archived = await addPrize({ name: 'Gone' });
    await prizeService.transition(event.id, inactive.id, 'deactivate', actor());
    await prizeService.transition(event.id, archived.id, 'archive', actor());
    await closeEvent();

    const result = await eventService.transition(event.id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_NOT_READY');
  });

  it('succeeds with a single active prize', async () => {
    await addPrize({ name: 'Gift Card', quantity: 1 });
    await closeEvent();

    const result = await eventService.transition(event.id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('DRAW_READY');
  });

  it('is reported as a blocked action so the UI hides the button', async () => {
    await closeEvent();
    const current = await new EventRepository(db.d1).findById(event.id);
    const { available, blocked } = eventService.describeActions(current!, {
      activePrizeUnits: 0,
    });

    expect(available).not.toContain('mark-draw-ready');
    expect(
      blocked.find((entry) => entry.action === 'mark-draw-ready')?.missingFields,
    ).toContain('ACTIVE_PRIZE_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two updates on the same revision: one wins, one conflicts', async () => {
    const prize = await addPrize();
    const [a, b] = await Promise.all([
      prizeService.update(event.id, prize.id, { expectedRevision: 1, name: 'A' }, actor()),
      prizeService.update(event.id, prize.id, { expectedRevision: 1, name: 'B' }, actor()),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const current = await prizeRepo.findById(prize.id);
    expect(current?.revision).toBe(2);
    expect(auditRows().filter((r) => r.action === 'PRIZE_UPDATED')).toHaveLength(1);
  });

  it('update racing deactivate cannot both land', async () => {
    const prize = await addPrize();
    const [update, off] = await Promise.all([
      prizeService.update(event.id, prize.id, { expectedRevision: 1, name: 'Renamed' }, actor()),
      prizeService.transition(event.id, prize.id, 'deactivate', actor(), 1),
    ]);

    expect([update.ok, off.ok].filter(Boolean)).toHaveLength(1);
    expect((await prizeRepo.findById(prize.id))?.revision).toBe(2);
  });

  it('activate racing archive produces one outcome', async () => {
    const prize = await addPrize();
    await prizeService.transition(event.id, prize.id, 'deactivate', actor());

    const [on, gone] = await Promise.all([
      prizeService.transition(event.id, prize.id, 'activate', actor(), 2),
      prizeService.transition(event.id, prize.id, 'archive', actor(), 2),
    ]);
    expect([on.ok, gone.ok].filter(Boolean)).toHaveLength(1);
  });

  it('delete racing update leaves a consistent result', async () => {
    const prize = await addPrize();
    const [removed, updated] = await Promise.all([
      prizeService.remove(event.id, prize.id, actor(), 1),
      prizeService.update(event.id, prize.id, { expectedRevision: 1, name: 'Renamed' }, actor()),
    ]);

    expect([removed.ok, updated.ok].filter(Boolean)).toHaveLength(1);
    const current = await prizeRepo.findById(prize.id);
    if (removed.ok) expect(current).toBeNull();
    else expect(current?.name).toBe('Renamed');
  });

  it('two concurrent creates never share a position', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        prizeService.create(event.id, { name: `P${index}`, quantity: 1 }, actor()),
      ),
    );

    const created = results.filter((r) => r.ok);
    const positions = created.map((r) => (r.ok ? r.value.sortOrder : -1));
    expect(new Set(positions).size).toBe(created.length);

    const rows = db.raw
      .prepare('SELECT sort_order FROM event_prizes WHERE event_id = ?')
      .all(event.id) as Array<{ sort_order: number }>;
    expect(new Set(rows.map((r) => r.sort_order)).size).toBe(rows.length);
  });

  it('two concurrent reorders: one wins, order stays coherent', async () => {
    const a = await addPrize({ name: 'A' });
    const b = await addPrize({ name: 'B' });

    const forward = [
      { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
      { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
    ];
    const backward = [
      { prizeId: b.id, expectedRevision: 1, sortOrder: 0 },
      { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
    ];

    const results = await Promise.all([
      prizeService.reorder(event.id, forward, actor()),
      prizeService.reorder(event.id, backward, actor()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const live = await prizeRepo.listLiveByEvent(event.id);
    expect(new Set(live.map((p) => p.sortOrder)).size).toBe(live.length);
    expect(live.every((p) => p.sortOrder < 1000)).toBe(true);
  });
});
