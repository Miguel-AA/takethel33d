// @vitest-environment node
//
// Adversarial validation of the event domain. Every test asserts the behaviour
// the contract demands and fails if the defence is absent or removed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventRepository, rowToEvent, type EventRow } from '../functions/_shared/eventRepository';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import {
  EVENT_STATUSES,
  EVENT_TRANSITION_ACTIONS,
  ACTION_TARGET,
  canTransition,
  type EventStatus,
} from '../shared/eventLifecycle';
import { checkSlug, isValidSlug, slugify } from '../shared/slug';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { AuthenticatedAdmin, Event, EventListQuery } from '../shared/types';

let db: TestDatabase;
let service: EventLifecycleService;
let repository: EventRepository;
let admin: AuthenticatedAdmin;

const REQUEST: RequestContext = {
  requestId: 'req-p3-adv',
  ipHash: 'b'.repeat(64),
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

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function auditRows() {
  return db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
}

function futureWindow() {
  return {
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  };
}

async function createDraft(overrides: Record<string, unknown> = {}): Promise<Event> {
  const result = await service.create({ name: 'Adversarial Event', ...overrides } as never, actor());
  if (!result.ok) throw new Error(`create failed: ${result.failure.code}`);
  return result.value;
}

/**
 * Gives an event one ACTIVE prize.
 *
 * Since phase 4, `mark-draw-ready` requires at least one active prize. Tests
 * that exercise the STATE MACHINE rather than the prize rule seed one so the
 * only thing under test is the transition itself.
 */
function seedActivePrize(eventId: string): void {
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO event_prizes
         (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, 'Seeded prize', 1, 0, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), eventId, admin.id, admin.id, now, now);
}

