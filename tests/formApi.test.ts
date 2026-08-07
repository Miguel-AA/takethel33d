// @vitest-environment node
//
// The form builder HTTP surface: auth, route protection, IDOR, payload guards,
// typed errors and method exposure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import * as formIndex from '../functions/api/events/[id]/form/index';
import * as previewRoute from '../functions/api/events/[id]/form/preview';
import * as stepsIndex from '../functions/api/events/[id]/form/steps/index';
import * as stepsReorder from '../functions/api/events/[id]/form/steps/reorder';
import * as stepById from '../functions/api/events/[id]/form/steps/[stepId]';
import * as questionsIndex from '../functions/api/events/[id]/form/questions/index';
import * as questionsReorder from '../functions/api/events/[id]/form/questions/reorder';
import * as questionById from '../functions/api/events/[id]/form/questions/[questionId]/index';
import * as duplicateRoute from '../functions/api/events/[id]/form/questions/[questionId]/duplicate';
import * as optionsIndex from '../functions/api/events/[id]/form/questions/[questionId]/options/index';
import * as optionsReorder from '../functions/api/events/[id]/form/questions/[questionId]/options/reorder';
import * as optionById from '../functions/api/events/[id]/form/questions/[questionId]/options/[optionId]';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { PAYLOAD_LIMITS } from '../functions/_shared/payload';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type {
  ApiErrorBody,
  Event,
  EventFormDraftResponse,
  FormDraftMutationResponse,
  FormPreviewResponse,
} from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let token: string;
let event: Event;
let otherEvent: Event;

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

const gate = async (path: string) => (await invoke(onRequest as never, req(path))).data;

