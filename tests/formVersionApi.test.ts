// @vitest-environment node
//
// The publishing HTTP surface: auth, route protection, IDOR, typed errors and
// the absence of any endpoint that could change a published version.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import * as publishRoute from '../functions/api/events/[id]/form/publish';
import * as validateRoute from '../functions/api/events/[id]/form/validate-publish';
import * as publishedRoute from '../functions/api/events/[id]/form/published';
import * as versionsIndex from '../functions/api/events/[id]/form/versions/index';
import * as versionById from '../functions/api/events/[id]/form/versions/[versionId]';
import * as formIndex from '../functions/api/events/[id]/form/index';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { FormDraftService } from '../functions/_shared/formDraftService';
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
  Event,
  EventFormDraft,
  EventFormDraftResponse,
  EventFormVersionDetailResponse,
  EventFormVersionListResponse,
  FormPublishValidationResponse,
  PublishFormResponse,
  PublishedFormResponse,
} from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let token: string;
let admin: AuthenticatedAdmin;
let event: Event;
let otherEvent: Event;
let drafts: FormDraftService;

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

const gate = async (path: string) => (await invoke(onRequest as never, req(path))).data;

/** A draft that satisfies every publication rule, built through the service. */
async function publishableDraft(eventId = event.id): Promise<EventFormDraft> {
  const created = await drafts.ensure(eventId, actor());
  if (!created.ok) throw new Error(created.failure.code);
  let form = created.value.draft;
  // Idempotent: a test may ask for a publishable draft twice.
  if (form.steps.flatMap((step) => step.questions).length > 0) return form;

  const step = await drafts.createStep(
    eventId,
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
    const made = await drafts.createQuestion(
      eventId,
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
    if (!made.ok) throw new Error(made.failure.code);
    form = made.value;
  }
  return form;
}

async function publish(eventId = event.id): Promise<PublishFormResponse> {
  const form = await publishableDraft(eventId);
  const data = await gate(`/api/events/${eventId}/form/publish`);
  const { response } = await invoke(
    publishRoute.onRequestPost as never,
    req(`/api/events/${eventId}/form/publish`, {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRevision: form.revision }),
    }),
    data,
    { id: eventId },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as PublishFormResponse;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  drafts = new FormDraftService(db.d1);

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

  const events = new EventLifecycleService(db.d1);
  const window = {
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  };
  const first = await events.create({ name: 'Owner', ...window }, actor());
  const second = await events.create({ name: 'Other', ...window }, actor());
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
  it('rejects every publishing route without a session', async () => {
    const id = newId();
    for (const path of [
      `/api/events/${id}/form/publish`,
      `/api/events/${id}/form/validate-publish`,
      `/api/events/${id}/form/published`,
      `/api/events/${id}/form/versions`,
      `/api/events/${id}/form/versions/${id}`,
    ]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(false);
      expect(response.status, path).toBe(401);
    }
  });

  it.each([
    '//api/events/x/form/publish',
    '/api//events/x/form/versions',
    '/API/events/x/form/published',
    '/api/events/x/form/%76ersions',
    '\\api\\events\\x\\form\\publish',
    '/api/events/x/form/versions/../../../audit',
  ])('rejects the bypass attempt %s', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('method exposure', () => {
  it('offers NO way to change a published version', () => {
    const handlersOf = (mod: Record<string, unknown>) =>
      Object.keys(mod)
        .filter((key) => key.startsWith('onRequest'))
        .sort();

    // Reading only. A version has no PATCH, no DELETE and no POST.
    expect(handlersOf(versionsIndex)).toEqual(['onRequestGet']);
    expect(handlersOf(versionById)).toEqual(['onRequestGet']);
    expect(handlersOf(publishedRoute)).toEqual(['onRequestGet']);

    expect(handlersOf(publishRoute)).toEqual(['onRequestPost']);
    expect(handlersOf(validateRoute)).toEqual(['onRequestPost']);

    for (const mod of [versionsIndex, versionById, publishedRoute, publishRoute]) {
      expect(Object.keys(mod)).not.toContain('onRequest');
    }
  });
});

// ---------------------------------------------------------------------------
describe('POST /form/publish', () => {
  it('freezes a version and answers with it', async () => {
    const body = await publish();
    expect(body.version.versionNumber).toBe(1);
    expect(body.version.steps[0].questions).toHaveLength(3);
    expect(body.publishedVersionId).toBe(body.version.id);
    expect(body.eventId).toBe(event.id);
    // The draft comes back untouched and still editable.
    expect(body.draft.revision).toBe(body.version.sourceDraftRevision);
  });

  it('answers with a request id and no-store', async () => {
    const form = await publishableDraft();
    const data = await gate(`/api/events/${event.id}/form/publish`);
    const { response } = await invoke(
      publishRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: form.revision }),
      }),
      data,
      { id: event.id },
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('refuses a body without the revision, and one with extra keys', async () => {
    const form = await publishableDraft();
    const data = await gate(`/api/events/${event.id}/form/publish`);

    for (const body of [
      {},
      { expectedDraftRevision: form.revision, steps: [] },
      { expectedDraftRevision: 0 },
    ]) {
      const { response } = await invoke(
        publishRoute.onRequestPost as never,
        req(`/api/events/${event.id}/form/publish`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        data,
        { id: event.id },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('422s a draft that is not ready, naming how many problems there are', async () => {
    const created = await drafts.ensure(event.id, actor());
    if (!created.ok) throw new Error('unreachable');
    const data = await gate(`/api/events/${event.id}/form/publish`);

    const { response } = await invoke(
      publishRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: created.value.draft.revision }),
      }),
      data,
      { id: event.id },
    );
    expect(response.status).toBe(422);
    const failure = (await response.json()) as ApiErrorBody;
    expect(failure.error.code).toBe('FORM_DRAFT_NOT_PUBLISHABLE');
    expect(Number(failure.error.fields?.issues)).toBeGreaterThan(0);
  });

  it('409s a stale revision and a form with nothing new', async () => {
    const first = await publish();
    const data = await gate(`/api/events/${event.id}/form/publish`);

    const stale = await invoke(
      publishRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: first.draft.revision - 1 }),
      }),
      data,
      { id: event.id },
    );
    expect(stale.response.status).toBe(409);
    expect(((await stale.response.json()) as ApiErrorBody).error.code).toBe(
      'FORM_DRAFT_REVISION_CONFLICT',
    );

    const unchanged = await invoke(
      publishRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: first.draft.revision }),
      }),
      data,
      { id: event.id },
    );
    expect(unchanged.response.status).toBe(409);
    const failure = (await unchanged.response.json()) as ApiErrorBody;
    expect(failure.error.code).toBe('FORM_NO_UNPUBLISHED_CHANGES');
    expect(failure.error.fields?.versionNumber).toBe('1');
  });
});

