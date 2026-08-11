// @vitest-environment node
//
// Adversarial regressions for the configurable-prize domain.
//
// Each test here corresponds to a defect that was REAL: it failed against the
// implementation as delivered, and passes only because of the fix that follows
// it. They are written to fail loudly again if that fix is undone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrizeService } from '../functions/_shared/prizeService';
import { PrizeRepository } from '../functions/_shared/prizeRepository';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { PRIZE_SORT_PARK_OFFSET, PRIZES_PER_EVENT_MAX } from '../shared/limits';
import { onRequest } from '../functions/_middleware';
import * as prizeById from '../functions/api/events/[id]/prizes/[prizeId]/index';
import * as prizesIndex from '../functions/api/events/[id]/prizes/index';
import * as reorderRoute from '../functions/api/events/[id]/prizes/reorder';
import * as eventById from '../functions/api/events/[id]/index';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { ApiErrorBody, AuthenticatedAdmin, Event, EventPrize } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let prizeService: PrizeService;
let eventService: EventLifecycleService;
let admin: AuthenticatedAdmin;
let event: Event;
let token: string;

const REQUEST: RequestContext = {
  requestId: 'req-phase4-adversarial',
  ipHash: 'c'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/prizes',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/**
 * A repository that lets another writer land in the window between the
 * service's revision pre-check and the batch that acts on it. That window is
 * real in production; this makes it deterministic.
 */
class RacyRepository extends PrizeRepository {
  private fired = false;
  constructor(
    d1: D1Database,
    private readonly race: () => void,
  ) {
    super(d1);
  }
  async listLiveByEvent(eventId: string): Promise<EventPrize[]> {
    const rows = await super.listLiveByEvent(eventId);
    if (!this.fired) {
      this.fired = true;
      this.race();
    }
    return rows;
  }
}

async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    request,
    env: { DB: db.d1 },
    data,
    params,
    next: async () => new Response('downstream', { status: 200 }),
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };
  const response = await handler(ctx as never);
  await Promise.allSettled(pending);
  return { response, data };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

const gate = async (path: string) => (await invoke(onRequest as never, req(path))).data;

async function addPrize(name: string): Promise<EventPrize> {
  const result = await prizeService.create(event.id, { name, quantity: 1 } as never, actor());
  if (!result.ok) throw new Error(`create failed: ${result.failure.code}`);
  return result.value;
}

function storedOrder(): Array<{ id: string; sort_order: number; revision: number }> {
  return db.raw
    .prepare('SELECT id, sort_order, revision FROM event_prizes ORDER BY sort_order ASC')
    .all() as never;
}

