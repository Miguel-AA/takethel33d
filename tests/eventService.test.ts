// @vitest-environment node
//
// EventRepository and EventLifecycleService against the real migrated schema,
// including audit atomicity and optimistic-concurrency behaviour.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventRepository, rowToEvent } from '../functions/_shared/eventRepository';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { normalizeEmail } from '../shared/schemas';
import { setLogSink } from '../functions/_shared/logger';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { AuthenticatedAdmin, Event, EventListQuery } from '../shared/types';

let db: TestDatabase;
let service: EventLifecycleService;
let repository: EventRepository;
let admin: AuthenticatedAdmin;

const REQUEST: RequestContext = {
  requestId: 'req-events',
  ipHash: 'a'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events',
};

const BASE_QUERY: EventListQuery = {
  page: 1,
  pageSize: 50,
  status: null,
  search: null,
  archived: 'all',
  sort: 'createdAt',
  direction: 'desc',
};

function actor() {
  return { admin, requestContext: REQUEST };
}

/**
 * Audit rows in INSERTION order.
 *
 * Ordering by `created_at` is not enough here: several rows can share a
 * millisecond and the id is a random UUID, so the sequence would be arbitrary.
 * `rowid` is the actual write order.
 */
function auditRows() {
  return db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
}

/**
 * Gives an event one ACTIVE prize.
 *
 * Since phase 4, `mark-draw-ready` requires something to give away, so any test
 * that walks to DRAW_READY has to configure a prize first. Inserted directly:
 * the prize domain has its own suite, and this is only scaffolding.
 */