// ---------------------------------------------------------------------------
describe('POST /form/validate-publish', () => {
  it('answers the verdict without writing anything', async () => {
    const form = await publishableDraft();
    const before = db.raw
      .prepare('SELECT COUNT(*) AS n FROM audit_logs')
      .get() as { n: number };

    const data = await gate(`/api/events/${event.id}/form/validate-publish`);
    const { response } = await invoke(
      validateRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/validate-publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: form.revision }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as FormPublishValidationResponse;
    expect(body.publishable).toBe(true);
    expect(body.draftRevision).toBe(form.revision);
    expect(body.publishedVersionNumber).toBeNull();

    const after = db.raw.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_versions').get() as { n: number }).n,
    ).toBe(0);
  });

  it('reports the issues, each carrying the id of what to fix', async () => {
    const created = await drafts.ensure(event.id, actor());
    if (!created.ok) throw new Error('unreachable');
    const step = await drafts.createStep(
      event.id,
      { expectedRevision: created.value.draft.revision, title: 'Empty page' },
      actor(),
    );
    if (!step.ok) throw new Error('unreachable');

    const data = await gate(`/api/events/${event.id}/form/validate-publish`);
    const { response } = await invoke(
      validateRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/validate-publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const body = (await response.json()) as FormPublishValidationResponse;
    expect(body.publishable).toBe(false);
    const empty = body.errors.find((issue) => issue.code === 'EMPTY_STEP');
    expect(empty?.stepId).toBe(step.value.steps[0].id);
    expect(body.errors.map((issue) => issue.code)).toContain('MISSING_SYSTEM_FIELD');
  });
});