function reorderAudits(): unknown[] {
  return db.raw
    .prepare("SELECT id FROM audit_logs WHERE action = 'PRIZES_REORDERED'")
    .all() as unknown[];
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  prizeService = new PrizeService(db.d1);
  eventService = new EventLifecycleService(db.d1);

  const created = await new AdminRepository(db.d1).create({
    email: EMAIL,
    normalizedEmail: normalizeEmail(EMAIL),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(PASSWORD),
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

  const login = await invoke(
    loginHandler as never,
    new Request('https://example.com/api/manager/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  const cookies = (login.response.headers.getSetCookie?.() ?? []).join(' | ');
  token = decodeURIComponent(
    new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookies)?.[1] ?? '',
  );

  const madeEvent = await eventService.create(
    {
      name: 'Adversarial Event',
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
// Reorder atomicity under a genuine race
//
// The service pre-checks revisions, but another writer can still commit
// between that read and the batch. Before the in-batch abort guard existed,
// this window produced two distinct failures — a raw SQL error escaping as a
// 500, and a reorder that COMMITTED while reporting a conflict.
// ---------------------------------------------------------------------------
describe('reorder: a lost race commits nothing', () => {
  function racyService(victimId: string): PrizeService {
    return new PrizeService(db.d1, {
      prizes: new RacyRepository(db.d1, () => {
        db.raw
          .prepare('UPDATE event_prizes SET revision = revision + 1 WHERE id = ?')
          .run(victimId);
      }),
    });
  }

  it('answers with a typed conflict instead of leaking a UNIQUE violation', async () => {
    const a = await addPrize('A');
    const b = await addPrize('B');

    // A swap: the stale prize keeps position 0, which B is about to claim.
    const result = await racyService(a.id).reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 1 },
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 0 },
      ],
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PRIZE_REORDER_CONFLICT');
  });

  it('rolls back the prizes that DID park, rather than committing half an order', async () => {
    const a = await addPrize('A');
    const b = await addPrize('B');
    const c = await addPrize('C');

    // The stale prize's target equals the position it already holds, so nothing
    // collides: without the guard, B and C moved and the batch committed while
    // the caller was told the operation conflicted.
    const result = await racyService(a.id).reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 2 },
        { prizeId: c.id, expectedRevision: c.revision, sortOrder: 1 },
      ],
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PRIZE_REORDER_CONFLICT');

    // Every prize sits where it started, and only the simulated racer's
    // revision moved.
    expect(storedOrder()).toEqual([
      { id: a.id, sort_order: 0, revision: a.revision + 1 },
      { id: b.id, sort_order: 1, revision: b.revision },
      { id: c.id, sort_order: 2, revision: c.revision },
    ]);
  });

  it('writes no audit row for a reorder that did not happen', async () => {
    const a = await addPrize('A');
    const b = await addPrize('B');
    const c = await addPrize('C');

    await racyService(a.id).reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 2 },
        { prizeId: c.id, expectedRevision: c.revision, sortOrder: 1 },
      ],
      actor(),
    );

    expect(reorderAudits()).toHaveLength(0);
  });

  it('leaves nothing parked when every prize is stale', async () => {
    const a = await addPrize('A');
    const b = await addPrize('B');

    const service = new PrizeService(db.d1, {
      prizes: new RacyRepository(db.d1, () => {
        db.raw.prepare('UPDATE event_prizes SET revision = revision + 1').run();
      }),
    });

    const result = await service.reorder(
      event.id,
      [
        { prizeId: a.id, expectedRevision: a.revision, sortOrder: 1 },
        { prizeId: b.id, expectedRevision: b.revision, sortOrder: 0 },
      ],
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PRIZE_REORDER_CONFLICT');
    expect(storedOrder().map((row) => row.sort_order)).toEqual([0, 1]);
    expect(reorderAudits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The parking range at full scale
// ---------------------------------------------------------------------------
describe('reorder: the parking range at the domain ceiling', () => {
  it('reverses a full event of prizes without persisting a parked position', async () => {
    const created: EventPrize[] = [];
    for (let i = 0; i < PRIZES_PER_EVENT_MAX; i++) {
      created.push(await addPrize(`Prize ${i}`));
    }

    const reversed = [...created].reverse();
    const result = await prizeService.reorder(
      event.id,
      reversed.map((prize, index) => ({
        prizeId: prize.id,
        expectedRevision: prize.revision,
        sortOrder: index,
      })),
      actor(),
    );

    expect(result.ok).toBe(true);

    const rows = storedOrder();
    expect(rows.map((row) => row.sort_order)).toEqual(
      Array.from({ length: PRIZES_PER_EVENT_MAX }, (_, i) => i),
    );
    // No value from the staging range survived the batch.
    expect(rows.every((row) => row.sort_order < PRIZE_SORT_PARK_OFFSET)).toBe(true);
    expect(rows.every((row) => row.revision === 2)).toBe(true);
    // A collective change is ONE entry, not one per prize.
    expect(reorderAudits()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The revision guard must never be silently dropped
// ---------------------------------------------------------------------------
describe('DELETE: a malformed revision guard is refused, not ignored', () => {
  it('refuses a non-numeric expectedRevision on a prize instead of deleting unguarded', async () => {
    const prize = await addPrize('A');
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestDelete as never,
      req(`/api/events/${event.id}/prizes/${prize.id}?expectedRevision=abc`, {
        method: 'DELETE',
      }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
    // Still there: the guard was honoured by refusing, not by ignoring.
    expect(await prizeService.findPrize(event.id, prize.id)).not.toBeNull();
  });

  it('refuses a zero expectedRevision, which no row can ever carry', async () => {
    const prize = await addPrize('A');
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestDelete as never,
      req(`/api/events/${event.id}/prizes/${prize.id}?expectedRevision=0`, {
        method: 'DELETE',
      }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(400);
    expect(await prizeService.findPrize(event.id, prize.id)).not.toBeNull();
  });

  it('still deletes when the guard is well-formed and current', async () => {
    const prize = await addPrize('A');
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestDelete as never,
      req(`/api/events/${event.id}/prizes/${prize.id}?expectedRevision=${prize.revision}`, {
        method: 'DELETE',
      }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(200);
    expect(await prizeService.findPrize(event.id, prize.id)).toBeNull();
  });

  it('refuses a malformed expectedRevision on an event delete too', async () => {
    const data = await gate(`/api/events/${event.id}`);

    const { response } = await invoke(
      eventById.onRequestDelete as never,
      req(`/api/events/${event.id}?expectedRevision=not-a-number`, { method: 'DELETE' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
    expect(await eventService.findById(event.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Every refusal reaches the client as data it can act on
// ---------------------------------------------------------------------------
describe('typed failures carry their detail to the client', () => {
  function setEventStatus(status: string): void {
    db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
  }

  async function body(response: Response): Promise<ApiErrorBody> {
    return (await response.json()) as ApiErrorBody;
  }

  it('names the locked fields when the event has frozen them', async () => {
    const prize = await addPrize('A');
    setEventStatus('OPEN');
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestPatch as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: prize.revision, quantity: 9 }),
      }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('PRIZE_CANNOT_BE_EDITED');
    expect(failure.error.fields?.locked).toBe('quantity');
  });

  it('reports why a prize cannot be deleted', async () => {
    const prize = await addPrize('A');
    await prizeService.transition(event.id, prize.id, 'archive', actor());
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestDelete as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`, { method: 'DELETE' }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('PRIZE_CANNOT_BE_DELETED');
    expect(failure.error.fields?.reason).toBe('archived');
  });

  it('states the ceiling when an event is full', async () => {
    for (let i = 0; i < PRIZES_PER_EVENT_MAX; i++) await addPrize(`P${i}`);
    const data = await gate(`/api/events/${event.id}/prizes`);

    const { response } = await invoke(
      prizesIndex.onRequestPost as never,
      req(`/api/events/${event.id}/prizes`, {
        method: 'POST',
        body: JSON.stringify({ name: 'one too many', quantity: 1 }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('PRIZE_LIMIT_REACHED');
    expect(failure.error.fields?.limit).toBe(String(PRIZES_PER_EVENT_MAX));
  }, 60_000);

  it('says which way a submitted order was invalid', async () => {
    const a = await addPrize('A');
    await addPrize('B');
    const data = await gate(`/api/events/${event.id}/prizes/reorder`);

    const { response } = await invoke(
      reorderRoute.onRequestPost as never,
      req(`/api/events/${event.id}/prizes/reorder`, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ prizeId: a.id, expectedRevision: a.revision, sortOrder: 0 }],
        }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(400);
    const failure = await body(response);
    expect(failure.error.code).toBe('PRIZE_ORDER_INVALID');
    expect(failure.error.fields?.reason).toBe('incomplete_order');
  });

  it('reports the event status that forbids an action, and never a stack', async () => {
    const prize = await addPrize('A');
    setEventStatus('CLOSED');
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}/deactivate`);

    const { response } = await invoke(
      (await import('../functions/api/events/[id]/prizes/[prizeId]/deactivate'))
        .onRequestPost as never,
      req(`/api/events/${event.id}/prizes/${prize.id}/deactivate`, { method: 'POST' }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('PRIZE_EVENT_NOT_EDITABLE');
    expect(failure.error.fields?.eventStatus).toBe('CLOSED');
    expect(failure.error.fields?.capability).toBe('deactivate');
    expect(JSON.stringify(failure)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
});

// ---------------------------------------------------------------------------
// The assignments seam
// ---------------------------------------------------------------------------
// This block originally asserted the OPPOSITE: that `hasAssignments` returned
// false while `draw_assignments` genuinely did not exist, so the method could
// not be quietly relying on a table that was not there. Phase 11 created the
// table and filled the seam, so the assertion that certified the placeholder is
// now the assertion that certifies the real query.
describe('hasAssignments queries the table the seam was left for', () => {
  it('answers false for a prize nobody has won', async () => {
    const prize = await addPrize('A');
    const repo = new PrizeRepository(db.d1);

    expect(await repo.hasAssignments(prize.id)).toBe(false);

    // The table it queries is genuinely present: a `false` here is an answer,
    // not a placeholder.
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain('draw_assignments');
  });
});
