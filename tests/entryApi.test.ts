// @vitest-environment node
//
// The participants HTTP surface: authentication, route protection, IDOR,
// mass-assignment, typed errors, cache headers, and the fact that nothing here
// leaks personal data to somebody who should not have it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import * as entriesIndex from '../functions/api/events/[id]/entries/index';
import * as entryById from '../functions/api/events/[id]/entries/[entryId]';
import * as participantsIndex from '../functions/api/events/[id]/participants/index';
import * as participantById from '../functions/api/events/[id]/participants/[entryId]';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { FormDraftService } from '../functions/_shared/formDraftService';
import { FormPublishingService } from '../functions/_shared/formPublishingService';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type {
  ApiErrorBody,
  AuthenticatedAdmin,
  CreateEventEntryResponse,
  Event,
  EventEntryDetail,
  EventEntryListResponse,
  EventFormVersion,
  SubmittedAnswer,
} from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let token: string;
let admin: AuthenticatedAdmin;
let event: Event;
let version: EventFormVersion;
let otherEvent: Event;
let otherVersion: EventFormVersion;

const REQUEST: RequestContext = {
  requestId: 'seed',
  ipHash: 'a'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/seed',
};
const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  let nextCalled = false;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    request,
    env: { DB: db.d1 },
    data,
    params,
    next: async () => {
      nextCalled = true;
      return new Response('downstream', { status: 200 });
    },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  };
  const response = await handler(ctx as never);
  await Promise.allSettled(pending);
  return { response, data, nextCalled };
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

const gate = async (path: string, method = 'GET') =>
  (await invoke(onRequest as never, req(path, { method }))).data;

/** An OPEN event with a published form, plus the version it serves. */
async function seedOpenEvent(name: string) {
  const events = new EventLifecycleService(db.d1);
  const drafts = new FormDraftService(db.d1);
  const publishing = new FormPublishingService(db.d1);

  const created = await events.create(
    {
      name,
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    actor(),
  );
  if (!created.ok) throw new Error('event seed failed');
  const made = created.value;

  const draft = await drafts.ensure(made.id, actor());
  if (!draft.ok) throw new Error(draft.failure.code);
  let form = draft.value.draft;

  const step = await drafts.createStep(
    made.id,
    { expectedRevision: form.revision, title: 'About you' },
    actor(),
  );
  if (!step.ok) throw new Error(step.failure.code);
  form = step.value;

  for (const [field, type] of [
    ['FIRST_NAME', 'SHORT_TEXT'],
    ['LAST_NAME', 'SHORT_TEXT'],
    ['EMAIL', 'EMAIL'],
  ] as const) {
    const question = await drafts.createQuestion(
      made.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type,
        systemField: field,
        label: field,
        required: true,
      } as never,
      actor(),
    );
    if (!question.ok) throw new Error(question.failure.code);
    form = question.value;
  }

  const published = await publishing.publish(made.id, form.revision, actor());
  if (!published.ok) throw new Error(published.failure.code);
  const opened = await events.transition(made.id, 'open', actor());
  if (!opened.ok) throw new Error(JSON.stringify(opened.failure));

  const reloaded = await events.findById(made.id);
  if (!reloaded) throw new Error('event vanished');
  return { event: reloaded, version: published.value.version };
}

function answersFor(
  target: EventFormVersion,
  overrides: Record<string, unknown> = {},
): SubmittedAnswer[] {
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'ana@example.com',
    ...overrides,
  };
  const byKey = new Map(
    target.steps.flatMap((step) => step.questions).map((question) => [question.key, question]),
  );
  return Object.entries(values).map(([key, value]) => {
    const question = byKey.get(key);
    if (!question) throw new Error(`no question keyed ${key}`);
    return { questionId: question.id, value };
  });
}