/** Forces a row into a state directly, bypassing the service. */
function forceState(id: string, columns: Record<string, string | number | null>) {
  const assignments = Object.keys(columns).map((c) => `${c} = ?`).join(', ');
  db.raw
    .prepare(`UPDATE events SET ${assignments} WHERE id = ?`)
    .run(...Object.values(columns), id);
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
// A. Exhaustive transition matrix — every state x every action
// ---------------------------------------------------------------------------
describe('transition matrix is exhaustive and exact', () => {
  const ALLOWED: Record<EventStatus, EventStatus[]> = {
    DRAFT: ['SCHEDULED', 'OPEN', 'CANCELLED', 'ARCHIVED'],
    SCHEDULED: ['OPEN', 'CANCELLED', 'ARCHIVED'],
    OPEN: ['CLOSED', 'CANCELLED', 'ARCHIVED'],
    CLOSED: ['DRAW_READY', 'ARCHIVED'],
    DRAW_READY: ['ARCHIVED'],
    DRAW_COMPLETED: ['ARCHIVED'],
    CANCELLED: ['ARCHIVED'],
    ARCHIVED: [],
  };

  it('every state/action pair matches the contract in the shared table', () => {
    for (const from of EVENT_STATUSES) {
      for (const action of EVENT_TRANSITION_ACTIONS) {
        const target = ACTION_TARGET[action];
        const shouldAllow = ALLOWED[from].includes(target);
        expect(canTransition(from, action), `${from} -> ${action} (${target})`).toBe(
          shouldAllow,
        );
      }
    }
  });

  // Drives the SERVICE from a forced row state, so the runtime agrees with the
  // table rather than merely sharing a constant with it.
  it.each(
    EVENT_STATUSES.flatMap((from) =>
      EVENT_TRANSITION_ACTIONS.map((action) => [from, action] as const),
    ),
  )('service enforces %s -> %s', async (from, action) => {
    const event = await createDraft(futureWindow());
    // Configuration that satisfies every non-state precondition, so a rejection
    // can only come from the state machine itself.
    seedActivePrize(event.id);
    seedPublishedForm(event.id);
    forceState(event.id, {
      status: from,
      closed_at: ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED'].includes(from)
        ? new Date().toISOString()
        : null,
    });

    const target = ACTION_TARGET[action];
    const shouldAllow = ALLOWED[from].includes(target);
    const result = await service.transition(event.id, action, actor());

    if (shouldAllow) {
      expect(result.ok, `${from} -> ${action} should be allowed`).toBe(true);
    } else {
      expect(result.ok, `${from} -> ${action} must be refused`).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe('EVENT_INVALID_TRANSITION');
      }
      // A refused transition leaves the state untouched and writes no audit.
      const current = await repository.findById(event.id);
      expect(current?.status).toBe(from);
      expect(
        auditRows().filter((r) => String(r.action).startsWith('EVENT_') && r.action !== 'EVENT_CREATED'),
      ).toHaveLength(0);
    }
  });

  it('DRAW_COMPLETED is unreachable through any action', () => {
    for (const action of EVENT_TRANSITION_ACTIONS) {
      expect(ACTION_TARGET[action]).not.toBe('DRAW_COMPLETED');
    }
  });

  it('repeating an action on the resulting state is refused', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const first = await service.transition(event.id, 'publish', actor());
    expect(first.ok).toBe(true);

    seedPublishedForm(event.id);
    const again = await service.transition(event.id, 'publish', actor());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.failure.code).toBe('EVENT_INVALID_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// B. Transition preconditions the contract demands
// ---------------------------------------------------------------------------
describe('open refuses a window that has already passed', () => {
  it('refuses to open when registration already closed', async () => {
    // Opening registration on an event whose window ended is incoherent: the
    // act of opening would be contradicted the instant it took effect.
    const event = await createDraft({
      registrationClosesAt: at(-5),
      startsAt: at(-3),
      endsAt: at(-2),
    });

    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'open', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_NOT_READY');
  });

  it('refuses to open when the event has already ended', async () => {
    // Built through a valid future window, then aged directly — the ordering
    // rules stay satisfied so only the timing precondition can reject it.
    const event = await createDraft(futureWindow());
    forceState(event.id, {
      registration_closes_at: at(-3),
      starts_at: at(-2),
      ends_at: at(-1),
      registration_opens_at: at(-4),
    });

    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'open', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_NOT_READY');
  });

  it('refuses to schedule once the registration opening has passed', async () => {
    const event = await createDraft(futureWindow());
    forceState(event.id, { registration_opens_at: at(-1) });

    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_NOT_READY');
  });

  it('reports a stale window as a blocked action so the UI hides the button', async () => {
    const event = await createDraft(futureWindow());
    forceState(event.id, { registration_closes_at: at(-1), registration_opens_at: at(-2) });
    const current = await repository.findById(event.id);

    const { available, blocked } = service.describeActions(current!);
    expect(available).not.toContain('open');
    expect(blocked.find((b) => b.action === 'open')?.missingFields).toContain(
      'registrationClosesAt',
    );
  });

  it('allows opening a window that is still live', async () => {
    const event = await createDraft({
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    });
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'open', actor());
    expect(result.ok).toBe(true);
  });
});

describe('mark-draw-ready requires a real closure', () => {
  it('refuses when closed_at is absent even if the status says CLOSED', async () => {
    const event = await createDraft(futureWindow());
    // A row manipulated directly in the database: status says CLOSED but the
    // event was never actually closed.
    forceState(event.id, { status: 'CLOSED', closed_at: null });

    const result = await service.transition(event.id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_REQUIRED_FIELDS_MISSING');
  });

  it('allows it after a genuine close', async () => {
    const event = await createDraft(futureWindow());
    seedActivePrize(event.id);
    seedPublishedForm(event.id);
    await service.transition(event.id, 'open', actor());
    await service.transition(event.id, 'close', actor());

    const result = await service.transition(event.id, 'mark-draw-ready', actor());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.closedAt).not.toBeNull();
  });
});

describe('publish', () => {
  it('always targets SCHEDULED and only from DRAFT', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor());
    expect(result.ok && result.value.status).toBe('SCHEDULED');
    expect(ACTION_TARGET.publish).toBe('SCHEDULED');
  });

  it('refuses an invalid timezone stored on the row', async () => {
    const event = await createDraft(futureWindow());
    forceState(event.id, { timezone: 'Mars/Olympus' });
    seedPublishedForm(event.id);
    const result = await service.transition(event.id, 'publish', actor());
    expect(result.ok).toBe(false);
  });
});