// ---------------------------------------------------------------------------
describe('reading versions', () => {
  it('reports no published form as 200 with null, not as 404', async () => {
    const data = await gate(`/api/events/${event.id}/form/published`);
    const { response } = await invoke(
      publishedRoute.onRequestGet as never,
      req(`/api/events/${event.id}/form/published`),
      data,
      { id: event.id },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as PublishedFormResponse).publishedVersion).toBeNull();
  });

  it('serves the live version once there is one', async () => {
    const published = await publish();
    const data = await gate(`/api/events/${event.id}/form/published`);
    const { response } = await invoke(
      publishedRoute.onRequestGet as never,
      req(`/api/events/${event.id}/form/published`),
      data,
      { id: event.id },
    );
    const body = (await response.json()) as PublishedFormResponse;
    expect(body.publishedVersion?.id).toBe(published.version.id);
    expect(body.publishedVersion?.steps[0].questions).toHaveLength(3);
  });

  it('lists history newest first with the live one marked', async () => {
    const first = await publish();
    // Move the draft on, then publish again.
    const saved = await drafts.saveDraft(event.id, first.draft.revision, actor());
    if (!saved.ok) throw new Error('unreachable');
    const data = await gate(`/api/events/${event.id}/form/publish`);
    await invoke(
      publishRoute.onRequestPost as never,
      req(`/api/events/${event.id}/form/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRevision: saved.value.revision }),
      }),
      data,
      { id: event.id },
    );

    const listData = await gate(`/api/events/${event.id}/form/versions`);
    const { response } = await invoke(
      versionsIndex.onRequestGet as never,
      req(`/api/events/${event.id}/form/versions`),
      listData,
      { id: event.id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as EventFormVersionListResponse;
    expect(body.items.map((item) => item.versionNumber)).toEqual([2, 1]);
    expect(body.items[0].currentPublished).toBe(true);
    expect(body.currentVersionId).toBe(body.items[0].id);
  });

  it('returns a version with its snapshot alongside its rows', async () => {
    const published = await publish();
    const data = await gate(
      `/api/events/${event.id}/form/versions/${published.version.id}`,
    );
    const { response } = await invoke(
      versionById.onRequestGet as never,
      req(`/api/events/${event.id}/form/versions/${published.version.id}`),
      data,
      { id: event.id, versionId: published.version.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EventFormVersionDetailResponse;
    expect(body.currentPublished).toBe(true);
    expect(body.version.versionNumber).toBe(1);
    expect(body.snapshot.summary.questionCount).toBe(3);
  });

  it('404s an unknown version and 400s a malformed id', async () => {
    const ghost = newId();
    const missing = await invoke(
      versionById.onRequestGet as never,
      req(`/api/events/${event.id}/form/versions/${ghost}`),
      await gate(`/api/events/${event.id}/form/versions/${ghost}`),
      { id: event.id, versionId: ghost },
    );
    expect(missing.response.status).toBe(404);
    expect(((await missing.response.json()) as ApiErrorBody).error.code).toBe(
      'FORM_VERSION_NOT_FOUND',
    );

    const malformed = await invoke(
      versionById.onRequestGet as never,
      req(`/api/events/${event.id}/form/versions/not-a-uuid`),
      await gate(`/api/events/${event.id}/form/versions/not-a-uuid`),
      { id: event.id, versionId: 'not-a-uuid' },
    );
    expect(malformed.response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('IDOR between events', () => {
  it('a version cannot be read through another event', async () => {
    const mine = await publish(event.id);

    const data = await gate(
      `/api/events/${otherEvent.id}/form/versions/${mine.version.id}`,
    );
    const { response } = await invoke(
      versionById.onRequestGet as never,
      req(`/api/events/${otherEvent.id}/form/versions/${mine.version.id}`),
      data,
      { id: otherEvent.id, versionId: mine.version.id },
    );
    expect(response.status).toBe(404);

    // The other event's history and pointer are untouched.
    const listData = await gate(`/api/events/${otherEvent.id}/form/versions`);
    const list = await invoke(
      versionsIndex.onRequestGet as never,
      req(`/api/events/${otherEvent.id}/form/versions`),
      listData,
      { id: otherEvent.id },
    );
    const body = (await list.response.json()) as EventFormVersionListResponse;
    expect(body.items).toEqual([]);
    expect(body.currentVersionId).toBeNull();
  });

  it('404s history for an event that does not exist', async () => {
    const ghost = newId();
    const { response } = await invoke(
      versionsIndex.onRequestGet as never,
      req(`/api/events/${ghost}/form/versions`),
      await gate(`/api/events/${ghost}/form/versions`),
      { id: ghost },
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('the draft endpoint reports publication state', () => {
  it('goes from never-published to up-to-date to dirty', async () => {
    const read = async (): Promise<EventFormDraftResponse> => {
      const data = await gate(`/api/events/${event.id}/form`);
      const { response } = await invoke(
        formIndex.onRequestGet as never,
        req(`/api/events/${event.id}/form`),
        data,
        { id: event.id },
      );
      return (await response.json()) as EventFormDraftResponse;
    };

    await publishableDraft();
    const before = await read();
    expect(before.publishedVersionNumber).toBeNull();
    expect(before.hasUnpublishedChanges).toBe(true);

    const published = await publish();
    const after = await read();
    expect(after.publishedVersionNumber).toBe(1);
    expect(after.publishedVersionId).toBe(published.version.id);
    expect(after.hasUnpublishedChanges).toBe(false);

    await drafts.saveDraft(event.id, published.draft.revision, actor());
    const dirty = await read();
    expect(dirty.hasUnpublishedChanges).toBe(true);
    expect(dirty.publishedVersionNumber).toBe(1);
  });
});