async function post(
  eventId: string,
  body: unknown,
): Promise<{ status: number; json: unknown; response: Response }> {
  const path = `/api/events/${eventId}/entries`;
  const data = await gate(path, 'POST');
  const { response } = await invoke(
    entriesIndex.onRequestPost as never,
    req(path, { method: 'POST', body: JSON.stringify(body) }),
    data,
    { id: eventId },
  );
  return { status: response.status, json: await response.clone().json(), response };
}

async function createEntry(eventId = event.id, target = version) {
  const result = await post(eventId, { answers: answersFor(target) });
  expect(result.status).toBe(201);
  return result.json as CreateEventEntryResponse;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});

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

  const first = await seedOpenEvent('Owner');
  const second = await seedOpenEvent('Other');
  event = first.event;
  version = first.version;
  otherEvent = second.event;
  otherVersion = second.version;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('route protection', () => {
  it('refuses every participant route without a session', async () => {
    const id = newId();
    const entryId = newId();
    for (const path of [
      `/api/events/${id}/entries`,
      `/api/events/${id}/entries/${entryId}`,
      `/api/events/${id}/participants`,
      `/api/events/${id}/participants/${entryId}`,
    ]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(response.status, path).toBe(401);
      expect(nextCalled, path).toBe(false);
    }
  });

  it('refuses them through a path the router would still resolve', async () => {
    // The guard normalises the path itself; a proxy-friendly encoding must not
    // slip a personal-data route past authentication.
    const id = newId();
    for (const path of [
      `//api/events/${id}/entries`,
      `/api/%65vents/${id}/entries`,
      `/api/events/${id}/../${id}/entries`,
    ]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(response.status, path).toBe(401);
      expect(nextCalled, path).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('creating an entry', () => {
  it('records one and answers with the entry, the identity and a count', async () => {
    const created = await createEntry();
    // Born decided. This event has no age rule, so nothing was judged about
    // the age — but the participation itself has a verdict.
    expect(created.entry.status).toBe('ELIGIBLE');
    expect(created.entry.overallEligible).toBe(true);
    expect(created.entry.ageEligible).toBeNull();
    expect(created.entry.eligibilityReason).toBe('ELIGIBLE');
    expect(created.entry.formVersionId).toBe(version.id);
    expect(created.participant.normalizedEmail).toBe('ana@example.com');
    expect(created.answerCount).toBe(3);
  });

  it('never caches a response carrying personal data', async () => {
    const path = `/api/events/${event.id}/entries`;
    const data = await gate(path, 'POST');
    const { response } = await invoke(
      entriesIndex.onRequestPost as never,
      req(path, { method: 'POST', body: JSON.stringify({ answers: answersFor(version) }) }),
      data,
      { id: event.id },
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('refuses a body that tries to decide anything the server decides', async () => {
    // `.strict()` is what stops a caller choosing its own participant, version,
    // status or timestamps by adding a key.
    for (const extra of [
      { participantId: newId() },
      { formVersionId: otherVersion.id },
      { status: 'ELIGIBLE' },
      { submittedAt: at(-5) },
      { ipHash: 'x'.repeat(64) },
      { userAgent: 'spoofed' },
      { calculatedAge: 99 },
      { overallEligible: true },
      { participant: { firstName: 'Someone', lastName: 'Else', email: 'x@y.com' } },
    ]) {
      const result = await post(event.id, { answers: answersFor(version), ...extra });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses an answer that names its own key, type or label', async () => {
    const answers = answersFor(version).map((answer) => ({
      ...answer,
      questionKey: 'something_else',
      answerType: 'CONSENT',
      questionLabel: 'Made up',
    }));
    const result = await post(event.id, { answers });
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a malformed body, a wrong content type and an oversized one', async () => {
    const path = `/api/events/${event.id}/entries`;
    const data = await gate(path, 'POST');

    const malformed = await invoke(
      entriesIndex.onRequestPost as never,
      req(path, { method: 'POST', body: '{not json' }),
      data,
      { id: event.id },
    );
    expect(malformed.response.status).toBe(400);
    expect(((await malformed.response.json()) as ApiErrorBody).error.code).toBe('INVALID_JSON');

    const wrongType = await invoke(
      entriesIndex.onRequestPost as never,
      req(path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }),
      data,
      { id: event.id },
    );
    expect(wrongType.response.status).toBe(415);

    const huge = await invoke(
      entriesIndex.onRequestPost as never,
      req(path, {
        method: 'POST',
        body: JSON.stringify({ answers: [], padding: 'x'.repeat(200_000) }),
      }),
      data,
      { id: event.id },
    );
    expect(huge.response.status).toBe(413);
  });

  it('refuses more answers than a form could ever hold, before validating them', async () => {
    const flood = Array.from({ length: 1000 }, () => ({ questionId: newId(), value: 'x' }));
    const result = await post(event.id, { answers: flood });
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an event id that is not one', async () => {
    const result = await post('not-a-uuid', { answers: [] });
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });

  it('answers 404 for an event that does not exist', async () => {
    const result = await post(newId(), { answers: [] });
    expect(result.status).toBe(404);
    expect((result.json as ApiErrorBody).error.code).toBe('EVENT_NOT_FOUND');
  });

  it('reports each domain refusal with its own code and detail', async () => {
    const duplicate = await post(event.id, {
      answers: [...answersFor(version), answersFor(version)[0]],
    });
    expect(duplicate.status).toBe(400);
    expect((duplicate.json as ApiErrorBody).error.code).toBe('DUPLICATE_FORM_ANSWER');

    const unknown = await post(event.id, {
      answers: [...answersFor(version), { questionId: newId(), value: 'x' }],
    });
    expect(unknown.status).toBe(400);
    expect((unknown.json as ApiErrorBody).error.code).toBe('FORM_ANSWER_UNKNOWN_QUESTION');

    const invalid = await post(event.id, {
      answers: answersFor(version, { email: 'nope' }),
    });
    expect(invalid.status).toBe(400);
    const invalidBody = invalid.json as ApiErrorBody;
    expect(invalidBody.error.code).toBe('FORM_ANSWER_INVALID');
    expect(invalidBody.error.fields?.answers).toContain('INVALID_EMAIL');

    const missing = await post(event.id, { answers: [] });
    expect(missing.status).toBe(422);
    const missingBody = missing.json as ApiErrorBody;
    expect(missingBody.error.code).toBe('FORM_REQUIRED_ANSWER_MISSING');
    expect(missingBody.error.fields?.keys).toContain('email');
  });

  it('a validation message never echoes what somebody typed back', async () => {
    const result = await post(event.id, {
      answers: answersFor(version, { email: 'secret-address@@private' }),
    });
    expect(result.status).toBe(400);
    // The refusal names the QUESTION and the problem. Reflecting the value
    // would put personal data into a log line, an error page and a browser
    // history entry, none of which were asked for.
    const serialized = JSON.stringify(result.json);
    expect(serialized).not.toContain('secret-address');
    expect(serialized).toContain('INVALID_EMAIL');
  });

  it('refuses a second entry for the same identity with a 409', async () => {
    const first = await createEntry();
    const again = await post(event.id, { answers: answersFor(version) });
    expect(again.status).toBe(409);
    const body = again.json as ApiErrorBody;
    expect(body.error.code).toBe('PARTICIPANT_ALREADY_ENTERED');
    expect(body.error.fields?.entryId).toBe(first.entry.id);
  });

  it('refuses an event that is not accepting entries, naming why', async () => {
    db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);
    const result = await post(event.id, { answers: answersFor(version) });
    expect(result.status).toBe(409);
    const body = result.json as ApiErrorBody;
    expect(body.error.code).toBe('EVENT_NOT_ACCEPTING_ENTRIES');
    expect(body.error.fields?.reason).toBe('EVENT_NOT_OPEN');
  });

  it('never returns a stack trace, whatever goes wrong', async () => {
    for (const body of [{ answers: [] }, { answers: [{ questionId: newId(), value: {} }] }]) {
      const result = await post(event.id, body);
      const serialized = JSON.stringify(result.json);
      expect(serialized).not.toMatch(/at .*\.ts:\d+/);
      expect(serialized).not.toContain('participantRegistrationService');
    }
  });
});

// ---------------------------------------------------------------------------
describe('reading entries', () => {
  async function list(eventId: string, query = '') {
    const path = `/api/events/${eventId}/entries${query}`;
    const data = await gate(path);
    const { response } = await invoke(
      entriesIndex.onRequestGet as never,
      req(path),
      data,
      { id: eventId },
    );
    return { status: response.status, json: await response.clone().json(), response };
  }

  async function detail(eventId: string, entryId: string, handler = entryById.onRequestGet) {
    const path = `/api/events/${eventId}/entries/${entryId}`;
    const data = await gate(path);
    const { response } = await invoke(handler as never, req(path), data, {
      id: eventId,
      entryId,
    });
    return { status: response.status, json: await response.clone().json(), response };
  }

  it('lists only this event’s entries, with no-store', async () => {
    await createEntry();
    await createEntry(otherEvent.id, otherVersion);

    const result = await list(event.id);
    expect(result.status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    const body = result.json as EventEntryListResponse;
    expect(body.total).toBe(1);
    expect(body.eventStatus).toBe('OPEN');
    expect(body.acceptingEntries).toBe(true);
  });

  it('refuses filters it does not understand rather than ignoring them', async () => {
    const result = await list(event.id, '?pageSize=99999');
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });

  it('returns one entry with its answers, and audits the read', async () => {
    const created = await createEntry();
    const result = await detail(event.id, created.entry.id);

    expect(result.status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    const body = result.json as EventEntryDetail;
    expect(body.participant.email).toBe('ana@example.com');
    expect(body.answers).toHaveLength(3);
    expect(body.formVersion.versionNumber).toBe(1);

    const audits = db.raw
      .prepare("SELECT * FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'")
      .all() as Array<Record<string, unknown>>;
    expect(audits).toHaveLength(1);
    // Identifiers and a count, never the answers: recording what was read would
    // copy the personal data into an append-only table.
    expect(String(audits[0].metadata)).not.toContain('ana@example.com');
  });

  it('an entry from ANOTHER event is not found, not forbidden', async () => {
    const created = await createEntry();
    const result = await detail(otherEvent.id, created.entry.id);
    expect(result.status).toBe(404);
    expect((result.json as ApiErrorBody).error.code).toBe('EVENT_ENTRY_NOT_FOUND');
    // Nothing about the real owner leaks through the refusal.
    expect(JSON.stringify(result.json)).not.toContain('ana@example.com');
  });

  it('refuses a malformed entry id before it reaches a query', async () => {
    const result = await detail(event.id, 'not-a-uuid');
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });

  it('does not audit a LIST, only the detail', async () => {
    await createEntry();
    db.raw.prepare("DELETE FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'").run();

    await list(event.id);
    const audits = db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'")
      .get() as { n: number };
    // Auditing every render would drown the trail that matters.
    expect(audits.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the /participants alias', () => {
  it('serves the same listing and the same detail', async () => {
    const created = await createEntry();

    const listPath = `/api/events/${event.id}/participants`;
    const listData = await gate(listPath);
    const listed = await invoke(
      participantsIndex.onRequestGet as never,
      req(listPath),
      listData,
      { id: event.id },
    );
    expect(listed.response.status).toBe(200);
    expect(((await listed.response.json()) as EventEntryListResponse).total).toBe(1);

    const detailPath = `/api/events/${event.id}/participants/${created.entry.id}`;
    const detailData = await gate(detailPath);
    const detailed = await invoke(
      participantById.onRequestGet as never,
      req(detailPath),
      detailData,
      { id: event.id, entryId: created.entry.id },
    );
    expect(detailed.response.status).toBe(200);
    expect(detailed.response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('is the same implementation, not a copy that can drift', () => {
    expect(participantsIndex.onRequestGet).toBe(entriesIndex.onRequestGet);
    expect(participantById.onRequestGet).toBe(entryById.onRequestGet);
  });

  it('offers no way to create a person', () => {
    // `POST .../participants` would read as "create a human being". Creating a
    // participation is `POST .../entries`, because that is what it creates.
    expect('onRequestPost' in participantsIndex).toBe(false);
    expect('onRequestPost' in participantById).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('no endpoint can alter what was submitted', () => {
  it('the entry routes expose reads and one create, and nothing else', () => {
    for (const [name, module] of [
      ['entries/index', entriesIndex],
      ['entries/[entryId]', entryById],
      ['participants/index', participantsIndex],
      ['participants/[entryId]', participantById],
    ] as const) {
      const handlers = Object.keys(module).filter((key) => key.startsWith('onRequest'));
      for (const handler of handlers) {
        expect(handler, `${name}.${handler}`).not.toMatch(/Patch|Put|Delete/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('personal data does not travel where it should not', () => {
  it('no audit row anywhere carries a name, an address or a birthday', async () => {
    const seeded = await seedOpenEvent('Audited');
    const dob = seeded.version.steps.flatMap((step) => step.questions);
    void dob;

    await post(seeded.event.id, { answers: answersFor(seeded.version) });
    const detailPath = `/api/events/${seeded.event.id}/entries`;
    const listData = await gate(detailPath);
    await invoke(entriesIndex.onRequestGet as never, req(detailPath), listData, {
      id: seeded.event.id,
    });

    const rows = db.raw.prepare('SELECT * FROM audit_logs').all() as Array<
      Record<string, unknown>
    >;
    const serialized = JSON.stringify(rows);
    for (const secret of ['Ana', 'Lopez', 'ana@example.com']) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('a 404 for another event’s entry reveals nothing about it', async () => {
    const created = await createEntry();
    const path = `/api/events/${otherEvent.id}/entries/${created.entry.id}`;
    const data = await gate(path);
    const { response } = await invoke(entryById.onRequestGet as never, req(path), data, {
      id: otherEvent.id,
      entryId: created.entry.id,
    });

    expect(response.status).toBe(404);
    const body = await response.text();
    for (const secret of ['Ana', 'Lopez', 'ana@example.com', created.participant.id]) {
      expect(body, secret).not.toContain(secret);
    }
    // And reading somebody else's record is not recorded as if it happened.
    const audits = db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'")
      .get() as { n: number };
    expect(audits.n).toBe(0);
  });

  it('a listing cannot be talked into returning another event’s people', async () => {
    await createEntry();
    await createEntry(otherEvent.id, otherVersion);

    // Every shape of "give me everything": a huge page size is clamped by the
    // schema, and the scope is the path, not a parameter.
    // A huge page size is clamped by the schema, and the scope is the PATH,
    // never a parameter — so none of these widens the result set.
    for (const [query, expected] of [
      ['?pageSize=200', 1],
      ['?page=1&search=', 1],
      // `%` is a LIKE wildcard. Escaped, it matches nobody rather than everybody.
      ['?search=%25', 0],
    ] as const) {
      const path = `/api/events/${event.id}/entries${query}`;
      const data = await gate(path);
      const { response } = await invoke(entriesIndex.onRequestGet as never, req(path), data, {
        id: event.id,
      });
      expect(response.status, query).toBe(200);
      const body = (await response.json()) as EventEntryListResponse;
      expect(body.total, query).toBe(expected);
    }
  });

  it('an event id that is not a UUID is refused before it reaches a query', async () => {
    // The handler receives whatever the router captured. Every one of these is
    // narrowed by `asUuid` first, so none of them is ever bound into SQL.
    const data = await gate(`/api/events/${event.id}/entries`, 'POST');
    for (const id of ['../../events', '%2e%2e', 'null', '0', 'undefined', "' OR 1=1--"]) {
      const { response } = await invoke(
        entriesIndex.onRequestPost as never,
        req(`/api/events/${event.id}/entries`, {
          method: 'POST',
          body: JSON.stringify({ answers: [] }),
        }),
        data,
        { id },
      );
      expect(response.status, id).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code, id).toBe('INVALID_QUERY');
    }
  });

  it('the auth guard covers the entries path however it is written', async () => {
    // The router and the guard must not normalise differently: a path the
    // router resolves to this function but the guard does not consider
    // protected would skip authentication entirely.
    const id = newId();
    for (const path of [
      `/api/events/${id}/entries`,
      `/API/EVENTS/${id}/ENTRIES`,
      `/api/events/${id}/x/../entries`,
      `/api//events/${id}/entries`,
      `/api/events/${id}/entries/`,
    ]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(response.status, path).toBe(401);
      expect(nextCalled, path).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the create endpoint cannot be turned into something else', () => {
  it('has no PATCH, PUT or DELETE, on either path', () => {
    for (const module of [entriesIndex, entryById, participantsIndex, participantById]) {
      expect('onRequestPatch' in module).toBe(false);
      expect('onRequestPut' in module).toBe(false);
      expect('onRequestDelete' in module).toBe(false);
    }
    // And only the collection accepts a write at all.
    expect('onRequestPost' in entriesIndex).toBe(true);
    expect('onRequestPost' in entryById).toBe(false);
  });

  it('refuses a second entry even when the payload varies the presentation', async () => {
    await createEntry();
    for (const variant of ['ANA@EXAMPLE.COM', '  ana@example.com  ', 'Ana@Example.Com']) {
      const result = await post(event.id, {
        answers: answersFor(version, { email: variant }),
      });
      expect(result.status, variant).toBe(409);
      expect((result.json as ApiErrorBody).error.code, variant).toBe(
        'PARTICIPANT_ALREADY_ENTERED',
      );
    }
    const total = db.raw
      .prepare('SELECT COUNT(*) AS n FROM event_entries')
      .get() as { n: number };
    expect(total.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the decision on the wire', () => {
  /** Adds a date-of-birth question and an age rule to the seeded event. */
  async function ageGatedEvent(minimumAge: number) {
    const seeded = await seedOpenEvent('Age gated');
    const drafts = new FormDraftService(db.d1);
    const publishing = new FormPublishingService(db.d1);

    const draft = await drafts.find(seeded.event.id);
    if (!draft.ok || !draft.value.draft) throw new Error('no draft');
    const made = await drafts.createQuestion(
      seeded.event.id,
      {
        expectedRevision: draft.value.draft.revision,
        stepId: draft.value.draft.steps[0].id,
        type: 'DATE',
        systemField: 'DATE_OF_BIRTH',
        label: 'Date of birth',
        required: true,
      } as never,
      actor(),
    );
    if (!made.ok) throw new Error(made.failure.code);

    const published = await publishing.publish(seeded.event.id, made.value.revision, actor());
    if (!published.ok) throw new Error(published.failure.code);
    db.raw
      .prepare('UPDATE events SET minimum_age = ? WHERE id = ?')
      .run(minimumAge, seeded.event.id);

    return { event: seeded.event, version: published.value.version };
  }

  function dobForAge(years: number): string {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const [year, month, day] = today.split('-');
    return `${Number(year) - years}-${month}-${day}`;
  }

  it('answers 201 with the whole verdict for somebody old enough', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    const result = await post(gated.id, {
      answers: answersFor(gatedVersion, { date_of_birth: dobForAge(21) }),
    });

    expect(result.status).toBe(201);
    const body = result.json as CreateEventEntryResponse;
    expect(body.entry.status).toBe('ELIGIBLE');
    expect(body.entry.calculatedAge).toBe(21);
    expect(body.entry.ageEligible).toBe(true);
    expect(body.entry.overallEligible).toBe(true);
    expect(body.entry.eligibilityReason).toBe('ELIGIBLE');
  });

  it('answers 201 — not an error — for somebody too young', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    const result = await post(gated.id, {
      answers: answersFor(gatedVersion, { date_of_birth: dobForAge(20) }),
    });

    // Being underage is a RESULT, not a failure of the request. Answering 4xx
    // would leave the client believing nothing was recorded — and something was.
    expect(result.status).toBe(201);
    const body = result.json as CreateEventEntryResponse;
    expect(body.entry.status).toBe('INELIGIBLE');
    expect(body.entry.calculatedAge).toBe(20);
    expect(body.entry.ageEligible).toBe(false);
    expect(body.entry.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('answers 400 for a date of birth that is not possible', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    for (const [dob, code] of [
      ['1800-01-01', 'DATE_OF_BIRTH_INVALID'],
      ['2099-01-01', 'FORM_ANSWER_INVALID'],
      ['2025-02-29', 'FORM_ANSWER_INVALID'],
    ] as const) {
      const result = await post(gated.id, {
        answers: answersFor(gatedVersion, { date_of_birth: dob }),
      });
      expect(result.status, dob).toBe(400);
      expect((result.json as ApiErrorBody).error.code, dob).toBe(code);
    }
  });

  it('never echoes the date of birth back in a refusal', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    const result = await post(gated.id, {
      answers: answersFor(gatedVersion, { date_of_birth: '1800-03-15' }),
    });
    expect(JSON.stringify(result.json)).not.toContain('1800-03-15');
  });

  it('refuses a body that tries to dictate the verdict', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    const answers = answersFor(gatedVersion, { date_of_birth: dobForAge(20) });

    for (const extra of [
      { calculatedAge: 99 },
      { ageEligible: true },
      { overallEligible: true },
      { eligibilityReason: 'ELIGIBLE' },
      { status: 'ELIGIBLE' },
      { minimumAge: 0 },
      { decision: { overallEligible: true } },
    ]) {
      const result = await post(gated.id, { answers, ...extra });
      expect(result.status, JSON.stringify(extra)).toBe(400);
      expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
    // And nothing landed while trying.
    const rows = db.raw
      .prepare('SELECT COUNT(*) AS n FROM event_entries')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('the listing carries the verdict, so a table needs no second request', async () => {
    const { event: gated, version: gatedVersion } = await ageGatedEvent(21);
    await post(gated.id, {
      answers: answersFor(gatedVersion, { date_of_birth: dobForAge(20) }),
    });

    const path = `/api/events/${gated.id}/entries`;
    const data = await gate(path);
    const { response } = await invoke(entriesIndex.onRequestGet as never, req(path), data, {
      id: gated.id,
    });
    const body = (await response.json()) as EventEntryListResponse;
    expect(body.items[0].status).toBe('INELIGIBLE');
    expect(body.items[0].calculatedAge).toBe(20);
    expect(body.items[0].overallEligible).toBe(false);
    expect(body.items[0].eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
  });
});

// ---------------------------------------------------------------------------
describe('nothing about the verdict can be dictated', () => {
  it('refuses every spelling of every decision field', async () => {
    const answers = answersFor(version);
    for (const key of [
      'status',
      'calculatedAge',
      'calculated_age',
      'ageEligible',
      'age_eligible',
      'overallEligible',
      'overall_eligible',
      'eligibilityReason',
      'eligibility_reason',
      'minimumAge',
      'minimum_age',
      'decision',
      'eligible',
      'timezone',
      'now',
      'submittedAt',
    ]) {
      const result = await post(event.id, { answers, [key]: 'anything' });
      expect(result.status, key).toBe(400);
      expect((result.json as ApiErrorBody).error.code, key).toBe('VALIDATION_ERROR');
    }

    // And nothing landed while trying every one of them.
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM event_entries').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('refuses a decision smuggled into an ANSWER envelope', async () => {
    const answers = answersFor(version).map((answer) => ({
      ...answer,
      overallEligible: true,
      calculatedAge: 99,
    }));
    const result = await post(event.id, { answers });
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });
});