describe('operational timestamps', () => {
  it('are written once and never rewritten by a refused retry', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const opened = await service.transition(event.id, 'open', actor());
    if (!opened.ok) throw new Error('open failed');
    const firstOpenedAt = opened.value.openedAt;
    expect(firstOpenedAt).not.toBeNull();

    // A second open is refused; the timestamp must not move.
    seedPublishedForm(event.id);
    await service.transition(event.id, 'open', actor());
    const current = await repository.findById(event.id);
    expect(current?.openedAt).toBe(firstOpenedAt);
  });

  it('are canonical ISO and survive into the delete snapshot', async () => {
    const event = await createDraft();
    const cancelled = await service.transition(event.id, 'cancel', actor());
    if (!cancelled.ok) throw new Error('cancel failed');
    expect(cancelled.value.cancelledAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const archived = await service.transition(event.id, 'archive', actor());
    if (!archived.ok) throw new Error('archive failed');
    // Cancelling then archiving keeps BOTH moments.
    expect(archived.value.cancelledAt).toBe(cancelled.value.cancelledAt);
    expect(archived.value.archivedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C. rowToEvent hardening
// ---------------------------------------------------------------------------
describe('rowToEvent refuses corrupt rows written outside the application', () => {
  function row(overrides: Partial<EventRow> = {}): EventRow {
    return {
      id: 'e1',
      slug: 'ok-slug',
      name: 'Name',
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
      created_by: 'u1',
      updated_by: 'u1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      published_at: null,
      opened_at: null,
      closed_at: null,
      cancelled_at: null,
      archived_at: null,
      ...overrides,
    };
  }

  it('accepts a well-formed row', () => {
    expect(rowToEvent(row()).status).toBe('DRAFT');
  });

  it.each([
    ['unknown status', { status: 'NOT_A_STATE' }, /unknown value/i],
    ['lowercase status', { status: 'draft' }, /unknown value/i],
    ['naive created_at', { created_at: '2026-01-01 00:00:00' }, /canonical ISO/i],
    ['bad updated_at', { updated_at: 'yesterday' }, /canonical ISO/i],
    ['bad published_at', { published_at: '2026-01-01' }, /canonical ISO/i],
    ['revision 0', { revision: 0 }, /revision/i],
    ['negative revision', { revision: -3 }, /revision/i],
    ['minimum_age out of range', { minimum_age: 500 }, /minimum_age/i],
    ['negative minimum_age', { minimum_age: -1 }, /minimum_age/i],
    ['max entries 0', { max_entries_per_identity: 0 }, /max_entries/i],
  ])('rejects %s', (_label, overrides, pattern) => {
    expect(() => rowToEvent(row(overrides as Partial<EventRow>))).toThrow(pattern);
  });

  it('the thrown error names the column without leaking a stack', () => {
    try {
      rowToEvent(row({ status: 'GHOST' }));
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('status');
      expect(message).not.toContain('at ');
      expect(message.split('\n')).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Slugs
// ---------------------------------------------------------------------------
describe('slug hostility', () => {
  it.each([
    ['forward slash', 'events/admin'],
    ['backslash', 'events\\admin'],
    ['percent-encoded slash', 'events%2fadmin'],
    ['double-encoded slash', 'events%252fadmin'],
    ['dot', 'events.admin'],
    ['parent traversal', '..'],
    ['traversal path', '../../admin'],
    ['emoji', 'party-🎉'],
    ['cyrillic lookalike', 'аdmin'],
    ['leading hyphen', '-events'],
    ['trailing hyphen', 'events-'],
    ['double hyphen', 'events--2026'],
    ['space', 'my event'],
    ['uppercase', 'MyEvent'],
    ['null byte', 'ev ent'],
    ['too long', 'a'.repeat(81)],
  ])('rejects %s as a slug', (_label, value) => {
    expect(isValidSlug(value), value).toBe(false);
    expect(checkSlug(value).ok).toBe(false);
  });

  it.each(['api', 'manager', 'events', 'event', 'admin', 'login', 'audit', 'confirmacion', 'landing'])(
    'refuses the reserved slug %s',
    (value) => {
      expect(checkSlug(value)).toEqual({ ok: false, reason: 'reserved' });
    },
  );

  it('slugify neutralises hostile names into safe addresses', () => {
    expect(slugify('../../admin')).toBe('admin');
    expect(slugify('My Event / Admin')).toBe('my-event-admin');
    expect(slugify('Q1')).toBe('q1');
    expect(slugify('Ñandú')).toBe('nandu');
    // A name with nothing slug-worthy yields empty, which is then refused.
    expect(slugify('🎉🎉')).toBe('');
    expect(checkSlug(slugify('🎉🎉')).ok).toBe(false);
  });

  it('a name that slugifies to a reserved word is refused, not silently used', async () => {
    const result = await service.create({ name: 'Admin' }, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_INVALID_SLUG');
  });

  it('the slug is immutable once the event leaves DRAFT', async () => {
    const event = await createDraft(futureWindow());

    // Editable while a draft.
    const inDraft = await service.update(
      event.id,
      { expectedRevision: 1, slug: 'renamed-in-draft' },
      actor(),
    );
    expect(inDraft.ok).toBe(true);
    if (!inDraft.ok) return;

    seedPublishedForm(event.id);
    const scheduled = await service.transition(event.id, 'publish', actor());
    if (!scheduled.ok) throw new Error('publish failed');

    const afterDraft = await service.update(
      event.id,
      { expectedRevision: scheduled.value.revision, slug: 'renamed-after' },
      actor(),
    );
    expect(afterDraft.ok).toBe(false);
    if (!afterDraft.ok) expect(afterDraft.failure.code).toBe('EVENT_CANNOT_BE_EDITED');

    const current = await repository.findById(event.id);
    expect(current?.slug).toBe('renamed-in-draft');
  });
});

// ---------------------------------------------------------------------------
// E. Listing: LIKE escaping and ordering
// ---------------------------------------------------------------------------
describe('search escaping', () => {
  beforeEach(async () => {
    await createDraft({ name: 'Alpha event', slug: 'alpha' });
    await createDraft({ name: 'Beta event', slug: 'beta' });
    await createDraft({ name: '100% Real Sale', slug: 'hundred-percent' });
    await createDraft({ name: 'under_score name', slug: 'under-score' });
  });

  it('treats % as a literal, not a wildcard', async () => {
    const result = await repository.list({ ...BASE_QUERY, search: '%' });
    // Only the event whose NAME contains a percent sign.
    expect(result.total).toBe(1);
    expect(result.items[0].slug).toBe('hundred-percent');
  });

  it('treats _ as a literal, not a single-character wildcard', async () => {
    const result = await repository.list({ ...BASE_QUERY, search: '_' });
    expect(result.total).toBe(1);
    expect(result.items[0].slug).toBe('under-score');
  });

  it('treats a backslash as a literal', async () => {
    const result = await repository.list({ ...BASE_QUERY, search: '\\' });
    expect(result.total).toBe(0);
  });

  it('still matches ordinary substrings', async () => {
    expect((await repository.list({ ...BASE_QUERY, search: 'alph' })).total).toBe(1);
    expect((await repository.list({ ...BASE_QUERY, search: 'event' })).total).toBe(2);
  });

  it('survives SQL injection attempts without damage', async () => {
    for (const search of ["' OR '1'='1", "'; DROP TABLE events;--", "%' OR slug LIKE '%"]) {
      const result = await repository.list({ ...BASE_QUERY, search });
      expect(result.total, search).toBe(0);
    }
    const alive = db.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='events'")
      .get() as { n: number };
    expect(alive.n).toBe(1);
  });
});

describe('listing order', () => {
  it('sorts by startsAt with NULLs without dropping rows', async () => {
    await createDraft({ name: 'No dates', slug: 'no-dates' });
    await createDraft({ name: 'With dates', slug: 'with-dates', ...futureWindow() });

    const asc = await repository.list({ ...BASE_QUERY, sort: 'startsAt', direction: 'asc' });
    const desc = await repository.list({ ...BASE_QUERY, sort: 'startsAt', direction: 'desc' });
    // Whatever the NULL placement, no row may vanish.
    expect(asc.items).toHaveLength(2);
    expect(desc.items).toHaveLength(2);
    expect(asc.total).toBe(2);
  });

  it('breaks ties deterministically so a page never repeats a row', async () => {
    for (let i = 0; i < 6; i++) await createDraft({ name: `Tie ${i}`, slug: `tie-${i}` });
    // Force identical timestamps so only the tiebreaker distinguishes them.
    db.raw.prepare("UPDATE events SET created_at = '2026-01-01T00:00:00.000Z'").run();

    const first = await repository.list({ ...BASE_QUERY, pageSize: 3, page: 1 });
    const second = await repository.list({ ...BASE_QUERY, pageSize: 3, page: 2 });
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// F. Revision guard
// ---------------------------------------------------------------------------
describe('revision guard', () => {
  it('a conflict does not increment the revision', async () => {
    const event = await createDraft();
    await service.update(event.id, { expectedRevision: 1, name: 'First' }, actor());

    const before = (await repository.findById(event.id))?.revision;
    await service.update(event.id, { expectedRevision: 1, name: 'Stale' }, actor());
    const after = (await repository.findById(event.id))?.revision;

    expect(before).toBe(2);
    expect(after).toBe(2);
  });

  it('rejects a revision from the future', async () => {
    const event = await createDraft();
    const result = await service.update(
      event.id,
      { expectedRevision: 999, name: 'X' },
      actor(),
    );
    expect(result).toEqual({ ok: false, failure: { code: 'EVENT_REVISION_CONFLICT' } });
  });

  it('a retried request with the consumed revision is refused, not reapplied', async () => {
    const event = await createDraft();
    const first = await service.update(event.id, { expectedRevision: 1, name: 'Once' }, actor());
    expect(first.ok).toBe(true);

    // Same payload replayed (a network retry).
    const replay = await service.update(event.id, { expectedRevision: 1, name: 'Once' }, actor());
    expect(replay.ok).toBe(false);

    // Exactly one update audit row: the replay wrote nothing.
    expect(auditRows().filter((r) => r.action === 'EVENT_UPDATED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// G. Audit atomicity across every mutation
// ---------------------------------------------------------------------------
describe('audit atomicity for every mutation', () => {
  it.each([
    ['create', async () => { await service.create({ name: 'Atomic' }, actor()); }],
    ['update', async (id: string) => {
      await service.update(id, { expectedRevision: 1, name: 'Atomic' }, actor());
    }],
    ['publish', async (id: string) => {
      seedPublishedForm(id);
      await service.transition(id, 'publish', actor());
    }],
    ['open', async (id: string) => {
      seedPublishedForm(id);
      await service.transition(id, 'open', actor());
    }],
    ['cancel', async (id: string) => { await service.transition(id, 'cancel', actor()); }],
    ['archive', async (id: string) => { await service.transition(id, 'archive', actor()); }],
    ['duplicate', async (id: string) => { await service.duplicate(id, {}, actor()); }],
    ['delete', async (id: string) => { await service.remove(id, actor()); }],
  ])('%s cannot commit without its audit row', async (_label, run) => {
    const event = await createDraft(futureWindow());
    const eventsBefore = (
      db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    ).n;
    const snapshot = await repository.findById(event.id);

    // Breaking the audit table makes the second statement of every batch fail.
    db.raw.exec('DROP TABLE audit_logs');

    await expect(run(event.id)).rejects.toThrow();

    // The mutation must have rolled back entirely.
    const eventsAfter = (
      db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    ).n;
    expect(eventsAfter).toBe(eventsBefore);

    const current = await repository.findById(event.id);
    expect(current?.status).toBe(snapshot?.status);
    expect(current?.revision).toBe(snapshot?.revision);
    expect(current?.name).toBe(snapshot?.name);
  });

  it('a refused transition writes no audit row at all', async () => {
    const event = await createDraft();
    const before = auditRows().length;

    await service.transition(event.id, 'close', actor()); // invalid from DRAFT
    await service.transition(event.id, 'mark-draw-ready', actor()); // invalid
    seedPublishedForm(event.id);
    await service.transition(event.id, 'publish', actor()); // missing fields

    expect(auditRows()).toHaveLength(before);
  });

  it('records exactly one audit row per successful mutation', async () => {
    const event = await createDraft(futureWindow());
    await service.update(event.id, { expectedRevision: 1, name: 'Renamed' }, actor());
    seedPublishedForm(event.id);
    await service.transition(event.id, 'publish', actor());
    await service.transition(event.id, 'open', actor());

    const forEvent = auditRows().filter((r) => r.event_id === event.id);
    expect(forEvent.map((r) => r.action)).toEqual([
      'EVENT_CREATED',
      'EVENT_UPDATED',
      'EVENT_PUBLISHED',
      'EVENT_OPENED',
    ]);
    for (const row of forEvent) {
      expect(row.actor_admin_id).toBe(admin.id);
      expect(row.request_id).toBe('req-p3-adv');
      expect(row.entity_id).toBe(event.id);
    }
  });

  it('a forged actor is refused by the foreign key, leaving no event behind', async () => {
    const rogue = {
      admin: { ...admin, id: 'ghost-admin-id' },
      requestContext: REQUEST,
    };
    await expect(service.create({ name: 'Forged' }, rogue)).rejects.toThrow();
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// H. Duplication across every source state
// ---------------------------------------------------------------------------
describe('duplication from every state', () => {
  it.each(EVENT_STATUSES)('duplicating a %s event yields a pristine DRAFT', async (status) => {
    const event = await createDraft({ ...futureWindow(), minimumAge: 21 });
    const stamp = new Date().toISOString();
    forceState(event.id, {
      status,
      published_at: stamp,
      opened_at: stamp,
      closed_at: stamp,
      cancelled_at: stamp,
      archived_at: stamp,
    });

    const result = await service.duplicate(event.id, {}, actor());
    expect(result.ok, status).toBe(true);
    if (!result.ok) return;

    const copy = result.value;
    expect(copy.status).toBe('DRAFT');
    expect(copy.revision).toBe(1);
    expect(copy.publishedAt).toBeNull();
    expect(copy.openedAt).toBeNull();
    expect(copy.closedAt).toBeNull();
    expect(copy.cancelledAt).toBeNull();
    expect(copy.archivedAt).toBeNull();
    // Configuration carries over; identity does not.
    expect(copy.minimumAge).toBe(21);
    expect(copy.id).not.toBe(event.id);
    expect(copy.slug).not.toBe(event.slug);

    // The original is untouched.
    const original = await repository.findById(event.id);
    expect(original?.status).toBe(status);
    expect(original?.revision).toBe(event.revision);
  });

  it('refuses a reserved slug for the copy', async () => {
    const event = await createDraft();
    const result = await service.duplicate(event.id, { slug: 'manager' }, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_SLUG_RESERVED');
  });

  it('drops partially-past dates when copying', async () => {
    const event = await createDraft({
      registrationOpensAt: at(-2),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    });
    const result = await service.duplicate(event.id, { copyDates: true }, actor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The past opening is dropped; future dates survive.
    expect(result.value.registrationOpensAt).toBeNull();
    expect(result.value.startsAt).toBe(event.startsAt);
  });
});

// ---------------------------------------------------------------------------
// I. Deletion
// ---------------------------------------------------------------------------
describe('physical deletion', () => {
  it.each([
    'published_at',
    'opened_at',
    'closed_at',
    'cancelled_at',
    'archived_at',
  ])('refuses a DRAFT carrying %s', async (column) => {
    const event = await createDraft();
    forceState(event.id, { status: 'DRAFT', [column]: new Date().toISOString() });

    const result = await service.remove(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_CANNOT_BE_DELETED');
    expect(await repository.findById(event.id)).not.toBeNull();
  });

  it.each(EVENT_STATUSES.filter((s) => s !== 'DRAFT'))(
    'refuses to delete a %s event',
    async (status) => {
      const event = await createDraft();
      forceState(event.id, { status });
      const result = await service.remove(event.id, actor());
      expect(result.ok).toBe(false);
      expect(await repository.findById(event.id)).not.toBeNull();
    },
  );

  it('the snapshot outlives the deleted event', async () => {
    const event = await createDraft({ ...futureWindow(), minimumAge: 21 });
    await service.remove(event.id, actor());

    expect(await repository.findById(event.id)).toBeNull();
    const deleted = auditRows().find((r) => r.action === 'EVENT_DELETED');
    const snapshot = JSON.parse(String(deleted?.previous_data));
    expect(snapshot.slug).toBe(event.slug);
    expect(snapshot.minimumAge).toBe(21);
    expect(snapshot.startsAt).toBe(event.startsAt);
  });
});

// ---------------------------------------------------------------------------
// J. Edit policy per state, exhaustive
// ---------------------------------------------------------------------------
describe('edit policy is enforced at runtime for every state', () => {
  const FROZEN_EVERYWHERE_BUT_DRAFT = 'slug';

  it.each(EVENT_STATUSES.filter((s) => s !== 'DRAFT'))(
    'refuses a slug change in %s',
    async (status) => {
      const event = await createDraft();
      forceState(event.id, { status });
      const current = await repository.findById(event.id);

      const result = await service.update(
        event.id,
        { expectedRevision: current!.revision, [FROZEN_EVERYWHERE_BUT_DRAFT]: 'new-slug' },
        actor(),
      );
      expect(result.ok, status).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('EVENT_CANNOT_BE_EDITED');
    },
  );

  it.each(['minimumAge', 'maxEntriesPerIdentity', 'timezone', 'registrationOpensAt'])(
    'refuses changing %s once OPEN',
    async (field) => {
      const event = await createDraft(futureWindow());
      forceState(event.id, { status: 'OPEN' });
      const current = await repository.findById(event.id);

      const patch: Record<string, unknown> = {
        expectedRevision: current!.revision,
        [field]: field === 'timezone' ? 'UTC' : field === 'registrationOpensAt' ? at(2) : 5,
      };
      const result = await service.update(event.id, patch as never, actor());
      expect(result.ok, field).toBe(false);
    },
  );

  it('refuses every editable field once ARCHIVED', async () => {
    const event = await createDraft();
    forceState(event.id, { status: 'ARCHIVED' });
    const current = await repository.findById(event.id);

    for (const field of ['name', 'description', 'bannerUrl', 'locationName']) {
      const result = await service.update(
        event.id,
        { expectedRevision: current!.revision, [field]: 'anything' } as never,
        actor(),
      );
      expect(result.ok, field).toBe(false);
    }
  });

  it('CANCELLED permits messages only', async () => {
    const event = await createDraft();
    await service.transition(event.id, 'cancel', actor());
    let current = await repository.findById(event.id);

    const message = await service.update(
      event.id,
      { expectedRevision: current!.revision, confirmationMessage: 'Sorry' },
      actor(),
    );
    expect(message.ok).toBe(true);

    current = await repository.findById(event.id);
    const name = await service.update(
      event.id,
      { expectedRevision: current!.revision, name: 'Renamed' },
      actor(),
    );
    expect(name.ok).toBe(false);
  });

  it('clearing an optional field to null is allowed in DRAFT', async () => {
    const event = await createDraft({ description: 'Some copy', minimumAge: 21 });
    const result = await service.update(
      event.id,
      { expectedRevision: 1, description: null, minimumAge: null },
      actor(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.description).toBeNull();
      expect(result.value.minimumAge).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// K. Concurrency beyond the happy path
// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two DIFFERENT transitions on the same revision: only one lands', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);

    const [publish, cancel] = await Promise.all([
      service.transition(event.id, 'publish', actor(), 1),
      service.transition(event.id, 'cancel', actor(), 1),
    ]);

    expect([publish.ok, cancel.ok].filter(Boolean)).toHaveLength(1);
    const current = await repository.findById(event.id);
    expect(['SCHEDULED', 'CANCELLED']).toContain(current?.status);
    expect(current?.revision).toBe(2);
    // Exactly one transition audit row.
    expect(
      auditRows().filter((r) => ['EVENT_PUBLISHED', 'EVENT_CANCELLED'].includes(String(r.action))),
    ).toHaveLength(1);
  });

  it('archive racing an update cannot produce a partial state', async () => {
    const event = await createDraft();
    const [archive, update] = await Promise.all([
      service.transition(event.id, 'archive', actor(), 1),
      service.update(event.id, { expectedRevision: 1, name: 'Renamed' }, actor()),
    ]);

    expect([archive.ok, update.ok].filter(Boolean)).toHaveLength(1);
    const current = await repository.findById(event.id);
    expect(current?.revision).toBe(2);
  });

  it('delete racing duplicate leaves a coherent outcome', async () => {
    const event = await createDraft();
    const [remove, copy] = await Promise.all([
      service.remove(event.id, actor(), 1),
      service.duplicate(event.id, {}, actor()),
    ]);

    // Duplicate reads the source; if the delete won first it must 404 rather
    // than produce a copy of nothing.
    if (!copy.ok) {
      expect(copy.failure.code).toBe('EVENT_NOT_FOUND');
    }
    expect(remove.ok || !copy.ok).toBe(true);
  });

  it('concurrent auto-generated slugs never collide', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.create({ name: 'Same Name Event' }, actor())),
    );
    const created = results.filter((r) => r.ok);
    const slugs = new Set(created.map((r) => (r.ok ? r.value.slug : '')));
    // Every create that succeeded got a distinct address.
    expect(slugs.size).toBe(created.length);

    const rows = db.raw.prepare('SELECT slug FROM events').all() as Array<{ slug: string }>;
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
  });
});