/** Reads the form. Never creates one — that is `createDraft`. */
async function readDraft(eventId = event.id): Promise<EventFormDraftResponse> {
  const data = await gate(`/api/events/${eventId}/form`);
  const { response } = await invoke(
    formIndex.onRequestGet as never,
    req(`/api/events/${eventId}/form`),
    data,
    { id: eventId },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as EventFormDraftResponse;
}

async function createDraft(eventId = event.id): Promise<EventFormDraftResponse> {
  const data = await gate(`/api/events/${eventId}/form`);
  const { response } = await invoke(
    formIndex.onRequestPost as never,
    req(`/api/events/${eventId}/form`, { method: 'POST', body: '{}' }),
    data,
    { id: eventId },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as EventFormDraftResponse;
}

/** The draft, created if needed, for tests that only need one to exist. */
async function getDraft(eventId = event.id): Promise<
  EventFormDraftResponse & { draft: NonNullable<EventFormDraftResponse['draft']> }
> {
  const existing = await readDraft(eventId);
  const body = existing.draft ? existing : await createDraft(eventId);
  if (!body.draft) throw new Error('draft missing');
  return body as EventFormDraftResponse & {
    draft: NonNullable<EventFormDraftResponse['draft']>;
  };
}

async function post(
  handler: (ctx: never) => Promise<Response> | Response,
  path: string,
  body: unknown,
  params: Record<string, string>,
  method = 'POST',
) {
  const data = await gate(path);
  return invoke(handler, req(path, { method, body: JSON.stringify(body) }), data, params);
}

async function addStep(title = 'About you') {
  const draft = await getDraft();
  const { response } = await post(
    stepsIndex.onRequestPost as never,
    `/api/events/${event.id}/form/steps`,
    { expectedRevision: draft.draft.revision, title },
    { id: event.id },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as FormDraftMutationResponse;
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

  const events = new EventLifecycleService(db.d1);
  const admin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
    sessionId: 'session-1',
  };
  const requestContext = {
    requestId: 'seed',
    ipHash: 'e'.repeat(64),
    userAgent: 'vitest',
    origin: null,
    method: 'POST',
    pathname: '/seed',
  };

  const window = {
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  };
  const first = await events.create({ name: 'Owner', ...window }, { admin, requestContext });
  const second = await events.create({ name: 'Other', ...window }, { admin, requestContext });
  if (!first.ok || !second.ok) throw new Error('event seed failed');
  event = first.value;
  otherEvent = second.value;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('route protection', () => {
  const routes = (eventId: string, id: string) => [
    `/api/events/${eventId}/form`,
    `/api/events/${eventId}/form/preview`,
    `/api/events/${eventId}/form/steps`,
    `/api/events/${eventId}/form/steps/reorder`,
    `/api/events/${eventId}/form/steps/${id}`,
    `/api/events/${eventId}/form/questions`,
    `/api/events/${eventId}/form/questions/reorder`,
    `/api/events/${eventId}/form/questions/${id}`,
    `/api/events/${eventId}/form/questions/${id}/duplicate`,
    `/api/events/${eventId}/form/questions/${id}/options`,
    `/api/events/${eventId}/form/questions/${id}/options/reorder`,
    `/api/events/${eventId}/form/questions/${id}/options/${id}`,
  ];

  it('rejects every form route without a session', async () => {
    for (const path of routes(newId(), newId())) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(false);
      expect(response.status, path).toBe(401);
    }
  });

  it.each([
    '//api/events/x/form',
    '/api//events/x/form',
    '/API/events/x/form',
    '/api/events/x/%66orm',
    '/api/events/x/%2566orm',
    '/api/events/x/form/questions/../../form',
    '\\api\\events\\x\\form\\questions',
  ])('rejects the bypass attempt %s', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(401);
  });

  it('rejects a revoked session and a suspended admin', async () => {
    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(new Date().toISOString());
    expect(
      (await invoke(onRequest as never, req(`/api/events/${event.id}/form`))).response.status,
    ).toBe(401);

    db.raw.prepare('UPDATE admin_sessions SET revoked_at = NULL').run();
    db.raw.prepare("UPDATE admin_users SET status = 'SUSPENDED'").run();
    expect(
      (await invoke(onRequest as never, req(`/api/events/${event.id}/form`))).response.status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('method exposure', () => {
  it('exposes only the documented handlers', () => {
    const handlersOf = (mod: Record<string, unknown>) =>
      Object.keys(mod)
        .filter((key) => key.startsWith('onRequest'))
        .sort();

    expect(handlersOf(formIndex)).toEqual([
      'onRequestGet',
      'onRequestPost',
      'onRequestPut',
    ]);
    expect(handlersOf(stepById)).toEqual(['onRequestDelete', 'onRequestPatch']);
    expect(handlersOf(questionById)).toEqual(['onRequestDelete', 'onRequestPatch']);
    expect(handlersOf(optionById)).toEqual(['onRequestDelete', 'onRequestPatch']);
    for (const mod of [
      previewRoute,
      stepsIndex,
      stepsReorder,
      questionsIndex,
      questionsReorder,
      duplicateRoute,
      optionsIndex,
      optionsReorder,
    ]) {
      expect(handlersOf(mod)).toEqual(['onRequestPost']);
    }

    // No catch-all that would answer every method.
    for (const mod of [formIndex, stepById, questionById, optionById]) {
      expect(Object.keys(mod)).not.toContain('onRequest');
    }
  });
});

// ---------------------------------------------------------------------------
describe('GET /form', () => {
  it('reports no form until one is created, and never creates on a read', async () => {
    const before = await readDraft();
    expect(before.draft).toBeNull();
    expect(before.editable).toBe(true);
    expect(before.eventStatus).toBe('DRAFT');
    expect(before.availableSystemFields).toContain('EMAIL');

    // A read wrote nothing: no row, no audit entry.
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_drafts').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'FORM_DRAFT_CREATED'")
          .get() as { n: number }
      ).n,
    ).toBe(0);

    const created = await createDraft();
    expect(created.draft?.revision).toBe(1);
    expect(created.draft?.steps).toEqual([]);
  });

  it('creating twice is harmless — the second POST returns the same form', async () => {
    const first = await createDraft();
    const second = await createDraft();
    expect(second.draft?.id).toBe(first.draft?.id);
    expect(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'FORM_DRAFT_CREATED'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('answers with a request id and no-store', async () => {
    const data = await gate(`/api/events/${event.id}/form`);
    const { response } = await invoke(
      formIndex.onRequestGet as never,
      req(`/api/events/${event.id}/form`),
      data,
      { id: event.id },
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('404s for an unknown event and 400s for a malformed id', async () => {
    const missing = await invoke(
      formIndex.onRequestGet as never,
      req(`/api/events/${newId()}/form`),
      await gate(`/api/events/${newId()}/form`),
      { id: newId() },
    );
    expect(missing.response.status).toBe(404);

    const malformed = await invoke(
      formIndex.onRequestGet as never,
      req('/api/events/not-a-uuid/form'),
      await gate('/api/events/not-a-uuid/form'),
      { id: 'not-a-uuid' },
    );
    expect(malformed.response.status).toBe(400);
    expect(((await malformed.response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });

  it('stops offering a system field once it is placed', async () => {
    const draft = await addStep();
    await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'EMAIL',
        systemField: 'EMAIL',
        label: 'Email',
      },
      { id: event.id },
    );

    const after = await getDraft();
    expect(after.availableSystemFields).not.toContain('EMAIL');
    expect(after.availableSystemFields).toContain('PHONE');
  });
});

// ---------------------------------------------------------------------------
describe('mutations', () => {
  it('creates a step, a question and an option, each answering with the whole draft', async () => {
    const stepResult = await addStep();
    expect(stepResult.draft.steps).toHaveLength(1);

    const question = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: stepResult.draft.revision,
        stepId: stepResult.draft.steps[0].id,
        type: 'SINGLE_SELECT',
        label: 'Do you smoke?',
      },
      { id: event.id },
    );
    expect(question.response.status).toBe(201);
    const withQuestion = (await question.response.json()) as FormDraftMutationResponse;
    const created = withQuestion.draft.steps[0].questions[0];
    expect(created.key).toBe('do_you_smoke');

    const option = await post(
      optionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions/${created.id}/options`,
      { expectedRevision: withQuestion.draft.revision, value: 'yes', label: 'Yes' },
      { id: event.id, questionId: created.id },
    );
    expect(option.response.status).toBe(201);
    const withOption = (await option.response.json()) as FormDraftMutationResponse;
    expect(withOption.draft.steps[0].questions[0].options).toHaveLength(1);
  });

  it('refuses a stale revision with a typed conflict', async () => {
    const draft = await addStep();
    const { response } = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { expectedRevision: draft.draft.revision - 1, title: 'Stale' },
      { id: event.id },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('FORM_REVISION_CONFLICT');
  });

  it('names the reason a step cannot be deleted', async () => {
    const draft = await addStep();
    const question = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Held',
      },
      { id: event.id },
    );
    const withQuestion = (await question.response.json()) as FormDraftMutationResponse;

    const { response } = await post(
      stepById.onRequestDelete as never,
      `/api/events/${event.id}/form/steps/${draft.draft.steps[0].id}`,
      { expectedRevision: withQuestion.draft.revision },
      { id: event.id, stepId: draft.draft.steps[0].id },
      'DELETE',
    );
    expect(response.status).toBe(409);
    const failure = (await response.json()) as ApiErrorBody;
    expect(failure.error.code).toBe('FORM_STEP_NOT_EMPTY');
    expect(failure.error.fields?.questions).toBe('1');
  });

  it('refuses a frozen event with its status', async () => {
    await addStep();
    db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    const { response } = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { expectedRevision: 2, title: 'Too late' },
      { id: event.id },
    );
    expect(response.status).toBe(409);
    const failure = (await response.json()) as ApiErrorBody;
    expect(failure.error.code).toBe('FORM_NOT_EDITABLE');
    expect(failure.error.fields?.eventStatus).toBe('CLOSED');
  });

  it('stores hostile text verbatim without executing it', async () => {
    const draft = await addStep();
    const hostile = '<script>alert(1)</script>';
    const { response } = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: hostile,
      },
      { id: event.id },
    );
    const body = (await response.json()) as FormDraftMutationResponse;
    const stored = body.draft.steps[0].questions[0];
    expect(stored.label).toBe(hostile);
    // The derived key never carries the markup.
    expect(stored.key).toBe('script_alert_1_script');
  });

  it('rejects a wrong content type and an oversized body', async () => {
    const draft = await getDraft();
    const wrongType = await invoke(
      stepsIndex.onRequestPost as never,
      new Request(`https://example.com/api/events/${event.id}/form/steps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        },
        body: JSON.stringify({ expectedRevision: 1, title: 'X' }),
      }),
      await gate(`/api/events/${event.id}/form/steps`),
      { id: event.id },
    );
    expect(wrongType.response.status).toBe(415);

    const huge = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { expectedRevision: draft.draft.revision, title: 'x'.repeat(PAYLOAD_LIMITS.admin + 10) },
      { id: event.id },
    );
    expect(huge.response.status).toBe(413);
  });

  it('refuses a body with no revision at all', async () => {
    const { response } = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { title: 'No guard' },
      { id: event.id },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an unknown field — the mass-assignment guard', async () => {
    const draft = await addStep();
    const { response } = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Sneaky',
        ownerId: 'someone-elses-form',
      },
      { id: event.id },
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Every refusal reaches the client as data it can act on.
// ---------------------------------------------------------------------------
describe('typed failures carry their detail', () => {
  async function question(overrides: Record<string, unknown> = {}) {
    const draft = await addStep();
    const { response } = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'A question',
        ...overrides,
      },
      { id: event.id },
    );
    expect(response.status).toBe(201);
    return (await response.json()) as FormDraftMutationResponse;
  }

  const body = async (response: Response) => (await response.json()) as ApiErrorBody;

  it('refuses a mutation with no revision on every write path', async () => {
    const made = await question();
    const q = made.draft.steps[0].questions[0];

    const attempts: Array<[string, Awaited<ReturnType<typeof post>>]> = [
      [
        'patch question',
        await post(
          questionById.onRequestPatch as never,
          `/api/events/${event.id}/form/questions/${q.id}`,
          { label: 'No guard' },
          { id: event.id, questionId: q.id },
          'PATCH',
        ),
      ],
      [
        'delete question',
        await post(
          questionById.onRequestDelete as never,
          `/api/events/${event.id}/form/questions/${q.id}`,
          {},
          { id: event.id, questionId: q.id },
          'DELETE',
        ),
      ],
      [
        'duplicate',
        await post(
          duplicateRoute.onRequestPost as never,
          `/api/events/${event.id}/form/questions/${q.id}/duplicate`,
          {},
          { id: event.id, questionId: q.id },
        ),
      ],
      [
        'create option',
        await post(
          optionsIndex.onRequestPost as never,
          `/api/events/${event.id}/form/questions/${q.id}/options`,
          { value: 'a', label: 'A' },
          { id: event.id, questionId: q.id },
        ),
      ],
    ];

    for (const [label, attempt] of attempts) {
      expect(attempt.response.status, label).toBe(400);
      expect((await body(attempt.response)).error.code, label).toBe('VALIDATION_ERROR');
    }
  });

  it('names the protected field when a standard question resists a change', async () => {
    const made = await question({ type: 'EMAIL', systemField: 'EMAIL', label: 'Email' });
    const q = made.draft.steps[0].questions[0];

    const { response } = await post(
      questionById.onRequestPatch as never,
      `/api/events/${event.id}/form/questions/${q.id}`,
      { expectedRevision: made.draft.revision, type: 'SHORT_TEXT' },
      { id: event.id, questionId: q.id },
      'PATCH',
    );
    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('FORM_QUESTION_PROTECTED');
    expect(failure.error.fields?.reason).toBe('type');
  });

  it('names the type that refuses options', async () => {
    const made = await question({ type: 'YES_NO', label: 'Sure?' });
    const q = made.draft.steps[0].questions[0];

    const { response } = await post(
      optionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions/${q.id}/options`,
      { expectedRevision: made.draft.revision, value: 'a', label: 'A' },
      { id: event.id, questionId: q.id },
    );
    expect(response.status).toBe(400);
    const failure = await body(response);
    expect(failure.error.code).toBe('FORM_OPTION_NOT_ALLOWED');
    expect(failure.error.fields?.type).toBe('YES_NO');
  });

  it('states the scope and the ceiling when a form is full', async () => {
    let draft = (await getDraft()).draft;
    for (let index = 0; index < 20; index++) {
      const { response } = await post(
        stepsIndex.onRequestPost as never,
        `/api/events/${event.id}/form/steps`,
        { expectedRevision: draft.revision, title: `Step ${index}` },
        { id: event.id },
      );
      draft = ((await response.json()) as FormDraftMutationResponse).draft;
    }

    const { response } = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { expectedRevision: draft.revision, title: 'One too many' },
      { id: event.id },
    );
    expect(response.status).toBe(409);
    const failure = await body(response);
    expect(failure.error.code).toBe('FORM_LIMIT_REACHED');
    expect(failure.error.fields?.scope).toBe('steps');
    expect(failure.error.fields?.limit).toBe('20');
  }, 30_000);

  it('refuses a reserved answer key, and never leaks a stack', async () => {
    const draft = await addStep();
    const { response } = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Sneaky',
        key: 'constructor',
      },
      { id: event.id },
    );
    expect(response.status).toBe(400);
    const failure = await body(response);
    expect(failure.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(failure)).not.toMatch(/:\d+:\d+/);
  });

  it('404s a step and a question that do not exist', async () => {
    const draft = await getDraft();
    const ghost = newId();

    const step = await post(
      stepById.onRequestPatch as never,
      `/api/events/${event.id}/form/steps/${ghost}`,
      { expectedRevision: draft.draft.revision, title: 'X' },
      { id: event.id, stepId: ghost },
      'PATCH',
    );
    expect(step.response.status).toBe(404);
    expect((await body(step.response)).error.code).toBe('FORM_STEP_NOT_FOUND');

    const q = await post(
      questionById.onRequestPatch as never,
      `/api/events/${event.id}/form/questions/${ghost}`,
      { expectedRevision: draft.draft.revision, label: 'X' },
      { id: event.id, questionId: ghost },
      'PATCH',
    );
    expect(q.response.status).toBe(404);
    expect((await body(q.response)).error.code).toBe('FORM_QUESTION_NOT_FOUND');
  });

  it('400s a malformed identifier rather than querying with it', async () => {
    const { response } = await invoke(
      questionById.onRequestPatch as never,
      req(`/api/events/${event.id}/form/questions/not-a-uuid`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, label: 'X' }),
      }),
      await gate(`/api/events/${event.id}/form/questions/not-a-uuid`),
      { id: event.id, questionId: 'not-a-uuid' },
    );
    expect(response.status).toBe(400);
    expect((await body(response)).error.code).toBe('INVALID_QUERY');
  });
});

// ---------------------------------------------------------------------------
describe('IDOR between events', () => {
  it('a step and a question cannot be reached through another event', async () => {
    const draft = await addStep();
    const stepId = draft.draft.steps[0].id;
    const questionResponse = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId,
        type: 'SINGLE_SELECT',
        label: 'Owned',
        options: [{ value: 'a', label: 'A' }],
      },
      { id: event.id },
    );
    const owned = (await questionResponse.response.json()) as FormDraftMutationResponse;
    const questionId = owned.draft.steps[0].questions[0].id;
    const optionId = owned.draft.steps[0].questions[0].options[0].id;

    // The other event gets its own draft, at revision 1.
    await createDraft(otherEvent.id);

    const attempts: Array<[string, Awaited<ReturnType<typeof post>>]> = [
      [
        'patch step',
        await post(
          stepById.onRequestPatch as never,
          `/api/events/${otherEvent.id}/form/steps/${stepId}`,
          { expectedRevision: 1, title: 'Stolen' },
          { id: otherEvent.id, stepId },
          'PATCH',
        ),
      ],
      [
        'delete step',
        await post(
          stepById.onRequestDelete as never,
          `/api/events/${otherEvent.id}/form/steps/${stepId}`,
          { expectedRevision: 1 },
          { id: otherEvent.id, stepId },
          'DELETE',
        ),
      ],
      [
        'patch question',
        await post(
          questionById.onRequestPatch as never,
          `/api/events/${otherEvent.id}/form/questions/${questionId}`,
          { expectedRevision: 1, label: 'Stolen' },
          { id: otherEvent.id, questionId },
          'PATCH',
        ),
      ],
      [
        'delete question',
        await post(
          questionById.onRequestDelete as never,
          `/api/events/${otherEvent.id}/form/questions/${questionId}`,
          { expectedRevision: 1 },
          { id: otherEvent.id, questionId },
          'DELETE',
        ),
      ],
      [
        'duplicate question',
        await post(
          duplicateRoute.onRequestPost as never,
          `/api/events/${otherEvent.id}/form/questions/${questionId}/duplicate`,
          { expectedRevision: 1 },
          { id: otherEvent.id, questionId },
        ),
      ],
      [
        'add option',
        await post(
          optionsIndex.onRequestPost as never,
          `/api/events/${otherEvent.id}/form/questions/${questionId}/options`,
          { expectedRevision: 1, value: 'x', label: 'X' },
          { id: otherEvent.id, questionId },
        ),
      ],
      [
        'patch option',
        await post(
          optionById.onRequestPatch as never,
          `/api/events/${otherEvent.id}/form/questions/${questionId}/options/${optionId}`,
          { expectedRevision: 1, label: 'Stolen' },
          { id: otherEvent.id, questionId, optionId },
          'PATCH',
        ),
      ],
    ];

    for (const [label, attempt] of attempts) {
      expect(attempt.response.status, label).toBe(404);
    }

    // The owner's form is untouched, and its revision never moved.
    const after = await getDraft();
    expect(after.draft.revision).toBe(owned.draft.revision);
    expect(after.draft.steps[0].questions[0].label).toBe('Owned');
    expect(after.draft.steps[0].questions[0].options[0].label).toBe('A');
  });

  it('a reorder cannot move a member of another form', async () => {
    const draft = await addStep();
    const stepId = draft.draft.steps[0].id;
    const other = await createDraft(otherEvent.id);
    if (!other.draft) throw new Error('draft missing');

    const { response } = await post(
      stepsReorder.onRequestPost as never,
      `/api/events/${otherEvent.id}/form/steps/reorder`,
      { expectedRevision: other.draft.revision, items: [{ id: stepId, sortOrder: 0 }] },
      { id: otherEvent.id },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('FORM_ORDER_INVALID');
  });
});

// ---------------------------------------------------------------------------
describe('preview endpoint', () => {
  it('refuses to conjure a form it was only asked to render', async () => {
    const { response } = await post(
      previewRoute.onRequestPost as never,
      `/api/events/${event.id}/form/preview`,
      {},
      { id: event.id },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('FORM_DRAFT_NOT_FOUND');
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_drafts').get() as { n: number }).n,
    ).toBe(0);
  });

  it('renders the draft and reports its problems, storing nothing', async () => {
    const draft = await addStep('Page one');
    await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Your name',
        required: true,
      },
      { id: event.id },
    );

    const before = db.raw.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };

    const { response } = await post(
      previewRoute.onRequestPost as never,
      `/api/events/${event.id}/form/preview`,
      {},
      { id: event.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as FormPreviewResponse;
    expect(body.steps[0].questions[0]).toMatchObject({
      label: 'Your name',
      required: true,
      key: 'your_name',
    });
    expect(body.problems).toEqual([]);

    const after = db.raw.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('reports a select with no options as a problem rather than an error', async () => {
    const draft = await addStep();
    await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'DROPDOWN',
        label: 'Pick one',
      },
      { id: event.id },
    );

    const { response } = await post(
      previewRoute.onRequestPost as never,
      `/api/events/${event.id}/form/preview`,
      {},
      { id: event.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as FormPreviewResponse;
    expect(body.problems.map((problem) => problem.code)).toContain('SELECT_WITHOUT_OPTIONS');
  });
});

// ---------------------------------------------------------------------------
describe('reorder endpoints', () => {
  it('applies a full new order and refuses a partial one', async () => {
    let draft = await addStep('One');
    const second = await post(
      stepsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/steps`,
      { expectedRevision: draft.draft.revision, title: 'Two' },
      { id: event.id },
    );
    draft = (await second.response.json()) as FormDraftMutationResponse;
    const [first, last] = draft.draft.steps;

    const applied = await post(
      stepsReorder.onRequestPost as never,
      `/api/events/${event.id}/form/steps/reorder`,
      {
        expectedRevision: draft.draft.revision,
        items: [
          { id: last.id, sortOrder: 0 },
          { id: first.id, sortOrder: 1 },
        ],
      },
      { id: event.id },
    );
    expect(applied.response.status).toBe(200);
    const reordered = (await applied.response.json()) as FormDraftMutationResponse;
    expect(reordered.draft.steps.map((step) => step.title)).toEqual(['Two', 'One']);

    const partial = await post(
      stepsReorder.onRequestPost as never,
      `/api/events/${event.id}/form/steps/reorder`,
      { expectedRevision: reordered.draft.revision, items: [{ id: first.id, sortOrder: 0 }] },
      { id: event.id },
    );
    expect(partial.response.status).toBe(400);
    const failure = (await partial.response.json()) as ApiErrorBody;
    expect(failure.error.fields?.reason).toBe('incomplete_order');
  });

  it('refuses a repeated id and a repeated position before reaching the database', async () => {
    const draft = await addStep();
    const stepId = draft.draft.steps[0].id;

    for (const items of [
      [
        { id: stepId, sortOrder: 0 },
        { id: stepId, sortOrder: 1 },
      ],
      [
        { id: stepId, sortOrder: 0 },
        { id: newId(), sortOrder: 0 },
      ],
    ]) {
      const { response } = await post(
        stepsReorder.onRequestPost as never,
        `/api/events/${event.id}/form/steps/reorder`,
        { expectedRevision: draft.draft.revision, items },
        { id: event.id },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('reorders options through their question', async () => {
    const draft = await addStep();
    const questionResponse = await post(
      questionsIndex.onRequestPost as never,
      `/api/events/${event.id}/form/questions`,
      {
        expectedRevision: draft.draft.revision,
        stepId: draft.draft.steps[0].id,
        type: 'MULTI_SELECT',
        label: 'Interests',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      { id: event.id },
    );
    const withOptions = (await questionResponse.response.json()) as FormDraftMutationResponse;
    const question = withOptions.draft.steps[0].questions[0];

    const { response } = await post(
      optionsReorder.onRequestPost as never,
      `/api/events/${event.id}/form/questions/${question.id}/options/reorder`,
      {
        expectedRevision: withOptions.draft.revision,
        items: [
          { id: question.options[1].id, sortOrder: 0 },
          { id: question.options[0].id, sortOrder: 1 },
        ],
      },
      { id: event.id, questionId: question.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as FormDraftMutationResponse;
    expect(body.draft.steps[0].questions[0].options.map((option) => option.value)).toEqual([
      'b',
      'a',
    ]);
  });
});