function seedActivePrize(eventId: string, quantity = 1): void {
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO event_prizes
         (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Seeded prize', ?, 0, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), eventId, quantity, admin.id, admin.id, now, now);
}

/**
 * Gives an event one participant who could actually win something.
 *
 * Since phase 11, `mark-draw-ready` requires it: DRAW_READY is a one-way door,
 * and declaring an event ready to draw when nothing could be drawn moves it
 * into a state whose only exit is a draw guaranteed to refuse. The same pattern
 * `seedActivePrize` follows for the prize precondition phase 4 added.
 *
 * `status = 'ELIGIBLE'` AND `overall_eligible = 1` — exactly the certified draw
 * predicate, not one of the two.
 */
function seedDrawEligibleEntry(eventId: string, versionId: string): void {
  const now = new Date().toISOString();
  const participantId = crypto.randomUUID();
  const email = `winner-${participantId}@example.com`;
  db.raw
    .prepare(
      `INSERT INTO participants
         (id, email, normalized_email, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, ?, 'Ada', 'Lovelace', ?, ?)`,
    )
    .run(participantId, email, email, now, now);
  db.raw
    .prepare(
      `INSERT INTO event_entries
         (id, event_id, participant_id, form_version_id, status,
          overall_eligible, submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ELIGIBLE', 1, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), eventId, participantId, versionId, now, now, now);
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
  db.raw
    .prepare(
      `INSERT INTO event_form_versions
         (id, event_id, version_number, source_draft_revision, published_by,
          published_at, schema_snapshot, created_at)
       VALUES (?, ?, 1, 1, ?, ?, '{"snapshotVersion":1}', ?)`,
    )
    .run(versionId, eventId, admin.id, now, now);
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

/** Dates that satisfy every ordering rule, well in the future. */
function futureWindow(offsetDays = 1) {
  const day = 86_400_000;
  const at = (days: number) => new Date(Date.now() + days * day).toISOString();
  return {
    registrationOpensAt: at(offsetDays),
    registrationClosesAt: at(offsetDays + 5),
    startsAt: at(offsetDays + 6),
    endsAt: at(offsetDays + 7),
  };
}

async function createDraft(overrides: Record<string, unknown> = {}): Promise<Event> {
  const result = await service.create(
    { name: 'Grand Opening Smoke Shop', ...overrides } as never,
    actor(),
  );
  if (!result.ok) throw new Error(`create failed: ${result.failure.code}`);
  return result.value;
}

/** Drives an event into a target state through real transitions. */
async function advanceTo(event: Event, target: string): Promise<Event> {
  let current = event;
  // Since phase 6, publishing or opening an event needs a published form.
  seedPublishedForm(event.id);
  const path: Record<string, string[]> = {
    SCHEDULED: ['publish'],
    OPEN: ['open'],
    CLOSED: ['open', 'close'],
    DRAW_READY: ['open', 'close', 'mark-draw-ready'],
    CANCELLED: ['cancel'],
    ARCHIVED: ['archive'],
  };
  for (const action of path[target] ?? []) {
    const result = await service.transition(current.id, action as never, actor());
    if (!result.ok) throw new Error(`${action} failed: ${result.failure.code}`);
    current = result.value;
  }
  return current;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  service = new EventLifecycleService(db.d1);
  repository = new EventRepository(db.d1);

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
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('create', () => {
  it('stores a draft with attribution and revision 1', async () => {
    const event = await createDraft();

    expect(event.status).toBe('DRAFT');
    expect(event.revision).toBe(1);
    expect(event.slug).toBe('grand-opening-smoke-shop');
    expect(event.createdBy).toBe(admin.id);
    expect(event.updatedBy).toBe(admin.id);
    expect(event.maxEntriesPerIdentity).toBe(1);
    expect(event.timezone).toBe('America/New_York');
    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('writes the event and its audit row in ONE transaction', async () => {
    const event = await createDraft();
    const rows = auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('EVENT_CREATED');
    expect(rows[0].entity_type).toBe('EVENT');
    expect(rows[0].event_id).toBe(event.id);
    expect(rows[0].actor_admin_id).toBe(admin.id);
    expect(rows[0].request_id).toBe('req-events');
  });

  it('rolls the event back when the audit insert fails', async () => {
    // Removing the audit table makes the second statement of the batch fail.
    db.raw.exec('DROP TABLE audit_logs');

    await expect(createDraft()).rejects.toThrow();

    // Nothing may remain: the mutation is not allowed to outlive its record.
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('auto-suffixes a generated slug on collision', async () => {
    await createDraft();
    const second = await createDraft();
    expect(second.slug).toBe('grand-opening-smoke-shop-2');
  });

  it('reports a conflict for an EXPLICIT slug rather than renaming it', async () => {
    await createDraft({ slug: 'my-event' });
    const result = await service.create({ name: 'Other', slug: 'my-event' }, actor());
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_SLUG_EXISTS' } });
  });

  it('rejects reserved slugs and invalid timezones', async () => {
    const reserved = await service.create({ name: 'X', slug: 'manager' }, actor());
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.failure.code).toBe('EVENT_SLUG_RESERVED');

    const zone = await service.create({ name: 'X', timezone: 'Mars/Olympus' }, actor());
    expect(zone.ok).toBe(false);
    if (!zone.ok) expect(zone.failure.code).toBe('EVENT_INVALID_TIMEZONE');
  });

  it('rejects an inverted date range', async () => {
    const result = await service.create(
      {
        name: 'X',
        startsAt: '2026-06-10T00:00:00.000Z',
        endsAt: '2026-06-01T00:00:00.000Z',
      },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_INVALID_DATE_RANGE');
  });

  it('allows a draft with no dates at all', async () => {
    const event = await createDraft();
    expect(event.startsAt).toBeNull();
    expect(event.registrationOpensAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('date rules', () => {
  it.each([
    ['registration opens after it closes', { registrationOpensAt: 2, registrationClosesAt: 1 }],
    ['event starts after it ends', { startsAt: 5, endsAt: 4 }],
    ['registration opens after the event starts', { registrationOpensAt: 6, startsAt: 5 }],
    ['registration closes after the event ends', { registrationClosesAt: 9, endsAt: 8 }],
  ])('rejects when %s', async (_label, offsets) => {
    const day = 86_400_000;
    const input: Record<string, string> = { name: 'X' };
    for (const [field, days] of Object.entries(offsets)) {
      input[field] = new Date(Date.now() + (days as number) * day).toISOString();
    }
    const result = await service.create(input as never, actor());
    expect(result.ok).toBe(false);
  });

  it('accepts registration closing exactly when the event starts', async () => {
    const day = 86_400_000;
    const same = new Date(Date.now() + 5 * day).toISOString();
    const result = await service.create(
      {
        name: 'X',
        registrationOpensAt: new Date(Date.now() + day).toISOString(),
        registrationClosesAt: same,
        startsAt: same,
        endsAt: new Date(Date.now() + 6 * day).toISOString(),
      },
      actor(),
    );
    expect(result.ok).toBe(true);
  });

  it('compares in UTC regardless of the event timezone', async () => {
    const window = futureWindow();
    const utc = await service.create({ name: 'A', timezone: 'UTC', ...window }, actor());
    const tokyo = await service.create(
      { name: 'B', timezone: 'Asia/Tokyo', ...window },
      actor(),
    );
    // The same instants are valid in both zones: the zone is presentation only.
    expect(utc.ok).toBe(true);
    expect(tokyo.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('update', () => {
  it('applies a patch, bumps the revision and audits atomically', async () => {
    const event = await createDraft();
    const result = await service.update(
      event.id,
      { expectedRevision: 1, name: 'Renamed', description: 'New copy' },
      actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Renamed');
    expect(result.value.revision).toBe(2);

    const updates = auditRows().filter((r) => r.action === 'EVENT_UPDATED');
    expect(updates).toHaveLength(1);
    // Both sides of the change are recorded.
    expect(String(updates[0].previous_data)).toContain('Grand Opening');
    expect(String(updates[0].new_data)).toContain('Renamed');
  });

  it('refuses a stale revision without touching the row', async () => {
    const event = await createDraft();
    await service.update(event.id, { expectedRevision: 1, name: 'First' }, actor());

    const stale = await service.update(
      event.id,
      { expectedRevision: 1, name: 'Second' },
      actor(),
    );
    expect(stale).toEqual({ ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } });

    const current = await repository.findById(event.id);
    expect(current?.name).toBe('First');
    // The rejected attempt left no audit row behind.
    expect(auditRows().filter((r) => r.action === 'EVENT_UPDATED')).toHaveLength(1);
  });

  it('rejects a field the current state has frozen', async () => {
    const event = await createDraft(futureWindow());
    const open = await advanceTo(event, 'OPEN');

    const result = await service.update(
      open.id,
      { expectedRevision: open.revision, minimumAge: 21 },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('EVENT_CANNOT_BE_EDITED');
    if (result.failure.code === 'EVENT_CANNOT_BE_EDITED') {
      expect(result.failure.fields).toContain('minimumAge');
    }
  });

  it('allows editorial changes while open', async () => {
    const event = await createDraft(futureWindow());
    const open = await advanceTo(event, 'OPEN');

    const result = await service.update(
      open.id,
      { expectedRevision: open.revision, description: 'Updated copy' },
      actor(),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses any edit once archived', async () => {
    const event = await createDraft();
    const archived = await advanceTo(event, 'ARCHIVED');

    const result = await service.update(
      archived.id,
      { expectedRevision: archived.revision, description: 'nope' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_CANNOT_BE_EDITED');
  });

  it('validates dates against the merged result, not the patch alone', async () => {
    const event = await createDraft(futureWindow());
    // Moving only the end date before the start must be caught.
    const result = await service.update(
      event.id,
      { expectedRevision: 1, endsAt: new Date(Date.now() + 1000).toISOString() },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_INVALID_DATE_RANGE');
  });

  it('rejects a duplicate slug on update', async () => {
    await createDraft({ slug: 'taken-slug' });
    const other = await createDraft({ name: 'Other event' });

    const result = await service.update(
      other.id,
      { expectedRevision: 1, slug: 'taken-slug' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_SLUG_EXISTS');
  });

  it('404s for an unknown event', async () => {
    const result = await service.update(
      '11111111-1111-4111-8111-111111111111',
      { expectedRevision: 1, name: 'X' },
      actor(),
    );
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_NOT_FOUND' } });
  });
});

// ---------------------------------------------------------------------------
describe('transitions', () => {
  it('publishes a fully configured draft and stamps published_at', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('SCHEDULED');
    expect(result.value.publishedAt).not.toBeNull();
    expect(result.value.revision).toBe(2);

    expect(auditRows().some((r) => r.action === 'EVENT_PUBLISHED')).toBe(true);
  });

  it('blocks publishing when required configuration is missing', async () => {
    const event = await createDraft();
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('EVENT_REQUIRED_FIELDS_MISSING');
    if (result.failure.code === 'EVENT_REQUIRED_FIELDS_MISSING') {
      expect(result.failure.fields).toContain('registrationOpensAt');
    }
    // Nothing was written.
    expect(auditRows().filter((r) => r.action === 'EVENT_PUBLISHED')).toHaveLength(0);
  });

  it('opens without requiring an opening date', async () => {
    const day = 86_400_000;
    const event = await createDraft({
      registrationClosesAt: new Date(Date.now() + 5 * day).toISOString(),
      startsAt: new Date(Date.now() + 6 * day).toISOString(),
      endsAt: new Date(Date.now() + 7 * day).toISOString(),
    });
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'open', actor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.openedAt).not.toBeNull();
  });

  it('walks the full happy path', async () => {
    const event = await createDraft(futureWindow());
    // A draw needs a prize and somebody to give it to; see seedActivePrize and
    // seedDrawEligibleEntry.
    seedActivePrize(event.id);
    seedDrawEligibleEntry(event.id, seedPublishedForm(event.id));
    const scheduled = await service.transition(event.id, 'publish', actor());
    expect(scheduled.ok && scheduled.value.status).toBe('SCHEDULED');

    seedPublishedForm(event.id);
    const opened = await service.transition(event.id, 'open', actor());
    expect(opened.ok && opened.value.status).toBe('OPEN');

    const closed = await service.transition(event.id, 'close', actor());
    expect(closed.ok && closed.value.status).toBe('CLOSED');
    if (closed.ok) expect(closed.value.closedAt).not.toBeNull();

    const ready = await service.transition(event.id, 'mark-draw-ready', actor());
    expect(ready.ok && ready.value.status).toBe('DRAW_READY');

    const archived = await service.transition(event.id, 'archive', actor());
    expect(archived.ok && archived.value.status).toBe('ARCHIVED');

    const actions = auditRows().map((r) => r.action);
    expect(actions).toEqual([
      'EVENT_CREATED',
      'EVENT_PUBLISHED',
      'EVENT_OPENED',
      'EVENT_CLOSED',
      'EVENT_MARKED_DRAW_READY',
      'EVENT_ARCHIVED',
    ]);
  });

  it.each([
    ['CLOSED', 'open'],
    ['OPEN', 'publish'],
    ['ARCHIVED', 'open'],
    ['ARCHIVED', 'archive'],
    ['CANCELLED', 'open'],
    ['CANCELLED', 'close'],
    ['DRAFT', 'close'],
    ['DRAFT', 'mark-draw-ready'],
    ['SCHEDULED', 'close'],
  ])('refuses %s -> %s', async (from, action) => {
    const event = await createDraft(futureWindow());
    const positioned = await advanceTo(event, from);

    const result = await service.transition(positioned.id, action as never, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_INVALID_TRANSITION');
  });

  it('cancels and then allows archiving, but nothing else', async () => {
    const event = await createDraft();
    const cancelled = await service.transition(event.id, 'cancel', actor());
    expect(cancelled.ok && cancelled.value.status).toBe('CANCELLED');
    if (cancelled.ok) expect(cancelled.value.cancelledAt).not.toBeNull();

    const archived = await service.transition(event.id, 'archive', actor());
    expect(archived.ok && archived.value.status).toBe('ARCHIVED');
  });

  it('honours expectedRevision when supplied', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor(), 99);
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } });
  });

  it('does not rewrite an operational timestamp already set', async () => {
    const event = await createDraft();
    const first = await service.transition(event.id, 'archive', actor());
    if (!first.ok) throw new Error('archive failed');
    const originalArchivedAt = first.value.archivedAt;

    // Archiving again is refused, so the timestamp cannot drift.
    const again = await service.transition(event.id, 'archive', actor());
    expect(again.ok).toBe(false);
    const current = await repository.findById(event.id);
    expect(current?.archivedAt).toBe(originalArchivedAt);
  });
});

// ---------------------------------------------------------------------------
describe('duplicate', () => {
  it('creates a fresh draft without state or operational timestamps', async () => {
    const event = await createDraft({ ...futureWindow(), minimumAge: 21 });
    const opened = await advanceTo(event, 'OPEN');

    const result = await service.duplicate(opened.id, {}, actor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const copy = result.value;
    expect(copy.id).not.toBe(opened.id);
    expect(copy.status).toBe('DRAFT');
    expect(copy.name).toBe('Grand Opening Smoke Shop (copy)');
    expect(copy.slug).not.toBe(opened.slug);
    expect(copy.revision).toBe(1);
    // Configuration carries over.
    expect(copy.minimumAge).toBe(21);
    expect(copy.timezone).toBe(opened.timezone);
    // Operational history does not.
    expect(copy.publishedAt).toBeNull();
    expect(copy.openedAt).toBeNull();
    // Dates are not copied by default.
    expect(copy.startsAt).toBeNull();
    expect(copy.registrationOpensAt).toBeNull();
  });

  it('copies future dates only when asked', async () => {
    const event = await createDraft(futureWindow());
    const result = await service.duplicate(event.id, { copyDates: true }, actor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.startsAt).toBe(event.startsAt);
  });

  it('drops past dates even when copying is requested', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const event = await createDraft({ startsAt: past });
    const result = await service.duplicate(event.id, { copyDates: true }, actor());
    // A window that has already passed would produce a draft that can never open.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.startsAt).toBeNull();
  });

  it('records the source in the audit metadata', async () => {
    const event = await createDraft();
    const result = await service.duplicate(event.id, {}, actor());
    expect(result.ok).toBe(true);

    const duplicated = auditRows().find((r) => r.action === 'EVENT_DUPLICATED');
    expect(duplicated).toBeDefined();
    expect(JSON.parse(String(duplicated?.metadata)).duplicatedFromEventId).toBe(event.id);
  });

  it('reports a conflict for an explicit duplicate slug', async () => {
    const event = await createDraft();
    await createDraft({ name: 'Another', slug: 'taken' });
    const result = await service.duplicate(event.id, { slug: 'taken' }, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_SLUG_EXISTS');
  });
});

// ---------------------------------------------------------------------------
describe('delete', () => {
  it('removes a pristine draft and stores a full snapshot', async () => {
    const event = await createDraft();
    const result = await service.remove(event.id, actor());
    expect(result.ok).toBe(true);

    expect(await repository.findById(event.id)).toBeNull();

    const deleted = auditRows().find((r) => r.action === 'EVENT_DELETED');
    expect(deleted).toBeDefined();
    // The audit row is now the only evidence the event existed.
    const snapshot = JSON.parse(String(deleted?.previous_data));
    expect(snapshot.slug).toBe(event.slug);
    expect(snapshot.name).toBe(event.name);
    expect(deleted?.new_data).toBeNull();
  });

  it.each([
    ['SCHEDULED', 'not_a_draft'],
    ['OPEN', 'not_a_draft'],
    ['CANCELLED', 'not_a_draft'],
    ['ARCHIVED', 'not_a_draft'],
  ])('refuses to delete a %s event', async (state, reason) => {
    const event = await createDraft(futureWindow());
    const positioned = await advanceTo(event, state);

    const result = await service.remove(positioned.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'EVENT_CANNOT_BE_DELETED') {
      expect(result.failure.reason).toBe(reason);
    }
    expect(await repository.findById(event.id)).not.toBeNull();
  });

  it('refuses a draft that carries operational history', async () => {
    const event = await createDraft();
    // Simulate a row that was published and somehow returned to draft.
    db.raw
      .prepare("UPDATE events SET published_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
      .run(event.id);

    const result = await service.remove(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'EVENT_CANNOT_BE_DELETED') {
      expect(result.failure.reason).toBe('was_published');
    }
  });

  it('honours expectedRevision', async () => {
    const event = await createDraft();
    const result = await service.remove(event.id, actor(), 99);
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } });
    expect(await repository.findById(event.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('listing', () => {
  it('filters, searches, sorts and paginates', async () => {
    await createDraft({ name: 'Alpha event', slug: 'alpha' });
    await createDraft({ name: 'Beta event', slug: 'beta' });
    const gamma = await createDraft({ name: 'Gamma event', slug: 'gamma' });
    await advanceTo(gamma, 'ARCHIVED');

    const active = await repository.list({ ...BASE_QUERY, archived: 'active' });
    expect(active.total).toBe(2);

    const archived = await repository.list({ ...BASE_QUERY, archived: 'archived' });
    expect(archived.total).toBe(1);
    expect(archived.items[0].slug).toBe('gamma');

    const all = await repository.list({ ...BASE_QUERY, archived: 'all' });
    expect(all.total).toBe(3);

    const searched = await repository.list({ ...BASE_QUERY, search: 'bet' });
    expect(searched.total).toBe(1);
    expect(searched.items[0].slug).toBe('beta');

    const byStatus = await repository.list({ ...BASE_QUERY, status: 'DRAFT' });
    expect(byStatus.total).toBe(2);

    const byName = await repository.list({ ...BASE_QUERY, sort: 'name', direction: 'asc' });
    expect(byName.items[0].name).toBe('Alpha event');

    const paged = await repository.list({ ...BASE_QUERY, pageSize: 2, page: 2 });
    expect(paged.items).toHaveLength(1);
  });

  it('treats a search string as data, never as SQL or a wildcard injection', async () => {
    await createDraft({ name: 'Alpha event', slug: 'alpha' });

    for (const search of ["' OR '1'='1", '%', "'; DROP TABLE events;--"]) {
      const result = await repository.list({ ...BASE_QUERY, search });
      // A bare `%` is escaped into the LIKE pattern as a literal, so it must not
      // match everything.
      expect(result.total, search).toBe(0);
    }

    const still = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(still.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('mapper', () => {
  it('refuses a stored status it does not model', () => {
    expect(() =>
      rowToEvent({
        id: 'x',
        slug: 's',
        name: 'n',
        description: null,
        banner_url: null,
        location_name: null,
        timezone: 'UTC',
        registration_opens_at: null,
        registration_closes_at: null,
        starts_at: null,
        ends_at: null,
        minimum_age: null,
        max_entries_per_identity: 1,
        status: 'NOT_A_STATE',
        confirmation_title: null,
        confirmation_message: null,
        ineligible_title: null,
        ineligible_message: null,
        revision: 1,
        created_by: 'a',
        updated_by: 'a',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        published_at: null,
        opened_at: null,
        closed_at: null,
        cancelled_at: null,
        archived_at: null,
      }),
    ).toThrow(/unknown value/);
  });

  it('the column CHECK already refuses a naive SQLite timestamp', async () => {
    const event = await createDraft();
    // The schema is the first line of defence: a `datetime('now')`-shaped value
    // cannot even be written, so the mapper's check is a second line that
    // should never fire in practice.
    expect(() =>
      db.raw
        .prepare("UPDATE events SET created_at = '2026-01-01 00:00:00' WHERE id = ?")
        .run(event.id),
    ).toThrow(/CHECK/i);
  });

  it('the mapper refuses a malformed timestamp if one ever reached the row', () => {
    const base = {
      id: 'x',
      slug: 's',
      name: 'n',
      description: null,
      banner_url: null,
      location_name: null,
      timezone: 'UTC',
      registration_opens_at: null,
      registration_closes_at: null,
      starts_at: null,
      ends_at: null,
      minimum_age: null,
      max_entries_per_identity: 1,
      status: 'DRAFT',
      confirmation_title: null,
      confirmation_message: null,
      ineligible_title: null,
      ineligible_message: null,
      revision: 1,
      created_by: 'a',
      updated_by: 'a',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01T00:00:00.000Z',
      published_at: null,
      opened_at: null,
      closed_at: null,
      cancelled_at: null,
      archived_at: null,
    };
    expect(() => rowToEvent(base)).toThrow(/canonical ISO/);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two concurrent updates on the same revision: one wins, one conflicts', async () => {
    const event = await createDraft();

    const [a, b] = await Promise.all([
      service.update(event.id, { expectedRevision: 1, name: 'A wins' }, actor()),
      service.update(event.id, { expectedRevision: 1, name: 'B wins' }, actor()),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    const conflicted = [a, b].filter((r) => !r.ok);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const current = await repository.findById(event.id);
    expect(current?.revision).toBe(2);
    // Exactly one audit row: the loser wrote nothing.
    expect(auditRows().filter((r) => r.action === 'EVENT_UPDATED')).toHaveLength(1);
  });

  it('an update and a transition on the same revision cannot both land', async () => {
    const event = await createDraft(futureWindow());

    seedPublishedForm(event.id);

    const [update, transition] = await Promise.all([
      service.update(event.id, { expectedRevision: 1, name: 'Renamed' }, actor()),
      service.transition(event.id, 'publish', actor(), 1),
    ]);

    expect([update.ok, transition.ok].filter(Boolean)).toHaveLength(1);
    const current = await repository.findById(event.id);
    expect(current?.revision).toBe(2);
  });

  it('two concurrent transitions produce one state change', async () => {
    const event = await createDraft(futureWindow());

    seedPublishedForm(event.id);

    const results = await Promise.all([
      service.transition(event.id, 'publish', actor(), 1),
      service.transition(event.id, 'publish', actor(), 1),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(auditRows().filter((r) => r.action === 'EVENT_PUBLISHED')).toHaveLength(1);
  });

  it('a delete racing an update leaves a consistent result', async () => {
    const event = await createDraft();

    const [remove, update] = await Promise.all([
      service.remove(event.id, actor(), 1),
      service.update(event.id, { expectedRevision: 1, name: 'Renamed' }, actor()),
    ]);

    // Exactly one may succeed; the row is either gone or renamed, never both.
    expect([remove.ok, update.ok].filter(Boolean)).toHaveLength(1);
    const current = await repository.findById(event.id);
    if (remove.ok) expect(current).toBeNull();
    else expect(current?.name).toBe('Renamed');
  });

  it('two creates with the same explicit slug: the unique index decides', async () => {
    const results = await Promise.all([
      service.create({ name: 'One', slug: 'shared-slug' }, actor()),
      service.create({ name: 'Two', slug: 'shared-slug' }, actor()),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const count = db.raw
      .prepare("SELECT COUNT(*) AS n FROM events WHERE slug = 'shared-slug'")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('DRAW_READY requires somebody to draw', () => {
  // Phase 11 added a SECOND precondition beside the prize rule, and it exists
  // because DRAW_READY is a ONE-WAY DOOR: no action returns an event to CLOSED.
  // Declaring an event ready to draw when nothing could be drawn moves it into
  // a state whose only exit is a draw guaranteed to refuse.
  async function closedEvent(): Promise<string> {
    const event = await createDraft(futureWindow());
    seedActivePrize(event.id);
    seedPublishedForm(event.id);
    await service.transition(event.id, 'open', actor());
    await service.transition(event.id, 'close', actor());
    return event.id;
  }

  it('refuses the transition when nobody is eligible', async () => {
    const id = await closedEvent();

    const result = await service.transition(id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('EVENT_NOT_READY');
      if (result.failure.code === 'EVENT_NOT_READY') {
        expect(result.failure.fields).toContain('ELIGIBLE_PARTICIPANT_REQUIRED');
      }
    }

    // And the event did not move.
    expect((await service.findById(id))?.status).toBe('CLOSED');
  });

  it('refuses it when the only entries were never judged eligible', async () => {
    const id = await closedEvent();
    const versionId = seedPublishedForm(id);
    const now = new Date().toISOString();
    const participantId = crypto.randomUUID();
    const email = `ineligible-${participantId}@example.com`;
    db.raw
      .prepare(
        `INSERT INTO participants
           (id, email, normalized_email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, 'Ada', 'Lovelace', ?, ?)`,
      )
      .run(participantId, email, email, now, now);
    db.raw
      .prepare(
        `INSERT INTO event_entries
           (id, event_id, participant_id, form_version_id, status, overall_eligible,
            eligibility_reason, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'INELIGIBLE', 0, 'AGE_REQUIREMENT_NOT_MET', ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), id, participantId, versionId, now, now, now);

    const result = await service.transition(id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(false);
  });

  it('allows it with one eligible participant', async () => {
    const id = await closedEvent();
    seedDrawEligibleEntry(id, seedPublishedForm(id));

    const result = await service.transition(id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('DRAW_READY');
  });

  it('is reported as a blocked action so the UI hides the button', async () => {
    const id = await closedEvent();
    const event = await service.findById(id);

    const { available, blocked } = service.describeActions(event!, {
      activePrizeUnits: 1,
      drawEligibleCount: 0,
      publishedFormValid: true,
    });

    expect(available).not.toContain('mark-draw-ready');
    expect(
      blocked.find((entry) => entry.action === 'mark-draw-ready')?.missingFields,
    ).toContain('ELIGIBLE_PARTICIPANT_REQUIRED');
  });

  it('is not evaluated when the caller does not supply the count', async () => {
    // Callers that only care about the event's own fields must not have the
    // rule applied on their behalf from a number they never resolved.
    const id = await closedEvent();
    const event = await service.findById(id);

    const { available } = service.describeActions(event!, {
      activePrizeUnits: 1,
      publishedFormValid: true,
    });
    expect(available).toContain('mark-draw-ready');
  });
});
